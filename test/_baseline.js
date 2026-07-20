/**
 * @file _baseline.js
 * @description Single source of truth for the sample-project diagnostics ratchet, shared by
 * test/test_sample_diagnostics.js and test/test_typecheck.js. Both measure the same thing the
 * same way, so the recipe and the baselines live here rather than being copied (and drifting).
 *
 * Two things this module owns:
 *
 * 1. **The measuring recipe** — syncDocument() below mirrors `syncDocument()` in src/lsp/server.js
 *    exactly. Measure any other way and the number is meaningless (see HANDOFF.md):
 *      - `convertXmlToSt(parsed, { raw: true })` — the NON-raw conversion silently strips
 *        declaration-site init lists (`fb : FB_X(a := b)` becomes `fb : FB_X;`), hiding real findings.
 *        The sample's `GVL_System.fbCylinder : FB_Cylinder(refExtendOut := GVL_Io.bExtendOut, …)` is
 *        exactly that shape, so this is load-bearing here and not a hypothetical.
 *      - `parseAndIndexDocument(stText, uri)` — gives methods real line ranges; without it
 *        `findActiveScope` matches no method, `methodVars` is empty, and every method-local variable
 *        in every method body is flagged undeclared.
 *      - `registerLibrarySymbolNodes(index, stText)` — puts the external symbols the document
 *        references into the index, on demand (never the whole registry at once: that is a
 *        deliberate performance design, see libsymbols.js).
 *      - the workspace scan up front — `indexLibraryNamespaces` (.plcproj), `indexLibrarySymbols`
 *        (the ZIP archives) and `indexTypeSystem` (the `.tmc`), exactly as server.js indexLibraries()
 *        does.
 *
 * 2. **The baseline, which is machine-dependent** — and that is not a bug, it is the point. See the
 *    table below.
 */

const fs = require('fs');
const path = require('path');

const { parseAndIndexDocument } = require('../src/lsp/parser');
const { indexLibraryNamespaces, clearLibraryNamespaces } = require('../src/lsp/libraries');
const {
    indexLibrarySymbols,
    indexTypeSystem,
    clearLibrarySymbols,
    registerLibrarySymbolNodes
} = require('../src/lsp/libsymbols');

/** The sample TwinCAT project (committed; harnesses skip cleanly when it is absent). */
const SAMPLE_DIR = path.join(__dirname, '..', 'sample');

/**
 * The sample project is correct TwinCAT code, so **every** diagnostic on it is a false positive and
 * the only defensible target is 0 — which is what it scores, in every mode this tree can produce.
 *
 * The table survives the move from the customer project to the committed synthetic one because the
 * *reason* for it survives: the external symbol sources are git-ignored build artifacts, so how much
 * a machine can resolve still depends on which of them it has. `sample/TcToolkitSample/
 * TcToolkitSample_PLC/_Libraries/` (three Beckhoff archives) is git-ignored, and the project `.tmc`
 * only exists after a TwinCAT build. A fresh clone or a CI runner has neither.
 *
 * What changed is the *numbers*. The old rows (0 / 12 / 69 / 171) were measured on the customer's
 * 152-object project, which named library symbols throughout its code; the synthetic sample's 19
 * objects reference **no library symbol at all**, so there is nothing for a missing archive or a
 * missing `.tmc` to fail to resolve, and every row collapses to 0.
 *
 * Re-measured 2026-07-20 against sample/TcToolkitSample (19 objects, 3 declared namespaces):
 *
 *   archives  .tmc  total  mode              how it was established
 *   --------  ----  -----  ----------------  ---------------------------------------------------
 *      yes    yes      0   full              NOT PRODUCIBLE on this tree — see below
 *      yes    no       0   archives-only     MEASURED: the mode this working copy is in
 *      no     yes      0   typesystem-only   NOT PRODUCIBLE on this tree — see below
 *      no     no       0   none              MEASURED: archives suppressed; identical to the
 *                                            archives-only run, confirming the sample's code
 *                                            names no external symbol
 *
 * **The two `.tmc` rows could not be measured**: the sample has no `.tmc` and cannot be given one
 * without building the project in TwinCAT XAE, so `indexTypeSystem()` returns `files: 0` and the
 * mode detector never selects them. Their 0 is therefore an *inference*, not a measurement — but a
 * safe one: adding the `.tmc` only ever adds resolvable symbols to the index, and the corresponding
 * measured row (archives-only / none respectively) is already at the 0 floor. If a `.tmc` ever lands
 * here and a row scores above 0, that is a real finding — measure it and record the number, do not
 * assume this table was right.
 *
 * Keeping every row at 0 is the point: the old `archives-only: 12` carried 12 points of slack on the
 * mode this machine actually runs in, so a regression of up to 12 new diagnostics would have passed
 * the gate silently.
 *
 * The mode is printed loudly on every run: a PASS against the wrong row means nothing.
 * @type {Object<string, {baseline: number, label: string}>}
 */
const BASELINES = {
    full: { baseline: 0, label: 'library archives + .tmc type system (not producible without an XAE build)' },
    'archives-only': { baseline: 0, label: 'library archives, no .tmc type system' },
    'typesystem-only': { baseline: 0, label: '.tmc type system, no library archives (not producible without an XAE build)' },
    none: { baseline: 0, label: 'no external symbol sources (fresh clone / CI)' }
};

/** The two realistic machines: a full TwinCAT working copy, and a fresh clone. Both score 0. */
const BASELINE_WITH_LIBRARIES = BASELINES.full.baseline;        // 0
const BASELINE_WITHOUT_LIBRARIES = BASELINES.none.baseline;     // 0

/**
 * @typedef {Object} BaselineMode
 * @property {'full'|'archives-only'|'typesystem-only'|'none'} mode Which row of the table applies.
 * @property {number} baseline The diagnostic count the sample may not exceed in this mode.
 * @property {string} label Human-readable description of the mode.
 * @property {number} namespaces Library namespaces recovered from the .plcproj.
 * @property {number} archives Library archives decoded.
 * @property {number} failed Archives that could not be decoded.
 * @property {number} tmcFiles `.tmc` type-system exports read.
 * @property {number} symbols External symbol names harvested in total.
 * @property {number} ms Time spent harvesting.
 */

/**
 * Rebuilds the external-symbol registries from the sample project, exactly as `indexLibraries()` in
 * src/lsp/server.js does on its workspace scan, and reports which row of BASELINES this machine is on.
 * @param {string} [sampleDir] Sample project root. Defaults to SAMPLE_DIR.
 * @returns {BaselineMode} Mode and the baseline that goes with it.
 */
function indexSampleLibraries(sampleDir = SAMPLE_DIR) {
    clearLibraryNamespaces();
    clearLibrarySymbols();

    const namespaces = indexLibraryNamespaces(sampleDir);
    const lib = indexLibrarySymbols(sampleDir);
    const tmc = indexTypeSystem(sampleDir);

    // Decided by what was actually harvested, not by a path probe: an archive that exists but does
    // not decode contributes nothing, and must therefore count as absent.
    const hasArchives = lib.archives > 0;
    const hasTypeSystem = tmc.files > 0;
    const mode = hasArchives
        ? (hasTypeSystem ? 'full' : 'archives-only')
        : (hasTypeSystem ? 'typesystem-only' : 'none');

    return {
        mode,
        baseline: BASELINES[mode].baseline,
        label: BASELINES[mode].label,
        namespaces: namespaces.length,
        archives: lib.archives,
        failed: lib.failed,
        tmcFiles: tmc.files,
        symbols: tmc.symbols || lib.symbols,
        ms: lib.ms + tmc.ms
    };
}

/**
 * Prints the mode loudly. Every row of the table is currently 0, but the mode still has to be shown:
 * it says which external symbol sources this machine actually had, and a future sample that does
 * reference library symbols will pull the rows apart again.
 * @param {BaselineMode} info Result of indexSampleLibraries().
 */
function printBaselineMode(info) {
    console.log(`\n=== BASELINE MODE: ${info.mode.toUpperCase()} — baseline ${info.baseline} ===`);
    console.log(`    ${info.label}`);
    console.log(`    ${info.archives} archive(s) decoded (${info.failed} undecodable), ` +
        `${info.tmcFiles} .tmc file(s), ${info.symbols} external symbol(s) in ${info.ms} ms; ` +
        `${info.namespaces} namespace(s) from .plcproj.`);
    if (info.mode !== 'full') {
        console.log(`    NOTE: sample/**/_Libraries is git-ignored and the .tmc is a TwinCAT build artifact,`);
        console.log(`    so most checkouts have one or neither. The sample scores 0 in every mode this tree`);
        console.log(`    can produce — see the measured table in test/_baseline.js.`);
    }
    console.log('');
}

/**
 * Brings the symbol index up to date with one document before diagnosing it — the harness twin of
 * `syncDocument()` in src/lsp/server.js. Both harnesses go through here so neither can drift from
 * the server, or from each other.
 * @param {Object} index Workspace symbol index (mutated).
 * @param {string} stText Structured Text of the document.
 * @param {string} fileUri Document URI.
 */
function syncDocument(index, stText, fileUri) {
    parseAndIndexDocument(stText, fileUri);
    registerLibrarySymbolNodes(index, stText);
}

// ---------------------------------------------------------------------------------------------
// Which library archives this checkout actually has
// ---------------------------------------------------------------------------------------------
//
// `_Libraries/` holds archives from two sources, and only one of them is committed:
//
//   fisothemes/twincat dynamic collections/  TwinCAT Dynamic Collections, MIT-licensed, so it CAN
//                                            be redistributed. sample/.gitignore negates exactly
//                                            this directory => present on CI and on a fresh clone.
//   Beckhoff Automation GmbH/                Tc2_Standard, Tc2_System, Tc3_Module. Vendor binaries,
//                                            git-ignored => present ONLY where TwinCAT copied them.
//
// The `.plcproj` references all four, and namespaces come from the `.plcproj`, so namespace-level
// facts (4 namespaces, their include/title/company splits, the catalog shape) hold in BOTH
// configurations. Only archive-derived facts — symbol names, symbol counts, per-namespace
// attribution — differ. Harnesses therefore assert on what is committed and gate the rest on
// `hasBeckhoff`, so a developer machine keeps the extra coverage without CI failing for lacking it.

/** The git-ignored vendor directory, named exactly as TwinCAT creates it. */
const BECKHOFF_VENDOR_DIR = 'Beckhoff Automation GmbH';

/** The committed MIT archive's namespace, as the sample `.plcproj` declares it. */
const MIT_NAMESPACE = 'TcDynCollections';

/**
 * Distinct identifier-shaped names the committed MIT archive harvests to. Measured 2026-07-20 by
 * running `harvestArchive()` over `tcdyncollections.library` (v1.0.7) — the archive is committed at
 * a fixed version, so this is a reproducible ratchet on the decoder, not a machine-dependent number.
 */
const MIT_SYMBOL_COUNT = 479;

/** Archive extensions the harvester reads. `.compiled-library-v3` is opaque and deliberately absent. */
const ARCHIVE_RE = /\.(compiled-library|compiled-library-ge33|library)$/i;

/**
 * Finds the `_Libraries` folder under a sample project, or null.
 * @param {string} dir Directory to search.
 * @param {number} [depth] Recursion depth guard.
 * @returns {string|null} Absolute path, or null when there is none.
 */
function findLibrariesDir(dir, depth = 0) {
    if (depth > 3 || !fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.toLowerCase() === '_libraries') return path.join(dir, entry.name);
        const hit = findLibrariesDir(path.join(dir, entry.name), depth + 1);
        if (hit) return hit;
    }
    return null;
}

/**
 * Collects every readable library archive beneath a directory.
 * @param {string} dir Directory to walk.
 * @param {string[]} [out] Accumulator.
 * @returns {string[]} Absolute archive paths.
 */
function collectArchives(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectArchives(full, out);
        else if (ARCHIVE_RE.test(entry.name)) out.push(full);
    }
    return out;
}

/**
 * @typedef {Object} ArchiveFixtures
 * @property {string|null} librariesDir The sample's `_Libraries` folder, or null.
 * @property {string[]} archives Every readable archive found beneath it.
 * @property {boolean} hasMit The committed MIT archive is present (it always should be).
 * @property {string|null} mitArchive Absolute path to the MIT archive, or null.
 * @property {boolean} hasBeckhoff The git-ignored Beckhoff archives are present.
 */

/**
 * Reports which library archives this checkout has, so harnesses can assert on the committed one and
 * gate Beckhoff-only coverage instead of failing on CI. Detected from the filesystem rather than
 * from the harvester's own output — a gate must not be decided by the code under test.
 * @param {string} [sampleDir] Sample project root. Defaults to SAMPLE_DIR.
 * @returns {ArchiveFixtures} What is present.
 */
function sampleArchiveFixtures(sampleDir = SAMPLE_DIR) {
    const librariesDir = findLibrariesDir(sampleDir);
    if (!librariesDir) {
        return { librariesDir: null, archives: [], hasMit: false, mitArchive: null, hasBeckhoff: false };
    }
    const archives = collectArchives(librariesDir);
    const mitArchive = archives.find(p => /tcdyncollections/i.test(path.basename(p))) || null;
    const beckhoffSegment = path.sep + BECKHOFF_VENDOR_DIR.toLowerCase() + path.sep;
    return {
        librariesDir,
        archives,
        hasMit: !!mitArchive,
        mitArchive,
        hasBeckhoff: archives.some(p => p.toLowerCase().includes(beckhoffSegment))
    };
}

/**
 * Prints the one-line explanation that goes with a skipped Beckhoff-only section, so a reduced run
 * never looks like a passing one.
 * @param {string} what The coverage being skipped.
 */
function skipBeckhoff(what) {
    console.log(`    [skip] ${what} — the Beckhoff archives (Tc2_Standard / Tc2_System / Tc3_Module)`);
    console.log('           are git-ignored vendor binaries, absent on CI and on a fresh clone. This is');
    console.log('           bonus coverage on a machine where TwinCAT has copied them in.');
}

/**
 * Collects every TwinCAT source object under a directory. `_Libraries` holds vendor binaries, not
 * source, and is skipped.
 * @param {string} dir Directory to walk.
 * @param {string[]} [out] Accumulator.
 * @returns {string[]} Absolute file paths.
 */
function walkTwinCatFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '_Libraries') continue;
            walkTwinCatFiles(full, out);
        } else if (/\.(TcPOU|TcGVL|TcDUT|TcIO)$/i.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

module.exports = {
    SAMPLE_DIR,
    BASELINES,
    BASELINE_WITH_LIBRARIES,
    BASELINE_WITHOUT_LIBRARIES,
    BECKHOFF_VENDOR_DIR,
    MIT_NAMESPACE,
    MIT_SYMBOL_COUNT,
    indexSampleLibraries,
    printBaselineMode,
    findLibrariesDir,
    sampleArchiveFixtures,
    skipBeckhoff,
    syncDocument,
    walkTwinCatFiles
};
