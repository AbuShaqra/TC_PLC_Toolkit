/**
 * @file test_st_converter_portable.js
 * @description Pins stConverter.js's raw/clean output behavior: raw mode is verbatim, clean mode
 * applies the portable-output rewrites, `raw` does not leak between calls, and struct EXTENDS is
 * flattened from struct definitions parsed out of the project itself (collectStructDefinitions) —
 * never from a hard-coded list of type names.
 */
const assert = require('assert');
const { parseTwinCatXml } = require('../src/xmlParser');
const stConverter = require('../src/stConverter');
const { convertXmlToSt, collectStructDefinitions } = stConverter;

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`[PASS] ${name}`); }
    catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failures++; }
}

function dut(name, body) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <DUT Name="${name}" Id="{22222222-2222-2222-2222-222222222222}">
    <Declaration><![CDATA[${body}]]></Declaration>
  </DUT>
</TcPlcObject>`;
}

// Minimal POU fixture through the real parseTwinCatXml. The declaration carries a REFERENCE TO
// field and (syntactically loose, but the rewrites are pure text regexes) a struct pair defined
// in the same text, one EXTENDS the other; the implementation carries AND_THEN.
const FIXTURE_XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_Fixture" Id="{11111111-1111-1111-1111-111111111111}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Fixture
VAR
	pRef : REFERENCE TO INT;
END_VAR

TYPE ST_Base :
STRUCT
	nBaseValue : INT;
END_STRUCT
END_TYPE

TYPE ST_Derived EXTENDS ST_Base :
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

function convert(xml, options) {
    const parsed = parseTwinCatXml(xml);
    assert.ok(parsed, 'parseTwinCatXml returned null for the fixture');
    return convertXmlToSt(parsed, options).stText;
}
const convertRaw = () => convert(FIXTURE_XML, { raw: true });
const convertClean = () => convert(FIXTURE_XML, { raw: false });

check('raw mode keeps REFERENCE TO, AND_THEN and the EXTENDS head byte-for-byte', () => {
    const stText = convertRaw();
    assert.ok(stText.includes('REFERENCE TO INT'), 'raw stText lost REFERENCE TO');
    assert.ok(stText.includes('AND_THEN'), 'raw stText lost AND_THEN');
    assert.ok(stText.includes('TYPE ST_Derived EXTENDS ST_Base :'), 'raw stText lost the EXTENDS head');
});

check('clean mode applies the portable-output rewrites, flattening from the file itself', () => {
    const stText = convertClean();
    assert.ok(stText.includes('POINTER TO INT'), 'clean stText missing POINTER TO (REFERENCE TO rewrite)');
    assert.ok(!stText.includes('AND_THEN'), 'clean stText still has AND_THEN');
    assert.ok(!/EXTENDS/i.test(stText), 'clean stText still has the EXTENDS head');
    assert.ok(/TYPE ST_Derived :\s*STRUCT\s*\/\/ Fields from ST_Base\s*nBaseValue : INT;\s*x : INT;/.test(stText),
        `flattened struct has the wrong shape:\n${stText}`);
});

check('no mode leakage across interleaved raw/clean conversions', () => {
    const first = convertRaw();
    convertClean();
    assert.strictEqual(convertRaw(), first, 'raw output changed after an interleaved clean conversion');
});

check('no hard-coded struct table is exported any more', () => {
    assert.strictEqual(stConverter.STRUCT_FLATTEN_REWRITES, undefined);
});

// Cross-file, multi-level: ST_Grand <- ST_Parent (file 2) <- ST_Child (file 3).
const GRAND = dut('ST_Grand', 'TYPE ST_Grand :\nSTRUCT\n\tbFlag : BOOL;\nEND_STRUCT\nEND_TYPE');
const PARENT = dut('ST_Parent', 'TYPE ST_Parent EXTENDS ST_Grand :\nSTRUCT\n\tnCount : UDINT;\nEND_STRUCT\nEND_TYPE');
const CHILD = dut('ST_Child', 'TYPE ST_Child EXTENDS ST_Parent :\nSTRUCT\n\tsName : STRING(20);\nEND_STRUCT\nEND_TYPE');

check('collectStructDefinitions reads name, base and body case-insensitively', () => {
    const reg = collectStructDefinitions([GRAND, PARENT, CHILD].map(parseTwinCatXml));
    assert.strictEqual(reg.size, 3);
    const parent = reg.get('st_parent');
    assert.ok(parent, 'ST_Parent not collected');
    assert.strictEqual(parent.name, 'ST_Parent');
    assert.strictEqual(parent.base, 'ST_Grand');
    assert.ok(/nCount : UDINT;/.test(parent.body));
    assert.strictEqual(reg.get('st_grand').base, null);
});

check('a project registry flattens a multi-level chain across files, root-most first', () => {
    const structs = collectStructDefinitions([GRAND, PARENT, CHILD].map(parseTwinCatXml));
    const stText = convert(CHILD, { structs });
    assert.ok(!/EXTENDS/i.test(stText), stText);
    assert.ok(/TYPE ST_Child :\s*STRUCT\s*\/\/ Fields from ST_Grand\s*bFlag : BOOL;\s*\/\/ Fields from ST_Parent\s*nCount : UDINT;\s*sName : STRING\(20\);/.test(stText),
        `wrong flattened shape:\n${stText}`);
});

check('an unresolvable chain is left untouched (conservative)', () => {
    // Base missing entirely (e.g. a library struct), and a chain whose root is missing.
    assert.ok(convert(CHILD, { structs: new Map() }).includes('TYPE ST_Child EXTENDS ST_Parent :'));
    const partial = collectStructDefinitions([PARENT].map(parseTwinCatXml)); // ST_Grand unknown
    assert.ok(convert(CHILD, { structs: partial }).includes('TYPE ST_Child EXTENDS ST_Parent :'));
});

check('an EXTENDS cycle is left untouched and does not hang', () => {
    const a = dut('ST_A', 'TYPE ST_A EXTENDS ST_B :\nSTRUCT\n\ta : INT;\nEND_STRUCT\nEND_TYPE');
    const b = dut('ST_B', 'TYPE ST_B EXTENDS ST_A :\nSTRUCT\n\tb : INT;\nEND_STRUCT\nEND_TYPE');
    const structs = collectStructDefinitions([a, b].map(parseTwinCatXml));
    assert.ok(convert(a, { structs }).includes('TYPE ST_A EXTENDS ST_B :'));
});

check('raw mode never flattens, even with a registry', () => {
    const structs = collectStructDefinitions([GRAND, PARENT, CHILD].map(parseTwinCatXml));
    assert.ok(convert(CHILD, { raw: true, structs }).includes('TYPE ST_Child EXTENDS ST_Parent :'));
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
