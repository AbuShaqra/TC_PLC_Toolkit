/**
 * @file test_plcproj_cache.js
 * @description One `.plcproj`, one read — however many indexers ask for it.
 *
 * A single project scan used to open the same `.plcproj` three times: libraries.js
 * `indexLibraryNamespaces` for the namespace set, and libsymbols.js `indexLibraryTitles` twice, once
 * from `indexLibrarySymbols` and once from `indexTypeSystem`. Three reads, three regex passes and
 * three directory walks over identical bytes, per project per scan.
 *
 * Sharing a parse between consumers is only safe if it changes nothing, so the count assertion is
 * paired with an **equivalence gate**: the same three indexers are driven a second time with the
 * cache dropped between every call, and the two projects' resulting registries must be identical.
 * A cache that is fast and subtly different is worse than no cache — the reference records carry the
 * title → namespace mapping the whole Libraries view and every archive attribution hang off.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    readLibraryReferences,
    clearPlcProjRefsCache,
    __stats
} = require('../src/lsp/plcprojRefs');
const { clearParseCaches } = require('../src/lsp/parseCache');
const { indexLibraryNamespaces, getLibraryNamespaces } = require('../src/lsp/libraries');
const {
    indexLibrarySymbols,
    indexTypeSystem,
    getLibraryCatalog,
    getLibraryNamespaceNames
} = require('../src/lsp/libsymbols');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ── Fixture: one project, both reference kinds, all three title spellings in play ────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_plcprojcache_'));
const projDir = path.join(root, 'Machine');
fs.mkdirSync(projDir, { recursive: true });
const plcproj = path.join(projDir, 'Machine.plcproj');

fs.writeFileSync(plcproj, `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <PlaceholderReference Include="System_VisuElems">
      <DefaultResolution>VisuElems, 4.8.0.0 (System)</DefaultResolution>
      <Namespace>VisuElems</Namespace>
    </PlaceholderReference>
    <LibraryReference Include="Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH">
      <Namespace>Tc2_EtherCAT</Namespace>
    </LibraryReference>
  </ItemGroup>
</Project>`);

/**
 * Drives the three indexers that each wanted their own read of the `.plcproj`.
 * @param {Object} index A fresh symbol index.
 * @param {boolean} dropCacheBetween Clear the caches between every call (the equivalence run).
 * @returns {number} Reads performed across all three calls. Accumulated rather than read at the end
 *   because clearing the cache also zeroes its counters.
 */
function indexAll(index, dropCacheBetween) {
    let reads = 0;
    const drop = () => {
        if (!dropCacheBetween) return;
        reads += __stats.reads;
        clearPlcProjRefsCache();
        clearParseCaches();
    };
    indexLibraryNamespaces(projDir, index);
    drop();
    indexLibrarySymbols(projDir, index);   // calls indexLibraryTitles
    drop();
    indexTypeSystem(projDir, index);       // calls indexLibraryTitles again
    return reads + __stats.reads;
}

/** Everything the three indexers put in the registry, as comparable JSON. @param {Object} index */
function snapshot(index) {
    return JSON.stringify({
        namespaces: getLibraryNamespaces(index).slice().sort(),
        namespaceNames: getLibraryNamespaceNames(index).slice().sort(),
        catalog: getLibraryCatalog(index)
    });
}

// ── 1. Three indexers, one read ──────────────────────────────────────────────────────────────────
const cached = /** @type {Object} */ ({});
{
    clearPlcProjRefsCache();
    clearParseCaches();
    const reads = indexAll(cached, false);
    assert(reads === 1, `the .plcproj is read and parsed exactly once (reads=${reads})`);
    assert(__stats.hits === 2, `the other two indexers hit the cache (hits=${__stats.hits})`);
}

// ── 2. Equivalence gate: caching must change nothing at all ──────────────────────────────────────
{
    const uncached = /** @type {Object} */ ({});
    clearPlcProjRefsCache();
    clearParseCaches();
    const reads = indexAll(uncached, true);
    assert(reads === 3, `the control run really does re-read each time (reads=${reads})`);
    assert(snapshot(cached) === snapshot(uncached),
        'the cached run and the re-read run produce byte-identical registries');
    // Named explicitly, because these are what a wrong shared parse would quietly break.
    assert(getLibraryCatalog(cached).length === 2, 'both reference kinds reached the catalog');
    assert(getLibraryNamespaces(cached).sort().join(',') === 'tc2_ethercat,visuelems',
        'both namespaces reached the namespace registry');
}

// ── 3. An edited .plcproj is re-read ─────────────────────────────────────────────────────────────
{
    clearPlcProjRefsCache();
    const first = readLibraryReferences(plcproj);
    assert(readLibraryReferences(plcproj) === first, 'a second read returns the identical records');
    assert(__stats.reads === 1 && __stats.hits === 1, 'and it was a cache hit, not a re-read');

    const future = new Date(Date.now() + 5000);
    fs.utimesSync(plcproj, future, future);
    const second = readLibraryReferences(plcproj);
    assert(__stats.reads === 2, `a changed mtime invalidates the cached parse (reads=${__stats.reads})`);
    assert(second !== first && JSON.stringify(second) === JSON.stringify(first),
        'the re-read yields fresh records with the same content');
}

// ── 4. An unreadable .plcproj yields null, never a throw ─────────────────────────────────────────
{
    assert(readLibraryReferences(path.join(projDir, 'no-such.plcproj')) === null,
        'a missing .plcproj reads as null');
}

fs.rmSync(root, { recursive: true, force: true });

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll .plcproj-cache assertions passed.');
