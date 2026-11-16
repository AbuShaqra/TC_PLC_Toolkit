/**
 * @file adsClient.js
 * @description Online monitoring (R15): the ONE place that touches the `ads-client` library. It
 * adapts ads-client 2.2.0 to the small interface the rest of src/online/ is written against
 * (`AdsPort` below), so the session, the poller, the watch list and the write path run unchanged
 * against test/_fakeAds.js in the harnesses — there is no PLC in CI.
 *
 * Connection modes (user decision D3, 2026-11-13):
 *   - `router` (default): through the AMS router on this PC (TwinCAT XAE/XAR, with the routes set up
 *     in XAE). ads-client registers an ADS port at the router's address, 127.0.0.1:48898 unless the
 *     untested `tcToolkit.online.routerAddress` says otherwise. No local AmsNetId is ever set in this
 *     mode — that would turn it into a direct connection.
 *   - `direct`: only when the setting asks for it, for a PC without TwinCAT. The PLC's IP is the
 *     router address, and the local AmsNetId and ADS port come from settings (the PLC needs a static
 *     route to this PC for them, created in XAE or on the PLC; this extension never creates routes).
 *   There is no fallback from one mode to the other, ever.
 *   Router mode has ONE fallback, of transport rather than mode (R15 phase 2, user decision
 *   2026-11-16): when the router on this PC refuses ads-client's TCP connection (the TwinCAT 3.1.4026
 *   user-mode router resets it), on Windows the same ads-client code runs again over a PowerShell
 *   helper that uses TwinCAT's own ADS DLL (src/online/helperClient.js). Remote routers, direct mode
 *   and every other failure keep the TCP path and its error.
 *
 * Library defects worked around here (docs/r15-ads-decision.md section 2):
 *   - #189: a notification whose value fails to parse (64-bit values) throws inside the library's own
 *     error handler, an unhandled rejection. Subscriptions therefore go through `subscribeRaw`, whose
 *     parse step only copies the bytes and cannot fail; the bytes are converted here, inside a
 *     try/catch.
 *   - ads-client emits `client-error` and `warning` events; both are always listened to, and its
 *     console warnings are switched off (`hideConsoleWarnings`).
 *   - ads-client RESTORES subscriptions by itself after an auto-reconnect and after a symbol-version
 *     change (a download): it subscribes them again as new objects with new notification handles,
 *     while the handles this adapter gave out still wrap the old objects. The session answers both
 *     events by subscribing everything again itself, so the library's copies would leak one PLC
 *     notification each per event, uncounted against the cap. So on either event this adapter first
 *     retires every handle it gave out (its `unsubscribe` and its data become no-ops: a stale
 *     DeleteNotification could hit a handle number the PLC has reused) and deletes the library's
 *     restored copies (`unsubscribeAll`, which leaves the library's internal subscriptions alone),
 *     and only then tells the session.
 *   - After `disconnect`, a reconnect attempt the library had already started can still land (its
 *     timer is cleared, the attempt in flight is not). A reconnect on a closed adapter is closed again.
 */

'use strict';

/**
 * @typedef {Object} ConnectOptions
 * @property {'router'|'direct'} mode
 * @property {string} targetAmsNetId `localhost` or six octets.
 * @property {number} targetAdsPort 851 for the first PLC runtime.
 * @property {string} [routerAddress] Router (or, in direct mode, PLC) address.
 * @property {number} [routerTcpPort]
 * @property {string} [localAmsNetId] Direct mode only.
 * @property {number} [localAdsPort] Direct mode only.
 * @property {number} [timeoutMs] ADS command timeout.
 */

/**
 * @typedef {Object} AdsSymbolInfo
 * @property {string} name
 * @property {string} type
 * @property {number} size
 * @property {number} indexGroup
 * @property {number} indexOffset
 * @property {Array<Object>} [attributes]
 */

/**
 * @typedef {Object} AdsPort The interface everything in src/online/ talks to.
 * @property {() => Promise<{localAmsNetId: string, targetAmsNetId: string, targetAdsPort: number, transport: 'tcp'|'helper'}>} connect
 * @property {() => Promise<void>} disconnect Closes the connection; safe to call twice or while connecting.
 * @property {(path: string) => Promise<AdsSymbolInfo>} getSymbol
 * @property {(name: string) => Promise<Object>} getDataType
 * @property {() => Promise<Array<{name: string, type: string, size: number}>>} getSymbols
 * @property {(cmds: Array<{indexGroup: number, indexOffset: number, size: number}>) =>
 *   Promise<Array<{ok: boolean, value?: Buffer, errorCode: number}>>} readRawMulti
 * @property {(data: Buffer, dataType: Object, attributes?: Array<Object>) => Promise<any>} convertFromRaw
 * @property {(path: string) => Promise<{value: any, dataType: Object}>} readValue
 * @property {(path: string, value: any) => Promise<void>} writeValue
 * @property {(symbol: AdsSymbolInfo, cycleMs: number, onData: (data: Buffer) => void) =>
 *   Promise<{unsubscribe: () => Promise<void>}>} subscribeRaw
 * @property {() => Promise<{state: string, code: number}>} readPlcState
 * @property {(event: 'connectionLost'|'reconnect'|'plcState'|'symbolVersion'|'warning'|'error'|'notice', fn: Function) => void} on
 */

/** The router's TCP port, the same on every TwinCAT router. */
const DEFAULT_ROUTER_PORT = 48898;

/**
 * The ads-client settings for one connection. Pure, so the "never direct by accident" rule is
 * testable: router mode never carries a local AmsNetId or ADS port.
 * @param {ConnectOptions} o
 * @returns {Object} ads-client `AdsClientSettings`.
 * @throws {Error} When direct mode lacks its three settings.
 */
function buildClientSettings(o) {
    const base = {
        targetAmsNetId: o.targetAmsNetId,
        targetAdsPort: o.targetAdsPort,
        routerTcpPort: o.routerTcpPort || DEFAULT_ROUTER_PORT,
        timeoutDelay: o.timeoutMs || 2000,
        autoReconnect: true,
        hideConsoleWarnings: true,
        objectifyEnumerations: true,
        convertDatesToJavascript: true,
        readAndCacheSymbols: false,
        readAndCacheDataTypes: false,
        monitorPlcSymbolVersion: true
    };
    if (o.mode === 'direct') {
        if (!o.routerAddress || !o.localAmsNetId || !o.localAdsPort) {
            throw new Error('Direct mode needs tcToolkit.online.direct.plcAddress, tcToolkit.online.direct.localAmsNetId ' +
                'and tcToolkit.online.direct.localAdsPort.');
        }
        return { ...base, routerAddress: o.routerAddress, localAmsNetId: o.localAmsNetId, localAdsPort: o.localAdsPort };
    }
    return { ...base, routerAddress: o.routerAddress || '127.0.0.1' };
}

/**
 * Whether a failed connect is the local router refusing ads-client's TCP connection — the one case
 * that switches to the PowerShell ADS helper (user decision 2026-11-16, "fallback on refusal only").
 * True only in router mode with the router on this PC, and only when the router reset or refused the
 * TCP connection, closed or ended it during the connect, or did not register our ADS port. A timeout,
 * a missing route or a missing PLC is not a refusal: those keep today's message.
 * @param {any} err What ads-client's `connect()` threw.
 * @param {ConnectOptions} o
 * @returns {boolean}
 */
function isRouterRefusal(err, o) {
    if (!o || o.mode === 'direct' || !isLoopback(o.routerAddress)) return false;
    const raw = errorText(err);
    if (/Registering ADS port failed/i.test(raw)) return true;
    if (!/Connecting to \S+ failed/i.test(raw)) return false;
    return /socket error (?:-4077|-4078|-104|-111|-54|-61)\b|ECONNRESET|ECONNREFUSED|socket (?:closed|ended) by remote/i.test(raw);
}

/**
 * The text of an error and its causes (ads-client keeps them in `trace`).
 * @param {any} err
 * @returns {string}
 */
function errorText(err) {
    if (!err) return '';
    const trace = Array.isArray(err.trace) && err.trace.length ? err.trace.join(' <- ') : '';
    return trace || String(err.message || err);
}

/**
 * Whether a router address is this PC (the default when unset).
 * @param {string|undefined} address
 * @returns {boolean}
 */
function isLoopback(address) {
    const a = String(address || '127.0.0.1').trim().toLowerCase();
    return a === 'localhost' || a === '::1' || /^127\./.test(a);
}

/**
 * Wraps one ads-client `Client` as an `AdsPort`. In router mode with the router on this PC, on Windows,
 * a refused TCP connection (`isRouterRefusal`) switches this port to the PowerShell ADS helper
 * (src/online/helperClient.js) and connects again; the switch is announced on the `notice` event and
 * `connect()` resolves with `transport: 'helper'`. Everything after the connect is the same code.
 * @param {ConnectOptions} options
 * @param {{Client?: any, platform?: string, HelperClient?: any, startHelper?: (o: Object) => Promise<import('./adsHelperProcess').AdsHelper>, fallback?: boolean}} [deps]
 *   `Client` is ads-client's class; `HelperClient` replaces the helper-backed class (harnesses);
 *   `startHelper` replaces the helper process start; `fallback: false` turns the switch off.
 * @returns {AdsPort}
 */
function createAdsClient(options, deps = {}) {
    const Client = deps.Client || require('ads-client').Client;
    const platform = deps.platform || process.platform;
    const settings = buildClientSettings(options);
    const canFallBack = deps.fallback !== false && platform === 'win32' && options.mode !== 'direct' && isLoopback(options.routerAddress);
    /** @type {Map<string, Function[]>} */
    const handlers = new Map();
    const emit = (/** @type {string} */ event, /** @type {any[]} */ ...args) => {
        for (const fn of handlers.get(event) || []) {
            try { fn(...args); } catch (e) { /* a listener's own failure is not the connection's */ }
        }
    };
    let closed = false;
    /** Bumped when the library replaces our subscriptions; a handle of an older generation is retired. */
    let generation = 0;
    /** @type {'tcp'|'helper'} */
    let transport = 'tcp';
    /** @type {any} */
    let client = null;

    /**
     * Listens to one client's events; a client this port has moved past is ignored.
     * @param {any} c
     */
    const attach = (c) => {
        const mine = () => c === client;
        /**
         * Retires every handle given out and drops the subscriptions the library restored on its own,
         * then announces the event (see the file header).
         * @param {string} event
         */
        const afterRestore = async (event) => {
            if (!mine()) return;
            generation++;
            if (closed) {
                // Go Offline already ran: whatever reconnected here has no owner. Close it.
                try { await c.disconnect(true); } catch (e) { /* already closed */ }
                return;
            }
            try { await c.unsubscribeAll(); } catch (e) { /* the connection may be gone again */ }
            if (!closed) emit(event);
        };
        c.on('client-error', (/** @type {any} */ err) => { if (mine()) emit('error', err); });
        c.on('warning', (/** @type {string} */ msg) => { if (mine()) emit('warning', msg); });
        c.on('connectionLost', () => { if (mine()) emit('connectionLost'); });
        c.on('reconnect', () => { afterRestore('reconnect'); });
        c.on('plcRuntimeStateChange', (/** @type {any} */ s) => { if (mine()) emit('plcState', stateOf(s)); });
        c.on('plcSymbolVersionChange', () => { afterRestore('symbolVersion'); });
    };
    client = new Client(settings);
    attach(client);
    /** @type {Promise<any>|null} */
    let pending = null;

    /**
     * One connect of the current client; a failure closes it so no socket outlives the attempt.
     * @returns {Promise<any>}
     */
    const connectOnce = async () => {
        const c = client;
        pending = c.connect();
        try {
            const res = await pending;
            if (closed) throw Object.assign(new Error('cancelled'), { cancelled: true });
            return res;
        } catch (e) {
            // A failure after the socket opened (no PLC on the port, CONFIG mode) leaves the socket
            // registered; close it so no connection outlives the failed attempt.
            try { await c.disconnect(true); } catch (e2) { /* already closed */ }
            throw e;
        } finally {
            pending = null;
        }
    };

    /** @type {AdsPort} */
    const port = {
        async connect() {
            let c;
            try {
                c = await connectOnce();
            } catch (e) {
                const first = /** @type {any} */ (e);
                if (closed || first.cancelled || !canFallBack || !isRouterRefusal(first, options)) throw first;
                const HelperClient = deps.HelperClient || require('./helperClient').createHelperClientClass(Client, {
                    startHelper: deps.startHelper, log: (/** @type {string} */ line) => emit('notice', line)
                });
                emit('notice', `The ADS router at ${options.routerAddress || '127.0.0.1'}:${settings.routerTcpPort} refused this client's TCP connection ` +
                    `(${errorText(first).trim()}). Trying TwinCAT's own ADS DLL through a PowerShell helper (user-mode fallback).`);
                transport = 'helper';
                client = new HelperClient(settings);
                attach(client);
                try {
                    c = await connectOnce();
                } catch (e2) {
                    const second = /** @type {any} */ (e2);
                    if (!second.cancelled) second.fallback = { routerError: errorText(first).trim() };
                    throw second;
                }
                const info = client.helperInfo || {};
                emit('notice', `Connected through TwinCAT's ADS DLL${info.dll ? ` (${info.dll}${info.dllVersion ? `, version ${info.dllVersion}` : ''}` +
                    `${info.bitness ? `, ${info.bitness}-bit PowerShell` : ''})` : ''}. Values are polled through the helper.`);
            }
            return { localAmsNetId: c.localAmsNetId, targetAmsNetId: c.targetAmsNetId, targetAdsPort: c.targetAdsPort, transport };
        },
        async disconnect() {
            if (closed) return;
            closed = true;
            // ads-client's disconnect() is a no-op while a connect is still in flight, so a cancelled
            // Go Online waits for that attempt to settle (connect() above then closes it itself).
            while (pending) {
                try { await pending; } catch (e) { /* connectOnce() closed it */ }
            }
            const c = client;
            try { await c.unsubscribeAll(); } catch (e) { /* the connection may already be gone */ }
            try { await c.disconnect(); } catch (e) {
                try { await c.disconnect(true); } catch (e2) { /* nothing left to close */ }
            }
        },
        async getSymbol(path) { return client.getSymbol(path); },
        async getDataType(name) { return client.getDataType(name); },
        async getSymbols() {
            const all = await client.getSymbols();
            return Object.keys(all).map(k => ({ name: all[k].name, type: all[k].type, size: all[k].size }));
        },
        async readRawMulti(cmds) {
            const res = await client.readRawMulti(cmds);
            return res.map((/** @type {any} */ r) => ({ ok: !!r.success, value: r.value, errorCode: r.errorCode }));
        },
        async convertFromRaw(data, dataType, attributes) { return client.convertFromRaw(data, dataType, attributes); },
        async readValue(path) {
            const r = await client.readValue(path);
            return { value: r.value, dataType: r.dataType };
        },
        async writeValue(path, value) { await client.writeValue(path, value); },
        async subscribeRaw(symbol, cycleMs, onData) {
            const mine = generation;
            const live = () => mine === generation && !closed;
            const sub = await client.subscribeRaw(symbol.indexGroup, symbol.indexOffset, symbol.size,
                (/** @type {any} */ data) => {
                    if (!live()) return;
                    try { onData(data.value); } catch (e) { emit('error', e); }
                }, cycleMs, true);
            if (!live()) {
                // The library replaced its subscriptions while this one was being made: it is a stray.
                try { await sub.unsubscribe(); } catch (e) { /* gone with the old connection */ }
                throw new Error('The PLC connection was re-established while subscribing.');
            }
            // A retired handle never sends a DeleteNotification: its number may belong to someone else now.
            return { unsubscribe: async () => { if (mine === generation) await sub.unsubscribe(); } };
        },
        async readPlcState() { return stateOf(await client.readPlcRuntimeState()); },
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, []);
            /** @type {Function[]} */ (handlers.get(event)).push(fn);
        }
    };
    return port;
}

/**
 * An ads-client `AdsState` as the session names it.
 * @param {any} s
 * @returns {{state: string, code: number}}
 */
function stateOf(s) {
    const code = s && typeof s.adsState === 'number' ? s.adsState : -1;
    return { state: (s && s.adsStateStr) || STATE_NAMES[code] || 'Unknown', code };
}

/** ADS state codes (ADS_STATE in ads-client's ads-commons), for a state without its string. */
const STATE_NAMES = { 5: 'Run', 6: 'Stop', 15: 'Config', 11: 'Error', 19: 'Exception' };

module.exports = { createAdsClient, buildClientSettings, stateOf, isRouterRefusal, isLoopback, DEFAULT_ROUTER_PORT };
