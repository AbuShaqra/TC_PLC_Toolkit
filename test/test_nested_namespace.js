/**
 * @file test_nested_namespace.js
 * @description Nested library namespaces — the answer to `VisuElems.VisuElemBase.▮`.
 *
 * A library's namespace re-exports the namespaces of the libraries it depends on, so a path can be
 * two namespaces deep before it names anything. Established from real compiling code, not guessed:
 * `VisuElems.VisuElemBase.IDialogManager`, `VisuElems.VisuElemBase.Visu_Globals.g_ClientManager`.
 * `VisuElems` is what a `.plcproj` references; `VisuElemBase` appears in no `.plcproj` at all — it
 * is a dependency of the VisuElems library (whose `dependencies` file lists `#System_VisuElemBase#`)
 * and is therefore resolved by name against the installed-library store, on demand.
 *
 * Two properties matter more than the lookup itself, and both are asserted without needing any
 * library installed:
 *   - the GATE. Resolution is attempted only when the head is a namespace the project actually
 *     references, which is what stops an ordinary member path (`stAxis.MotionState.▮`) from ever
 *     reaching the archive store — that path is a different pipeline item and must stay untouched.
 *   - the MISS. An uninstalled library yields an empty list that is cached, never an exception and
 *     never a retry: the store is machine-dependent and absent on CI by definition.
 *
 * The real resolution is asserted only when the store actually holds a nested library, and the run
 * says so either way rather than passing silently on a machine that proves nothing.
 */

const fs = require('fs');
const path = require('path');

const {
    getNestedNamespaceSymbols,
    findInstalledLibraryArchive,
    clearLibrarySymbols
} = require('../src/lsp/libsymbols');
const { MANAGED_LIBRARIES } = require('../src/lsp/browserCache');
const { clearLibraryNamespaces } = require('../src/lsp/libraries');
const { parseAndIndexDocument, getWorkspaceSymbolIndex, clearWorkspaceIndex } = require('../src/lsp/parser');
const { provideCompletions } = require('../src/lsp/features');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Completions for a caret placed at the end of `line`, inside a trivial FB. */
function completeAfter(line) {
    const code = ['FUNCTION_BLOCK FB_Probe', 'VAR', 'END_VAR', line, 'END_FUNCTION_BLOCK', ''].join('\n');
    clearWorkspaceIndex();
    parseAndIndexDocument(code, '/nested_probe.st');
    return provideCompletions(code, { line: 3, character: line.length }, getWorkspaceSymbolIndex(), '/nested_probe.st') || [];
}

// ── 1. A miss is empty, cached, and never throws ─────────────────────────────────────────────────
{
    clearLibrarySymbols();
    const ABSENT = 'NoSuchLibrary_ZzzQqq';
    assert(findInstalledLibraryArchive(ABSENT) === null,
        'an uninstalled library resolves to no archive');
    const first = getNestedNamespaceSymbols(ABSENT);
    assert(Array.isArray(first) && first.length === 0,
        'an uninstalled nested namespace yields an empty list, not an exception');
    assert(getNestedNamespaceSymbols(ABSENT) === first,
        'the miss is cached — the same array comes back, so the store is not rescanned per keystroke');
    assert(getNestedNamespaceSymbols('').length === 0 && getNestedNamespaceSymbols(null).length === 0,
        'an empty or null segment is a miss, not a crash');
}

// ── 2. The gate: only a referenced namespace head opens the store ────────────────────────────────
// With no namespaces indexed at all, NOTHING is a library namespace, so a two-part head must be
// refused outright — this is the state a project without a .plcproj is in.
{
    clearLibraryNamespaces();
    assert(completeAfter('VisuElems.VisuElemBase.').length === 0,
        'with no .plcproj namespaces indexed, even a real nested path resolves to nothing');
    assert(completeAfter('stAxis.MotionState.').length === 0,
        'an ordinary member path is never treated as a nested namespace');
    assert(completeAfter('a.b.c.').length === 0,
        'a three-part head is refused: past two segments a name is a symbol, not a namespace');
}

// ── 3. Real resolution, when this machine actually has a nested library installed ────────────────
// Picked by scanning the store rather than hardcoding a library: which are installed varies per
// machine, and a hardcoded name would turn a fine machine into a red build.
function findAnyInstalledLibrary() {
    let companies;
    try { companies = fs.readdirSync(MANAGED_LIBRARIES, { withFileTypes: true }); } catch (e) { return null; }
    for (const company of companies) {
        if (!company.isDirectory()) continue;
        let libs;
        try { libs = fs.readdirSync(path.join(MANAGED_LIBRARIES, company.name), { withFileTypes: true }); } catch (e) { continue; }
        for (const lib of libs) {
            if (!lib.isDirectory()) continue;
            const archive = findInstalledLibraryArchive(lib.name);
            if (archive && getNestedNamespaceSymbols(lib.name).length > 0) return lib.name;
        }
    }
    return null;
}

const installed = findAnyInstalledLibrary();
if (!installed) {
    console.log('\n[SKIP] no readable library found under the Managed Libraries store '
        + `(${MANAGED_LIBRARIES}) — real nested resolution not exercised on this machine.`);
} else {
    console.log(`\n--- real resolution against installed library "${installed}" ---`);
    const symbols = getNestedNamespaceSymbols(installed);
    assert(symbols.length > 0, `${installed} harvests symbols from its archive (${symbols.length})`);
    assert(symbols.every(s => typeof s === 'string' && s.length > 0),
        'every harvested symbol is a non-empty string');
    assert(new Set(symbols).size === symbols.length, 'the harvested list is de-duplicated');

    // The cache must return the identical array — a re-harvest of a 6 MB archive per keystroke is
    // exactly the cost this lazy path exists to avoid.
    const t0 = Date.now();
    assert(getNestedNamespaceSymbols(installed) === symbols, 'a hit is cached by identity');
    assert(Date.now() - t0 < 15, 'a cached hit is effectively free');

    // Case-insensitivity: a user types the namespace as spelled in their code, not as on disk.
    assert(getNestedNamespaceSymbols(installed.toUpperCase()).length === symbols.length,
        'the lookup is case-insensitive');
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll nested-namespace assertions passed.');
