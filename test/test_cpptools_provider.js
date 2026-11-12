/**
 * @file test_cpptools_provider.js
 * @description IntelliSense for the generated C++ in Microsoft's C/C++ extension (R13):
 * src/cppToolsProvider.js's configuration provider over plain objects (which files it answers for,
 * the include path, C++17, the g++ as compiler and its IntelliSense mode, the browse configuration),
 * connectCppTools against a fake C/C++ API (registered and made ready only when the extension is
 * installed, also when it is installed later; never throws, never shows anything), and
 * src/commands/cppToolsCommands.js under a `vscode` stub (a g++ path change tells the C/C++
 * extension again; nothing is written).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── vscode stub (for src/commands/cppToolsCommands.js) ─────────────────────────────────────────
const settings = {};
/** @type {Array<(e: any) => void>} */
const configListeners = [];
/** @type {Array<() => void>} */
const extensionListeners = [];
/** @type {any} */
let installedCpptools = null;
const shown = [];
/** @type {Array<{glob: string, listeners: Array<() => void>}>} */
const watchers = [];
const writes = [];
const vscodeStub = {
    extensions: {
        getExtension: (id) => (id === 'ms-vscode.cpptools' ? installedCpptools : undefined),
        onDidChange: (fn) => { extensionListeners.push(fn); return { dispose() {} }; }
    },
    workspace: {
        getConfiguration: (section) => ({
            get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, `${section}.${key}`) ? settings[`${section}.${key}`] : fallback),
            update: async (key, value) => { writes.push({ key, value }); }
        }),
        onDidChangeConfiguration: (fn) => { configListeners.push(fn); return { dispose() {} }; },
        createFileSystemWatcher: (glob) => {
            const w = { glob, listeners: [], onDidCreate: (fn) => { w.listeners.push(fn); return { dispose() {} }; }, dispose() {} };
            watchers.push(w);
            return w;
        }
    },
    window: {
        showInformationMessage: async (m) => { shown.push(m); },
        showWarningMessage: async (m) => { shown.push(m); },
        showErrorMessage: async (m) => { shown.push(m); }
    }
};
const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.apply(this, arguments);
};

const { createCppConfigurationProvider, connectCppTools, gccIntelliSenseMode, CPPTOOLS_EXTENSION_ID } = require('../src/cppToolsProvider');
const { registerCppToolsProvider } = require('../src/commands/cppToolsCommands');

/** A fake C/C++ API that records every call. */
function fakeApi() {
    const calls = [];
    return {
        calls,
        provider: null,
        registerCustomConfigurationProvider(p) { this.provider = p; calls.push(['register', p.name]); },
        notifyReady: (p) => calls.push(['ready', p.name]),
        didChangeCustomConfiguration: (p) => calls.push(['changed', p.name]),
        didChangeCustomBrowseConfiguration: (p) => calls.push(['browseChanged', p.name]),
        dispose: () => calls.push(['dispose'])
    };
}
const uri = (fsPath) => ({ fsPath, scheme: 'file' });

(async () => {
    // ── The provider (Windows paths) ─────────────────────────────────────────────────────────────
    const INC = 'C:\\ext\\resources\\compiler\\include';
    let gpp = 'C:\\msys64\\ucrt64\\bin\\g++.exe';
    const provider = createCppConfigurationProvider({
        extensionId: 'pub.ext', includeDir: INC, gppPath: () => gpp,
        projectDirs: () => ['D:\\Sol\\PLC1\\PLC1'],
        hasPlcproj: (dir) => dir.toLowerCase() === 'd:\\other\\plc2',
        isDir: (dir) => dir.toLowerCase() === 'd:\\sol\\plc1\\plc1\\cpp_files',
        platform: 'win32', arch: 'x64'
    });
    assert(provider.name === 'TC Toolkit' && provider.extensionId === 'pub.ext', 'PROVIDER: named "TC Toolkit", with the extension\'s id');
    const can = async (p) => provider.canProvideConfiguration(uri(p));
    assert(await can('D:\\Sol\\PLC1\\PLC1\\CPP_Files\\PLC1.cpp') && await can('d:\\sol\\plc1\\plc1\\cpp_files\\PLC1.HPP'),
        'PROVIDER: the .cpp and .hpp in a known project\'s CPP_Files (any letter case on Windows)');
    assert(await can('D:\\Other\\PLC2\\CPP_Files\\PLC2.hpp'), 'PROVIDER: a CPP_Files next to a .plcproj the project map does not know yet');
    assert(!(await can('D:\\Sol\\PLC1\\PLC1\\CPP_Files\\PLC1.o')) && !(await can('D:\\Sol\\PLC1\\PLC1\\CPP_Files\\notes.txt'))
        && !(await can('D:\\Sol\\PLC1\\PLC1\\CPP_Files\\sub\\x.cpp')) && !(await can('D:\\Sol\\PLC1\\PLC1\\POUs\\x.cpp'))
        && !(await can('D:\\Elsewhere\\CPP_Files\\x.cpp')) && !(await can('')) && !(await provider.canProvideConfiguration(undefined)),
    'PROVIDER: not the object file, other files, sub-folders, other folders, or a CPP_Files outside a PLC project');
    const items = await provider.provideConfigurations([uri('D:\\Sol\\PLC1\\PLC1\\CPP_Files\\PLC1.hpp'), uri('D:\\x\\y.cpp')]);
    assert(items.length === 1 && items[0].uri.fsPath === 'D:\\Sol\\PLC1\\PLC1\\CPP_Files\\PLC1.hpp'
        && eq(items[0].configuration, { includePath: [INC, 'D:\\Sol\\PLC1\\PLC1\\CPP_Files'], defines: [], standard: 'c++17',
            intelliSenseMode: 'windows-gcc-x64', compilerPath: gpp }),
    `PROVIDER: the runtime headers and the CPP_Files folder on the include path, C++17, the g++ and its mode (${JSON.stringify(items)})`);
    gpp = null;
    const noGpp = await provider.provideConfigurations([uri('D:\\Sol\\PLC1\\PLC1\\CPP_Files\\PLC1.cpp')]);
    assert(eq(noGpp[0].configuration, { includePath: [INC, 'D:\\Sol\\PLC1\\PLC1\\CPP_Files'], defines: [], standard: 'c++17' }),
        'PROVIDER: no g++: no compiler path, and the C/C++ extension\'s own default mode');
    assert(await provider.canProvideBrowseConfiguration() === true && eq(await provider.provideBrowseConfiguration(), { browsePath: [INC, 'D:\\Sol\\PLC1\\PLC1\\CPP_Files'], standard: 'c++17' })
        && await provider.canProvideBrowseConfigurationsPerFolder() === false && await provider.provideFolderBrowseConfiguration() === null,
    'PROVIDER: the browse configuration lists the runtime headers and the existing CPP_Files folders');
    gpp = 'C:\\msys64\\ucrt64\\bin\\g++.exe';
    assert((await provider.provideBrowseConfiguration()).compilerPath === gpp, 'PROVIDER: the browse configuration names the g++ too');
    const noFolders = createCppConfigurationProvider({ extensionId: 'x', includeDir: INC, gppPath: () => gpp, projectDirs: () => ['D:\\Sol\\PLC1\\PLC1'], isDir: () => false, platform: 'win32', arch: 'x64' });
    assert(await noFolders.canProvideBrowseConfiguration() === false,
        'PROVIDER: no CPP_Files folder yet: no browse configuration (the C/C++ extension keeps its own browse path)');
    const throwing = createCppConfigurationProvider({ extensionId: 'x', includeDir: '/inc', gppPath: () => { throw new Error('boom'); }, projectDirs: () => ['/w/P'], platform: 'linux', arch: 'x64' });
    const lin = await throwing.provideConfigurations([uri('/w/P/CPP_Files/P.cpp'), uri('/w/P/cpp_files/P.cpp')]);
    assert(lin.length === 1 && eq(lin[0].configuration.includePath, ['/inc', '/w/P/CPP_Files']) && !lin[0].configuration.compilerPath,
        'PROVIDER: Linux paths (case-sensitive: cpp_files is not CPP_Files); a failing g++ lookup is no g++');
    assert(gccIntelliSenseMode('win32', 'x64') === 'windows-gcc-x64' && gccIntelliSenseMode('linux', 'arm64') === 'linux-gcc-arm64'
        && gccIntelliSenseMode('darwin', 'x64') === 'macos-gcc-x64' && gccIntelliSenseMode('win32', 'ia32') === 'windows-gcc-x86',
    'PROVIDER: the gcc IntelliSense mode per platform and architecture');

    // ── connectCppTools ──────────────────────────────────────────────────────────────────────────
    const subs = [];
    let asked = 0;
    let api = fakeApi();
    installedCpptools = null;
    const quietWarn = console.warn;
    const link = connectCppTools({ vscode: vscodeStub, provider, getApi: async () => { asked++; return api; }, subscriptions: subs });
    assert(await link.ready === false && asked === 0 && !link.connected() && api.calls.length === 0 && shown.length === 0,
        'CONNECT: without the C/C++ extension nothing happens (the API is not even asked; no message)');
    link.changed();
    assert(api.calls.length === 0, 'CONNECT: a change before connecting does nothing');
    installedCpptools = { id: CPPTOOLS_EXTENSION_ID };
    for (const fn of extensionListeners) fn();
    await new Promise(r => setTimeout(r, 10));
    assert(link.connected() && asked === 1 && eq(api.calls, [['register', 'TC Toolkit'], ['ready', 'TC Toolkit']]),
        `CONNECT: installed later: registered, then made ready (${JSON.stringify(api.calls)})`);
    for (const fn of extensionListeners) fn();
    await new Promise(r => setTimeout(r, 10));
    assert(asked === 1, 'CONNECT: registered once only');
    link.changed();
    assert(eq(api.calls.slice(2), [['changed', 'TC Toolkit'], ['browseChanged', 'TC Toolkit']]), 'CONNECT: a change tells the C/C++ extension (files and browse)');
    for (const s of subs) s.dispose();
    assert(api.calls[api.calls.length - 1][0] === 'dispose' && !link.connected(), 'CONNECT: disposing the extension disposes the API');

    // An older API without notifyReady; a getter that answers nothing; one that throws.
    api = fakeApi();
    delete api.notifyReady;
    const old = connectCppTools({ vscode: vscodeStub, provider, getApi: async () => api, subscriptions: [] });
    assert(await old.ready === true && eq(api.calls, [['register', 'TC Toolkit'], ['changed', 'TC Toolkit']]), 'CONNECT: an API without notifyReady gets didChangeCustomConfiguration');
    assert(await connectCppTools({ vscode: vscodeStub, provider, getApi: async () => undefined, subscriptions: [] }).ready === false,
        'CONNECT: no API (the C/C++ extension did not activate) → not connected');
    const quietErr = console.error;
    console.error = () => {};
    const bad = connectCppTools({ vscode: vscodeStub, provider, getApi: async () => { throw new Error('activation failed'); }, subscriptions: [] });
    const badReady = await bad.ready;
    console.error = quietErr;
    console.warn = quietWarn;
    assert(badReady === false && shown.length === 0, 'CONNECT: a failing API getter never throws and shows nothing');

    // ── The VS Code wiring ───────────────────────────────────────────────────────────────────────
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_cpptools_'));
    const BIN = path.join(ROOT, 'bin');
    fs.mkdirSync(BIN);
    const fakeGpp = path.join(BIN, 'g++');
    fs.writeFileSync(fakeGpp, '#!/bin/sh\necho 13.3.0\n', { mode: 0o755 });
    const PROJ = path.join(ROOT, 'PLC');
    fs.mkdirSync(path.join(PROJ, 'CPP_Files'), { recursive: true });
    settings['tcToolkit.compiler.gppPath'] = fakeGpp;
    api = fakeApi();
    installedCpptools = { id: CPPTOOLS_EXTENSION_ID };
    const context = { subscriptions: [], extensionPath: '/ext', extension: { id: 'a-abushaqra.twincat-plc-toolkit' } };
    const projectMap = { projects: new Map([['k', { dir: PROJ }]]) };
    configListeners.length = 0;
    const wired = registerCppToolsProvider(context, { getProjectMap: () => projectMap, getApi: async () => api });
    assert(await wired.ready === true, 'WIRING: registered with the installed C/C++ extension');
    const registered = api.calls.length;
    assert(registered === 2, `WIRING: register + ready (${JSON.stringify(api.calls)})`);
    for (const fn of configListeners) fn({ affectsConfiguration: (s) => s === 'tcToolkit.compiler.nodePath' });
    assert(api.calls.length === registered, 'WIRING: another setting changing does not re-ask');
    for (const fn of configListeners) fn({ affectsConfiguration: (s) => s === 'tcToolkit.compiler.gppPath' || s === 'tcToolkit.compiler' });
    assert(eq(api.calls.slice(registered), [['changed', 'TC Toolkit'], ['browseChanged', 'TC Toolkit']]), 'WIRING: a g++ path change tells the C/C++ extension');
    assert(writes.length === 0 && shown.length === 0, 'WIRING: nothing is written, nothing is shown');
    const hpp = uri(path.join(PROJ, 'CPP_Files', 'PLC.hpp'));
    let cfg = (await api.provider.provideConfigurations([hpp]))[0].configuration;
    assert(cfg.compilerPath === fakeGpp && /gcc/.test(cfg.intelliSenseMode), 'WIRING: a g++ 13 is handed over as the compiler');

    // A g++ older than 7 (the build refuses it): not handed over, the C/C++ extension keeps its default.
    const oldGpp = path.join(BIN, 'g++-6');
    fs.writeFileSync(oldGpp, '#!/bin/sh\necho 6.3.0\n', { mode: 0o755 });
    settings['tcToolkit.compiler.gppPath'] = oldGpp;
    for (const fn of configListeners) fn({ affectsConfiguration: (s) => s === 'tcToolkit.compiler.gppPath' });
    cfg = (await api.provider.provideConfigurations([hpp]))[0].configuration;
    const browse = await api.provider.provideBrowseConfiguration();
    assert(!cfg.compilerPath && !cfg.intelliSenseMode && !browse.compilerPath && cfg.standard === 'c++17',
        `WIRING: a g++ 6 is not handed over as the compiler (${JSON.stringify(cfg)})`);

    // Without the C/C++ extension (the dev host): nothing at all.
    installedCpptools = null;
    api = fakeApi();
    extensionListeners.length = 0;
    watchers.length = 0;
    const absent = registerCppToolsProvider({ subscriptions: [], extensionPath: '/ext' }, { getProjectMap: () => null, getApi: async () => api });
    assert(await absent.ready === false && api.calls.length === 0 && shown.length === 0, 'WIRING: without the C/C++ extension nothing is registered and nothing is shown');
    assert(watchers.length === 1 && watchers[0].glob === '**/CPP_Files/*.{cpp,hpp}', 'WIRING: the CPP_Files watcher exists even without the C/C++ extension');
    for (const fn of watchers[0].listeners) fn();
    assert(api.calls.length === 0, 'WIRING: a generated file before the C/C++ extension is there tells nobody');
    // Installed mid-session: registered then, and a first generation refreshes the browse configuration.
    installedCpptools = { id: CPPTOOLS_EXTENSION_ID };
    for (const fn of extensionListeners) fn();
    await new Promise(r => setTimeout(r, 10));
    assert(absent.connected() && eq(api.calls, [['register', 'TC Toolkit'], ['ready', 'TC Toolkit']]), 'WIRING: the C/C++ extension installed later: registered');
    for (const fn of watchers[0].listeners) fn();
    assert(eq(api.calls.slice(2), [['changed', 'TC Toolkit'], ['browseChanged', 'TC Toolkit']]),
        `WIRING: installed later, a first generated file tells the C/C++ extension (${JSON.stringify(api.calls)})`);

    fs.rmSync(ROOT, { recursive: true, force: true });
    if (errors > 0) {
        console.error(`\n${errors} C/C++ provider assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll C/C++ provider assertions passed.');
})().catch((e) => { console.error(e); process.exit(1); });
