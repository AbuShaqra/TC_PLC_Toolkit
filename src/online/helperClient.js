/**
 * @file helperClient.js
 * @description Online monitoring (R15 phase 2): ads-client's `Client` with its transport swapped for
 * the PowerShell ADS helper (src/online/adsHelperProcess.js), for a PC whose local router refuses
 * ads-client's TCP connection (the TwinCAT 3.1.4026 user-mode runtime).
 *
 * The seam is ads-client's own: every ADS request it makes goes through `sendAdsCommand(command)`
 * (an ADS command id plus the request payload it already serialised), and every response through
 * `parseAdsResponse(packet, data)`. This subclass overrides only the transport —
 * `connectToTarget`, `unregisterAdsPort`, `disconnectFromTarget` and `sendAdsCommand` — so symbol
 * lookups, the data type builder, value conversion, sum reads and writes are ads-client's code on both
 * paths and behave the same. The helper is asked for raw ADS only (Read, Write, ReadWrite,
 * ReadState, ReadDeviceInfo by NetId/port/index group/offset), and its answer is re-encoded as the ADS
 * response bytes ads-client parses itself.
 *
 * Notifications: TcAdsClient's notification callbacks would need a .NET event pump inside the helper.
 * Instead AddNotification/DeleteNotification are emulated here by polling: an added notification is
 * read once at once (an error is the AddNotification's error, as on a PLC; the value is the first
 * notification, as a PLC sends one), then every entry due on a 100 ms tick is read in ONE sum read per
 * target (ads-client's `readRawMulti`) and handed to ads-client's notification dispatcher
 * (`onAdsCommandReceived`) when it changed (on-change) or every cycle (cyclic). A cycle time of 0
 * (ads-client's own state and symbol-version subscriptions) polls every 500 ms.
 *
 * Relies on these ads-client 2.2.0 internals (pinned; test/test_ads_helper.js checks they exist):
 * `connectToTarget`, `disconnectFromTarget`, `unregisterAdsPort`, `sendAdsCommand`, `parseAdsResponse`,
 * `onAdsCommandReceived`, `setupPlcConnection`, `onConnectionLost`, `readRawMulti`.
 */

'use strict';

const ADS = require('ads-client/dist/ads-commons.js');
const ClientError = require('ads-client/dist/client-error.js').default;
const { startAdsHelper, HelperError } = require('./adsHelperProcess');

/** A read whose length ads-client leaves open (0xFFFFFFFF: symbol and data type info) gets this buffer. */
const UNKNOWN_READ_LENGTH = 4 * 1024 * 1024;
/** Poll tick of the emulated notifications. */
const POLL_TICK_MS = 100;
/** Poll period for a notification with cycle time 0. */
const ZERO_CYCLE_MS = 500;
/** ADS 0x701: service not supported. */
const ADSERR_SERVICE_NOT_SUPPORTED = 0x701;
/** ADS 0x714: invalid notification handle. */
const ADSERR_INVALID_NOTIFICATION_HANDLE = 0x714;

/**
 * A little-endian buffer writer for the ADS response bytes.
 * @param {Array<[string, number]|Buffer>} parts
 * @returns {Buffer}
 */
function bytes(parts) {
    return Buffer.concat(parts.map(p => {
        if (Buffer.isBuffer(p)) return p;
        const [kind, v] = p;
        const size = kind === 'u8' ? 1 : kind === 'u16' ? 2 : 4;
        const b = Buffer.alloc(size);
        if (kind === 'u8') b.writeUInt8(v & 0xFF);
        else if (kind === 'u16') b.writeUInt16LE(v & 0xFFFF);
        else b.writeUInt32LE(v >>> 0);
        return b;
    }));
}

/**
 * An ADS error answer in the shape a PLC sends it: the result code, then the command's fixed fields
 * zeroed (a Read or ReadWrite answer always carries its length field; ads-client's parser reads it).
 * @param {number} cmd
 * @param {number} code
 * @returns {Buffer}
 */
function errorResponse(cmd, code) {
    const C = ADS.ADS_COMMAND;
    const tail = cmd === C.Read || cmd === C.ReadWrite || cmd === C.ReadState || cmd === C.AddNotification ? 4
        : cmd === C.ReadDeviceInfo ? 20 : 0;
    return Buffer.concat([bytes([['u32', code]]), Buffer.alloc(tail)]);
}

/**
 * The ADS loopback NetId ads-client uses for `localhost`.
 * @param {string|undefined} netId
 * @returns {string}
 */
function normalizeNetId(netId) {
    return !netId || String(netId).toLowerCase() === 'localhost' ? ADS.LOOPBACK_AMS_NET_ID : String(netId);
}

/**
 * Makes the helper-backed Client class.
 * @param {any} Base ads-client's `Client` (injectable for a contract test).
 * @param {Object} [deps]
 * @param {(o: Object) => Promise<import('./adsHelperProcess').AdsHelper>} [deps.startHelper]
 * @param {(line: string) => void} [deps.log] The helper's stderr lines.
 * @returns {any} A class whose instances are ads-client Clients talking through the helper.
 */
function createHelperClientClass(Base, deps = {}) {
    const start = deps.startHelper || startAdsHelper;
    const log = deps.log || (() => {});

    class HelperClient extends Base {
        /** @param {Object} settings ads-client settings (router mode). */
        constructor(settings) {
            super(settings);
            /** @type {import('./adsHelperProcess').AdsHelper|null} */
            this.helper = null;
            /** @type {Map<number, any>} Emulated notifications by handle. */
            this.polls = new Map();
            this.nextHandle = 1;
            /** @type {any} */
            this.pollTimer = null;
            this.polling = false;
            /** The ready line of the last helper started (dll, version, bitness), for the log. */
            this.helperInfo = null;
        }

        /**
         * Starts a helper and opens the target through it; then ads-client's own PLC setup runs.
         * @param {boolean} [isReconnecting]
         * @returns {Promise<any>} ads-client's connection object.
         */
        async connectToTarget(isReconnecting = false) {
            if (this.socket) {
                throw new ClientError('connectToTarget(): Connection is already opened. Close the connection first by calling disconnect()');
            }
            this.settings.targetAmsNetId = normalizeNetId(this.settings.targetAmsNetId);
            let helper;
            try {
                helper = await start({ adsTimeoutMs: this.settings.timeoutDelay, log });
            } catch (e) {
                const err = new ClientError(`connectToTarget(): Starting the ADS helper failed: ${/** @type {any} */ (e).message}`);
                /** @type {any} */ (err).helper = e;
                throw err;
            }
            this.helper = helper;
            this.helperInfo = helper.info;
            // ads-client checks and clears `socket`; this stand-in lets its disconnect and reconnect logic run.
            this.socket = {
                off() {}, once() {}, on() {}, removeAllListeners() {},
                end: (/** @type {Function} */ cb) => { if (cb) cb(); },
                destroy: () => { this.stopHelper(helper); }
            };
            try {
                const opened = await helper.request('open', { netId: this.settings.targetAmsNetId, port: this.settings.targetAdsPort });
                this.connection = {
                    connected: true,
                    isLocal: this.settings.targetAmsNetId === ADS.LOOPBACK_AMS_NET_ID || this.settings.targetAmsNetId === opened.localNetId,
                    localAmsNetId: String(opened.localNetId),
                    localAdsPort: Number(opened.localPort),
                    targetAmsNetId: this.settings.targetAmsNetId,
                    targetAdsPort: this.settings.targetAdsPort
                };
                this.metaData.adsSymbolsUseUtf8 = this.settings.forceUtf8ForAdsSymbols;
                if (this.settings.rawClient !== true) {
                    try {
                        await this.setupPlcConnection();
                    } catch (err) {
                        throw new ClientError(`connectToTarget(): Connection failed - failed to set PLC connection. Error: ${/** @type {any} */ (err).message}`, err);
                    }
                }
            } catch (e) {
                this.clearTimer(this.tcSystemStatePollerTimer);
                this.stopPolls();
                this.socket = undefined;
                this.connection = { connected: false };
                this.stopHelper(helper);
                if (e instanceof HelperError) {
                    const err = new ClientError(`connectToTarget(): Opening ${this.settings.targetAmsNetId}:${this.settings.targetAdsPort} through the ADS helper failed: ${e.message}`,
                        e.adsError ? { errorCode: e.adsError, errorStr: ADS.ADS_ERROR[e.adsError] } : undefined);
                    /** @type {any} */ (err).helper = e;
                    throw err;
                }
                throw e;
            }
            // A helper that exits while connected is a lost connection; ads-client reconnects (a new helper).
            helper.onExit(() => {
                if (this.helper === helper && this.connection.connected) this.onConnectionLost(true);
            });
            this.emit('connect', this.connection);
            return this.connection;
        }

        /** No port was registered at a router: the helper's close is the whole teardown. */
        async unregisterAdsPort() {
            if (this.helper) this.stopHelper(this.helper);
        }

        /**
         * @param {boolean} [force]
         * @param {boolean} [isReconnecting]
         */
        async disconnectFromTarget(force = false, isReconnecting = false) {
            const helper = this.helper;
            try {
                return await super.disconnectFromTarget(force, isReconnecting);
            } finally {
                this.stopPolls();
                if (helper) this.stopHelper(helper);
            }
        }

        /**
         * Closes a helper (once) and forgets it if it is the current one.
         * @param {import('./adsHelperProcess').AdsHelper} helper
         */
        stopHelper(helper) {
            if (this.helper === helper) {
                this.helper = null;
                this.stopPolls();
            }
            helper.close().catch(() => {});
        }

        /**
         * ads-client's single exit for ADS requests, answered through the helper.
         * @param {{adsCommand: number, payload?: Buffer, targetAmsNetId?: string, targetAdsPort?: number}} command
         * @returns {Promise<any>} The response packet ads-client's callers read (`ads`, `ams`).
         */
        async sendAdsCommand(command) {
            const netId = normalizeNetId(command.targetAmsNetId ?? this.settings.targetAmsNetId);
            const port = command.targetAdsPort ?? this.settings.targetAdsPort;
            const name = ADS.ADS_COMMAND.toString(command.adsCommand);
            const helper = this.helper;
            if (!helper) {
                throw new ClientError('sendAdsCommand(): Error - Socket is not available (failed to send data)');
            }
            /** @type {Buffer} */
            let data;
            try {
                data = await this.exchange(helper, command.adsCommand, command.payload || Buffer.alloc(0), netId, port);
            } catch (e) {
                const he = /** @type {any} */ (e);
                if (he instanceof HelperError && he.kind === 'ads' && he.adsError) {
                    data = errorResponse(command.adsCommand, he.adsError);
                } else if (he instanceof HelperError && he.kind === 'timeout') {
                    throw new ClientError(`sendAdsCommand(): Timeout for command ${name} - ${he.message}`,
                        { errorCode: -1, errorStr: he.message });
                } else {
                    throw new ClientError(`sendAdsCommand(): Error - ${he && he.message}`);
                }
            }
            const packet = {
                amsTcp: { command: ADS.AMS_HEADER_FLAG.AMS_TCP_PORT_AMS_CMD },
                ams: {
                    targetAmsAddress: { amsNetId: this.connection.localAmsNetId, adsPort: this.connection.localAdsPort },
                    sourceAmsAddress: { amsNetId: netId, adsPort: port },
                    adsCommand: command.adsCommand,
                    adsCommandStr: name,
                    errorCode: 0,
                    error: false,
                    invokeId: this.nextInvokeId++
                },
                ads: /** @type {any} */ ({})
            };
            packet.ads = this.parseAdsResponse(packet, data);
            if (packet.ads.error) {
                throw new ClientError(`sendAdsCommand(): Response with ADS error received (error ${packet.ads.errorCode} - ${packet.ads.errorStr})`, packet.ads);
            }
            return packet;
        }

        /**
         * One ADS command through the helper, answered as the ADS response bytes (error code first).
         * @param {import('./adsHelperProcess').AdsHelper} helper
         * @param {number} cmd
         * @param {Buffer} p The request payload.
         * @param {string} netId
         * @param {number} port
         * @returns {Promise<Buffer>}
         */
        async exchange(helper, cmd, p, netId, port) {
            const at = { netId, port };
            const len = (/** @type {number} */ n) => (n === 0xFFFFFFFF ? UNKNOWN_READ_LENGTH : n);
            const C = ADS.ADS_COMMAND;
            switch (cmd) {
                case C.Read: {
                    const r = await helper.request('read', { ...at, ig: p.readUInt32LE(0), io: p.readUInt32LE(4), len: len(p.readUInt32LE(8)) });
                    const d = Buffer.from(String(r.data || ''), 'base64');
                    return bytes([['u32', 0], ['u32', d.length], d]);
                }
                case C.Write: {
                    const n = p.readUInt32LE(8);
                    await helper.request('write', { ...at, ig: p.readUInt32LE(0), io: p.readUInt32LE(4), data: p.subarray(12, 12 + n).toString('base64') });
                    return bytes([['u32', 0]]);
                }
                case C.ReadWrite: {
                    const wn = p.readUInt32LE(12);
                    const r = await helper.request('readwrite', { ...at, ig: p.readUInt32LE(0), io: p.readUInt32LE(4), len: len(p.readUInt32LE(8)),
                        data: p.subarray(16, 16 + wn).toString('base64') });
                    const d = Buffer.from(String(r.data || ''), 'base64');
                    return bytes([['u32', 0], ['u32', d.length], d]);
                }
                case C.ReadState: {
                    const r = await helper.request('state', at);
                    return bytes([['u32', 0], ['u16', Number(r.adsState)], ['u16', Number(r.deviceState)]]);
                }
                case C.ReadDeviceInfo: {
                    const r = await helper.request('deviceinfo', at);
                    const nameBuf = Buffer.alloc(16);
                    Buffer.from(String(r.name || ''), 'latin1').copy(nameBuf, 0, 0, 15);
                    return bytes([['u32', 0], ['u8', Number(r.major)], ['u8', Number(r.minor)], ['u16', Number(r.build)], nameBuf]);
                }
                case C.AddNotification:
                    return this.addPoll(helper, p, netId, port);
                case C.DeleteNotification: {
                    const h = p.readUInt32LE(0);
                    if (!this.polls.delete(h)) return errorResponse(cmd, ADSERR_INVALID_NOTIFICATION_HANDLE);
                    if (!this.polls.size) this.stopPolls();
                    return bytes([['u32', 0]]);
                }
                default:
                    // WriteControl and anything else: never sent by the online code.
                    return errorResponse(cmd, ADSERR_SERVICE_NOT_SUPPORTED);
            }
        }

        /**
         * Emulates an AddNotification: reads once (its error is the AddNotification's), registers the poll
         * and delivers the first value as the first notification.
         * @param {import('./adsHelperProcess').AdsHelper} helper
         * @param {Buffer} p
         * @param {string} netId
         * @param {number} port
         * @returns {Promise<Buffer>}
         */
        async addPoll(helper, p, netId, port) {
            const ig = p.readUInt32LE(0);
            const io = p.readUInt32LE(4);
            const size = p.readUInt32LE(8);
            const onChange = p.readUInt32LE(12) === ADS.ADS_TRANS_MODE.OnChange;
            const cycleMs = Math.round(p.readUInt32LE(20) / 10000);
            if (size === 0xFFFFFFFF || size > UNKNOWN_READ_LENGTH) return errorResponse(ADS.ADS_COMMAND.AddNotification, 0x705); // invalid size
            let first;
            try {
                const r = await helper.request('read', { netId, port, ig, io, len: size });
                first = Buffer.from(String(r.data || ''), 'base64');
            } catch (e) {
                const he = /** @type {any} */ (e);
                if (he instanceof HelperError && he.kind === 'ads' && he.adsError) return errorResponse(ADS.ADS_COMMAND.AddNotification, he.adsError);
                throw e;
            }
            const handle = this.nextHandle++;
            const poll = { handle, netId, port, ig, io, size, onChange, periodMs: Math.max(POLL_TICK_MS, cycleMs || ZERO_CYCLE_MS),
                due: Date.now(), last: /** @type {Buffer|null} */ (null) };
            this.polls.set(handle, poll);
            // As a PLC does: the current value arrives as the first notification, after the AddNotification answer.
            setImmediate(() => { if (this.polls.get(handle) === poll) this.deliver(poll, first); });
            this.startPolls();
            return bytes([['u32', 0], ['u32', handle]]);
        }

        /**
         * Hands one value to ads-client's notification dispatcher (unless on-change and unchanged).
         * @param {any} poll
         * @param {Buffer} value
         */
        deliver(poll, value) {
            if (poll.onChange && poll.last && poll.last.equals(value)) return;
            poll.last = Buffer.from(value);
            this.onAdsCommandReceived({
                amsTcp: { command: ADS.AMS_HEADER_FLAG.AMS_TCP_PORT_AMS_CMD },
                ams: { adsCommand: ADS.ADS_COMMAND.Notification, sourceAmsAddress: { amsNetId: poll.netId, adsPort: poll.port }, invokeId: 0 },
                ads: { payload: { stamps: [{ timestamp: new Date(), samples: [{ notificationHandle: poll.handle, payload: value }] }] } }
            });
        }

        startPolls() {
            if (this.pollTimer) return;
            this.pollTimer = setInterval(() => { this.pollOnce().catch(() => {}); }, POLL_TICK_MS);
            if (this.pollTimer.unref) this.pollTimer.unref();
        }

        stopPolls() {
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.pollTimer = null;
            this.polls.clear();
        }

        /** One tick: every due poll, one sum read per target. A failed read is skipped, not reported. */
        async pollOnce() {
            if (this.polling || !this.helper || !this.connection.connected) return;
            this.polling = true;
            try {
                const now = Date.now();
                /** @type {Map<string, any[]>} */
                const byTarget = new Map();
                for (const poll of this.polls.values()) {
                    if (poll.due > now) continue;
                    poll.due = now + poll.periodMs;
                    const key = `${poll.netId}:${poll.port}`;
                    if (!byTarget.has(key)) byTarget.set(key, []);
                    /** @type {any[]} */ (byTarget.get(key)).push(poll);
                }
                for (const polls of byTarget.values()) {
                    const res = await this.readRawMulti(polls.map(p => ({ indexGroup: p.ig, indexOffset: p.io, size: p.size })),
                        { amsNetId: polls[0].netId, adsPort: polls[0].port }).catch(() => null);
                    if (!res) continue;
                    res.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
                        if (r.success && this.polls.get(polls[i].handle) === polls[i]) this.deliver(polls[i], Buffer.from(r.value));
                    });
                }
            } finally {
                this.polling = false;
            }
        }
    }
    return HelperClient;
}

module.exports = { createHelperClientClass, normalizeNetId, UNKNOWN_READ_LENGTH, POLL_TICK_MS, ZERO_CYCLE_MS };
