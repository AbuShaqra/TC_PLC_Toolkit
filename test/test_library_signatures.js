'use strict';

// Tests the ProduceAllLibrarySignatures parser (src/lsp/librarySignatures.js) against a self-contained
// synthetic fixture, then — if the real captured sample is present in the scratchpad — validates the
// parser against it too and prints a coverage summary. Standalone Node, no VS Code.

const fs = require('fs');
const path = require('path');
const { parseLibrarySignaturesXml, toRegistryTypes } = require('../src/lsp/librarySignatures');

let errors = 0;
function ok(cond, msg) { console.log(`${cond ? '[PASS]' : '[FAIL]'} ${msg}`); if (!cond) errors++; }
function eq(actual, expected, msg) { ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`); }

const FIXTURE = `<?xml version="1.0"?>
<LibrarySignatures>
  <Library>
    <LibraryName>Tc_Test</LibraryName><Version>1.2.3.4</Version><Distributor>Acme GmbH</Distributor>
    <TypeSignatures>
      <TypeSignature type="Function"><Name>CONCAT</Name><Comment>joins two strings</Comment>
        <Inputs>
          <Input><Name>STR1</Name><DataType>STRING(255)</DataType></Input>
          <Input><Name>STR2</Name><DataType>STRING(255)</DataType></Input>
        </Inputs>
        <Outputs><Output><Name>CONCAT</Name><DataType>STRING(255)</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="FunctionBlock"><Name>FB_Foo</Name>
        <Inputs><Input><Name>bEnable</Name><DataType>BOOL</DataType></Input></Inputs>
        <Outputs><Output><Name>initStatus</Name><DataType>HRESULT</DataType></Output></Outputs>
        <InOuts><InOut><Name>arr</Name><DataType>ARRAY [0..9] OF INT</DataType></InOut></InOuts>
      </TypeSignature>
      <TypeSignature type="Type"><Name>ST_Bar</Name><Comment>a struct with no fields exported</Comment></TypeSignature>
      <TypeSignature type="Interface"><Name>IFoo</Name></TypeSignature>
      <TypeSignature type="VarGlobal"><Name>Globals</Name>
        <Constants><Constant><Name>cMax</Name><DataType>INT</DataType></Constant></Constants>
      </TypeSignature>
    </TypeSignatures>
  </Library>
</LibrarySignatures>`;

console.log('--- synthetic fixture ---');
const parsed = parseLibrarySignaturesXml(FIXTURE);
eq(parsed.libraries.length, 1, 'one library parsed');
const lib = parsed.libraries[0];
eq(lib.name, 'Tc_Test', 'library name');
eq(lib.version, '1.2.3.4', 'library version');
eq(lib.distributor, 'Acme GmbH', 'library distributor');

eq(lib.functions.length, 1, 'one function');
const fn = lib.functions[0];
eq(fn.name, 'CONCAT', 'function name');
eq(fn.inputs.length, 2, 'CONCAT has 2 inputs');
eq(fn.inputs[0].name, 'STR1', 'first input name');
eq(fn.inputs[0].type, 'STRING(255)', 'input datatype with parens preserved');
eq(fn.inputs[0].scope, 'VAR_INPUT', 'input scope');
eq(fn.returnType, 'STRING(255)', 'function return type from its like-named Output');

eq(lib.functionBlocks.length, 1, 'one function block');
const fb = lib.functionBlocks[0];
eq(fb.name, 'FB_Foo', 'fb name');
eq(fb.inputs[0].scope, 'VAR_INPUT', 'fb input scope');
eq(fb.outputs[0].name, 'initStatus', 'fb output name');
eq(fb.outputs[0].scope, 'VAR_OUTPUT', 'fb output scope');
eq(fb.inouts[0].name, 'arr', 'fb inout name');
eq(fb.inouts[0].scope, 'VAR_IN_OUT', 'fb inout scope');

eq(lib.types.length, 1, 'one bare type');
eq(lib.types[0], 'ST_Bar', 'type name (no members expected)');
eq(lib.interfaces.length, 1, 'one interface');
eq(lib.interfaces[0], 'IFoo', 'interface name');
eq(lib.globals.length, 1, 'one global var list');
eq(lib.globals[0].constants[0].name, 'cMax', 'global constant name');

console.log('--- registry mapping ---');
const reg = toRegistryTypes(parsed);
const byName = Object.fromEntries(reg.types.map(t => [t.name, t]));
eq(byName.FB_Foo.kind, 'fb', 'FB_Foo maps to kind fb');
eq(byName.FB_Foo.members.length, 3, 'FB_Foo carries input+output+inout as members');
eq(byName.FB_Foo.namespace, 'Tc_Test', 'FB_Foo namespace is the library');
eq(byName.CONCAT.kind, 'function', 'CONCAT maps to kind function');
eq(byName.CONCAT.returnType, 'STRING(255)', 'CONCAT carries its return type');
eq(byName.CONCAT.members.length, 2, 'CONCAT carries its inputs as members');
eq(byName.ST_Bar.kind, 'opaque', 'bare Type maps to opaque');
eq(byName.ST_Bar.members.length, 0, 'bare Type has no members');
ok(reg.symbols.includes('cMax'), 'global constant surfaces as a symbol name');
ok(reg.symbols.includes('Globals'), 'global var-list name surfaces as a symbol');

// Malformed input must not throw.
ok(parseLibrarySignaturesXml('').libraries.length === 0, 'empty string yields no libraries');
ok(parseLibrarySignaturesXml(null).libraries.length === 0, 'null yields no libraries');

// --- optional: validate against the real captured sample if it is present ---
const SAMPLE = path.join(
    process.env.LOCALAPPDATA || '', 'Temp', 'claude', 'c--Software-TC-PLC-Toolkit',
    '9333d0c6-ebfb-4eec-9842-ff7d99f18bfe', 'scratchpad', 'keep_signatures_sample.xml'
);
if (fs.existsSync(SAMPLE)) {
    console.log('--- real sample (keep_signatures_sample.xml) ---');
    const real = parseLibrarySignaturesXml(fs.readFileSync(SAMPLE, 'utf8'));
    const totF = real.libraries.reduce((n, l) => n + l.functions.length, 0);
    const totFB = real.libraries.reduce((n, l) => n + l.functionBlocks.length, 0);
    ok(real.libraries.length >= 4, `parsed ${real.libraries.length} libraries`);
    ok(totF > 100, `parsed ${totF} functions (new capability vs .tmc, which has none)`);
    const jsonLib = real.libraries.find(l => l.name === 'Tc3_JsonXml');
    if (jsonLib) {
        const parser = jsonLib.functionBlocks.find(f => f.name === 'FB_JsonDomParser');
        ok(!!parser, 'FB_JsonDomParser present in signatures');
        // confirms the known limitation: signatures carry FB I/O but NOT methods
        console.log(`   FB_JsonDomParser: ${parser ? parser.inputs.length : 0} inputs, ${parser ? parser.outputs.length : 0} outputs, 0 methods (as expected)`);
    }
    console.log(`   totals: ${totFB} function blocks, ${totF} functions across ${real.libraries.length} libraries`);
} else {
    console.log('(real sample not present — skipping; synthetic fixture covers the parser)');
}

console.log(`\n--- LIBRARY SIGNATURES TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors ? 1 : 0);
