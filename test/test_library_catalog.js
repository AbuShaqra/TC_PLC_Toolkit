/**
 * @file test_library_catalog.js
 * @description The library catalog (src/lsp/libsymbols.js `getLibraryCatalog()`) that backs the
 * "TwinCAT Libraries" view.
 *
 * What the view exists for, and therefore what this guards: a library has **three** names in the
 * .plcproj, and they are routinely different strings —
 *
 *     <PlaceholderReference Include="Balluff BVS Sensor">                <- the placeholder name
 *       <DefaultResolution>Balluff Sesnor Library TC3, * (Balluff GmbH)</...>  <- the library title
 *       <Namespace>Balluff_BVS_Sensor</Namespace>                        <- what the CODE must say
 *
 * Only the last one compiles. A programmer looking for the Balluff FB has no way to guess it from
 * either of the other two, which is exactly the confusion the view removes — so the mapping is what
 * is asserted here, on the real .plcproj, not on a mock.
 *
 * The catalog must also never *drop* a library: a namespace that libraries.js knows about but the
 * catalog does not would be a library the user silently cannot look up. §4 checks that both agree.
 *
 * The view itself (icons, tooltips, context menus, Insert at Cursor) needs VS Code and is not
 * testable here; this harness covers the data behind it. Skips cleanly when sample/ is absent.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    indexLibraryTitles,
    indexLibrarySignaturesFromXml,
    getLibraryCatalog,
    getTypeSystemNamespaceTypes,
    clearLibrarySymbols
} = require('../src/lsp/libsymbols');
const {
    indexLibraryNamespaces,
    getLibraryNamespaces,
    clearLibraryNamespaces
} = require('../src/lsp/libraries');
const { SAMPLE_DIR, indexSampleLibraries, printBaselineMode } = require('./_baseline');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** The catalog entry for a namespace, case-insensitively. */
const byNamespace = (catalog, ns) =>
    catalog.find(e => e.namespace.toLowerCase() === String(ns).toLowerCase());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_libcatalog_'));

try {
    // ---- 1. Synthetic .plcproj: the three name forms are kept apart ------------------------------
    console.log('=== 1. reference forms ===');

    fs.writeFileSync(path.join(dir, 'Synth.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <PlaceholderReference Include="RecipeManagement">
      <DefaultResolution>Recipe Management, * (System)</DefaultResolution>
      <Namespace>Recipe_Management</Namespace>
    </PlaceholderReference>
    <LibraryReference Include="Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH">
      <Namespace>Tc2_EtherCAT</Namespace>
    </LibraryReference>
    <!-- A <Namespace> outside a reference block is not a library and must not appear. -->
    <Compile Include="POUs\\MAIN.TcPOU">
      <Namespace>NotALibrary</Namespace>
    </Compile>
  </ItemGroup>
</Project>`, 'utf8');

    clearLibrarySymbols();
    assert(getLibraryCatalog().length === 0, 'clearLibrarySymbols empties the catalog');

    indexLibraryTitles(dir);
    let synth = getLibraryCatalog();
    assert(synth.length === 2, `two reference blocks -> two catalog entries (got ${synth.length})`);
    assert(!byNamespace(synth, 'NotALibrary'), 'a <Namespace> outside a reference block is not catalogued');

    const recipe = byNamespace(synth, 'Recipe_Management');
    assert(!!recipe && recipe.kind === 'placeholder' && recipe.include === 'RecipeManagement' &&
        recipe.title === 'Recipe Management' && recipe.version === '*' && recipe.company === 'System',
        `a placeholder splits into include/title/version/company ` +
        `(${recipe.include} / ${recipe.title} / ${recipe.version} / ${recipe.company})`);

    const ethercat = byNamespace(synth, 'Tc2_EtherCAT');
    assert(!!ethercat && ethercat.kind === 'reference' && ethercat.title === 'Tc2_EtherCAT' &&
        ethercat.version === '3.5.1.0' && ethercat.company === 'Beckhoff Automation GmbH',
        `a pinned LibraryReference splits its Include triple ` +
        `(${ethercat.title} / ${ethercat.version} / ${ethercat.company})`);

    // Re-indexing must not duplicate: indexLibraryTitles() runs once per index pass, and both
    // indexLibrarySymbols() and indexTypeSystem() call it.
    indexLibraryTitles(dir);
    indexLibraryTitles(dir);
    synth = getLibraryCatalog();
    assert(synth.length === 2, `re-indexing is idempotent — still 2 entries (got ${synth.length})`);

    // ---- 1b. Compiler-internal (__*) names are hidden from the tree -------------------------------
    // TwinCAT auto-generates backing GVLs like `__TL_Foo__GVL`; nobody references them by hand, so the
    // catalog (which feeds the view) must drop them while keeping the real ones.
    indexLibrarySignaturesFromXml(`<LibrarySignatures><Library>
      <LibraryName>Recipe Management</LibraryName><Version>1</Version><Distributor>System</Distributor>
      <TypeSignature type="VarGlobal"><Name>GVL_Real</Name>
        <Constants><Constant><Name>gX</Name><DataType>INT</DataType></Constant></Constants></TypeSignature>
      <TypeSignature type="VarGlobal"><Name>__TL_Foo__GVL</Name>
        <Constants><Constant><Name>gY</Name><DataType>INT</DataType></Constant></Constants></TypeSignature>
    </Library></LibrarySignatures>`);
    const recipeTypes = byNamespace(getLibraryCatalog(), 'Recipe_Management').types.map(t => t.name);
    assert(recipeTypes.includes('GVL_Real'), 'a normal GVL is catalogued');
    assert(!recipeTypes.some(n => /^__/.test(n)), `a compiler-internal __*__GVL is hidden (got ${JSON.stringify(recipeTypes)})`);

    // ---- 2. The real sample project --------------------------------------------------------------
    // Gated on the sample actually declaring library references, not on sample/ merely existing: the
    // synthetic sample declares none until the library fixtures land, and a catalogue of zero has
    // nothing to assert about.
    const sampleHasLibraries = fs.existsSync(SAMPLE_DIR) && indexLibraryNamespaces(SAMPLE_DIR).length > 0;
    if (!sampleHasLibraries) {
        console.log('\n[skip] the sample declares no library references — skipping the real-.plcproj assertions.');
    } else {
        const modeInfo = indexSampleLibraries(SAMPLE_DIR);
        printBaselineMode(modeInfo);

        const catalog = getLibraryCatalog();
        console.log('=== 2. the sample .plcproj\'s 3 references ===');
        assert(catalog.length === 3,
            `one entry per reference block: 3 placeholders, 0 pinned = 3 (got ${catalog.length})`);

        // Sorted by namespace, case-insensitively — the view shows them in this order.
        const namespaces = catalog.map(e => e.namespace);
        const sorted = namespaces.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        assert(JSON.stringify(namespaces) === JSON.stringify(sorted),
            'the catalog is sorted by namespace, case-insensitively');

        // ---- 3. Each reference splits into its three name forms ---------------------------------
        // COVERAGE NOTE. The three-names-differ case this view exists for — "Balluff BVS Sensor" /
        // "Balluff Sesnor Library TC3" / Balluff_BVS_Sensor, and "RecipeManagement" / "Recipe
        // Management" / Recipe_Management — came from the customer project and has no counterpart in
        // the synthetic sample, whose three Beckhoff libraries spell all three names identically.
        // §1 above still asserts the splitting on a synthetic .plcproj that DOES carry the mismatch,
        // so the parsing is guarded; what is lost here is only the on-real-data confirmation. Restore
        // these assertions when a library reference with differing names lands in the sample.
        console.log('\n=== 3. reference -> include / title / version / company ===');

        for (const ns of ['Tc2_Standard', 'Tc2_System', 'Tc3_Module']) {
            const e = byNamespace(catalog, ns);
            assert(!!e && e.kind === 'placeholder' && e.include === ns && e.title === ns &&
                e.company === 'Beckhoff Automation GmbH',
                `${ns}: placeholder, include/title both "${ns}", company Beckhoff Automation GmbH ` +
                `(${e ? e.kind + ' / ' + e.include + ' / ' + e.title + ' / ' + e.company : 'MISSING'})`);
        }

        // ---- 3b. Versions are kept verbatim -----------------------------------------------------
        // All three sample references resolve with "*" (<DefaultResolution>Tc2_System, * (…)</…>), so
        // that is the only form measurable here; the "newest" and pinned-triple forms are exercised
        // in §1 on the synthetic .plcproj.
        const star = byNamespace(catalog, 'Tc2_System');
        assert(!!star && star.version === '*',
            `"*" is preserved verbatim, not normalized (${star ? star.version : 'MISSING'})`);

        // ---- 4. No library is silently dropped --------------------------------------------------
        console.log('\n=== 4. every declared namespace is catalogued ===');

        clearLibraryNamespaces();
        indexLibraryNamespaces(SAMPLE_DIR);
        const declared = getLibraryNamespaces();   // lower-cased, from libraries.js
        const catalogued = new Set(catalog.map(e => e.namespace.toLowerCase()));
        const missing = declared.filter(ns => !catalogued.has(ns));
        assert(missing.length === 0,
            `all ${declared.length} namespaces libraries.js knows are in the catalog ` +
            `(missing: ${missing.join(', ') || 'none'})`);

        // ---- 5. Symbol counts, from the archives ------------------------------------------------
        // symbolCount comes from the .compiled-library string tables and is independent of the .tmc,
        // so it is measurable on every checkout that has the (git-ignored) _Libraries fixtures.
        console.log('\n=== 5. symbols beneath a library ===');

        catalog.forEach(e => console.log(`    ${e.namespace.padEnd(14)} ${e.symbolCount} archive symbol(s)`));
        // Measured 2026-07-20: Tc2_Standard 313, Tc2_System 1293, Tc3_Module 461. Exact per-library
        // counts are a property of the vendor archives (they change with the library version), so what
        // is asserted is that every declared library resolved to an archive and none came back empty —
        // which is what a broken title->archive mapping would show up as.
        const uncounted = catalog.filter(e => e.symbolCount === 0).map(e => e.namespace);
        assert(uncounted.length === 0,
            `every catalogued library resolved to an archive with symbols (empty: ${uncounted.join(', ') || 'none'})`);

        // ---- 6. Types beneath a library (needs the .tmc) ----------------------------------------
        console.log('\n=== 6. types beneath a library ===');

        if (modeInfo.tmcFiles === 0) {
            // Expected on this tree: the sample's .tmc is a TwinCAT *build* artifact and the committed
            // fixtures are source-only, so no checkout has one until the project is built in XAE.
            console.log('  skip  no .tmc present — no structured types to attach (see the mode above).');
            console.log('        COVERAGE NOTE: the member-level assertions (an FB type whose members');
            console.log('        include a named VAR_INPUT) were written against the customer project\'s');
            console.log('        Tc2_MC2/MC_Power and cannot be re-based without a .tmc. They return when');
            console.log('        the sample ships one.');
        } else {
            // The invariant that survives any project: the catalog reports exactly what the type
            // system holds for that namespace — no more, no less.
            catalog.forEach(e => {
                const fromTypeSystem = getTypeSystemNamespaceTypes(e.namespace);
                assert(e.types.length === fromTypeSystem.length,
                    `${e.namespace}: catalog reports exactly the type system's types ` +
                    `(${e.types.length} vs ${fromTypeSystem.length})`);
            });
            const withTypes = catalog.filter(e => e.types.length > 0);
            console.log(`    ${withTypes.length} of ${catalog.length} libraries have .tmc types`);
            assert(withTypes.length > 0,
                'at least one library carries .tmc types — otherwise this section is vacuous');
        }
    }
} catch (e) {
    console.error(`[FATAL] ${e.stack}`);
    errors++;
} finally {
    clearLibrarySymbols();
    clearLibraryNamespaces();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir: ignore */ }
}

console.log(`\n--- LIBRARY CATALOG TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
