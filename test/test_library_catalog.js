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
        console.log('=== 2. the sample .plcproj\'s 28 references ===');
        assert(catalog.length === 28,
            `one entry per reference block: 26 placeholders + 2 pinned = 28 (got ${catalog.length})`);

        // Sorted by namespace, case-insensitively — the view shows them in this order.
        const namespaces = catalog.map(e => e.namespace);
        const sorted = namespaces.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        assert(JSON.stringify(namespaces) === JSON.stringify(sorted),
            'the catalog is sorted by namespace, case-insensitively');

        // ---- 3. The whole point: library name != namespace --------------------------------------
        console.log('\n=== 3. library name -> namespace (the mismatches) ===');

        const balluff = byNamespace(catalog, 'Balluff_BVS_Sensor');
        assert(!!balluff && balluff.include === 'Balluff BVS Sensor' &&
            balluff.title === 'Balluff Sesnor Library TC3' && balluff.company === 'Balluff GmbH',
            `"Balluff BVS Sensor" / "Balluff Sesnor Library TC3" -> Balluff_BVS_Sensor ` +
            `(${balluff ? balluff.include + ' / ' + balluff.title : 'MISSING'})`);

        const recipeSample = byNamespace(catalog, 'Recipe_Management');
        assert(!!recipeSample && recipeSample.include === 'RecipeManagement' &&
            recipeSample.title === 'Recipe Management',
            `"RecipeManagement" / "Recipe Management" -> Recipe_Management ` +
            `(${recipeSample ? recipeSample.include + ' / ' + recipeSample.title : 'MISSING'})`);

        const visu = byNamespace(catalog, 'VisuElems');
        assert(!!visu && visu.include === 'System_VisuElems' && visu.title === 'VisuElems',
            `"System_VisuElems" -> VisuElems (${visu ? visu.include : 'MISSING'})`);

        // ---- 3b. Versions are kept verbatim -----------------------------------------------------
        const pinned = byNamespace(catalog, 'Tc2_EtherCAT');
        assert(!!pinned && pinned.title === 'Tc2_EtherCAT' && pinned.version === '3.5.1.0' &&
            pinned.company === 'Beckhoff Automation GmbH',
            `a pinned reference keeps its exact version ` +
            `(${pinned ? pinned.title + ' ' + pinned.version + ' / ' + pinned.company : 'MISSING'})`);

        const newest = byNamespace(catalog, 'Tc2_ControllerToolbox');
        assert(!!newest && newest.version === 'newest',
            `"newest" is preserved verbatim, not normalized (${newest ? newest.version : 'MISSING'})`);

        const star = byNamespace(catalog, 'Tc2_MC2');
        assert(!!star && star.version === '*',
            `"*" is preserved verbatim too (${star ? star.version : 'MISSING'})`);

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

        // ---- 5. Types and members ---------------------------------------------------------------
        console.log('\n=== 5. types beneath a library ===');

        if (modeInfo.tmcFiles === 0) {
            console.log('  skip  no .tmc present — no structured types to attach (see the mode above).');
        } else {
            const mc2 = byNamespace(catalog, 'Tc2_MC2');
            assert(mc2.types.length === 57,
                `Tc2_MC2 carries its 57 .tmc types (got ${mc2.types.length})`);
            assert(mc2.types.length === getTypeSystemNamespaceTypes('Tc2_MC2').length,
                'the catalog reports exactly the type system\'s types — no more, no less');

            const power = mc2.types.find(t => t.name === 'MC_Power');
            assert(!!power && power.kind === 'fb' &&
                power.members.some(m => m.name === 'Enable' && m.scope === 'VAR_INPUT'),
                `MC_Power is an FB whose members include Enable ` +
                `(${power ? power.kind + ', ' + power.members.length + ' members' : 'MISSING'})`);

            // The honest empty case the view has to explain rather than hide: the .tmc only exports
            // the types the project already uses, so most libraries carry none.
            const empty = catalog.filter(e => e.types.length === 0);
            const withTypes = catalog.length - empty.length;
            console.log(`    ${withTypes} of ${catalog.length} libraries have .tmc types; ` +
                `${empty.length} have none (VisuElems ships only as unreadable -v3, etc.)`);
            assert(empty.length > 0 && withTypes > 0,
                'both cases really occur — the "No indexed types" row is not dead code');

            // symbolCount comes from the archives and is independent of the .tmc.
            const counted = catalog.filter(e => e.symbolCount > 0);
            console.log(`    ${counted.length} libraries have archive symbols ` +
                `(largest: ${catalog.slice().sort((a, b) => b.symbolCount - a.symbolCount)[0].namespace} ` +
                `= ${Math.max(...catalog.map(e => e.symbolCount))})`);
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
