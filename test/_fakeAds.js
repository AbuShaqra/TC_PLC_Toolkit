/**
 * @file _fakeAds.js
 * @description A PLC in memory for the online-monitoring harnesses (R15). There is no PLC in CI, so
 * src/online/ is written against the small `AdsPort` interface of src/online/adsClient.js, and this
 * module implements it over a symbol table the test controls:
 *
 *   const plc = createFakePlc({ symbols: { 'MAIN.nCount': { type: 'INT', value: 1 } } });
 *   const session = createOnlineSession({ createClient: plc.createClient });
 *
 * It counts what a real router would see — open connections, active notifications, reads, writes —
 * so a test can assert that nothing is left open, that the cap held, that a refused write never
 * reached the PLC. `plc.set(path, value)` changes a value and fires the on-change notifications.
 * `fakeAdsClientClass()` is a stand-in for ads-client's own `Client`, for the adapter's contract test.
 */

'use strict';

const BASE_SIZES = { BOOL: 1, BYTE: 1, SINT: 1, USINT: 1, INT: 2, UINT: 2, WORD: 2, DINT: 4, UDINT: 4, DWORD: 4, REAL: 4,
    LINT: 8, ULINT: 8, LWORD: 8, LREAL: 8, TIME: 4 };

/** Encodes a value as the fake's "raw bytes" (JSON, BigInt-safe). */
function encode(value) {
    return Buffer.from(JSON.stringify({ v: value }, (_, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x)));
}
/** Decodes `encode`'s bytes. */
function decode(buf) {
    return JSON.parse(buf.toString(), (_, x) => (x && typeof x === 'object' && '$big' in x ? BigInt(x.$big) : x)).v;
}

/**
 * The data type the fake answers for a type name: scalars are bare; `struct` gives members.
 * @param {string} type
 * @param {Object} [extra] `{ subItems, arrayInfos, enumInfos }`.
 */
function dataType(type, extra = {}) {
    return { name: type, type: '', size: BASE_SIZES[String(type).replace(/\(.*$/, '').toUpperCase()] || 81,
        subItems: [], arrayInfos: [], enumInfos: [], arrayDimension: 0, ...extra };
}

/**
 * @param {Object} o
 * @param {Record<string, {type: string, value: any, dataType?: Object, size?: number}>} [o.symbols]
 * @param {{ProjectName?: string, forces?: {plc: boolean, io: boolean}|null, OnlineChangeCnt?: number}} [o.appInfo]
 * @param {Record<string, Object>} [o.types] Extra data types by name (struct/FB/array types).
 */
function createFakePlc(o = {}) {
    const plc = {
        symbols: new Map(),
        types: new Map(),
        state: 'Run',
        openConnections: 0,
        clients: [],
        reads: 0,
        sumReads: 0,
        writes: [],
        /** What the next connect() does: { delayMs, error, hang } */
        connectBehavior: {},
        /** Error thrown by getDataType for these type names (to exercise the readValue fallback). */
        noDataType: new Set(),
        /** @type {Set<{path: string, onData: Function}>} */
        notifications: new Set(),
        appInfo: { ProjectName: 'TcToolkitSample_PLC', OnlineChangeCnt: 1, forces: { plc: false, io: false }, ...(o.appInfo || {}) }
    };
    let offset = 0;
    const addSymbol = (name, s) => {
        const dt = s.dataType || plc.types.get(String(s.type).toLowerCase()) || dataType(s.type);
        plc.symbols.set(name.toLowerCase(), { name, type: s.type, size: s.size || dt.size, indexGroup: 0x4040, indexOffset: (offset += 16), value: s.value, dataType: dt });
    };
    for (const [n, t] of Object.entries(o.types || {})) plc.types.set(n.toLowerCase(), t);
    for (const [n, s] of Object.entries(o.symbols || {})) addSymbol(n, s);
    plc.addSymbol = addSymbol;
    plc.removeSymbol = (name) => plc.symbols.delete(name.toLowerCase());

    const APP = 'TwinCAT_SystemInfoVarList._AppInfo.';
    const appValue = (path) => {
        const field = path.slice(APP.length);
        if (field === 'ActivePlcForces' || field === 'ActiveIoForces') {
            if (!plc.appInfo.forces) throw Object.assign(new Error('symbol not found'), { adsError: { errorCode: 1808 } });
            return field === 'ActivePlcForces' ? plc.appInfo.forces.plc : plc.appInfo.forces.io;
        }
        if (field in plc.appInfo) return plc.appInfo[field];
        throw Object.assign(new Error('symbol not found'), { adsError: { errorCode: 1808 } });
    };

    /** Changes a value and fires its notifications. */
    plc.set = (path, value) => {
        const s = plc.symbols.get(path.toLowerCase());
        if (!s) throw new Error('no symbol ' + path);
        s.value = value;
        for (const n of plc.notifications) if (n.path === s.name.toLowerCase()) n.onData(encode(value));
    };
    plc.get = (path) => { const s = plc.symbols.get(path.toLowerCase()); return s ? s.value : undefined; };

    /** @param {import('../src/online/adsClient').ConnectOptions} options */
    plc.createClient = (options) => {
        const handlers = new Map();
        let open = false;
        let closed = false;
        const own = new Set();
        const fire = (ev, ...a) => (handlers.get(ev) || []).forEach(fn => fn(...a));
        const need = () => { if (!open) throw new Error('Client is not connected'); };
        const notFound = (path) => Object.assign(new Error(`getSymbol(): Reading symbol for ${path} failed`), { adsError: { errorCode: 1808, errorStr: 'Symbol not found' } });
        const client = {
            options,
            fire,
            async connect() {
                const b = plc.connectBehavior;
                if (b.delayMs) await new Promise(r => setTimeout(r, b.delayMs));
                if (b.error) throw b.error;
                if (closed) throw Object.assign(new Error('cancelled'), { cancelled: true });
                open = true;
                plc.openConnections++;
                return { localAmsNetId: '10.0.0.5.1.1', targetAmsNetId: options.targetAmsNetId, targetAdsPort: options.targetAdsPort };
            },
            async disconnect() {
                closed = true;
                for (const n of own) plc.notifications.delete(n);
                own.clear();
                if (open) { open = false; plc.openConnections--; }
            },
            async getSymbol(path) {
                need();
                if (path.startsWith(APP)) return { name: path, type: 'BOOL', size: 1, indexGroup: 1, indexOffset: 1 };
                const s = plc.symbols.get(path.toLowerCase());
                if (!s) throw notFound(path);
                return { name: s.name, type: s.type, size: s.size, indexGroup: s.indexGroup, indexOffset: s.indexOffset, attributes: [] };
            },
            async getDataType(name) {
                need();
                if (plc.noDataType.has(name.toLowerCase())) throw new Error('no data type ' + name);
                for (const s of plc.symbols.values()) if (s.type.toLowerCase() === name.toLowerCase()) return s.dataType;
                return plc.types.get(name.toLowerCase()) || dataType(name);
            },
            async getSymbols() {
                need();
                return [...plc.symbols.values()].filter(s => !s.name.includes('.', s.name.indexOf('.') + 1)).map(s => ({ name: s.name, type: s.type, size: s.size }));
            },
            async readRawMulti(cmds) {
                need();
                plc.sumReads++;
                return cmds.map(c => {
                    plc.reads++;
                    const s = [...plc.symbols.values()].find(x => x.indexOffset === c.indexOffset);
                    return s ? { ok: true, value: encode(s.value), errorCode: 0 } : { ok: false, errorCode: 1793 };
                });
            },
            async convertFromRaw(buf) { return decode(buf); },
            async readValue(path) {
                need();
                if (path.startsWith(APP)) return { value: appValue(path), dataType: dataType('BOOL') };
                const s = plc.symbols.get(path.toLowerCase());
                if (!s) throw notFound(path);
                plc.reads++;
                return { value: s.value, dataType: s.dataType };
            },
            async writeValue(path, value) {
                need();
                const s = plc.symbols.get(path.toLowerCase());
                if (!s) throw notFound(path);
                plc.writes.push({ path: s.name, value });
                plc.set(s.name, value);
            },
            async subscribeRaw(symbol, cycleMs, onData) {
                need();
                const n = { path: symbol.name.toLowerCase(), cycleMs, onData };
                plc.notifications.add(n);
                own.add(n);
                const s = plc.symbols.get(n.path);
                if (s) setImmediate(() => { if (plc.notifications.has(n)) onData(encode(s.value)); });
                return { unsubscribe: async () => { plc.notifications.delete(n); own.delete(n); } };
            },
            async readPlcState() { need(); return { state: plc.state, code: plc.state === 'Run' ? 5 : 6 }; },
            on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); }
        };
        plc.clients.push(client);
        return client;
    };
    return plc;
}

/**
 * A stand-in for ads-client's `Client` class: records its settings and calls, and lets a test decide
 * when `connect()` settles — which is what the adapter's "disconnect while connecting" rule needs.
 */
function fakeAdsClientClass() {
    const instances = [];
    class Client {
        constructor(settings) {
            this.settings = settings;
            this.calls = [];
            this.listeners = new Map();
            this.connected = false;
            this.connectGate = null;
            instances.push(this);
        }
        on(ev, fn) { this.listeners.set(ev, fn); }
        connect() {
            this.calls.push('connect');
            return new Promise((resolve, reject) => {
                this.connectGate = { resolve: () => { this.connected = true; resolve({ localAmsNetId: '1.2.3.4.1.1', targetAmsNetId: this.settings.targetAmsNetId, targetAdsPort: this.settings.targetAdsPort }); }, reject };
            });
        }
        async disconnect(force) { this.calls.push(force ? 'disconnect(force)' : 'disconnect'); this.connected = false; }
        async unsubscribeAll() { this.calls.push('unsubscribeAll'); }
        async subscribeRaw(ig, io, size, cb, cycle, onChange) {
            this.calls.push(`subscribeRaw(${ig},${io},${size},${cycle},${onChange})`);
            this.lastCallback = cb;
            return { unsubscribe: async () => { this.calls.push('unsubscribe'); } };
        }
        async readPlcRuntimeState() { return { adsState: 6, adsStateStr: 'Stop' }; }
        async readRawMulti(cmds) { return cmds.map(() => ({ success: false, errorCode: 1793, value: undefined })); }
    }
    return { Client, instances };
}

module.exports = { createFakePlc, fakeAdsClientClass, dataType, encode, decode };
