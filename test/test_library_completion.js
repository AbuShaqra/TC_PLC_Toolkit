/**
 * @file test_library_completion.js
 * @description Library symbols in autocompletion, and the namespace attribution that makes them
 * offerable at all.
 *
 * The problem this guards. Library symbols ARE indexed (measured 2026-07-20: 502 names from the
 * sample's committed archive and `.tmc` alone, 4,028 with the git-ignored Beckhoff archives there
 * too, and tens of thousands on a real project), but a `LIBRARY` node is not in TYPE_NODE_KINDS, so
 * a type caret never offered one: `fbList : F▮` suggested no `FB_List`. The naive fix — admit
 * LIBRARY to TYPE_NODE_KINDS — is the one thing that must NOT happen: it empties every bare library
 * name into every type caret.
 *
 * The design instead makes library types reachable by *qualifying* the caret, which is how TwinCAT
 * code writes them (`TcDynCollections.FB_List`, `Tc2_System.ST_AmsAddr`):
 *
 *   1. a type caret additionally offers the library NAMESPACES (4 in the sample) — few, and
 *      legitimate type prefixes — while staying types-only otherwise;
 *   2. `TcDynCollections.▮` offers that one library's symbols, a list narrowed by construction;
 *   3. unqualified library symbols keep completing exactly where they did (TwinCAT auto-imports the
 *      namespaces, so a bare `FB_List` is legal and common) — this feature only ever ADDS.
 *
 * Attribution — which library a name came from — is recovered without guessing, from the `.plcproj`
 * (namespace + library title) matched against the archive path, and from the `.tmc`'s explicit
 * `Namespace="…"` tags. An archive that matches no declared title stays unattributed: its symbols
 * remain in the flat, unqualified registry and appear under no prefix. The negative assertions below
 * are the point — a namespace must never answer with a symbol that is not its own, and an unknown
 * prefix must answer with nothing at all.
 *
 * The unattributed case is not hypothetical here. Building the sample in TwinCAT XAE left a FIFTH
 * archive in `_Libraries` — `Beckhoff Automation GmbH/Tc2_Utilities/` — that no `<PlaceholderReference>`
 * in the `.plcproj` declares. So "every archive on disk maps to a namespace" is NOT an invariant, and
 * §1 does not assert it: what must hold is that every archive matching a *declared* title is
 * attributed, and that an archive matching none is attributed to nothing rather than to a plausible
 * neighbour. Tc2_Utilities is now the real-data fixture for that second half.
 *
 * WHICH FIXTURES THIS NEEDS. The `.plcproj`, the project's `.tmc` and the MIT-licensed TwinCAT
 * Dynamic Collections archive are COMMITTED, so everything keyed to the 4 declared namespaces and to
 * TcDynCollections' 479 symbols runs on CI and on a fresh clone. The Beckhoff archives are
 * git-ignored vendor binaries: assertions that need a SECOND attributed library — cross-library
 * negatives, "the caret narrows to less than the whole registry", a library FB that shadows a
 * builtin name (`TON`), and the undeclared-archive case above — are only observable where they
 * exist, and are gated on their presence. Note the mirror image is covered too, and only on CI:
 * without the Beckhoff archives, three declared namespaces carry no symbols at all, which exercises
 * §4's "declared but unattributable" branch for real.
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

const { SAMPLE_DIR, MIT_NAMESPACE, sampleArchiveFixtures, skipBeckhoff } = require('./_baseline');

const fixtures = sampleArchiveFixtures(SAMPLE_DIR);

if (!fixtures.hasMit) {
    // The MIT archive is committed, so this is not the normal CI state — it means the working copy was
    // pruned by hand. Skip rather than fail, but say which fixture is missing.
    console.log('\n=== LIBRARY COMPLETION ===');
    console.log('  skip  the committed MIT archive (sample/**/_Libraries/fisothemes/) is not present —');
    console.log('        nothing to attribute, nothing to complete.');
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

// One POU carrying every caret under test. `nVersion := Global_Version;` is deliberate: a bare
// library global, which is what registerLibrarySymbolNodes puts into the index on demand — the
// unqualified path this feature must not disturb. Naming FB_Hash_Map in the declaration is equally
// deliberate: it puts that symbol IN the index, which is what makes §2's "still not offered at a type
// caret" a real assertion rather than a vacuous one.
//
// The two Beckhoff-qualified declarations stay in the document unconditionally even though those
// libraries resolve to nothing on CI: this harness runs completions, never diagnostics, so an
// unresolvable type here costs nothing and it keeps the gated carets available on a machine that has
// the archives.
const MAIN_DECL =
    'PROGRAM MAIN\n' +
    'VAR\n' +
    '\tnCount : INT;\n' +
    '\tfbList : TcDynCollections.FB_List;\n' +
    '\tfbMap : TcDynCollections.FB_Hash_Map;\n' +
    '\tfbTimer : Tc2_Standard.TON;\n' +
    '\tstStatus : Tc2_System.ST_AmsAddr;\n' +
    '\tstBogus : NoSuchLib.ST_Nothing;\n' +
    '\tnVersion : UDINT;\n' +
    'END_VAR';
const MAIN_IMPL = 'nVersion := Global_Version;\n';
const MAIN_XML = tcpou('MAIN', MAIN_DECL, MAIN_IMPL);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_libcompl_'));
const uriOf = (f) => 'file:///' + path.join(dir, f).replace(/\\/g, '/').replace(/^\//, '');

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

    // The namespaces come from the committed .plcproj, so this is 4 in every configuration — an
    // archive that was never copied in does not un-declare its reference.
    assert(nsFound.length === 4 && coverage.namespaces === 4,
        `the .plcproj declares 4 library namespaces (got ${coverage.namespaces})`);
    assert(getLibraryNamespaceNames().includes('Tc2_System') &&
        getLibraryNamespaceNames().includes(MIT_NAMESPACE),
        'namespaces keep the project\'s own spelling (Tc2_System, not tc2_system)');

    // Measured 2026-07-20: TcDynCollections 479 attributed symbols, over a flat registry of 479
    // distinct names on CI and 1,950 with the Beckhoff archives present.
    const dyn = getNamespaceSymbols(MIT_NAMESPACE);
    assert(dyn.some(s => s === 'FB_Hash_Map') && dyn.some(s => s === 'I_List') &&
        dyn.some(s => s === 'E_COMPARISON') && dyn.some(s => s === 'F_Murmur3_Hash'),
        `${MIT_NAMESPACE} owns FB_Hash_Map, I_List, E_COMPARISON and F_Murmur3_Hash (${dyn.length} symbols)`);

    // Attribution resolved the archive through the .plcproj's *title* ("TwinCat Dynamic Collections"),
    // which is neither the namespace nor the on-disk file name (tcdyncollections.library) — the exact
    // three-way mismatch the attribution code exists to bridge.
    assert(dyn.length === 479,
        `${MIT_NAMESPACE} resolves through its differing title to all 479 of its symbols (got ${dyn.length})`);

    // Lookups are case-insensitive, as Structured Text is.
    assert(getNamespaceSymbols(MIT_NAMESPACE.toLowerCase()).length === dyn.length &&
        getNamespaceSymbols(MIT_NAMESPACE.toUpperCase()).length === dyn.length,
        'namespace lookup is case-insensitive');

    // An archive is attributed only when its path matches a DECLARED library title, and never more
    // than one archive per namespace. `mapped === archives` is deliberately NOT asserted: TwinCAT
    // leaves archives in `_Libraries` that the `.plcproj` does not reference (Tc2_Utilities, see the
    // header), and an unattributed archive is the correct outcome for one of those — its symbols stay
    // in the flat registry and appear under no prefix. Measured 2026-07-20: 1/1 on CI, 4/5 here.
    assert(lib.archives >= 1 && lib.mapped >= 1 && lib.mapped <= coverage.namespaces,
        `every archive that maps, maps to one of the declared namespaces (${lib.mapped}/${lib.archives} ` +
        `archives, ${coverage.namespaces} namespaces)`);
    assert(coverage.mapped >= 1 && coverage.mapped <= coverage.namespaces,
        `at least one declared namespace carries symbols (${coverage.mapped}/${coverage.namespaces})`);

    // Configuration-independent because it is summed rather than hard-coded: coverage counts
    // per-namespace membership, so a name shared between two libraries is counted once per owner and
    // the total can exceed the flat registry. Measured 2,546 over 4,028 distinct with all five
    // archives plus the `.tmc`; 479 over 502 with the committed archive and `.tmc` alone.
    const perNamespaceTotal = getLibraryNamespaceNames()
        .reduce((n, ns) => n + getNamespaceSymbols(ns).length, 0);
    assert(coverage.symbols === perNamespaceTotal,
        `coverage counts per-namespace membership, shared names once per owner ` +
        `(${coverage.symbols} = sum of the ${coverage.namespaces} namespace lists, over ${TOTAL_SYMBOLS} distinct)`);

    // The fallback rule that must never soften: never guess.
    assert(archiveNamespace(path.join(SAMPLE_DIR, 'nowhere', 'unknown-lib.compiled-library')) === null,
        'an archive whose path matches no declared library title is NOT attributed');

    // BONUS COVERAGE (developer machine only). "A name belongs to the library that ships it and to no
    // other" is the negative that matters most here, and it is only meaningful with a SECOND
    // attributed library to be wrong about — on CI the other three namespaces are empty, so every
    // such negative would hold vacuously and guard nothing. Measured 2026-07-20: Tc2_Standard 313,
    // Tc2_System 1,293, Tc3_Module 461.
    if (!fixtures.hasBeckhoff) {
        skipBeckhoff('cross-library attribution negatives');
    } else {
        const std = getNamespaceSymbols('Tc2_Standard');
        const sys = getNamespaceSymbols('Tc2_System');
        const mod = getNamespaceSymbols('Tc3_Module');
        assert(std.some(s => s === 'TON') && std.some(s => s === 'CTUD'),
            `Tc2_Standard owns TON and CTUD (${std.length} symbols)`);
        assert(sys.some(s => s === 'DEFAULT_ADS_TIMEOUT') && sys.some(s => s === 'ST_AmsAddr'),
            `Tc2_System owns DEFAULT_ADS_TIMEOUT and ST_AmsAddr (${sys.length} symbols)`);
        assert(mod.some(s => s === 'FW_SafeRelease') && mod.some(s => s === 'TcBaseModule'),
            `Tc3_Module owns FW_SafeRelease and TcBaseModule (${mod.length} symbols)`);
        assert(!std.includes('DEFAULT_ADS_TIMEOUT') && !std.includes('FW_SafeRelease'),
            'Tc2_System\'s and Tc3_Module\'s symbols are NOT filed under Tc2_Standard');
        assert(!sys.includes('CTUD') && !mod.includes('CTUD'),
            'Tc2_Standard\'s CTUD is NOT filed under Tc2_System or Tc3_Module');
        assert(!dyn.includes('TON') && !dyn.includes('DEFAULT_ADS_TIMEOUT') && !std.includes('FB_Hash_Map'),
            'the MIT library and the Beckhoff libraries do not borrow each other\'s symbols');
        assert(lib.mapped === 4 && coverage.mapped === coverage.namespaces,
            `all 4 declared libraries resolved to an archive and carry symbols ` +
            `(${lib.mapped}/${lib.archives} archives, ${coverage.mapped}/${coverage.namespaces} namespaces)`);

        // The never-guess rule, on real data rather than on a made-up path. TwinCAT's build copied
        // Tc2_Utilities into `_Libraries` although the `.plcproj` declares no reference to it, and it
        // sits right beside three archives that ARE declared and share its vendor directory — the
        // exact shape a fuzzy match would get wrong. It must be attributed to nothing, and none of
        // its symbols may surface under a neighbouring namespace.
        const stray = fixtures.archives.filter(p => /tc2_utilities/i.test(path.basename(p)));
        if (stray.length === 0) {
            console.log('    [skip] no undeclared archive in this working copy — the never-guess rule is');
            console.log('           still covered by the synthetic path above.');
        } else {
            assert(stray.every(p => archiveNamespace(p) === null),
                `an archive the .plcproj never references is attributed to nothing ` +
                `(${stray.map(p => path.basename(p)).join(', ')})`);
            assert(lib.archives > lib.mapped,
                `…so it is counted as present but unmapped (${lib.mapped} of ${lib.archives} archives mapped)`);
            // Measured 2026-07-20: Tc2_Utilities harvests 2,697 names, 2,153 of which appear in none
            // of the three declared Beckhoff archives. FB_GetLocalAmsNetId is one of them — it must
            // reach the flat registry (so a document naming it is not flagged undeclared) and appear
            // under no namespace list at all.
            const strayNames = new Set(getLibrarySymbols());
            const STRAY = 'FB_GetLocalAmsNetId';
            assert(strayNames.has(STRAY) &&
                !std.includes(STRAY) && !sys.includes(STRAY) &&
                !mod.includes(STRAY) && !dyn.includes(STRAY),
                `its symbols reach the flat registry but no namespace list (${STRAY})`);
        }
    }

    // ---- 2. Type caret: namespaces are offered, and nothing else changes ------------------------
    console.log('\n=== 2. type caret (`x : ▮`) ===');

    const cType = record('type caret', completionsAt('nCount : '));
    const mods = modulesOf(cType);
    // 4 in every configuration: the namespaces come from the .plcproj, not from the archives, so a
    // library whose binary is absent is still a legitimate type prefix to offer.
    assert(mods.length === 4,
        `all 4 library namespaces are offered as module items (got ${mods.length})`);
    assert(has(cType, 'TcDynCollections') && has(cType, 'Tc2_Standard') &&
        has(cType, 'Tc2_System') && has(cType, 'Tc3_Module'),
        'namely TcDynCollections, Tc2_Standard, Tc2_System and Tc3_Module');
    assert(has(cType, 'INT') && has(cType, 'BOOL') && has(cType, 'ST_Data'),
        'elementary and project types are still offered');
    assert(leaked(cType, JUNK) === '' && snippetsOf(cType).length === 0,
        `the caret stays types-only — no keywords, no snippets (leaked: [${leaked(cType, JUNK)}])`);
    assert(!has(cType, 'nCount') && !has(cType, 'nVersion'),
        '…and no variables');

    // The bare library names must NOT be here. That is the whole reason the namespaces are.
    assert(cType.length < 200,
        `the type caret is not flooded with library symbols (${cType.length} items, of ${TOTAL_SYMBOLS} known)`);
    // Both names are in the workspace index — MAIN declares fbMap : TcDynCollections.FB_Hash_Map and
    // assigns Global_Version, so registerLibrarySymbolNodes put both there. That is what makes this a
    // real assertion: a LIBRARY node is present and must still not reach a type caret unqualified.
    assert(!has(cType, 'FB_Hash_Map') && !has(cType, 'Global_Version'),
        'a bare library symbol is not offered unqualified at a type caret');

    // ---- 3. Qualified caret: `TcDynCollections.▮` narrows to that library -----------------------
    console.log('\n=== 3. namespace-qualified caret (`TcDynCollections.▮`) ===');

    const cNs = record('TcDynCollections.', completionsAt('fbList : TcDynCollections.'));
    // The list is that namespace's symbols, minus the elementary types every library's string table
    // carries because it *uses* them (`TcDynCollections.BOOL` is not a thing) — see
    // libraryNamespaceMembers. Measured 2026-07-20: 479 symbols, 478 offerable (BOOL is filtered).
    const expected = dyn.filter(s => !STANDARD_TYPES.has(s.toUpperCase()));
    assert(cNs.length === expected.length && cNs.length > 0,
        `offers exactly TcDynCollections's symbols (${cNs.length})`);
    assert(has(cNs, 'FB_Hash_Map') && has(cNs, 'I_List') && has(cNs, 'ST_MAP_ENTRY'),
        'including FB_Hash_Map, I_List and ST_MAP_ENTRY');
    assert(!has(cNs, 'nCount') && !has(cNs, 'ST_Data'),
        'and no project variables or project types');
    assert(!has(cNs, 'INT') && !has(cNs, 'DWORD') && !has(cNs, 'BOOL'),
        'no elementary types — a namespace does not re-export INT');
    assert(cNs.every(i => i.detail && i.detail.includes(MIT_NAMESPACE)),
        'every item names the library it came from');

    // BONUS COVERAGE (developer machine only). Two things are simply not observable with a single
    // attributed library, and both are worth keeping where they can be:
    //   - "narrows to LESS than the whole registry" — on CI TcDynCollections IS the whole registry,
    //     so the exact-count assertion above is the only form of it available;
    //   - a library FB that shadows a builtin name (Tc2_Standard.TON) must survive the elementary-type
    //     filter. The MIT archive has no such name — BOOL is its only STANDARD_TYPES collision, and
    //     that one is a genuine elementary type it merely uses.
    // Also re-checks the exact-count invariant on the LARGEST library (Tc2_System, 1,293 of the 1,950
    // known names), so it is not only verified on a small one.
    if (!fixtures.hasBeckhoff) {
        skipBeckhoff('registry-narrowing and builtin-shadowing carets');
    } else {
        assert(cNs.length < TOTAL_SYMBOLS,
            `and NOT the whole registry (${cNs.length} of ${TOTAL_SYMBOLS})`);
        assert(!has(cNs, 'DEFAULT_ADS_TIMEOUT') && !has(cNs, 'FW_SafeRelease'),
            'no other library\'s symbols');

        const cStd = record('Tc2_Standard.', completionsAt('fbTimer : Tc2_Standard.'));
        const expectedStd = getNamespaceSymbols('Tc2_Standard').filter(s => !STANDARD_TYPES.has(s.toUpperCase()));
        assert(cStd.length === expectedStd.length && cStd.length > 0,
            `Tc2_Standard.▮ offers exactly its own symbols (${cStd.length})`);
        assert(has(cStd, 'TON') && has(cStd, 'CTUD'),
            'including TON and CTUD — a library FB is not filtered out for looking like a builtin');

        const cSys = record('Tc2_System.', completionsAt('stStatus : Tc2_System.'));
        const expectedSys = getNamespaceSymbols('Tc2_System').filter(s => !STANDARD_TYPES.has(s.toUpperCase()));
        assert(cSys.length === expectedSys.length && cSys.length > 0,
            `Tc2_System.▮ offers exactly its own symbols (${cSys.length})`);
        assert(has(cSys, 'ST_AmsAddr') && has(cSys, 'DEFAULT_ADS_TIMEOUT'),
            'including the types and constants the sample declares with that prefix');
        assert(!has(cSys, 'CTUD') && !has(cSys, 'FW_SafeRelease') && !has(cSys, 'FB_Hash_Map'),
            'and none of Tc2_Standard\'s, Tc3_Module\'s or TcDynCollections\'s');
    }

    // ---- 4. Unknown / unmapped prefixes fail safe -----------------------------------------------
    console.log('\n=== 4. unknown and unmapped prefixes ===');

    const cBogus = record('NoSuchLib.', completionsAt('stBogus : NoSuchLib.'));
    assert(cBogus.length === 0,
        `an unknown namespace prefix offers nothing — no crash, no invented names (got ${cBogus.length})`);

    // A namespace that is DECLARED but carries no symbols — because its archive could not be read
    // (the customer project's VisuElems shipped only as the opaque `.compiled-library-v3`) or was
    // never copied in at all — must still be offered as a prefix, and answer with nothing rather than
    // junk. Note this branch is exercised precisely where the Beckhoff archives are ABSENT: on CI the
    // three Beckhoff namespaces are declared-but-empty, which is exactly the shape. The two
    // configurations therefore cover each other rather than one being a degraded copy of the other.
    if (empties.length === 0) {
        console.log('    [skip] every declared namespace resolved to an archive — no declared-but-empty');
        console.log('           namespace to check here (this branch runs on a checkout that lacks one).');
    } else {
        const empty = empties[0];
        assert(getNamespaceSymbols(empty).length === 0 && has(cType, empty),
            `${empty} has no attributable archive: still offered as a prefix, answers with nothing`);
        // The caret itself, not just the registry: `: <ns>.` matches whichever declaration in MAIN
        // uses that prefix, so this works for any of the empty namespaces.
        if (MAIN_DECL.includes(`: ${empty}.`)) {
            assert(completionsAt(`: ${empty}.`).length === 0,
                `${empty}.▮ answers with nothing rather than falling back to the flat registry`);
        }
    }

    // A half-typed line must never throw.
    let survived = true;
    try {
        completionsAt('fbMap : TcDynCollections.FB_H');  // partially typed member
        completionsAt('fbList : ');                      // type caret, no namespace typed
        completionsAt('stBogus : NoSuchLib');            // namespace head, dot not typed yet
    } catch (e) {
        survived = false;
        console.error('   threw: ' + e.message);
    }
    assert(survived, 'a partially typed line never throws');

    // ---- 5. What worked before still works ------------------------------------------------------
    console.log('\n=== 5. unqualified library symbols (unchanged behaviour) ===');

    const cValue = record('value caret', completionsAt('nVersion := '));
    assert(has(cValue, 'Global_Version'),
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
    // Timed on the largest namespace this checkout can actually offer: Tc2_System (1,278 offerable
    // symbols) where the Beckhoff archives are present, TcDynCollections (478) where they are not.
    // Both are far above the size at which a registry scan would show, which is what this measures.
    const prefix = fixtures.hasBeckhoff ? 'Tc2_System.' : 'TcDynCollections.';
    const line = lines.findIndex(l => l.includes(prefix));
    const character = lines[line].indexOf(prefix) + prefix.length;

    const N = 50;
    const started = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
        provideCompletions(stText, { line, character }, getWorkspaceSymbolIndex(), uriOf('MAIN.TcPOU'));
    }
    const perCall = Number(process.hrtime.bigint() - started) / 1e6 / N;
    const timedItems = counts[prefix] !== undefined ? counts[prefix] : cNs.length;
    console.log(`    ${perCall.toFixed(2)} ms/call at ${prefix}▮ (${timedItems} items)`);
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
