/**
 * @file tsprojTarget.js
 * @description Reads and changes the target a TwinCAT solution names: the `TargetNetId="…"`
 * attribute of its system project (`.tsproj` / `.tspproj`), the attribute XAE's *Choose Target
 * System* writes. Used when an activation is refused because that target is not a runtime on this
 * PC (the driver's gate 3), so the user can point the solution at one that is (user decision,
 * 2026-11-16). vscode-free; `fs` is injected.
 *
 * Rules:
 *   - **Exactly one occurrence, or nothing is changed.** The file is searched case-insensitively for
 *     `TargetNetId` in any form; anything but one `TargetNetId="…"` attribute (none, several, an
 *     element) is refused with a reason, never guessed at.
 *   - **Only that attribute's value changes.** The file is handled as bytes (latin1 maps every byte
 *     to one char and back), so the BOM, the encoding, the line endings and every other byte are
 *     written back unchanged. A UTF-16 file (BOM FF FE / FE FF) is refused: its ASCII is not
 *     contiguous bytes.
 *   - **The value must still be the refused one**: a file changed since the run is not rewritten.
 *   - **The new value is a well-formed AmsNetId**; that it is a runtime of this PC is the caller's
 *     rule (it offers only the driver's local list), and the driver checks it again on the re-run.
 *   - **Only a system project inside the solution's folder** is written: the path comes from the
 *     driver's output, so it is checked before anything is read.
 *
 * test/test_tsproj_target.js covers it.
 */

'use strict';

const path = require('path');
const { isValidNetId } = require('./xaeBuild');

/** Every occurrence of the name, in any form and case: the count that must be exactly one. */
const ANY_RE = /TargetNetId/gi;
/** The attribute form, as the driver reads it (Select-String is case-insensitive). */
const ATTR_RE = /TargetNetId="([^"]*)"/gi;

/**
 * @typedef {Object} TargetRead
 * @property {boolean} ok Exactly one `TargetNetId="…"` attribute and no other occurrence.
 * @property {'encoding'|'none'|'several'|'not-attribute'} [reason] Why not, when not ok.
 * @property {number} count Occurrences of `TargetNetId` in any form.
 * @property {string} [value] The attribute's value, when ok.
 * @property {number} [start] Offset of the value in the file (bytes = latin1 chars), when ok.
 */

/**
 * Finds the one `TargetNetId="…"` attribute of a system project.
 * @param {Buffer} buf The file's bytes.
 * @returns {TargetRead}
 */
function findTargetNetId(buf) {
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
        return { ok: false, reason: 'encoding', count: 0 };
    }
    const text = buf.toString('latin1');
    const count = (text.match(ANY_RE) || []).length;
    if (count === 0) return { ok: false, reason: 'none', count };
    if (count > 1) return { ok: false, reason: 'several', count };
    ATTR_RE.lastIndex = 0;
    const m = ATTR_RE.exec(text);
    if (!m) return { ok: false, reason: 'not-attribute', count };
    return { ok: true, count, value: m[1], start: m.index + m[0].indexOf('"') + 1 };
}

/**
 * The file with its one TargetNetId changed from `from` to `to`, every other byte unchanged.
 * @param {Buffer} buf
 * @param {string} from The value the refusal named; the file must still hold it.
 * @param {string} to A well-formed AmsNetId.
 * @returns {{ok: true, buffer: Buffer} | {ok: false, reason: string, count?: number, found?: string}}
 */
function rewriteTargetNetId(buf, from, to) {
    if (!isValidNetId(to)) return { ok: false, reason: 'invalid' };
    const r = findTargetNetId(buf);
    if (!r.ok) return { ok: false, reason: String(r.reason), count: r.count };
    if (r.value !== from) return { ok: false, reason: 'changed', found: r.value };
    const start = /** @type {number} */ (r.start);
    const buffer = Buffer.concat([buf.subarray(0, start), Buffer.from(to, 'latin1'), buf.subarray(start + from.length)]);
    return { ok: true, buffer };
}

/**
 * Whether `file` is a system project inside the solution's folder.
 * @param {string} file
 * @param {string} slnPath
 * @returns {boolean}
 */
function insideSolution(file, slnPath) {
    if (typeof file !== 'string' || !file || !/\.tsp?proj$/i.test(file)) return false;
    const rel = path.relative(path.dirname(slnPath), file);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Why a system project's target cannot be changed here, as a sentence part ('' for an unknown reason).
 * @param {{reason: string, count?: number, found?: string, message?: string}} r
 * @param {string} file
 * @param {string} from
 * @returns {string}
 */
function problemText(r, file, from) {
    const name = path.basename(String(file || '')) || 'the system project';
    switch (r.reason) {
        case 'outside': return `the system project the build named (${file || 'none'}) is not a .tsproj or .tspproj inside the solution's folder`;
        case 'unreadable': return `${name} could not be read${r.message ? ` (${r.message})` : ''}`;
        case 'encoding': return `${name} is stored as UTF-16, which TC Toolkit does not rewrite`;
        case 'none': return `${name} has no TargetNetId`;
        case 'several': return `${name} names TargetNetId ${r.count} times, and TC Toolkit does not guess which one counts`;
        case 'not-attribute': return `${name} names TargetNetId, but not as the TargetNetId="…" attribute XAE writes`;
        case 'changed': return `${name} now names TargetNetId ${r.found}, not ${from}: it changed after the build started`;
        case 'invalid': return 'the chosen runtime has no well-formed AmsNetId';
        case 'unwritable': return `${name} could not be written${r.message ? ` (${r.message})` : ''}`;
        default: return '';
    }
}

/**
 * Checks, without writing, that the solution's target can be changed here: the file is the
 * solution's system project and holds exactly one TargetNetId, still `from`.
 * @param {{slnPath: string, tsprojPath: string|null, from: string, fs: {readFileSync: Function}}} o
 * @returns {{ok: boolean, text: string}} `text` says why not ('' when ok).
 */
function checkSolutionTarget(o) {
    if (!o.tsprojPath || !insideSolution(o.tsprojPath, o.slnPath)) return { ok: false, text: problemText({ reason: 'outside' }, o.tsprojPath || '', o.from) };
    /** @type {Buffer} */
    let buf;
    try { buf = o.fs.readFileSync(o.tsprojPath); } catch (err) {
        return { ok: false, text: problemText({ reason: 'unreadable', message: err && /** @type {any} */ (err).code }, o.tsprojPath, o.from) };
    }
    const r = findTargetNetId(buf);
    if (!r.ok) return { ok: false, text: problemText({ reason: String(r.reason), count: r.count }, o.tsprojPath, o.from) };
    if (r.value !== o.from) return { ok: false, text: problemText({ reason: 'changed', found: r.value }, o.tsprojPath, o.from) };
    return { ok: true, text: '' };
}

/**
 * Changes the solution's target: reads the system project afresh, rewrites its one TargetNetId
 * from `from` to `to` and writes it back. Nothing is written unless every check passes.
 * @param {{slnPath: string, tsprojPath: string|null, from: string, to: string, fs: {readFileSync: Function, writeFileSync: Function}}} o
 * @returns {{ok: boolean, text: string}} `text` says why not ('' when ok).
 */
function changeSolutionTarget(o) {
    if (!o.tsprojPath || !insideSolution(o.tsprojPath, o.slnPath)) return { ok: false, text: problemText({ reason: 'outside' }, o.tsprojPath || '', o.from) };
    /** @type {Buffer} */
    let buf;
    try { buf = o.fs.readFileSync(o.tsprojPath); } catch (err) {
        return { ok: false, text: problemText({ reason: 'unreadable', message: err && /** @type {any} */ (err).code }, o.tsprojPath, o.from) };
    }
    const r = rewriteTargetNetId(buf, o.from, o.to);
    if (!r.ok) return { ok: false, text: problemText(/** @type {any} */ (r), o.tsprojPath, o.from) };
    try { o.fs.writeFileSync(o.tsprojPath, r.buffer); } catch (err) {
        return { ok: false, text: problemText({ reason: 'unwritable', message: err && /** @type {any} */ (err).code }, o.tsprojPath, o.from) };
    }
    return { ok: true, text: '' };
}

module.exports = { findTargetNetId, rewriteTargetNetId, insideSolution, checkSolutionTarget, changeSolutionTarget };
