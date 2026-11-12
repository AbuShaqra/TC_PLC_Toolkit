/**
 * @file gppCommands.js
 * @description The VS Code half of the g++ path setting (`tcToolkit.compiler.gppPath`, roadmap R13):
 * `twincat.detectGpp` fills an EMPTY setting with the g++ found on this machine and never overwrites
 * a value the user has set — like the XAE Shell paths (src/commands/xaeShellCommands.js). The same
 * silent fill runs when the g++ build is turned on, so the setting shows what a run will use.
 *
 * Detection itself is src/gpp.js (pure, unit-tested); here it only gets its real dependencies.
 */

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const { SETTING_GPP_PATH, detectGpp } = require('../gpp');
const { CPP_SECTION } = require('../cppSettings');

/** The key of the path setting inside its section. */
const GPP_PATH_KEY = 'gppPath';

/**
 * @typedef {Object} GppFillResult
 * @property {'found'|'kept'|'notFound'} status `found`: the empty setting was filled; `kept`: it
 *   already had a value and was left alone; `notFound`: empty, and nothing was detected.
 * @property {string} path The setting's value after the fill ('' when not found).
 * @property {boolean} [missing] For `kept`: the kept path is not a file on this machine.
 */

/**
 * Detection with the real platform, environment and file system.
 * @returns {{path: string, source: string}|null}
 */
function detectOnThisMachine() {
    return detectGpp({ platform: process.platform, env: process.env, exists: (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } } });
}

/**
 * Detects g++ and writes it into the setting, only when the setting is empty.
 * @param {() => ({path: string}|null)} detect
 * @returns {Promise<GppFillResult>}
 */
async function fillGppSetting(detect) {
    const config = vscode.workspace.getConfiguration(CPP_SECTION);
    const current = config.get(GPP_PATH_KEY);
    const value = typeof current === 'string' ? current.trim() : '';
    if (value) {
        // A bare command name (`g++`) is looked up on PATH at run time, so it is not "missing".
        const missing = /[\\/]/.test(value) && !fs.existsSync(value);
        return { status: 'kept', path: value, missing };
    }
    const hit = detect();
    if (!hit || !hit.path) return { status: 'notFound', path: '' };
    await config.update(GPP_PATH_KEY, hit.path, vscode.ConfigurationTarget.Global);
    return { status: 'found', path: hit.path };
}

/**
 * The one-line summary `twincat.detectGpp` shows.
 * @param {GppFillResult} r
 * @returns {string}
 */
function describeGppFill(r) {
    if (r.status === 'found') return `g++ found: ${r.path}`;
    if (r.status === 'kept') return `g++: kept your value ${r.path}${r.missing ? ' (that file does not exist)' : ''}.`;
    return 'g++ was not found on PATH or in the usual install folders. Install it (for example MSYS2 or WinLibs) or set its path.';
}

/**
 * Registers `twincat.detectGpp`.
 * @param {vscode.ExtensionContext} context
 * @param {{detect?: () => ({path: string}|null)}} [deps]
 * @returns {{autoFill: () => Promise<GppFillResult|null>}} The silent fill; it never rejects.
 */
function registerGppCommands(context, { detect = detectOnThisMachine } = {}) {
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.detectGpp', async () => {
            /** @type {GppFillResult} */
            let result;
            try {
                result = await fillGppSetting(detect);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not update the g++ path setting: ${err && err.message ? err.message : err}`);
                return undefined;
            }
            const show = result.status === 'notFound' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
            Promise.resolve(show(describeGppFill(result), 'Open Setting')).then((choice) => {
                if (choice === 'Open Setting') return vscode.commands.executeCommand('twincat.openSettings', SETTING_GPP_PATH);
                return undefined;
            }).then(undefined, () => undefined);
            return result;
        })
    );
    return {
        autoFill: () => fillGppSetting(detect).catch((err) => {
            console.error('TC Toolkit: could not fill the g++ path setting:', err);
            return null;
        })
    };
}

module.exports = { registerGppCommands, fillGppSetting, describeGppFill, GPP_PATH_KEY };
