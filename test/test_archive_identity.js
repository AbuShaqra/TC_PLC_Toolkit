/**
 * @file test_archive_identity.js
 * @description A library archive is decoded once per distinct CONTENT, not once per path.
 *
 * Every PLC project vendors its own `_Libraries`, so a multi-project workspace holds the same vendor
 * archives many times over. Measured on a real 8-project workspace: 306 archive files / 156.5 MB on
 * disk, but only 148 distinct / 74.2 MB — **53% of the archive bytes are byte-identical copies at
 * different paths**, and the old path-keyed cache re-inflated every one of them. Of the 90 duplicate
 * groups, 81 share an identical millisecond mtime; the 9 that do not are SHA1-verified identical and
 * simply fail to share, which is today's outcome rather than a worse one.
 *
 * The key is `<title>/<version>/<filename>|size|mtimeMs` — the last three segments of the real
 * `_Libraries/<company>/<title>/<version>/<file>` layout. This asserts both directions: identical
 * tails share a decode, and a different tail does not, so the sharing can never be quietly widened
 * into "same size, same mtime, therefore same library".
 *
 * The end-to-end section drives `scanWorkspace` with the REAL `indexLibraries` composition (the
 * `realIndexLibraries` pattern from test_multi_project_scope.js): the stub every convenient harness
 * reaches for is exactly why nine prior task reviews missed a bug in this callback.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    harvestArchive,
    harvestArchiveFile,
    getNestedNamespaceSymbols,
    isLibrarySymbol,
    indexLibrarySymbols,
    indexTypeSystem,
    indexLibrarySignatures,
    indexBrowserCache,
    __archiveStats
} = require('../src/lsp/libsymbols');
const { indexLibraryNamespaces } = require('../src/lsp/libraries');
const { scanWorkspace } = require('../src/lsp/workspaceScan');
const { normalizeProjectPath } = require('../src/lsp/projectMap');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** The one library archive committed with the sample (the Beckhoff ones are git-ignored vendor bytes). */
const ARCHIVE = path.join(
    __dirname, '..', 'sample', 'TcToolkitSample', 'TcToolkitSample_PLC', '_Libraries',
    'fisothemes', 'twincat dynamic collections', '1.0.7', 'tcdyncollections.library'
);

if (!fs.existsSync(ARCHIVE)) {
    console.log(`[SKIP] the committed sample archive is missing (${ARCHIVE}) — nothing to identify`);
    process.exit(0);
}

const EXPECTED = harvestArchive(fs.readFileSync(ARCHIVE));   // direct read: does not touch the cache
const PROBE = EXPECTED.find(n => /^FB_/i.test(n)) || EXPECTED[0];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_archive_identity_'));

/** Snapshot of the counters, for asserting on deltas rather than absolutes. */
function counters() {
    return { ...__archiveStats };
}

/**
 * Plants a copy of the archive at a real `_Libraries` layout, with an exact mtime.
 * @param {string} project Project directory name under the temp root.
 * @param {string} company Distributor directory.
 * @param {string} title Library title directory.
 * @param {string} version Version directory.
 * @param {string} file Archive file name.
 * @param {number} mtimeSec Modification time, in whole seconds (equal across copies unless stated).
 * @returns {string} Absolute path to the planted copy.
 */
function plant(project, company, title, version, file, mtimeSec) {
    const dir = path.join(root, project, '_Libraries', company, title, version);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, file);
    fs.copyFileSync(ARCHIVE, dest);
    fs.utimesSync(dest, mtimeSec, mtimeSec);
    return dest;
}

const MTIME = 1700000000;

// ── 1. Two projects' copies of the same library: one decode ──────────────────────────────────────
const copyA = plant('LineA', 'fisothemes', 'twincat dynamic collections', '1.0.7', 'tcdyncollections.library', MTIME);
const copyB = plant('LineB', 'fisothemes', 'twincat dynamic collections', '1.0.7', 'tcdyncollections.library', MTIME);
{
    const before = counters();
    const namesA = harvestArchiveFile(copyA);
    const namesB = harvestArchiveFile(copyB);

    assert(__archiveStats.inflated - before.inflated === 1,
        `the second copy is not re-inflated (inflated +${__archiveStats.inflated - before.inflated})`);
    assert(__archiveStats.contentHits - before.contentHits === 1,
        `it is served from the content cache (contentHits +${__archiveStats.contentHits - before.contentHits})`);
    assert(namesA === namesB, 'both paths get the identical name list');
    assert(JSON.stringify(namesA) === JSON.stringify(EXPECTED),
        `and it is the real harvest (${EXPECTED.length} names)`);

    // Asking for the same path twice is a path hit, not a content hit — the two levels stay distinct.
    const mid = counters();
    harvestArchiveFile(copyA);
    assert(__archiveStats.pathHits - mid.pathHits === 1 &&
           __archiveStats.inflated === mid.inflated && __archiveStats.contentHits === mid.contentHits,
        'a repeat of the same path is a path hit, with no decode and no content lookup');
}

// ── 2. A different <title>/<version> tail is a different library, whatever its size and mtime ────
{
    const before = counters();
    const other = plant('LineC', 'fisothemes', 'twincat other collections', '2.0.0', 'tcdyncollections.library', MTIME);
    harvestArchiveFile(other);
    assert(__archiveStats.inflated - before.inflated === 1,
        'a copy under a different title/version is decoded separately, not assumed identical');

    const renamed = plant('LineD', 'fisothemes', 'twincat dynamic collections', '1.0.7', 'somethingelse.library', MTIME);
    const beforeFile = counters();
    harvestArchiveFile(renamed);
    assert(__archiveStats.inflated - beforeFile.inflated === 1,
        'so is a copy whose file name differs — all three tail segments are part of the key');
}

// ── 3. An edited archive is re-decoded ───────────────────────────────────────────────────────────
{
    const before = counters();
    fs.utimesSync(copyA, MTIME + 60, MTIME + 60);
    const names = harvestArchiveFile(copyA);
    assert(__archiveStats.inflated - before.inflated === 1,
        'a changed mtime invalidates both cache levels');
    assert(JSON.stringify(names) === JSON.stringify(EXPECTED), 'and the re-decode is still correct');
}

// ── 4. An unreadable or undecodable archive yields null, never a throw ───────────────────────────
{
    const truncated = path.join(root, 'truncated.library');
    fs.writeFileSync(truncated, fs.readFileSync(ARCHIVE).subarray(0, 512));
    const garbage = path.join(root, 'garbage.library');
    fs.writeFileSync(garbage, 'not a zip at all');

    const before = counters();
    assert(harvestArchiveFile(truncated) === null, 'a truncated archive harvests as null');
    assert(harvestArchiveFile(garbage) === null, 'a non-ZIP file harvests as null');
    assert(harvestArchiveFile(path.join(root, 'no-such.library')) === null,
        'a missing archive harvests as null');
    assert(__archiveStats.inflated === before.inflated,
        'and none of them is recorded as a successful decode');
    // Failures are deliberately NOT cached: a transient read error must not stick for the session.
    assert(harvestArchiveFile(garbage) === null, 'a repeated failure is still null, not a cached hit');
}

// ── 5. The nested-namespace path goes through the same cache ─────────────────────────────────────
// It used to read and inflate the file directly, so VisuElemBase (6.3 MB) was re-harvested once per
// project. Two assertions are needed, and the first is the load-bearing one: a bypass would satisfy
// "adds no decode" vacuously, because a direct read increments no counter at all.
{
    const fresh = plant('LineE', 'fisothemes', 'nested probe lib', '1.0.7', 'NestedProbe.library', MTIME);
    const beforeFresh = counters();
    const first = getNestedNamespaceSymbols('NestedProbeOne', {}, { findArchive: () => fresh });
    assert(first.length > 0, 'the injected archive resolves to real symbols');
    assert(__archiveStats.statted - beforeFresh.statted === 1 &&
           __archiveStats.inflated - beforeFresh.inflated === 1,
        'the nested harvest goes THROUGH harvestArchiveFile (a direct read would count nothing)');
    assert(new Set(first).size === first.length, 'the nested list is still de-duplicated');

    // A second project's copy of the same library: same tail, same mtime, different path.
    const twin = plant('LineF', 'fisothemes', 'nested probe lib', '1.0.7', 'NestedProbe.library', MTIME);
    const beforeTwin = counters();
    const second = getNestedNamespaceSymbols('NestedProbeTwo', {}, { findArchive: () => twin });
    assert(__archiveStats.inflated === beforeTwin.inflated &&
           __archiveStats.contentHits - beforeTwin.contentHits === 1,
        'and a second project\'s copy of it adds no decode');
    assert(JSON.stringify(second) === JSON.stringify(first), 'both yield the same symbols');
}

// ── 6. End to end: two projects, one workspace, one decode ───────────────────────────────────────
// Real indexLibraries composition, mirroring src/lsp/server.js (which cannot be required standalone —
// it opens an IPC connection at require time).
{
    const e2e = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_archive_e2e_'));
    const E2E_MTIME = 1700000500;

    /** @type {Array<{dir: string, index: Object}>} */
    const seen = [];

    for (const name of ['LineA', 'LineB']) {
        const dir = path.join(e2e, name);
        const libDir = path.join(dir, '_Libraries', 'fisothemes', 'tcdyncollections', '1.0.7');
        fs.mkdirSync(libDir, { recursive: true });
        const dest = path.join(libDir, 'TcDynCollections.library');
        fs.copyFileSync(ARCHIVE, dest);
        fs.utimesSync(dest, E2E_MTIME, E2E_MTIME);
        fs.writeFileSync(path.join(dir, `${name}.plcproj`), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <PlaceholderReference Include="TcDynCollections">
      <DefaultResolution>TcDynCollections, 1.0.7 (fisothemes)</DefaultResolution>
      <Namespace>TcDynCollections</Namespace>
    </PlaceholderReference>
  </ItemGroup>
</Project>`);
    }

    /**
     * A real (non-stub) indexLibraries, mirroring src/lsp/server.js's own.
     * @param {string} dir Project directory.
     * @param {Object} index The project's symbol index.
     * @param {Array<string>} roots Workspace roots.
     */
    function realIndexLibraries(dir, index, roots) {
        indexLibraryNamespaces(dir, index);
        indexLibrarySymbols(dir, index);
        indexTypeSystem(dir, index);
        indexLibrarySignatures(dir, index);
        for (const otherRoot of roots || []) {
            if (normalizeProjectPath(otherRoot) === normalizeProjectPath(dir)) continue;
            indexLibrarySignatures(otherRoot, index);
        }
        indexBrowserCache(dir, index);
        seen.push({ dir, index });
    }

    const before = counters();
    scanWorkspace([e2e], { indexLibraries: realIndexLibraries });

    assert(seen.length === 2, `both projects were indexed (${seen.length})`);
    assert(__archiveStats.inflated - before.inflated === 1,
        `the workspace decoded the shared archive once (inflated +${__archiveStats.inflated - before.inflated})`);
    assert(seen.every(p => isLibrarySymbol(PROBE, p.index)),
        `and both projects resolve the same library symbol ("${PROBE}")`);

    fs.rmSync(e2e, { recursive: true, force: true });
}

fs.rmSync(root, { recursive: true, force: true });

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll archive-identity assertions passed.');
