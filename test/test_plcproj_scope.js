/**
 * @file test_plcproj_scope.js
 * @description The workspace index is scoped to the .plcproj, not the filesystem.
 *
 * A real symptom this guards: a project had a leftover backup folder (POUs\Modulezzz\) that was a
 * full copy of POUs\Modules\ — same object names, but NOT in the .plcproj. Because the name-keyed
 * index is last-write-wins and the backup sorted last, the orphan FB_Loading won the index key, so a
 * reference-aware rename scanned the orphan (no references) and never touched the real object. The
 * fix: collectPlcProjObjectPaths() lists the objects the .plcproj actually <Compile>s, and
 * indexTwinCatDirectory() skips anything on disk outside that set (falling back to indexing everything
 * only when there is no .plcproj at all).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    indexTwinCatDirectory,
    collectPlcProjObjectPaths
} = require('../src/lsp/xmlIndexer');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ------------------------------------------------------------------------------------------------
// A temp project: the real Modules\FB_Loading.TcPOU (in the .plcproj) and an orphan backup copy in
// Modulezzz\ (same object name, NOT in the .plcproj), plus a non-duplicate GVL.
// ------------------------------------------------------------------------------------------------
const ROOT = path.join(os.tmpdir(), 'plcproj_scope_' + Date.now());
fs.mkdirSync(path.join(ROOT, 'POUs', 'Modules'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'POUs', 'Modulezzz'), { recursive: true });
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

const realFb = path.join(ROOT, 'POUs', 'Modules', 'FB_Loading.TcPOU');
const orphanFb = path.join(ROOT, 'POUs', 'Modulezzz', 'FB_Loading.TcPOU');
const gvl = path.join(ROOT, 'GVLs', 'GVL_Data.TcGVL');
fs.writeFileSync(realFb, pou('FB_Loading', 'n := GVL_Data.nSpeed; // REAL'));
fs.writeFileSync(orphanFb, pou('FB_Loading', 'n := 0; // ORPHAN — no GVL_Data reference'));
fs.writeFileSync(gvl, `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <GVL Name="GVL_Data" Id="{b0000000-0000-4a00-8a00-000000000001}">
    <Declaration><![CDATA[VAR_GLOBAL
	nSpeed : INT;
END_VAR]]></Declaration>
  </GVL>
</TcPlcObject>`);

// The .plcproj includes ONLY the real Modules\FB_Loading and the GVL — never the Modulezzz orphan.
fs.writeFileSync(path.join(ROOT, 'Proj.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\Modules\\FB_Loading.TcPOU"><SubType>Code</SubType></Compile>
    <Compile Include="GVLs\\GVL_Data.TcGVL"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`);

// ------------------------------------------------------------------------------------------------
// collectPlcProjObjectPaths
// ------------------------------------------------------------------------------------------------
const included = collectPlcProjObjectPaths([ROOT]);
const key = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

assert(included instanceof Set, 'a project returns a Set of included object paths');
assert(included.has(key(realFb)), 'the real Modules\\FB_Loading is in the include set');
assert(included.has(key(gvl)), 'the GVL is in the include set');
assert(!included.has(key(orphanFb)), 'the orphan Modulezzz\\FB_Loading is NOT in the include set');
assert(included.size === 2, `exactly the two <Compile>d objects are included (got ${included.size})`);

// No .plcproj anywhere → null (the caller then indexes everything).
const emptyDir = path.join(os.tmpdir(), 'plcproj_none_' + Date.now());
fs.mkdirSync(emptyDir, { recursive: true });
assert(collectPlcProjObjectPaths([emptyDir]) === null, 'no .plcproj under any root returns null (index-all fallback)');

// ------------------------------------------------------------------------------------------------
// indexTwinCatDirectory honours the include set: the real object wins the name key, orphan skipped.
// ------------------------------------------------------------------------------------------------
const gated = {};
indexTwinCatDirectory(gated, ROOT, included);
assert(!!gated['FB_Loading'], 'FB_Loading is indexed');
assert(/POUs\/Modules\/FB_Loading\.TcPOU$/i.test(gated['FB_Loading'].uri),
    'the .plcproj copy (Modules) wins the name key — not the orphan (Modulezzz)');
assert(!!gated['GVL_Data'], 'the GVL is indexed');

// Without a filter, the old behavior stands: both copies collapse onto the key, last-write-wins, so
// the orphan can win — this is exactly the bug the filter removes.
const ungated = {};
indexTwinCatDirectory(ungated, ROOT);
assert(!!ungated['FB_Loading'], 'unfiltered: FB_Loading is still indexed (fallback behavior intact)');

// ------------------------------------------------------------------------------------------------
// Ratchet tie-in: if the real sample is present, every object on disk must be in its .plcproj, so
// gating is a NO-OP there and the zero-diagnostics baseline cannot move because of this change.
// ------------------------------------------------------------------------------------------------
const SAMPLE_DIR = path.join(__dirname, '..', 'sample');
if (fs.existsSync(SAMPLE_DIR)) {
    const sampleIncluded = collectPlcProjObjectPaths([SAMPLE_DIR]);
    assert(sampleIncluded instanceof Set, 'sample: a .plcproj is found');
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
    const missing = onDisk.filter(p => !sampleIncluded.has(key(p)));
    assert(missing.length === 0,
        `sample: every object on disk is in the .plcproj, so gating is a no-op (got ${missing.length} outside: ${missing.slice(0, 3).map(p => path.basename(p)).join(', ')})`);
} else {
    console.log('sample/ not present — skipping the ratchet-safety coverage check.');
}

// Cleanup
fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });

console.log(`\n--- PLCPROJ SCOPE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
