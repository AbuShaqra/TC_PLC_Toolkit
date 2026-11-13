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
 *
 * Library defects worked around here (docs/r15-ads-decision.md section 2):
 *   - #189: a notification whose value fails to parse (64-bit values) throws inside the library's own
 *     error handler, an unhandled rejection. Subscriptions therefore go through `subscribeRaw`, whose
 *     parse step only copies the bytes and cannot fail; the bytes are converted here, inside a
 *     try/catch.
 *   - ads-client emits `client-error` and `warning` events; both are always listened to, and its
 *     console warnings are switched off (`hideConsoleWarnings`).
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
 * @property {() => Promise<{localAmsNetId: string, targetAmsNetId: string, targetAdsPort: number}>} connect
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
 * @property {(event: 'connectionLost'|'reconnect'|'plcState'|'symbolVersion'|'warning'|'error', fn: Function) => void} on
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
 * Wraps one ads-client `Client` as an `AdsPort`.
 * @param {ConnectOptions} options
 * @param {{Client?: any}} [deps] `Client` is ads-client's class; injectable for a contract test.
 * @returns {AdsPort}
 */
function createAdsClient(options, deps = {}) {
    const Client = deps.Client || require('ads-client').Client;
    const client = new Client(buildClientSettings(options));
    /** @type {Map<string, Function[]>} */
    const handlers = new Map();
    const emit = (/** @type {string} */ event, /** @type {any[]} */ ...args) => {
        for (const fn of handlers.get(event) || []) {
            try { fn(...args); } catch (e) { /* a listener's own failure is not the connection's */ }
        }
    };
    client.on('client-error', (/** @type {any} */ err) => emit('error', err));
    client.on('warning', (/** @type {string} */ msg) => emit('warning', msg));
    client.on('connectionLost', () => emit('connectionLost'));
    client.on('reconnect', () => emit('reconnect'));
    client.on('plcRuntimeStateChange', (/** @type {any} */ s) => emit('plcState', stateOf(s)));
    client.on('plcSymbolVersionChange', () => emit('symbolVersion'));
    let closed = false;
    /** @type {Promise<any>|null} */
    let pending = null;

    /** @type {AdsPort} */
    const port = {
        async connect() {
            pending = client.connect();
            try {
                const c = await pending;
                if (closed) throw Object.assign(new Error('cancelled'), { cancelled: true });
                return { localAmsNetId: c.localAmsNetId, targetAmsNetId: c.targetAmsNetId, targetAdsPort: c.targetAdsPort };
            } catch (e) {
                // A failure after the socket opened (no PLC on the port, CONFIG mode) leaves the socket
                // registered; close it so no connection outlives the failed attempt.
                try { await client.disconnect(true); } catch (e2) { /* already closed */ }
                throw e;
            } finally {
                pending = null;
            }
        },
        async disconnect() {
            if (closed) return;
            closed = true;
            // ads-client's disconnect() is a no-op while a connect is still in flight, so a cancelled
            // Go Online waits for that attempt to settle (connect() above then closes it itself).
            if (pending) {
                try { await pending; } catch (e) { /* connect() closed it */ }
            }
            try { await client.unsubscribeAll(); } catch (e) { /* the connection may already be gone */ }
            try { await client.disconnect(); } catch (e) {
                try { await client.disconnect(true); } catch (e2) { /* nothing left to close */ }
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
            const sub = await client.subscribeRaw(symbol.indexGroup, symbol.indexOffset, symbol.size,
                (/** @type {any} */ data) => {
                    try { onData(data.value); } catch (e) { emit('error', e); }
                }, cycleMs, true);
            return { unsubscribe: () => sub.unsubscribe() };
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

module.exports = { createAdsClient, buildClientSettings, stateOf, DEFAULT_ROUTER_PORT };
