/**
 * @file test_config_references.js
 * @description References to a PLC symbol inside TwinCAT's NON-CODE objects — the other half of a
 * reference-aware rename. Three families name PLC symbols and go stale on rename (breaking the XAE
 * build): visualizations (`.TcVIS`/`.TcVMO`) as quoted dotted paths and embedded ST snippets, text
 * lists (`.TcTLO`/`.TcGTLO`) as text entries whose text IS a symbol path, and task configurations
 * (`.TcTTO`) as a `<PouCall>` naming the task's entry POU.
 *
 * findConfigReferencesForSymbol(spec, index, configFilePaths) takes the SAME by-name spec as
 * custom/referencesForSymbol and returns code-unit offsets into each file's BOM-stripped text, each
 * covering exactly one segment. Matching is conservative by construction — anything whose ownership
 * cannot be positively proved is skipped (an unproven edit corrupts an HMI or a task config).
 *
 * Part 1 (always runs) drives synthetic TwinCAT XML fixtures + hand-written config objects with a real
 * BOM and an umlaut label BEFORE the paths (which proves the offsets are UTF-16 code units, not bytes).
 * Part 2 (skips cleanly without sample/) drives the real sample project.
 */

const fs = require('fs');
const path = require('path');
const { indexXmlFile, indexTwinCatDirectory } = require('../src/lsp/xmlIndexer');
const { findConfigReferencesForSymbol } = require('../src/lsp/features');
const { uriToFsPath } = require('../src/lsp/workspaceScan');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Reads a file and strips a leading BOM, exactly as the feature does — offsets are into this text. */
function readStripped(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

const toUri = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');

// =================================================================================================
// PART 1 — synthetic fixtures
// =================================================================================================
console.log('\n========== PART 1: synthetic fixtures ==========');

const TEST_DIR = path.join(__dirname, 'test_config_project');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

// ------------------------------------------------------------------------------------------------
// TwinCAT XML fixtures. GVL_Sys holds instances of FB_Tgt (the target), FB_Other (an UNRELATED FB
// that declares its OWN MyProp), FB_Drv (EXTENDS FB_Tgt, so it inherits MyProp) and ST_Wrap (a struct
// whose field is an FB_Tgt — a deep hop). FB_Tgt owns property MyProp and method DoIt. MAIN is a PRG.
// PRG_Main is the PROGRAM a task calls; Visu_Prg is a project POU sharing its NAME with the library
// POU the other task calls namespace-qualified (VisuElems.Visu_Prg) — the decoy the no-dot rule
// protects.
// ------------------------------------------------------------------------------------------------
const xmlFiles = {
    'FB_Tgt.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="FB_Tgt" Id="{a0000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Tgt
VAR
	nCounter : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[nCounter := nCounter + 1;]]></ST>
    </Implementation>
    <Method Name="DoIt" Id="{a0000000-0000-4a00-8a00-000000000010}">
      <Declaration><![CDATA[METHOD DoIt : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[DoIt := TRUE;]]></ST>
      </Implementation>
    </Method>
    <Property Name="MyProp" Id="{a0000000-0000-4a00-8a00-000000000020}">
      <Declaration><![CDATA[PROPERTY MyProp : INT]]></Declaration>
      <Get Name="Get" Id="{a0000000-0000-4a00-8a00-000000000021}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[MyProp := nCounter;]]></ST>
        </Implementation>
      </Get>
    </Property>
  </POU>
</TcPlcObject>`,

    'FB_Other.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="FB_Other" Id="{a1000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Other
VAR
	nOther : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Property Name="MyProp" Id="{a1000000-0000-4a00-8a00-000000000020}">
      <Declaration><![CDATA[PROPERTY MyProp : INT]]></Declaration>
      <Get Name="Get" Id="{a1000000-0000-4a00-8a00-000000000021}">
        <Declaration><![CDATA[]]></Declaration>
        <Implementation>
          <ST><![CDATA[MyProp := nOther;]]></ST>
        </Implementation>
      </Get>
    </Property>
  </POU>
</TcPlcObject>`,

    'FB_Drv.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="FB_Drv" Id="{a2000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Drv EXTENDS FB_Tgt
VAR
	nDrv : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`,

    'ST_Wrap.TcDUT': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <DUT Name="ST_Wrap" Id="{d0000000-0000-4a00-8a00-000000000001}">
    <Declaration><![CDATA[TYPE ST_Wrap :
STRUCT
	fbInner : FB_Tgt;
END_STRUCT
END_TYPE]]></Declaration>
  </DUT>
</TcPlcObject>`,

    'GVL_Sys.TcGVL': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <GVL Name="GVL_Sys" Id="{c0000000-0000-4a00-8a00-000000000001}">
    <Declaration><![CDATA[VAR_GLOBAL
	fbTgt : FB_Tgt;
	fbOther : FB_Other;
	fbDrv : FB_Drv;
	stW : ST_Wrap;
	adValues : ARRAY[0..9] OF LREAL;
END_VAR]]></Declaration>
  </GVL>
</TcPlcObject>`,

    'MAIN.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="MAIN" Id="{e0000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM MAIN
VAR
	bRun : BOOL;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`,

    'PRG_Main.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="PRG_Main" Id="{f0000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM PRG_Main
VAR
	bCycle : BOOL;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Method Name="Step" Id="{f0000000-0000-4a00-8a00-000000000010}">
      <Declaration><![CDATA[METHOD Step : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[Step := TRUE;]]></ST>
      </Implementation>
    </Method>
  </POU>
</TcPlcObject>`,

    'Visu_Prg.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="Visu_Prg" Id="{f1000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM Visu_Prg
VAR
	bTick : BOOL;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`
};

const index = {};
const uris = {};
for (const [name, content] of Object.entries(xmlFiles)) {
    const filePath = path.join(TEST_DIR, name);
    fs.writeFileSync(filePath, content, 'utf8');
    uris[name] = toUri(filePath);
    indexXmlFile(index, filePath);
}
console.log('Indexed symbols:', Object.keys(index));

// ------------------------------------------------------------------------------------------------
// Synthetic .TcVIS files. Written WITH a BOM, and with an umlaut-laden label BEFORE any path so a
// byte-offset bug would land off the segment. Every real value shape from the brief is represented,
// including decoys that must NEVER match.
// ------------------------------------------------------------------------------------------------
const VIS_A_BODY = `<?xml version="1.0" encoding="utf-8"?>
<Visualization Name="Vis_A">
  <Elements>
    <v n="Label">"Kühlung Ächtung groß — ä ö ü ß"</v>
    <v n="BasicTypeNodeValue">"GVL_Sys.fbTgt.stStatus.stError.bError"</v>
    <v n="Value">"GVL_Sys.fbDUT.stError.bError"</v>
    <v n="STSnippet">"GVL_Sys.fbTgt.MyProp := TRUE;"</v>
    <v n="Other">"GVL_Sys.fbOther.MyProp"</v>
    <v n="Drv">"GVL_Sys.fbDrv.MyProp"</v>
    <v n="Deep">"GVL_Sys.stW.fbInner.MyProp"</v>
    <v n="LowerMember">"GVL_Sys.fbTgt.myprop"</v>
    <v n="Unk">"Unknown.something.MyProp"</v>
    <v n="DisplayTextId">"TL_ElementProperties.XCoordinate"</v>
    <v n="Dlg">"VisuDialogs.Keypad"</v>
    <v n="Login">"VisuUserManagement.VUM_Login"</v>
    <v n="Inst">"GenElemInst_6"</v>
    <v n="Align">"HCENTER"</v>
    <v n="BareBoundary">"GVL_SysX.y"</v>
  </Elements>
</Visualization>`;

const VIS_B_BODY = `<?xml version="1.0" encoding="utf-8"?>
<Visualization Name="Vis_B">
  <Elements>
    <v n="ToggleVariable">"MAIN.bRun"</v>
    <v n="Val">"GVL_Sys.fbDrv.MyProp"</v>
  </Elements>
</Visualization>`;

const visA = path.join(TEST_DIR, 'Vis_A.TcVIS');
const visB = path.join(TEST_DIR, 'Vis_B.TcVMO');
fs.writeFileSync(visA, '﻿' + VIS_A_BODY, 'utf8');
fs.writeFileSync(visB, '﻿' + VIS_B_BODY, 'utf8');
const visuFiles = [visA, visB];

// ------------------------------------------------------------------------------------------------
// Synthetic .TcGTLO — a global text list. Its TextDefault entries are plain UI strings EXCEPT where
// the text IS a PLC symbol path (dynamic visu text). The `[INDEX]` subscript must end the chain, and
// the dotted prose ("Palletizer.Turn1") is the decoy: it has the same shape as a symbol path but
// resolves to nothing, so it must never be touched. Real text lists mix the two freely, which is
// exactly why "looks like a chain" cannot be the test.
// ------------------------------------------------------------------------------------------------
const GTLO_BODY = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <GlobalTextList Name="GlobalTextList" Id="{b0000000-0000-4a00-8a00-000000000001}">
    <XmlArchive>
      <Data>
        <o xml:space="preserve" t="GlobalTextListObject">
          <l n="TextList" t="ArrayList" cet="TextListRow">
            <o>
              <v n="TextID">"1"</v>
              <v n="TextDefault">"Kühlung Ächtung groß — ä ö ü ß"</v>
            </o>
            <o>
              <v n="TextID">"2"</v>
              <v n="TextDefault">"GVL_Sys.adValues[INDEX]"</v>
            </o>
            <o>
              <v n="TextID">"3"</v>
              <v n="TextDefault">"Palletizer.Turn1"</v>
            </o>
            <o>
              <v n="TextID">"4"</v>
              <v n="TextDefault">"Palletizer.Turn2"</v>
            </o>
            <o>
              <v n="TextID">"5"</v>
              <v n="TextDefault">"GVL_Sys.fbTgt.MyProp"</v>
            </o>
          </l>
        </o>
      </Data>
    </XmlArchive>
  </GlobalTextList>
</TcPlcObject>`;

const gtlo = path.join(TEST_DIR, 'GlobalTextList.TcGTLO');
fs.writeFileSync(gtlo, '﻿' + GTLO_BODY, 'utf8');
const textListFiles = [gtlo];

// ------------------------------------------------------------------------------------------------
// Synthetic .TcTTO task configurations, in TwinCAT's real layout (the Name on its own indented line).
// Task_A calls the project PROGRAM PRG_Main; Task_B calls the LIBRARY POU VisuElems.Visu_Prg. The
// no-dot rule is the only thing separating them, and the project also contains a POU named Visu_Prg.
// ------------------------------------------------------------------------------------------------
const TASK_A_BODY = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.12">
  <Task Name="PlcTask" Id="{a6f69ccf-6b78-46d9-86ee-0d55a6d83f31}">
    <!--CycleTime in micro seconds.-->
    <CycleTime>5000</CycleTime>
    <Priority>20</Priority>
    <PouCall>
      <Name>PRG_Main</Name>
    </PouCall>
    <TaskFBGuid>{5ffe9497-f398-4107-a89b-7dcbceb0d29f}</TaskFBGuid>
  </Task>
</TcPlcObject>`;

const TASK_B_BODY = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <Task Name="VISU_TASK" Id="{d4955318-1a7f-421e-befe-5caa782a85a5}">
    <!--CycleTime in micro seconds.-->
    <CycleTime>10000</CycleTime>
    <Priority>1</Priority>
    <PouCall>
      <Name>VisuElems.Visu_Prg</Name>
    </PouCall>
    <TaskFBGuid>{7fc1af1b-071a-429f-b25b-1cbcf8ed9c14}</TaskFBGuid>
  </Task>
</TcPlcObject>`;

const taskA = path.join(TEST_DIR, 'PlcTask.TcTTO');
const taskB = path.join(TEST_DIR, 'VISU_TASK.TcTTO');
fs.writeFileSync(taskA, '﻿' + TASK_A_BODY, 'utf8');
fs.writeFileSync(taskB, '﻿' + TASK_B_BODY, 'utf8');
const taskFiles = [taskA, taskB];

const allConfigFiles = visuFiles.concat(textListFiles, taskFiles);

// stripped text per uri, for offset verification
const strippedByUri = {};
for (const p of allConfigFiles) strippedByUri[toUri(p)] = readStripped(p);

/** True when every occurrence's slice equals the expected word (case-insensitively). */
function slicesMatch(occ, expectedWord) {
    return occ.every(o => {
        const text = strippedByUri[o.uri];
        return text && text.substr(o.offset, o.length).toLowerCase() === expectedWord.toLowerCase();
    });
}
const chainsOf = (occ) => occ.map(o => o.chain);

/** Applies one file's occurrences in DESCENDING offset order, so earlier offsets stay valid. */
function spliceAll(text, occs, newName) {
    let out = text;
    for (const o of occs.slice().sort((a, b) => b.offset - a.offset)) {
        out = out.slice(0, o.offset) + newName + out.slice(o.offset + o.length);
    }
    return out;
}

// ------------------------------------------------------------------------------------------------
// 1. GVL root rename — first-segment matches; STSnippet included; every decoy excluded.
// ------------------------------------------------------------------------------------------------
console.log('\n--- GVL root rename (GVL_Sys) over the visu files ---');
const gvlRoot = findConfigReferencesForSymbol({ rootName: 'GVL_Sys', fileUri: uris['GVL_Sys.TcGVL'] }, index, visuFiles);
assert(gvlRoot.resolved === true, 'GVL_Sys root resolves');
assert(gvlRoot.occurrences.length === 8,
    `GVL_Sys found 8 first-segment occurrences across both files (got ${gvlRoot.occurrences.length})`);
assert(slicesMatch(gvlRoot.occurrences, 'GVL_Sys'),
    'every GVL_Sys occurrence slice equals "GVL_Sys"');
assert(chainsOf(gvlRoot.occurrences).includes('GVL_Sys.fbTgt.MyProp'),
    'GVL_Sys found INSIDE an STSnippet ("GVL_Sys.fbTgt.MyProp := TRUE;")');
assert(gvlRoot.occurrences.every(o => o.length === 'GVL_Sys'.length),
    'every GVL_Sys occurrence spans exactly the first segment (length 7)');
// Decoys — none of these may appear as an occurrence chain.
const gvlChains = chainsOf(gvlRoot.occurrences);
assert(!gvlChains.includes('TL_ElementProperties.XCoordinate'), 'text-list-id decoy NOT matched');
assert(!gvlChains.includes('VisuDialogs.Keypad'), 'visu-library decoy VisuDialogs.Keypad NOT matched');
assert(!gvlChains.includes('VisuUserManagement.VUM_Login'), 'visu-library decoy VisuUserManagement.VUM_Login NOT matched');
assert(!gvlChains.some(c => /^GenElemInst/.test(c)), 'GenElemInst_6 (no dot) NOT matched');
assert(!gvlChains.includes('GVL_SysX.y'), 'identifier-boundary decoy GVL_SysX.y NOT matched');

// ------------------------------------------------------------------------------------------------
// 2. PRG root rename — MAIN.bRun found (in the second file).
// ------------------------------------------------------------------------------------------------
console.log('\n--- PRG root rename (MAIN) ---');
const prgRoot = findConfigReferencesForSymbol({ rootName: 'MAIN', fileUri: uris['MAIN.TcPOU'] }, index, visuFiles);
assert(prgRoot.resolved === true, 'MAIN root resolves');
assert(prgRoot.occurrences.length === 1 && prgRoot.occurrences[0].chain === 'MAIN.bRun',
    `MAIN.bRun found (got ${JSON.stringify(chainsOf(prgRoot.occurrences))})`);
assert(slicesMatch(prgRoot.occurrences, 'MAIN'), 'MAIN occurrence slice equals "MAIN"');

// ------------------------------------------------------------------------------------------------
// 3. Member rename FB_Tgt.MyProp — owner/related prefixes only; unrelated + unresolvable excluded.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Member rename (FB_Tgt.MyProp) ---');
const myProp = findConfigReferencesForSymbol(
    { rootName: 'FB_Tgt', fileUri: uris['FB_Tgt.TcPOU'], member: { kind: 'Property', name: 'MyProp' } },
    index, visuFiles);
assert(myProp.resolved === true, 'FB_Tgt.MyProp resolves');
const mpChains = chainsOf(myProp.occurrences);
assert(mpChains.includes('GVL_Sys.fbTgt.MyProp'),
    'GVL_Sys.fbTgt.MyProp found (member on the target itself)');
assert(mpChains.includes('GVL_Sys.fbDrv.MyProp'),
    'GVL_Sys.fbDrv.MyProp found (inherited: FB_Drv EXTENDS FB_Tgt)');
assert(mpChains.includes('GVL_Sys.stW.fbInner.MyProp'),
    'GVL_Sys.stW.fbInner.MyProp found (deep hop through a struct field)');
assert(mpChains.includes('GVL_Sys.fbTgt.myprop'),
    'GVL_Sys.fbTgt.myprop found (case-insensitive segment match)');
// The ambiguous shape: GVL_Sys.fbOther.MyProp names FB_Other's OWN unrelated MyProp — must NOT match.
assert(!mpChains.includes('GVL_Sys.fbOther.MyProp'),
    'GVL_Sys.fbOther.MyProp NOT matched (different, unrelated owner FB_Other)');
assert(!mpChains.includes('Unknown.something.MyProp'),
    'Unknown.something.MyProp NOT matched (unresolvable prefix — the scan skips it)');
assert(myProp.occurrences.length === 5,
    `FB_Tgt.MyProp found exactly 5 occurrences (fbTgt, fbDrv, deep, lowercase, fbDrv-in-B) (got ${myProp.occurrences.length})`);
assert(slicesMatch(myProp.occurrences, 'MyProp'),
    'every MyProp occurrence slice equals "MyProp" (case-insensitively)');
// Each MyProp occurrence must land on the LAST segment, not the whole chain.
assert(myProp.occurrences.every(o => o.length === 'MyProp'.length),
    'every MyProp occurrence spans exactly the member segment (length 6)');

// ------------------------------------------------------------------------------------------------
// 4. Offsets are exact: splicing all of a file's occurrences descending reproduces the renamed text.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Splice round-trip (offsets are exact) ---');
const strippedA = strippedByUri[toUri(visA)];
const expectedA = strippedA.split('GVL_Sys.').join('GVL_New.'); // independent ground truth
const splicedA = spliceAll(strippedA, gvlRoot.occurrences.filter(o => o.uri === toUri(visA)), 'GVL_New');
assert(splicedA === expectedA,
    'splicing GVL_Sys occurrences in Vis_A yields exactly the expected renamed file text');

// ------------------------------------------------------------------------------------------------
// 5. Sort order — by uri, then offset.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Sort order ---');
let sorted = true;
for (let i = 1; i < gvlRoot.occurrences.length; i++) {
    const a = gvlRoot.occurrences[i - 1], b = gvlRoot.occurrences[i];
    if (a.uri > b.uri || (a.uri === b.uri && a.offset > b.offset)) { sorted = false; break; }
}
assert(sorted, 'occurrences are sorted by uri then offset');

// ------------------------------------------------------------------------------------------------
// 6. resolved:false paths — unknown root, wrong fileUri (identity guard), missing member.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Unresolved paths ---');
const unknown = findConfigReferencesForSymbol({ rootName: 'FB_DoesNotExist', fileUri: uris['GVL_Sys.TcGVL'] }, index, allConfigFiles);
assert(unknown.resolved === false && unknown.occurrences.length === 0,
    'unknown rootName is unresolved with an empty result');

const wrongFile = findConfigReferencesForSymbol({ rootName: 'GVL_Sys', fileUri: uris['FB_Tgt.TcPOU'] }, index, allConfigFiles);
assert(wrongFile.resolved === false && wrongFile.occurrences.length === 0,
    'identity guard: correct rootName but wrong fileUri is unresolved');

const missingMember = findConfigReferencesForSymbol(
    { rootName: 'FB_Tgt', fileUri: uris['FB_Tgt.TcPOU'], member: { kind: 'Method', name: 'Nope' } }, index, allConfigFiles);
assert(missingMember.resolved === false && missingMember.occurrences.length === 0,
    'a member that does not exist on the node is unresolved');

// ------------------------------------------------------------------------------------------------
// 7. Text lists (.TcGTLO) — a symbol path in a text entry is a reference; dotted prose is not.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Text list (.TcGTLO) ---');
const tlRoot = findConfigReferencesForSymbol({ rootName: 'GVL_Sys', fileUri: uris['GVL_Sys.TcGVL'] }, index, textListFiles);
assert(tlRoot.resolved === true, 'GVL_Sys resolves against the text list');
const tlChains = chainsOf(tlRoot.occurrences);
assert(tlChains.includes('GVL_Sys.adValues'),
    `the symbol path "GVL_Sys.adValues[INDEX]" is found, chain stopping at the subscript (got ${JSON.stringify(tlChains)})`);
assert(tlChains.includes('GVL_Sys.fbTgt.MyProp'),
    'a deeper symbol path in a text entry is found too');
assert(tlRoot.occurrences.length === 2,
    `exactly 2 text-list occurrences — the two symbol paths, nothing else (got ${tlRoot.occurrences.length})`);
assert(slicesMatch(tlRoot.occurrences, 'GVL_Sys'),
    'every text-list occurrence slice equals the ROOT segment "GVL_Sys"');
assert(tlRoot.occurrences.every(o => o.length === 'GVL_Sys'.length),
    'every text-list occurrence spans exactly the root segment (length 7)');
// The decoy: dotted prose with the same shape. It cannot be matched because its first segment names
// no workspace object — which is exactly what makes any query aimed at it unresolved.
assert(!tlChains.includes('Palletizer.Turn1') && !tlChains.includes('Palletizer.Turn2'),
    'text-key decoys Palletizer.Turn1/.Turn2 NOT matched');
const palletizer = findConfigReferencesForSymbol({ rootName: 'Palletizer', fileUri: uris['GVL_Sys.TcGVL'] }, index, textListFiles);
assert(palletizer.resolved === false && palletizer.occurrences.length === 0,
    'a query for "Palletizer" is unresolved — no such object, so the decoy can never be targeted');

// Member rename reaches into text lists too.
const tlMember = findConfigReferencesForSymbol(
    { rootName: 'FB_Tgt', fileUri: uris['FB_Tgt.TcPOU'], member: { kind: 'Property', name: 'MyProp' } },
    index, textListFiles);
assert(tlMember.resolved === true && tlMember.occurrences.length === 1
    && tlMember.occurrences[0].chain === 'GVL_Sys.fbTgt.MyProp',
    `the member segment is found in a text-list symbol path (got ${JSON.stringify(chainsOf(tlMember.occurrences))})`);
assert(slicesMatch(tlMember.occurrences, 'MyProp'),
    'the text-list member occurrence slice equals "MyProp"');

// ------------------------------------------------------------------------------------------------
// 8. Task configurations (.TcTTO) — the <PouCall> name, and ONLY when it carries no namespace.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Task config PouCall (.TcTTO) ---');
const taskRoot = findConfigReferencesForSymbol({ rootName: 'PRG_Main', fileUri: uris['PRG_Main.TcPOU'] }, index, taskFiles);
assert(taskRoot.resolved === true, 'PRG_Main resolves');
assert(taskRoot.occurrences.length === 1,
    `PRG_Main found exactly 1 PouCall occurrence (got ${taskRoot.occurrences.length})`);
if (taskRoot.occurrences.length === 1) {
    const o = taskRoot.occurrences[0];
    assert(o.uri === toUri(taskA), 'the PRG_Main occurrence is in PlcTask.TcTTO');
    assert(o.chain === 'PRG_Main' && o.length === 'PRG_Main'.length,
        'the occurrence spans exactly the POU name and reports it as the chain');
    assert(strippedByUri[o.uri].substr(o.offset, o.length) === 'PRG_Main',
        'the PRG_Main occurrence slice is exactly "PRG_Main"');
    // Splicing it must produce the file with only that one name changed.
    const strippedTaskA = strippedByUri[toUri(taskA)];
    const expectedTaskA = strippedTaskA.replace('<Name>PRG_Main</Name>', '<Name>PRG_Renamed</Name>');
    assert(spliceAll(strippedTaskA, taskRoot.occurrences, 'PRG_Renamed') === expectedTaskA,
        'splicing the PouCall occurrence yields the task file with only <Name> changed');
}

// The decoy that must never be rewritten: VisuElems.Visu_Prg is a LIBRARY POU, and the project
// happens to contain its own POU named Visu_Prg. Renaming that one must leave the task alone.
const libQualified = findConfigReferencesForSymbol({ rootName: 'Visu_Prg', fileUri: uris['Visu_Prg.TcPOU'] }, index, taskFiles);
assert(libQualified.resolved === true, 'the project POU Visu_Prg resolves');
assert(libQualified.occurrences.length === 0,
    `namespace-qualified <Name>VisuElems.Visu_Prg</Name> NOT matched by the no-dot rule (got ${libQualified.occurrences.length})`);

// A member is never named in a task config, so a member spec must find nothing there.
const taskMember = findConfigReferencesForSymbol(
    { rootName: 'PRG_Main', fileUri: uris['PRG_Main.TcPOU'], member: { kind: 'Method', name: 'Step' } },
    index, taskFiles);
assert(taskMember.resolved === true && taskMember.occurrences.length === 0,
    `a member spec finds nothing in a .TcTTO (got ${taskMember.occurrences.length})`);

// The Task's own Name attribute is not a PouCall and must never be picked up either.
const taskNameAttr = findConfigReferencesForSymbol({ rootName: 'MAIN', fileUri: uris['MAIN.TcPOU'] }, index, taskFiles);
assert(taskNameAttr.resolved === true && taskNameAttr.occurrences.length === 0,
    'a .TcTTO yields nothing for a POU it does not call');

// ------------------------------------------------------------------------------------------------
// 9. The combined walk — one query over every configuration object at once.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Combined config-object set ---');
const combined = findConfigReferencesForSymbol({ rootName: 'GVL_Sys', fileUri: uris['GVL_Sys.TcGVL'] }, index, allConfigFiles);
assert(combined.resolved === true, 'GVL_Sys resolves over the combined set');
assert(combined.occurrences.length === gvlRoot.occurrences.length + tlRoot.occurrences.length,
    `the combined result is exactly the visu + text-list results (got ${combined.occurrences.length}, expected ${gvlRoot.occurrences.length + tlRoot.occurrences.length})`);
let combinedSorted = true;
for (let i = 1; i < combined.occurrences.length; i++) {
    const a = combined.occurrences[i - 1], b = combined.occurrences[i];
    if (a.uri > b.uri || (a.uri === b.uri && a.offset > b.offset)) { combinedSorted = false; break; }
}
assert(combinedSorted, 'the combined result is sorted by uri then offset');

// ------------------------------------------------------------------------------------------------
// Cleanup Part 1.
// ------------------------------------------------------------------------------------------------
for (const name of Object.keys(xmlFiles)) {
    try { fs.unlinkSync(path.join(TEST_DIR, name)); } catch (e) { /* best effort */ }
}
for (const p of allConfigFiles) {
    try { fs.unlinkSync(p); } catch (e) { /* best effort */ }
}
try { fs.rmdirSync(TEST_DIR); } catch (e) { /* best effort */ }

// =================================================================================================
// PART 2 — real sample project (skips cleanly when absent)
// =================================================================================================
console.log('\n========== PART 2: real sample project ==========');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample');
// Gated on the sample actually containing configuration objects, not on sample/ merely existing —
// the synthetic sample has none until the config-object fixtures land, and Part 2 is entirely about
// what those files contain.
const sampleHasConfigObjects = fs.existsSync(SAMPLE_DIR)
    && (function has(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (entry.name === '_Libraries') continue;
                if (has(path.join(dir, entry.name))) return true;
            } else if (/\.(tcvis|tcvmo|tctlo|tcgtlo|tctto)$/i.test(entry.name)) {
                return true;
            }
        }
        return false;
    })(SAMPLE_DIR);
if (!sampleHasConfigObjects) {
    console.log('sample/ has no configuration objects — skipping Part 2.');
} else {
    // Index the whole sample the way server.js does its workspace scan.
    const { indexSampleLibraries } = require('./_baseline');
    const sIndex = {};
    indexTwinCatDirectory(sIndex, SAMPLE_DIR);
    try { indexSampleLibraries(SAMPLE_DIR); } catch (e) { /* library artifacts optional for root rename */ }

    // Discover the configuration objects (skipping vendor binaries) — the same extension set the
    // server handler's collectConfigObjectFiles walks.
    const CONFIG_EXTS = /\.(tcvis|tcvmo|tctlo|tcgtlo|tctto)$/i;
    const collectConfig = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '_Libraries') continue;
                collectConfig(full, out);
            } else if (CONFIG_EXTS.test(entry.name)) {
                out.push(full);
            }
        }
        return out;
    };
    const sampleConfig = collectConfig(SAMPLE_DIR);
    const countExt = (re) => sampleConfig.filter(p => re.test(p)).length;
    console.log(`Discovered ${sampleConfig.length} configuration object(s).`);
    // The synthetic sample carries exactly one configuration object: PlcTask.TcTTO, written by XAE
    // when the PLC project was created, whose <PouCall><Name>MAIN</Name></PouCall> names the real MAIN.
    assert(sampleConfig.length === 1,
        `sample has 1 configuration object (1 .TcTTO) (got ${sampleConfig.length})`);
    assert(countExt(/\.tctto$/i) === 1, `the task config is found (got ${countExt(/\.tctto$/i)} .TcTTO)`);

    // COVERAGE NOTE — deliberately reduced, not forgotten. The customer project this part was written
    // against had 47 configuration objects (41 .TcVIS + 1 .TcVMO + 2 .TcTLO + 1 .TcGTLO + 2 .TcTTO),
    // and the assertions below used to cover BOTH matcher families on real data:
    //   · the chain matcher — a high-volume GVL found >100 times across .TcVIS/.TcVMO
    //     (BasicTypeNodeValue paths and STSnippet code), a named deep path
    //     (GVL_X.fb.stStatus.stError.bError) located in one specific visualization, and the .TcGTLO
    //     text entry whose chain must stop at a "[INDEX]" subscript;
    //   · the decoy negatives — a second .TcTTO whose PouCall names the LIBRARY POU
    //     VisuElems.Visu_Prg, which must NOT match (the "no dot in the value" rule), and text-list
    //     prose that merely looks dotted.
    // The synthetic sample has no .TcVIS/.TcVMO/.TcTLO/.TcGTLO at all, so none of that is measurable
    // here; only the .TcTTO PouCall family is. Part 1 still exercises every matcher on synthetic
    // fixtures (including both decoys), so the logic is guarded — what is lost is the on-real-data
    // confirmation. These assertions return when Phase 2 adds .TcVIS/.TcTLO/.TcGTLO fixtures.
    assert(countExt(/\.tcvis$/i) === 0 && countExt(/\.tcvmo$/i) === 0 &&
        countExt(/\.tctlo$/i) === 0 && countExt(/\.tcgtlo$/i) === 0,
        'no visualization or text-list fixtures yet — see the coverage note above');

    const strippedCache = new Map();
    const strippedFor = (uri) => {
        if (!strippedCache.has(uri)) {
            // The product's converter, not a local copy: a hand-rolled one here hard-coded the
            // Windows separator flip and could not open a file on any POSIX filesystem.
            strippedCache.set(uri, readStripped(uriToFsPath(uri)));
        }
        return strippedCache.get(uri);
    };
    const sliceOf = (o) => strippedFor(o.uri).substr(o.offset, o.length);

    // --- The real task config: PlcTask calls MAIN. ---
    console.log('\n--- Real task config: PlcTask.TcTTO ---');
    const mainNode = sIndex['MAIN'];
    assert(!!mainNode && !!mainNode.uri, 'MAIN is indexed from the sample');
    if (mainNode) {
        const main = findConfigReferencesForSymbol({ rootName: 'MAIN', fileUri: mainNode.uri }, sIndex, sampleConfig);
        assert(main.resolved === true, 'MAIN resolves');
        console.log(`  MAIN occurrences: ${main.occurrences.length} in ${JSON.stringify([...new Set(main.occurrences.map(o => path.basename(o.uri)))])}`);
        const inTask = main.occurrences.filter(o => /\.tctto$/i.test(o.uri));
        assert(inTask.length === 1, `MAIN is found in exactly one task config (got ${inTask.length})`);
        if (inTask.length === 1) {
            assert(/PlcTask\.TcTTO$/i.test(inTask[0].uri), 'the task occurrence is in PlcTask.TcTTO');
            assert(inTask[0].chain === 'MAIN' && sliceOf(inTask[0]) === 'MAIN',
                'the PlcTask occurrence spans exactly the PouCall name "MAIN"');
        }
        assert(main.occurrences.length === 1,
            `MAIN has exactly one configuration-object occurrence (got ${main.occurrences.length})`);
        assert(main.occurrences.every(o => sliceOf(o).toLowerCase() === 'main'),
            'every MAIN occurrence slice equals "MAIN" (case-insensitively)');
    }

    // --- The negative that keeps the above from being vacuous: a real, indexed PROGRAM that the
    //     task config does NOT call must resolve and find nothing. A matcher that answered by
    //     mere presence of the name, or that fell back to a substring scan, would fail here. ---
    console.log('\n--- A POU the task config does not call ---');
    const startupNode = sIndex['P_Startup'];
    assert(!!startupNode && !!startupNode.uri, 'P_Startup is indexed from the sample');
    if (startupNode) {
        const startup = findConfigReferencesForSymbol({ rootName: 'P_Startup', fileUri: startupNode.uri }, sIndex, sampleConfig);
        assert(startup.resolved === true, 'P_Startup resolves');
        assert(startup.occurrences.length === 0,
            `P_Startup is not called by any task config (got ${startup.occurrences.length})`);
    }

    // A GVL that no configuration object mentions must likewise come back empty rather than guess.
    const sysNode = sIndex['GVL_System'];
    assert(!!sysNode && !!sysNode.uri, 'GVL_System is indexed from the sample');
    if (sysNode) {
        const sys = findConfigReferencesForSymbol({ rootName: 'GVL_System', fileUri: sysNode.uri }, sIndex, sampleConfig);
        assert(sys.resolved === true, 'GVL_System resolves');
        assert(sys.occurrences.length === 0,
            `GVL_System appears in no configuration object (got ${sys.occurrences.length})`);
    }
}

console.log(`\n--- CONFIG-REFERENCES TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
