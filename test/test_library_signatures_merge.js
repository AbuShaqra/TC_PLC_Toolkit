'use strict';

// Tests the merge of ProduceAllLibrarySignatures data into the workspace type registry
// (libsymbols.js indexLibrarySignatures / indexLibrarySignaturesFromXml). The parser itself is covered
// by test_library_signatures.js; this harness proves the *registry* side of Part 2:
//   1. a signature-only FB becomes a typeSystemTypes 'fb' with scoped members, namespace-attributed;
//   2. a `.tmc`-style struct that already carries members is NOT overwritten by a same-named opaque
//      signature Type (the `.tmc` wins);
//   3. a signature Function yields a 'function' record with its return type, and the node it produces
//      stays anonymous UNKNOWN in the type model (so it is never diagnostic-validated);
//   4. global var-list names and their constants land in the flat library-symbol registry.
// Standalone Node, no VS Code.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    indexLibrarySignaturesFromXml,
    indexTypeSystem,
    indexLibraryTitles,
    clearLibrarySymbols,
    getLibraryType,
    getTypeSystemNamespaceTypes,
    isLibrarySymbol,
    registerLibrarySymbolNodes
} = require('../src/lsp/libsymbols');
const { typeFromNode, UNKNOWN } = require('../src/lsp/types');

let errors = 0;
function ok(cond, msg) { console.log(`${cond ? '[PASS]' : '[FAIL]'} ${msg}`); if (!cond) errors++; }
function eq(actual, expected, msg) { ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`); }

// A signatures dump: one FB (in/out/inout), one Function with a return type, one bare Type that
// collides by name with a `.tmc` struct we seed below, and one global constant list.
// NB the LibraryName is the library's TITLE, not its namespace, and the two DIFFER here on purpose:
// that is exactly the shape of the real bug this guards (`TwinCat Dynamic Collections` in the dump vs
// `TcDynCollections` in code). A title is not even a legal identifier — it has spaces.
const SIG_XML = `<?xml version="1.0"?>
<LibrarySignatures>
  <Library>
    <LibraryName>Sig Test Library</LibraryName><Version>1.0.0.0</Version><Distributor>Acme</Distributor>
    <TypeSignatures>
      <TypeSignature type="FunctionBlock"><Name>FB_SigOnly</Name>
        <Inputs><Input><Name>bEnable</Name><DataType>BOOL</DataType></Input></Inputs>
        <Outputs><Output><Name>nStatus</Name><DataType>DINT</DataType></Output></Outputs>
        <InOuts><InOut><Name>arr</Name><DataType>ARRAY [0..3] OF INT</DataType></InOut></InOuts>
      </TypeSignature>
      <TypeSignature type="Function"><Name>F_SigFunc</Name>
        <Inputs><Input><Name>x</Name><DataType>LREAL</DataType></Input></Inputs>
        <Outputs><Output><Name>F_SigFunc</Name><DataType>LREAL</DataType></Output></Outputs>
      </TypeSignature>
      <TypeSignature type="Type"><Name>ST_Seeded</Name></TypeSignature>
      <TypeSignature type="VarGlobal"><Name>SigGlobals</Name>
        <Constants><Constant><Name>cSigMax</Name><DataType>INT</DataType></Constant></Constants>
      </TypeSignature>
    </TypeSignatures>
  </Library>
</LibrarySignatures>`;

// A minimal `.tmc` seeding a member-bearing struct ST_Seeded, so the merge has something to protect.
const TMC_XML = `<?xml version="1.0"?>
<TcModuleClass>
  <DataTypes>
    <DataType>
      <Name>ST_Seeded</Name>
      <SubItem><Name>fromTmc</Name><Type>LREAL</Type></SubItem>
    </DataType>
  </DataTypes>
</TcModuleClass>`;

// The .plcproj is the ONLY place that maps a library's title to the namespace you type in ST. Without
// it the signatures dump cannot be attributed to anything, so seed one — with the title deliberately
// different from the namespace.
const PLCPROJ_XML = `<?xml version="1.0"?>
<Project>
  <ItemGroup>
    <PlaceholderReference Include="Sig Test Library">
      <DefaultResolution>Sig Test Library, * (Acme)</DefaultResolution>
      <Namespace>Tc_SigTest</Namespace>
    </PlaceholderReference>
  </ItemGroup>
</Project>`;

// Seed the `.tmc` struct and the .plcproj by driving the real indexers over a temp fixture (there is no
// public setter for typeSystemTypes, and driving the real indexer is exactly the path production uses).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmerge-'));
fs.writeFileSync(path.join(tmpDir, 'fixture.tmc'), TMC_XML, 'utf8');
fs.writeFileSync(path.join(tmpDir, 'fixture.plcproj'), PLCPROJ_XML, 'utf8');

clearLibrarySymbols();
indexLibraryTitles(tmpDir);   // must precede the merge: it builds the title -> namespace map
indexTypeSystem(tmpDir);

const seededBefore = getLibraryType('ST_Seeded');
eq(seededBefore ? seededBefore.kind : null, 'struct', 'seed: ST_Seeded is a struct from the .tmc');
eq(seededBefore ? seededBefore.members.length : 0, 1, 'seed: ST_Seeded has 1 member before the merge');

// --- the merge under test ---
const stats = indexLibrarySignaturesFromXml(SIG_XML);

console.log('--- merge stats ---');
eq(stats.functions, 1, 'stats: one function parsed');
eq(stats.functionBlocks, 1, 'stats: one function block parsed');
ok(stats.added >= 2, `stats: at least FB + function inserted (added=${stats.added})`);

console.log('--- (1) signature-only FB ---');
const fb = getLibraryType('FB_SigOnly');
ok(!!fb, 'FB_SigOnly is now a registry type');
eq(fb.kind, 'fb', 'FB_SigOnly kind is fb');
eq(fb.members.length, 3, 'FB_SigOnly carries input+output+inout as members');
const scopes = fb.members.map(m => m.scope).sort();
ok(scopes.includes('VAR_INPUT') && scopes.includes('VAR_OUTPUT') && scopes.includes('VAR_IN_OUT'),
    `FB_SigOnly members are scoped (${scopes.join(',')})`);
// REGRESSION (the Libraries view showed empty libraries): the dump names a library by TITLE, but every
// lookup keys on NAMESPACE. Attribute by title and the tree finds nothing under TcDynCollections.
const nsTypes = getTypeSystemNamespaceTypes('Tc_SigTest').map(t => t.name);
ok(nsTypes.includes('FB_SigOnly'), `FB_SigOnly attributed to the NAMESPACE Tc_SigTest (${nsTypes.join(',')})`);
eq(getTypeSystemNamespaceTypes('Sig Test Library').length, 0,
    'nothing is attributed under the library TITLE — a title is not a namespace');
ok(isLibrarySymbol('FB_SigOnly'), 'FB_SigOnly is a library symbol');

console.log('--- (2) `.tmc` wins over an opaque signature ---');
const seededAfter = getLibraryType('ST_Seeded');
eq(seededAfter.kind, 'struct', 'ST_Seeded stays a struct (not clobbered to opaque)');
eq(seededAfter.members.length, 1, 'ST_Seeded keeps its .tmc member');
eq(seededAfter.members[0].name, 'fromTmc', 'ST_Seeded still has its .tmc field name');
// The namespace list must not have gained a duplicate ST_Seeded (the .tmc had no namespace here, so
// it should appear zero times under Tc_SigTest — the opaque signature entry must not have leaked in).
const seededInNs = getTypeSystemNamespaceTypes('Tc_SigTest').filter(t => t.name.toLowerCase() === 'st_seeded');
eq(seededInNs.length, 0, 'the opaque ST_Seeded signature did not leak into the namespace list');

console.log('--- (3) function keeps its return type and stays UNKNOWN in the model ---');
const fn = getLibraryType('F_SigFunc');
ok(!!fn, 'F_SigFunc is now a registry type');
eq(fn.kind, 'function', 'F_SigFunc kind is function');
eq(fn.returnType, 'LREAL', 'F_SigFunc carries its return type');
// The node built for a library function must stay anonymous UNKNOWN, or getCallParams/typeFromNode
// would start validating it — the exact false-positive class this design forbids.
const index = {};
registerLibrarySymbolNodes(index, 'PROGRAM P VAR END_VAR F_SigFunc(x := 1.0); FB_SigOnly(); END_PROGRAM');
const fnNode = index['F_SigFunc'];
ok(!!fnNode, 'F_SigFunc node registered into the index');
eq(fnNode.libKind, 'function', 'F_SigFunc node libKind is function');
eq(fnNode.returnType, 'LREAL', 'F_SigFunc node carries returnType for completion detail');
const modelled = typeFromNode(fnNode);
eq(modelled.kind, UNKNOWN.kind, 'typeFromNode maps a library function to UNKNOWN (never validated)');
eq(modelled.name, UNKNOWN.name, 'the UNKNOWN is anonymous (empty name), so declarationTypes cannot flag it');
// And the FB node is a proper external fb node (completion uses its members).
const fbNode = index['FB_SigOnly'];
eq(fbNode.libKind, 'fb', 'FB_SigOnly node libKind is fb');
eq(fbNode.external, true, 'FB_SigOnly node is external (so getCallParams declines it)');

console.log('--- (4) globals land in the flat registry ---');
ok(isLibrarySymbol('SigGlobals'), 'global var-list name SigGlobals is a library symbol');
ok(isLibrarySymbol('cSigMax'), 'global constant cSigMax is a library symbol');

// Cleanup the temp fixture; leave the registry as the next harness expects (each harness clears anyway).
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
clearLibrarySymbols();

console.log(`\n--- LIBRARY SIGNATURES MERGE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors ? 1 : 0);
