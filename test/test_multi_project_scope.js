/**
 * @file test_multi_project_scope.js
 * @description Two PLC projects under one workspace folder must not contaminate each other.
 *
 * The bug this guards (reported 2026-08-06, reproduced on this exact fixture): the symbol index was
 * one flat name-keyed map for the whole workspace, so LineA's and LineB's same-named objects
 * collapsed onto one key. Measured before the fix: 38 object files produced 19 index entries, every
 * shared name resolved to LineB, LineA's correct MAIN reported `"fbDerived" is not a member of type
 * "GVL_System"`, and Find References returned 7 hits of which 3 were in the wrong project.
 *
 * Two more regressions from the same partition (final whole-branch review, 2026-08-07) are covered
 * near the TOP of this file, ahead of the `sampleAvailable()` gate — both are self-contained synthetic
 * fixtures that need no sample/, unlike everything below the gate:
 *   - CRITICAL: `library-signatures.xml` is a WORKSPACE-level artifact (written to `folders[0].fsPath`
 *     by `twincat.updateLibraryDefinitions` — see libraryCommands.js), normally sitting ABOVE the
 *     `.plcproj` directory. `indexLibraries` used to scan only `project.dir` downward, so the dump was
 *     unreachable by construction on every normal TwinCAT layout, including single-project ones.
 *   - IMPORTANT: a loose `.st` outside every project directory used to route to the `(loose)` index,
 *     which no project's own document ever consults — invisible where the old flat index made it
 *     visible everywhere.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sampleAvailable, buildTwoProjectFixture, objectPath } = require('./_multiproject');

const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { createProjectMap, normalizeProjectPath } = require('../src/lsp/projectMap');
const { scanWorkspace } = require('../src/lsp/workspaceScan');
const { parseAndIndexDocument } = require('../src/lsp/parser');
const {
    provideDiagnostics,
    provideReferences,
    findConfigReferencesForSymbol
} = require('../src/lsp/features');
const { indexLibraryNamespaces, isLibraryNamespace, clearLibraryNamespaces } = require('../src/lsp/libraries');
const {
    indexLibraryTitles,
    getLibraryCatalog,
    getUnionLibraryCatalog,
    clearLibrarySymbols,
    indexLibrarySymbols,
    indexTypeSystem,
    indexLibrarySignatures,
    indexBrowserCache,
    registerLibrarySymbolNodes,
    isLibrarySymbol
} = require('../src/lsp/libsymbols');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// =====================================================================================================
// CRITICAL — library-signatures.xml is a WORKSPACE-level artifact, not a per-project one (review
// finding, 2026-08-07). Reproduced by the reviewer on a SINGLE-project workspace as the real
// `"Identifier \"cProbeMax\" is not declared in the current scope."` — this fixture uses that exact
// identifier. Drives scanWorkspace with a REAL (non-stub) indexLibraries: the stub every other section
// of this file uses for `deps.indexLibraries` is exactly why nine prior task reviews missed this bug —
// it never exercises the callback the bug lives in. server.js cannot be required standalone (it opens
// an IPC connection at require time — see HANDOFF.md "Diagnostics: how to measure"), so this mirrors
// its indexLibraries composition, including the fix under test: scan every workspace root for a
// signatures dump, in addition to `dir`.
// =====================================================================================================
/**
 * A real (non-stub) indexLibraries, mirroring src/lsp/server.js's own.
 * @param {string} dir Project directory.
 * @param {Object} index The project's symbol index.
 * @param {Array<string>} roots Workspace roots.
 */
function realIndexLibraries(dir, index, roots) {
    indexLibraryNamespaces(dir, index);
    indexLibrarySymbols(dir, index);
    indexTypeSystem(dir, index);
    indexLibrarySignatures(dir, index);
    // THE FIX UNDER TEST: library-signatures.xml normally sits ABOVE `dir` (the .plcproj directory),
    // and indexLibrarySignatures only scans DOWNWARD — so a scan rooted at `dir` alone can never reach
    // it. Scan every workspace root too (skipping one that IS `dir`, already scanned above).
    for (const root of roots || []) {
        if (normalizeProjectPath(root) === normalizeProjectPath(dir)) continue;
        indexLibrarySignatures(root, index);
    }
    indexBrowserCache(dir, index);
}

const sigRoot = path.join(os.tmpdir(), 'tc_sigroot_' + process.pid + '_' + Date.now());
const sigProjDir = path.join(sigRoot, 'Machine');
fs.mkdirSync(path.join(sigProjDir, 'POUs'), { recursive: true });

// The dump sits at the WORKSPACE ROOT — exactly where twincat.updateLibraryDefinitions writes it — one
// level ABOVE the .plcproj directory, which is the normal TwinCAT layout (a .plcproj is always at
// least one directory below the workspace root XAE opens).
fs.writeFileSync(path.join(sigRoot, 'library-signatures.xml'), `<?xml version="1.0"?>
<LibrarySignatures>
  <Library>
    <LibraryName>Tc_ProbeLib</LibraryName><Version>1.0.0.0</Version><Distributor>Acme</Distributor>
    <TypeSignatures>
      <TypeSignature type="VarGlobal"><Name>ProbeGlobals</Name>
        <Constants><Constant><Name>cProbeMax</Name><DataType>INT</DataType></Constant></Constants>
      </TypeSignature>
    </TypeSignatures>
  </Library>
</LibrarySignatures>`);

fs.writeFileSync(path.join(sigProjDir, 'Machine.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\MAIN.TcPOU"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`);

const sigMain = path.join(sigProjDir, 'POUs', 'MAIN.TcPOU');
fs.writeFileSync(sigMain, `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="MAIN" Id="{c0000000-0000-4a00-8a00-0000000000aa}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM MAIN
VAR
	n : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[n := cProbeMax;]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`);

const sigWs = scanWorkspace([sigRoot], { indexLibraries: realIndexLibraries });
const sigKey = normalizeProjectPath(path.join(sigProjDir, 'Machine.plcproj'));
const sigIndex = sigWs.indexForKey(sigKey);

assert(isLibrarySymbol('cProbeMax', sigIndex),
    'the signature-only global constant cProbeMax IS reachable from a .plcproj BELOW the workspace ' +
    'root where the dump lives (the CRITICAL fix under test)');

/**
 * Diagnoses one object the way server.js does — including the library-symbol registration step the
 * shared `diagnose()` helper further down in this file (pre-existing, LineA/LineB section) omits,
 * because that section never references a library symbol and so never needed it.
 * @param {string} file Absolute object path.
 * @param {Object} index The owning project's index.
 * @returns {Array<Object>} Diagnostics.
 */
function diagnoseWithLibs(file, index) {
    const parsed = parseTwinCatXml(fs.readFileSync(file, 'utf8'));
    const { stText } = convertXmlToSt(parsed, { raw: true });
    const uri = 'file:///' + file.replace(/\\/g, '/').replace(/^\//, '');
    parseAndIndexDocument(stText, uri, index);
    registerLibrarySymbolNodes(index, stText);
    return provideDiagnostics(stText, index, uri);
}

const sigDiags = diagnoseWithLibs(sigMain, sigIndex);
assert(sigDiags.length === 0,
    `MAIN referencing the workspace-root signature symbol scores 0 diagnostics ` +
    `(got ${sigDiags.length}: ${sigDiags.map(d => d.message).join(' | ')})`);

fs.rmSync(sigRoot, { recursive: true, force: true });

// =====================================================================================================
// IMPORTANT — a loose .st outside every project directory must still be visible to the project(s) in
// this workspace (review finding, 2026-08-07). routeFile used to send it to the `(loose)` index, which
// no project's own document ever queries — the old (single flat index) behaviour made every .st visible
// everywhere, and there is no correctness argument for hiding one now: a .st is not a `.plcproj`
// compilation unit. Reproduced on a SINGLE-project workspace with Shared.st at the workspace root
// declaring FB_SharedHelper, and a POU declaring a variable of that type.
// =====================================================================================================
const looseRoot = path.join(os.tmpdir(), 'tc_loosest_' + process.pid + '_' + Date.now());
const looseProjDir = path.join(looseRoot, 'Machine');
fs.mkdirSync(path.join(looseProjDir, 'POUs'), { recursive: true });

// A loose .st at the WORKSPACE ROOT — not inside any .plcproj directory.
fs.writeFileSync(path.join(looseRoot, 'Shared.st'), `FUNCTION_BLOCK FB_SharedHelper
VAR
	n : INT;
END_VAR`);

fs.writeFileSync(path.join(looseProjDir, 'Machine.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\MAIN.TcPOU"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`);

const looseMain = path.join(looseProjDir, 'POUs', 'MAIN.TcPOU');
fs.writeFileSync(looseMain, `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="MAIN" Id="{c0000000-0000-4a00-8a00-0000000000bb}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM MAIN
VAR
	fbHelper : FB_SharedHelper;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[fbHelper();]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`);

const looseWs = scanWorkspace([looseRoot], { indexLibraries: () => {} });
const looseKey = normalizeProjectPath(path.join(looseProjDir, 'Machine.plcproj'));
const looseIndex = looseWs.indexForKey(looseKey);

assert(!!looseIndex['FB_SharedHelper'],
    "a loose .st outside every project directory IS indexed into the (single) project's own index " +
    '(the IMPORTANT fix under test — it used to land only in the unreachable (loose) index)');

function diagnoseLoose(file, index) {
    const parsed = parseTwinCatXml(fs.readFileSync(file, 'utf8'));
    const { stText } = convertXmlToSt(parsed, { raw: true });
    const uri = 'file:///' + file.replace(/\\/g, '/').replace(/^\//, '');
    parseAndIndexDocument(stText, uri, index);
    return provideDiagnostics(stText, index, uri);
}

const looseDiags = diagnoseLoose(looseMain, looseIndex);
assert(looseDiags.length === 0,
    `MAIN declaring a variable of the loose-.st type FB_SharedHelper scores 0 diagnostics ` +
    `(got ${looseDiags.length}: ${looseDiags.map(d => d.message).join(' | ')})`);

fs.rmSync(looseRoot, { recursive: true, force: true });

// =====================================================================================================
// Everything below needs the committed sample/ fixture.
// =====================================================================================================
if (!sampleAvailable()) {
    console.log('sample/ project not present — skipping the remaining (sample-based) multi-project scope tests.');
    console.log(`\n--- MULTI-PROJECT SCOPE TESTS COMPLETE with ${errors} error(s) ---`);
    process.exit(errors > 0 ? 1 : 0);
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

// --- node uris carry the ON-DISK spelling, never the normalized (lowercased) one ---------------
// 0.6.0 regression (user report 2026-08-10, root-caused in a real dev host): the scan indexed each
// object from the partition's NORMALIZED path, so every scan-time node uri was fully lowercased.
// The webview compares node uris against VS Code's real-cased document uri to pick same-file vs
// cross-file navigation, and vscode.openWith() treats a differently-cased uri as a DIFFERENT
// resource — so every cross-file Go to Definition / reference click opened a DUPLICATE tab titled
// "gvl_system.tcgvl" with nothing highlighted, which reads as "definitions are broken". The
// i-flagged assertions above cannot catch this; these pin the exact casing.
assert(indexes.get(keyA)['MAIN'].uri.includes('POUs/MAIN.TcPOU'),
    `scan-time node uris keep the on-disk spelling (got ${indexes.get(keyA)['MAIN'].uri})`);
assert(indexes.get(keyA)['GVL_System'].uri.includes('GVLs/GVL_System.TcGVL'),
    `a GVL node uri keeps its on-disk spelling (got ${indexes.get(keyA)['GVL_System'].uri})`);

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
    const uri = 'file:///' + file.replace(/\\/g, '/').replace(/^\//, '');
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
assert(ws.indexForUri('file:///' + mainA.replace(/\\/g, '/').replace(/^\//, '')) === indexes.get(keyA),
    "the scan routes a request for LineA's MAIN to LineA's index");
assert(ws.indexForUri('file:///' + mainB.replace(/\\/g, '/').replace(/^\//, '')) === indexes.get(keyB),
    "the scan routes a request for LineB's MAIN to LineB's index");

// --- library namespaces are per project ------------------------------------------------------
// LineB additionally references a library LineA does not. A namespace known only to B must not
// silence B's namespace head inside A (that is a diagnostic suppressed on the wrong project).
// (indexLibraryNamespaces/isLibraryNamespace/clearLibraryNamespaces are required at the top of this file.)

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
// (indexLibraryTitles/getLibraryCatalog/getUnionLibraryCatalog/clearLibrarySymbols are required at the
// top of this file.)

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

// --- a rename's config scan never leaves its own project --------------------------------------
// The sample ships XAE's PlcTask.TcTTO, which names MAIN in a <PouCall>; both copies have one.
// Before per-project indexes, renaming the MAIN that won the flat index rewrote BOTH task files
// (measured: 2 occurrences, one of them in the other project), while renaming the MAIN that lost
// resolved to nothing at all and silently skipped the config update.
// (findConfigReferencesForSymbol is required at the top of this file.)

const uriA = 'file:///' + mainA.replace(/\\/g, '/').replace(/^\//, '');
const uriB = 'file:///' + mainB.replace(/\\/g, '/').replace(/^\//, '');

// Both directions must now resolve — neither project is a "loser" any more.
const fromA = findConfigReferencesForSymbol(
    { rootName: 'MAIN', fileUri: uriA }, ws.indexForUri(uriA), ws.configFilesFor(uriA));
const fromB = findConfigReferencesForSymbol(
    { rootName: 'MAIN', fileUri: uriB }, ws.indexForUri(uriB), ws.configFilesFor(uriB));

assert(fromA.resolved, "renaming LineA's MAIN resolves (the identity guard no longer rejects it)");
assert(fromB.resolved, "renaming LineB's MAIN resolves");
assert(fromA.occurrences.length > 0, `LineA's task config is found (got ${fromA.occurrences.length})`);
assert(fromA.occurrences.every(o => /LineA/i.test(o.uri)),
    `renaming LineA's MAIN touches only LineA (leaked: ${fromA.occurrences.filter(o => !/LineA/i.test(o.uri)).map(o => o.uri).join(', ')})`);
assert(fromB.occurrences.every(o => /LineB/i.test(o.uri)),
    `renaming LineB's MAIN touches only LineB (leaked: ${fromB.occurrences.filter(o => !/LineB/i.test(o.uri)).map(o => o.uri).join(', ')})`);

// The scoping is in configFilesFor, so assert it directly too — a future refactor that widens the
// walk would still pass the assertions above by luck if the matcher happened not to hit.
const filesA = ws.configFilesFor(uriA);
assert(filesA.length > 0, `LineA has config objects to scan (got ${filesA.length})`);
assert(filesA.every(f => /LineA/i.test(f)),
    `configFilesFor never offers another project's files (leaked: ${filesA.filter(f => !/LineA/i.test(f)).join(', ')})`);

// And pin the hazard: handed BOTH projects' files, the matcher does cross over. This is why the
// scoping must live in the file-collection step and not be left to the matcher.
const unscoped = findConfigReferencesForSymbol(
    { rootName: 'MAIN', fileUri: uriB },
    ws.indexForUri(uriB),
    filesA.concat(ws.configFilesFor(uriB))
);
assert(unscoped.occurrences.some(o => /LineA/i.test(o.uri)),
    'sanity: an UNSCOPED file list does reach the other project — the guard above is load-bearing');

fx.cleanup();
console.log(`\n--- MULTI-PROJECT SCOPE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
