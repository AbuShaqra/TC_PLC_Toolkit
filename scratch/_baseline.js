/**
 * @file _baseline.js
 * @description Single source of truth for the sample-project diagnostics ratchet, shared by
 * scratch/test_sample_diagnostics.js and scratch/test_typecheck.js. Both measure the same thing the
 * same way, so the recipe and the baselines live here rather than being copied (and drifting).
 *
 * Two things this module owns:
 *
 * 1. **The measuring recipe** — syncDocument() below mirrors `syncDocument()` in src/lsp/server.js
 *    exactly. Measure any other way and the number is meaningless (see HANDOFF.md):
 *      - `convertXmlToSt(parsed, { raw: true })` — the NON-raw conversion silently strips
 *        declaration-site init lists (`fb : FB_X(a := b)` becomes `fb : FB_X;`), hiding real findings.
 *      - `parseAndIndexDocument(stText, uri)` — gives methods real line ranges; without it
 *        `findActiveScope` matches no method, `methodVars` is empty, and every method-local variable
 *        in every method body is flagged undeclared (~2,300 phantom diagnostics).
 *      - `registerLibrarySymbolNodes(index, stText)` — puts the external symbols the document
 *        references into the index, on demand (never all 32k at once: that is a deliberate
 *        performance design, see libsymbols.js). Without it every bare library name
 *        (`DEFAULT_ADS_TIMEOUT`, `T_MaxString`, …) reads as undeclared: 171 false positives.
 *      - the workspace scan up front — `indexLibraryNamespaces` (.plcproj), `indexLibrarySymbols`
 *        (the ZIP archives) and `indexTypeSystem` (the `.tmc`), exactly as server.js indexLibraries()
 *        does. Skip the `.tmc` and the count is 12, not 0.
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

/** The sample TwinCAT project (git-ignored; harnesses skip cleanly when it is absent). */
const SAMPLE_DIR = path.join(__dirname, '..', 'sample');

/**
 * The sample project is correct TwinCAT code, so **every** diagnostic on it is a false positive and
 * the only defensible target is 0 — which, with both external symbol sources present, is what it
 * now scores. But the two sources are *git-ignored build artifacts*: `sample/.gitignore` tracks only
 * the source objects and the `.plcproj`, so a fresh clone or a CI runner has **neither** the
 * `_Libraries/` archives nor the `.tmc`. On such a machine a bare library name genuinely cannot be
 * resolved, and 171 diagnostics is the honest, correct result — failing there would be punishing a
 * machine that is behaving exactly as designed.
 *
 * Hence a table rather than a constant. Pinning a single number would be wrong on one machine or the
 * other: assert 0 on a fresh clone and a correct run fails; assert 171 everywhere and a real
 * regression hides behind 171 points of slack on the machine that HAS the artifacts.
 *
 * Every row below is **measured**, not assumed (2026-07-13, 152 sample objects):
 *
 *   archives  .tmc  total  mode              what is unresolvable
 *   --------  ----  -----  ----------------  ---------------------------------------------------
 *      yes    yes      0   full              nothing — the target, reached
 *      yes    no      12   archives-only     E_EthercatDeviceState (x8), CANQUEUE (x4): neither is
 *                                            in any archive string table; only the .tmc has them
 *      no     yes     69   typesystem-only   the library names the .tmc does not export
 *                                            (DEFAULT_ADS_TIMEOUT x25, F_STRING x12, …)
 *      no     no     171   none              every bare library identifier (fresh clone / CI)
 *
 * The mode is printed loudly on every run: a PASS against the wrong row means nothing.
 * @type {Object<string, {baseline: number, label: string}>}
 */
const BASELINES = {
    full: { baseline: 0, label: 'library archives + .tmc type system' },
    'archives-only': { baseline: 12, label: 'library archives, no .tmc type system' },
    'typesystem-only': { baseline: 69, label: '.tmc type system, no library archives' },
    none: { baseline: 171, label: 'no external symbol sources (fresh clone / CI)' }
};

/** The two realistic machines: a full TwinCAT working copy, and a fresh clone. */
const BASELINE_WITH_LIBRARIES = BASELINES.full.baseline;        // 0
const BASELINE_WITHOUT_LIBRARIES = BASELINES.none.baseline;     // 171

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
 * Prints the mode loudly. A passing run must never be mistakable for a run on a different machine —
 * the baselines span 0 to 171, and "PASS" against the wrong one means nothing.
 * @param {BaselineMode} info Result of indexSampleLibraries().
 */
function printBaselineMode(info) {
    console.log(`\n=== BASELINE MODE: ${info.mode.toUpperCase()} — baseline ${info.baseline} ===`);
    console.log(`    ${info.label}`);
    console.log(`    ${info.archives} archive(s) decoded (${info.failed} undecodable), ` +
        `${info.tmcFiles} .tmc file(s), ${info.symbols} external symbol(s) in ${info.ms} ms; ` +
        `${info.namespaces} namespace(s) from .plcproj.`);
    if (info.mode !== 'full') {
        console.log(`    NOTE: sample/**/_Libraries and the .tmc are git-ignored build artifacts. With both`);
        console.log(`    present the sample scores 0 — see the measured table in scratch/_baseline.js.`);
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
    indexSampleLibraries,
    printBaselineMode,
    syncDocument,
    walkTwinCatFiles
};
