/**
 * @file test_library_catalog.js
 * @description The library catalog (src/lsp/libsymbols.js `getLibraryCatalog()`) that backs the
 * "TwinCAT Libraries" view.
 *
 * What the view exists for, and therefore what this guards: a library has **three** names in the
 * .plcproj, and they are routinely different strings —
 *
 *     <PlaceholderReference Include="Acme Vision Sensor">                <- the placeholder name
 *       <DefaultResolution>Acme Sensor Library TC3, * (Acme GmbH)</...>  <- the library title
 *       <Namespace>Acme_Vision_Sensor</Namespace>                        <- what the CODE must say
 *
 * Only the last one compiles. A programmer looking for the Acme FB has no way to guess it from
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
const {
    SAMPLE_DIR,
    MIT_NAMESPACE,
    MIT_SYMBOL_COUNT,
    indexSampleLibraries,
    printBaselineMode,
    sampleArchiveFixtures,
    skipBeckhoff
} = require('./_baseline');

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
        const fixtures = sampleArchiveFixtures(SAMPLE_DIR);

        const catalog = getLibraryCatalog();
        console.log('=== 2. the sample .plcproj\'s 4 references ===');
        // The catalog is built from the .plcproj, which is COMMITTED — so its SHAPE (how many entries,
        // and each entry's include/title/version/company/namespace) is identical on a developer machine
        // and on CI. Only the archive-derived fields (symbolCount, §5) depend on which binaries are
        // present. Assertions are split along exactly that line.
        assert(catalog.length === 4,
            `one entry per reference block: 4 placeholders, 0 pinned = 4 (got ${catalog.length})`);

        // Sorted by namespace, case-insensitively — the view shows them in this order.
        const namespaces = catalog.map(e => e.namespace);
        const sorted = namespaces.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        assert(JSON.stringify(namespaces) === JSON.stringify(sorted),
            'the catalog is sorted by namespace, case-insensitively');

        // ---- 3. Each reference splits into its three name forms ---------------------------------
        // The three-names-differ case this view exists for is back on real data, and committed: the
        // sample's TwinCAT Dynamic Collections reference spells the Include ("TwinCat Dynamic
        // Collections") and the Namespace (TcDynCollections) differently, which is precisely the
        // lookup a programmer cannot perform by eye. Its archive is MIT-licensed and therefore
        // committed, but nothing in this section reads it — the names come from the .plcproj, so
        // these assertions hold on CI too. (The three Beckhoff references spell all three forms
        // identically, so they cover the degenerate case only.)
        console.log('\n=== 3. reference -> include / title / version / company ===');

        const dyn = byNamespace(catalog, MIT_NAMESPACE);
        assert(!!dyn && dyn.kind === 'placeholder' && dyn.include === 'TwinCat Dynamic Collections' &&
            dyn.title === 'TwinCat Dynamic Collections' && dyn.company === 'FisoThemes',
            `${MIT_NAMESPACE}: the namespace differs from the Include/title, and all three are kept apart ` +
            `(${dyn ? dyn.include + ' / ' + dyn.title + ' / ' + dyn.company : 'MISSING'})`);

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
        // symbolCount comes from a `.compiled-library` string table, so this is the section that
        // genuinely needs an archive on disk. One of the four IS committed — TwinCAT Dynamic
        // Collections is MIT-licensed — so the title->archive->symbols mapping is testable everywhere;
        // the three Beckhoff archives are vendor binaries and git-ignored, and on CI their entries
        // legitimately report 0. Assert the committed one, gate the rest.
        console.log('\n=== 5. symbols beneath a library ===');

        catalog.forEach(e => console.log(`    ${e.namespace.padEnd(18)} ${e.symbolCount} archive symbol(s)`));

        if (!fixtures.hasMit) {
            // Not a normal state: the archive is committed, so its absence means the working copy was
            // pruned by hand. Say so rather than passing quietly.
            console.log('    [skip] the committed MIT archive is missing from this working copy — ' +
                'restore sample/**/_Libraries/fisothemes/.');
        } else {
            // Measured 2026-07-20 with harvestArchive() over the committed tcdyncollections.library
            // (v1.0.7). The archive is committed at a fixed version, so this is an exact ratchet on the
            // ZIP reader + string-table decoder rather than a machine-dependent number: if a future
            // change silently drops a string-table region, this moves.
            const mit = byNamespace(catalog, MIT_NAMESPACE);
            assert(!!mit && mit.symbolCount === MIT_SYMBOL_COUNT,
                `${MIT_NAMESPACE} resolves through its differing title to the committed archive: ` +
                `${MIT_SYMBOL_COUNT} symbols (got ${mit ? mit.symbolCount : 'MISSING'})`);
        }

        // BONUS COVERAGE (developer machine only). "No catalogued library came back empty" is what a
        // broken title->archive mapping shows up as, but it can only be asserted when every declared
        // library HAS an archive — on CI three of the four deliberately do not. Exact per-library
        // counts stay unasserted even here: they are a property of the vendor archive version.
        // Measured 2026-07-20: Tc2_Standard 313, Tc2_System 1293, Tc3_Module 461, TcDynCollections 479.
        if (!fixtures.hasBeckhoff) {
            skipBeckhoff('every-library-resolved check');
        } else {
            const uncounted = catalog.filter(e => e.symbolCount === 0).map(e => e.namespace);
            assert(uncounted.length === 0,
                `every catalogued library resolved to an archive with symbols (empty: ${uncounted.join(', ') || 'none'})`);
            // NOT `archives === 4`. The number of archives on disk is a property of what TwinCAT
            // copied in, not of what the project references: since the sample was built in XAE its
            // `_Libraries` also holds Tc2_Utilities, which no <PlaceholderReference> declares.
            // Measured 2026-07-20: 5 archives on disk, 4 of them declared. What the catalog owes is
            // one entry per *declared* reference — asserted above — so the invariant here is that
            // every declared library found its archive, and an undeclared one adds no entry.
            assert(modeInfo.archives >= 4 && catalog.length === 4,
                `${modeInfo.archives} archive(s) on disk resolve the 4 declared references, and an ` +
                `undeclared archive adds no catalog entry (${catalog.length} entries)`);
        }

        // ---- 6. Types beneath a library (needs the .tmc) ----------------------------------------
        console.log('\n=== 6. types beneath a library ===');

        if (modeInfo.tmcFiles === 0) {
            // Not a normal state: the sample's `.tmc` is committed. Its absence means the working
            // copy was pruned by hand, so say which fixture is missing rather than pass quietly.
            console.log('  skip  no .tmc present — the committed sample .tmc is missing from this working');
            console.log('        copy, so there are no structured types to attach (see the mode above).');
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

            // What a type entry actually carries, on the one library this `.tmc` attributes. The
            // committed MIT archive is the fixture, so this runs in both configurations. Measured
            // 2026-07-20: TcDynCollections -> ST_ERROR (struct, 3 fields) + three opaque blocks
            // (T_Error, GVL_Constants, GVL_Errors) — a `.tmc` describes only what the project uses.
            const mitTypes = byNamespace(catalog, MIT_NAMESPACE).types;
            const errType = mitTypes.find(t => t.name === 'ST_ERROR');
            assert(!!errType && errType.kind === 'struct' &&
                errType.members.map(m => m.name).join(',') === 'nCODE,bSTATUS,sSOURCE',
                `${MIT_NAMESPACE}'s ST_ERROR is a struct carrying its real fields ` +
                `(${errType ? errType.kind + ': ' + errType.members.map(m => m.name).join(',') : 'MISSING'})`);
            assert(mitTypes.every(t => t.kind !== 'opaque' || t.members.length === 0),
                'an opaque block contributes a name and no members — nothing is invented for it');

            // The negative that keeps the view honest: the sample's `.tmc` describes the project's
            // OWN types too (FB_Cylinder, ST_StationStatus, …), and those carry no `Namespace="…"`
            // attribute. A library row must never claim them — "TwinCAT Libraries" would then list
            // the user's own code as somebody's library.
            const ownTypes = ['FB_Cylinder', 'ST_StationStatus', 'E_StationState', 'GVL_Io'];
            const misfiled = catalog.filter(e => e.types.some(t => ownTypes.includes(t.name)))
                .map(e => e.namespace);
            assert(misfiled.length === 0,
                `the project's own .tmc types are filed under no library (claimed by: ${misfiled.join(', ') || 'none'})`);
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
