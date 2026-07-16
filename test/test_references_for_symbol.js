/**
 * @file test_references_for_symbol.js
 * @description By-symbol Find References — the query that powers rename.
 *
 * provideReferencesForSymbol(spec, index) resolves its target from the index BY NAME instead of from a
 * cursor position, then runs the same workspace scan as the position-based provideReferences. The
 * point of the by-symbol entry is a GVL: a GVL's own name never appears in its converted ST, so the
 * position API has no seed and cannot answer it at all.
 *
 * The fixtures are real TwinCAT XML objects (.TcPOU/.TcGVL/.TcDUT/.TcIO) written to disk and indexed
 * through the xmlIndexer, then read back by readStForFile (which converts XML → ST on read) — exactly
 * the production path. The index is a fresh, local object, so nothing here touches — or is touched by —
 * the parser's module-global workspace index.
 */

const fs = require('fs');
const path = require('path');
const { indexXmlFile } = require('../src/lsp/xmlIndexer');
const { provideReferencesForSymbol } = require('../src/lsp/features');

const TEST_DIR = path.join(__dirname, 'test_refsym_project');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ------------------------------------------------------------------------------------------------
// Fixtures. FB_Target implements I_Target (both declare DoIt); GVL_Data holds an FB_Target instance
// and a global; ST_Foo is a struct; PRG_Main uses all of them across dotted and qualified paths.
// ------------------------------------------------------------------------------------------------
const files = {
    'FB_Target.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="FB_Target" Id="{a0000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Target IMPLEMENTS I_Target
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
    <Action Name="MyAct" Id="{a0000000-0000-4a00-8a00-000000000030}">
      <Implementation>
        <ST><![CDATA[nCounter := 0;]]></ST>
      </Implementation>
    </Action>
  </POU>
</TcPlcObject>`,

    'I_Target.TcIO': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <Itf Name="I_Target" Id="{b0000000-0000-4a00-8a00-000000000001}">
    <Declaration><![CDATA[INTERFACE I_Target
]]></Declaration>
    <Method Name="DoIt" Id="{b0000000-0000-4a00-8a00-000000000010}">
      <Declaration><![CDATA[METHOD DoIt : BOOL
]]></Declaration>
    </Method>
  </Itf>
</TcPlcObject>`,

    'GVL_Data.TcGVL': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <GVL Name="GVL_Data" Id="{c0000000-0000-4a00-8a00-000000000001}">
    <Declaration><![CDATA[VAR_GLOBAL
	fbX : FB_Target;
	g_var : INT;
END_VAR]]></Declaration>
  </GVL>
</TcPlcObject>`,

    'ST_Foo.TcDUT': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <DUT Name="ST_Foo" Id="{d0000000-0000-4a00-8a00-000000000001}">
    <Declaration><![CDATA[TYPE ST_Foo :
STRUCT
	nField : INT;
END_STRUCT
END_TYPE]]></Declaration>
  </DUT>
</TcPlcObject>`,

    'PRG_Main.TcPOU': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="PRG_Main" Id="{e0000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM PRG_Main
VAR
	fbLocal : FB_Target;
	stFoo : ST_Foo;
	nLocal : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[fbLocal.DoIt();
GVL_Data.fbX.DoIt();
nLocal := fbLocal.MyProp;
fbLocal.MyAct();
stFoo.nField := GVL_Data.g_var;]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`
};

const toUri = (p) => 'file:///' + p.replace(/\\/g, '/');

// Write fixtures to disk and index each into a FRESH local index (isolation from module globals).
const index = {};
const uris = {};
for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(TEST_DIR, name);
    fs.writeFileSync(filePath, content, 'utf8');
    uris[name] = toUri(filePath);
    indexXmlFile(index, filePath);
}
console.log('Indexed symbols:', Object.keys(index));

/** Count references landing in a given fixture file. */
const inFile = (refs, name) => refs.filter(r => r.uri.endsWith('/' + name)).length;

// ------------------------------------------------------------------------------------------------
// 1. FB root: cross-file usage found, self header found, declaration points at a real occurrence.
// ------------------------------------------------------------------------------------------------
console.log('\n--- FB root ---');
const fbRoot = provideReferencesForSymbol({ rootName: 'FB_Target', fileUri: uris['FB_Target.TcPOU'] }, index);
assert(fbRoot.resolved === true, 'FB_Target root resolves');
assert(inFile(fbRoot.references, 'GVL_Data.TcGVL') >= 1,
    `FB_Target found in the GVL that declares an instance (got ${inFile(fbRoot.references, 'GVL_Data.TcGVL')})`);
assert(inFile(fbRoot.references, 'PRG_Main.TcPOU') >= 1,
    `FB_Target found in the PRG that declares a local (got ${inFile(fbRoot.references, 'PRG_Main.TcPOU')})`);
assert(inFile(fbRoot.references, 'FB_Target.TcPOU') >= 1,
    `FB_Target self header occurrence found (got ${inFile(fbRoot.references, 'FB_Target.TcPOU')})`);
assert(fbRoot.declaration && fbRoot.declaration.uri === uris['FB_Target.TcPOU'],
    'FB_Target declaration points at its own file');
assert(fbRoot.declaration && fbRoot.references.some(r =>
        r.uri === uris['FB_Target.TcPOU'] &&
        r.range.start.line === fbRoot.declaration.range.start.line &&
        r.range.start.character === fbRoot.declaration.range.start.character),
    'FB_Target declaration range coincides with a reported occurrence (the header)');

// ------------------------------------------------------------------------------------------------
// 2. GVL root — the case the position API cannot seed (a GVL's name is absent from its own ST).
// ------------------------------------------------------------------------------------------------
console.log('\n--- GVL root (position API cannot seed this) ---');
const gvlRoot = provideReferencesForSymbol({ rootName: 'GVL_Data', fileUri: uris['GVL_Data.TcGVL'] }, index);
assert(gvlRoot.resolved === true, 'GVL_Data root resolves');
assert(inFile(gvlRoot.references, 'PRG_Main.TcPOU') >= 1,
    `GVL_Data qualified usages found in the PRG (got ${inFile(gvlRoot.references, 'PRG_Main.TcPOU')})`);
assert(gvlRoot.declaration && gvlRoot.declaration.uri === uris['GVL_Data.TcGVL'],
    'GVL_Data declaration points at its own file');

// ------------------------------------------------------------------------------------------------
// 3. DUT root: struct-typed variable usage found.
// ------------------------------------------------------------------------------------------------
console.log('\n--- DUT root ---');
const dutRoot = provideReferencesForSymbol({ rootName: 'ST_Foo', fileUri: uris['ST_Foo.TcDUT'] }, index);
assert(dutRoot.resolved === true, 'ST_Foo root resolves');
assert(inFile(dutRoot.references, 'PRG_Main.TcPOU') >= 1,
    `ST_Foo found where a variable is declared of it (got ${inFile(dutRoot.references, 'PRG_Main.TcPOU')})`);
assert(dutRoot.declaration && dutRoot.declaration.uri === uris['ST_Foo.TcDUT'],
    'ST_Foo declaration points at its own file');

// ------------------------------------------------------------------------------------------------
// 4. Method: dotted calls found, and the implemented interface's own declaration is included
//    (the sameSymbol EXTENDS/IMPLEMENTS relaxation).
// ------------------------------------------------------------------------------------------------
console.log('\n--- Method (with interface relaxation) ---');
const doIt = provideReferencesForSymbol(
    { rootName: 'FB_Target', fileUri: uris['FB_Target.TcPOU'], member: { kind: 'Method', name: 'DoIt' } }, index);
assert(doIt.resolved === true, 'FB_Target.DoIt resolves');
assert(inFile(doIt.references, 'PRG_Main.TcPOU') >= 1,
    `DoIt dotted calls found in the PRG (got ${inFile(doIt.references, 'PRG_Main.TcPOU')})`);
assert(inFile(doIt.references, 'FB_Target.TcPOU') >= 1,
    `DoIt found in its own FB (got ${inFile(doIt.references, 'FB_Target.TcPOU')})`);
assert(inFile(doIt.references, 'I_Target.TcIO') >= 1,
    `DoIt includes the interface declaration it implements (got ${inFile(doIt.references, 'I_Target.TcIO')})`);
assert(doIt.declaration && doIt.declaration.uri === uris['FB_Target.TcPOU'],
    'DoIt declaration points at the FB that owns it');

// ------------------------------------------------------------------------------------------------
// 5. Property: dotted usage found.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Property ---');
const myProp = provideReferencesForSymbol(
    { rootName: 'FB_Target', fileUri: uris['FB_Target.TcPOU'], member: { kind: 'Property', name: 'MyProp' } }, index);
assert(myProp.resolved === true, 'FB_Target.MyProp resolves');
assert(inFile(myProp.references, 'PRG_Main.TcPOU') >= 1,
    `MyProp dotted usage found in the PRG (got ${inFile(myProp.references, 'PRG_Main.TcPOU')})`);
assert(myProp.declaration && myProp.declaration.uri === uris['FB_Target.TcPOU'],
    'MyProp declaration points at the FB that owns it');

// ------------------------------------------------------------------------------------------------
// 6. Action: dotted usage found, and the synthesized `ACTION MyAct` decl line comes back at ST coords.
// ------------------------------------------------------------------------------------------------
console.log('\n--- Action ---');
const myAct = provideReferencesForSymbol(
    { rootName: 'FB_Target', fileUri: uris['FB_Target.TcPOU'], member: { kind: 'Action', name: 'MyAct' } }, index);
assert(myAct.resolved === true, 'FB_Target.MyAct resolves');
assert(inFile(myAct.references, 'PRG_Main.TcPOU') >= 1,
    `MyAct dotted usage found in the PRG (got ${inFile(myAct.references, 'PRG_Main.TcPOU')})`);
assert(inFile(myAct.references, 'FB_Target.TcPOU') >= 1,
    `MyAct decl-line occurrence found in its own FB (got ${inFile(myAct.references, 'FB_Target.TcPOU')})`);
assert(myAct.declaration && myAct.declaration.uri === uris['FB_Target.TcPOU'] &&
        myAct.references.some(r =>
            r.uri === uris['FB_Target.TcPOU'] &&
            r.range.start.line === myAct.declaration.range.start.line &&
            r.range.start.character === myAct.declaration.range.start.character),
    'MyAct declaration (synthesized ACTION line) coincides with a reported occurrence at ST coords');

// ------------------------------------------------------------------------------------------------
// 7. resolved:false — unknown root, and the identity guard (right name, wrong file).
// ------------------------------------------------------------------------------------------------
console.log('\n--- Unresolved paths ---');
const unknown = provideReferencesForSymbol({ rootName: 'FB_DoesNotExist', fileUri: uris['FB_Target.TcPOU'] }, index);
assert(unknown.resolved === false && unknown.references.length === 0 && unknown.declaration === null,
    'unknown rootName is unresolved with an empty result');

const wrongFile = provideReferencesForSymbol({ rootName: 'FB_Target', fileUri: uris['PRG_Main.TcPOU'] }, index);
assert(wrongFile.resolved === false && wrongFile.references.length === 0 && wrongFile.declaration === null,
    'identity guard: correct rootName but wrong fileUri is unresolved (never scans the wrong object)');

const missingMember = provideReferencesForSymbol(
    { rootName: 'FB_Target', fileUri: uris['FB_Target.TcPOU'], member: { kind: 'Method', name: 'Nope' } }, index);
assert(missingMember.resolved === false,
    'a member that does not exist on the node is unresolved');

// ------------------------------------------------------------------------------------------------
// 8. Index-restored discipline: a by-symbol call must leave previously-indexed nodes' uri/nameRange
//    untouched (the on-disk per-component ranges are what cross-file Go to Definition navigates with).
// ------------------------------------------------------------------------------------------------
console.log('\n--- Index restored after a call ---');
const before = {};
for (const name of ['FB_Target', 'GVL_Data', 'ST_Foo', 'PRG_Main', 'I_Target']) {
    before[name] = { uri: index[name].uri, nameRange: JSON.stringify(index[name].nameRange) };
}
// A call that both re-indexes the target's own file AND transiently re-indexes every other file.
provideReferencesForSymbol({ rootName: 'FB_Target', fileUri: uris['FB_Target.TcPOU'] }, index);
for (const name of Object.keys(before)) {
    assert(index[name].uri === before[name].uri,
        `${name}.uri unchanged after a by-symbol call`);
    assert(JSON.stringify(index[name].nameRange) === before[name].nameRange,
        `${name}.nameRange unchanged after a by-symbol call`);
}

// ------------------------------------------------------------------------------------------------
// Cleanup.
// ------------------------------------------------------------------------------------------------
for (const name of Object.keys(files)) {
    try { fs.unlinkSync(path.join(TEST_DIR, name)); } catch (e) { /* best effort */ }
}
try { fs.rmdirSync(TEST_DIR); } catch (e) { /* best effort */ }

console.log(`\n--- REFERENCES-FOR-SYMBOL TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
