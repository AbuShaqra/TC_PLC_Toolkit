/**
 * @file connectErrors.js
 * @description Online monitoring (R15): a failed Go Online, told the user in words that say what to do.
 * ads-client reports failures as `ClientError`s whose message trace names the step that failed and
 * whose `adsError.errorCode` is the ADS return code. This maps the cases a user meets — no router, a
 * router that refuses our port (what the TwinCAT 3.1.4026 user-mode runtime is reported to do), no
 * route, no PLC on the port — to a message, and keeps the raw text for the output channel.
 *
 * User decision D4 (2026-11-13): if the user-mode runtime cannot be reached through the local router,
 * say so clearly with the documented workarounds; never block, never fall back to direct mode.
 * R15 phase 2 (user decision 2026-11-16): on Windows a refused TCP connection to the local router
 * switches to TwinCAT's own ADS DLL through a PowerShell helper (src/online/adsClient.js). When that
 * fails too, the error carries `fallback` (and `helper`, the helper's own failure) and the message
 * names both: the router refused the TCP connection, and what the fallback ran into.
 * A reset (ECONNRESET) is told apart from a refusal (ECONNREFUSED): a reset means a router DID answer
 * at 48898 and dropped the connection, which "No ADS router answered" used to misstate.
 * The workaround text below states only what docs/r15-ads-decision.md section 6 records, with its
 * uncertainty: the kernel-mode switch is from the library's README, not confirmed by Beckhoff.
 */

'use strict';

/** The user-mode runtime explanation, shared by the cases where it is the likely cause. */
const USER_MODE_HINT = 'If this PC runs the TwinCAT 3.1.4026 user-mode runtime (the default on Windows 11 with ' +
    'Hyper-V or virtualization-based security on), its router refuses the TCP connection the ADS library used here ' +
    'opens; on Windows TC Toolkit then switches to TwinCAT\'s own ADS DLL by itself. Other workarounds: run the PLC ' +
    'in a kernel-mode runtime (the library documents ' +
    '"tcpkg config set -n xarMode -v KM", with Hyper-V and Memory Integrity off; not confirmed by Beckhoff), ' +
    'or monitor a PLC on another machine. See README, "Online monitoring".';

/** What to do about a missing route, which only XAE can set up (D7). */
const ROUTE_HINT = 'Add a route to the target in XAE (SYSTEM > Routes > Add Route, or Search (Ethernet)), ' +
    'then Go Online again. This extension never creates routes.';

/** With the user-mode runtime the PLC is not at the router's own AMS Net ID (measured 2026-11-16). */
const RUNTIME_NETID_HINT = 'With the user-mode runtime the PLC runs under the runtime\'s own AMS Net ID, not the router\'s: ' +
    'use Go Online… > Enter AMS Net ID… with the Net ID printed in the runtime\'s console window ("AmsNetId: …"), ' +
    'for example 10.0.0.4.1.1:851.';

/** What the fallback is, for the messages that report it failing. */
const DLL = 'TwinCAT\'s ADS DLL';

/** ECONNRESET as Node reports it on Windows, Linux and macOS. */
const RESET = /socket error (?:-4077|-104|-54)\b|ECONNRESET/i;

/**
 * @typedef {Object} ConnectFailure
 * @property {'no-router'|'router-reset'|'router-rejected'|'port-registration'|'no-route'|'no-plc'|'timeout'|'config'|'cancelled'|'helper-unavailable'|'other'} kind
 * @property {string} message One sentence for the notification.
 * @property {string} [hint] What to do, when there is something to do.
 * @property {string} raw The library's own text, for the output channel.
 * @property {boolean} [fallback] The user-mode fallback (TwinCAT's ADS DLL) ran and failed too.
 */

/**
 * The ADS return code carried by an error, or -1.
 * @param {any} err
 * @returns {number}
 */
function adsCode(err) {
    const c = err && err.adsError && err.adsError.errorCode;
    return typeof c === 'number' ? c : -1;
}

/**
 * The full text of an error and its causes (ads-client keeps them in `trace`).
 * @param {any} err
 * @returns {string}
 */
function rawText(err) {
    if (!err) return 'Unknown error';
    const trace = Array.isArray(err.trace) && err.trace.length ? err.trace.join(' <- ') : '';
    return trace || String(err.message || err);
}

/**
 * Classifies a Go Online failure.
 * @param {any} err What `connect()` threw.
 * @param {{mode: 'router'|'direct', routerAddress?: string, targetAmsNetId: string, targetAdsPort: number}} o
 * @returns {ConnectFailure}
 */
function describeConnectError(err, o) {
    const raw = rawText(err);
    const where = `${o.targetAmsNetId}:${o.targetAdsPort}`;
    const router = `${o.routerAddress || '127.0.0.1'}:48898`;
    const code = adsCode(err);
    if (err && err.cancelled) return { kind: 'cancelled', message: 'Go Online was cancelled.', raw };
    if (err && err.configError) return { kind: 'config', message: String(err.message), raw };
    if (err && err.fallback) return describeFallbackError(err, o, raw);
    if (o.mode !== 'direct' && isLoopback(o.routerAddress) && /Connecting to/.test(raw) && RESET.test(raw)) {
        return { kind: 'router-reset', message: `The ADS router at ${router} answered but reset this client's TCP connection.`,
            hint: USER_MODE_HINT, raw };
    }
    if (/ECONNREFUSED|socket error -?\d+|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(raw) && /Connecting to/.test(raw)) {
        if (o.mode === 'direct') {
            return { kind: 'no-router', message: `The PLC at ${router} did not accept an ADS connection.`,
                hint: 'Check tcToolkit.online.direct.plcAddress and that TCP port 48898 is open on the PLC. ' + ROUTE_HINT, raw };
        }
        return { kind: 'no-router', message: `No ADS router answered at ${router}.`,
            hint: 'Online monitoring goes through the TwinCAT router on this PC: install and start TwinCAT (XAE or XAR). ' + USER_MODE_HINT, raw };
    }
    if (/Registering ADS port failed|registerAdsPort/i.test(raw)) {
        return { kind: 'port-registration', message: `The ADS router at ${router} did not register a port for this client.`,
            hint: USER_MODE_HINT, raw };
    }
    // Any other failure of the connect step to the LOCAL router (it closed or ended the socket, or did
    // not answer): section 6 of docs/r15-ads-decision.md does not record which of these the 4026
    // user-mode runtime produces, so every one of them carries the user-mode explanation.
    if (o.mode !== 'direct' && isLoopback(o.routerAddress) && /Connecting to .* failed/i.test(raw)) {
        return { kind: 'router-rejected', message: `The ADS router at ${router} closed the connection or did not answer.`,
            hint: 'Online monitoring goes through the TwinCAT router on this PC: check that TwinCAT (XAE or XAR) is running. ' + USER_MODE_HINT, raw };
    }
    if (code === 7 || /target machine not found/i.test(raw)) {
        return { kind: 'no-route', message: `The router has no route to ${o.targetAmsNetId}.`, hint: ROUTE_HINT, raw };
    }
    if (code === 6 || /target port not found/i.test(raw)) {
        return { kind: 'no-plc', message: `No PLC runtime answers on ADS port ${o.targetAdsPort} at ${o.targetAmsNetId}.`,
            hint: 'Check the port (851 is the first PLC runtime, 852 the second) and that the configuration is activated.', raw };
    }
    if (code === 1861 || /timeout/i.test(raw)) {
        return { kind: 'timeout', message: `${where} did not answer in time.`,
            hint: (o.mode === 'router' ? 'Check that the target is running and that the route exists on BOTH sides. ' : '') + ROUTE_HINT, raw };
    }
    if (/failed to set PLC connection/i.test(raw)) {
        return { kind: 'no-plc', message: `Connected to ${o.targetAmsNetId}, but no PLC program answers on port ${o.targetAdsPort}.`,
            hint: 'The target may be in CONFIG mode or have no PLC program downloaded.', raw };
    }
    return { kind: 'other', message: `Go Online to ${where} failed.`, raw };
}

/**
 * A Go Online whose user-mode fallback failed too: the router refused the TCP connection, and then
 * TwinCAT's ADS DLL (through the PowerShell helper) could not start or could not reach the PLC.
 * @param {any} err The fallback's error; `err.helper` is the helper's own failure when it has one.
 * @param {{mode: 'router'|'direct', routerAddress?: string, targetAmsNetId: string, targetAdsPort: number}} o
 * @param {string} raw
 * @returns {ConnectFailure}
 */
function describeFallbackError(err, o, raw) {
    const router = `${o.routerAddress || '127.0.0.1'}:48898`;
    const refused = `The ADS router at ${router} refused this client's TCP connection`;
    const fullRaw = `${raw} (after the router refused TCP: ${err.fallback.routerError})`;
    const helper = err.helper || {};
    const local = isLoopbackTarget(o.targetAmsNetId);
    const where = local ? `the local runtime (port ${o.targetAdsPort})` : `${o.targetAmsNetId}:${o.targetAdsPort}`;
    const done = (/** @type {Partial<ConnectFailure>} */ f) => /** @type {ConnectFailure} */ ({ kind: 'other', ...f, raw: fullRaw, fallback: true });
    switch (helper.kind) {
        case 'dll-not-found':
            return done({ kind: 'helper-unavailable', message: `${refused}, and the fallback through ${DLL} could not start: TwinCAT.Ads.dll was not found.`,
                hint: 'It is installed with TwinCAT 3.1 (XAE or XAR) under TwinCAT\\3.1\\Components\\Base. ' + USER_MODE_HINT });
        case 'dll-load':
            return done({ kind: 'helper-unavailable', message: `${refused}, and the fallback could not load ${DLL}: ${helper.message}`, hint: USER_MODE_HINT });
        case 'spawn-failed':
        case 'not-windows':
            return done({ kind: 'helper-unavailable', message: `${refused}, and the fallback through ${DLL} could not start: ${helper.message}`, hint: USER_MODE_HINT });
        case 'start-timeout':
        case 'exited':
        case 'failed':
            return done({ kind: 'helper-unavailable', message: `${refused}, and the fallback through ${DLL} failed: ${helper.message}`,
                hint: 'The TC Toolkit Online log has the helper\'s output. ' + USER_MODE_HINT });
        default:
            break;
    }
    const code = typeof helper.adsError === 'number' ? helper.adsError : adsCode(err);
    const via = `The local router refused a TCP connection, so TC Toolkit used ${DLL}`;
    if (code === 7 || /target machine not found/i.test(raw)) {
        return done({ kind: 'no-route', message: local
            ? `${via}, but the router does not know the local runtime (ADS error 0x7).`
            : `${via}, but the router does not know ${o.targetAmsNetId} (ADS error 0x7): the runtime is not running, or there is no route to it.`,
        hint: local ? RUNTIME_NETID_HINT : 'Check that the runtime is started (its console window is open). ' + ROUTE_HINT });
    }
    if (code === 6 || /target port not found/i.test(raw)) {
        return done({ kind: 'no-plc', message: local
            ? `${via}, but no PLC answers on port ${o.targetAdsPort} of the router's own AMS Net ID (ADS error 0x6).`
            : `${via}, but no PLC runtime answers on ADS port ${o.targetAdsPort} at ${o.targetAmsNetId} (ADS error 0x6).`,
        hint: local ? RUNTIME_NETID_HINT : 'Check the port (851 is the first PLC runtime, 852 the second) and that the configuration is activated.' });
    }
    if (helper.kind === 'timeout' || code === 1861 || code === -1 && /timeout/i.test(raw)) {
        return done({ kind: 'timeout', message: `${via}, but ${where} did not answer in time.`,
            hint: local ? RUNTIME_NETID_HINT : 'Check that the target is running. ' + ROUTE_HINT });
    }
    if (/failed to set PLC connection/i.test(raw)) {
        return done({ kind: 'no-plc', message: `${via} and connected to ${where}, but no PLC program answers there.`,
            hint: 'The target may be in CONFIG mode or have no PLC program downloaded.' + (local ? ' ' + RUNTIME_NETID_HINT : '') });
    }
    return done({ message: `${via}, but Go Online to ${where} failed${code > 0 ? ` (ADS error 0x${code.toString(16)})` : ''}.`,
        hint: local ? RUNTIME_NETID_HINT : undefined });
}

/**
 * Whether a target NetId means the local router itself.
 * @param {string} netId
 * @returns {boolean}
 */
function isLoopbackTarget(netId) {
    const n = String(netId || '').toLowerCase();
    return n === 'localhost' || n === '127.0.0.1.1.1';
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

module.exports = { describeConnectError, rawText, isLoopback, USER_MODE_HINT, ROUTE_HINT, RUNTIME_NETID_HINT };
