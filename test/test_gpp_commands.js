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
    // The set value is checked the way the build checks it (src/gpp.js checkConfiguredGpp), on a faked machine.
    const BIN = path.join(ROOT, 'bin');
    const machine = {
        platform: 'linux', env: { PATH: BIN },
        exists: (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } },
        isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } },
        version: (p) => machineVersion(p)
    };
    /** The version the faked machine reports for a set g++ (null: unknown). */
    let machineVersion = (_p) => null;
    fs.mkdirSync(BIN, { recursive: true });
    fs.writeFileSync(path.join(BIN, 'g++'), '');
    const gpp = registerGppCommands(context, { detect: () => hit, machine });
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
    assert(r.status === 'kept' && r.missing === false, 'FILL: a bare command name on PATH is kept and not called missing');
    settings[KEY] = 'x86_64-w64-mingw32-g++';
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.missing === true && r.problem === 'not-on-path', 'FILL: a bare command name PATH does not have is kept, and called missing');
    settings[KEY] = `"${path.join(BIN, 'g++')}"`;
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.missing === false, 'FILL: a quoted path (Explorer\'s "Copy as path") is checked without its quotes, as the build does');
    // A value of only quotes (or quoted blanks) is unset for the build and the start page's g++ row
    // (src/gpp.js normalizeGppSetting), so the fill treats it as empty too and fills it.
    for (const blank of ['""', '" "', '  ""  ']) {
        settings[KEY] = blank;
        const before = calls.updates.length;
        r = await gpp.autoFill();
        assert(r.status === 'found' && r.path === hit.path && settings[KEY] === hit.path && calls.updates.length === before + 1,
            `FILL: a setting of only quotes (${JSON.stringify(blank)}) counts as empty and is filled, as the build and the start page see it (${JSON.stringify(r)})`);
    }
    settings[KEY] = BIN;
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.missing === false, 'FILL: a folder that holds g++ works, as it does for the build');
    settings[KEY] = ROOT;
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.missing === true && r.problem === 'folder' && /that folder has no g\+\+ in it/.test(describeGppFill(r)),
        `FILL: a folder with no g++ is called out as such (${describeGppFill(r)})`);
    const real = path.join(ROOT, 'g++');
    fs.writeFileSync(real, '');
    settings[KEY] = real;
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.missing === false, 'FILL: an existing path is kept');
    settings[KEY] = '';
    hit = null;
    const updatesBefore = calls.updates.length;
    r = await gpp.autoFill();
    assert(r.status === 'notFound' && settings[KEY] === '' && calls.updates.length === updatesBefore, 'FILL: nothing found writes nothing');
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
    assert(calls.executed.some(e => e.id === 'twincat.openSettings' && e.args[0] === KEY && e.args[1] && e.args[1].target === 'user'),
        'COMMAND: Open Setting opens tcToolkit.compiler.gppPath in the User settings (machine scope; like the start page\'s Change…)');
    settings[KEY] = '';
    hit = null;
    answer = undefined;
    r = await handlers.get('twincat.detectGpp')();
    assert(r.status === 'notFound' && calls.warnings.length === 1 && /not found on PATH or in the usual install folders/.test(calls.warnings[0].m),
        'COMMAND: nothing found is a warning that says where it looked');
    assert(describeGppFill({ status: 'kept', path: 'D:\\g++.exe', missing: true, problem: 'missing' }) === 'g++: kept your value D:\\g++.exe (that file does not exist). Clear the setting to let it be detected, or correct it.',
        'COMMAND: the kept message for a value that does not work says how to get it detected');
    assert(describeGppFill({ status: 'kept', path: '/usr/bin/g++', missing: false }) === 'g++: kept your value /usr/bin/g++.', 'COMMAND: the kept message for a working value');


    // g++ older than 7: a set value is kept (never overwritten) but said to be too old; a detected
    // one is written only because nothing newer exists, and the message says so.
    settings[KEY] = path.join(BIN, 'g++');
    machineVersion = () => ({ version: '6.3.0', major: 6 });
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.missing === false && r.tooOld === true && r.version === '6.3.0' && settings[KEY] === path.join(BIN, 'g++')
        && /^g\+\+: kept your value .*\. But g\+\+ 6\.3\.0 is too old: the generated C\+\+ needs g\+\+ 7 or later\./.test(describeGppFill(r)),
    `FILL: a set g++ 6 is kept, and called too old (${describeGppFill(r)})`);
    assert(!/Detect g\+\+/.test(describeGppFill(r)) && /clear that setting so the newer g\+\+ is detected/.test(describeGppFill(r)),
        `FILL: a set g++ 6 with nothing newer: the message says to change or clear the setting, not to run "Detect g++" (${describeGppFill(r)})`);
    // A newer g++ is installed while the setting still names the old one: named, never written.
    hit = { path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default', version: '13.2.0' };
    calls.warnings.length = 0;
    const updatesBeforeNewer = calls.updates.length;
    r = await handlers.get('twincat.detectGpp')();
    await settle();
    assert(r.status === 'kept' && r.tooOld === true && settings[KEY] === path.join(BIN, 'g++') && calls.updates.length === updatesBeforeNewer
        && r.newer && r.newer.path === hit.path && calls.warnings.length === 1
        && calls.warnings[0].m.endsWith('A newer g++ 13.2.0 is at C:\\msys64\\ucrt64\\bin\\g++.exe: clear the g++ path setting, or set it to that path.')
        && !/Detect g\+\+/.test(calls.warnings[0].m),
    `COMMAND: a set g++ 6 and a g++ 13 detected: the value is kept, the newer g++ is named (${calls.warnings[0] && calls.warnings[0].m})`);
    hit = { path: path.join(BIN, 'g++'), source: 'path', version: '6.3.0', tooOld: true };
    r = await gpp.autoFill();
    assert(r.status === 'kept' && r.tooOld === true && !r.newer, 'FILL: detection finding only the same old g++ names no newer one');
    machineVersion = () => ({ version: '13.3.0', major: 13 });
    r = await gpp.autoFill();
    assert(r.status === 'kept' && !r.tooOld && r.version === '13.3.0', 'FILL: a set g++ 13 is kept, with its version');
    // The silent fill does not write a g++ 6 (a later install is then detected without clearing anything).
    settings[KEY] = '';
    hit = { path: 'C:\\MinGW\\bin\\g++.exe', source: 'default', version: '6.3.0', tooOld: true };
    const updatesBeforeSilent = calls.updates.length;
    r = await gpp.autoFill();
    assert(r.status === 'tooOldNotFilled' && r.tooOld === true && r.version === '6.3.0' && settings[KEY] === '' && calls.updates.length === updatesBeforeSilent,
        `FILL: the silent fill leaves the setting empty when only a g++ 6 is found (${JSON.stringify(r)})`);
    settings[KEY] = '';
    hit = { path: 'C:\\MinGW\\bin\\g++.exe', source: 'default', version: '6.3.0', tooOld: true };
    calls.warnings.length = 0;
    calls.infos.length = 0;
    r = await handlers.get('twincat.detectGpp')();
    await settle();
    assert(r.status === 'found' && r.tooOld === true && settings[KEY] === hit.path && calls.infos.length === 0 && calls.warnings.length === 1
        && /^g\+\+ found: C:\\MinGW\\bin\\g\+\+\.exe\. But g\+\+ 6\.3\.0 is too old: the generated C\+\+ needs g\+\+ 7 or later\./.test(calls.warnings[0].m),
    `COMMAND: only a g++ 6 found: it is filled in, and the message is a warning saying it is too old (${calls.warnings[0] && calls.warnings[0].m})`);
    assert(!/Detect g\+\+/.test(calls.warnings[0].m) && /clear that setting/.test(calls.warnings[0].m),
        'COMMAND: after writing a g++ 6 the message does not send the user back to "Detect g++"');

    fs.rmSync(ROOT, { recursive: true, force: true });
    if (errors > 0) {
        console.error(`\n${errors} g++ command assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll g++ command assertions passed.');
})().catch((e) => { console.error(e); process.exit(1); });
