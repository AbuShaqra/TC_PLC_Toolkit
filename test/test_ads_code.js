/**
 * @file test_ads_code.js
 * @description Online monitoring (R15): the code-mismatch guard (src/online/codeIdentity.js) and the
 * `_AppInfo` fields the session reads, checked against the sample's committed `.tmc` — a real XAE
 * build output (TwinCAT 3.1.4024), so the field names and the symbol format are not assumptions.
 *
 * Covers: the `.tmc` symbol table is parsed (name, byte size, base type, arrays); the PLC's
 * `_AppInfo` really has ProjectName, OnlineChangeCnt, AppTimestamp, ActivePlcForces and
 * ActiveIoForces; the layout comparison finds added, missing and resized variables and ignores
 * namespaces the build does not have; the three outcomes of the check (name unreadable / other
 * project: values hidden; no `.tmc`: name only; layout or edits differ: writes blocked) and that it
 * never claims more than it checks.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTmcSymbols, compareLayout, sourcesEditedSince, filesEditedSince, checkCode } = require('../src/online/codeIdentity');
const { APP_INFO } = require('../src/online/session');
const { reportCoverage } = require('./_coverage');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const TMC = path.join(__dirname, '..', 'sample', 'TcToolkitSample', 'TcToolkitSample_PLC', 'TcToolkitSample_PLC.tmc');
if (!fs.existsSync(TMC)) {
    console.log('SKIP: the sample .tmc is missing.');
    reportCoverage('ads-code', 'skipped', 'sample .tmc not present');
    process.exit(0);
}

(async () => {
    const text = fs.readFileSync(TMC, 'utf8');
    const built = parseTmcSymbols(text);
    const s = (n) => built.get(n.toLowerCase());
    assert(s('MAIN.nCycleCount') && s('MAIN.nCycleCount').bytes === 4 && s('MAIN.nCycleCount').baseType === 'UDINT', 'a UDINT is 4 bytes in the last build');
    assert(s('GVL_Hmi.arValues') && s('GVL_Hmi.arValues').array && s('GVL_Hmi.arValues').bytes === 20, 'an ARRAY[0..9] OF INT is an array of 20 bytes');
    assert(s('GVL_System.fbStation') && s('GVL_System.fbStation').baseType === 'FB_Station', 'FB instances are symbols too');
    assert(s('TwinCAT_SystemInfoVarList._AppInfo') && s('TwinCAT_SystemInfoVarList._AppInfo').baseType === 'PlcAppSystemInfo',
        `${APP_INFO} is in the symbol table, of type PlcAppSystemInfo`);
    const appInfoType = /<DataType>\s*<Name[^>]*>PlcAppSystemInfo<\/Name>([\s\S]*?)<\/DataType>/.exec(text);
    const fields = appInfoType ? [...appInfoType[1].matchAll(/<SubItem>\s*<Name>([^<]*)<\/Name>/g)].map(m => m[1]) : [];
    for (const f of ['ProjectName', 'OnlineChangeCnt', 'AppTimestamp', 'ActivePlcForces', 'ActiveIoForces']) {
        assert(fields.includes(f), `PlcAppSystemInfo has ${f} (read by the session)`);
    }

    // ── layout ────────────────────────────────────────────────────────────────────────────────────
    const online = [...built.values()].map(x => ({ name: x.name, type: x.baseType, size: /** @type {number} */ (x.bytes) }));
    assert(compareLayout(built, online).ok, 'the build against an identical PLC: no difference');
    assert(compareLayout(built, online.concat([{ name: 'Tc2_System.SomeLibVar', type: 'INT', size: 2 }])).ok,
        'a PLC symbol in a namespace the build does not have is not counted');
    const added = compareLayout(built, online.concat([{ name: 'MAIN.nNew', type: 'INT', size: 2 }]));
    assert(!added.ok && /MAIN\.nNew is on the PLC but not in the last build/.test(added.differences[0]), 'a variable added on the PLC is found');
    const missing = compareLayout(built, online.filter(x => x.name !== 'MAIN.nIdx'));
    assert(!missing.ok && /MAIN\.nIdx is in the last build but not on the PLC/.test(missing.differences[0]), 'a variable missing on the PLC is found');
    const resized = compareLayout(built, online.map(x => (x.name === 'GVL_System.fbStation' ? { ...x, size: x.size + 8 } : x)));
    assert(!resized.ok && /GVL_System\.fbStation is 168 bytes in the last build but 176 on the PLC/.test(resized.differences[0]),
        'an FB whose size changed (a member added) is found');

    // ── edits since the build ─────────────────────────────────────────────────────────────────────
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_code_'));
    fs.mkdirSync(path.join(dir, 'POUs'));
    fs.mkdirSync(path.join(dir, '_Libraries'));
    const old = path.join(dir, 'POUs', 'MAIN.TcPOU');
    const fresh = path.join(dir, 'POUs', 'FB_A.TcPOU');
    const lib = path.join(dir, '_Libraries', 'X.TcPOU');
    for (const f of [old, fresh, lib]) fs.writeFileSync(f, 'x');
    const t0 = Date.now() / 1000;
    fs.utimesSync(old, t0 - 100, t0 - 100);
    fs.utimesSync(fresh, t0 + 100, t0 + 100);
    fs.utimesSync(lib, t0 + 100, t0 + 100);
    assert(JSON.stringify(sourcesEditedSince(dir, t0 * 1000)) === JSON.stringify([path.join('POUs', 'FB_A.TcPOU')]),
        'a source newer than the build is found; _Libraries is not project source');
    assert(JSON.stringify(filesEditedSince([old, fresh], t0 * 1000, dir)) === JSON.stringify([path.join('POUs', 'FB_A.TcPOU')]),
        'the same for the project\'s compiled object list');

    // ── the check ─────────────────────────────────────────────────────────────────────────────────
    fs.copyFileSync(TMC, path.join(dir, 'Proj.tmc'));
    fs.utimesSync(path.join(dir, 'Proj.tmc'), t0, t0);
    const projects = [{ name: 'Proj', dir, files: [old] }];
    const onlineSymbols = async () => online;
    let c = await checkCode({ projectName: null, projects, onlineSymbols });
    assert(c.state === 'unknown' && !c.showValues, 'no project name from the PLC: not checkable, values hidden');
    c = await checkCode({ projectName: 'Other', projects, onlineSymbols });
    assert(c.state === 'differs' && c.name === 'differs' && !c.showValues && /"Other"/.test(c.reason), 'another project name: differs, values hidden');
    c = await checkCode({ projectName: 'proj', projects: [{ name: 'Proj', dir: path.join(dir, 'nowhere') }], onlineSymbols });
    assert(c.state === 'unknown' && c.name === 'match' && c.showValues && /\.tmc .*missing/.test(c.reason),
        'the name matches (case-insensitively) but there is no .tmc: values shown, writes stay blocked (unknown)');
    c = await checkCode({ projectName: 'Proj', projects, onlineSymbols });
    assert(c.state === 'match' && c.layout === 'match' && c.edits === 'none', 'name, layout and edits all pass: match');
    assert(/a change to code bodies alone cannot be detected/.test(c.reason), 'and even then it says what it cannot detect');
    c = await checkCode({ projectName: 'Proj', projects: [{ name: 'Proj', dir, files: [old, fresh] }], onlineSymbols });
    assert(c.state === 'differs' && c.edits === 'edited' && c.showValues, 'a source edited after the build: differs (writes blocked), values still shown');
    c = await checkCode({ projectName: 'Proj', projects, onlineSymbols: async () => online.slice(1) });
    assert(c.state === 'differs' && c.layout === 'differs' && c.details.some(d => /variable layout differs/.test(d)), 'a layout difference: differs, with the details');
    c = await checkCode({ projectName: 'Proj', projects, onlineSymbols: async () => { throw new Error('upload failed'); } });
    assert(c.state === 'unknown' && c.layout === 'unknown', 'a failed symbol upload is not a match');

    reportCoverage('ads-code', 'ran');
    if (errors) { console.error(`\n${errors} code-check assertion(s) failed`); process.exit(1); }
    console.log('\nAll code-check assertions passed.');
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
