/**
 * @file test_plcproj_scope.js
 * @description The workspace index is scoped to the .plcproj, not the filesystem.
 *
 * A real symptom this guards: a project had a leftover backup folder (POUs\Modules_bak\) that was a
 * full copy of POUs\Modules\ — same object names, but NOT in the .plcproj. Because the name-keyed
 * index is last-write-wins and the backup sorted last, the orphan FB_Feeder won the index key, so a
 * reference-aware rename scanned the orphan (no references) and never touched the real object. The
 * fix: collectPlcProjObjectPaths() lists the objects the .plcproj actually <Compile>s, and
 * indexTwinCatDirectory() skips anything on disk outside that set (falling back to indexing everything
 * only when there is no .plcproj at all).
 *
 * That fix has since been superseded by the project-scoped index (see test_project_map.js and
 * test_multi_project_scope.js): `createProjectMap()` now answers "what does THIS project compile"
 * per project instead of as one workspace-wide union, and `collectPlcProjObjectPaths()` — the old
 * unioned API — was removed. This harness still asserts the exact same guarantee the Modules_bak
 * incident demanded, just through `createProjectMap()`'s per-project `objectPaths` instead.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { indexXmlFile } = require('../src/lsp/xmlIndexer');
const { createProjectMap, normalizeProjectPath } = require('../src/lsp/projectMap');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ------------------------------------------------------------------------------------------------
// A temp project: the real Modules\FB_Feeder.TcPOU (in the .plcproj) and an orphan backup copy in
// Modules_bak\ (same object name, NOT in the .plcproj), plus a non-duplicate GVL.
// ------------------------------------------------------------------------------------------------
const ROOT = path.join(os.tmpdir(), 'plcproj_scope_' + Date.now());
fs.mkdirSync(path.join(ROOT, 'POUs', 'Modules'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'POUs', 'Modules_bak'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'GVLs'), { recursive: true });

function pou(name, body) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="{c0000000-0000-4a00-8a00-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK ${name}
VAR
	n : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[${body}]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;
}

const realFb = path.join(ROOT, 'POUs', 'Modules', 'FB_Feeder.TcPOU');
const orphanFb = path.join(ROOT, 'POUs', 'Modules_bak', 'FB_Feeder.TcPOU');
const gvl = path.join(ROOT, 'GVLs', 'GVL_Data.TcGVL');
fs.writeFileSync(realFb, pou('FB_Feeder', 'n := GVL_Data.nSpeed; // REAL'));
fs.writeFileSync(orphanFb, pou('FB_Feeder', 'n := 0; // ORPHAN — no GVL_Data reference'));
fs.writeFileSync(gvl, `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <GVL Name="GVL_Data" Id="{b0000000-0000-4a00-8a00-000000000001}">
    <Declaration><![CDATA[VAR_GLOBAL
	nSpeed : INT;
END_VAR]]></Declaration>
  </GVL>
</TcPlcObject>`);

// The .plcproj includes ONLY the real Modules\FB_Feeder and the GVL — never the Modules_bak orphan.
fs.writeFileSync(path.join(ROOT, 'Proj.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\Modules\\FB_Feeder.TcPOU"><SubType>Code</SubType></Compile>
    <Compile Include="GVLs\\GVL_Data.TcGVL"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`);

// ------------------------------------------------------------------------------------------------
// createProjectMap: the project's objectPaths is the include set the old union API used to compute.
// ------------------------------------------------------------------------------------------------
const map = createProjectMap([ROOT]);
const key = normalizeProjectPath(path.join(ROOT, 'Proj.plcproj'));
const objects = map.get(key).objectPaths;

assert(objects instanceof Set, 'a project carries a Set of <Compile>d object paths');
assert(objects.has(normalizeProjectPath(realFb)), 'the real Modules\\FB_Feeder is in the project');
assert(!objects.has(normalizeProjectPath(orphanFb)), 'the orphan Modules_bak\\FB_Feeder is NOT');
assert(objects.size === 2, `exactly the two <Compile>d objects (got ${objects.size})`);

// A root with no .plcproj anywhere yields an empty map, not a project to look up.
const emptyDir = path.join(os.tmpdir(), 'plcproj_none_' + Date.now());
fs.mkdirSync(emptyDir, { recursive: true });
assert(createProjectMap([emptyDir]).isEmpty(), 'no .plcproj under any root yields an empty project map');

// ------------------------------------------------------------------------------------------------
// Indexing the project's own objectPaths: the real object wins the name key, the orphan is never
// touched because it was never in the set to begin with (this is how workspaceScan.js indexes a
// project today — one indexXmlFile() call per objectPaths entry, not a filtered directory walk).
// ------------------------------------------------------------------------------------------------
const index = {};
for (const p of objects) indexXmlFile(index, p);
assert(!!index['FB_Feeder'], 'FB_Feeder is indexed');
assert(/POUs\/Modules\/FB_Feeder\.TcPOU$/i.test(index['FB_Feeder'].uri),
    'the .plcproj copy wins the name key — the orphan is never indexed');
assert(!!index['GVL_Data'], 'the GVL is indexed');

// ------------------------------------------------------------------------------------------------
// Ratchet tie-in: if the real sample is present, every object on disk must be in its .plcproj, so
// scoping to objectPaths is a NO-OP there and the zero-diagnostics baseline cannot move because of
// this change.
// ------------------------------------------------------------------------------------------------
const SAMPLE_DIR = path.join(__dirname, '..', 'sample');
if (fs.existsSync(SAMPLE_DIR)) {
    const sampleMap = createProjectMap([SAMPLE_DIR]);
    assert(!sampleMap.isEmpty(), 'sample: a .plcproj is found');
    const sampleObjects = new Set();
    for (const proj of sampleMap.projects.values()) {
        for (const p of proj.objectPaths) sampleObjects.add(p);
    }
    const TWINCAT_RE = /\.(tcpou|tcgvl|tcdut|tcio)$/i;
    const onDisk = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) {
                if (!/^(\.git|node_modules|\.vscode|_Libraries)$/i.test(e.name)) walk(full);
            } else if (TWINCAT_RE.test(e.name)) onDisk.push(full);
        }
    })(SAMPLE_DIR);
    const missing = onDisk.filter(p => !sampleObjects.has(normalizeProjectPath(p)));
    assert(missing.length === 0,
        `sample: every object on disk is in a .plcproj, so scoping is a no-op (got ${missing.length} outside: ${missing.slice(0, 3).map(p => path.basename(p)).join(', ')})`);
} else {
    console.log('sample/ not present — skipping the ratchet-safety coverage check.');
}

// Cleanup
fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });

console.log(`\n--- PLCPROJ SCOPE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
