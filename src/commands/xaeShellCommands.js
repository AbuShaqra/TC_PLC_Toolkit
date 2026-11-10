/**
 * @file xaeShellCommands.js
 * @description The VS Code half of the XAE Shell path settings (`twincat.xaeShell.path4024` /
 * `twincat.xaeShell.path4026`): fills an EMPTY setting with the installation found on this machine —
 * once in the background after activation, and again on `twincat.detectXaeShell` — and never
 * overwrites a value the user has set.
 *
 * Detection itself is src/xaeShellDetect.js (pure, unit-tested); here it only gets its real
 * dependencies. This module launches nothing: the paths are read by Update Library Definitions
 * (src/xaeShell.js) and are otherwise stored for the planned create-through-XAE phase.
 */

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const { execFile } = require('child_process');
const { XAE_SHELL_SECTION, XAE_SHELL_VERSIONS, detectXaeShells, createRegQuery } = require('../xaeShellDetect');

/**
 * @typedef {Object} XaeShellFillResult
 * @property {string} id Version id ('4024' | '4026').
 * @property {string} version '3.1.4024' | '3.1.4026'.
 * @property {'found'|'kept'|'notFound'} status `found`: the empty setting was filled; `kept`: the
 *   setting already had a value and was left alone; `notFound`: empty, and nothing was detected.
 * @property {string} path The setting's value after the fill ('' when not found).
 * @property {boolean} [missing] For `kept`: the kept path is not a file on this machine.
 */

/**
 * Detection with the real platform, environment, file system and registry.
 * @returns {ReturnType<typeof detectXaeShells>}
 */
function detectOnThisMachine() {
    return detectXaeShells({
        platform: process.platform,
        env: process.env,
        exists: (p) => fs.existsSync(p),
        regQuery: createRegQuery(/** @type {any} */ (execFile))
    });
}

/**
 * Detects the shells and writes each found path into its setting — only where the setting is empty.
 * A non-empty setting is never overwritten, and nothing is written for a shell that was not found.
 * @param {() => ReturnType<typeof detectXaeShells>} detect
 * @returns {Promise<XaeShellFillResult[]>} One entry per version, in display order.
 */
async function fillXaeShellSettings(detect) {
    const found = await detect();
    const config = vscode.workspace.getConfiguration(XAE_SHELL_SECTION);
    /** @type {XaeShellFillResult[]} */
    const results = [];
    for (const shell of XAE_SHELL_VERSIONS) {
        const current = config.get(shell.key);
        const value = typeof current === 'string' ? current.trim() : '';
        if (value) {
            results.push({ id: shell.id, version: shell.version, status: 'kept', path: value, missing: !fs.existsSync(value) });
            continue;
        }
        const hit = found && found[shell.id];
        if (!hit || !hit.path) {
            results.push({ id: shell.id, version: shell.version, status: 'notFound', path: '' });
            continue;
        }
        await config.update(shell.key, hit.path, vscode.ConfigurationTarget.Global);
        results.push({ id: shell.id, version: shell.version, status: 'found', path: hit.path });
    }
    return results;
}

/**
 * The one-line summary `twincat.detectXaeShell` shows.
 * @param {XaeShellFillResult[]} results
 * @param {string} platform
 * @returns {string}
 */
function describeFill(results, platform) {
    const parts = results.map((r) => {
        if (r.status === 'found') return `${r.version}: found ${r.path}`;
        if (r.status === 'kept') return `${r.version}: kept your value ${r.path}${r.missing ? ' (that file does not exist)' : ''}`;
        return `${r.version}: not found`;
    });
    const note = platform === 'win32' ? '' : ' Detection runs on Windows only.';
    return `XAE Shell — ${parts.join(' · ')}.${note}`;
}

/**
 * Registers `twincat.detectXaeShell`.
 * @param {vscode.ExtensionContext} context
 * @param {object} [deps]
 * @param {() => ReturnType<typeof detectXaeShells>} [deps.detect] Detection; the real one by default.
 * @param {string} [deps.platform] `process.platform` by default.
 * @returns {{autoFill: () => Promise<XaeShellFillResult[]>}} `autoFill` is the silent activation-time
 *   fill; it never rejects.
 */
function registerXaeShellCommands(context, { detect = detectOnThisMachine, platform = process.platform } = {}) {
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.detectXaeShell', async () => {
            /** @type {XaeShellFillResult[]} */
            let results;
            try {
                results = await fillXaeShellSettings(detect);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not update the XAE Shell settings: ${err && err.message ? err.message : err}`);
                return undefined;
            }
            // Not awaited for the return value: a notification nobody dismisses must not hold the caller.
            Promise.resolve(vscode.window.showInformationMessage(describeFill(results, platform), 'Open Settings')).then((choice) => {
                if (choice === 'Open Settings') return vscode.commands.executeCommand('twincat.openSettings', XAE_SHELL_SECTION);
                return undefined;
            }).then(undefined, () => undefined);
            return results;
        })
    );

    return {
        autoFill: () => fillXaeShellSettings(detect).catch((err) => {
            console.error('TC Toolkit: could not fill the XAE Shell settings:', err);
            return [];
        })
    };
}

module.exports = { registerXaeShellCommands, fillXaeShellSettings, describeFill };
