/**
 * @file _fakeAdsHelper.js
 * @description A stand-in for resources/online/ads-helper.ps1 (R15 phase 2): a fake `spawn` whose
 * "powershell.exe" speaks the helper's JSON-lines protocol, backed by a raw-ADS PLC in memory
 * (`createRawPlc`). The raw PLC answers what ads-client asks for by index group and offset — symbol
 * info by name (0xF009) as the documented binary entry, data types by name (0xF011: ADS error 1808, so
 * ads-client builds its base types itself), the upload info, the symbol version, the device data,
 * the system service state on port 10000, sum reads (0xF080) and plain memory (0x4040) — so the real
 * ads-client code runs end to end over the helper transport. No PowerShell, no TwinCAT.
 */

'use strict';

const { EventEmitter } = require('events');

/**
 * One symbol entry as SymbolInfoByNameEx and the symbol upload return it (with its entry length).
 * @param {{name: string, type: string, ig: number, io: number, size: number, adsDataType: number}} s
 * @returns {Buffer}
 */
function encodeSymbol(s) {
    const name = Buffer.from(s.name, 'latin1');
    const type = Buffer.from(s.type, 'latin1');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(s.ig, 4);
    head.writeUInt32LE(s.io, 8);
    head.writeUInt32LE(s.size, 12);
    head.writeUInt32LE(s.adsDataType, 16);
    head.writeUInt16LE(0, 20);                 // flags
    head.writeUInt16LE(0, 22);                 // array dimension
    head.writeUInt16LE(name.length, 24);
    head.writeUInt16LE(type.length, 26);
    head.writeUInt16LE(0, 28);                 // comment length
    const entry = Buffer.concat([head, name, Buffer.from([0]), type, Buffer.from([0]), Buffer.from([0])]);
    entry.writeUInt32LE(entry.length, 0);
    return entry;
}

/**
 * A PLC at the raw-ADS level.
 * @param {Object} [o]
 * @param {string} [o.netId] The runtime's AMS NetId.
 * @param {number} [o.port]
 */
function createRawPlc(o = {}) {
    const plc = {
        netId: o.netId || '10.0.0.4.1.1',
        port: o.port || 851,
        routerNetId: '10.0.0.9.1.1',
        adsState: 5,
        symbolVersion: 1,
        memory: Buffer.alloc(512),
        /** @type {Array<{name: string, type: string, ig: number, io: number, size: number, adsDataType: number}>} */
        symbols: [
            { name: 'MAIN.nCount', type: 'INT', ig: 0x4040, io: 0, size: 2, adsDataType: 2 },
            { name: 'MAIN.bRun', type: 'BOOL', ig: 0x4040, io: 2, size: 1, adsDataType: 33 },
            { name: 'GVL.fValue', type: 'REAL', ig: 0x4040, io: 4, size: 4, adsDataType: 4 },
            { name: 'TwinCAT_SystemInfoVarList._AppInfo.ProjectName', type: 'STRING(63)', ig: 0x4040, io: 100, size: 64, adsDataType: 30 }
        ],
        /** Counts per helper command. */
        counts: /** @type {Record<string, number>} */ ({}),
        sumReads: 0,
        /** @param {string} name @param {number|boolean|string} v */
        set(name, v) {
            const s = plc.symbols.find(x => x.name.toLowerCase() === name.toLowerCase());
            if (!s) throw new Error('no symbol ' + name);
            if (s.type === 'INT') plc.memory.writeInt16LE(Number(v), s.io);
            else if (s.type === 'BOOL') plc.memory.writeUInt8(v ? 1 : 0, s.io);
            else if (s.type === 'REAL') plc.memory.writeFloatLE(Number(v), s.io);
            else { plc.memory.fill(0, s.io, s.io + s.size); plc.memory.write(String(v), s.io, 'latin1'); }
        },
        /**
         * One raw read; throws `{adsError}` like the helper reports.
         * @param {string} netId @param {number} port @param {number} ig @param {number} io @param {number} len
         * @param {Buffer} [wr] The write part of a ReadWrite.
         * @returns {Buffer}
         */
        read(netId, port, ig, io, len, wr) {
            if (port === 10000) {
                if (ig === 240) { const b = Buffer.alloc(16); b.writeUInt16LE(5, 0); b.writeUInt16LE(1, 2); return b; }
                throw { adsError: 0x702 };
            }
            if (netId !== plc.netId || port !== plc.port) throw { adsError: netId === plc.netId ? 6 : 7 };
            switch (ig) {
                case 0xF100: { const b = Buffer.alloc(4); b.writeUInt16LE(plc.adsState, 0); return b; }
                case 0xF008: return Buffer.from([plc.symbolVersion]);
                case 0xF00F: {
                    const b = Buffer.alloc(24);
                    b.writeUInt32LE(plc.symbols.length, 0);
                    b.writeUInt32LE(Buffer.concat(plc.symbols.map(encodeSymbol)).length, 4);
                    return b;
                }
                case 0xF00B: return Buffer.concat(plc.symbols.map(encodeSymbol)).subarray(0, len);
                case 0xF009: {
                    const name = String(wr).replace(/\0.*$/s, '');
                    const s = plc.symbols.find(x => x.name.toLowerCase() === name.toLowerCase());
                    if (!s) throw { adsError: 0x710 };
                    const e = encodeSymbol(s);
                    return e.subarray(0, Math.min(len, e.length));
                }
                case 0xF011: throw { adsError: 0x710 };
                case 0xF080: {
                    plc.sumReads++;
                    const n = io;
                    const codes = [];
                    const datas = [];
                    for (let i = 0; i < n; i++) {
                        const g = /** @type {Buffer} */ (wr).readUInt32LE(i * 12);
                        const off = /** @type {Buffer} */ (wr).readUInt32LE(i * 12 + 4);
                        const size = /** @type {Buffer} */ (wr).readUInt32LE(i * 12 + 8);
                        let d;
                        let code = 0;
                        try { d = plc.read(netId, port, g, off, size); } catch (e) { code = /** @type {any} */ (e).adsError; d = Buffer.alloc(size); }
                        const c = Buffer.alloc(4);
                        c.writeUInt32LE(code, 0);
                        codes.push(c);
                        const padded = Buffer.alloc(size);
                        d.copy(padded);
                        datas.push(padded);
                    }
                    return Buffer.concat([...codes, ...datas]);
                }
                case 0x4040: return Buffer.from(plc.memory.subarray(io, io + len));
                default: throw { adsError: 0x702 };
            }
        },
        /** @param {string} netId @param {number} port @param {number} ig @param {number} io @param {Buffer} data */
        write(netId, port, ig, io, data) {
            if (netId !== plc.netId || port !== plc.port) throw { adsError: netId === plc.netId ? 6 : 7 };
            if (ig !== 0x4040) throw { adsError: 0x702 };
            data.copy(plc.memory, io);
        }
    };
    return plc;
}

/**
 * A fake `spawn` for the helper, backed by `plc`.
 * @param {ReturnType<typeof createRawPlc>} plc
 * @param {Object} [o]
 * @param {any} [o.ready] The ready line to send (default ok).
 * @param {(req: any) => any} [o.intercept] Return an answer object to override, `'hang'` to never answer.
 * @param {boolean} [o.ignoreStdinEnd] Do not exit when stdin ends (a hung helper).
 */
function createFakeHelperSpawn(plc, o = {}) {
    /** @type {Array<{cmd: string, args: string[], opts: any, proc: any, requests: any[], exited: boolean, killed: boolean}>} */
    const spawned = [];
    /**
     * @param {string} cmd
     * @param {string[]} args
     * @param {any} opts
     */
    function spawn(cmd, args, opts) {
        const proc = /** @type {any} */ (new EventEmitter());
        const rec = { cmd, args, opts, proc, requests: /** @type {any[]} */ ([]), exited: false, killed: false };
        spawned.push(rec);
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        const exit = (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
            if (rec.exited) return;
            rec.exited = true;
            setImmediate(() => proc.emit('exit', code, signal));
        };
        const send = (/** @type {any} */ m) => { if (!rec.exited) proc.stdout.emit('data', Buffer.from(JSON.stringify(m) + '\r\n')); };
        proc.kill = () => { rec.killed = true; exit(null, 'SIGTERM'); return true; };
        proc.crash = () => exit(1, null);
        let buf = '';
        proc.stdin = {
            on() {},
            write(/** @type {string} */ chunk) {
                if (rec.exited) throw new Error('EPIPE');
                buf += chunk;
                const lines = buf.split('\n');
                buf = /** @type {string} */ (lines.pop());
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const req = JSON.parse(line);
                    rec.requests.push(req);
                    setImmediate(() => answer(req));
                }
                return true;
            },
            end() { if (!o.ignoreStdinEnd) exit(0, null); }
        };
        /** @param {any} req */
        function answer(req) {
            plc.counts[req.cmd] = (plc.counts[req.cmd] || 0) + 1;
            if (o.intercept) {
                const r = o.intercept(req);
                if (r === 'hang') return;
                if (r) { send({ id: req.id, ...r }); return; }
            }
            const netId = req.netId === '127.0.0.1.1.1' ? plc.routerNetId : req.netId;
            try {
                switch (req.cmd) {
                    case 'open': send({ id: req.id, ok: true, localNetId: plc.routerNetId, localPort: 32905 }); return;
                    case 'read': send({ id: req.id, ok: true, data: plc.read(netId, req.port, req.ig, req.io, req.len).toString('base64') }); return;
                    case 'readwrite': send({ id: req.id, ok: true, data: plc.read(netId, req.port, req.ig, req.io, req.len, Buffer.from(req.data, 'base64')).toString('base64') }); return;
                    case 'write': plc.write(netId, req.port, req.ig, req.io, Buffer.from(req.data, 'base64')); send({ id: req.id, ok: true }); return;
                    case 'state':
                        if (req.port !== 10000 && (netId !== plc.netId || req.port !== plc.port)) throw { adsError: netId === plc.netId ? 6 : 7 };
                        send({ id: req.id, ok: true, adsState: req.port === 10000 ? 5 : plc.adsState, deviceState: 0 }); return;
                    case 'deviceinfo': send({ id: req.id, ok: true, name: req.port === 10000 ? 'TwinCAT System' : 'Plc30 App', major: 3, minor: 1, build: 2144 }); return;
                    case 'close': send({ id: req.id, ok: true, closing: true }); exit(0, null); return;
                    default: send({ id: req.id, ok: false, error: `unknown command "${req.cmd}"` });
                }
            } catch (e) {
                const err = /** @type {any} */ (e);
                send({ id: req.id, ok: false, error: `Ads-Error 0x${(err.adsError || 0).toString(16)}`, adsError: err.adsError });
            }
        }
        setImmediate(() => send(o.ready || { id: 0, event: 'ready', ok: true, dll: 'C:\\TwinCAT\\3.1\\Components\\Base\\v170\\TwinCAT.Ads.dll', dllVersion: '4.3.32.0', bitness: 64, common: 'C:\\TwinCAT\\Common64' }));
        return proc;
    }
    return { spawn, spawned };
}

module.exports = { createRawPlc, createFakeHelperSpawn, encodeSymbol };
