/**
 * @file test_library_completion.js
 * @description Library symbols in autocompletion, and the namespace attribution that makes them
 * offerable at all.
 *
 * The problem this guards. Library symbols ARE indexed (1,551 names from the sample's 3 archives,
 * and tens of thousands on a real project, plus the project's `.tmc`), but a `LIBRARY` node is not
 * in TYPE_NODE_KINDS, so a type caret never offered one: `fbTimer : T▮` suggested no `TON`. The
 * naive fix — admit LIBRARY to TYPE_NODE_KINDS — is the one thing that must NOT happen: it empties
 * every bare library name into every type caret.
 *
 * The design instead makes library types reachable by *qualifying* the caret, which is how TwinCAT
 * code writes them (`Tc2_Standard.TON`, `Tc2_System.ST_AmsAddr`):
 *
 *   1. a type caret additionally offers the library NAMESPACES (3 in the sample) — few, and
 *      legitimate type prefixes — while staying types-only otherwise;
 *   2. `Tc2_Standard.▮` offers that one library's symbols, a list narrowed by construction;
 *   3. unqualified library symbols keep completing exactly where they did (TwinCAT auto-imports the
 *      namespaces, so a bare `TON` is legal and common) — this feature only ever ADDS.
 *
 * Attribution — which library a name came from — is recovered without guessing, from the `.plcproj`
 * (namespace + library title) matched against the archive path, and from the `.tmc`'s explicit
 * `Namespace="…"` tags. An archive that matches no declared title stays unattributed: its symbols
 * remain in the flat, unqualified registry and appear under no prefix. The negative assertions below
 * are the point — a namespace must never answer with a symbol that is not its own, and an unknown
 * prefix must answer with nothing at all.
 *
 * Needs the real sample project (its `_Libraries` and `.tmc`); skips cleanly when absent.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideCompletions } = require('../src/lsp/features');
const { STANDARD_TYPES } = require('../src/lsp/builtins');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { indexLibraryNamespaces, clearLibraryNamespaces } = require('../src/lsp/libraries');
const {
    indexLibrarySymbols,
    indexTypeSystem,
    clearLibrarySymbols,
    registerLibrarySymbolNodes,
    getNamespaceSymbols,
    getLibraryNamespaceNames,
    getNamespaceCoverage,
    getLibrarySymbols,
    archiveNamespace
} = require('../src/lsp/libsymbols');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const SAMPLE_DIR = path.join(__dirname, '..', 'sample');

/** Finds a `_Libraries` folder under sample/, or null. */
function findLibrariesDir(dir, depth = 0) {
    if (depth > 3 || !fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name.toLowerCase() === '_libraries') return path.join(dir, e.name);
        const hit = findLibrariesDir(path.join(dir, e.name), depth + 1);
        if (hit) return hit;
    }
    return null;
}

if (!findLibrariesDir(SAMPLE_DIR)) {
    console.log('\n=== LIBRARY COMPLETION ===');
    console.log('  skip  sample/**/_Libraries not present — nothing to attribute, nothing to complete.');
    console.log('\n--- LIBRARY COMPLETION TESTS SKIPPED ---');
    process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Index the real project's external symbols, exactly as server.js indexLibraries() does.
// ---------------------------------------------------------------------------------------------

clearLibraryNamespaces();
clearLibrarySymbols();
const nsFound = indexLibraryNamespaces(SAMPLE_DIR);
const lib = indexLibrarySymbols(SAMPLE_DIR);
const tmc = indexTypeSystem(SAMPLE_DIR);
const coverage = getNamespaceCoverage();
const TOTAL_SYMBOLS = getLibrarySymbols().length;

console.log('\n=== NAMESPACE ATTRIBUTION COVERAGE ===');
console.log(`    archives : ${lib.mapped}/${lib.archives} mapped to a namespace (${lib.failed} undecodable)`);
console.log(`    .tmc     : ${tmc.attributed} type(s) attributed from ${tmc.files} file(s)`);
console.log(`    namespaces: ${coverage.mapped}/${coverage.namespaces} carry symbols; ` +
            `${coverage.symbols} attributed of ${TOTAL_SYMBOLS} total`);
const empties = getLibraryNamespaceNames().filter(n => getNamespaceSymbols(n).length === 0);
console.log(`    unattributed namespaces (${empties.length}): ${empties.join(', ') || 'none'}`);
console.log('');

// ---------------------------------------------------------------------------------------------
// A synthetic active document, in the workspace of the real library index.
// ---------------------------------------------------------------------------------------------

let uid = 0;
const guid = () => `{00000000-0000-0000-0000-${String(++uid).padStart(12, '0')}}`;

/** Builds a .TcPOU document. */
function tcpou(name, decl, impl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="${guid()}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl || ''}]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;
}

/** Builds a .TcDUT document. */
function tcdut(name, decl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <DUT Name="${name}" Id="${guid()}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </DUT>
</TcPlcObject>`;
}

const ST_DATA_XML = tcdut('ST_Data', 'TYPE ST_Data :\nSTRUCT\n\tnSpeed : INT;\nEND_STRUCT\nEND_TYPE');

// One POU carrying every caret under test. `nTimeout := DEFAULT_ADS_TIMEOUT;` is deliberate: a bare
// library constant, which is what registerLibrarySymbolNodes puts into the index on demand — the
// unqualified path this feature must not disturb.
const MAIN_DECL =
    'PROGRAM MAIN\n' +
    'VAR\n' +
    '\tnCount : INT;\n' +
    '\tfbTimer : Tc2_Standard.TON;\n' +
    '\tstStatus : Tc2_System.ST_AmsAddr;\n' +
    '\tstBogus : NoSuchLib.ST_Nothing;\n' +
    '\tnTimeout : UDINT;\n' +
    'END_VAR';
const MAIN_IMPL = 'nTimeout := DEFAULT_ADS_TIMEOUT;\n';
const MAIN_XML = tcpou('MAIN', MAIN_DECL, MAIN_IMPL);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_libcompl_'));
const uriOf = (f) => 'file:///' + path.join(dir, f).replace(/\\/g, '/');

/**
 * Runs completions the way the LSP server does — index the workspace, re-parse the active unit, and
 * register the library symbols the document references (server.js syncDocument) — with the caret
 * placed immediately after the first occurrence of `marker`.
 * @param {string} marker Text the caret sits directly behind.
 * @returns {Array<Object>} Completion items.
 */
function completionsAt(marker) {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    indexXmlObject(index, ST_DATA_XML, uriOf('ST_Data.TcDUT'));
    indexXmlObject(index, MAIN_XML, uriOf('MAIN.TcPOU'));

    const { stText } = convertXmlToSt(parseTwinCatXml(MAIN_XML), { raw: true });
    parseAndIndexDocument(stText, uriOf('MAIN.TcPOU'));
    registerLibrarySymbolNodes(getWorkspaceSymbolIndex(), stText);

    const lines = stText.split('\n');
    const lineIdx = lines.findIndex(l => l.includes(marker));
    if (lineIdx === -1) throw new Error(`test bug: no ST line contains "${marker}"`);
    const character = lines[lineIdx].indexOf(marker) + marker.length;

    return provideCompletions(stText, { line: lineIdx, character }, getWorkspaceSymbolIndex(), uriOf('MAIN.TcPOU')) || [];
}

const labelsOf = (items) => items.map(i => i.label);
const has = (items, label) => labelsOf(items).some(l => l.toLowerCase() === label.toLowerCase());
const snippetsOf = (items) => items.filter(i => i.kind === 27).map(i => i.label);
const modulesOf = (items) => items.filter(i => i.kind === 9).map(i => i.label);

/** Every terminator / keyword / snippet that must never reach a type caret. */
const JUNK = ['END_IF', 'END_VAR', 'END_CASE', 'THEN', 'ELSE', 'IF', 'FOR', 'WHILE', 'RETURN'];
const leaked = (items, bad) => bad.filter(l => has(items, l)).join(', ');

const counts = {};
const record = (name, items) => { counts[name] = items.length; return items; };

try {
    // ---- 1. Attribution: a symbol is filed under the library that declares it -------------------
    console.log('=== 1. symbol -> namespace attribution ===');

    assert(nsFound.length === 3 && coverage.namespaces === 3,
        `the .plcproj declares 3 library namespaces (got ${coverage.namespaces})`);
    assert(getLibraryNamespaceNames().includes('Tc2_System'),
        'namespaces keep the project\'s own spelling (Tc2_System, not tc2_system)');

    // Measured 2026-07-20: Tc2_Standard 313, Tc2_System 1293, Tc3_Module 461 attributed symbols,
    // over a flat registry of 1,551 distinct names.
    const std = getNamespaceSymbols('Tc2_Standard');
    const sys = getNamespaceSymbols('Tc2_System');
    const mod = getNamespaceSymbols('Tc3_Module');
    assert(std.some(s => s === 'TON') && std.some(s => s === 'CTUD'),
        `Tc2_Standard owns TON and CTUD (${std.length} symbols)`);
    assert(sys.some(s => s === 'DEFAULT_ADS_TIMEOUT') && sys.some(s => s === 'ST_AmsAddr'),
        `Tc2_System owns DEFAULT_ADS_TIMEOUT and ST_AmsAddr (${sys.length} symbols)`);
    assert(mod.some(s => s === 'FW_SafeRelease') && mod.some(s => s === 'TcBaseModule'),
        `Tc3_Module owns FW_SafeRelease and TcBaseModule (${mod.length} symbols)`);

    // The negative that matters: a name belongs to the library that ships it, and to no other.
    assert(!std.includes('DEFAULT_ADS_TIMEOUT') && !std.includes('FW_SafeRelease'),
        'Tc2_System\'s and Tc3_Module\'s symbols are NOT filed under Tc2_Standard');
    assert(!sys.includes('CTUD') && !mod.includes('CTUD'),
        'Tc2_Standard\'s CTUD is NOT filed under Tc2_System or Tc3_Module');

    // Lookups are case-insensitive, as Structured Text is.
    assert(getNamespaceSymbols('tc2_system').length === sys.length &&
        getNamespaceSymbols('TC2_SYSTEM').length === sys.length,
        'namespace lookup is case-insensitive');

    // COVERAGE NOTE. The customer project shipped 88 archives against 28 declared namespaces, so
    // attribution was necessarily *partial* — transitive dependencies had no importable prefix and
    // the old assertion here was `coverage.symbols < TOTAL_SYMBOLS`. The synthetic sample has one
    // archive per declared library, so all 3 map and nothing is left unattributed; the sum of the
    // per-namespace lists (2,067) now EXCEEDS the flat registry (1,551) because names shared between
    // libraries (Global_Version, MEMCPY, …) are counted once per owner. Re-point this to the partial
    // form if an unattributable archive ever lands in the sample.
    assert(lib.mapped === lib.archives && lib.archives === 3,
        `every archive maps to a declared library title (${lib.mapped}/${lib.archives})`);
    assert(coverage.mapped === coverage.namespaces,
        `every declared namespace carries symbols (${coverage.mapped}/${coverage.namespaces})`);
    assert(coverage.symbols === std.length + sys.length + mod.length,
        `coverage counts per-namespace membership, shared names once per owner ` +
        `(${coverage.symbols} = ${std.length} + ${sys.length} + ${mod.length}, over ${TOTAL_SYMBOLS} distinct)`);

    // The fallback rule that must never soften: never guess.
    assert(archiveNamespace(path.join(SAMPLE_DIR, 'nowhere', 'unknown-lib.compiled-library')) === null,
        'an archive whose path matches no declared library title is NOT attributed');

    // ---- 2. Type caret: namespaces are offered, and nothing else changes ------------------------
    console.log('\n=== 2. type caret (`x : ▮`) ===');

    const cType = record('type caret', completionsAt('nCount : '));
    const mods = modulesOf(cType);
    assert(mods.length === 3,
        `all 3 library namespaces are offered as module items (got ${mods.length})`);
    assert(has(cType, 'Tc2_Standard') && has(cType, 'Tc2_System') && has(cType, 'Tc3_Module'),
        'namely Tc2_Standard, Tc2_System and Tc3_Module');
    assert(has(cType, 'INT') && has(cType, 'BOOL') && has(cType, 'ST_Data'),
        'elementary and project types are still offered');
    assert(leaked(cType, JUNK) === '' && snippetsOf(cType).length === 0,
        `the caret stays types-only — no keywords, no snippets (leaked: [${leaked(cType, JUNK)}])`);
    assert(!has(cType, 'nCount') && !has(cType, 'nTimeout'),
        '…and no variables');

    // The bare library names must NOT be here. That is the whole reason the namespaces are.
    assert(cType.length < 200,
        `the type caret is not flooded with library symbols (${cType.length} items, of ${TOTAL_SYMBOLS} known)`);
    assert(!has(cType, 'FW_SafeRelease') && !has(cType, 'DEFAULT_ADS_TIMEOUT'),
        'a bare library symbol is not offered unqualified at a type caret');

    // ---- 3. Qualified caret: `Tc2_Standard.▮` narrows to that library ---------------------------
    console.log('\n=== 3. namespace-qualified caret (`Tc2_Standard.▮`) ===');

    const cNs = record('Tc2_Standard.', completionsAt('fbTimer : Tc2_Standard.'));
    // The list is that namespace's symbols, minus the elementary types every library's string table
    // carries because it *uses* them (`Tc2_Standard.INT` is not a thing) — see libraryNamespaceMembers.
    const expected = std.filter(s => !STANDARD_TYPES.has(s.toUpperCase()));
    assert(cNs.length === expected.length && cNs.length > 0,
        `offers exactly Tc2_Standard's symbols (${cNs.length})`);
    // …and a library FB that happens to share a builtin's name IS still its member: TON is real.
    assert(has(cNs, 'TON') && has(cNs, 'CTUD'),
        'including TON and CTUD — a library FB is not filtered out for looking like a builtin');
    assert(cNs.length < TOTAL_SYMBOLS / 4,
        `and NOT the whole registry (${cNs.length} of ${TOTAL_SYMBOLS})`);
    assert(!has(cNs, 'DEFAULT_ADS_TIMEOUT') && !has(cNs, 'FW_SafeRelease') && !has(cNs, 'nCount'),
        'no other library\'s symbols, and no project variables');
    assert(!has(cNs, 'INT') && !has(cNs, 'DWORD') && !has(cNs, 'BOOL'),
        'no elementary types — a namespace does not re-export INT');
    assert(cNs.every(i => i.detail && i.detail.includes('Tc2_Standard')),
        'every item names the library it came from');

    // The same narrowing on the largest library, so the exact-count invariant is not only checked on
    // the small one: Tc2_System is 1,293 of the 1,551 known names and must still exclude the others'.
    const cSys = record('Tc2_System.', completionsAt('stStatus : Tc2_System.'));
    const expectedSys = sys.filter(s => !STANDARD_TYPES.has(s.toUpperCase()));
    assert(cSys.length === expectedSys.length && cSys.length > 0,
        `Tc2_System.▮ offers exactly its own symbols (${cSys.length})`);
    assert(has(cSys, 'ST_AmsAddr') && has(cSys, 'DEFAULT_ADS_TIMEOUT'),
        'including the types and constants the sample declares with that prefix');
    assert(!has(cSys, 'CTUD') && !has(cSys, 'FW_SafeRelease'),
        'and none of Tc2_Standard\'s or Tc3_Module\'s');

    // ---- 4. Unknown / unmapped prefixes fail safe -----------------------------------------------
    console.log('\n=== 4. unknown and unmapped prefixes ===');

    const cBogus = record('NoSuchLib.', completionsAt('stBogus : NoSuchLib.'));
    assert(cBogus.length === 0,
        `an unknown namespace prefix offers nothing — no crash, no invented names (got ${cBogus.length})`);

    // A namespace whose archive could not be read (the customer project's VisuElems shipped only as
    // the opaque `.compiled-library-v3`) has no symbols. It must still be offered as a prefix, and
    // answer with nothing rather than junk. The synthetic sample has no such library — all 3 map —
    // so this branch does not run here; it returns with an unreadable-archive fixture.
    if (empties.length > 0) {
        const empty = empties[0];
        assert(getNamespaceSymbols(empty).length === 0 && has(cType, empty),
            `${empty} has no attributable archive: still offered as a prefix, answers with nothing`);
    }

    // A half-typed line must never throw.
    let survived = true;
    try {
        completionsAt('stStatus : Tc2_System.ST_A');  // partially typed member
        completionsAt('fbTimer : ');                  // type caret, no namespace typed
        completionsAt('stBogus : NoSuchLib');         // namespace head, dot not typed yet
    } catch (e) {
        survived = false;
        console.error('   threw: ' + e.message);
    }
    assert(survived, 'a partially typed line never throws');

    // ---- 5. What worked before still works ------------------------------------------------------
    console.log('\n=== 5. unqualified library symbols (unchanged behaviour) ===');

    const cValue = record('value caret', completionsAt('nTimeout := '));
    assert(has(cValue, 'DEFAULT_ADS_TIMEOUT'),
        'a library symbol the document references still completes unqualified at a value caret');
    assert(has(cValue, 'nCount') && has(cValue, 'TRUE'),
        '…alongside the ordinary value list');
    assert(modulesOf(cValue).length === 0,
        'namespaces are NOT injected at a value caret — they are a type prefix, not a value');

    // ---- 6. Latency at the qualified caret ------------------------------------------------------
    console.log('\n=== 6. completion latency ===');

    // Everything the request needs is prepared once; only provideCompletions is timed, which is what
    // runs per keystroke. The namespace -> symbols map is built at index time, so this must be a map
    // lookup and a list build — never a scan of the whole registry.
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    indexXmlObject(index, MAIN_XML, uriOf('MAIN.TcPOU'));
    const { stText } = convertXmlToSt(parseTwinCatXml(MAIN_XML), { raw: true });
    parseAndIndexDocument(stText, uriOf('MAIN.TcPOU'));
    registerLibrarySymbolNodes(getWorkspaceSymbolIndex(), stText);
    const lines = stText.split('\n');
    // Timed on the LARGEST namespace (Tc2_System, 1,278 offerable symbols) — the worst case.
    const line = lines.findIndex(l => l.includes('Tc2_System.'));
    const character = lines[line].indexOf('Tc2_System.') + 'Tc2_System.'.length;

    const N = 50;
    const started = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
        provideCompletions(stText, { line, character }, getWorkspaceSymbolIndex(), uriOf('MAIN.TcPOU'));
    }
    const perCall = Number(process.hrtime.bigint() - started) / 1e6 / N;
    console.log(`    ${perCall.toFixed(2)} ms/call at a namespace-dot caret (${cSys.length} items)`);
    assert(perCall < 25, `stays well under a keystroke's budget (${perCall.toFixed(2)} ms)`);

    // ---- Summary --------------------------------------------------------------------------------
    console.log('\n=== suggestion counts per caret ===');
    Object.keys(counts).forEach(k => console.log(`    ${k.padEnd(14)} ${counts[k]}`));

} catch (e) {
    console.error(`[FATAL] ${e.stack}`);
    errors++;
} finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir: ignore */ }
}

console.log(`\n--- LIBRARY COMPLETION TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
