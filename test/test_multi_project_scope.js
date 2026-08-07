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

fx.cleanup();
console.log(`\n--- MULTI-PROJECT SCOPE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
