/**
 * @file cppToolsCommands.js
 * @description The VS Code half of the C/C++ extension integration (src/cppToolsProvider.js): builds
 * the provider with the extension's vendored runtime headers, the project map and the g++ a build
 * would use, and registers it through `vscode-cpptools` when `ms-vscode.cpptools` is installed. A
 * change of `tcToolkit.compiler.gppPath`, or a generated file appearing in a CPP_Files folder, tells
 * the C/C++ extension to ask again. Does nothing without the C/C++ extension.
 *
 * Registering is not selecting: the C/C++ extension only consults the provider its configuration names.
 * When a generated file is written or opened and TC Toolkit is not that provider for the file's workspace
 * folder (src/cppToolsSelection.js), one message per folder offers to set
 * `C_Cpp.default.configurationProvider` there — or, when `.vscode/c_cpp_properties.json` names another
 * provider (the file wins over the setting), to open that file; nothing else is ever written. The
 * C/C++ extension's requests are logged to the "TC Toolkit C/C++" output channel.
 */

'use strict';

const path = require('path');
const vscode = require('vscode');
const { SETTING_GPP_PATH, resolveGpp, thisMachine } = require('../gpp');
const { CPP_SECTION } = require('../cppSettings');
const { defaultMsys2RootCache } = require('../msys2Detect');
const { createCppConfigurationProvider, connectCppTools, CPPTOOLS_EXTENSION_ID } = require('../cppToolsProvider');
const { CPP_SECTION_NAME, PROVIDER_SETTING_KEY, PROPERTIES_RELATIVE, providerSelection } = require('../cppToolsSelection');

/** The output channel the C/C++ extension's requests are logged to. */
const CPP_OUTPUT_CHANNEL = 'TC Toolkit C/C++';

/** The message's first sentence. */
const SELECT_MESSAGE = 'IntelliSense for the generated C++ needs TC Toolkit as the C/C++ configuration provider.';
const USE_BUTTON = 'Use TC Toolkit';
const NOT_NOW_BUTTON = 'Not now';
const NEVER_BUTTON = "Don't ask again";
const OPEN_FILE_BUTTON = 'Open c_cpp_properties.json';

/** workspaceState key prefix: a folder's answer (`selected`, `never`, `opened`), so it is asked once. */
const PROMPT_STATE_PREFIX = 'tcToolkit.cppProviderPrompt:';

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
 * The one-time offer to make TC Toolkit the C/C++ configuration provider of a workspace folder.
 * @param {{extensionId: string, provider: {generatedFolderOf: (fsPath: string) => (string|null)},
 *   link: {changed: () => void, connected: () => boolean, ready: Promise<boolean>},
 *   workspaceState: {get: (key: string) => any, update: (key: string, value: any) => Thenable<void>},
 *   log: (line: string) => void, platform?: string, readFile?: (file: string) => (string|null)}} o
 * @returns {{check: (uri: any) => Promise<string>}} `check` resolves to what happened (for the tests):
 *   `skip`, `asked-before`, `none`, or the button chosen (`dismissed` when none).
 */
function createProviderPrompt(o) {
    const platform = o.platform || process.platform;
    const readFile = o.readFile || ((/** @type {string} */ file) => {
        try { return require('fs').readFileSync(file, 'utf8'); } catch (e) { return null; }
    });
    /** Folders asked in this session (also while a message is still open). */
    const asked = new Set();

    /** @param {any} uri */
    async function check(uri) {
        try {
            if (!uri || uri.scheme !== 'file' || !vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID)) return 'skip';
            if (!o.provider.generatedFolderOf(uri.fsPath)) return 'skip';
            await o.link.ready;
            // Selecting a provider the C/C++ extension does not know yet would gain nothing.
            if (!o.link.connected()) return 'skip';
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            if (!folder) return 'skip';
            const key = PROMPT_STATE_PREFIX + folder.uri.toString();
            if (asked.has(key) || o.workspaceState.get(key)) return 'asked-before';
            const propsPath = path.join(folder.uri.fsPath, ...PROPERTIES_RELATIVE);
            const settings = vscode.workspace.getConfiguration(CPP_SECTION_NAME, folder.uri);
            const decision = providerSelection({
                extensionId: o.extensionId, platform,
                settingValue: settings.get(PROVIDER_SETTING_KEY),
                propertiesText: readFile(propsPath)
            });
            if (decision.action === 'none') return 'none';
            asked.add(key);
            o.log(`${folder.name}: TC Toolkit is not the configuration provider (${decision.action === 'file'
                ? `c_cpp_properties.json names ${decision.named ? `"${decision.named}"` : 'no provider, or cannot be read'}`
                : `C_Cpp.default.configurationProvider is ${decision.current ? `"${decision.current}"` : 'not set'}`})`);
            if (decision.action === 'file') {
                const what = decision.named ? `names "${decision.named}"` : 'names no provider (or cannot be read)';
                const why = ` .vscode/c_cpp_properties.json in "${folder.name}" ${what}, and that file wins over the settings: set "configurationProvider": "${o.extensionId}" in it.`;
                const choice = await vscode.window.showInformationMessage(SELECT_MESSAGE + why, OPEN_FILE_BUTTON, NEVER_BUTTON);
                if (choice === OPEN_FILE_BUTTON) {
                    await o.workspaceState.update(key, 'opened');
                    await vscode.window.showTextDocument(vscode.Uri.file(propsPath));
                } else if (choice === NEVER_BUTTON) {
                    await o.workspaceState.update(key, 'never');
                }
                return choice || 'dismissed';
            }
            const where = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1 ? ` (folder "${folder.name}")` : '';
            const choice = await vscode.window.showInformationMessage(`${SELECT_MESSAGE} Use it for this workspace${where}?`,
                USE_BUTTON, NOT_NOW_BUTTON, NEVER_BUTTON);
            if (choice === USE_BUTTON) {
                try {
                    await settings.update(PROVIDER_SETTING_KEY, o.extensionId, vscode.ConfigurationTarget.WorkspaceFolder);
                } catch (err) {
                    asked.delete(key);
                    vscode.window.showWarningMessage(`Could not set C_Cpp.default.configurationProvider: ${err && err.message ? err.message : err}`);
                    return 'failed';
                }
                await o.workspaceState.update(key, 'selected');
                o.log(`${folder.name}: C_Cpp.default.configurationProvider set to "${o.extensionId}" (workspace folder)`);
                o.link.changed();
            } else if (choice === NEVER_BUTTON) {
                await o.workspaceState.update(key, 'never');
            }
            return choice || 'dismissed';
        } catch (err) {
            console.error('TC Toolkit: C/C++ provider selection check failed:', err);
            return 'skip';
        }
    }
    return { check };
}

/**
 * Registers the configuration provider for the generated C++.
 * @param {vscode.ExtensionContext} context
 * @param {{getProjectMap: () => any, getApi?: () => Promise<any>, msys2Ready?: () => Promise<string[]>}} deps
 *   `getApi`, `msys2Ready` (the MSYS2 registry search, src/msys2Detect.js): for the tests.
 * @returns {{changed: () => void, connected: () => boolean, ready: Promise<boolean>, check: (uri: any) => Promise<string>}}
 */
function registerCppToolsProvider(context, deps) {
    /** @type {vscode.OutputChannel|null} */
    let channel = null;
    const log = (/** @type {string} */ line) => {
        if (!channel) {
            channel = vscode.window.createOutputChannel(CPP_OUTPUT_CHANNEL);
            context.subscriptions.push(channel);
        }
        channel.appendLine(`[${new Date().toISOString()}] ${line}`);
    };
    /** @type {string|null|undefined} undefined: not resolved since the last change. */
    let gppCache;
    const gppPath = () => {
        if (gppCache === undefined) {
            try {
                const found = resolveGpp({ configured: vscode.workspace.getConfiguration(CPP_SECTION).get('gppPath', ''), ...thisMachine() });
                // A g++ the build refuses (older than 7) is not handed over: the C/C++ extension keeps its own default.
                gppCache = found.ok === true && !found.tooOld ? found.path : null;
            } catch (e) { gppCache = null; }
        }
        return gppCache;
    };
    const extensionId = (context.extension && context.extension.id) || 'a-abushaqra.twincat-plc-toolkit';
    const provider = createCppConfigurationProvider({
        extensionId,
        log,
        includeDir: path.join(context.extensionPath, 'resources', 'compiler', 'include'),
        gppPath,
        projectDirs: () => {
            const map = deps.getProjectMap();
            return map && map.projects ? [...map.projects.values()].map((/** @type {any} */ p) => p.dir).filter(Boolean) : [];
        }
    });
    const link = connectCppTools({ vscode, provider, getApi: deps.getApi || getApi, subscriptions: context.subscriptions });
    // A g++ resolved before the MSYS2 registry search settled may miss an MSYS2 g++: resolve again then.
    Promise.resolve().then(deps.msys2Ready || (() => defaultMsys2RootCache().load()))
        .then((roots) => {
            gppCache = undefined;
            if (Array.isArray(roots) && roots.length > 0) link.changed();
        }).then(undefined, () => undefined);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SETTING_GPP_PATH)) { gppCache = undefined; link.changed(); }
    }));
    // A first generation creates a CPP_Files folder the browse configuration does not list yet. Made
    // whether or not the C/C++ extension is there now: it may be installed later, and `changed` does
    // nothing while it is not connected.
    const prompt = createProviderPrompt({ extensionId, provider, link, workspaceState: context.workspaceState, log });
    if (vscode.workspace.createFileSystemWatcher) {
        const watcher = vscode.workspace.createFileSystemWatcher('**/CPP_Files/*.{cpp,hpp}', false, false, true);
        context.subscriptions.push(watcher, watcher.onDidCreate((uri) => { link.changed(); prompt.check(uri); }));
        // A generation that rewrites existing files is "just generated" too.
        if (typeof watcher.onDidChange === 'function') context.subscriptions.push(watcher.onDidChange((uri) => { prompt.check(uri); }));
    }
    // A generated file opened in an editor (also one already open at activation).
    if (vscode.workspace.onDidOpenTextDocument) {
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => { prompt.check(doc.uri); }));
    }
    for (const doc of vscode.workspace.textDocuments || []) prompt.check(doc.uri);
    return { ...link, check: prompt.check };
}

module.exports = { registerCppToolsProvider, createProviderPrompt, CPP_OUTPUT_CHANNEL, PROMPT_STATE_PREFIX };
