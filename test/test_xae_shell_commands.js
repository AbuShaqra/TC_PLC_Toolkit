/**
 * @file test_xae_shell_commands.js
 * @description The VS Code half of the XAE Shell path settings — src/commands/xaeShellCommands.js —
 * under a recording `vscode` stub with detection faked: an empty setting is filled (user/Global
 * target), a non-empty one is never overwritten, nothing found writes nothing, the activation-time
 * fill is silent and cannot reject, and `twincat.detectXaeShell` reports found / kept / not found in
 * one message whose button opens the settings. Also src/xaeShell.js's `findTwinCatShells`: a
 * configured path wins for the matching shell (4026 ↔ 64-bit, 4024 ↔ 32-bit) and only when it exists.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_xae_shell_'));
const realExe = path.join(ROOT, 'TcXaeShell.exe');
fs.writeFileSync(realExe, '');

// ── A recording `vscode` stub ───────────────────────────────────────────────────────────────────
const settings = { 'twincat.xaeShell.path4024': '', 'twincat.xaeShell.path4026': '' };
const calls = { updates: [], infos: [], errors: [], executed: [] };
const handlers = new Map();
let infoAnswer;
let failUpdates = false;
const vscodeStub = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        getConfiguration: (section) => ({
            get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, `${section}.${key}`) ? settings[`${section}.${key}`] : fallback),
            update: async (key, value, target) => {
                if (failUpdates) throw new Error('settings are read-only');
                calls.updates.push({ key: `${section}.${key}`, value, target });
                settings[`${section}.${key}`] = value;
            }
        })
    },
    window: {
        showInformationMessage: async (m, ...buttons) => { calls.infos.push({ m, buttons }); return infoAnswer; },
        showErrorMessage: async (m) => { calls.errors.push(m); }
    },
    commands: {
        registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() {} }; },
        executeCommand: async (id, ...args) => { calls.executed.push({ id, args }); return handlers.has(id) ? handlers.get(id)(...args) : undefined; }
    }
};
const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.apply(this, arguments);
};

const { registerXaeShellCommands, describeFill } = require('../src/commands/xaeShellCommands');
const { findTwinCatShells } = require('../src/xaeShell');

/** What the faked detection finds next. */
let detected = { '4024': null, '4026': null };
let detectCalls = 0;
let detectThrows = false;
const detect = async () => { detectCalls++; if (detectThrows) throw new Error('detection broke'); return detected; };
const reset = (s4024, s4026) => {
    settings['twincat.xaeShell.path4024'] = s4024;
    settings['twincat.xaeShell.path4026'] = s4026;
    calls.updates.length = 0; calls.infos.length = 0; calls.errors.length = 0; calls.executed.length = 0;
};
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
    const context = { subscriptions: [] };
    const xae = registerXaeShellCommands(context, { detect, platform: 'win32' });
    assert(handlers.has('twincat.detectXaeShell') && context.subscriptions.length === 1, 'twincat.detectXaeShell is registered and disposed with the extension');

    // ── The activation-time fill ────────────────────────────────────────────────────────────────
    detected = { '4024': { path: 'C:\\x86\\TcXaeShell.exe', source: 'registry' }, '4026': { path: 'C:\\x64\\TcXaeShell.exe', source: 'default' } };
    reset('', '');
    let results = await xae.autoFill();
    assert(settings['twincat.xaeShell.path4024'] === 'C:\\x86\\TcXaeShell.exe' && settings['twincat.xaeShell.path4026'] === 'C:\\x64\\TcXaeShell.exe',
        'both empty settings are filled with what was detected');
    assert(calls.updates.length === 2 && calls.updates.every(u => u.target === vscodeStub.ConfigurationTarget.Global), 'they are written to the user settings (ConfigurationTarget.Global)');
    assert(results.every(r => r.status === 'found') && calls.infos.length === 0 && calls.errors.length === 0, 'the activation fill reports found and shows nothing');

    reset(realExe, '');
    results = await xae.autoFill();
    assert(settings['twincat.xaeShell.path4024'] === realExe && calls.updates.length === 1 && calls.updates[0].key === 'twincat.xaeShell.path4026',
        'a non-empty setting is never overwritten; the empty one is still filled');
    assert(results[0].status === 'kept' && results[0].path === realExe && results[0].missing === false && results[1].status === 'found', 'kept (file present) / found');

    reset('Z:\\custom\\TcXaeShell.exe', 'Y:\\other\\TcXaeShell.exe');
    results = await xae.autoFill();
    assert(calls.updates.length === 0 && results.every(r => r.status === 'kept' && r.missing === true),
        'two configured values are both kept, even when the files are not there (flagged missing, not replaced)');

    detected = { '4024': null, '4026': null };
    reset('', '');
    results = await xae.autoFill();
    assert(calls.updates.length === 0 && results.every(r => r.status === 'notFound' && r.path === ''), 'nothing found: nothing is written');
    reset('   ', '');
    detected = { '4024': { path: 'C:\\x86\\TcXaeShell.exe', source: 'default' }, '4026': null };
    results = await xae.autoFill();
    assert(calls.updates.length === 1 && calls.updates[0].key === 'twincat.xaeShell.path4024' && results[1].status === 'notFound',
        'a whitespace-only setting counts as empty; the version that was not found is left alone');

    // Never rejects: a broken detection or an unwritable settings file must not reach activation.
    detectThrows = true;
    reset('', '');
    const realError = console.error;
    const logged = [];
    console.error = (...a) => { logged.push(a.join(' ')); };
    results = await xae.autoFill();
    detectThrows = false;
    failUpdates = true;
    const results2 = await xae.autoFill();
    failUpdates = false;
    console.error = realError;
    assert(Array.isArray(results) && results.length === 0 && Array.isArray(results2) && results2.length === 0 && logged.length === 2 && calls.updates.length === 0,
        'autoFill never rejects: a throwing detection and a failing settings write are logged, not thrown');

    // ── The command ─────────────────────────────────────────────────────────────────────────────
    detected = { '4024': null, '4026': { path: 'C:\\x64\\TcXaeShell.exe', source: 'registry' } };
    reset('', '');
    const before = detectCalls;
    infoAnswer = undefined;
    results = await vscodeStub.commands.executeCommand('twincat.detectXaeShell');
    await tick();
    assert(detectCalls === before + 1 && calls.updates.length === 1 && settings['twincat.xaeShell.path4026'] === 'C:\\x64\\TcXaeShell.exe', 'the command re-runs detection and fills the empty setting');
    assert(calls.infos.length === 1 && /3\.1\.4024: not found/.test(calls.infos[0].m) && /3\.1\.4026: found C:\\x64\\TcXaeShell\.exe/.test(calls.infos[0].m),
        `one message says, per version, what happened (${calls.infos[0] && calls.infos[0].m})`);
    assert(JSON.stringify(calls.infos[0].buttons) === '["Open Settings"]' && !calls.executed.some(c => c.id === 'twincat.openSettings'), 'it offers Open Settings; dismissed, nothing opens');
    assert(Array.isArray(results) && results.length === 2, 'the command returns the per-version results');

    reset('Z:\\custom\\TcXaeShell.exe', '');
    detected = { '4024': { path: 'C:\\x86\\TcXaeShell.exe', source: 'default' }, '4026': null };
    infoAnswer = 'Open Settings';
    await vscodeStub.commands.executeCommand('twincat.detectXaeShell');
    await tick();
    assert(settings['twincat.xaeShell.path4024'] === 'Z:\\custom\\TcXaeShell.exe' && calls.updates.length === 0, 'the command does not overwrite a configured value either');
    assert(/3\.1\.4024: kept your value Z:\\custom\\TcXaeShell\.exe \(that file does not exist\)/.test(calls.infos[0].m) && /3\.1\.4026: not found/.test(calls.infos[0].m),
        `kept your value / not found (${calls.infos[0].m})`);
    const opened = calls.executed.find(c => c.id === 'twincat.openSettings');
    assert(!!opened && opened.args[0] === 'twincat.xaeShell', 'the Open Settings button opens the settings filtered to twincat.xaeShell');

    detectThrows = true;
    reset('', '');
    await vscodeStub.commands.executeCommand('twincat.detectXaeShell');
    detectThrows = false;
    assert(calls.errors.length === 1 && calls.infos.length === 0, 'a failure of the command is reported, not thrown');

    assert(/Detection runs on Windows only\.$/.test(describeFill([{ id: '4024', version: '3.1.4024', status: 'notFound', path: '' }], 'linux'))
        && !/Windows only/.test(describeFill([{ id: '4024', version: '3.1.4024', status: 'notFound', path: '' }], 'win32')),
        'off Windows the message says detection is Windows-only');

    // ── Update Library Definitions' discovery honours the settings ──────────────────────────────
    // Off Windows nothing is installed, so only a configured, existing path can produce a shell.
    if (process.platform !== 'win32') {
        assert(findTwinCatShells().length === 0 && findTwinCatShells({}).length === 0, 'with no configured path, discovery is what it was (nothing here)');
        let shells = findTwinCatShells({ path4026: realExe });
        assert(shells.length === 1 && shells[0].id === 'x64' && shells[0].progId === 'TcXaeShell.DTE.17.0' && shells[0].exePath === realExe,
            'path4026 names the 64-bit shell (DTE.17.0)');
        shells = findTwinCatShells({ path4024: realExe });
        assert(shells.length === 1 && shells[0].id === 'x86' && shells[0].progId === 'TcXaeShell.DTE.15.0' && shells[0].exePath === realExe,
            'path4024 names the 32-bit shell (DTE.15.0)');
        assert(findTwinCatShells({ path4024: path.join(ROOT, 'gone.exe'), path4026: '' }).length === 0, 'a configured path that does not exist is ignored');
    } else {
        console.log('[SKIP] findTwinCatShells off-Windows checks (this is Windows: a real shell may be installed)');
    }

    fs.rmSync(ROOT, { recursive: true, force: true });
    if (errors) {
        console.error(`\n${errors} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll XAE shell command tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
