/**
 * @file writeGuard.js
 * @description Online monitoring (R15): the only path to an ADS write. User decisions D2 and D5
 * (2026-11-13): a write sets a value ONCE (the program may overwrite it; nothing here is a force), it
 * is OFF by default, and every write
 *   1. needs `tcToolkit.online.allowWrites` on, AND writes enabled for the current online session
 *      (asked once per session, modal; going offline turns them off again);
 *   2. is refused while the code check (src/online/codeIdentity.js: project name, variable layout
 *      against the last build's .tmc, source edits since that build) does not pass, or cannot be
 *      run, or the symbol's online type differs from its declaration;
 *   3. is refused while an editor has unsaved edits (the code on screen may not be the code running);
 *   4. is confirmed by a MODAL dialog naming the target, the path, the old and new values and the PLC
 *      state — and the guards are checked AGAIN after the dialog, since the state can change while it
 *      is open;
 *   5. is logged (attempt, outcome) to the "TC Toolkit Online" output channel.
 * vscode-free: the dialogs and the channel are injected, so test/test_ads_write.js drives this exact
 * code with a fake session.
 */

'use strict';

const { parseInput, editText, isScalar, typesMatch, formatValue } = require('./values');
const { REASON_TEXT } = require('./editorPaths');

/** The confirm button of the write modal. Never "Force": a write is not a force (D2). */
const WRITE_BUTTON = 'Write';
/** The confirm button of the per-session enable modal. */
const ENABLE_BUTTON = 'Enable writes';

/**
 * @typedef {Object} WriteRequest
 * @property {string|null} path The ADS path, or null when the variable has none.
 * @property {string|null} [reason] Why `path` is null (onlinePaths reasons).
 * @property {string|null} [localType] The declared type, when known.
 * @property {'editor'|'watch'} source
 */

/**
 * @typedef {Object} WriteDeps
 * @property {ReturnType<typeof import('./session').createOnlineSession>} session
 * @property {() => boolean} allowWrites `tcToolkit.online.allowWrites`.
 * @property {{enabled: boolean}} sessionWrites Per online session; the command layer resets it on Go Offline.
 * @property {() => 'match'|'differs'|'unknown'} projectState The code check (src/online/codeIdentity.js).
 * @property {() => string} [projectReason] Its one-sentence explanation, used in a refusal.
 * @property {() => boolean} hasUnsavedEdits
 * @property {(o: {prompt: string, value: string, validate: (s: string) => string|null}) => Promise<string|undefined>} input
 * @property {(o: {message: string, detail: string, button: string}) => Promise<boolean>} confirm
 * @property {(line: string) => void} log
 */

/**
 * The reason a write may not happen now, or null. Checked before the dialogs and again after them.
 * @param {WriteDeps} d
 * @returns {string|null}
 */
function blockedReason(d) {
    if (d.session.state !== 'online') return 'Not online. Use "Go Online" first.';
    if (!d.allowWrites()) return 'Writing values is off. Turn on the setting tcToolkit.online.allowWrites to allow it.';
    const project = d.projectState();
    const why = d.projectReason ? d.projectReason() : '';
    if (project === 'differs') return `${why || 'The PLC runs a different project than this workspace.'} Writes are blocked while the code differs.`;
    if (project === 'unknown') return `${why || 'The PLC\'s project could not be checked against this workspace.'} Writes are blocked until it can be.`;
    if (d.hasUnsavedEdits()) return 'An editor has unsaved edits: the code on screen may not be the code running. Save first.';
    if (d.session.info.lost) return 'The connection is being re-established.';
    return null;
}

/**
 * The text of the confirmation modal.
 * @param {{target: string, path: string, oldText: string, newText: string, plcState: string|null, forces: {plc: boolean, io: boolean}|null}} o
 * @returns {{message: string, detail: string, button: string}}
 */
function confirmationText(o) {
    const forces = o.forces && (o.forces.plc || o.forces.io)
        ? '\nForces are active on this target (set from XAE); a forced variable keeps its forced value.' : '';
    return {
        message: `Write ${o.newText} to ${o.path} on ${o.target}?`,
        detail: `Current value: ${o.oldText}\nNew value: ${o.newText}\nPLC state: ${o.plcState || 'unknown'}\n\n` +
            'This sets the value once; the PLC program may overwrite it in its next cycle. It is not a force.' + forces,
        button: WRITE_BUTTON
    };
}

/**
 * Runs one write from request to log line.
 * @param {WriteRequest} req
 * @param {WriteDeps} d
 * @returns {Promise<{status: 'written'|'refused'|'cancelled'|'failed', message: string}>}
 */
async function performWrite(req, d) {
    const target = d.session.target ? d.session.target.label : 'the target';
    const refuse = (/** @type {string} */ message) => {
        d.log(`Write refused${req.path ? ` (${req.path})` : ''}: ${message}`);
        return { status: /** @type {'refused'} */ ('refused'), message };
    };
    if (!req.path) return refuse(REASON_TEXT[/** @type {keyof typeof REASON_TEXT} */ (req.reason || 'unsupported')] || REASON_TEXT.unsupported);
    let blocked = blockedReason(d);
    if (blocked && blocked.startsWith('Writing values is off')) return refuse(blocked);
    if (d.session.state === 'online' && !d.sessionWrites.enabled && !blocked) {
        const ok = await d.confirm({
            message: `Enable writes to ${target} for this online session?`,
            detail: 'Each write still asks for confirmation. Writes turn off again when you go offline.',
            button: ENABLE_BUTTON
        });
        if (!ok) { d.log('Writes for this session: not enabled.'); return { status: 'cancelled', message: 'Writes were not enabled.' }; }
        d.sessionWrites.enabled = true;
        d.log(`Writes enabled for this online session (${target}).`);
    }
    blocked = blockedReason(d);
    if (blocked) return refuse(blocked);

    const resolved = await d.session.resolve(req.path);
    if (!resolved.ok) return refuse(`The PLC has no symbol ${req.path}.`);
    if (!resolved.scalar || !isScalar(resolved.dataType)) return refuse('Only single values can be written, not structures, FB instances or arrays.');
    if (typesMatch(req.localType || null, /** @type {any} */ (resolved.symbol).type) === false) {
        return refuse(`${req.path} is ${/** @type {any} */ (resolved.symbol).type} on the PLC but ${req.localType} in the project.`);
    }
    const current = await d.session.readMany([resolved]);
    const cur = current.get(resolved.path);
    const oldText = cur && cur.ok ? formatValue(cur.value, resolved.dataType) : 'unreadable';
    const typed = await d.input({
        prompt: `New value for ${req.path} (${/** @type {any} */ (resolved.symbol).type})`,
        value: cur && cur.ok ? editText(cur.value, resolved.dataType) : '',
        validate: (s) => { const p = /** @type {any} */ (parseInput(s, resolved.dataType)); return p.ok ? null : p.error; }
    });
    if (typed === undefined) return { status: 'cancelled', message: 'Write cancelled.' };
    const parsed = /** @type {any} */ (parseInput(typed, resolved.dataType));
    if (!parsed.ok) return refuse(parsed.error);
    const text = confirmationText({ target, path: req.path, oldText, newText: parsed.text,
        plcState: d.session.info.plcState, forces: d.session.info.forces });
    d.log(`Write requested: ${req.path} = ${parsed.text} on ${target} (current ${oldText}, from the ${req.source}).`);
    const confirmed = await d.confirm(text);
    if (!confirmed) { d.log(`Write cancelled: ${req.path}.`); return { status: 'cancelled', message: 'Write cancelled.' }; }
    blocked = blockedReason(d);
    if (blocked) return refuse(blocked);
    try {
        await d.session.write(resolved.path, parsed.value);
    } catch (e) {
        const msg = e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : String(e);
        d.log(`Write FAILED: ${req.path} = ${parsed.text} on ${target}: ${msg}`);
        return { status: 'failed', message: `Writing ${req.path} failed: ${msg}` };
    }
    d.log(`Written: ${req.path} = ${parsed.text} on ${target} (was ${oldText}).`);
    return { status: 'written', message: `Wrote ${parsed.text} to ${req.path}.` };
}

module.exports = { performWrite, blockedReason, confirmationText, WRITE_BUTTON, ENABLE_BUTTON };
