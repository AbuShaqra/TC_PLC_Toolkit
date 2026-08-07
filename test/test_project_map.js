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
    normalizeProjectPath,
    findPlcProjFiles,
    createProjectMap
} = require('../src/lsp/projectMap');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

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

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(bare, { recursive: true, force: true });

console.log(`\n--- PROJECT MAP TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
