/**
 * @file test_cpptools_selection.js
 * @description Selecting TC Toolkit as the C/C++ extension's configuration provider (R13, user report
 * 2026-11-12: registered but not selected, so "cannot open source file iec_types.hpp" stayed):
 * src/cppToolsSelection.js (JSONC, which c_cpp_properties.json configuration counts, when the file wins
 * over `C_Cpp.default.configurationProvider`) and createProviderPrompt in
 * src/commands/cppToolsCommands.js under a `vscode` stub (settings per folder scope, the message once
 * per folder, the buttons, the setting written only in the folder scope, the file never written).
 */

'use strict';

const path = require('path');
const Module = require('module');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ── vscode stub ─────────────────────────────────────────────────────────────────────────────────
/** Effective `C_Cpp.default.configurationProvider` per folder uri string (as getConfiguration(…, uri) resolves it). */
const folderSetting = new Map();
const updates = [];
const messages = [];
const opened = [];
/** The button the next message answers with. */
let answer;
let cpptoolsInstalled = true;
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const mkUri = (fsPath) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` });
const FOLDER_A = { name: 'A', uri: mkUri(path.resolve('/ws/A')) };
const FOLDER_B = { name: 'B', uri: mkUri(path.resolve('/ws/B')) };
const vscodeStub = {
    ConfigurationTarget,
    Uri: { file: (p) => mkUri(p) },
    extensions: { getExtension: (id) => (id === 'ms-vscode.cpptools' && cpptoolsInstalled ? { id } : undefined) },
    workspace: {
        workspaceFolders: [FOLDER_A, FOLDER_B],
        getWorkspaceFolder: (uri) => [FOLDER_A, FOLDER_B].find(f => uri.fsPath.startsWith(f.uri.fsPath + path.sep)),
        getConfiguration: (section, scope) => ({
            get: (key) => (section === 'C_Cpp' && key === 'default.configurationProvider' ? folderSetting.get(scope && scope.toString()) : undefined),
            update: async (key, value, target) => {
                updates.push({ section, key, value, target, scope: scope && scope.toString() });
                if (target === ConfigurationTarget.WorkspaceFolder) folderSetting.set(scope.toString(), value);
            }
        })
    },
    window: {
        showInformationMessage: async (m, ...buttons) => { messages.push({ m, buttons }); return answer; },
        showWarningMessage: async (m) => { messages.push({ m, buttons: [] }); },
        showTextDocument: async (uri) => { opened.push(uri.fsPath); }
    }
};
const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.apply(this, arguments);
};

const { parseJsonc, providerFromProperties, providerSelection } = require('../src/cppToolsSelection');
const { createProviderPrompt } = require('../src/commands/cppToolsCommands');

const ID = 'a-abushaqra.twincat-plc-toolkit';

(async () => {
    // ── JSONC ────────────────────────────────────────────────────────────────────────────────────
    assert(JSON.stringify(parseJsonc('﻿// c\n{ "a": "x,]//y", /* z */ "b": [1, 2,], }')) === '{"a":"x,]//y","b":[1,2]}',
        'JSONC: comments, trailing commas and a BOM; a comma, bracket or // inside a string stays');
    assert(parseJsonc('{ "a": ') === null && parseJsonc(undefined) === null, 'JSONC: not JSON → null');

    // ── c_cpp_properties.json ──────────────────────────────────────────────────────────────────────
    const props = (configs) => JSON.stringify({ configurations: configs, version: 4 });
    assert(providerFromProperties(null, 'win32').exists === false, 'PROPERTIES: no file');
    let r = providerFromProperties(props([{ name: 'Linux', configurationProvider: 'x.linux' }, { name: 'Win32', configurationProvider: 'ms-vscode.cmake-tools' }]), 'win32');
    assert(r.exists && r.readable && r.provider === 'ms-vscode.cmake-tools', 'PROPERTIES: on Windows the Win32 configuration counts');
    r = providerFromProperties(props([{ name: 'Other' }, { name: 'Mine', configurationProvider: 'x.last' }]), 'linux');
    assert(r.provider === 'x.last', 'PROPERTIES: no configuration named for the platform → the LAST (the C/C++ extension\'s getConfigIndexForPlatform)');
    r = providerFromProperties(props([{ name: 'win32', configurationProvider: 'x.lower' }, { name: 'Other' }]), 'win32');
    assert(r.provider === null, 'PROPERTIES: the platform name matches exactly ("win32" is not "Win32")');
    r = providerFromProperties(props([{ name: 'Win32', configurationProvider: '' }]), 'win32');
    assert(r.provider === '', 'PROPERTIES: "" is an explicit no-provider (no fallback to the setting)');
    r = providerFromProperties(props([{ name: 'Win32', includePath: ['${workspaceFolder}/**'] }]), 'win32');
    assert(r.readable && r.provider === null, 'PROPERTIES: a configuration naming no provider → the setting applies');
    r = providerFromProperties(props([{ name: 'Win32', configurationProvider: '${default}' }]), 'win32');
    assert(r.provider === null, 'PROPERTIES: "${default}" → the setting applies');
    r = providerFromProperties('{ "configurations": [ { "name": "Win32", // c\n "configurationProvider": "' + ID + '", } ] }', 'win32');
    assert(r.provider === ID, 'PROPERTIES: JSONC file read');
    assert(providerFromProperties('{ broken', 'win32').readable === false && providerFromProperties('{}', 'win32').readable === false,
        'PROPERTIES: unreadable or without configurations');

    // ── providerSelection ─────────────────────────────────────────────────────────────────────────
    const sel = (settingValue, propertiesText) => providerSelection({ extensionId: ID, providerName: 'TC Toolkit', settingValue, propertiesText, platform: 'win32' });
    assert(sel(undefined, null).action === 'setting' && sel('', null).action === 'setting', 'SELECTION: no file, no setting → offer the setting');
    assert(sel(ID, null).action === 'none', 'SELECTION: the setting already names TC Toolkit → nothing');
    // The C/C++ extension looks provider ids up exactly (providers.has(id), no trim, no case folding).
    const upper = sel('A-AbuShaqra.twincat-plc-toolkit', null);
    assert(upper.action === 'setting' && upper.nearMiss === 'A-AbuShaqra.twincat-plc-toolkit',
        `SELECTION: the setting names the id in another case → not ours, offer the setting, flagged as a near miss (${JSON.stringify(upper)})`);
    const padded = sel(' ' + ID + ' ', null);
    assert(padded.action === 'setting' && padded.nearMiss === ' ' + ID + ' ', 'SELECTION: the setting names the id with blanks around it → not ours');
    const fileUpper = sel(undefined, props([{ name: 'a', configurationProvider: 'A-AbuShaqra.twincat-plc-toolkit' }]));
    assert(fileUpper.action === 'file' && fileUpper.named === 'A-AbuShaqra.twincat-plc-toolkit' && fileUpper.nearMiss !== undefined,
        `SELECTION: the file names the id in another case → the file decides, flagged (${JSON.stringify(fileUpper)})`);
    assert(sel(undefined, props([{ name: 'Win32', configurationProvider: 'TC Toolkit' }])).action === 'none',
        'SELECTION: the file names the provider by its display name → ours (the C/C++ extension\'s checkId rewrites it to the id)');
    assert(sel('TC Toolkit', null).action === 'setting', 'SELECTION: the display name in the SETTING is not rewritten by the C/C++ extension → not ours');
    assert(sel(undefined, props([{ name: 'Win32', configurationProvider: 'tc toolkit' }])).action === 'file', 'SELECTION: the display name matches exactly');
    // Another configuration (perhaps the active one, picked in the status bar) names another provider:
    // setting the setting may change nothing, so the file is pointed at instead.
    const otherCfg = sel(undefined, props([{ name: 'Win32' }, { name: 'Custom', configurationProvider: 'ms-vscode.cmake-tools' }]));
    assert(otherCfg.action === 'file' && otherCfg.named === 'ms-vscode.cmake-tools' && otherCfg.configuration === 'Custom',
        `SELECTION: another configuration names another provider → the file, naming that configuration (${JSON.stringify(otherCfg)})`);
    assert(sel(ID, props([{ name: 'Win32' }, { name: 'Custom', configurationProvider: 'ms-vscode.cmake-tools' }])).action === 'none',
        'SELECTION: the setting already names TC Toolkit → nothing, whatever other configurations say');
    assert(sel(undefined, props([{ name: 'Win32' }, { name: 'Custom', configurationProvider: ID }, { name: 'D', configurationProvider: '${default}' }])).action === 'setting',
        'SELECTION: other configurations naming TC Toolkit or ${default} → the setting is still offered');
    assert(sel(undefined, props([{ name: 'Win32', configurationProvider: ID }, { name: 'Custom', configurationProvider: 'x.other' }])).action === 'none',
        'SELECTION: the platform configuration names TC Toolkit → nothing');
    const other = sel('ms-vscode.cmake-tools', null);
    assert(other.action === 'setting' && other.current === 'ms-vscode.cmake-tools', 'SELECTION: the setting names another provider → offer the setting');
    assert(sel(undefined, props([{ name: 'Win32' }])).action === 'setting' && sel(ID, props([{ name: 'Win32' }])).action === 'none',
        'SELECTION: a file naming no provider → the setting decides');
    const fileWins = sel(ID, props([{ name: 'Win32', configurationProvider: 'ms-vscode.cmake-tools' }]));
    assert(fileWins.action === 'file' && fileWins.named === 'ms-vscode.cmake-tools', 'SELECTION: the file names another provider → the file wins, even over the setting');
    assert(sel(undefined, props([{ name: 'Win32', configurationProvider: ID }])).action === 'none', 'SELECTION: the file names TC Toolkit → nothing');
    assert(sel(undefined, '{ broken').action === 'file', 'SELECTION: an unreadable file → the file (offer to open it)');
    const empty = sel(ID, props([{ name: 'Win32', configurationProvider: '' }]));
    assert(empty.action === 'file' && empty.named === null, 'SELECTION: the file sets "configurationProvider": "" → the file wins, even over a setting naming TC Toolkit');

    // ── createProviderPrompt ──────────────────────────────────────────────────────────────────────
    const files = new Map();
    const state = new Map();
    const workspaceState = { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); } };
    const changed = [];
    let connected = true;
    const link = { ready: Promise.resolve(true), connected: () => connected, changed: () => changed.push(1) };
    const provider = { generatedFolderOf: (p) => (/[\\/]CPP_Files[\\/][^\\/]+\.(cpp|hpp)$/.test(p) ? path.dirname(p) : null) };
    const logs = [];
    const make = (log = (l) => logs.push(l)) => createProviderPrompt({ extensionId: ID, provider, link, workspaceState, log, platform: 'win32',
        readFile: (f) => (files.has(f) ? files.get(f) : null) });
    const cppA = mkUri(path.join(FOLDER_A.uri.fsPath, 'PLC', 'CPP_Files', 'PLC.cpp'));
    const cppB = mkUri(path.join(FOLDER_B.uri.fsPath, 'PLC', 'CPP_Files', 'PLC.hpp'));

    let prompt = make();
    assert(await prompt.check(mkUri(path.join(FOLDER_A.uri.fsPath, 'PLC', 'POUs', 'x.cpp'))) === 'skip' && messages.length === 0,
        'PROMPT: a file outside CPP_Files → nothing');
    cpptoolsInstalled = false;
    assert(await prompt.check(cppA) === 'skip' && messages.length === 0, 'PROMPT: without the C/C++ extension → nothing');
    cpptoolsInstalled = true;
    connected = false;
    assert(await prompt.check(cppA) === 'skip' && messages.length === 0, 'PROMPT: provider not registered → nothing');
    connected = true;
    assert(await prompt.check({ ...cppA, scheme: 'untitled' }) === 'skip', 'PROMPT: not a file URI → nothing');

    folderSetting.set(FOLDER_A.uri.toString(), ID);
    assert(await prompt.check(cppA) === 'none' && messages.length === 0, 'PROMPT: TC Toolkit already selected for the folder → nothing');
    folderSetting.delete(FOLDER_A.uri.toString());

    // "Not now": session only; a second check in the same session is not asked again.
    answer = 'Not now';
    assert(await prompt.check(cppA) === 'Not now' && messages.length === 1, 'PROMPT: not selected → one message');
    const m0 = messages[0];
    assert(m0.m.startsWith('IntelliSense for the generated C++ needs TC Toolkit as the C/C++ configuration provider.')
        && JSON.stringify(m0.buttons) === JSON.stringify(['Use TC Toolkit', 'Not now', "Don't ask again"]),
    `PROMPT: the message and its buttons (${JSON.stringify(m0)})`);
    assert(await prompt.check(cppA) === 'asked-before' && messages.length === 1, 'PROMPT: asked once per folder per session');
    assert(updates.length === 0 && state.size === 0, 'PROMPT: "Not now" writes nothing and is not remembered');
    // Two concurrent checks (several generated files at once) → still one message.
    prompt = make();
    messages.length = 0;
    answer = undefined;
    const both = await Promise.all([prompt.check(cppA), prompt.check(cppA)]);
    assert(messages.length === 1 && both.includes('dismissed') && both.includes('asked-before'), `PROMPT: concurrent checks → one message (${both})`);

    // "Use TC Toolkit": the folder-scoped setting, then the C/C++ extension is told.
    prompt = make();
    messages.length = 0;
    answer = 'Use TC Toolkit';
    assert(await prompt.check(cppA) === 'Use TC Toolkit', 'PROMPT: Use TC Toolkit chosen');
    assert(updates.length === 1 && updates[0].section === 'C_Cpp' && updates[0].key === 'default.configurationProvider'
        && updates[0].value === ID && updates[0].target === ConfigurationTarget.WorkspaceFolder && updates[0].scope === FOLDER_A.uri.toString(),
    `PROMPT: C_Cpp.default.configurationProvider set in the workspace-folder scope of that folder (${JSON.stringify(updates)})`);
    assert(changed.length === 1, 'PROMPT: didChangeCustomConfiguration after selecting');
    assert(state.get('tcToolkit.cppProviderPrompt:' + FOLDER_A.uri.toString()) === 'selected', 'PROMPT: the choice is remembered in workspaceState');
    // A new session (fresh prompt object), the user later changes the setting back: not asked again.
    folderSetting.delete(FOLDER_A.uri.toString());
    prompt = make();
    messages.length = 0;
    assert(await prompt.check(cppA) === 'asked-before' && messages.length === 0, 'PROMPT: after a choice, not asked again in later sessions');

    // Folder B is asked on its own; "Don't ask again" is remembered.
    answer = "Don't ask again";
    assert(await prompt.check(cppB) === "Don't ask again" && messages.length === 1 && / \(folder "B"\)/.test(messages[0].m),
        'PROMPT: another workspace folder is asked on its own (multi-root: the folder named)');
    assert(state.get('tcToolkit.cppProviderPrompt:' + FOLDER_B.uri.toString()) === 'never' && updates.length === 1,
        'PROMPT: "Don\'t ask again" remembered, nothing written');

    // c_cpp_properties.json naming another provider: the file wins — never edited, offer to open it.
    state.clear();
    updates.length = 0;
    messages.length = 0;
    const propsA = path.join(FOLDER_A.uri.fsPath, '.vscode', 'c_cpp_properties.json');
    files.set(propsA, '{ "configurations": [ { "name": "Win32", "configurationProvider": "ms-vscode.cmake-tools", }, ], }');
    prompt = make();
    answer = 'Open c_cpp_properties.json';
    assert(await prompt.check(cppA) === 'Open c_cpp_properties.json', 'PROMPT: the file names another provider → asked');
    assert(/that file wins over the settings/.test(messages[0].m) && /"ms-vscode\.cmake-tools"/.test(messages[0].m)
        && JSON.stringify(messages[0].buttons) === JSON.stringify(['Open c_cpp_properties.json', "Don't ask again"]),
    `PROMPT: the message says the file wins and offers to open it (${JSON.stringify(messages[0])})`);
    assert(opened.length === 1 && opened[0] === propsA && updates.length === 0, 'PROMPT: the file is opened, no setting written, the file not edited');
    // c_cpp_properties.json naming no provider: the setting is offered (the C/C++ extension fills it in).
    files.set(propsA, '{ "configurations": [ { "name": "Win32", "includePath": [] } ] }');
    state.clear();
    messages.length = 0;
    prompt = make();
    answer = 'Use TC Toolkit';
    assert(await prompt.check(cppA) === 'Use TC Toolkit' && updates.length === 1 && updates[0].target === ConfigurationTarget.WorkspaceFolder,
        'PROMPT: a file naming no provider → the setting is offered and set');
    assert(logs.some(l => /not the configuration provider/.test(l)) && logs.some(l => /set to "a-abushaqra/.test(l)), 'PROMPT: the check is logged');

    // Another configuration in the file names another provider: the file is pointed at, naming it.
    files.set(propsA, '{ "configurations": [ { "name": "Win32" }, { "name": "Custom", "configurationProvider": "ms-vscode.cmake-tools" } ] }');
    folderSetting.delete(FOLDER_A.uri.toString());
    state.clear();
    messages.length = 0;
    updates.length = 0;
    opened.length = 0;
    prompt = make();
    answer = undefined;
    assert(await prompt.check(cppA) === 'dismissed' && updates.length === 0 && /configuration "Custom" that names "ms-vscode\.cmake-tools"/.test(messages[0].m)
        && /active configuration/.test(messages[0].m) && JSON.stringify(messages[0].buttons) === JSON.stringify(['Open c_cpp_properties.json', "Don't ask again"]),
    `PROMPT: another configuration names another provider → the file is offered, the setting is not promised (${JSON.stringify(messages[0])})`);
    // A near miss is logged; without a log function the check logs to the console.
    files.delete(propsA);
    folderSetting.set(FOLDER_A.uri.toString(), ID.toUpperCase());
    state.clear();
    messages.length = 0;
    const consoleLines = [];
    const realLog = console.log;
    console.log = (l) => consoleLines.push(String(l));
    try {
        prompt = make(null);
        answer = 'Not now';
        await prompt.check(cppA);
    } finally { console.log = realLog; }
    assert(messages.length === 1 && consoleLines.some(l => /is not exactly "a-abushaqra\.twincat-plc-toolkit"/.test(l)),
        `PROMPT: a near-miss id is offered the setting and logged (to the console by default) (${JSON.stringify(consoleLines)})`);
    folderSetting.delete(FOLDER_A.uri.toString());

    if (errors > 0) {
        console.error(`\n${errors} C/C++ provider selection assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll C/C++ provider selection assertions passed.');
})().catch((e) => { console.error(e); process.exit(1); });
