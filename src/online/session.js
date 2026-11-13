/**
 * @file session.js
 * @description Online monitoring (R15): one connection to one PLC runtime, and everything that reads
 * through it. vscode-free; the command layer (src/commands/onlineCommands.js) owns the UI around it.
 *
 *   - `connect` is cancellable at any point: a cancel or a newer connect disconnects the client it
 *     started, so no connection outlives the attempt that made it. `disconnect` is idempotent and is
 *     what extension deactivation calls.
 *   - Every ADS path the editor or the Watch view uses goes through `resolve`, which asks the PLC for
 *     the symbol (`getSymbol`, ADS SymbolInfoByNameEx) and its data type. A path the PLC does not
 *     know resolves to `ok: false` and is never read — paths are checked against the PLC, not guessed.
 *   - The status poll (2 s) reads the runtime state and `TwinCAT_SystemInfoVarList._AppInfo`:
 *     `ProjectName` (the code-mismatch guard), `ActivePlcForces`/`ActiveIoForces` (the forces
 *     indicator; these exist from TwinCAT 3.1.4026.21, older runtimes report "not reported") and
 *     `OnlineChangeCnt` (an online change drops every resolved symbol, so offsets are re-read).
 *   - Notifications (the Watch view) are counted against `maxNotifications`, far below the 550 per
 *     device Beckhoff recommends (D8); a subscription past the cap is refused, not queued.
 */

'use strict';

const { isScalar } = require('./values');

/** Where the runtime describes the running application. */
const APP_INFO = 'TwinCAT_SystemInfoVarList._AppInfo';
/** Reads per sum command; far under the limit ADS sum commands are reported to have. */
const SUM_CHUNK = 100;

/**
 * @typedef {Object} Resolved
 * @property {boolean} ok
 * @property {string} path
 * @property {import('./adsClient').AdsSymbolInfo} [symbol]
 * @property {Object} [dataType]
 * @property {boolean} [scalar]
 * @property {string} [error]
 */

/**
 * @typedef {Object} SessionInfo
 * @property {string|null} plcState 'Run', 'Stop', … as the runtime reports it.
 * @property {string|null} projectName `_AppInfo.ProjectName`, or null when it could not be read.
 * @property {string|null} appTimestamp `_AppInfo.AppTimestamp` (DT), logged for the user's comparison only:
 *   what it stamps (build, download, start) is not documented, so no check relies on it.
 * @property {{plc: boolean, io: boolean}|null} forces null when the runtime does not report forces.
 * @property {number|null} onlineChangeCnt
 * @property {boolean} lost The connection dropped and the library is reconnecting.
 */

/**
 * @param {Object} deps
 * @param {(options: import('./adsClient').ConnectOptions) => import('./adsClient').AdsPort} deps.createClient
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.maxNotifications] Read on every subscribe, so a settings change applies.
 * @param {number} [deps.statusIntervalMs] Default 2000.
 * @param {{setInterval: Function, clearInterval: Function}} [deps.timers]
 */
function createOnlineSession(deps) {
    const log = deps.log || (() => {});
    const timers = deps.timers || { setInterval, clearInterval };
    const statusIntervalMs = deps.statusIntervalMs || 2000;
    /** @type {'offline'|'connecting'|'online'} */
    let state = 'offline';
    /** @type {import('./adsClient').AdsPort|null} */
    let client = null;
    /** @type {{netId: string, port: number, mode: string, label: string}|null} */
    let target = null;
    let attempt = 0;
    /** @type {any} */
    let statusTimer = null;
    let statusBusy = false;
    /** @type {SessionInfo} */
    let info = emptyInfo();
    /** @type {Map<string, Promise<Resolved>>} */
    const symbols = new Map();
    /** @type {Map<string, Promise<Object>>} */
    const dataTypes = new Map();
    /** @type {Set<{unsubscribe: () => Promise<void>}>} */
    const subscriptions = new Set();
    /** @type {Set<(what: string) => void>} */
    const listeners = new Set();
    /** @type {Promise<Array<{name: string, type: string, size?: number}>>|null} */
    let symbolList = null;
    /** Clients being closed in the background (a cancelled connect); `disconnect` waits for them. */
    /** @type {Set<Promise<void>>} */
    const closing = new Set();

    /**
     * Closes a client without waiting, but remembers the close so `disconnect` can wait for it.
     * @param {import('./adsClient').AdsPort} c
     */
    function closeInBackground(c) {
        const p = c.disconnect().catch(() => {}).then(() => { closing.delete(p); });
        closing.add(p);
    }

    const emit = (/** @type {string} */ what) => {
        for (const fn of listeners) {
            try { fn(what); } catch (e) { /* a listener's failure is its own */ }
        }
    };

    function emptyInfo() {
        return { plcState: null, projectName: null, appTimestamp: null, forces: null, onlineChangeCnt: null, lost: false };
    }

    function dropSymbols() {
        symbols.clear();
        dataTypes.clear();
        symbolList = null;
    }

    /**
     * Connects; resolves once online. Rejects with `{cancelled: true}` when `token` fires first.
     * @param {import('./adsClient').ConnectOptions & {label?: string}} options
     * @param {{isCancellationRequested?: boolean, onCancellationRequested?: (fn: () => void) => any}} [token]
     * @returns {Promise<{localAmsNetId: string}>}
     */
    async function connect(options, token) {
        if (state !== 'offline') await disconnect();
        const mine = ++attempt;
        state = 'connecting';
        target = { netId: options.targetAmsNetId, port: options.targetAdsPort, mode: options.mode,
            label: options.label || `${options.targetAmsNetId}:${options.targetAdsPort}` };
        emit('state');
        let c;
        try {
            c = deps.createClient(options);
        } catch (e) {
            state = 'offline';
            target = null;
            emit('state');
            const err = /** @type {any} */ (e);
            err.configError = true;
            throw err;
        }
        client = c;
        wire(c, mine);
        /** @type {Promise<never>} */
        const cancelled = new Promise((_, reject) => {
            const fire = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
            if (token && token.isCancellationRequested) fire();
            else if (token && token.onCancellationRequested) token.onCancellationRequested(fire);
        });
        cancelled.catch(() => {});
        try {
            const res = await Promise.race([c.connect(), cancelled]);
            if (mine !== attempt) throw Object.assign(new Error('superseded'), { cancelled: true });
            state = 'online';
            info = emptyInfo();
            log(`Online: ${target.label} (${options.mode === 'direct' ? 'direct' : 'through the local router'}), local AmsNetId ${res.localAmsNetId}`);
            await refreshStatus();
            if (mine === attempt) {
                statusTimer = timers.setInterval(() => { refreshStatus().catch(() => {}); }, statusIntervalMs);
                emit('state');
            }
            return res;
        } catch (e) {
            if (mine === attempt) {
                attempt++;
                client = null;
                state = 'offline';
                target = null;
                emit('state');
            }
            closeInBackground(c);
            throw e;
        }
    }

    /**
     * @param {import('./adsClient').AdsPort} c
     * @param {number} mine
     */
    function wire(c, mine) {
        const live = () => mine === attempt && client === c;
        c.on('connectionLost', () => { if (live()) { info.lost = true; log('Connection lost; reconnecting.'); emit('info'); } });
        c.on('reconnect', () => {
            if (!live()) return;
            info.lost = false;
            dropSymbols();
            log('Reconnected.');
            emit('symbols');
            emit('info');
        });
        c.on('plcState', (/** @type {{state: string}} */ s) => { if (live()) { info.plcState = s.state; emit('info'); } });
        c.on('symbolVersion', () => { if (live()) { dropSymbols(); log('The PLC symbol version changed (a download): symbols re-read.'); emit('symbols'); } });
        c.on('warning', (/** @type {string} */ m) => { if (live()) log(`ADS: ${m}`); });
        c.on('error', (/** @type {any} */ e) => { if (live()) log(`ADS error: ${e && e.message ? e.message : e}`); });
    }

    /** Closes the connection and forgets everything read through it. Idempotent. */
    async function disconnect() {
        attempt++;
        if (statusTimer) { timers.clearInterval(statusTimer); statusTimer = null; }
        const c = client;
        const was = state;
        client = null;
        state = 'offline';
        subscriptions.clear();
        dropSymbols();
        info = emptyInfo();
        if (was !== 'offline' && target) log(`Offline: ${target.label}`);
        target = null;
        if (was !== 'offline') emit('state');
        if (c) closeInBackground(c);
        await Promise.all([...closing]);
    }

    /** Reads the runtime state and `_AppInfo`; never throws. */
    async function refreshStatus() {
        const c = client;
        if (!c || state === 'offline' || statusBusy) return;
        statusBusy = true;
        try {
            const before = JSON.stringify(info);
            try { info.plcState = (await c.readPlcState()).state; } catch (e) { info.plcState = null; }
            try { info.projectName = String((await c.readValue(`${APP_INFO}.ProjectName`)).value); } catch (e) { info.projectName = null; }
            try {
                const ts = (await c.readValue(`${APP_INFO}.AppTimestamp`)).value;
                info.appTimestamp = ts instanceof Date ? ts.toISOString() : (ts === undefined || ts === null ? null : String(ts));
            } catch (e) { info.appTimestamp = null; }
            try {
                const plc = (await c.readValue(`${APP_INFO}.ActivePlcForces`)).value;
                const io = (await c.readValue(`${APP_INFO}.ActiveIoForces`)).value;
                info.forces = { plc: !!plc, io: !!io };
            } catch (e) {
                info.forces = null;
            }
            try {
                const cnt = Number((await c.readValue(`${APP_INFO}.OnlineChangeCnt`)).value);
                if (info.onlineChangeCnt !== null && cnt !== info.onlineChangeCnt) {
                    dropSymbols();
                    log(`Online change detected (OnlineChangeCnt ${info.onlineChangeCnt} -> ${cnt}): symbols re-read.`);
                    emit('symbols');
                }
                info.onlineChangeCnt = cnt;
            } catch (e) { /* not reported */ }
            if (c === client && JSON.stringify(info) !== before) emit('info');
        } finally {
            statusBusy = false;
        }
    }

    /**
     * The data type of a symbol, cached per type name.
     * @param {import('./adsClient').AdsPort} c
     * @param {import('./adsClient').AdsSymbolInfo} symbol
     * @param {string} path
     * @returns {Promise<Object>}
     */
    function dataTypeOf(c, symbol, path) {
        const key = String(symbol.type).toLowerCase();
        if (!dataTypes.has(key)) {
            const p = c.getDataType(symbol.type).catch(async () => (await c.readValue(path)).dataType);
            p.catch(() => dataTypes.delete(key));
            dataTypes.set(key, p);
        }
        return /** @type {Promise<Object>} */ (dataTypes.get(key));
    }

    /**
     * Asks the PLC for a path's symbol and type. Cached until the symbols change.
     * @param {string} path
     * @returns {Promise<Resolved>}
     */
    function resolve(path) {
        const c = client;
        if (!c || state !== 'online') return Promise.resolve({ ok: false, path, error: 'offline' });
        const key = path.toLowerCase();
        if (!symbols.has(key)) {
            const p = (async () => {
                try {
                    const symbol = await c.getSymbol(path);
                    const dataType = await dataTypeOf(c, symbol, path);
                    return { ok: true, path, symbol, dataType, scalar: isScalar(dataType) };
                } catch (e) {
                    return { ok: false, path, error: e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : String(e) };
                }
            })();
            symbols.set(key, p);
        }
        return /** @type {Promise<Resolved>} */ (symbols.get(key));
    }

    /**
     * Reads many resolved symbols with sum commands.
     * @param {Array<Resolved>} list Resolved, `ok` entries.
     * @returns {Promise<Map<string, {ok: boolean, value?: any}>>} Keyed by path.
     */
    async function readMany(list) {
        /** @type {Map<string, {ok: boolean, value?: any}>} */
        const out = new Map();
        const c = client;
        if (!c || state !== 'online') return out;
        for (let i = 0; i < list.length; i += SUM_CHUNK) {
            const chunk = list.slice(i, i + SUM_CHUNK);
            const res = await c.readRawMulti(chunk.map(r => ({
                indexGroup: /** @type {any} */ (r.symbol).indexGroup, indexOffset: /** @type {any} */ (r.symbol).indexOffset, size: /** @type {any} */ (r.symbol).size
            })));
            for (let k = 0; k < chunk.length; k++) {
                const r = chunk[k];
                const raw = res[k];
                if (!raw || !raw.ok || !raw.value) { out.set(r.path, { ok: false }); continue; }
                try {
                    out.set(r.path, { ok: true, value: await c.convertFromRaw(raw.value, /** @type {Object} */ (r.dataType), r.symbol && r.symbol.attributes) });
                } catch (e) {
                    out.set(r.path, { ok: false });
                }
            }
        }
        return out;
    }

    /**
     * Subscribes to a path's value on change. Refused past the notification cap.
     * @param {string} path
     * @param {number} cycleMs
     * @param {(value: any) => void} onValue
     * @returns {Promise<{ok: true, handle: {unsubscribe: () => Promise<void>}, resolved: Resolved}|{ok: false, capped?: boolean, resolved?: Resolved}>}
     */
    async function subscribe(path, cycleMs, onValue) {
        const c = client;
        if (!c || state !== 'online') return { ok: false };
        const max = deps.maxNotifications ? deps.maxNotifications() : 100;
        if (subscriptions.size >= max) return { ok: false, capped: true };
        const resolved = await resolve(path);
        if (!resolved.ok || c !== client) return { ok: false, resolved };
        if (subscriptions.size >= max) return { ok: false, capped: true, resolved };
        /** @type {{unsubscribe: () => Promise<void>}} */
        const handle = { unsubscribe: async () => {} };
        subscriptions.add(handle);
        try {
            const sub = await c.subscribeRaw(/** @type {any} */ (resolved.symbol), cycleMs, (data) => {
                c.convertFromRaw(data, /** @type {Object} */ (resolved.dataType), resolved.symbol && resolved.symbol.attributes)
                    .then(v => { if (c === client) onValue(v); })
                    .catch(() => {});
            });
            handle.unsubscribe = async () => {
                subscriptions.delete(handle);
                try { await sub.unsubscribe(); } catch (e) { /* the connection may be gone */ }
            };
            if (c !== client) { await handle.unsubscribe(); return { ok: false, resolved }; }
            return { ok: true, handle, resolved };
        } catch (e) {
            subscriptions.delete(handle);
            return { ok: false, resolved };
        }
    }

    /**
     * One write. The caller (writeGuard.performWrite) has already checked and confirmed it.
     * @param {string} path
     * @param {any} value
     */
    async function write(path, value) {
        const c = client;
        if (!c || state !== 'online') throw new Error('Not online.');
        await c.writeValue(path, value);
    }

    /**
     * The PLC's symbol upload (top-level symbols: name, type, byte size), read once until the symbols change.
     * @returns {Promise<Array<{name: string, type: string, size?: number}>>}
     */
    function onlineSymbols() {
        const c = client;
        if (!c || state !== 'online') return Promise.reject(new Error('Not online.'));
        if (!symbolList) {
            const p = c.getSymbols();
            p.catch(() => { if (symbolList === p) symbolList = null; });
            symbolList = p;
        }
        return symbolList;
    }

    /**
     * Instance paths of the given FB types, from the PLC's symbol upload: top-level symbols of that
     * type and FB/struct members of that type nested up to `maxDepth` levels. Arrays of instances are
     * not listed.
     * @param {string[]} typeNames FB names (the FB and those deriving from it).
     * @param {{maxDepth?: number, maxResults?: number}} [o]
     * @returns {Promise<Array<{path: string, type: string}>>}
     */
    async function findInstances(typeNames, o = {}) {
        const c = client;
        if (!c || state !== 'online') return [];
        const wanted = new Set(typeNames.map(t => t.toLowerCase()));
        const maxDepth = o.maxDepth || 4;
        const maxResults = o.maxResults || 100;
        const all = await onlineSymbols();
        /** @type {Array<{path: string, type: string}>} */
        const found = [];
        /** @type {Map<string, Object|null>} */
        const types = new Map();
        /**
         * @param {Object} dt An ads-client data type with built subItems.
         * @param {string} base
         * @param {number} depth
         */
        const walk = (dt, base, depth) => {
            if (depth > maxDepth || found.length >= maxResults) return;
            for (const sub of /** @type {any} */ (dt).subItems || []) {
                if (found.length >= maxResults) return;
                if (sub.arrayInfos && sub.arrayInfos.length) continue;
                const p = `${base}.${sub.name}`;
                if (wanted.has(String(sub.type).toLowerCase())) found.push({ path: p, type: sub.type });
                if (sub.subItems && sub.subItems.length) walk(sub, p, depth + 1);
            }
        };
        for (const s of all) {
            if (found.length >= maxResults) break;
            if (wanted.has(String(s.type).toLowerCase())) { found.push({ path: s.name, type: s.type }); continue; }
            if (/^TwinCAT_|^Constants\.|^Global_Version\./i.test(s.name)) continue;
            const key = String(s.type).toLowerCase();
            if (!types.has(key)) {
                try { types.set(key, await c.getDataType(s.type)); } catch (e) { types.set(key, null); }
            }
            const dt = types.get(key);
            if (dt && /** @type {any} */ (dt).subItems && /** @type {any} */ (dt).subItems.length) walk(dt, s.name, 1);
        }
        return found;
    }

    return {
        connect, disconnect, resolve, readMany, subscribe, write, findInstances, refreshStatus, onlineSymbols,
        get state() { return state; },
        get target() { return target; },
        get info() { return info; },
        get subscriptionCount() { return subscriptions.size; },
        get closingCount() { return closing.size; },
        /** @param {(what: string) => void} fn @returns {{dispose: () => void}} */
        onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }
    };
}

module.exports = { createOnlineSession, APP_INFO };
