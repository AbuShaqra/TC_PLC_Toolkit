/**
 * @file plcControl.js
 * @description Online monitoring (R15): Start / Stop PLC (user request 2026-11-16) — ADS WriteControl
 * Run (5) / Stop (6) on the PLC's port, through ads-client's `startPlc` / `stopPlc` (which keep the
 * device state the PLC reports). The rules:
 *   1. only while online, and only the action that fits the PLC state the session reads: Start while
 *      the PLC is in Stop, Stop while it is in Run. Any other state (not read yet, Config, Error,
 *      Exception, Invalid, a connection being re-established) offers neither;
 *   2. confirmed EVERY time by a modal naming the target (label and AMS address), with one confirm
 *      button. Not gated by `tcToolkit.online.allowWrites`: that setting is about variable values;
 *   3. bound to the connection the user was asked about: the identity and the PLC state are checked
 *      again after the modal, and `session.controlPlc` refuses another connection itself;
 *   4. logged to the "TC Toolkit Online" channel (the log line carries the time): target, action and
 *      outcome — refused, cancelled, done (with the state read right after) or failed (the ADS error);
 *   5. one request at a time (`busy`): a second click while one runs is refused.
 * vscode-free: the dialog and the channel are injected, so test/test_ads_plc_control.js drives this
 * exact code with the in-memory PLC.
 */

'use strict';

const { targetName } = require('./writeGuard');
const { sameIdentity } = require('./session');

/** The ADS state names the session reports for the two states a toggle is offered in. */
const RUN_STATE = 'Run';
const STOP_STATE = 'Stop';

/**
 * @typedef {Object} PlcControlDeps
 * @property {ReturnType<typeof import('./session').createOnlineSession>} session
 * @property {(o: {message: string, detail: string, button: string}) => Promise<boolean>} confirm A modal.
 * @property {(line: string) => void} log
 * @property {{busy: boolean}} [guard] Shared by every caller: true while a start or stop runs.
 */

/**
 * @typedef {Object} PlcControlResult
 * @property {'done'|'refused'|'cancelled'|'failed'} status
 * @property {string} message What the user is told (a refusal or the failure; empty when cancelled).
 * @property {string|null} [state] The PLC state read right after a start or stop.
 */

/**
 * Which action the toggle offers for a PLC state: 'start' in Stop, 'stop' in Run, null otherwise.
 * @param {string|null|undefined} plcState As the session reports it ('Run', 'Stop', 'Config', …).
 * @returns {'start'|'stop'|null}
 */
function actionFor(plcState) {
    const s = String(plcState || '').toLowerCase();
    if (s === RUN_STATE.toLowerCase()) return 'stop';
    if (s === STOP_STATE.toLowerCase()) return 'start';
    return null;
}

/**
 * What the toggle shows: the action it offers (null: disabled) and why it is disabled.
 * @param {{state: string, info: {plcState: string|null, lost: boolean}}} session
 * @param {boolean} [busy]
 * @returns {{online: boolean, action: 'start'|'stop'|null, plcState: string|null, busy: boolean, reason: string}}
 */
function toggleState(session, busy = false) {
    const online = session.state === 'online';
    const plcState = online ? session.info.plcState : null;
    const lost = online && !!session.info.lost;
    const action = online && !lost && !busy ? actionFor(plcState) : null;
    let reason = '';
    if (!online) reason = 'Not online.';
    else if (busy) reason = 'A start or stop of the PLC is in progress.';
    else if (lost) reason = 'The connection is being re-established.';
    else if (!plcState) reason = 'The PLC state has not been read yet.';
    else if (!action) reason = `The PLC is in ${plcState}: Start and Stop are offered in Stop and Run only.`;
    return { online, action, plcState, busy: !!busy, reason };
}

/**
 * The text of a failed start or stop: the ADS error code and its text when the library reports one.
 * @param {any} err
 * @returns {string}
 */
function failureText(err) {
    const ads = err && err.adsError;
    if (ads && typeof ads.errorCode === 'number' && ads.errorCode > 0) {
        return `ADS error 0x${ads.errorCode.toString(16)}${ads.errorStr ? ` (${ads.errorStr})` : ''}`;
    }
    return String((err && err.message) || err || 'unknown error');
}

/**
 * Starts or stops the PLC, after the modal. Never throws.
 * @param {'start'|'stop'} action
 * @param {PlcControlDeps} deps
 * @returns {Promise<PlcControlResult>}
 */
async function performPlcControl(action, deps) {
    const { session, log } = deps;
    const guard = deps.guard || { busy: false };
    const verb = action === 'start' ? 'Start' : 'Stop';
    const id = session.identity;
    const target = targetName(id);
    const refuse = (/** @type {string} */ message) => {
        log(`PLC ${action} on ${target} refused: ${message}`);
        return /** @type {PlcControlResult} */ ({ status: 'refused', message });
    };
    if (action !== 'start' && action !== 'stop') return refuse(`Unknown action "${action}".`);
    if (session.state !== 'online' || !id) return refuse('Not online. Use "Go Online" first.');
    if (guard.busy) return refuse('A start or stop of the PLC is already in progress.');
    const before = toggleState(session);
    if (before.action !== action) {
        return refuse(before.reason || `The PLC is in ${before.plcState}: there is nothing to ${action === 'start' ? 'start' : 'stop'}.`);
    }
    guard.busy = true;
    try {
        const ok = await deps.confirm({
            message: `${verb} the PLC on ${target}?`,
            detail: action === 'start'
                ? 'The PLC program starts running (ADS state Run).'
                : 'The PLC program stops running (ADS state Stop); its outputs are no longer written by the program.',
            button: `${verb} PLC`
        });
        if (!ok) {
            log(`PLC ${action} on ${target}: cancelled.`);
            return { status: 'cancelled', message: '' };
        }
        // The modal was open for a while: the same connection, and still the state the user saw.
        if (session.state !== 'online' || !sameIdentity(id, session.identity)) {
            return refuse('The connection changed while the dialog was open; nothing was sent.');
        }
        const now = toggleState(session);
        if (now.action !== action) {
            return refuse(`The PLC state changed to ${now.plcState || 'unknown'} while the dialog was open; nothing was sent.`);
        }
        log(`PLC ${action} on ${target}: sending (PLC state ${now.plcState}).`);
        let state;
        try {
            state = await session.controlPlc(action, /** @type {any} */ (id));
        } catch (e) {
            const text = failureText(e);
            log(`PLC ${action} on ${target} FAILED: ${text}`);
            return { status: 'failed', message: `${action === 'start' ? 'Starting' : 'Stopping'} the PLC failed: ${text}` };
        }
        log(`PLC ${action} on ${target}: done (PLC state now ${state || 'not read'}).`);
        return { status: 'done', message: `PLC ${action === 'start' ? 'started' : 'stopped'} on ${target}.`, state };
    } finally {
        guard.busy = false;
    }
}

module.exports = { performPlcControl, toggleState, actionFor, failureText };
