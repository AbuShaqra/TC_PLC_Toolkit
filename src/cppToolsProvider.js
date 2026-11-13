/**
 * @file cppToolsProvider.js
 * @description IntelliSense for the generated C++ (roadmap R13) in Microsoft's C/C++ extension
 * (`ms-vscode.cpptools`): a custom configuration provider, registered through that extension's
 * public API (npm package `vscode-cpptools`), answers for the `.cpp`/`.hpp` files directly in a
 * PLC project's `CPP_Files/` folder — the vendored runtime headers (`resources/compiler/include/`)
 * and that folder on the include path, C++17, and the g++ the build uses as the compiler. Without
 * it, the C/C++ extension reports "cannot open source file iec_types.hpp" on every generated file.
 *
 * Nothing is written here: the C/C++ extension only consults a provider a configuration selects, and
 * offering that selection is src/cppToolsSelection.js + src/commands/cppToolsCommands.js. When the C/C++
 * extension is not installed nothing happens at all (no error, no notification); when it is installed
 * later in the session, the provider is registered then.
 *
 * `createCppConfigurationProvider` is vscode-free (test/test_cpptools_provider.js drives it with
 * plain objects); `connectCppTools` takes `vscode` and the API getter as arguments.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { CPP_FILES_DIR } = require('./cppGenerate');

/** The C/C++ extension's id. */
const CPPTOOLS_EXTENSION_ID = 'ms-vscode.cpptools';

/** The provider's name, as the C/C++ extension shows it. */
const PROVIDER_NAME = 'TC Toolkit';

/** The file kinds the toolkit generates into CPP_Files. */
const SOURCE_EXTENSIONS = Object.freeze(['.cpp', '.hpp']);

/** The language standard of the g++ build (src/gpp.js GPP_FLAGS). */
const CPP_STANDARD = 'c++17';

/**
 * The IntelliSense mode of a g++ on this platform and architecture.
 * @param {string} platform
 * @param {string} arch
 * @returns {string}
 */
function gccIntelliSenseMode(platform, arch) {
    const os = platform === 'win32' ? 'windows' : (platform === 'darwin' ? 'macos' : 'linux');
    const cpu = arch === 'arm64' ? 'arm64' : (arch === 'arm' ? 'arm' : (arch === 'ia32' ? 'x86' : 'x64'));
    return `${os}-gcc-${cpu}`;
}

/**
 * @typedef {Object} CppProviderDeps
 * @property {string} extensionId This extension's id (`publisher.name`).
 * @property {string} includeDir The vendored runtime headers.
 * @property {() => (string|null)} gppPath The g++ a build would use, or null (src/gpp.js resolveGpp).
 * @property {() => string[]} projectDirs The PLC project folders of the workspace.
 * @property {(dir: string) => boolean} [hasPlcproj] Whether a folder holds a `.plcproj` (projects the
 *   map does not know yet); a real directory listing by default.
 * @property {(dir: string) => boolean} [isDir] Whether a folder exists; the real check by default.
 * @property {(line: string) => void} [log] Told each time the C/C++ extension asks (the
 *   "TC Toolkit C/C++" output channel), for diagnosing on the user's machine.
 * @property {string} [platform]
 * @property {string} [arch]
 */

/**
 * The C/C++ extension's custom configuration provider for the generated C++.
 * @param {CppProviderDeps} deps
 */
function createCppConfigurationProvider(deps) {
    const platform = deps.platform || process.platform;
    const arch = deps.arch || process.arch;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const key = (/** @type {string} */ f) => {
        const r = p.resolve(f);
        return platform === 'win32' ? r.toLowerCase() : r;
    };
    const hasPlcproj = deps.hasPlcproj || ((/** @type {string} */ dir) => {
        try { return fs.readdirSync(dir).some(n => /\.plcproj$/i.test(n)); } catch (e) { return false; }
    });
    const isDir = deps.isDir || ((/** @type {string} */ dir) => { try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; } });
    const log = (/** @type {string} */ line) => { try { if (deps.log) deps.log(line); } catch (e) { /* logging never fails a request */ } };
    const show = (/** @type {any} */ uri) => {
        if (!uri) return String(uri);
        try { return typeof uri === 'string' ? uri : (uri.fsPath || String(uri)); } catch (e) { return '?'; }
    };

    /**
     * The CPP_Files folder a generated file is in, or null when the file is not one.
     * @param {string} fsPath
     * @returns {string|null}
     */
    function cppFolderOf(fsPath) {
        if (!fsPath || !SOURCE_EXTENSIONS.includes(p.extname(fsPath).toLowerCase())) return null;
        const dir = p.dirname(fsPath);
        const name = p.basename(dir);
        // Windows file names ignore case; elsewhere only the folder the toolkit writes counts.
        if (platform === 'win32' ? name.toLowerCase() !== CPP_FILES_DIR.toLowerCase() : name !== CPP_FILES_DIR) return null;
        const projectDir = p.dirname(dir);
        const known = (deps.projectDirs() || []).some(d => key(d) === key(projectDir));
        return known || hasPlcproj(projectDir) ? dir : null;
    }

    /** The g++ in use, or undefined; never throws. */
    function compilerPath() {
        try { return deps.gppPath() || undefined; } catch (e) { return undefined; }
    }

    /**
     * The configuration of one generated file.
     * @param {string} cppDir Its CPP_Files folder.
     */
    function configurationFor(cppDir) {
        const gpp = compilerPath();
        /** @type {{includePath: string[], defines: string[], standard: string, intelliSenseMode?: string, compilerPath?: string}} */
        const config = { includePath: [deps.includeDir, cppDir], defines: [], standard: CPP_STANDARD };
        // Without a g++ the C/C++ extension's own default mode stays.
        if (gpp) { config.intelliSenseMode = gccIntelliSenseMode(platform, arch); config.compilerPath = gpp; }
        return config;
    }

    /** The CPP_Files folders of the known projects that exist. */
    function cppFolders() {
        /** @type {string[]} */
        const out = [];
        for (const d of deps.projectDirs() || []) {
            const dir = p.join(d, CPP_FILES_DIR);
            if (isDir(dir)) out.push(dir);
        }
        return out;
    }

    return {
        name: PROVIDER_NAME,
        extensionId: deps.extensionId,
        /** The CPP_Files folder of a generated file, or null (not asked by the C/C++ extension). */
        generatedFolderOf: cppFolderOf,
        /** @param {{fsPath: string}} uri */
        canProvideConfiguration(uri) {
            const yes = !!(uri && cppFolderOf(uri.fsPath));
            log(`canProvideConfiguration ${show(uri)} -> ${yes}`);
            return Promise.resolve(yes);
        },
        /**
         * Each item carries the very URI object it was asked for: the C/C++ extension matches the answer
         * to its request by `uri.toString()` and accepts only a string or its own `vscode.Uri`.
         * @param {Array<{fsPath: string}>} uris
         */
        provideConfigurations(uris) {
            /** @type {any[]} */
            const items = [];
            for (const uri of uris || []) {
                const dir = uri ? cppFolderOf(uri.fsPath) : null;
                if (dir) items.push({ uri, configuration: configurationFor(dir) });
            }
            log(`provideConfigurations ${(uris || []).map(show).join(', ')} -> ${items.length} item(s)`
                + (items.length ? `: ${JSON.stringify(items[0].configuration)}` : ''));
            return Promise.resolve(items);
        },
        // Only with a CPP_Files folder: otherwise the C/C++ extension keeps its own browse path.
        canProvideBrowseConfiguration() {
            const yes = cppFolders().length > 0;
            log(`canProvideBrowseConfiguration -> ${yes}`);
            return Promise.resolve(yes);
        },
        provideBrowseConfiguration() {
            const gpp = compilerPath();
            /** @type {{browsePath: string[], standard: string, compilerPath?: string}} */
            const browse = { browsePath: [deps.includeDir, ...cppFolders()], standard: CPP_STANDARD };
            if (gpp) browse.compilerPath = gpp;
            log(`provideBrowseConfiguration -> ${JSON.stringify(browse)}`);
            return Promise.resolve(browse);
        },
        canProvideBrowseConfigurationsPerFolder() {
            return Promise.resolve(false);
        },
        provideFolderBrowseConfiguration() {
            return Promise.resolve(null);
        },
        dispose() { /* nothing held */ }
    };
}

/**
 * @typedef {Object} CppToolsApiLike The part of the C/C++ extension's API used here.
 * @property {(provider: any) => void} registerCustomConfigurationProvider
 * @property {(provider: any) => void} [notifyReady]
 * @property {(provider: any) => void} didChangeCustomConfiguration
 * @property {(provider: any) => void} [didChangeCustomBrowseConfiguration]
 * @property {() => void} [dispose]
 */

/**
 * Registers the provider with the C/C++ extension when it is installed — now, or when it is installed
 * later. Never throws and never shows anything.
 * @param {{vscode: any, provider: ReturnType<typeof createCppConfigurationProvider>,
 *   getApi: () => Promise<CppToolsApiLike|undefined>, subscriptions: Array<{dispose: () => any}>}} o
 * @returns {{changed: () => void, connected: () => boolean, ready: Promise<boolean>}} `changed`: tell the
 *   C/C++ extension the configurations changed (the g++ path, a new project); `ready`: settles once the
 *   first attempt is done (true when registered).
 */
function connectCppTools(o) {
    /** @type {CppToolsApiLike|null} */
    let api = null;
    let connecting = false;
    const installed = () => {
        try { return !!o.vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID); } catch (e) { return false; }
    };
    const tryConnect = async () => {
        if (api || connecting || !installed()) return !!api;
        connecting = true;
        try {
            const got = await o.getApi();
            if (!got) return false;
            got.registerCustomConfigurationProvider(o.provider);
            if (typeof got.notifyReady === 'function') got.notifyReady(o.provider);
            else got.didChangeCustomConfiguration(o.provider);
            api = got;
            o.subscriptions.push({ dispose: () => { try { if (api && api.dispose) api.dispose(); } catch (e) { /* shutting down */ } api = null; } });
            return true;
        } catch (err) {
            console.error('TC Toolkit: could not register with the C/C++ extension:', err);
            return false;
        } finally {
            connecting = false;
        }
    };
    try {
        if (o.vscode.extensions.onDidChange) o.subscriptions.push(o.vscode.extensions.onDidChange(() => { tryConnect(); }));
    } catch (e) { /* no extension events: connect once only */ }
    return {
        ready: tryConnect(),
        connected: () => !!api,
        changed: () => {
            if (!api) return;
            try {
                api.didChangeCustomConfiguration(o.provider);
                if (typeof api.didChangeCustomBrowseConfiguration === 'function') api.didChangeCustomBrowseConfiguration(o.provider);
            } catch (e) { /* the C/C++ extension went away */ }
        }
    };
}

module.exports = {
    CPPTOOLS_EXTENSION_ID, PROVIDER_NAME, CPP_STANDARD, SOURCE_EXTENSIONS,
    gccIntelliSenseMode, createCppConfigurationProvider, connectCppTools
};
