/**
 * @file adsHelperProcess.js
 * @description Online monitoring (R15 phase 2): the PowerShell ADS helper process and its JSON-lines
 * protocol. The helper (resources/online/ads-helper.ps1) loads Beckhoff's installed TwinCAT.Ads.dll
 * and answers raw ADS requests, for a PC whose local router refuses ads-client's TCP connection (the
 * TwinCAT 3.1.4026 user-mode runtime does). Nothing here knows about symbols or values: that stays in
 * ads-client, driven through src/online/helperClient.js.
 *
 * Protocol, one JSON object per line, UTF-8, no BOM:
 *   helper → host, once at start:  {"id":0,"event":"ready","ok":true,"dll":…,"dllVersion":…,"bitness":64,"common":…}
 *                                  or {"id":0,"event":"ready","ok":false,"kind":"dll-not-found"|"dll-load","error":…,"searched":[…],
 *                                      "dllName":"TwinCAT.Ads.dll"|"TcAdsDll.dll","configured":bool}
 *   host → helper:                 {"id":N,"cmd":"open"|"read"|"write"|"readwrite"|"state"|"deviceinfo"|"writecontrol"|"close", …}
 *   helper → host:                 {"id":N,"ok":true,…result} or {"id":N,"ok":false,"error":"…","adsError":7}
 * Commands carry `netId` and `port` (the helper keeps one TcAdsClient per address); `ig`/`io` are the
 * index group/offset, `len` the read length, `data` base64; `writecontrol` carries `adsState` and
 * `deviceState` (Start PLC: 5 Run, Stop PLC: 6 Stop) and `data` (empty). Results: `open` → localNetId, localPort;
 * `read`/`readwrite` → data; `state` → adsState, deviceState; `deviceinfo` → name, major, minor, build.
 *
 * One request is in flight at a time (the helper is single-threaded anyway); the queue keeps a slow ADS
 * call from making the ones behind it time out. Hang guard: a request unanswered for `requestTimeoutMs`
 * (the ADS timeout plus slack) kills the helper — a helper that stopped answering cannot be trusted with
 * the next request — and every queued request fails. There is no restart here: the owner (ads-client's
 * auto-reconnect, through helperClient.js) starts a new helper when it reconnects. The helper exits on
 * its own when its stdin closes, so `close()` ends stdin first and kills only if it is still alive
 * after `killAfterMs`.
 */

'use strict';

const path = require('path');

/** The helper script, shipped with the extension. */
const HELPER_SCRIPT = path.join(__dirname, '..', '..', 'resources', 'online', 'ads-helper.ps1');

/**
 * A helper failure. `kind` says what failed: `not-windows`, `spawn-failed`, `dll-not-found`,
 * `dll-load`, `start-timeout`, `exited`, `timeout`, `ads` (the request reached ADS, which answered
 * `adsError`), `failed` (the helper reported another error), `closed`.
 */
class HelperError extends Error {
    /**
     * @param {string} kind
     * @param {string} message
     * @param {{adsError?: number, detail?: any}} [extra]
     */
    constructor(kind, message, extra = {}) {
        super(message);
        this.name = 'HelperError';
        this.kind = kind;
        /** @type {number|undefined} */
        this.adsError = extra.adsError;
        this.detail = extra.detail;
    }
}

/**
 * The command line of the helper: as src/xaeShell.js starts PowerShell, minus `-STA` (no COM here).
 * The configured DLL locations (src/adsDllSettings.js) are passed only when set; empty = the helper searches.
 * @param {string} scriptPath
 * @param {number} adsTimeoutMs
 * @param {{dotNetLibrary?: string, nativeDllFolder?: string}} [dlls]
 * @returns {string[]}
 */
function helperArgs(scriptPath, adsTimeoutMs, dlls = {}) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TimeoutMs', String(adsTimeoutMs)];
    if (dlls.dotNetLibrary) args.push('-AdsDll', dlls.dotNetLibrary);
    if (dlls.nativeDllFolder) args.push('-AdsNativeDir', dlls.nativeDllFolder);
    return args;
}

/**
 * @typedef {Object} AdsHelper
 * @property {Object} info The `ready` line (dll, dllVersion, bitness, common).
 * @property {(cmd: string, args?: Object) => Promise<any>} request
 * @property {() => Promise<void>} close Ends stdin; kills the helper if it does not exit.
 * @property {(fn: (reason: string) => void) => void} onExit Called once when the helper exits or is killed.
 * @property {() => boolean} alive
 */

/**
 * Starts the helper and resolves once it reported `ready`.
 * @param {Object} [o]
 * @param {Function} [o.spawn] child_process.spawn (injectable for the harnesses).
 * @param {string} [o.platform] process.platform.
 * @param {string} [o.scriptPath]
 * @param {number} [o.adsTimeoutMs] The helper's TcAdsClient timeout (ads-client's timeoutDelay).
 * @param {{dotNetLibrary?: string, nativeDllFolder?: string}} [o.dlls] The tcToolkit.adsDll.* settings.
 * @param {number} [o.requestTimeoutMs] Hang guard per request; default ADS timeout + 3 s.
 * @param {number} [o.startTimeoutMs] PowerShell start plus the DLL load; default 20 s.
 * @param {number} [o.killAfterMs] How long `close()` waits for a clean exit; default 2 s.
 * @param {(line: string) => void} [o.log] Gets the helper's stderr lines.
 * @returns {Promise<AdsHelper>}
 */
function startAdsHelper(o = {}) {
    const platform = o.platform || process.platform;
    if (platform !== 'win32') {
        return Promise.reject(new HelperError('not-windows', 'The TwinCAT ADS DLL fallback runs only on Windows.'));
    }
    const spawn = o.spawn || require('child_process').spawn;
    const adsTimeoutMs = o.adsTimeoutMs || 2000;
    const requestTimeoutMs = o.requestTimeoutMs || adsTimeoutMs + 3000;
    const startTimeoutMs = o.startTimeoutMs || 20000;
    const killAfterMs = o.killAfterMs === undefined ? 2000 : o.killAfterMs;
    const log = o.log || (() => {});

    return new Promise((resolveStart, rejectStart) => {
        /** @type {any} */
        let proc;
        try {
            proc = spawn('powershell.exe', helperArgs(o.scriptPath || HELPER_SCRIPT, adsTimeoutMs, o.dlls), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            rejectStart(new HelperError('spawn-failed', `powershell.exe could not be started: ${/** @type {any} */ (e).message}`));
            return;
        }
        let started = false;
        let exited = false;
        let nextId = 1;
        /** @type {Array<{id: number, line: string, resolve: Function, reject: Function}>} */
        const queue = [];
        /** @type {{id: number, resolve: Function, reject: Function, timer: any}|null} */
        let current = null;
        /** @type {Array<(reason: string) => void>} */
        const exitFns = [];
        let stdout = '';
        let stderr = '';
        /** @type {string[]} */
        const stderrTail = [];

        const startTimer = setTimeout(() => {
            if (started) return;
            kill();
            finish('start-timeout');
            rejectStart(new HelperError('start-timeout', `The ADS helper did not start within ${Math.round(startTimeoutMs / 1000)} s.`));
        }, startTimeoutMs);

        function kill() {
            try { proc.kill(); } catch (e) { /* already gone */ }
        }

        /** @param {string} reason */
        function finish(reason) {
            if (exited) return;
            exited = true;
            clearTimeout(startTimer);
            const err = new HelperError(reason === 'timeout' ? 'timeout' : 'exited',
                reason === 'timeout' ? 'The ADS helper stopped answering.' : `The ADS helper exited (${reason}).`);
            if (current) { clearTimeout(current.timer); current.reject(err); current = null; }
            for (const q of queue.splice(0)) q.reject(err);
            for (const fn of exitFns.splice(0)) { try { fn(reason); } catch (e) { /* the owner's problem */ } }
        }

        function pump() {
            if (current || exited || !queue.length) return;
            const q = /** @type {any} */ (queue.shift());
            current = { id: q.id, resolve: q.resolve, reject: q.reject, timer: null };
            current.timer = setTimeout(() => {
                const cur = current;
                current = null;
                if (cur) cur.reject(new HelperError('timeout', `The ADS helper did not answer within ${Math.round(requestTimeoutMs / 1000)} s.`));
                kill();
                finish('timeout');
            }, requestTimeoutMs);
            try { proc.stdin.write(q.line + '\n'); } catch (e) {
                kill();
                finish('stdin closed');
            }
        }

        /** @param {any} msg */
        function onMessage(msg) {
            if (!started) {
                if (msg.event !== 'ready') return;
                started = true;
                clearTimeout(startTimer);
                if (!msg.ok) {
                    const kind = msg.kind === 'dll-not-found' || msg.kind === 'dll-load' ? msg.kind : 'failed';
                    rejectStart(new HelperError(kind, String(msg.error || 'The ADS helper could not start.'), { detail: msg }));
                    kill();
                    finish('not ready');
                    return;
                }
                helper.info = msg;
                resolveStart(helper);
                return;
            }
            if (!current || msg.id !== current.id) return; // a late answer to a request that timed out
            const cur = current;
            current = null;
            clearTimeout(cur.timer);
            if (msg.ok) cur.resolve(msg);
            else if (typeof msg.adsError === 'number' && msg.adsError > 0) {
                cur.reject(new HelperError('ads', String(msg.error || `ADS error ${msg.adsError}`), { adsError: msg.adsError }));
            } else cur.reject(new HelperError('failed', String(msg.error || 'The ADS helper reported an error.')));
            pump();
        }

        proc.stdout.on('data', (/** @type {Buffer} */ chunk) => {
            stdout += chunk.toString('utf8');
            const lines = stdout.split(/\r?\n/);
            stdout = /** @type {string} */ (lines.pop());
            for (const line of lines) {
                const t = line.replace(/^\uFEFF/, '').trim();
                if (!t) continue;
                let msg;
                try { msg = JSON.parse(t); } catch (e) { log(`ADS helper: ${t}`); continue; }
                onMessage(msg);
            }
        });
        proc.stderr.on('data', (/** @type {Buffer} */ chunk) => {
            stderr += chunk.toString('utf8');
            const lines = stderr.split(/\r?\n/);
            stderr = /** @type {string} */ (lines.pop());
            for (const line of lines) {
                if (!line.trim()) continue;
                stderrTail.push(line.trim());
                if (stderrTail.length > 5) stderrTail.shift();
                log(`ADS helper: ${line.trim()}`);
            }
        });
        if (proc.stdin && proc.stdin.on) proc.stdin.on('error', () => { /* the exit handler reports it */ });
        proc.on('error', (/** @type {any} */ e) => {
            if (!started) {
                started = true;
                rejectStart(new HelperError('spawn-failed', `powershell.exe could not be started: ${e && e.message}`));
            }
            finish('spawn error');
        });
        proc.on('exit', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
            const reason = signal ? `signal ${signal}` : `exit code ${code}`;
            if (!started) {
                started = true;
                rejectStart(new HelperError('exited', `The ADS helper exited before it was ready (${reason})${stderrTail.length ? ': ' + stderrTail.join(' ') : ''}.`));
            }
            finish(reason);
        });

        /** @type {AdsHelper} */
        const helper = {
            info: {},
            request(cmd, args = {}) {
                if (exited) return Promise.reject(new HelperError('closed', 'The ADS helper is not running.'));
                const id = nextId++;
                return new Promise((resolve, reject) => {
                    queue.push({ id, line: JSON.stringify({ ...args, id, cmd }), resolve, reject });
                    pump();
                });
            },
            async close() {
                if (exited) return;
                await new Promise((resolve) => {
                    exitFns.push(() => resolve(undefined));
                    try { proc.stdin.end(); } catch (e) { /* already closed */ }
                    setTimeout(() => { if (!exited) { kill(); finish('killed'); } }, killAfterMs);
                });
            },
            onExit(fn) { if (exited) fn('exited'); else exitFns.push(fn); },
            alive() { return !exited; }
        };
    });
}

module.exports = { startAdsHelper, helperArgs, HelperError, HELPER_SCRIPT };
