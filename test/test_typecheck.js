/**
 * @file test_typecheck.js
 * @description Semantic type-checking tests. Two independent halves:
 *
 *   1. A **ratchet** on the real /sample project (correct TwinCAT code, so every diagnostic on it is
 *      a false positive; with every external symbol source present it now scores 0). Measured exactly
 *      the way `src/lsp/server.js` does; the recipe and the baseline are shared with
 *      scratch/test_sample_diagnostics.js via scratch/_baseline.js, so the two harnesses cannot
 *      drift. The baseline is **machine-dependent** — `sample/**\/_Libraries` and the project `.tmc`
 *      are git-ignored, so a fresh clone legitimately scores 171. The mode is detected and printed.
 *      Fails on any increase; passes on a decrease.
 *   2. A **strict** "should / should not error" corpus of synthetic probes. These are built on a
 *      self-contained fixture (below), NOT on the sample: they used to reference symbols
 *      (FB_Bin, FB_Conveyor, ST_ProductStatus, E_ConveyorStatus) that exist only in the author's
 *      original private sample, so all of them failed against the sample that ships today. The
 *      fixture makes the corpus portable; the assertions themselves are unchanged and strict.
 */

const fs = require('fs');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideDiagnostics, setDiagnosticsConfig } = require('../src/lsp/features');
const {
    SAMPLE_DIR,
    indexSampleLibraries,
    printBaselineMode,
    syncDocument,
    walkTwinCatFiles
} = require('./_baseline');

const hasSample = fs.existsSync(SAMPLE_DIR);

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

clearWorkspaceIndex();
const index = getWorkspaceSymbolIndex();

// ---- Sample ratchet (skipped cleanly when sample/ is absent) ----
if (!hasSample) {
    console.log('sample/ project not present — skipping the sample ratchet; synthetic probes still run.');
} else {
    // The server's workspace scan: namespace heads from the .plcproj, symbol names from the library
    // archives, types from the .tmc. Which baseline applies depends on which of those (git-ignored)
    // artifacts this machine actually has.
    const modeInfo = indexSampleLibraries(SAMPLE_DIR);
    const BASELINE_DIAGNOSTICS = modeInfo.baseline;
    printBaselineMode(modeInfo);

    const sampleFiles = walkTwinCatFiles(SAMPLE_DIR);
    const sampleSt = {};
    for (const f of sampleFiles) {
        const xml = fs.readFileSync(f, 'utf8');
        const parsed = parseTwinCatXml(xml);
        if (!parsed) continue;
        const uri = 'file:///' + f.replace(/\\/g, '/');
        // raw:true — the non-raw conversion strips declaration-site init lists and hides findings.
        sampleSt[f] = { stText: convertXmlToSt(parsed, { raw: true }).stText, uri };
        indexXmlObject(index, xml, uri);
    }

    console.log(`--- Sample diagnostics ratchet (mode ${modeInfo.mode}, baseline ${BASELINE_DIAGNOSTICS}) ---`);
    let sampleDiagTotal = 0;
    for (const f of sampleFiles) {
        const c = sampleSt[f];
        if (!c) continue;
        // As server.js does: re-parse the unit so methods carry real line ranges, and register the
        // library symbols it references, then diagnose.
        syncDocument(index, c.stText, c.uri);
        const diags = provideDiagnostics(c.stText, index, c.uri);
        if (diags.length) {
            sampleDiagTotal += diags.length;
            const lines = c.stText.split('\n');
            diags.forEach(d => console.log(`   ${path.basename(f)} L${d.range.start.line + 1}: ${d.message}  >> ${(lines[d.range.start.line] || '').trim()}`));
        }
    }
    const delta = sampleDiagTotal - BASELINE_DIAGNOSTICS;
    assert(sampleDiagTotal <= BASELINE_DIAGNOSTICS,
        `sample project stays at or below the ${BASELINE_DIAGNOSTICS}-diagnostic "${modeInfo.mode}" baseline (got ${sampleDiagTotal}, delta ${delta > 0 ? '+' : ''}${delta})`);
    if (sampleDiagTotal < BASELINE_DIAGNOSTICS) {
        console.log(`       IMPROVEMENT: lower the "${modeInfo.mode}" baseline in scratch/_baseline.js to ${sampleDiagTotal} (both harnesses share it).`);
    }
}

// ---- Fixture: the types the synthetic probes are written against ----
// Indexed exactly like project files (indexXmlObject on TwinCAT XML), so the probes see them the
// way the product sees a real workspace object — with real declaration ranges and members.
const FIXTURES = {
    'FB_Bin.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="FB_Bin" Id="{11111111-1111-1111-1111-111111111111}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Bin
VAR
    N_BinID : INT;
    bFull : BOOL;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`,
    'FB_Conveyor.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="FB_Conveyor" Id="{22222222-2222-2222-2222-222222222222}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Conveyor
VAR_INPUT
    fbDestinationBin : FB_Bin;
END_VAR
VAR
    fbCurrentProduct : ST_ProductStatus;
    eStatus : E_ConveyorStatus;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Method Name="cyclic" Id="{33333333-3333-3333-3333-333333333333}">
      <Declaration><![CDATA[METHOD cyclic : BOOL
VAR_INPUT
END_VAR
VAR
END_VAR]]></Declaration>
      <Implementation>
        <ST><![CDATA[eStatus := E_ConveyorStatus.Running;]]></ST>
      </Implementation>
    </Method>
  </POU>
</TcPlcObject>`,
    'ST_ProductStatus.TcDUT': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <DUT Name="ST_ProductStatus" Id="{44444444-4444-4444-4444-444444444444}">
    <Declaration><![CDATA[TYPE ST_ProductStatus :
STRUCT
    byTarget : BYTE;
    iBarcodeID : INT;
END_STRUCT
END_TYPE]]></Declaration>
  </DUT>
</TcPlcObject>`,
    'E_ConveyorStatus.TcDUT': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <DUT Name="E_ConveyorStatus" Id="{55555555-5555-5555-5555-555555555555}">
    <Declaration><![CDATA[{attribute 'qualified_only'}
TYPE E_ConveyorStatus :
(
    Idle := 0,
    Running := 1,
    Faulted := 2
);
END_TYPE]]></Declaration>
  </DUT>
</TcPlcObject>`
};

console.log('\n--- Fixture ---');
for (const [name, xml] of Object.entries(FIXTURES)) {
    const node = indexXmlObject(index, xml, `file:///tmp/_typecheck_fixture/${name}`);
    if (!node) { console.error(`[FAIL] fixture ${name} did not index`); errors++; }
}
assert(!!(index['FB_Bin'] && index['FB_Conveyor'] && index['ST_ProductStatus'] && index['E_ConveyorStatus']),
    'fixture types (FB_Bin, FB_Conveyor, ST_ProductStatus, E_ConveyorStatus) are indexed');

/**
 * Builds a throwaway POU on top of the indexed fixture and returns its diagnostics.
 * The POU is registered under a temp URI so it can reference the fixture types.
 */
let probeCounter = 0;
function diagnose(stText) {
    // Unique URI per probe so the active-POU lookup never picks up a previous probe's node.
    const uri = `file:///tmp/_TypeCheckProbe_${probeCounter++}.st`;
    parseAndIndexDocument(stText, uri);
    return provideDiagnostics(stText, index, uri);
}

function messages(diags) { return diags.map(d => d.message); }

// ---- Phase A: member-access validation ----
console.log('\n--- Phase A: member access ---');
{
    // Valid member access through an FB instance + struct + enum should NOT error.
    const ok = `FUNCTION_BLOCK FB_Probe
VAR
    fbBin : FB_Bin;
    prod : ST_ProductStatus;
    st : E_ConveyorStatus;
END_VAR
fbBin.N_BinID := 1;
prod.byTarget := 0;
st := E_ConveyorStatus.Running;
END_FUNCTION_BLOCK`;
    const d = diagnose(ok);
    assert(d.length === 0, `valid member access produces no diagnostics (got ${JSON.stringify(messages(d))})`);
}
{
    // Invalid members should be flagged.
    const bad = `FUNCTION_BLOCK FB_Probe2
VAR
    fbBin : FB_Bin;
    prod : ST_ProductStatus;
END_VAR
fbBin.NoSuchField := 1;
prod.alsoMissing := 2;
st := E_ConveyorStatus.NotAValue;
END_FUNCTION_BLOCK`;
    const d = diagnose(bad);
    const msgs = messages(d);
    assert(msgs.some(m => m.includes('NoSuchField') && m.includes('not a member')), `flags FB member typo (got ${JSON.stringify(msgs)})`);
    assert(msgs.some(m => m.includes('alsoMissing') && m.includes('ST_ProductStatus')), `flags struct field typo`);
    assert(msgs.some(m => m.includes('NotAValue') && m.includes('E_ConveyorStatus')), `flags invalid enum member`);
}
{
    // Members of unknown/library types must NOT be flagged (conservative).
    const lib = `FUNCTION_BLOCK FB_Probe3
VAR
    fbTimer : TON;
    fbUnknown : ST_NotIndexed;
END_VAR
fbTimer.Q := FALSE;
fbUnknown.whatever := 1;
END_FUNCTION_BLOCK`;
    const d = diagnose(lib).filter(x => x.message.includes('not a member'));
    assert(d.length === 0, `members of library/unknown types are not flagged (got ${JSON.stringify(messages(d))})`);
}

// ---- Phase B: call-argument validation ----
console.log('\n--- Phase B: call arguments ---');
{
    // FB_Conveyor.cyclic has VAR_INPUT (empty); FB has fbDestinationBin as VAR_INPUT.
    // Valid: calling the FB instance with its real input; calling a method with no args.
    const ok = `FUNCTION_BLOCK FB_CallOk
VAR
    fbConv : FB_Conveyor;
    fbBin : FB_Bin;
END_VAR
fbConv.cyclic();
fbConv(fbDestinationBin := fbBin);
END_FUNCTION_BLOCK`;
    const d = diagnose(ok).filter(x => x.message.includes('not a parameter'));
    assert(d.length === 0, `valid call arguments produce no diagnostics (got ${JSON.stringify(messages(d))})`);
}
{
    const bad = `FUNCTION_BLOCK FB_CallBad
VAR
    fbConv : FB_Conveyor;
    fbBin : FB_Bin;
END_VAR
fbConv(notAParam := fbBin);
fbConv.cyclic(bogusArg := 1);
END_FUNCTION_BLOCK`;
    const d = diagnose(bad);
    const msgs = messages(d);
    assert(msgs.some(m => m.includes('notAParam') && m.includes('not a parameter')), `flags unknown FB call parameter (got ${JSON.stringify(msgs)})`);
    assert(msgs.some(m => m.includes('bogusArg')), `flags unknown method call parameter`);
}
{
    // Calls to library / unknown callees must not be validated.
    const lib = `FUNCTION_BLOCK FB_CallLib
VAR
    fbTimer : TON;
END_VAR
fbTimer(IN := TRUE, PT := T#1S, anything := 5);
END_FUNCTION_BLOCK`;
    const d = diagnose(lib).filter(x => x.message.includes('not a parameter'));
    assert(d.length === 0, `library/unknown callee parameters are not validated (got ${JSON.stringify(messages(d))})`);
}

// ---- Phase C: declaration type validation (opt-in) ----
console.log('\n--- Phase C: declaration types ---');
{
    setDiagnosticsConfig({ declarationTypes: true });
    const probe = `FUNCTION_BLOCK FB_DeclTypes
VAR
    a : INT;
    b : FB_Bin;
    c : ST_ProductStatus;
    d : ARRAY [1..3] OF E_ConveyorStatus;
    e : POINTER TO FB_Bin;
    bad : T_DoesNotExist;
    badArr : ARRAY [1..2] OF T_AlsoMissing;
END_VAR
END_FUNCTION_BLOCK`;
    const d = diagnose(probe).filter(x => x.message.includes('Unknown type'));
    const msgs = messages(d);
    assert(msgs.some(m => m.includes('T_DoesNotExist')), `flags unknown declaration type (got ${JSON.stringify(msgs)})`);
    assert(msgs.some(m => m.includes('T_AlsoMissing')), `flags unknown array element type`);
    assert(!msgs.some(m => /"(INT|FB_Bin|ST_ProductStatus|E_ConveyorStatus)"/.test(m)), `does not flag known types`);
    setDiagnosticsConfig({ declarationTypes: false });
}

// ---- Phase D: assignment type compatibility ----
console.log('\n--- Phase D: assignment compatibility ---');
{
    // Valid assignments (numeric<->numeric, matching struct, enum<->enum) must not flag.
    const ok = `FUNCTION_BLOCK FB_AssignOk
VAR
    n : INT;
    r : LREAL;
    fbBin : FB_Bin;
    prod : ST_ProductStatus;
    prod2 : ST_ProductStatus;
    st : E_ConveyorStatus;
    s : STRING;
END_VAR
n := 5;
r := n;
n := r + 1;
prod := prod2;
st := E_ConveyorStatus.Idle;
prod.byTarget := 0;
s := 'Idle';
END_FUNCTION_BLOCK`;
    const d = diagnose(ok).filter(x => x.message.includes('Type mismatch'));
    assert(d.length === 0, `valid assignments produce no mismatch (got ${JSON.stringify(messages(d))})`);
}
{
    // Clear category mismatches must flag.
    const bad = `FUNCTION_BLOCK FB_AssignBad
VAR
    n : INT;
    prod : ST_ProductStatus;
    fbBin : FB_Bin;
    s : STRING;
END_VAR
n := prod;
prod := n;
n := fbBin;
END_FUNCTION_BLOCK`;
    const d = diagnose(bad).filter(x => x.message.includes('Type mismatch'));
    const msgs = messages(d);
    assert(msgs.some(m => m.includes('ST_ProductStatus') && m.includes('INT')), `flags struct<->numeric mismatch (got ${JSON.stringify(msgs)})`);
    assert(d.length >= 2, `flags multiple clear mismatches (got ${d.length})`);
}
{
    // Anything involving an unknown/library type must NOT flag.
    const lib = `FUNCTION_BLOCK FB_AssignLib
VAR
    n : INT;
    fbTimer : TON;
    x : ST_NotIndexed;
END_VAR
n := fbTimer.ET;
x := n;
n := x;
END_FUNCTION_BLOCK`;
    const d = diagnose(lib).filter(x => x.message.includes('Type mismatch'));
    assert(d.length === 0, `unknown/library operands never flag (got ${JSON.stringify(messages(d))})`);
}

console.log(`\n--- TYPECHECK TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
