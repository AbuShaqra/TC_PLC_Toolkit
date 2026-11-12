/**
 * @file test_gpp_commands.js
 * @description The VS Code half of the g++ path setting (src/commands/gppCommands.js, R13) under a
 * recording `vscode` stub with detection faked: an empty `tcToolkit.compiler.gppPath` is filled
 * (user/Global target), a value the user set is never overwritten, nothing found writes nothing,
 * the silent fill cannot reject, and `twincat.detectGpp` says what happened with a button that opens
 * the setting.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_gpp_cmd_'));
const settings = {};
const calls = { updates: [], infos: [], warnings: [], errors: [], executed: [] };
const handlers = new Map();
let answer;
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
        showInformationMessage: async (m, ...buttons) => { calls.infos.push({ m, buttons }); return answer; },
        showWarningMessage: async (m, ...buttons) => { calls.warnings.push({ m, buttons }); return answer; },
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

const { registerGppCommands, describeGppFill } = require('../src/commands/gppCommands');
const KEY = 'tcToolkit.compiler.gppPath';
const settle = () => new Promise(r => setTimeout(r, 5));

(async () => {
    let hit = { path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default' };
    const context = { subscriptions: [] };
    const gpp = registerGppCommands(context, { detect: () => hit });
    assert(handlers.has('twincat.detectGpp'), 'REGISTER: twincat.detectGpp');

    let r = await gpp.autoFill();
    assert(r.status === 'found' && settings[KEY] === hit.path && calls.updates.length === 1 && calls.updates[0].target === 1,
        'FILL: an empty setting is filled with the detected g++, in the user settings');
    hit = { path: '/usr/bin/g++', source: 'path' };
    r = await gpp.autoFill();
    assert(r.status === 'kept' && settings[KEY] === 'C:\\msys64\\ucrt64\\bin\\g++.exe' && calls.updates.length === 1 && r.missing === true,
        'FILL: a value already set is never overwritten (and is reported missing when it is not a file here)');
    settings[KEY] = 'g++';
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.missing === false, 'FILL: a bare command name is kept and not called missing (it is looked up on PATH)');
    const real = path.join(ROOT, 'g++');
    fs.writeFileSync(real, '');
    settings[KEY] = real;
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.missing === false, 'FILL: an existing path is kept');
    settings[KEY] = '';
    hit = null;
    r = await gpp.autoFill();
    assert(r.status === 'notFound' && settings[KEY] === '' && calls.updates.length === 1, 'FILL: nothing found writes nothing');
    failUpdates = true;
    hit = { path: '/x/g++' };
    const quiet = console.error;
    console.error = () => {};
    r = await gpp.autoFill();
    console.error = quiet;
    assert(r === null, 'FILL: the silent fill never rejects');
    failUpdates = false;

    // The command: says what happened, and its button opens the setting.
    hit = { path: '/opt/gcc/bin/g++', source: 'path' };
    answer = 'Open Setting';
    r = await handlers.get('twincat.detectGpp')();
    await settle();
    assert(r.status === 'found' && calls.infos.length === 1 && calls.infos[0].m === 'g++ found: /opt/gcc/bin/g++' && calls.infos[0].buttons.join() === 'Open Setting',
        'COMMAND: "g++ found: <path>", with Open Setting');
    assert(calls.executed.some(e => e.id === 'twincat.openSettings' && e.args[0] === KEY), 'COMMAND: Open Setting opens tcToolkit.compiler.gppPath');
    settings[KEY] = '';
    hit = null;
    answer = undefined;
    r = await handlers.get('twincat.detectGpp')();
    assert(r.status === 'notFound' && calls.warnings.length === 1 && /not found on PATH or in the usual install folders/.test(calls.warnings[0].m),
        'COMMAND: nothing found is a warning that says where it looked');
    assert(describeGppFill({ status: 'kept', path: 'D:\\g++.exe', missing: true }) === 'g++: kept your value D:\\g++.exe (that file does not exist).', 'COMMAND: the kept message');

    fs.rmSync(ROOT, { recursive: true, force: true });
    if (errors > 0) {
        console.error(`\n${errors} g++ command assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll g++ command assertions passed.');
})().catch((e) => { console.error(e); process.exit(1); });
