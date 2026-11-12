/**
 * @file cppToolsCommands.js
 * @description The VS Code half of the C/C++ extension integration (src/cppToolsProvider.js): builds
 * the provider with the extension's vendored runtime headers, the project map and the g++ a build
 * would use, and registers it through `vscode-cpptools` when `ms-vscode.cpptools` is installed. A
 * change of `tcToolkit.compiler.gppPath`, or a generated file appearing in a CPP_Files folder, tells
 * the C/C++ extension to ask again. Writes nothing; does nothing without the C/C++ extension.
 */

'use strict';

const path = require('path');
const vscode = require('vscode');
const { SETTING_GPP_PATH, resolveGpp, thisMachine } = require('../gpp');
const { CPP_SECTION } = require('../cppSettings');
const { createCppConfigurationProvider, connectCppTools } = require('../cppToolsProvider');

/**
 * The C/C++ extension's API, version 7 (the newest `vscode-cpptools` 7.1 knows; an older C/C++
 * extension answers with its own, which the package handles).
 * @returns {Promise<any>}
 */
async function getApi() {
    const { getCppToolsApi, Version } = require('vscode-cpptools');
    return getCppToolsApi(Version.v7);
}

/**
 * Registers the configuration provider for the generated C++.
 * @param {vscode.ExtensionContext} context
 * @param {{getProjectMap: () => any, getApi?: () => Promise<any>}} deps `getApi`: for the tests.
 * @returns {{changed: () => void, connected: () => boolean, ready: Promise<boolean>}}
 */
function registerCppToolsProvider(context, deps) {
    /** @type {string|null|undefined} undefined: not resolved since the last change. */
    let gppCache;
    const gppPath = () => {
        if (gppCache === undefined) {
            try {
                const found = resolveGpp({ configured: vscode.workspace.getConfiguration(CPP_SECTION).get('gppPath', ''), ...thisMachine() });
                gppCache = found.ok === true ? found.path : null;
            } catch (e) { gppCache = null; }
        }
        return gppCache;
    };
    const provider = createCppConfigurationProvider({
        extensionId: (context.extension && context.extension.id) || 'a-abushaqra.twincat-plc-toolkit',
        includeDir: path.join(context.extensionPath, 'resources', 'compiler', 'include'),
        gppPath,
        projectDirs: () => {
            const map = deps.getProjectMap();
            return map && map.projects ? [...map.projects.values()].map((/** @type {any} */ p) => p.dir).filter(Boolean) : [];
        }
    });
    const link = connectCppTools({ vscode, provider, getApi: deps.getApi || getApi, subscriptions: context.subscriptions });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SETTING_GPP_PATH)) { gppCache = undefined; link.changed(); }
    }));
    // A first generation creates a CPP_Files folder the browse configuration does not list yet.
    link.ready.then((ok) => {
        if (!ok || !vscode.workspace.createFileSystemWatcher) return;
        const watcher = vscode.workspace.createFileSystemWatcher('**/CPP_Files/*.{cpp,hpp}', false, true, true);
        context.subscriptions.push(watcher, watcher.onDidCreate(() => link.changed()));
    }, () => undefined);
    return link;
}

module.exports = { registerCppToolsProvider };
