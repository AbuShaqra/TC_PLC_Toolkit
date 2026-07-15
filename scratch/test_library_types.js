/**
 * @file test_library_types.js
 * @description Structured library types from the project's `.tmc` — and the conservatism that must
 * survive them.
 *
 * What changed, and why it is dangerous. Library symbols used to be a flat set of *names*: an
 * external node had no kind and no members, `typeFromNode()` mapped it to the anonymous `unknown`,
 * and an unknown type is never member-checked. That anonymity is why the sample sits at zero
 * diagnostics. The `.tmc` (TwinCAT's type-system export, plain XML) actually carries real structure
 * for the types the project uses — 251 structs/FBs with `<SubItem>` fields, 82 enums with
 * `<EnumInfo>` members — so those types can now complete with their real fields.
 *
 * The trap: give a library node real members and let it resolve to a concrete `struct`/`fb`/`enum`,
 * and `checkMemberAccess` starts flagging every member it cannot find — but the `.tmc` only covers
 * what the project uses, holds `<DataType>` blocks only (no constants, no functions), and its member
 * lists are not guaranteed exhaustive. A concrete library kind would therefore manufacture a fresh
 * crop of false positives on correct code, undoing the entire point of the exercise.
 *
 * So the contract this harness enforces is: **enrich completion, keep diagnostics silent.**
 *   - `membersComplete: false` on every library node; `lookupMember()` answers `undefined`
 *     ("cannot be sure") and never `null` ("definitely absent") for one — §4;
 *   - a member type derived from a library type is tagged `external`, so `isAssignable` returns 'ok'
 *     on sight and no type-mismatch can be invented from a `.tmc` description we got slightly wrong;
 *   - the same must NOT over-suppress: an absent member of a *project* struct is still flagged — §4;
 *   - the sample stays at exactly 0 diagnostics, under the default config AND with the two opt-in
 *     checks (`declarationTypes`, `typeCompatibility`) forced on — §5. That is the hard gate.
 *
 * Needs the real sample project and its `.tmc` (both git-ignored); skips cleanly when absent.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideCompletions, provideDiagnostics, setDiagnosticsConfig } = require('../src/lsp/features');
const { resolveSymbolType, lookupMember, typeFromNode, parseTypeString, isAssignable } = require('../src/lsp/types');
const { getLibraryType, getTypeSystemNamespaceTypes, getNamespaceSymbols } = require('../src/lsp/libsymbols');
const {
    SAMPLE_DIR,
    indexSampleLibraries,
    printBaselineMode,
    syncDocument,
    walkTwinCatFiles
} = require('./_baseline');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ---------------------------------------------------------------------------------------------
// Skip cleanly without the sample project or its .tmc — both are git-ignored build artifacts.
// ---------------------------------------------------------------------------------------------

/** True when a `.tmc` exists anywhere under the sample project. */
function hasTmc(dir, depth = 0) {
    if (depth > 4 || !fs.existsSync(dir)) return false;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (e.name.toLowerCase() === '_libraries') continue;
            if (hasTmc(path.join(dir, e.name), depth + 1)) return true;
        } else if (/\.tmc$/i.test(e.name)) {
            return true;
        }
    }
    return false;
}

if (!fs.existsSync(SAMPLE_DIR) || !hasTmc(SAMPLE_DIR)) {
    console.log('\n=== LIBRARY TYPES ===');
    console.log('  skip  sample/ or its .tmc is not present — no type system to harvest.');
    console.log('\n--- LIBRARY TYPE TESTS SKIPPED ---');
    process.exit(0);
}

const modeInfo = indexSampleLibraries(SAMPLE_DIR);
printBaselineMode(modeInfo);

// ---------------------------------------------------------------------------------------------
// A synthetic document that uses the library types, in the workspace of the real library index.
// ---------------------------------------------------------------------------------------------

let uid = 0;
const guid = () => `{00000000-0000-0000-0000-${String(++uid).padStart(12, '0')}}`;

const tcpou = (name, decl, impl) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="${guid()}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl || ''}]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;

const tcdut = (name, decl) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <DUT Name="${name}" Id="${guid()}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </DUT>
</TcPlcObject>`;

// A project struct, so the "still flags a real absence" assertion has something honest to flag.
const ST_LOCAL_XML = tcdut('ST_Local', 'TYPE ST_Local :\nSTRUCT\n\tnSpeed : INT;\n\tbReady : BOOL;\nEND_STRUCT\nEND_TYPE');

// Every caret under test lives in this one POU. `MC_Home` is deliberate: it is in the library
// archives (32k names) but has NO <DataType> block in the .tmc — the "known name, unknown shape"
// case that must still behave.
const MAIN_DECL = [
    'PROGRAM MAIN',
    'VAR',
    '\tstAxis : Tc2_MC2.ST_AxisStatus;',   // qualified — the way the sample really writes it
    '\tfbPower : MC_Power;',               // bare
    '\tstTime : TIMESTRUCT;',
    '\tfbHome : MC_Home;',                 // in the archives, NOT in the .tmc
    '\tstLocal : ST_Local;',               // a project struct
    '\teState : E_EthercatDeviceState;',
    '\tnCount : INT;',
    'END_VAR'
].join('\n');

const MAIN_IMPL = [
    'nCount := stAxis.NoSuchField;',       // absent on a LIBRARY type  -> must stay silent
    'nCount := stLocal.NoSuchField;',      // absent on a PROJECT type  -> must still be flagged
    'nCount := stAxis.CycleCounter;',      // present on a library type -> silent
    'fbPower(Enable := TRUE, NoSuchParam := 1);',  // named arg on a library FB -> never flagged
    'stAxis.',
    'fbPower.',
    'stTime.',
    'fbHome.',
    'MC_Power.',
    'ST_AxisStatus.',
    'TIMESTRUCT.',
    'E_EthercatDeviceState.',
    'stLocal.'
].join('\n');

const MAIN_XML = tcpou('MAIN', MAIN_DECL, MAIN_IMPL);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_libtypes_'));
const uriOf = (f) => 'file:///' + path.join(dir, f).replace(/\\/g, '/');
const MAIN_URI = uriOf('MAIN.TcPOU');

/** Builds the workspace index the way server.js does, and returns the active unit's ST. */
function buildWorkspace() {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    indexXmlObject(index, ST_LOCAL_XML, uriOf('ST_Local.TcDUT'));
    indexXmlObject(index, MAIN_XML, MAIN_URI);
    const { stText } = convertXmlToSt(parseTwinCatXml(MAIN_XML), { raw: true });
    syncDocument(index, stText, MAIN_URI);   // parseAndIndexDocument + registerLibrarySymbolNodes
    return { index, stText };
}

/** Completions with the caret immediately behind the first occurrence of `marker`. */
function completionsAt(marker) {
    const { index, stText } = buildWorkspace();
    const lines = stText.split('\n');
    const line = lines.findIndex(l => l.trim() === marker || l.includes(marker));
    if (line === -1) throw new Error(`test bug: no ST line contains "${marker}"`);
    const character = lines[line].indexOf(marker) + marker.length;
    return provideCompletions(stText, { line, character }, index, MAIN_URI) || [];
}

const labels = (items) => items.map(i => i.label);
const has = (items, label) => labels(items).some(l => l.toLowerCase() === String(label).toLowerCase());
const detailOf = (items, label) => (items.find(i => i.label.toLowerCase() === label.toLowerCase()) || {}).detail;

const counts = {};
const record = (name, items) => { counts[name] = items.length; return items; };

try {
    // ---- 1. The .tmc harvest carries real structure ---------------------------------------------
    console.log('=== 1. `.tmc` type structure ===');

    const info = getLibraryType('PlcAppSystemInfo');
    assert(!!info && info.kind === 'struct',
        `PlcAppSystemInfo is harvested as a struct (${info ? info.kind : 'MISSING'})`);
    // The brief's verified example — names AND types, not just names.
    const first5 = (info ? info.members.slice(0, 5) : []).map(m => `${m.name} : ${m.type}`);
    assert(first5.join(', ') === 'ObjId : OTCID, TaskCnt : UDINT, OnlineChangeCnt : UDINT, ' +
        'Flags : DWORD, AdsPort : UINT',
        `its members carry real field names and field types (${first5.join(', ')})`);

    const power = getLibraryType('MC_Power');
    assert(!!power && power.kind === 'fb' && power.namespace === 'Tc2_MC2',
        `MC_Power is an FB of Tc2_MC2 (${power ? power.kind + '/' + power.namespace : 'MISSING'})`);
    assert(power.members.some(m => m.name === 'Enable' && m.scope === 'VAR_INPUT') &&
        power.members.some(m => m.name === 'Status' && m.scope === 'VAR_OUTPUT') &&
        power.members.some(m => m.name === 'Axis' && m.scope === 'VAR_IN_OUT'),
        'an FB\'s call parameters keep their direction (ItemType -> VAR_INPUT/OUTPUT/IN_OUT)');
    assert(power.members.find(m => m.name === 'Axis').type === 'REFERENCE TO AXIS_REF',
        `and their ST wrappers (Axis : ${power.members.find(m => m.name === 'Axis').type})`);

    const dev = getLibraryType('E_EthercatDeviceState');
    assert(!!dev && dev.kind === 'enum' && dev.members.every(m => m.scope === 'ENUM'),
        `E_EthercatDeviceState is harvested as an enum (${dev ? dev.members.length : 0} members)`);

    const arrayOwner = getLibraryType('ST_DMSCalibrationArrays');
    const arrayMember = arrayOwner && arrayOwner.members.find(m => m.name === 'aAppliedForceX');
    assert(!!arrayMember && arrayMember.type === 'ARRAY [1..17] OF INT',
        `<ArrayInfo> becomes a real ARRAY type (${arrayMember ? arrayMember.type : 'MISSING'})`);

    // A library symbol the .tmc says nothing about keeps its old, shapeless self.
    assert(getLibraryType('MC_Home') === undefined,
        'MC_Home is in the archives but not the .tmc — no structure is invented for it');

    // ---- 2. Member completion on library types --------------------------------------------------
    console.log('\n=== 2. member completion ===');

    const cPower = record('MC_Power.', completionsAt('MC_Power.'));
    assert(has(cPower, 'Enable') && has(cPower, 'Status') && has(cPower, 'Busy') && has(cPower, 'Axis'),
        `MC_Power.▮ completes with its real parameters (${cPower.length} items)`);
    assert(/Input\s*:\s*BOOL/.test(detailOf(cPower, 'Enable') || ''),
        `…labelled with direction and type (Enable -> "${detailOf(cPower, 'Enable')}")`);

    const cStatus = record('ST_AxisStatus.', completionsAt('ST_AxisStatus.'));
    assert(has(cStatus, 'MotionState') && has(cStatus, 'CycleCounter') && has(cStatus, 'ErrorID'),
        `ST_AxisStatus.▮ completes with its real fields (${cStatus.length} items)`);

    const cTime = record('TIMESTRUCT.', completionsAt('TIMESTRUCT.'));
    assert(cTime.length === 8 && has(cTime, 'wYear') && has(cTime, 'wMilliseconds'),
        `TIMESTRUCT.▮ completes with its 8 fields (${cTime.length} items)`);

    const cEnum = record('E_EthercatDeviceState.', completionsAt('E_EthercatDeviceState.'));
    assert(has(cEnum, 'INIT') && has(cEnum, 'PREOP') && has(cEnum, 'SAFEOP') && has(cEnum, 'OP'),
        `E_EthercatDeviceState.▮ completes with its enum members (${cEnum.length} items)`);
    assert(cEnum.every(i => i.kind === 20),
        'every one of them is an EnumMember item, not a field');

    // Through an *instance*, and through a namespace-qualified declaration — how real code writes it.
    const cInst = record('stAxis. (instance)', completionsAt('stAxis.'));
    assert(has(cInst, 'MotionState') && has(cInst, 'CycleCounter'),
        `an instance of a qualified library type completes too (stAxis : Tc2_MC2.ST_AxisStatus, ` +
        `${cInst.length} items)`);
    const cInstFb = record('fbPower. (instance)', completionsAt('fbPower.'));
    assert(has(cInstFb, 'Enable') && has(cInstFb, 'Error'),
        `…and an instance of a library FB (${cInstFb.length} items)`);
    const cInstTime = record('stTime. (instance)', completionsAt('stTime.'));
    assert(has(cInstTime, 'wYear'), `…and of a bare library struct (${cInstTime.length} items)`);

    // The unknown-shape case: a name we know, a type we do not. Nothing, and no crash.
    let survived = true;
    let cHome = [];
    try {
        cHome = record('fbHome. (no .tmc)', completionsAt('fbHome.'));
    } catch (e) {
        survived = false;
        console.error('   threw: ' + e.stack);
    }
    assert(survived && cHome.length === 0,
        `MC_Home has no .tmc entry: fbHome.▮ offers nothing and does not crash (${cHome.length} items)`);

    // The project's own types are untouched by all of this.
    const cLocal = record('stLocal. (project)', completionsAt('stLocal.'));
    assert(cLocal.length === 2 && has(cLocal, 'nSpeed') && has(cLocal, 'bReady'),
        `a project struct still completes from its own node (${cLocal.length} items)`);

    // ---- 3. Namespace-qualified caret: the .tmc's real types rank first --------------------------
    console.log('\n=== 3. `Tc2_MC2.▮` ranking ===');

    const mc2Symbols = getNamespaceSymbols('Tc2_MC2');
    const mc2Types = getTypeSystemNamespaceTypes('Tc2_MC2');
    const cNs = record('Tc2_MC2.', completionsAt('stAxis : Tc2_MC2.'));
    const ranked = cNs.filter(i => i.sortText);
    console.log(`    Tc2_MC2.▮ -> ${cNs.length} items ` +
        `(${ranked.length} of them .tmc-known types, ranked first; ${mc2Symbols.length} raw names)`);
    assert(ranked.length === mc2Types.length && ranked.length > 0,
        `every .tmc type of the namespace is ranked first (${ranked.length})`);
    assert(has(cNs, 'ST_AxisStatus') && has(cNs, 'MC_Power') &&
        /Struct/.test(detailOf(cNs, 'ST_AxisStatus') || '') &&
        /Function Block/.test(detailOf(cNs, 'MC_Power') || ''),
        'and carries its true kind (ST_AxisStatus = Struct, MC_Power = Function Block)');
    // Ranking, not filtering: the .tmc only exports what the project already uses, so dropping the
    // rest would hide every Tc2_MC2 type the project has not adopted yet.
    assert(cNs.length > ranked.length,
        `the string-table names are kept, not filtered away (${cNs.length - ranked.length} of them)`);

    // ---- 4. Conservatism: rich completion, silent diagnostics ------------------------------------
    console.log('\n=== 4. member checking stays conservative ===');

    const { index, stText } = buildWorkspace();

    // The type model itself: a library type is now concrete (so completion can use it) but every
    // answer about it is hedged.
    const libNode = index['ST_AxisStatus'];
    assert(!!libNode && libNode.external === true && libNode.membersComplete === false,
        'a .tmc-structured node is external AND declares its member list incomplete');
    const libType = typeFromNode(libNode);
    assert(libType.kind === 'struct' && libType.external === true,
        `typeFromNode gives it a concrete kind, tagged external (${libType.kind}/${libType.external})`);
    assert(lookupMember(libType, 'CycleCounter', index).kind === 'elementary',
        'a member it knows resolves to that member\'s type');
    assert(lookupMember(libType, 'NoSuchField', index) === undefined,
        'a member it does NOT know is "uncertain" (undefined) — never "absent" (null)');
    assert(lookupMember(typeFromNode(index['MC_Power']), 'NoSuchParam', index) === undefined,
        '…the same for a library FB');
    assert(lookupMember(typeFromNode(index['E_EthercatDeviceState']), 'NO_SUCH_STATE', index) === undefined,
        '…and for a library enum');
    // A member type derived from a library type is tagged too, so a `.tmc` description we got wrong
    // can never become a type-mismatch diagnostic.
    assert(isAssignable(parseTypeString('ST_Local', index), libType) === 'ok',
        'isAssignable never flags a library type, whatever it is compared against');

    // The guard against over-suppression: a project struct must still say "definitely absent".
    const projType = resolveSymbolType('stLocal', { pou: index['MAIN'] }, index);
    assert(projType.kind === 'struct' && !projType.external,
        `a project struct is still a plain struct (${projType.kind})`);
    assert(lookupMember(projType, 'NoSuchField', index) === null,
        'and an absent member on it is still "definitely absent" (null) — no over-suppression');

    // End to end, through provideDiagnostics.
    setDiagnosticsConfig({ memberAccess: true, callArguments: true, declarationTypes: true, typeCompatibility: true });
    const diags = provideDiagnostics(stText, index, MAIN_URI);
    setDiagnosticsConfig({ memberAccess: true, callArguments: true, declarationTypes: false, typeCompatibility: true });

    const messages = diags.map(d => d.message);
    assert(!messages.some(m => /NoSuchField.*ST_AxisStatus|not a member of type "ST_AxisStatus"/.test(m)),
        '`stAxis.NoSuchField` produces NO diagnostic — the library type is uncertain, not absent');
    assert(!messages.some(m => /NoSuchParam/.test(m)),
        '`fbPower(NoSuchParam := 1)` produces NO diagnostic — a library FB\'s parameters are partial');
    assert(messages.some(m => /"NoSuchField" is not a member of type "ST_Local"/.test(m)),
        '`stLocal.NoSuchField` IS still flagged — the project type is fully known');
    assert(diags.length === 1,
        `exactly one diagnostic on the probe, and it is the honest one (${diags.length}: ` +
        `${messages.join(' | ') || 'none'})`);

    // ---- 5. THE GATE: the sample stays at 0, in all three configs --------------------------------
    console.log('\n=== 5. sample project: 0 diagnostics in every config ===');

    const CONFIGS = [
        ['default', {}],
        ['declarationTypes:true', { declarationTypes: true }],
        ['typeCompatibility:true', { typeCompatibility: true }]
    ];
    const BASE = { memberAccess: true, callArguments: true, declarationTypes: false, typeCompatibility: true };

    const files = walkTwinCatFiles(SAMPLE_DIR);
    clearWorkspaceIndex();
    const sampleIndex = getWorkspaceSymbolIndex();
    const converted = [];
    for (const file of files) {
        const xml = fs.readFileSync(file, 'utf8');
        const parsed = parseTwinCatXml(xml);
        if (!parsed) continue;
        const fileUri = 'file:///' + file.replace(/\\/g, '/');
        converted.push({ file, fileUri, stText: convertXmlToSt(parsed, { raw: true }).stText });
        indexXmlObject(sampleIndex, xml, fileUri);
    }

    for (const [label, cfg] of CONFIGS) {
        setDiagnosticsConfig(Object.assign({}, BASE, cfg));
        let total = 0;
        const worst = [];
        for (const c of converted) {
            syncDocument(sampleIndex, c.stText, c.fileUri);
            const d = provideDiagnostics(c.stText, sampleIndex, c.fileUri);
            if (d.length) {
                total += d.length;
                worst.push(`${path.relative(SAMPLE_DIR, c.file)}: ${d.map(x => x.message).join(' | ')}`);
            }
        }
        assert(total === modeInfo.baseline,
            `${label.padEnd(23)} -> ${total} diagnostics across ${converted.length} files ` +
            `(baseline ${modeInfo.baseline}, mode ${modeInfo.mode})`);
        worst.slice(0, 5).forEach(w => console.error(`        ${w}`));
    }
    setDiagnosticsConfig(BASE);

    // ---- 6. Cost -------------------------------------------------------------------------------
    console.log('\n=== 6. cost ===');
    console.log(`    indexing: ${modeInfo.ms} ms (archives + .tmc structure), ` +
        `${modeInfo.symbols} symbols, ${modeInfo.tmcFiles} .tmc file(s)`);

    // Only provideCompletions is timed — that is what runs per keystroke. The .tmc structure is
    // parsed once, at index time; a member caret must be a node lookup and a list build, no more.
    const ws = buildWorkspace();
    const wsLines = ws.stText.split('\n');
    const memberLine = wsLines.findIndex(l => l.trim() === 'stAxis.');
    const N = 50;
    const started = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
        provideCompletions(ws.stText, { line: memberLine, character: 7 }, ws.index, MAIN_URI);
    }
    const perCall = Number(process.hrtime.bigint() - started) / 1e6 / N;
    console.log(`    completion: ${perCall.toFixed(2)} ms/call at a member caret (stAxis.▮, ${cInst.length} items)`);
    assert(perCall < 25, `a member caret stays well inside a keystroke's budget (${perCall.toFixed(2)} ms)`);

    console.log('\n=== suggestion counts per caret ===');
    Object.keys(counts).forEach(k => console.log(`    ${k.padEnd(24)} ${counts[k]}`));

} catch (e) {
    console.error(`[FATAL] ${e.stack}`);
    errors++;
} finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir: ignore */ }
}

console.log(`\n--- LIBRARY TYPE TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
