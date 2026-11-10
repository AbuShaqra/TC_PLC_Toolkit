/**
 * @file test_sample_diagnostics.js
 * @description Diagnostics ratchet on the committed samples — every PLC project under sample/ (two
 * solutions today), each indexed and diagnosed on its own, as the server partitions a workspace.
 *
 * The sample is known-good TwinCAT code, so *every* diagnostic it produces is a bug in us. The
 * target is zero — and with the external symbol sources present it now *scores* zero, so this
 * harness fails on any diagnostic at all. Improvements print the value the baseline can be lowered to.
 *
 * Measuring it the way the product does is the whole point — get this wrong and the number is
 * meaningless. The recipe and the baselines both live in scratch/_baseline.js, shared with
 * scratch/test_typecheck.js so the two cannot drift; read that file for the why.
 *
 * The baseline is **machine-dependent**: `sample/**\/_Libraries` and the project `.tmc` are
 * git-ignored build artifacts, so a fresh clone cannot resolve library names and legitimately scores
 * 171. The mode is detected from what was actually harvested and printed loudly on every run.
 */

const fs = require('fs');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideDiagnostics } = require('../src/lsp/features');
const { reportCoverage } = require('./_coverage');
const {
    SAMPLE_DIR,
    isFirstSampleDir,
    indexSampleLibraries,
    printBaselineMode,
    sampleProjects,
    syncDocument
} = require('./_baseline');

if (!fs.existsSync(SAMPLE_DIR)) {
    console.log('sample/ project not present — skipping sample diagnostics test.');
    reportCoverage('sample-diagnostics', 'skipped', 'sample/ project not present');
    process.exit(0);
}

/**
 * Buckets a diagnostic by its message shape, so a regression can be read at a glance.
 * @param {{message: string}} diag
 * @returns {string} Category key.
 */
function categorize(diag) {
    const m = diag.message || '';
    if (/is not declared/.test(m)) return 'not declared';
    if (/is not a member/.test(m)) return 'not a member';
    if (/is not a parameter/.test(m)) return 'not a parameter';
    if (/^Unknown type/.test(m)) return 'unknown type';
    if (/^Type mismatch/.test(m)) return 'type mismatch';
    return 'other';
}

// One PLC project at a time, exactly as the server does (workspaceScan.js: one index per project).
// sample/ holds two solutions whose objects share names (MAIN, FB_Cylinder); a flat index over both
// would report the collision as a false positive the product never shows.
const projects = sampleProjects(SAMPLE_DIR);
let total = 0;
let fileCount = 0;
let parseSkipped = 0;
let BASELINE_DIAGNOSTICS = 0;
/** @type {Array<string>} */
const modes = [];
const byCategory = {};
const byFile = [];
for (const project of projects) {
    const files = project.files;
    fileCount += files.length;
    clearWorkspaceIndex();

    // Mirror the server's per-project scan (indexLibraries in src/lsp/server.js): namespaces from the
    // .plcproj, symbol names from the .compiled-library archives, and the project's .tmc type system.
    // Which baseline applies falls out of which of those sources this machine actually has.
    console.log(`\n##### PLC project ${project.name} (${path.relative(SAMPLE_DIR, project.dir)}): ${files.length} objects #####`);
    const modeInfo = indexSampleLibraries(project.dir);
    BASELINE_DIAGNOSTICS += modeInfo.baseline;
    modes.push(`${project.name}: ${modeInfo.mode}`);
    printBaselineMode(modeInfo, isFirstSampleDir(project.dir));

    // First pass: index every TwinCAT object directly from XML (the project's cross-file index).
    const index = getWorkspaceSymbolIndex();
    const converted = {};
    for (const file of files) {
        const xml = fs.readFileSync(file, 'utf8');
        const parsed = parseTwinCatXml(xml);
        if (!parsed) { console.log(`  [skip] could not parse ${file}`); parseSkipped++; continue; }
        const { stText, lineMap } = convertXmlToSt(parsed, { raw: true });
        const fileUri = 'file:///' + file.replace(/\\/g, '/').replace(/^\//, '');
        converted[file] = { stText, lineMap, fileUri, parsed };
        indexXmlObject(index, xml, fileUri);
    }
    console.log(`Indexed ${Object.keys(index).length} symbols from ${files.length} files`);

    // Second pass: diagnose each file the way server.js does — syncDocument() re-parses the unit into
    // the index (so scopes carry real line ranges) and registers the library symbols it references.
    for (const file of files) {
        const c = converted[file];
        if (!c) continue;
        syncDocument(index, c.stText, c.fileUri);
        const diags = provideDiagnostics(c.stText, index, c.fileUri);
        if (diags.length === 0) continue;
        total += diags.length;
        byFile.push({ file, count: diags.length });
        console.log(`\n=== ${path.relative(SAMPLE_DIR, file)} : ${diags.length} diagnostics ===`);
        const stLines = c.stText.split('\n');
        diags.forEach(d => {
            const cat = categorize(d);
            byCategory[cat] = (byCategory[cat] || 0) + 1;
            const lineNo = d.range.start.line; // 0-based
            const srcLine = (stLines[lineNo] || '').trim();
            console.log(`  L${lineNo + 1} [sev${d.severity}] ${d.message}`);
            console.log(`        >> ${srcLine}`);
        });
    }

    // Third pass — a FRESH open of each file: the project's scan-time index (XML only) plus that one
    // unit, which is what the server has when a file is the first one opened in a session. The pass
    // above syncs files in order, so a file diagnosed late sees every earlier unit already parsed;
    // that hid a scan-only defect (IMPLEMENTS on a multi-line head was mis-read by xmlIndexer, so
    // `ipValve := fbValve;` in the second sample's MAIN was a type mismatch until FB_Valve was opened).
    let freshTotal = 0;
    for (const file of files) {
        const c = converted[file];
        if (!c) continue;
        clearWorkspaceIndex();
        const freshIndex = getWorkspaceSymbolIndex();
        for (const other of files) {
            if (converted[other]) indexXmlObject(freshIndex, fs.readFileSync(other, 'utf8'), converted[other].fileUri);
        }
        syncDocument(freshIndex, c.stText, c.fileUri);
        const diags = provideDiagnostics(c.stText, freshIndex, c.fileUri);
        freshTotal += diags.length;
        if (diags.length === 0) continue;
        byFile.push({ file, count: diags.length });
        console.log(`\n=== ${path.relative(SAMPLE_DIR, file)} (opened fresh) : ${diags.length} diagnostics ===`);
        diags.forEach(d => {
            const cat = categorize(d);
            byCategory[cat] = (byCategory[cat] || 0) + 1;
            console.log(`  L${d.range.start.line + 1} [sev${d.severity}] ${d.message}`);
        });
    }
    total += freshTotal;
    console.log(`Opened fresh, one at a time: ${freshTotal} diagnostic(s) across ${files.length} files`);
}
const modeLabel = modes.join(', ');
const projectsOk = projects.length >= 2;

// ---- Report ----
console.log(`\n--- Diagnostics by category ---`);
Object.keys(byCategory).sort((a, b) => byCategory[b] - byCategory[a])
    .forEach(cat => console.log(`  ${String(byCategory[cat]).padStart(5)}  ${cat}`));

console.log(`\n--- Worst files ---`);
byFile.sort((a, b) => b.count - a.count).slice(0, 10)
    .forEach(f => console.log(`  ${String(f.count).padStart(5)}  ${path.relative(SAMPLE_DIR, f.file)}`));

const delta = total - BASELINE_DIAGNOSTICS;
console.log(`\n--- TOTAL: ${total} diagnostics across ${fileCount} files in ${projects.length} PLC project(s) ` +
    `(${modeLabel}; baseline ${BASELINE_DIAGNOSTICS}, delta ${delta > 0 ? '+' : ''}${delta}) ---`);
reportCoverage('sample-diagnostics', parseSkipped === 0 && projectsOk ? 'ran' : 'skipped',
    parseSkipped > 0 ? `${parseSkipped} file(s) could not be parsed`
        : (projectsOk ? `${fileCount} files in ${projects.length} projects diagnosed` : `expected both sample projects, found ${projects.length}`));

// ---- Ratchet ----
if (total > BASELINE_DIAGNOSTICS) {
    console.error(`\n[FAIL] REGRESSION: ${delta} new diagnostic(s) on the sample projects (${modeLabel}).`);
    console.error(`       The sample is correct TwinCAT code — every diagnostic on it is a false positive.`);
    console.error(`       Fix the new findings above; do NOT raise the baseline in scratch/_baseline.js to make this pass.`);
    process.exit(1);
}

if (total < BASELINE_DIAGNOSTICS) {
    console.log(`\n[PASS] IMPROVEMENT: ${-delta} fewer diagnostic(s) than the baseline (${modeLabel}).`);
    console.log(`       Lower it in scratch/_baseline.js to ${total} to lock it in (both harnesses share it).`);
} else if (total === 0) {
    console.log(`\n[PASS] ZERO diagnostics on the sample project. That is the target — keep it there.`);
} else {
    console.log(`\n[PASS] At the baseline (${BASELINE_DIAGNOSTICS}; ${modeLabel}). With every external symbol`);
    console.log(`       source present the sample scores 0 — see the measured table in scratch/_baseline.js.`);
}
process.exit(0);
