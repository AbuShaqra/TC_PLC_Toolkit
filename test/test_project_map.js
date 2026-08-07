/**
 * @file test_project_map.js
 * @description The project map decides which .plcproj owns a file.
 *
 * Two PLC projects under one workspace folder is a normal TwinCAT layout, and each is its own
 * compilation unit — symbols do NOT resolve across them in XAE. Everything downstream (one symbol
 * index per project, scoped references, scoped rename) rests on this module getting ownership right.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    LOOSE_PROJECT_KEY,
    TWINCAT_EXTS,
    normalizeProjectPath,
    findPlcProjFiles,
    createProjectMap
} = require('../src/lsp/projectMap');
const { TWINCAT_EXTS: XML_INDEXER_TWINCAT_EXTS } = require('../src/lsp/xmlIndexer');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// --- TWINCAT_EXTS must stay in sync with xmlIndexer.js's own copy --------------------------
// projectMap.js is deliberately dependency-free, so it duplicates xmlIndexer.js's TWINCAT_EXTS
// rather than importing it. A real bug (found in review): projectMap.js's set was missing
// `.tctleo` (EnumerationTextList — a real ST enum), so scanWorkspace's Task-2 project-scoped scan
// silently dropped every .TcTLEO object's symbols from the index, on any project using the
// feature — a false "not declared" on real code. Asserting the two SETS are equal (not a fixed
// literal list) catches drift in either direction, not just a re-encoding of this one miss.
assert(TWINCAT_EXTS.size === XML_INDEXER_TWINCAT_EXTS.size &&
    [...TWINCAT_EXTS].every(ext => XML_INDEXER_TWINCAT_EXTS.has(ext)),
    `projectMap's TWINCAT_EXTS matches xmlIndexer's exactly ` +
    `(projectMap: ${[...TWINCAT_EXTS].sort().join(',')}; xmlIndexer: ${[...XML_INDEXER_TWINCAT_EXTS].sort().join(',')})`);

// A root with two sibling projects; LineB additionally links LineA's shared FB.
const ROOT = path.join(os.tmpdir(), 'projmap_' + Date.now());
const A = path.join(ROOT, 'LineA');
const B = path.join(ROOT, 'LineB');
fs.mkdirSync(path.join(A, 'POUs'), { recursive: true });
fs.mkdirSync(path.join(B, 'POUs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'Loose'), { recursive: true });

for (const dir of [A, B]) {
    fs.writeFileSync(path.join(dir, 'POUs', 'MAIN.TcPOU'), '<TcPlcObject/>');
    fs.writeFileSync(path.join(dir, 'POUs', 'Orphan.TcPOU'), '<TcPlcObject/>');
}
fs.writeFileSync(path.join(A, 'POUs', 'FB_Shared.TcPOU'), '<TcPlcObject/>');
fs.writeFileSync(path.join(ROOT, 'Loose', 'Stray.TcPOU'), '<TcPlcObject/>');

fs.writeFileSync(path.join(A, 'LineA.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\MAIN.TcPOU"><SubType>Code</SubType></Compile>
    <Compile Include="POUs\\FB_Shared.TcPOU"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`);
// LineB links LineA's FB_Shared — a real TwinCAT pattern (add existing item as link).
fs.writeFileSync(path.join(B, 'LineB.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\MAIN.TcPOU"><SubType>Code</SubType></Compile>
    <Compile Include="..\\LineA\\POUs\\FB_Shared.TcPOU"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`);

const map = createProjectMap([ROOT]);
const keyA = normalizeProjectPath(path.join(A, 'LineA.plcproj'));
const keyB = normalizeProjectPath(path.join(B, 'LineB.plcproj'));

// --- discovery -----------------------------------------------------------------------------
assert(findPlcProjFiles([ROOT]).length === 2, 'both .plcproj files are discovered');
assert(map.projects.size === 2, 'the map holds two projects');
assert(!map.isEmpty(), 'a root with projects is not empty');
assert(map.get(keyA).name === 'LineA', 'a project carries its display name');

// --- ownership -----------------------------------------------------------------------------
assert(map.projectFor(path.join(A, 'POUs', 'MAIN.TcPOU')) === keyA, "LineA's MAIN routes to LineA");
assert(map.projectFor(path.join(B, 'POUs', 'MAIN.TcPOU')) === keyB, "LineB's MAIN routes to LineB");
assert(map.get(keyA).objectPaths.size === 2, 'LineA <Compile>s exactly its two objects');
assert(map.get(keyB).objectPaths.has(normalizeProjectPath(path.join(A, 'POUs', 'FB_Shared.TcPOU'))),
    'the linked FB_Shared is in LineB\'s object set too');

// A file two projects compile belongs to BOTH — it must be indexed into each.
const sharedOwners = map.ownersOf(path.join(A, 'POUs', 'FB_Shared.TcPOU'));
assert(sharedOwners.length === 2, `a linked file has two owners (got ${sharedOwners.length})`);
assert(sharedOwners.includes(keyA) && sharedOwners.includes(keyB), 'both projects own the linked file');
// ...but routing a REQUEST for it is single-valued: the project it physically sits under.
assert(map.projectFor(path.join(A, 'POUs', 'FB_Shared.TcPOU')) === keyA,
    'a linked file routes to the project whose directory contains it');

// Not <Compile>d anywhere: routes to the nearest ancestor project (so an open orphan still gets
// answers), and outside every project directory to the loose key.
assert(map.projectFor(path.join(B, 'POUs', 'Orphan.TcPOU')) === keyB,
    'an orphan object routes to its nearest ancestor project');
assert(map.projectFor(path.join(ROOT, 'Loose', 'Stray.TcPOU')) === LOOSE_PROJECT_KEY,
    'a file under no project routes to the loose key');
assert(map.ownersOf(path.join(ROOT, 'Loose', 'Stray.TcPOU')).length === 0,
    'a loose file is owned by no project');

// --- no project at all ---------------------------------------------------------------------
const bare = path.join(os.tmpdir(), 'projmap_none_' + Date.now());
fs.mkdirSync(bare, { recursive: true });
const empty = createProjectMap([bare]);
assert(empty.isEmpty(), 'a root with no .plcproj yields an empty map');
assert(empty.projectFor(path.join(bare, 'X.TcPOU')) === LOOSE_PROJECT_KEY,
    'with no project, everything is loose (preserves the index-everything fallback)');

// --- case-insensitivity (Windows/TwinCAT) ----------------------------------------------------
assert(map.projectFor(path.join(A, 'pous', 'main.tcpou')) === keyA,
    'ownership is case-insensitive');

// --- status-bar label ---------------------------------------------------------------------
const { projectLabel } = require('../src/projectStatusBar');

assert(projectLabel(map, path.join(A, 'POUs', 'MAIN.TcPOU')) === 'LineA',
    'the label names the owning project');
assert(projectLabel(map, path.join(ROOT, 'Loose', 'Stray.TcPOU')) === 'Loose files',
    'a file under no project is labelled as loose');
assert(projectLabel(empty, path.join(bare, 'X.TcPOU')) === '',
    'a workspace with no project shows nothing — there is nothing to disambiguate');

// One project is the common case: the indicator must stay out of the way.
const soloRoot = path.join(os.tmpdir(), 'projmap_solo_' + Date.now());
fs.mkdirSync(path.join(soloRoot, 'POUs'), { recursive: true });
fs.writeFileSync(path.join(soloRoot, 'Solo.plcproj'),
    '<Project><ItemGroup><Compile Include="POUs\\MAIN.TcPOU"/></ItemGroup></Project>');
const solo = createProjectMap([soloRoot]);
assert(projectLabel(solo, path.join(soloRoot, 'POUs', 'MAIN.TcPOU')) === '',
    'a single-project workspace shows nothing');

// --- tree grouping ----------------------------------------------------------------------------
const { groupRootsByProject } = require('../src/lsp/projectMap');

const groups = groupRootsByProject(map, [ROOT]);
assert(groups.length === 2, `two projects produce two tree groups (got ${groups.length})`);
// Compared against a literal, NOT `groups.map(...).sort()` — sorting the actual result before
// comparing would make this pass even if groupRootsByProject's own sort regressed (e.g. started
// returning discovery order instead of name order); the literal is the one thing that can catch that.
assert(groups.map(g => g.name).join(',') === ['LineA', 'LineB'].join(','),
    `groups are named after the projects, in sorted order (got ${groups.map(g => g.name).join(',')})`);
assert(groups.every(g => fs.statSync(g.dir).isDirectory()),
    'each group points at a real DIRECTORY, not the .plcproj file itself');
assert(groupRootsByProject(solo, [soloRoot]).length === 0,
    'a single-project workspace produces no groups — the tree stays flat');

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(bare, { recursive: true, force: true });
fs.rmSync(soloRoot, { recursive: true, force: true });

console.log(`\n--- PROJECT MAP TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
