/**
 * @file test_archive_store.js
 * @description R6 part 2: the persisted archive-name cache (src/lsp/archiveStore.js, wired into
 * libsymbols.js `harvestArchiveFile`). Each "session" is a fresh Node process, so the in-memory caches
 * start empty exactly as they do when VS Code starts the language server again.
 *
 * Pinned:
 *   - off by default: with no directory configured nothing is read or written (every other harness);
 *   - a second session reads names instead of decoding, and gets the SAME names;
 *   - never a stale entry: an archive rewritten with the same size and the same mtime (so the content
 *     key still matches) is caught by the central-directory fingerprint and decoded afresh;
 *   - a corrupt, truncated, foreign, outdated-version or other-decoder file is ignored (and rewritten),
 *     and a single malformed entry is dropped on its own;
 *   - bounded: entries and name characters are capped, least recently used dropped first;
 *   - the content-keyed dedup holds across sessions: eight vendored copies are ONE stored entry;
 *   - only names are stored — no other string from the archive reaches the file;
 *   - two windows flushing one directory keep each other's entries;
 *   - the file fingerprint equals the buffer fingerprint, also when the central directory starts
 *     before the 66 KB tail window.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const { createArchiveStore, FILE_NAME, FORMAT_NAME, FORMAT_VERSION } = require('../src/lsp/archiveStore');
const { fingerprintArchiveBuffer, fingerprintArchiveFile, harvestArchive, DECODER_ID } = require('../src/lsp/libsymbols');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const LIBSYMBOLS = path.join(__dirname, '..', 'src', 'lsp', 'libsymbols.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_archive_store_'));

// --- A tiny ZIP writer (stored or deflated entries, real CRC-32) -----------------------------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function varint(value) {
    const bytes = [];
    let v = value;
    do { let b = v & 0x7f; v >>>= 7; if (v > 0) b |= 0x80; bytes.push(b); } while (v > 0);
    return Buffer.from(bytes);
}
function stringTable(strings) {
    return Buffer.concat([varint(strings.length), ...strings.flatMap((s, i) => {
        const b = Buffer.from(s, 'utf8');
        return [varint(i), varint(b.length), b];
    })]);
}
/**
 * @param {Array<{name: string, data: Buffer, deflate?: boolean}>} files
 * @returns {Buffer}
 */
function zip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const f of files) {
        const nameBuf = Buffer.from(f.name, 'utf8');
        const body = f.deflate ? zlib.deflateRawSync(f.data) : f.data;
        const method = f.deflate ? 8 : 0;
        const crc = crc32(f.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(f.data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20); central.writeUInt32LE(f.data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, body);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}
const TABLE_ENTRY = '__shared_data_storage_string_table__.auxiliary';
/** A library archive whose table holds `names` plus a doc-comment string that must never be stored. */
function library(names) {
    return zip([{ name: TABLE_ENTRY, data: stringTable([...names, 'A doc comment that is not a name.', '{4d3f-guid}']) }]);
}

const FIXED = new Date('2026-03-01T10:00:00Z');
/** Writes an archive at the real `_Libraries/<company>/<title>/<version>/<file>` layout. */
function plant(project, title, buf, mtime = FIXED) {
    const dir = path.join(root, project, '_Libraries', 'synthetic co', title, '1.0.0.0');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${title}.compiled-library`);
    fs.writeFileSync(file, buf);
    fs.utimesSync(file, mtime, mtime);
    return file;
}

/**
 * One language-server "session": a fresh process harvests `files` with the cache at `cacheDir`.
 * @param {string|null} cacheDir
 * @param {string[]} files
 * @param {Object} [limits]
 * @returns {{stats: Object, names: Array<string[]|null>, info: Object, flushed: boolean}}
 */
function session(cacheDir, files, limits) {
    const script = `
        const l = require(${JSON.stringify(LIBSYMBOLS)});
        const [cacheDir, files, limits] = JSON.parse(process.argv[1]);
        if (cacheDir) l.configureArchiveCache(cacheDir, limits || undefined);
        const names = files.map(f => l.harvestArchiveFile(f));
        const info = l.archiveCacheInfo();
        const flushed = l.flushArchiveCache();
        process.stdout.write(JSON.stringify({ stats: l.__archiveStats, names, info, flushed }));`;
    const r = spawnSync(process.execPath, ['-e', script, JSON.stringify([cacheDir, files, limits || null])], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`session failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
}
const storeFile = (dir) => path.join(dir, FILE_NAME);
const readStore = (dir) => JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));

const A_NAMES = ['FB_Alpha', 'F_Alpha', 'cAlphaMax', 'E_AlphaMode'];
const B_NAMES = ['FB_Beta', 'F_Beta'];
const C_NAMES = ['FB_Gamma'];
const archA = plant('LineA', 'AlphaLib', library(A_NAMES));
const archB = plant('LineA', 'BetaLib', library(B_NAMES));

// --- Off by default ----------------------------------------------------------------------------------
{
    const s = session(null, [archA]);
    assert(s.stats.inflated === 1 && s.stats.persistHits === 0 && !s.info.enabled && !s.flushed,
        'no directory configured: the archive is decoded, nothing is persisted (every other harness runs as before)');
}

// --- Second session reads the names ------------------------------------------------------------------
const dir1 = path.join(root, 'cache1');
{
    const cold = session(dir1, [archA, archB]);
    assert(cold.stats.inflated === 2 && cold.stats.persistHits === 0 && cold.flushed,
        'first session: both archives decoded and the cache file written');
    const doc = readStore(dir1);
    assert(doc.format === FORMAT_NAME && doc.version === FORMAT_VERSION && doc.decoder === DECODER_ID,
        'the file carries the format name, the format version and the running decoder id');
    const entries = Object.values(doc.entries);
    assert(entries.length === 2 && entries.every(e => Object.keys(e).sort().join() === 'fp,names,used'),
        'each entry holds only a fingerprint, the names and a use stamp');
    const text = fs.readFileSync(storeFile(dir1), 'utf8');
    assert(!text.includes('doc comment') && !text.includes('4d3f-guid'),
        'only identifier-shaped NAMES are stored: no comment or GUID string from the archive reaches the file');

    const warm = session(dir1, [archA, archB]);
    assert(warm.stats.inflated === 0 && warm.stats.persistHits === 2,
        'second session: no archive decoded, both answered from the persisted cache');
    assert(JSON.stringify(warm.names) === JSON.stringify(cold.names) &&
        JSON.stringify(warm.names[0]) === JSON.stringify(harvestArchive(fs.readFileSync(archA))),
        'the persisted names are exactly the decoded names, in order');
    assert(!warm.flushed, 'a session that only reads the cache does not rewrite it');
}

// --- Never a stale entry ------------------------------------------------------------------------------
{
    // Same name lengths and stored (not deflated) entries => identical file size; mtime restored =>
    // the content key is unchanged. Only the content — and so the CRC-32 in the central directory — moved.
    const swapped = ['FB_Omega', 'F_Omega', 'cOmegaMax', 'E_OmegaMode'];
    const before = fs.statSync(archA).size;
    fs.writeFileSync(archA, library(swapped));
    fs.utimesSync(archA, FIXED, FIXED);
    assert(fs.statSync(archA).size === before && fs.statSync(archA).mtimeMs === FIXED.getTime(),
        'the rewritten archive keeps its size and mtime (the content key alone cannot tell)');
    const s = session(dir1, [archA]);
    assert(s.stats.persistStale === 1 && s.stats.inflated === 1 && s.stats.persistHits === 0,
        'the fingerprint catches the changed content: the stale entry is refused and the archive decoded');
    assert(JSON.stringify(s.names[0]) === JSON.stringify(swapped), 'the fresh names are the NEW content\'s');
    const again = session(dir1, [archA]);
    assert(again.stats.persistHits === 1 && JSON.stringify(again.names[0]) === JSON.stringify(swapped),
        'the re-recorded entry serves the next session with the new names');
    fs.writeFileSync(archA, library(A_NAMES));
    fs.utimesSync(archA, FIXED, FIXED);
}

// --- Corrupt, partial and foreign files are ignored ------------------------------------------------
{
    const good = fs.readFileSync(storeFile(dir1), 'utf8');
    const cases = [
        ['garbage', 'not json at all'],
        ['a truncated write', good.slice(0, Math.floor(good.length / 2))],
        ['an empty file', ''],
        ['another JSON shape', JSON.stringify({ hello: 'world' })],
        ['an older format version', JSON.stringify({ ...JSON.parse(good), version: FORMAT_VERSION + 99 })],
        ['names decoded by other code', JSON.stringify({ ...JSON.parse(good), decoder: 'f'.repeat(40) })],
        ['entries that are an array', JSON.stringify({ ...JSON.parse(good), entries: [] })]
    ];
    for (const [label, content] of cases) {
        const dir = path.join(root, `corrupt_${label.replace(/\W+/g, '_')}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(storeFile(dir), content);
        const s = session(dir, [archA]);
        assert(s.stats.inflated === 1 && s.stats.persistHits === 0 && s.info.rejected !== null && s.flushed,
            `${label}: ignored (reason "${s.info.rejected}"), the archive decoded, the file rewritten`);
        assert(readStore(dir).decoder === DECODER_ID, `${label}: the rewritten file is valid`);
    }

    // One malformed entry beside a good one: only it is dropped.
    const dir = path.join(root, 'corrupt_entry');
    fs.mkdirSync(dir, { recursive: true });
    const doc = JSON.parse(good);
    const keys = Object.keys(doc.entries);
    doc.entries[keys[0]].names = [42];
    doc.entries['bogus|1|1'] = { fp: 'nothex', names: [], used: 1 };
    fs.writeFileSync(storeFile(dir), JSON.stringify(doc));
    const s = session(dir, [archA, archB]);
    assert(s.info.rejected === null && s.info.dropped === 2 && s.info.loaded === 1,
        'malformed entries are dropped one by one; the valid entry is kept');
    assert(s.stats.persistHits === 1 && s.stats.inflated === 1, 'the kept entry still serves; the dropped one is decoded');
}

// --- Bounded ------------------------------------------------------------------------------------------
{
    const archC = plant('LineA', 'GammaLib', library(C_NAMES));
    const dir = path.join(root, 'bounded');
    session(dir, [archA], { maxEntries: 2 });
    session(dir, [archB], { maxEntries: 2 });
    session(dir, [archC], { maxEntries: 2 });
    const kept = Object.keys(readStore(dir).entries);
    assert(kept.length === 2 && !kept.some(k => k.includes('alphalib')),
        `entry cap: the least recently used archive is evicted (kept ${kept.map(k => k.split('/')[0]).join(', ')})`);

    const dirChars = path.join(root, 'bounded_chars');
    // A's names cost 4 x (len + 3) characters; allow room for B and C only.
    session(dirChars, [archA, archB, archC], { maxNameChars: 40 });
    const keptChars = Object.values(readStore(dirChars).entries);
    const chars = keptChars.reduce((n, e) => n + e.names.reduce((m, x) => m + x.length + 3, 0), 0);
    assert(chars <= 40 && keptChars.length >= 1, `name-character cap: the file stays within it (${chars} <= 40)`);
}

// --- Content-keyed dedup across projects and sessions -----------------------------------------------
{
    const copies = [];
    for (let p = 0; p < 8; p++) copies.push(plant(`Proj${p}`, 'SharedLib', library(['FB_Shared', 'cShared'])));
    const dir = path.join(root, 'dedup');
    const cold = session(dir, copies);
    assert(cold.stats.inflated === 1 && cold.stats.contentHits === 7, 'eight vendored copies: one decode, seven content hits');
    assert(Object.keys(readStore(dir).entries).length === 1, 'and ONE stored entry, not eight');
    const warm = session(dir, copies);
    assert(warm.stats.inflated === 0 && warm.stats.persistHits === 1 && warm.stats.contentHits === 7,
        'next session: one verified persisted hit, the other seven share it in memory');
}

// --- Two windows, one storage directory ---------------------------------------------------------------
{
    const dir = path.join(root, 'two_windows');
    const a = createArchiveStore({ dir, decoderId: DECODER_ID });
    const b = createArchiveStore({ dir, decoderId: DECODER_ID });
    a.lookup('x');
    b.lookup('x');
    a.record('lib_a|1|1', 'a'.repeat(40), ['FB_A']);
    b.record('lib_b|1|1', 'b'.repeat(40), ['FB_B']);
    a.flush();
    b.flush();
    const keys = Object.keys(readStore(dir).entries).sort();
    assert(keys.join() === 'lib_a|1|1,lib_b|1|1', 'the second window\'s flush keeps the first window\'s entry');
    const c = createArchiveStore({ dir: path.join(root, 'unwritable', '\u0000bad'), decoderId: DECODER_ID });
    c.record('k|1|1', 'c'.repeat(40), ['X']);
    let threw = false;
    try { c.flush(); } catch (e) { threw = true; }
    assert(!threw, 'an unwritable directory is not an error (the cache is an optimisation)');
}

// --- File fingerprint == buffer fingerprint ------------------------------------------------------------
{
    const small = fs.readFileSync(archB);
    assert(fingerprintArchiveFile(archB, small.length) === fingerprintArchiveBuffer(small) && /^[0-9a-f]{40}$/.test(fingerprintArchiveBuffer(small)),
        'small archive: the fingerprint read from the file\'s end equals the one from the whole buffer');
    const many = [];
    for (let i = 0; i < 1500; i++) many.push({ name: `object_${String(i).padStart(5, '0')}_with_a_long_entry_name.object`, data: Buffer.from([i & 0xff]) });
    many.push({ name: TABLE_ENTRY, data: stringTable(['FB_Big']), deflate: true });
    const big = zip(many);
    const bigFile = path.join(root, 'big.compiled-library');
    fs.writeFileSync(bigFile, big);
    const cdSize = big.readUInt32LE(big.length - 22 + 12);
    assert(cdSize > 66000, `the large archive's central directory (${cdSize} bytes) starts before the tail window`);
    assert(fingerprintArchiveFile(bigFile, big.length) === fingerprintArchiveBuffer(big),
        'large central directory: file and buffer fingerprints agree');
    assert(fingerprintArchiveFile(path.join(root, 'missing.library'), 100) === null &&
        fingerprintArchiveBuffer(Buffer.from('not a zip')) === null,
        'no fingerprint for a missing file or a non-ZIP buffer (such an archive is simply not persisted)');
}

fs.rmSync(root, { recursive: true, force: true });

if (errors > 0) {
    console.error(`\n${errors} archive-store assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll archive-store assertions passed.');
