/**
 * @file gppCommands.js
 * @description The VS Code half of the g++ path setting (`tcToolkit.compiler.gppPath`, roadmap R13):
 * `twincat.detectGpp` fills an EMPTY setting with the g++ found on this machine and never overwrites
 * a value the user has set — like the XAE Shell paths (src/commands/xaeShellCommands.js). The same
 * silent fill runs when the g++ build is turned on, so the setting shows what a run will use; it
 * leaves out a g++ older than 7, which only the explicit command writes.
 *
 * Detection itself is src/gpp.js (pure, unit-tested); here it only gets its real dependencies.
 */

'use strict';

const path = require('path');
const vscode = require('vscode');
const { SETTING_GPP_PATH, detectGpp, checkConfiguredGpp, describeGppProblem, normalizeGppSetting, thisMachine, isGppTooOld, gppTooOldText, gppInstallHint } = require('../gpp');
const { CPP_SECTION } = require('../cppSettings');

/** The key of the path setting inside its section. */
const GPP_PATH_KEY = 'gppPath';

/**
 * @typedef {Object} GppFillResult
 * @property {'found'|'kept'|'notFound'|'tooOldNotFilled'} status `found`: the empty setting was filled;
 *   `kept`: it already had a value and was left alone; `notFound`: empty, and nothing was detected;
 *   `tooOldNotFilled`: the silent fill found only a g++ older than 7 and left the setting empty, so
 *   a newer g++ installed later is detected without the user clearing anything.
 * @property {string} path The setting's value after the fill ('' when not found).
 * @property {boolean} [missing] For `kept`: the kept value does not work on this machine.
 * @property {string} [problem] For a `missing` value: why (src/gpp.js checkConfiguredGpp).
 * @property {string} [version] The g++ version, when it was read.
 * @property {boolean} [tooOld] That g++ is older than 7: the build will not run it.
 * @property {{path: string, version?: string}} [newer] For a kept value that is too old: a g++ 7+
 *   detection finds, which the user can switch to by clearing the setting or setting that path.
 */

/** The real platform, environment and file checks (src/gpp.js thisMachine). */
const machine = thisMachine;

/**
 * Detection with the real platform, environment and file system (a g++ 7+ preferred).
 * @returns {{path: string, source: string, version?: string, tooOld?: boolean}|null}
 */
function detectOnThisMachine() {
    return detectGpp(machine());
}

/**
 * Detects g++ and writes it into the setting, only when the setting is empty.
 * @param {() => ({path: string, version?: string, tooOld?: boolean}|null)} detect
 * @param {Parameters<typeof checkConfiguredGpp>[1]} [env] How a set value is checked (the build's own
 *   check, so both say the same about it); the real machine by default.
 * @param {{fillTooOld?: boolean}} [o] `fillTooOld: false` (the silent fill): a g++ older than 7 is not
 *   written, because a written value is never replaced by a later detection.
 * @returns {Promise<GppFillResult>}
 */
async function fillGppSetting(detect, env = machine(), o = {}) {
    const config = vscode.workspace.getConfiguration(CPP_SECTION);
    const current = config.get(GPP_PATH_KEY);
    // The build's own emptiness rule (quotes and blanks only count as unset), so the start page's
    // g++ row, the build and this fill agree on whether the setting is set.
    const value = normalizeGppSetting(current);
    if (value) {
        const checked = checkConfiguredGpp(value, env);
        if (checked.ok !== true) return { status: 'kept', path: value, missing: true, problem: checked.reason };
        /** @type {GppFillResult} */
        const kept = { status: 'kept', path: value, missing: false, ...versionOf(checked.path, env) };
        if (kept.tooOld) {
            const other = detect();
            if (other && other.path && !other.tooOld && !samePath(other.path, checked.path)) {
                kept.newer = other.version ? { path: other.path, version: other.version } : { path: other.path };
            }
        }
        return kept;
    }
    const hit = detect();
    if (!hit || !hit.path) return { status: 'notFound', path: '' };
    if (hit.tooOld && o.fillTooOld === false) {
        /** @type {GppFillResult} */
        const left = { status: 'tooOldNotFilled', path: '', tooOld: true };
        if (hit.version) left.version = hit.version;
        return left;
    }
    await config.update(GPP_PATH_KEY, hit.path, vscode.ConfigurationTarget.Global);
    /** @type {GppFillResult} */
    const found = { status: 'found', path: hit.path };
    if (hit.version) found.version = hit.version;
    if (hit.tooOld) found.tooOld = true;
    return found;
}

/**
 * Whether two paths name the same file (case-blind on Windows).
 * @param {string} a
 * @param {string} b
 */
function samePath(a, b) {
    const p = process.platform === 'win32' ? path.win32 : path;
    const n = (/** @type {string} */ x) => { const r = p.resolve(x); return process.platform === 'win32' ? r.toLowerCase() : r; };
    return n(a) === n(b);
}

/**
 * The version fields of a fill result for a kept value: none when the version cannot be read.
 * @param {string} gppPath
 * @param {Parameters<typeof checkConfiguredGpp>[1] & {version?: (p: string) => ({version: string, major: number}|null)}} env
 * @returns {{version?: string, tooOld?: boolean}}
 */
function versionOf(gppPath, env) {
    let v;
    try { v = env && typeof env.version === 'function' ? env.version(gppPath) : null; } catch (e) { v = null; }
    if (!v) return {};
    return isGppTooOld(v) ? { version: v.version, tooOld: true } : { version: v.version };
}

/**
 * The one-line summary `twincat.detectGpp` shows.
 * @param {GppFillResult} r
 * @returns {string}
 */
function describeGppFill(r) {
    // Both `found` and `kept` leave the old g++ in the setting, where detection never replaces it.
    const fix = r.newer
        ? `A newer g++${r.newer.version ? ' ' + r.newer.version : ''} is at ${r.newer.path}: clear the g++ path setting, or set it to that path.`
        : gppInstallHint(process.platform, { fromSetting: true });
    const old = r.tooOld ? ` But ${gppTooOldText(r.version || '?')} ${fix}` : '';
    if (r.status === 'found') return `g++ found: ${r.path}${old ? '.' + old : ''}`;
    if (r.status === 'tooOldNotFilled') return `${gppTooOldText(r.version || '?')} ${gppInstallHint()}`;
    if (r.status === 'kept') {
        if (old) return `g++: kept your value ${r.path}.${old}`;
        return r.missing
            ? `g++: kept your value ${r.path} (${describeGppProblem(r.problem || 'missing')}). Clear the setting to let it be detected, or correct it.`
            : `g++: kept your value ${r.path}.`;
    }
    return 'g++ was not found on PATH or in the usual install folders. Install it (for example MSYS2 or WinLibs) or set its path.';
}

/**
 * Registers `twincat.detectGpp`.
 * @param {vscode.ExtensionContext} context
 * @param {{detect?: () => ({path: string, version?: string, tooOld?: boolean}|null), machine?: Parameters<typeof checkConfiguredGpp>[1]}} [deps] For the tests.
 * @returns {{autoFill: () => Promise<GppFillResult|null>}} The silent fill; it never rejects.
 */
function registerGppCommands(context, { detect = detectOnThisMachine, machine: env = machine() } = {}) {
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.detectGpp', async () => {
            /** @type {GppFillResult} */
            let result;
            try {
                result = await fillGppSetting(detect, env);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not update the g++ path setting: ${err && err.message ? err.message : err}`);
                return undefined;
            }
            const show = result.status === 'notFound' || result.tooOld ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
            Promise.resolve(show(describeGppFill(result), 'Open Setting')).then((choice) => {
                if (choice === 'Open Setting') return vscode.commands.executeCommand('twincat.openSettings', SETTING_GPP_PATH, { target: 'user' });
                return undefined;
            }).then(undefined, () => undefined);
            return result;
        })
    );
    return {
        autoFill: () => fillGppSetting(detect, env, { fillTooOld: false }).catch((err) => {
            console.error('TC Toolkit: could not fill the g++ path setting:', err);
            return null;
        })
    };
}

module.exports = { registerGppCommands, fillGppSetting, describeGppFill, GPP_PATH_KEY };
