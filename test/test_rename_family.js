/**
 * @file test_rename_family.js
 * @description R7: a Method/Property rename reaches every implementor of a shared interface method
 * (and every override of a shared base method), not just the pairwise relatives Find References
 * reports — and nothing that merely shares the name.
 *
 * Before R7, renaming `FB_A.Start` (FB_A IMPLEMENTS I_Drive) renamed `I_Drive.Start` but left
 * `FB_B.Start` (FB_B IMPLEMENTS I_Drive too) alone, so TwinCAT XAE reported FB_B as no longer
 * implementing the interface. The fixtures are real TwinCAT XML through the production path
 * (xmlIndexer + readStForFile), and the occurrences are then applied with renameEngine exactly as the
 * rename command does, so the test covers the structural Method-Name rewrites as well as the query.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { indexXmlFile } = require('../src/lsp/xmlIndexer');
const { provideReferencesForSymbol } = require('../src/lsp/features');
const { memberRenameFamily, pousRelated } = require('../src/lsp/features/references');
const { findConfigReferencesForSymbol } = require('../src/lsp/features/configReferences');
const { applyReferenceEditsToXml } = require('../src/renameEngine');
const { renameComponentInXml, parseTwinCatXml } = require('../src/xmlParser');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

let idSeq = 0;
const guid = () => `{f0000000-0000-4a00-8a00-${String(++idSeq).padStart(12, '0')}}`;

/** A method element; `body` null makes an interface (declaration-only) method. */
function method(name, body) {
    const impl = body === null ? '' : `
      <Implementation>
        <ST><![CDATA[${body}]]></ST>
      </Implementation>`;
    return `
    <Method Name="${name}" Id="${guid()}">
      <Declaration><![CDATA[METHOD ${name} : BOOL
]]></Declaration>${impl}
    </Method>`;
}

/** A property element with a Get accessor (or declaration-only for an interface). */
function property(name, isItf) {
    const get = isItf
        ? `
      <Get Name="Get" Id="${guid()}">
        <Declaration><![CDATA[]]></Declaration>
      </Get>`
        : `
      <Get Name="Get" Id="${guid()}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[${name} := 1;]]></ST>
        </Implementation>
      </Get>`;
    return `
    <Property Name="${name}" Id="${guid()}">
      <Declaration><![CDATA[PROPERTY ${name} : INT
]]></Declaration>${get}
    </Property>`;
}

function itf(name, members, ext) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <Itf Name="${name}" Id="${guid()}">
    <Declaration><![CDATA[INTERFACE ${name}${ext ? ' EXTENDS ' + ext : ''}
]]></Declaration>${members.join('')}
  </Itf>
</TcPlcObject>`;
}

function fb(name, header, members, decl, body) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="${name}" Id="${guid()}" SpecialFunc="None">
    <Declaration><![CDATA[${header}
${decl || 'VAR\n\tn : INT;\nEND_VAR'}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${body || 'n := n + 1;'}]]></ST>
    </Implementation>${members.join('')}
  </POU>
</TcPlcObject>`;
}

// The family of Start: I_Drive and I_Aux (FB_C implements both) and everything deriving from them.
// Outside it: FB_X (same name, no relation), FB_Y (implements an UNRELATED interface with a Start),
// and Stop (a different method of the same interface).
const files = {
    'I_Drive.TcIO': itf('I_Drive', [method('Start', null), method('Stop', null), property('Speed', true)]),
    'I_Aux.TcIO': itf('I_Aux', [method('Start', null)]),
    'I_Other.TcIO': itf('I_Other', [method('Start', null)]),
    'I_DriveEx.TcIO': itf('I_DriveEx', [method('Reset', null)], 'I_Drive'),
    // An interface extending TWO interfaces: its second parent's Start is the same slot.
    'I_Stop2.TcIO': itf('I_Stop2', [method('Start', null)]),
    'I_Combo.TcIO': itf('I_Combo', [method('Halt', null)], 'I_Other2, I_Stop2'),
    'I_Other2.TcIO': itf('I_Other2', [method('Halt2', null)]),
    'FB_G.TcPOU': fb('FB_G', 'FUNCTION_BLOCK FB_G IMPLEMENTS I_Combo',
        [method('Start', 'Start := TRUE;'), method('Halt', 'Halt := TRUE;'), method('Halt2', 'Halt2 := TRUE;')]),
    'FB_A.TcPOU': fb('FB_A', 'FUNCTION_BLOCK FB_A IMPLEMENTS I_Drive',
        [method('Start', 'Start := TRUE;'), method('Stop', 'Stop := TRUE;'), property('Speed')]),
    'FB_B.TcPOU': fb('FB_B', 'FUNCTION_BLOCK FB_B IMPLEMENTS I_Drive',
        [method('Start', 'Start := TRUE;'), method('Stop', 'Stop := TRUE;'), property('Speed')]),
    'FB_C.TcPOU': fb('FB_C', 'FUNCTION_BLOCK FB_C IMPLEMENTS I_Drive, I_Aux',
        [method('Start', 'Start := TRUE;'), method('Stop', 'Stop := TRUE;'), property('Speed')]),
    'FB_E.TcPOU': fb('FB_E', 'FUNCTION_BLOCK FB_E IMPLEMENTS I_Aux', [method('Start', 'Start := TRUE;')]),
    'FB_F.TcPOU': fb('FB_F', 'FUNCTION_BLOCK FB_F IMPLEMENTS I_DriveEx',
        [method('Start', 'Start := TRUE;'), method('Stop', 'Stop := TRUE;'), method('Reset', 'Reset := TRUE;'), property('Speed')]),
    // EXTENDS an implementor without redeclaring Start: inherits it, so its call sites rename.
    'FB_D.TcPOU': fb('FB_D', 'FUNCTION_BLOCK FB_D EXTENDS FB_A', []),
    // EXTENDS a sibling implementor and overrides Start: its declaration renames too.
    'FB_D2.TcPOU': fb('FB_D2', 'FUNCTION_BLOCK FB_D2 EXTENDS FB_B', [method('Start', 'Start := SUPER^.Start();')]),
    'FB_X.TcPOU': fb('FB_X', 'FUNCTION_BLOCK FB_X', [method('Start', 'Start := TRUE;'), property('Speed')]),
    'FB_Y.TcPOU': fb('FB_Y', 'FUNCTION_BLOCK FB_Y IMPLEMENTS I_Other', [method('Start', 'Start := TRUE;')]),
    'PRG_Main.TcPOU': fb('PRG_Main', 'PROGRAM PRG_Main', [], `VAR
	itf : I_Drive;
	aux : I_Aux;
	oth : I_Other;
	fbA : FB_A;
	fbB : FB_B;
	fbC : FB_C;
	fbD : FB_D;
	fbD2 : FB_D2;
	fbE : FB_E;
	fbX : FB_X;
	fbY : FB_Y;
	b : BOOL;
	k : INT;
END_VAR`, `b := itf.Start();
b := aux.Start();
b := fbA.Start();
b := fbB.Start();
b := fbC.Start();
b := fbD.Start();
b := fbD2.Start();
b := fbE.Start();
b := fbX.Start();
b := fbY.Start();
b := oth.Start();
b := fbA.Stop();
k := fbB.Speed;
k := fbX.Speed;`)
};

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_rename_family_'));
const toUri = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
const index = {};
const uris = {};
for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(TEST_DIR, name);
    fs.writeFileSync(filePath, content, 'utf8');
    uris[name] = toUri(filePath);
    indexXmlFile(index, filePath);
}

const inFile = (refs, name) => refs.filter(r => r.uri.endsWith('/' + name)).length;
/** The PRG_Main implementation lines (0-based in the unit) that carry a reference. */
function mainLinesHit(refs) {
    const text = files['PRG_Main.TcPOU'];
    const body = text.slice(text.indexOf('<ST><![CDATA[') + 13, text.indexOf(']]></ST>')).split('\n');
    const hits = new Set();
    // Map back by content: each reference's line in the ST unit is matched against the body lines via
    // the call text it lands on, which keeps this independent of the unit's header line count.
    const main = refs.filter(r => r.uri.endsWith('/PRG_Main.TcPOU'));
    for (const r of main) hits.add(r.range.start.line);
    const lines = [...hits].sort((a, b) => a - b);
    // The body is the last block of the unit, so the offset is the first body line's unit line.
    return { lines, body };
}

// ------------------------------------------------------------------------------------------------
// 1. The family itself.
// ------------------------------------------------------------------------------------------------
console.log('\n--- memberRenameFamily ---');
const famFromA = memberRenameFamily(index['FB_A'] || index['fb_a'], 'Start', index);
const want = ['fb_a', 'fb_b', 'fb_c', 'fb_d', 'fb_d2', 'fb_e', 'fb_f', 'i_drive', 'i_aux', 'i_driveex'];
for (const n of want) assert(famFromA.has(n), `Start family from FB_A contains ${n}`);
for (const n of ['fb_x', 'fb_y', 'i_other', 'prg_main']) assert(!famFromA.has(n), `Start family from FB_A excludes ${n}`);
const famG = memberRenameFamily(Object.values(index).find(x => x && x.name === 'FB_G'), 'Start', index);
assert(famG.has('i_stop2') && famG.has('i_combo'),
    `an interface's SECOND EXTENDS parent is followed (I_Combo EXTENDS I_Other2, I_Stop2; got ${[...famG]})`);
assert(!famG.has('fb_a') && !famG.has('i_drive'), 'and that family stays apart from I_Drive\'s');
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const node = (n) => Object.values(index).find(x => x && x.name === n);
assert(sameSet(famFromA, memberRenameFamily(node('I_Drive'), 'Start', index)),
    'the family is the same when the rename starts from the interface (what a call site `itf.Start()` resolves to)');
assert(sameSet(famFromA, memberRenameFamily(node('FB_D2'), 'Start', index)),
    'the family is the same when the rename starts from an override in a derived sibling');
assert(sameSet(famFromA, memberRenameFamily(node('FB_E'), 'Start', index)),
    'the family is the same when the rename starts from the second interface\'s implementor');
const famY = memberRenameFamily(node('FB_Y'), 'Start', index);
assert(sameSet(famY, new Set(['fb_y', 'i_other'])), `an unrelated interface keeps its own family (got ${[...famY]})`);
const famX = memberRenameFamily(node('FB_X'), 'Start', index);
assert(sameSet(famX, new Set(['fb_x'])), `a POU sharing only the name is alone (got ${[...famX]})`);
const famStop = memberRenameFamily(node('FB_A'), 'Stop', index);
assert(!famStop.has('i_aux') && !famStop.has('fb_e'), 'Stop\'s family does not pull in I_Aux (only Start is shared there)');
assert(famStop.has('fb_b') && famStop.has('fb_f'), 'Stop\'s family still holds every I_Drive implementor');
assert(!pousRelated(node('FB_A'), node('FB_B'), index), 'control: FB_A and FB_B are NOT pairwise related (the v1 gap)');

// ------------------------------------------------------------------------------------------------
// 2. The rename query (custom/referencesForSymbol) from FB_A.Start.
// ------------------------------------------------------------------------------------------------
console.log('\n--- referencesForSymbol: FB_A.Start ---');
const res = provideReferencesForSymbol(
    { rootName: 'FB_A', fileUri: uris['FB_A.TcPOU'], member: { kind: 'Method', name: 'Start' } }, index);
assert(res.resolved === true, 'FB_A.Start resolves');
for (const f of ['I_Drive.TcIO', 'I_Aux.TcIO', 'FB_B.TcPOU', 'FB_C.TcPOU', 'FB_E.TcPOU', 'FB_F.TcPOU', 'FB_D2.TcPOU']) {
    assert(inFile(res.references, f) >= 1, `the declaration in ${f} is in the rename set (got ${inFile(res.references, f)})`);
}
for (const f of ['FB_X.TcPOU', 'FB_Y.TcPOU', 'I_Other.TcIO', 'I_DriveEx.TcIO']) {
    assert(inFile(res.references, f) === 0, `nothing in ${f} is in the rename set (got ${inFile(res.references, f)})`);
}
const { lines, body } = mainLinesHit(res.references);
// itf, aux, fbA, fbB, fbC, fbD, fbD2, fbE = 8 calls; fbX, fbY, oth and Stop are not.
assert(lines.length === 8, `8 call sites in PRG_Main are renamed (got ${lines.length})`);
const first = lines.length ? lines[0] : 0;
const hitCalls = lines.map(l => body[l - first]);
assert(JSON.stringify(hitCalls) === JSON.stringify(body.slice(0, 8)),
    `the renamed calls are exactly itf/aux/fbA/fbB/fbC/fbD/fbD2/fbE (got ${JSON.stringify(hitCalls)})`);

console.log('\n--- referencesForSymbol: Property and the negative cases ---');
const speed = provideReferencesForSymbol(
    { rootName: 'FB_A', fileUri: uris['FB_A.TcPOU'], member: { kind: 'Property', name: 'Speed' } }, index);
assert(inFile(speed.references, 'FB_B.TcPOU') >= 1 && inFile(speed.references, 'I_Drive.TcIO') >= 1,
    'a shared interface PROPERTY reaches the sibling implementor and the interface');
assert(inFile(speed.references, 'FB_X.TcPOU') === 0, 'FB_X.Speed (name only) is not in the property rename set');
assert(inFile(speed.references, 'PRG_Main.TcPOU') === 1, `only fbB.Speed in PRG_Main, not fbX.Speed (got ${inFile(speed.references, 'PRG_Main.TcPOU')})`);

const fromX = provideReferencesForSymbol(
    { rootName: 'FB_X', fileUri: uris['FB_X.TcPOU'], member: { kind: 'Method', name: 'Start' } }, index);
for (const f of ['I_Drive.TcIO', 'FB_A.TcPOU', 'FB_B.TcPOU', 'FB_Y.TcPOU']) {
    assert(inFile(fromX.references, f) === 0, `renaming FB_X.Start touches nothing in ${f}`);
}
assert(inFile(fromX.references, 'PRG_Main.TcPOU') === 1, 'renaming FB_X.Start renames only fbX.Start()');

const fromY = provideReferencesForSymbol(
    { rootName: 'FB_Y', fileUri: uris['FB_Y.TcPOU'], member: { kind: 'Method', name: 'Start' } }, index);
assert(inFile(fromY.references, 'I_Other.TcIO') >= 1, 'renaming FB_Y.Start renames its own interface I_Other');
for (const f of ['I_Drive.TcIO', 'I_Aux.TcIO', 'FB_A.TcPOU', 'FB_E.TcPOU']) {
    assert(inFile(fromY.references, f) === 0, `renaming FB_Y.Start touches nothing in ${f}`);
}
assert(inFile(fromY.references, 'PRG_Main.TcPOU') === 2, `renaming FB_Y.Start renames fbY.Start() and oth.Start() only (got ${inFile(fromY.references, 'PRG_Main.TcPOU')})`);

const fromItf = provideReferencesForSymbol(
    { rootName: 'I_Drive', fileUri: uris['I_Drive.TcIO'], member: { kind: 'Method', name: 'Start' } }, index);
assert(inFile(fromItf.references, 'FB_B.TcPOU') >= 1 && inFile(fromItf.references, 'FB_E.TcPOU') >= 1,
    'starting from the interface method reaches every implementor, the second interface\'s too');
assert(inFile(fromItf.references, 'PRG_Main.TcPOU') === 8, `starting from the interface renames the same 8 calls (got ${inFile(fromItf.references, 'PRG_Main.TcPOU')})`);

const action = provideReferencesForSymbol(
    { rootName: 'FB_A', fileUri: uris['FB_A.TcPOU'], member: { kind: 'Method', name: 'Stop' } }, index);
assert(inFile(action.references, 'FB_E.TcPOU') === 0 && inFile(action.references, 'I_Aux.TcIO') === 0,
    'Stop does not reach I_Aux/FB_E');
assert(inFile(action.references, 'FB_B.TcPOU') >= 1, 'Stop reaches the sibling implementor FB_B');

// ------------------------------------------------------------------------------------------------
// 3. Applied as the rename command applies it: every file's XML, structural Method renames included.
// ------------------------------------------------------------------------------------------------
console.log('\n--- applied through renameEngine ---');
const byUri = new Map();
for (const r of res.references) {
    if (r.uri === res.declaration.uri && r.range.start.line === res.declaration.range.start.line
        && r.range.start.character === res.declaration.range.start.character) continue;
    // Keyed by file name: the server may spell the same file's URI differently (drive-letter case, %3A).
    const key = decodeURIComponent(r.uri).split('/').pop();
    if (!byUri.has(key)) byUri.set(key, []);
    byUri.get(key).push({ line: r.range.start.line, character: r.range.start.character });
}
const out = {};
for (const [name, xml] of Object.entries(files)) {
    const occs = byUri.get(name) || [];
    let next = applyReferenceEditsToXml(xml, occs, { oldName: 'Start', newName: 'Begin', propagateDeclRenames: true });
    let text = next.xmlText;
    if (name === 'FB_A.TcPOU' && !next.renamedDeclComponents.some(d => d.componentName === 'Start')) {
        text = renameComponentInXml(text, 'FB_A', 'Method', 'Start', 'Begin');
    }
    out[name] = { text, uncovered: next.skipped.filter(s => !s.coveredByStructuralRename).length };
}
const methodNames = (xml) => (parseTwinCatXml(xml).components || [])
    .filter(c => c.xmlContext && c.xmlContext.subType === 'Method').map(c => c.xmlContext.subName);
for (const f of ['I_Drive.TcIO', 'I_Aux.TcIO', 'FB_A.TcPOU', 'FB_B.TcPOU', 'FB_C.TcPOU', 'FB_E.TcPOU', 'FB_F.TcPOU', 'FB_D2.TcPOU']) {
    const names = methodNames(out[f].text);
    assert(names.includes('Begin') && !names.includes('Start'), `${f}: the Method element is renamed Start -> Begin (got ${names})`);
    assert(/METHOD Begin : BOOL/.test(out[f].text), `${f}: its declaration header reads METHOD Begin`);
    assert(out[f].uncovered === 0, `${f}: no uncovered occurrence`);
}
for (const f of ['FB_X.TcPOU', 'FB_Y.TcPOU', 'I_Other.TcIO', 'I_DriveEx.TcIO', 'FB_D.TcPOU']) {
    assert(out[f].text === files[f], `${f}: byte-identical`);
}
const mainOut = out['PRG_Main.TcPOU'].text;
for (const call of ['itf', 'aux', 'fbA', 'fbB', 'fbC', 'fbD', 'fbD2', 'fbE']) {
    assert(mainOut.includes(`b := ${call}.Begin();`), `PRG_Main: ${call}.Start() -> ${call}.Begin()`);
}
for (const call of ['fbX', 'fbY', 'oth']) {
    assert(mainOut.includes(`b := ${call}.Start();`), `PRG_Main: ${call}.Start() is left alone`);
}
assert(mainOut.includes('b := fbA.Stop();'), 'PRG_Main: Stop is left alone');
assert(mainOut.includes('Start := SUPER^.Start();') === false && out['FB_D2.TcPOU'].text.includes('Begin := SUPER^.Begin();'),
    'FB_D2: the override body (its return variable and SUPER^ call) follows the rename');

// ------------------------------------------------------------------------------------------------
// 4. Visualizations follow the same family (config references).
// ------------------------------------------------------------------------------------------------
console.log('\n--- configuration objects ---');
const gvlPath = path.join(TEST_DIR, 'GVL_Vis.TcGVL');
fs.writeFileSync(gvlPath, `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <GVL Name="GVL_Vis" Id="${guid()}">
    <Declaration><![CDATA[VAR_GLOBAL
	fbB : FB_B;
	fbX : FB_X;
END_VAR]]></Declaration>
  </GVL>
</TcPlcObject>`, 'utf8');
indexXmlFile(index, gvlPath);
const visPath = path.join(TEST_DIR, 'Visu.TcVIS');
fs.writeFileSync(visPath, '﻿<v n="BasicTypeNodeValue">"GVL_Vis.fbB.Speed"</v>\n<v n="BasicTypeNodeValue">"GVL_Vis.fbX.Speed"</v>\n', 'utf8');
const cfg = findConfigReferencesForSymbol(
    { rootName: 'FB_A', fileUri: uris['FB_A.TcPOU'], member: { kind: 'Property', name: 'Speed' } }, index, [visPath]);
assert(cfg.resolved && cfg.occurrences.length === 1 && cfg.occurrences[0].chain === 'GVL_Vis.fbB.Speed',
    `a visualization naming the sibling implementor's property is renamed, the unrelated one is not (got ${JSON.stringify(cfg.occurrences.map(o => o.chain))})`);

fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log(`\n--- RENAME FAMILY TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
