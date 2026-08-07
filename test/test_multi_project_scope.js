/**
 * @file test_multi_project_scope.js
 * @description Two PLC projects under one workspace folder must not contaminate each other.
 *
 * The bug this guards (reported 2026-08-06, reproduced on this exact fixture): the symbol index was
 * one flat name-keyed map for the whole workspace, so LineA's and LineB's same-named objects
 * collapsed onto one key. Measured before the fix: 38 object files produced 19 index entries, every
 * shared name resolved to LineB, LineA's correct MAIN reported `"fbDerived" is not a member of type
 * "GVL_System"`, and Find References returned 7 hits of which 3 were in the wrong project.
 */

const fs = require('fs');
const path = require('path');
const { sampleAvailable, buildTwoProjectFixture, objectPath } = require('./_multiproject');

if (!sampleAvailable()) {
    console.log('sample/ project not present — skipping multi-project scope test.');
    process.exit(0);
}

const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { createProjectMap, normalizeProjectPath } = require('../src/lsp/projectMap');
const { scanWorkspace } = require('../src/lsp/workspaceScan');
const { parseAndIndexDocument } = require('../src/lsp/parser');
const { provideDiagnostics, provideReferences } = require('../src/lsp/features');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const fx = buildTwoProjectFixture();
const map = createProjectMap([fx.root]);
const keyA = normalizeProjectPath(fx.plcprojA);
const keyB = normalizeProjectPath(fx.plcprojB);

// --- the partition -------------------------------------------------------------------------
assert(map.projects.size === 2, `two projects are discovered (got ${map.projects.size})`);
const objectsA = map.get(keyA).objectPaths;
const objectsB = map.get(keyB).objectPaths;
assert(objectsA.size === objectsB.size && objectsA.size > 0,
    `both projects compile the same object count (${objectsA.size})`);
assert([...objectsA].every(p => !objectsB.has(p)), 'no object path is shared between the two copies');

// --- one index per project, built by the REAL scan --------------------------------------------
// Libraries are stubbed out: this harness is about the partition, and Task 3 covers the registries.
const ws = scanWorkspace([fx.root], { indexLibraries: () => {} });
const indexes = ws.indexes;
assert(indexes.size === 2, `the scan produces one index per project (got ${indexes.size})`);

const namesA = Object.keys(indexes.get(keyA));
const namesB = Object.keys(indexes.get(keyB));
assert(namesA.length === objectsA.size,
    `LineA indexes every one of its objects (${namesA.length} of ${objectsA.size}) — nothing is lost to a collision`);
assert(namesB.length === objectsB.size,
    `LineB indexes every one of its objects (${namesB.length} of ${objectsB.size})`);
assert(/LineA/i.test(indexes.get(keyA)['GVL_System'].uri), "LineA's GVL_System resolves inside LineA");
assert(/LineB/i.test(indexes.get(keyB)['GVL_System'].uri), "LineB's GVL_System resolves inside LineB");
assert(/LineA/i.test(indexes.get(keyA)['MAIN'].uri), "LineA's MAIN resolves inside LineA");

// --- diagnostics: correct code in BOTH projects scores zero ---------------------------------
/**
 * Diagnoses one object the way server.js does.
 * @param {string} file Absolute object path.
 * @param {Object} index The owning project's index.
 * @returns {{diags: Array<Object>, stText: string, uri: string}}
 */
function diagnose(file, index) {
    const parsed = parseTwinCatXml(fs.readFileSync(file, 'utf8'));
    const { stText } = convertXmlToSt(parsed, { raw: true });
    const uri = 'file:///' + file.replace(/\\/g, '/');
    parseAndIndexDocument(stText, uri, index);
    return { diags: provideDiagnostics(stText, index, uri), stText, uri };
}

const mainA = objectPath(fx.lineA, 'POUs/MAIN.TcPOU');
const a = diagnose(mainA, indexes.get(keyA));
assert(a.diags.length === 0,
    `LineA MAIN scores 0 diagnostics (got ${a.diags.length}: ${a.diags.map(d => d.message).join(' | ')})`);

const mainB = objectPath(fx.lineB, 'POUs/MAIN.TcPOU');
const b = diagnose(mainB, indexes.get(keyB));
// LineB genuinely calls a member its own GVL_System no longer declares — the fixture's divergence.
// It must be flagged in B and must NOT be silenced by A's copy.
assert(b.diags.some(d => /fbDerived/.test(d.message)),
    "LineB's own missing fbDerived is still reported in LineB (A's copy does not mask it)");

// --- references never cross the project boundary ---------------------------------------------
const lines = a.stText.split('\n');
const line = lines.findIndex(l => l.includes('GVL_System.fbCylinder'));
const character = lines[line].indexOf('GVL_System') + 2;
const refs = provideReferences(a.stText, { line, character }, indexes.get(keyA), a.uri) || [];
assert(refs.length > 0, `references are found at all (got ${refs.length})`);
assert(refs.every(r => /LineA/i.test(r.uri)),
    `every reference stays in LineA (leaked: ${refs.filter(r => !/LineA/i.test(r.uri)).map(r => r.uri).join(', ')})`);

// --- routing -----------------------------------------------------------------------------------
assert(map.projectFor(mainA) === keyA, 'a request for LineA MAIN routes to LineA');
assert(map.projectFor(mainB) === keyB, 'a request for LineB MAIN routes to LineB');
assert(ws.indexForUri('file:///' + mainA.replace(/\\/g, '/')) === indexes.get(keyA),
    "the scan routes a request for LineA's MAIN to LineA's index");
assert(ws.indexForUri('file:///' + mainB.replace(/\\/g, '/')) === indexes.get(keyB),
    "the scan routes a request for LineB's MAIN to LineB's index");

// --- library namespaces are per project ------------------------------------------------------
// LineB additionally references a library LineA does not. A namespace known only to B must not
// silence B's namespace head inside A (that is a diagnostic suppressed on the wrong project).
const { indexLibraryNamespaces, isLibraryNamespace, clearLibraryNamespaces } = require('../src/lsp/libraries');

const plcprojB = fs.readFileSync(fx.plcprojB, 'utf8').replace(
    '</Project>',
    `  <ItemGroup>
    <PlaceholderReference Include="Tc2_LineBOnly">
      <DefaultResolution>Tc2_LineBOnly, 1.0.0.0 (Beckhoff Automation GmbH)</DefaultResolution>
      <Namespace>Tc2_LineBOnly</Namespace>
    </PlaceholderReference>
  </ItemGroup>
</Project>`);
fs.writeFileSync(fx.plcprojB, plcprojB);

const idxA = indexes.get(keyA);
const idxB = indexes.get(keyB);
clearLibraryNamespaces(idxA);
clearLibraryNamespaces(idxB);
indexLibraryNamespaces(path.dirname(fx.plcprojA), idxA);
indexLibraryNamespaces(path.dirname(fx.plcprojB), idxB);

assert(isLibraryNamespace('Tc2_LineBOnly', idxB), "LineB knows its own library namespace");
assert(!isLibraryNamespace('Tc2_LineBOnly', idxA),
    "LineA does NOT know LineB's library namespace (registries are per project)");

// --- once a project index has been written, it never reads the default (no-index) registry --------
// This is the invariant the read/write split's whole safety argument rests on, and it is a DIFFERENT
// claim from the two assertions just above. Those prove idxA and idxB are isolated from EACH OTHER;
// they would pass identically under the design's literal single-function sketch (registryFor that
// creates-and-returns unconditionally), because by the time they run, idxA and idxB already have
// their OWN non-empty registries either way. The read/write split's actual, distinguishing behaviour
// only shows up for an index that is read before it is ever written — which is exactly the ~15
// pre-existing-harness scenario the split exists to bridge. So the regression this guards against is
// specific: a future change that makes the read side fall back to (or merge in) the default registry
// even for an index that already owns one — e.g. "let's also check the default for completeness".
//
// A marker namespace is indexed with NO index (landing only in the shared default registry). idxA and
// idxB — both already written to, above — must not see it: nothing indexed elsewhere, including the
// no-index default, may leak into an index that has its own registry.
const probeDir = path.join(fx.root, '_DefaultOnlyProbe');
fs.mkdirSync(probeDir);
fs.writeFileSync(path.join(probeDir, 'Marker.plcproj'), `<Project>
  <ItemGroup>
    <PlaceholderReference Include="Tc2_DefaultRegistryOnly">
      <DefaultResolution>Tc2_DefaultRegistryOnly, 1.0.0.0 (Beckhoff Automation GmbH)</DefaultResolution>
      <Namespace>Tc2_DefaultRegistryOnly</Namespace>
    </PlaceholderReference>
  </ItemGroup>
</Project>`);

clearLibraryNamespaces(); // clears the DEFAULT (no-index) registry only — idxA/idxB are untouched
indexLibraryNamespaces(probeDir); // NO index — lands in the shared default registry, nowhere else
assert(isLibraryNamespace('Tc2_DefaultRegistryOnly'),
    'sanity: the marker namespace really did land in the default (no-index) registry');

assert(!isLibraryNamespace('Tc2_DefaultRegistryOnly', idxA),
    "LineA's already-written registry does NOT see a namespace known only to the default registry");
assert(!isLibraryNamespace('Tc2_DefaultRegistryOnly', idxB),
    "LineB's already-written registry does NOT see a namespace known only to the default registry");

// --- the Libraries view falls back to the union when no project-specific catalog is resolved -------
// custom/libraries (server.js) composes exactly these two primitives — getLibraryCatalog(index) for a
// specific project, and getUnionLibraryCatalog(indexes) as the fallback when no fileUri is given, or
// the routed project's own catalog is empty. Tested at this level because server.js opens an IPC
// connection at require time and cannot be loaded standalone.
const { indexLibraryTitles, getLibraryCatalog, getUnionLibraryCatalog, clearLibrarySymbols } = require('../src/lsp/libsymbols');

clearLibrarySymbols(idxA);
clearLibrarySymbols(idxB);
indexLibraryTitles(path.dirname(fx.plcprojA), idxA);
indexLibraryTitles(path.dirname(fx.plcprojB), idxB);

const catalogA = getLibraryCatalog(idxA);
const catalogB = getLibraryCatalog(idxB);
assert(catalogA.length > 0, "LineA's own catalog is non-empty (sanity)");
assert(catalogB.length === catalogA.length + 1,
    `LineB's own catalog includes exactly the one extra Tc2_LineBOnly reference LineA does not have ` +
    `(A: ${catalogA.length}, B: ${catalogB.length})`);

// No fileUri (the extension host has not sent one), or a fileUri routing to an empty catalog: the
// union, not nothing — that is the actual fix for the Libraries-view regression this review found.
const union = getUnionLibraryCatalog(indexes.values());
assert(union.length > 0, 'the union catalog is non-empty even with no project specified');
assert(union.some(e => e.namespace.toLowerCase() === 'tc2_linebonly'),
    "the union includes LineB's extra namespace");
assert(union.length >= catalogB.length,
    'the union is at least as large as the biggest single project catalog — a true superset, never fewer');

// A fileUri that DOES resolve still narrows to that one project, exactly as before this fix.
assert(!catalogA.some(e => e.namespace.toLowerCase() === 'tc2_linebonly'),
    "LineA's own (non-union) catalog does NOT include LineB's namespace — narrowing still works");

fx.cleanup();
console.log(`\n--- MULTI-PROJECT SCOPE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
