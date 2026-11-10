/**
 * @file test_xae_shell_detect.js
 * @description src/xaeShellDetect.js — where the XAE Shell of TwinCAT 3.1.4024 / 3.1.4026 is installed —
 * with every dependency faked, so it runs off Windows: the COM registration (ProgID → CLSID →
 * LocalServer32, quoted and argument-suffixed values, the 32-bit registry view for the 4024 shell), the
 * default locations (environment variables and their fallbacks), a registered file that is missing,
 * registry errors, a non-Windows platform (nothing found, nothing queried), the real `reg.exe` wrapper
 * over a fake `execFile`, the start page's description of the settings, and the choice Update Library
 * Definitions makes between a configured path and its own discovery.
 */

'use strict';

const {
    XAE_SHELL_VERSIONS, REG_TIMEOUT_MS, parseRegDefaultValue, exeFromLocalServer, defaultShellPath,
    detectXaeShells, createRegQuery, describeConfiguredShells, resolveShellExe
} = require('../src/xaeShellDetect');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const CLSID_15 = '{11111111-2222-3333-4444-555555555555}';
const CLSID_17 = '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}';
const DEF_4026 = 'C:\\Program Files\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe';
const DEF_4024 = 'C:\\Program Files (x86)\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe';
const ENV = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };

/** reg.exe's output for a key whose default value is `value`. */
const regOut = (key, value, name = '(Default)') => `\r\n${key.replace(/^HKCR/, 'HKEY_CLASSES_ROOT')}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`;

/**
 * A fake registry: `map` is key → default value. Records every key asked for.
 * @param {Record<string, string>} map
 */
function fakeReg(map) {
    const asked = [];
    const regQuery = async (key) => { asked.push(key); return Object.prototype.hasOwnProperty.call(map, key) ? regOut(key, map[key]) : null; };
    return { regQuery, asked };
}
const existsIn = (...files) => (p) => files.includes(p);

(async () => {
    // ── The version table ───────────────────────────────────────────────────────────────────────
    const byId = Object.fromEntries(XAE_SHELL_VERSIONS.map(v => [v.id, v]));
    assert(JSON.stringify(XAE_SHELL_VERSIONS.map(v => v.id)) === '["4024","4026"]', 'two versions, 4024 then 4026');
    assert(byId['4024'].progId === 'TcXaeShell.DTE.15.0' && byId['4024'].setting === 'twincat.xaeShell.path4024'
        && byId['4024'].clsidRoots[0] === 'HKCR\\WOW6432Node\\CLSID', '4024 is DTE.15.0, registered in the 32-bit view');
    assert(byId['4026'].progId === 'TcXaeShell.DTE.17.0' && byId['4026'].setting === 'twincat.xaeShell.path4026'
        && JSON.stringify(byId['4026'].clsidRoots) === '["HKCR\\\\CLSID"]', '4026 is DTE.17.0, registered in the 64-bit view');

    // ── Parsing ─────────────────────────────────────────────────────────────────────────────────
    assert(parseRegDefaultValue(regOut('HKCR\\X', CLSID_17)) === CLSID_17, 'the (Default) REG_SZ line is parsed');
    assert(parseRegDefaultValue(regOut('HKCR\\X', CLSID_17, '(Standard)')) === CLSID_17, 'a localized value name (German "(Standard)") parses too');
    assert(parseRegDefaultValue('\r\nHKEY_CLASSES_ROOT\\X\r\n    (Default)    REG_SZ    C:\\A B\\TcXaeShell.exe /Embedding\r\n') === 'C:\\A B\\TcXaeShell.exe /Embedding',
        'a value with spaces is kept whole');
    assert(parseRegDefaultValue('ERROR: The system was unable to find the specified registry key or value.') === null
        && parseRegDefaultValue('') === null && parseRegDefaultValue(null) === null && parseRegDefaultValue(undefined) === null,
        'no REG_SZ line (an error text, empty, null) is "no value"');
    assert(exeFromLocalServer(`"${DEF_4026}"`) === DEF_4026, 'a quoted LocalServer32 value loses its quotes');
    assert(exeFromLocalServer(`"${DEF_4026}" /Embedding`) === DEF_4026, 'a quoted value loses trailing arguments');
    assert(exeFromLocalServer(`${DEF_4024} /Embedding`) === DEF_4024, 'an unquoted value with spaces in the path loses trailing arguments');
    assert(exeFromLocalServer(DEF_4024) === DEF_4024, 'a bare path is returned as is');
    assert(exeFromLocalServer('D:\\tools\\TCXAESHELL.EXE -Embedding /x') === 'D:\\tools\\TCXAESHELL.EXE', 'the .exe match ignores case; several arguments are dropped');
    assert(exeFromLocalServer('') === null && exeFromLocalServer('   ') === null && exeFromLocalServer(null) === null, 'an empty registration is nothing');

    // ── Default locations ───────────────────────────────────────────────────────────────────────
    assert(defaultShellPath(byId['4026'], ENV) === DEF_4026 && defaultShellPath(byId['4024'], ENV) === DEF_4024, 'default locations come from the environment');
    assert(defaultShellPath(byId['4026'], {}) === DEF_4026 && defaultShellPath(byId['4024'], {}) === DEF_4024,
        'without the variables they fall back to C:\\Program Files and C:\\Program Files (x86)');
    assert(defaultShellPath(byId['4026'], { PROGRAMFILES: 'D:\\PF\\' }) === 'D:\\PF\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe'
        && defaultShellPath(byId['4024'], { 'programfiles(x86)': 'D:\\PF86' }) === 'D:\\PF86\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe',
        'variable names are matched without regard to case; a trailing separator is not doubled');

    // ── Source 1: the COM registration ──────────────────────────────────────────────────────────
    const custom15 = 'D:\\Beckhoff\\Xae15\\TcXaeShell.exe';
    const custom17 = 'E:\\Xae 17\\Common7\\IDE\\TcXaeShell.exe';
    let reg = fakeReg({
        'HKCR\\TcXaeShell.DTE.15.0\\CLSID': CLSID_15,
        [`HKCR\\WOW6432Node\\CLSID\\${CLSID_15}\\LocalServer32`]: `"${custom15}" /Embedding`,
        'HKCR\\TcXaeShell.DTE.17.0\\CLSID': CLSID_17,
        [`HKCR\\CLSID\\${CLSID_17}\\LocalServer32`]: `${custom17} /Embedding`
    });
    let found = await detectXaeShells({ platform: 'win32', env: ENV, exists: existsIn(custom15, custom17, DEF_4024, DEF_4026), regQuery: reg.regQuery });
    assert(found['4024'] && found['4024'].path === custom15 && found['4024'].source === 'registry', 'the 4024 shell is found through DTE.15.0 in WOW6432Node (quoted, with /Embedding)');
    assert(found['4026'] && found['4026'].path === custom17 && found['4026'].source === 'registry', 'the 4026 shell is found through DTE.17.0 in HKCR\\CLSID (unquoted, with /Embedding)');
    assert(reg.asked.includes(`HKCR\\WOW6432Node\\CLSID\\${CLSID_15}\\LocalServer32`) && !reg.asked.includes(`HKCR\\WOW6432Node\\CLSID\\${CLSID_17}\\LocalServer32`),
        'only the 4024 shell is looked up in the 32-bit view');
    assert(reg.asked[0] === 'HKCR\\TcXaeShell.DTE.15.0\\CLSID', `the ProgID's CLSID is read first (${reg.asked[0]})`);

    // The registration wins over the default location; a registered file that is gone does not.
    found = await detectXaeShells({ platform: 'win32', env: ENV, exists: existsIn(DEF_4024, DEF_4026), regQuery: reg.regQuery });
    assert(found['4024'].path === DEF_4024 && found['4024'].source === 'default' && found['4026'].path === DEF_4026 && found['4026'].source === 'default',
        'a registered file that does not exist is not accepted; the default location is used instead');
    found = await detectXaeShells({ platform: 'win32', env: ENV, exists: existsIn(), regQuery: reg.regQuery });
    assert(found['4024'] === null && found['4026'] === null, 'registered but missing, and no default install: not found');

    // A value that is not a CLSID never becomes part of the next key.
    reg = fakeReg({ 'HKCR\\TcXaeShell.DTE.17.0\\CLSID': 'x\\..\\evil' });
    found = await detectXaeShells({ platform: 'win32', env: ENV, exists: existsIn(), regQuery: reg.regQuery });
    assert(found['4026'] === null && !reg.asked.some(k => k.includes('evil')), 'a ProgID value that is not a braced GUID is ignored');

    // ── Source 2: the default locations ─────────────────────────────────────────────────────────
    reg = fakeReg({});
    found = await detectXaeShells({ platform: 'win32', env: ENV, exists: existsIn(DEF_4026), regQuery: reg.regQuery });
    assert(found['4026'] && found['4026'].path === DEF_4026 && found['4026'].source === 'default' && found['4024'] === null,
        'nothing registered: the 4026 default location is found, 4024 is not');
    found = await detectXaeShells({ platform: 'win32', env: {}, exists: existsIn(DEF_4024), regQuery: reg.regQuery });
    assert(found['4024'] && found['4024'].path === DEF_4024 && found['4026'] === null, 'the 4024 default location is found with no environment variables');
    found = await detectXaeShells({ platform: 'win32', env: { ProgramFiles: 'D:\\PF' }, exists: existsIn(DEF_4026), regQuery: reg.regQuery });
    assert(found['4026'] === null, 'the environment variable, when set, is the location that is checked');

    // ── Errors never escape ─────────────────────────────────────────────────────────────────────
    found = await detectXaeShells({ platform: 'win32', env: ENV, exists: existsIn(DEF_4026), regQuery: async () => { throw new Error('reg.exe exploded'); } });
    assert(found['4026'] && found['4026'].source === 'default' && found['4024'] === null, 'a rejecting registry query means "not found" for that source only');
    found = await detectXaeShells({ platform: 'win32', env: ENV, exists: existsIn(DEF_4026), regQuery: () => { throw new Error('sync throw'); } });
    assert(found['4026'] && found['4026'].source === 'default', 'a synchronously throwing registry query is survived too');
    found = await detectXaeShells({ platform: 'win32', env: ENV, exists: () => { throw new Error('EACCES'); }, regQuery: fakeReg({}).regQuery });
    assert(found['4024'] === null && found['4026'] === null, 'a throwing existence check is "does not exist"');
    found = await detectXaeShells({ platform: 'win32', env: ENV, exists: existsIn(DEF_4024), regQuery: async () => 'garbage with no value line' });
    assert(found['4024'] && found['4024'].source === 'default', 'unparseable reg output falls through to the default location');

    // ── Not Windows ─────────────────────────────────────────────────────────────────────────────
    for (const platform of ['linux', 'darwin']) {
        reg = fakeReg({ 'HKCR\\TcXaeShell.DTE.17.0\\CLSID': CLSID_17 });
        let existsCalls = 0;
        found = await detectXaeShells({ platform, env: ENV, exists: () => { existsCalls++; return true; }, regQuery: reg.regQuery });
        assert(found['4024'] === null && found['4026'] === null && reg.asked.length === 0 && existsCalls === 0,
            `on ${platform} nothing is found, the registry is never queried and no file is probed`);
    }

    // ── The real reg.exe wrapper, over a fake execFile ──────────────────────────────────────────
    const execCalls = [];
    let regQuery = createRegQuery((file, args, options, cb) => { execCalls.push({ file, args, options }); cb(null, regOut('HKCR\\K', 'v')); });
    assert((await regQuery('HKCR\\K')) === regOut('HKCR\\K', 'v'), 'createRegQuery resolves with reg.exe\'s output');
    assert(execCalls.length === 1 && execCalls[0].file === 'reg.exe' && JSON.stringify(execCalls[0].args) === JSON.stringify(['query', 'HKCR\\K', '/ve']),
        'it runs reg.exe query <key> /ve with the key as its own argument (no shell string)');
    assert(execCalls[0].options.timeout === REG_TIMEOUT_MS && REG_TIMEOUT_MS > 0 && REG_TIMEOUT_MS <= 5000 && !execCalls[0].options.shell,
        `with a short timeout and no shell (${REG_TIMEOUT_MS} ms)`);
    regQuery = createRegQuery((file, args, options, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), ''));
    assert((await regQuery('HKCR\\Missing')) === null, 'a failing reg.exe (key absent) resolves null');
    regQuery = createRegQuery(() => { throw new Error('ENOENT'); });
    assert((await regQuery('HKCR\\K')) === null, 'an execFile that throws (no reg.exe) resolves null');

    // ── The settings as the start page shows them ───────────────────────────────────────────────
    const cfg = { path4024: '  ' + DEF_4024 + ' ', path4026: 'Z:\\gone\\TcXaeShell.exe' };
    let rows = describeConfiguredShells((k) => cfg[k], existsIn(DEF_4024));
    assert(rows.length === 2 && rows[0].id === '4024' && rows[0].version === '3.1.4024' && rows[0].path === DEF_4024 && rows[0].exists === true,
        'a configured, existing path is reported (trimmed)');
    assert(rows[1].id === '4026' && rows[1].path === 'Z:\\gone\\TcXaeShell.exe' && rows[1].exists === false, 'a configured path that is not on disk is reported as missing');
    rows = describeConfiguredShells(() => undefined, () => { throw new Error('never called'); });
    assert(rows.every(r => r.path === '' && r.exists === false), 'empty settings are "not found" and probe nothing');
    rows = describeConfiguredShells((k) => (k === 'path4024' ? 42 : 'C:\\x.exe'), () => { throw new Error('EACCES'); });
    assert(rows[0].path === '' && rows[1].path === 'C:\\x.exe' && rows[1].exists === false, 'a non-string setting is empty; a throwing probe is "missing"');

    // ── Update Library Definitions: configured path vs. its own discovery ───────────────────────
    let registryCalls = 0;
    const fromRegistry = (value) => () => { registryCalls++; return value; };
    assert(resolveShellExe({ configured: custom17, defaultPath: DEF_4026, exists: existsIn(custom17, DEF_4026), fromRegistry: fromRegistry('R') }) === custom17
        && registryCalls === 0, 'a configured, existing path wins over the default location, and the registry is not asked');
    assert(resolveShellExe({ configured: custom17, defaultPath: DEF_4026, exists: existsIn(DEF_4026), fromRegistry: fromRegistry('R') }) === DEF_4026
        && registryCalls === 0, 'a configured path that does not exist is ignored: the default location, as before');
    assert(resolveShellExe({ configured: '', defaultPath: DEF_4026, exists: existsIn(DEF_4026), fromRegistry: fromRegistry('R') }) === DEF_4026
        && resolveShellExe({ configured: undefined, defaultPath: DEF_4026, exists: existsIn(DEF_4026), fromRegistry: fromRegistry('R') }) === DEF_4026
        && registryCalls === 0, 'no configured path: the default location, as before');
    assert(resolveShellExe({ configured: '', defaultPath: DEF_4026, exists: existsIn(), fromRegistry: fromRegistry('R:\\reg.exe') }) === 'R:\\reg.exe'
        && registryCalls === 1, 'no configured path and no default install: the registry, as before');
    assert(resolveShellExe({ configured: 'Z:\\gone.exe', defaultPath: DEF_4026, exists: existsIn(), fromRegistry: fromRegistry(null) }) === null,
        'nothing anywhere: not installed');
    assert(resolveShellExe({ configured: 7, defaultPath: DEF_4024, exists: existsIn(DEF_4024), fromRegistry: fromRegistry(null) }) === DEF_4024, 'a non-string setting is treated as unset');

    if (errors) {
        console.error(`\n${errors} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll XAE shell detection tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
