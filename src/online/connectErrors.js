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
 * The workaround text below states only what docs/r15-ads-decision.md section 6 records, with its
 * uncertainty: the kernel-mode switch is from the library's README, not confirmed by Beckhoff.
 */

'use strict';

/** The user-mode runtime explanation, shared by the cases where it is the likely cause. */
const USER_MODE_HINT = 'If this PC runs the TwinCAT 3.1.4026 user-mode runtime (the default on Windows 11 with ' +
    'Hyper-V or virtualization-based security on), the ADS library used here is reported not to reach its ' +
    'router. Workarounds: run the PLC in a kernel-mode runtime (the library documents ' +
    '"tcpkg config set -n xarMode -v KM", with Hyper-V and Memory Integrity off; not confirmed by Beckhoff), ' +
    'or monitor a PLC on another machine. See README, "Online monitoring".';

/** What to do about a missing route, which only XAE can set up (D7). */
const ROUTE_HINT = 'Add a route to the target in XAE (SYSTEM > Routes > Add Route, or Search (Ethernet)), ' +
    'then Go Online again. This extension never creates routes.';

/**
 * @typedef {Object} ConnectFailure
 * @property {'no-router'|'router-rejected'|'port-registration'|'no-route'|'no-plc'|'timeout'|'config'|'cancelled'|'other'} kind
 * @property {string} message One sentence for the notification.
 * @property {string} [hint] What to do, when there is something to do.
 * @property {string} raw The library's own text, for the output channel.
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
 * Whether a router address is this PC (the default when unset).
 * @param {string|undefined} address
 * @returns {boolean}
 */
function isLoopback(address) {
    const a = String(address || '127.0.0.1').trim().toLowerCase();
    return a === 'localhost' || a === '::1' || /^127\./.test(a);
}

module.exports = { describeConnectError, rawText, USER_MODE_HINT, ROUTE_HINT };
