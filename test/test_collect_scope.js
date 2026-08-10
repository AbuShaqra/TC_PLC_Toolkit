/**
 * @file test_collect_scope.js
 * @description The two skip sets of libsymbols.js are deliberately different, and both halves of that
 * asymmetry are load-bearing.
 *
 * `collectTmcFiles` and `collectSignatureFiles` look for the *project's own* artifacts, which are never
 * vendored inside `_Libraries` — descending into it only costs a walk over 156 MB of archives (measured
 * 150 ms vs 69 ms on the real 8-project workspace, zero `.tmc` found under any `_Libraries`). So they
 * use `PROJECT_SKIP_DIRS`.
 *
 * `collectArchives` uses plain `SKIP_DIRS` and MUST keep descending into `_Libraries` — that is where
 * every vendor archive lives. The tempting "just add `_libraries` to SKIP_DIRS" is the trap: it yields
 * zero library symbols and takes the sample diagnostics ratchet from 0 to ~171 false positives. The
 * last section proves that by doing it, so the guard can never be quietly removed as dead weight.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    collectArchives,
    collectTmcFiles,
    collectSignatureFiles,
    SKIP_DIRS,
    PROJECT_SKIP_DIRS
} = require('../src/lsp/libsymbols');
const { PLCPROJ_SKIP_DIRS } = require('../src/lsp/plcprojRefs');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// A workspace shaped like the real thing: the project's own artifacts at the top, and an `_Libraries`
// tree that holds an archive AND (as a decoy) a `.tmc` and a signatures dump of its own. Vendors do
// not actually ship those two, which is exactly why finding them means the walker went somewhere it
// had no reason to go.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_collect_scope_'));
const libDir = path.join(root, 'Machine', '_Libraries', 'acme gmbh', 'acmelib', '1.0.0.0');
fs.mkdirSync(libDir, { recursive: true });

const projectTmc = path.join(root, 'Machine', 'Machine.tmc');
const projectSig = path.join(root, 'library-signatures.xml');
const vendorTmc = path.join(libDir, 'AcmeLib.tmc');
const vendorSig = path.join(libDir, 'library-signatures.xml');
const vendorArchive = path.join(libDir, 'AcmeLib.compiled-library');

fs.writeFileSync(projectTmc, '<TcModuleClass/>');
fs.writeFileSync(projectSig, '<LibrarySignatures/>');
fs.writeFileSync(vendorTmc, '<TcModuleClass/>');
fs.writeFileSync(vendorSig, '<LibrarySignatures/>');
// Contents are irrelevant here: collectArchives matches on the extension, it does not decode.
fs.writeFileSync(vendorArchive, 'PKnot-a-real-zip');

/** @param {(dir: string, out: string[]) => void} collect @returns {string[]} Collected paths. */
function run(collect) {
    const out = [];
    collect(root, out);
    return out;
}

// ── 1. The project's own artifacts are found; the ones under _Libraries are not ──────────────────
{
    const tmc = run(collectTmcFiles);
    assert(tmc.includes(projectTmc), 'collectTmcFiles finds the project .tmc');
    assert(!tmc.includes(vendorTmc), 'collectTmcFiles does NOT descend into _Libraries');

    const sig = run(collectSignatureFiles);
    assert(sig.includes(projectSig), 'collectSignatureFiles finds the workspace-root signatures dump');
    assert(!sig.includes(vendorSig), 'collectSignatureFiles does NOT descend into _Libraries');
}

// ── 2. The archive walker still descends into _Libraries ─────────────────────────────────────────
{
    assert(run(collectArchives).includes(vendorArchive),
        'collectArchives DOES descend into _Libraries (where every archive lives)');
}

// ── 3. The skip sets differ in exactly one entry, and that entry is `_libraries` ─────────────────
{
    assert(!SKIP_DIRS.has('_libraries'), 'SKIP_DIRS (the archive walker\'s) does not exclude _libraries');
    assert(PROJECT_SKIP_DIRS.has('_libraries'), 'PROJECT_SKIP_DIRS does exclude _libraries');
    const extra = Array.from(PROJECT_SKIP_DIRS).filter(d => !SKIP_DIRS.has(d));
    assert(extra.length === 1 && extra[0] === '_libraries',
        'PROJECT_SKIP_DIRS is SKIP_DIRS plus _libraries and nothing else');

    // plcprojRefs.js states the same set for the `.plcproj` walk it owns, and the two must not drift:
    // a project artifact skipped by one walker and not the other is a difference nobody would notice
    // until a `.tmc` or a dump went missing from exactly one index.
    assert(PLCPROJ_SKIP_DIRS.size === PROJECT_SKIP_DIRS.size &&
           Array.from(PLCPROJ_SKIP_DIRS).every(d => PROJECT_SKIP_DIRS.has(d)),
        'plcprojRefs.js PLCPROJ_SKIP_DIRS and libsymbols.js PROJECT_SKIP_DIRS are the same set');
}

// ── 4. The guard is load-bearing: break it and the archive walker goes blind ─────────────────────
// This is the whole reason `collectArchives` may not share PROJECT_SKIP_DIRS. Mutating the exported
// Set is safe here and nowhere else: every harness runs in its own process (test/run.js), and the
// entry is removed again immediately.
{
    SKIP_DIRS.add('_libraries');
    try {
        assert(!run(collectArchives).includes(vendorArchive),
            'with _libraries in SKIP_DIRS, collectArchives finds NO archive — the ~171-false-positive trap');
    } finally {
        SKIP_DIRS.delete('_libraries');
    }
    assert(run(collectArchives).includes(vendorArchive),
        'and it finds the archive again once the entry is removed');
}

fs.rmSync(root, { recursive: true, force: true });

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll collect-scope assertions passed.');
