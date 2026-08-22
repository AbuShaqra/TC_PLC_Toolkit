/**
 * @file test_st_converter_portable.js
 * @description Pins stConverter.js's raw/clean output behavior across the Phase 4 refactor that
 * threads `raw` as a parameter (deleting the module-global RAW_MODE) and turns the three
 * copy-pasted struct-flatten rewrites into a frozen data table. These assertions PASS against
 * the pre-refactor code too (module-global RAW_MODE has no leakage hazard within a single
 * synchronous call) — only the STRUCT_FLATTEN_REWRITES export is new. Run this file before and
 * after the refactor: identical results prove the refactor changed nothing observable.
 */
const assert = require('assert');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt, STRUCT_FLATTEN_REWRITES } = require('../src/stConverter');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`[PASS] ${name}`); }
    catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failures++; }
}

// Minimal POU fixture through the real parseTwinCatXml. The declaration carries a REFERENCE TO
// field and a (syntactically loose, but that's fine — the rewrites are pure text regexes) struct
// EXTENDS head matching one row of STRUCT_FLATTEN_REWRITES; the implementation carries AND_THEN.
const FIXTURE_XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_Fixture" Id="{11111111-1111-1111-1111-111111111111}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Fixture
VAR
	pRef : REFERENCE TO INT;
END_VAR

TYPE ST_MES_Interlocking_Data EXTENDS ST_MES_Basic_Data :
STRUCT
	x : INT;
END_STRUCT
END_TYPE]]></Declaration>
    <Implementation>
      <ST><![CDATA[IF a AND_THEN b THEN
	;
END_IF]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;

function convertRaw() {
    const parsed = parseTwinCatXml(FIXTURE_XML);
    assert.ok(parsed, 'parseTwinCatXml returned null for the fixture');
    return convertXmlToSt(parsed, { raw: true });
}
function convertClean() {
    const parsed = parseTwinCatXml(FIXTURE_XML);
    assert.ok(parsed, 'parseTwinCatXml returned null for the fixture');
    return convertXmlToSt(parsed, { raw: false });
}

// 1. Raw mode is verbatim.
check('raw mode keeps REFERENCE TO, AND_THEN and the EXTENDS head byte-for-byte', () => {
    const { stText } = convertRaw();
    assert.ok(stText.includes('REFERENCE TO INT'), 'raw stText lost REFERENCE TO');
    assert.ok(stText.includes('AND_THEN'), 'raw stText lost AND_THEN');
    assert.ok(stText.includes('TYPE ST_MES_Interlocking_Data EXTENDS ST_MES_Basic_Data :'),
        'raw stText lost the EXTENDS head');
});

// 2. Clean mode still rewrites.
check('clean mode still applies the portable-output rewrites', () => {
    const { stText } = convertClean();
    assert.ok(stText.includes('POINTER TO INT'), 'clean stText missing POINTER TO (REFERENCE TO rewrite)');
    assert.ok(!stText.includes('AND_THEN'), 'clean stText still has AND_THEN');
    assert.ok(!stText.includes('EXTENDS ST_MES_Basic_Data'), 'clean stText still has the EXTENDS head');
    assert.ok(stText.includes('TYPE ST_MES_Interlocking_Data :'), 'clean stText missing the flattened TYPE head');
    assert.ok(stText.includes('// Fields from ST_MES_Basic_Data'), 'clean stText missing the flattened fields comment');
});

// 3. No mode leakage: raw, then clean, then raw again — first and third must be identical.
// (This is the pin for the hazard the old module-global RAW_MODE created across calls; it
// already holds today because convertXmlToSt is synchronous end-to-end, and it must keep
// holding once RAW_MODE is deleted and `raw` becomes an ordinary threaded parameter.)
check('no mode leakage across interleaved raw/clean conversions', () => {
    const first = convertRaw().stText;
    convertClean();
    const third = convertRaw().stText;
    assert.strictEqual(third, first, 'raw output changed after an interleaved clean conversion');
});

// 4. The fossil rewrites are data, not code.
check('STRUCT_FLATTEN_REWRITES is exported, frozen, and has exactly 3 entries', () => {
    assert.ok(STRUCT_FLATTEN_REWRITES, 'STRUCT_FLATTEN_REWRITES is not exported from stConverter');
    assert.ok(Object.isFrozen(STRUCT_FLATTEN_REWRITES), 'STRUCT_FLATTEN_REWRITES must be frozen');
    // Deleting a row is a real behavior change (drops a recorded portability rewrite) — pinning
    // the count at 3 makes that a conscious test edit, not an accidental regression.
    assert.strictEqual(STRUCT_FLATTEN_REWRITES.length, 3, 'expected exactly 3 struct-flatten rewrites');
    for (const rw of STRUCT_FLATTEN_REWRITES) {
        assert.ok(rw.typeName && rw.baseName && rw.fields, `malformed STRUCT_FLATTEN_REWRITES entry: ${JSON.stringify(rw)}`);
    }
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
