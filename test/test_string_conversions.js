/**
 * @file test_string_conversions.js
 * @description Regression harness for STRING/WSTRING assignment typing.
 *
 * Guards the fix for the self-contradictory diagnostic
 * `Type mismatch: cannot assign "STRING" to "STRING".`, which fired on every string conversion
 * (`TO_STRING`, `INT_TO_STRING`, `TO_WSTRING`, …): declared strings type as kind 'string'
 * (types.js parseTypeString) while the conversion builtins typed as kind 'elementary'
 * (exprParser.js builtinCallType), so isAssignable matched no branch and fell through to
 * 'incompatible'.
 *
 * Self-contained: enum/struct types are indexed from inline TwinCAT XML, the probe POUs from
 * inline Structured Text. No `sample/` project, no temp files.
 *
 * Also asserts the fix does NOT over-suppress: a genuine category mismatch (STRUCT -> INT) is
 * still flagged.
 */

const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideDiagnostics } = require('../src/lsp/features');

let errors = 0;
function assert(condition, message) {
    if (condition) {
        console.log(`[PASS] ${message}`);
    } else {
        console.error(`[FAIL] ${message}`);
        errors++;
    }
}

// ---- Workspace: one enum DUT + one struct DUT, indexed from inline TwinCAT XML ----
clearWorkspaceIndex();
const index = getWorkspaceSymbolIndex();

const enumXml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <DUT Name="E_Step" Id="{00000000-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[{attribute 'to_string'}
TYPE E_Step :
(
	eIdle := 0,
	eRun := 1
);
END_TYPE]]></Declaration>
  </DUT>
</TcPlcObject>`;

const structXml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <DUT Name="ST_Data" Id="{00000000-0000-0000-0000-000000000002}">
    <Declaration><![CDATA[TYPE ST_Data :
STRUCT
	nValue : INT;
END_STRUCT
END_TYPE]]></Declaration>
  </DUT>
</TcPlcObject>`;

indexXmlObject(index, enumXml, 'file:///c:/fake/E_Step.TcDUT');
indexXmlObject(index, structXml, 'file:///c:/fake/ST_Data.TcDUT');

/** Indexes an ST probe under a unique URI and returns only its type-mismatch diagnostics. */
let probeCounter = 0;
function mismatches(stText) {
    const uri = `file:///c:/fake/_StringProbe_${probeCounter++}.TcPOU`;
    parseAndIndexDocument(stText, uri);
    return provideDiagnostics(stText, index, uri).filter(d => /Type mismatch/.test(d.message));
}

function messages(diags) { return diags.map(d => d.message); }

// ----------------------------------------------------------------------------
// (a) string conversions assigned to declared STRING/WSTRING targets
// ----------------------------------------------------------------------------
console.log('\n--- (a): conversion results assigned to STRING/WSTRING ---');

const okCode = `FUNCTION_BLOCK FB_StringOk
VAR
	eStep : E_Step;
	x : INT;
	sOut : STRING;
	sOther : STRING;
	sSized : STRING(80);
	wsOut : WSTRING;
END_VAR

sOut := TO_STRING(eStep);
sOut := INT_TO_STRING(12);
sOut := INT_TO_STRING(x);
sOut := TO_STRING(x);
wsOut := TO_WSTRING(x);
wsOut := INT_TO_WSTRING(x);
sOut := sOther;
sOut := 'literal';
sSized := TO_STRING(eStep);
sSized := sOut;
`;
const diagsA = mismatches(okCode);
assert(diagsA.length === 0, `no type-mismatch on string conversions/assignments. Found: ${JSON.stringify(messages(diagsA))}`);

// ----------------------------------------------------------------------------
// (b) sized STRING target declared with a conversion initializer
// ----------------------------------------------------------------------------
console.log('\n--- (b): sized STRING declaration initialized from a conversion ---');

const declCode = `FUNCTION_BLOCK FB_StringDecl
VAR
	eStep : E_Step;
	sSized : STRING(80) := TO_STRING(eStep);
	sPlain : STRING := INT_TO_STRING(12);
	wsSized : WSTRING(80) := TO_WSTRING(12);
END_VAR

sSized := TO_STRING(eStep);
`;
const diagsB = mismatches(declCode);
assert(diagsB.length === 0, `no type-mismatch on sized/initialized STRING declarations. Found: ${JSON.stringify(messages(diagsB))}`);

// ----------------------------------------------------------------------------
// (c) non-string conversions still type as their elementary target
// ----------------------------------------------------------------------------
console.log('\n--- (c): non-string conversions unchanged ---');

const numCode = `FUNCTION_BLOCK FB_NumOk
VAR
	x : INT;
	r : LREAL;
	b : BOOL;
	eStep : E_Step;
END_VAR

x := TO_INT(r);
r := INT_TO_LREAL(x);
b := TO_BOOL(x);
x := TO_INT(eStep);
`;
const diagsC = mismatches(numCode);
assert(diagsC.length === 0, `numeric conversions produce no mismatch. Found: ${JSON.stringify(messages(diagsC))}`);

// ----------------------------------------------------------------------------
// (d) over-suppression guard: genuine category mismatches are STILL flagged
// ----------------------------------------------------------------------------
console.log('\n--- (d): genuine mismatches still flagged (no over-suppression) ---');

const badCode = `FUNCTION_BLOCK FB_StringBad
VAR
	x : INT;
	stData : ST_Data;
	sOut : STRING;
END_VAR

x := stData;
`;
const diagsD = mismatches(badCode);
assert(diagsD.some(d => /ST_Data/.test(d.message) && /INT/.test(d.message)),
    `STRUCT assigned to INT is still flagged. Found: ${JSON.stringify(messages(diagsD))}`);

const badCode2 = `FUNCTION_BLOCK FB_StringBad2
VAR
	stData : ST_Data;
	sOut : STRING;
END_VAR

stData := sOut;
`;
const diagsD2 = mismatches(badCode2);
assert(diagsD2.some(d => /ST_Data/.test(d.message) && /STRING/.test(d.message)),
    `STRING assigned to a STRUCT is still flagged. Found: ${JSON.stringify(messages(diagsD2))}`);

console.log(`\n--- STRING-CONVERSION TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
