/**
 * @file test_visu_references.js
 * @description References to a PLC symbol inside TwinCAT visualization files (.TcVIS/.TcVMO) — the
 * other half of a reference-aware rename. Visu files reference PLC symbols as quoted dotted paths and
 * inside embedded ST snippets; a rename that leaves them stale makes XAE fail to build.
 *
 * findVisuReferencesForSymbol(spec, index, visuFilePaths) takes the SAME by-name spec as
 * custom/referencesForSymbol and returns code-unit offsets into each file's BOM-stripped text, each
 * covering exactly one chain segment. Matching is conservative by construction — anything whose
 * ownership cannot be positively proved is skipped (an unproven visu edit corrupts an HMI).
 *
 * Part 1 (always runs) drives synthetic TwinCAT XML fixtures + hand-written .TcVIS files with a real
 * BOM and an umlaut label BEFORE the paths (which proves the offsets are UTF-16 code units, not bytes).
 * Part 2 (skips cleanly without sample/) drives the real sample project.
 */

const fs = require('fs');
const path = require('path');
const { indexXmlFile, indexTwinCatDirectory } = require('../src/lsp/xmlIndexer');
const { findVisuReferencesForSymbol } = require('../src/lsp/features');

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

const toUri = (p) => 'file:///' + p.replace(/\\/g, '/');

// =================================================================================================
// PART 1 — synthetic fixtures
// =================================================================================================
console.log('\n========== PART 1: synthetic fixtures ==========');

const TEST_DIR = path.join(__dirname, 'test_visu_project');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

// ------------------------------------------------------------------------------------------------
// TwinCAT XML fixtures. GVL_Sys holds instances of FB_Tgt (the target), FB_Other (an UNRELATED FB
// that declares its OWN MyProp), FB_Drv (EXTENDS FB_Tgt, so it inherits MyProp) and ST_Wrap (a struct
// whose field is an FB_Tgt — a deep hop). FB_Tgt owns property MyProp and method DoIt. MAIN is a PRG.
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

// stripped text per uri, for offset verification
const strippedByUri = {
    [toUri(visA)]: readStripped(visA),
    [toUri(visB)]: readStripped(visB)
};

/** True when every occurrence's slice equals the expected word (case-insensitively). */
function slicesMatch(occ, expectedWord) {
    return occ.every(o => {
        const text = strippedByUri[o.uri];
        return text && text.substr(o.offset, o.length).toLowerCase() === expectedWord.toLowerCase();
    });
}
const chainsOf = (occ) => occ.map(o => o.chain);

// ------------------------------------------------------------------------------------------------
// 1. GVL root rename — first-segment matches; STSnippet included; every decoy excluded.
// ------------------------------------------------------------------------------------------------
console.log('\n--- GVL root rename (GVL_Sys) ---');
const gvlRoot = findVisuReferencesForSymbol({ rootName: 'GVL_Sys', fileUri: uris['GVL_Sys.TcGVL'] }, index, visuFiles);
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
assert(!gvlChains.includes('TL_ElementProperties.XCoordinate'), 'text-list decoy NOT matched');
assert(!gvlChains.includes('VisuDialogs.Keypad'), 'visu-library decoy VisuDialogs.Keypad NOT matched');
assert(!gvlChains.includes('VisuUserManagement.VUM_Login'), 'visu-library decoy VisuUserManagement.VUM_Login NOT matched');
assert(!gvlChains.some(c => /^GenElemInst/.test(c)), 'GenElemInst_6 (no dot) NOT matched');
assert(!gvlChains.includes('GVL_SysX.y'), 'identifier-boundary decoy GVL_SysX.y NOT matched');

// ------------------------------------------------------------------------------------------------
// 2. PRG root rename — MAIN.bRun found (in the second file).
// ------------------------------------------------------------------------------------------------
console.log('\n--- PRG root rename (MAIN) ---');
const prgRoot = findVisuReferencesForSymbol({ rootName: 'MAIN', fileUri: uris['MAIN.TcPOU'] }, index, visuFiles);
assert(prgRoot.resolved === true, 'MAIN root resolves');
assert(prgRoot.occurrences.length === 1 && prgRoot.occurrences[0].chain === 'MAIN.bRun',
    `MAIN.bRun found (got ${JSON.stringify(chainsOf(prgRoot.occurrences))})`);
assert(slicesMatch(prgRoot.occurrences, 'MAIN'), 'MAIN occurrence slice equals "MAIN"');

// ------------------------------------------------------------------------------------------------
// 3. Member rename FB_Tgt.MyProp — owner/related prefixes only; unrelated + unresolvable excluded.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Member rename (FB_Tgt.MyProp) ---');
const myProp = findVisuReferencesForSymbol(
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
    'Unknown.something.MyProp NOT matched (unresolvable prefix — visu skips it)');
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
const occA = gvlRoot.occurrences
    .filter(o => o.uri === toUri(visA))
    .slice()
    .sort((a, b) => b.offset - a.offset); // descending, so earlier offsets stay valid
let splicedA = strippedA;
for (const o of occA) {
    splicedA = splicedA.slice(0, o.offset) + 'GVL_New' + splicedA.slice(o.offset + o.length);
}
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
const unknown = findVisuReferencesForSymbol({ rootName: 'FB_DoesNotExist', fileUri: uris['GVL_Sys.TcGVL'] }, index, visuFiles);
assert(unknown.resolved === false && unknown.occurrences.length === 0,
    'unknown rootName is unresolved with an empty result');

const wrongFile = findVisuReferencesForSymbol({ rootName: 'GVL_Sys', fileUri: uris['FB_Tgt.TcPOU'] }, index, visuFiles);
assert(wrongFile.resolved === false && wrongFile.occurrences.length === 0,
    'identity guard: correct rootName but wrong fileUri is unresolved');

const missingMember = findVisuReferencesForSymbol(
    { rootName: 'FB_Tgt', fileUri: uris['FB_Tgt.TcPOU'], member: { kind: 'Method', name: 'Nope' } }, index, visuFiles);
assert(missingMember.resolved === false && missingMember.occurrences.length === 0,
    'a member that does not exist on the node is unresolved');

// ------------------------------------------------------------------------------------------------
// Cleanup Part 1.
// ------------------------------------------------------------------------------------------------
for (const name of Object.keys(xmlFiles)) {
    try { fs.unlinkSync(path.join(TEST_DIR, name)); } catch (e) { /* best effort */ }
}
try { fs.unlinkSync(visA); } catch (e) { /* best effort */ }
try { fs.unlinkSync(visB); } catch (e) { /* best effort */ }
try { fs.rmdirSync(TEST_DIR); } catch (e) { /* best effort */ }

// =================================================================================================
// PART 2 — real sample project (skips cleanly when absent)
// =================================================================================================
console.log('\n========== PART 2: real sample project ==========');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample');
if (!fs.existsSync(SAMPLE_DIR)) {
    console.log('sample/ project not present — skipping Part 2.');
} else {
    // Index the whole sample the way server.js does its workspace scan.
    const { indexSampleLibraries } = require('./_baseline');
    const sIndex = {};
    indexTwinCatDirectory(sIndex, SAMPLE_DIR);
    try { indexSampleLibraries(SAMPLE_DIR); } catch (e) { /* library artifacts optional for root rename */ }

    // Discover the visu files (skipping vendor binaries), the same set the server handler walks.
    const collectVisu = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '_Libraries') continue;
                collectVisu(full, out);
            } else if (/\.(tcvis|tcvmo)$/i.test(entry.name)) {
                out.push(full);
            }
        }
        return out;
    };
    const sampleVisu = collectVisu(SAMPLE_DIR);
    console.log(`Discovered ${sampleVisu.length} visu file(s).`);
    assert(sampleVisu.length === 42, `sample has 42 visu files (41 .TcVIS + 1 .TcVMO) (got ${sampleVisu.length})`);

    const strippedCache = new Map();
    const strippedFor = (uri) => {
        if (!strippedCache.has(uri)) {
            const fsPath = decodeURIComponent(uri.replace(/^file:\/\/\//i, '')).replace(/\//g, '\\');
            strippedCache.set(uri, readStripped(fsPath));
        }
        return strippedCache.get(uri);
    };
    const sliceOf = (o) => strippedFor(o.uri).substr(o.offset, o.length);

    // --- High-volume GVL: GVL_HMI_Manuell (the sample's most-referenced PLC GVL, ~665 visu paths;
    //     it is also the STSnippet example in the brief). This carries the ">100 occurrences" case. ---
    console.log('\n--- GVL_HMI_Manuell root over the real visu files ---');
    const hmiNode = sIndex['GVL_HMI_Manuell'];
    assert(!!hmiNode && !!hmiNode.uri, 'GVL_HMI_Manuell is indexed from the sample');
    if (hmiNode) {
        const hmi = findVisuReferencesForSymbol({ rootName: 'GVL_HMI_Manuell', fileUri: hmiNode.uri }, sIndex, sampleVisu);
        assert(hmi.resolved === true, 'GVL_HMI_Manuell resolves');
        console.log(`  GVL_HMI_Manuell occurrences: ${hmi.occurrences.length}`);
        assert(hmi.occurrences.length > 100,
            `GVL_HMI_Manuell has > 100 visu occurrences (got ${hmi.occurrences.length})`);
        assert(hmi.occurrences.every(o => sliceOf(o).toLowerCase() === 'gvl_hmi_manuell'),
            'every GVL_HMI_Manuell occurrence slice equals the root name (case-insensitively)');
        assert(hmi.occurrences.every(o => o.length === o.chain.split('.')[0].length),
            'every GVL_HMI_Manuell occurrence spans exactly its chain first segment');
    }

    // --- Named-path case: GVL_System.fbAxisX.stStatus.stError.bError lives in Kreuztisch.TcVIS. ---
    console.log('\n--- GVL_System root: a named known path is among the results ---');
    const sysNode = sIndex['GVL_System'];
    assert(!!sysNode && !!sysNode.uri, 'GVL_System is indexed from the sample');
    if (sysNode) {
        const sys = findVisuReferencesForSymbol({ rootName: 'GVL_System', fileUri: sysNode.uri }, sIndex, sampleVisu);
        assert(sys.resolved === true, 'GVL_System resolves');
        console.log(`  GVL_System occurrences: ${sys.occurrences.length}`);
        assert(sys.occurrences.length > 10,
            `GVL_System has a plausible number of visu occurrences (got ${sys.occurrences.length})`);
        assert(sys.occurrences.every(o => sliceOf(o).toLowerCase() === 'gvl_system'),
            'every GVL_System occurrence slice equals the root name (case-insensitively)');
        const named = sys.occurrences.find(o =>
            o.chain === 'GVL_System.fbAxisX.stStatus.stError.bError' && /Kreuztisch\.TcVIS$/i.test(o.uri));
        assert(!!named, 'the named path GVL_System.fbAxisX.stStatus.stError.bError is found in Kreuztisch.TcVIS');
        if (named) {
            assert(strippedFor(named.uri).substr(named.offset, named.length) === 'GVL_System',
                'the named path occurrence slice is exactly "GVL_System"');
        }
    }
}

console.log(`\n--- VISU-REFERENCES TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
