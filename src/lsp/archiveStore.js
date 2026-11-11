/**
 * @file archiveStore.js
 * @description The PERSISTED half of the archive-name cache: decoded library symbol names kept across
 * sessions in VS Code's global storage, so a second session does not decode every vendor archive again.
 *
 * What it stores is exactly what libsymbols.js's in-memory `harvestCache` already holds — the
 * identifier-shaped NAMES of one archive's string table, nothing else — under the same content key
 * (`<title>/<version>/<file>|size|mtimeMs`), so the cross-project dedup of identical vendor copies
 * carries over unchanged. The file lives only in the user's own global storage on their own machine
 * (passed to the server as `initializationOptions.archiveCacheDir`); never in the repo or the VSIX.
 *
 * **It never trusts a stale entry.** An entry is used only when all of these hold:
 *   - the file's `decoder` id equals the running code's (libsymbols.js `DECODER_ID`, a hash of the ZIP
 *     reader and string-table parser SOURCE plus FORMAT_VERSION) — so a change to how names are
 *     decoded discards every name decoded the old way, with no version bump to forget;
 *   - the content key matches (the same tail, size and mtime guard the in-memory cache uses);
 *   - the archive's ZIP central-directory fingerprint, read from the file NOW, equals the stored one.
 *     The central directory carries every entry's CRC-32 and sizes, so a string table whose bytes
 *     changed cannot keep its fingerprint — a real content guard for one small read at the file's end.
 *
 * **It tolerates a corrupt or partial file by ignoring it.** A file that does not parse, has the wrong
 * shape, the wrong format, version or decoder, or is larger than the read ceiling, is treated as empty;
 * a single malformed entry is dropped on its own. Writes go to a temp file and are renamed into place,
 * so a crash mid-write leaves the previous file (or none), never half of one.
 *
 * **It stays bounded.** At most MAX_ENTRIES archives and MAX_NAME_CHARS characters of names are kept;
 * the least recently used entries are dropped first when a flush would exceed either.
 *
 * Two VS Code windows share one global storage. Each flush re-reads the file and keeps entries the
 * other window wrote, so neither erases the other's work; if both write at once, the last rename wins —
 * that only costs a future decode, never a wrong name, because every entry is re-validated on use.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Bump when the file's JSON shape changes. Decoder changes are caught by the decoder id instead. */
const FORMAT_VERSION = 1;
/** Identifies the file, so a stray JSON file of another shape is never read as one. */
const FORMAT_NAME = 'tc-toolkit-archive-names';
/** The file name inside the cache directory. */
const FILE_NAME = `archive-names-v${FORMAT_VERSION}.json`;
/** At most this many archives are kept. */
const MAX_ENTRIES = 4000;
/** At most this many characters of names are kept (about the same in bytes on disk). */
const MAX_NAME_CHARS = 40 * 1024 * 1024;
/** A file larger than this is not read at all (treated as corrupt). */
const MAX_FILE_BYTES = 96 * 1024 * 1024;

/** A hit refreshes an entry's `used` stamp on disk only when it is older than this, so a session that
 *  only READS the cache does not rewrite the whole file on every scan. */
const TOUCH_GRANULARITY_MS = 24 * 60 * 60 * 1000;

/** A SHA-1 hex digest. */
const FINGERPRINT = /^[0-9a-f]{40}$/;

/**
 * @typedef {Object} StoredEntry
 * @property {string} fp ZIP central-directory fingerprint (SHA-1 hex).
 * @property {string[]} names Harvested names, in harvest order (duplicates kept, as harvested).
 * @property {number} used Last use, epoch ms — the eviction order.
 */

/**
 * @typedef {Object} ArchiveStore
 * @property {(key: string) => (StoredEntry|null)} lookup The entry for a content key, or null. The
 *   caller still has to compare the fingerprint against the file before trusting the names.
 * @property {(key: string) => void} touch Marks an entry used (after a verified hit).
 * @property {(key: string, fp: string, names: string[]) => void} record Stores a fresh decode.
 * @property {(key: string) => void} forget Drops an entry whose fingerprint no longer matches.
 * @property {() => boolean} flush Writes the store if it changed; true when a file was written.
 * @property {() => boolean} enabled False when no directory is configured.
 * @property {() => {loaded: number, rejected: string|null, dropped: number}} info What the last load
 *   found: entries accepted, why a whole file was rejected (null when it was not), entries dropped.
 */

/**
 * Validates one parsed entry.
 * @param {*} e
 * @returns {boolean}
 */
function isValidEntry(e) {
    return !!e && typeof e === 'object'
        && typeof e.fp === 'string' && FINGERPRINT.test(e.fp)
        && Array.isArray(e.names) && e.names.every(n => typeof n === 'string')
        && typeof e.used === 'number' && Number.isFinite(e.used);
}

/**
 * Reads and validates the store file. Never throws.
 * @param {string} file Absolute path.
 * @param {string} decoderId The running decoder's id.
 * @returns {{entries: Map<string, StoredEntry>, rejected: string|null, dropped: number}}
 */
function readStoreFile(file, decoderId) {
    const entries = new Map();
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (e) {
        return { entries, rejected: null, dropped: 0 }; // no file yet: an empty store, not a rejection
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { entries, rejected: 'size', dropped: 0 };
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return { entries, rejected: 'unreadable', dropped: 0 };
    }
    if (!doc || typeof doc !== 'object' || doc.format !== FORMAT_NAME) return { entries, rejected: 'format', dropped: 0 };
    if (doc.version !== FORMAT_VERSION) return { entries, rejected: 'version', dropped: 0 };
    if (doc.decoder !== decoderId) return { entries, rejected: 'decoder', dropped: 0 };
    if (!doc.entries || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) {
        return { entries, rejected: 'format', dropped: 0 };
    }
    let dropped = 0;
    for (const key of Object.keys(doc.entries)) {
        const e = doc.entries[key];
        if (!isValidEntry(e)) { dropped++; continue; }
        entries.set(key, { fp: e.fp, names: e.names, used: e.used });
    }
    return { entries, rejected: null, dropped };
}

/**
 * Keeps the most recently used entries within both bounds.
 * @param {Map<string, StoredEntry>} entries
 * @param {{maxEntries: number, maxNameChars: number}} limits
 * @returns {Array<[string, StoredEntry]>} The kept entries, most recent first.
 */
function boundEntries(entries, limits) {
    const sorted = Array.from(entries.entries()).sort((a, b) => b[1].used - a[1].used);
    const kept = [];
    let chars = 0;
    for (const [key, e] of sorted) {
        if (kept.length >= limits.maxEntries) break;
        let size = 0;
        for (const n of e.names) size += n.length + 3;
        if (chars + size > limits.maxNameChars) continue; // one oversized archive must not evict the rest
        chars += size;
        kept.push([key, e]);
    }
    return kept;
}

/**
 * Creates a store over one directory. With no directory it is a disabled store: every lookup misses
 * and nothing is written — the behaviour of every harness and of a host that passes no storage path.
 * @param {{dir?: string|null, decoderId: string, now?: () => number,
 *   maxEntries?: number, maxNameChars?: number}} options `now` and the limits are seams for the harness.
 * @returns {ArchiveStore}
 */
function createArchiveStore(options) {
    const dir = (options && options.dir) || null;
    const decoderId = String((options && options.decoderId) || '');
    const now = (options && options.now) || Date.now;
    const limits = {
        maxEntries: (options && options.maxEntries) || MAX_ENTRIES,
        maxNameChars: (options && options.maxNameChars) || MAX_NAME_CHARS
    };
    const file = dir ? path.join(dir, FILE_NAME) : null;

    /** @type {Map<string, StoredEntry>|null} Loaded lazily, on the first lookup or record. */
    let entries = null;
    let dirty = false;
    let lastInfo = { loaded: 0, rejected: /** @type {string|null} */ (null), dropped: 0 };

    const load = () => {
        if (entries) return entries;
        if (!file) { entries = new Map(); return entries; }
        const read = readStoreFile(file, decoderId);
        entries = read.entries;
        lastInfo = { loaded: entries.size, rejected: read.rejected, dropped: read.dropped };
        // A rejected or partly dropped file is rewritten on the next flush, so it does not stay corrupt.
        if (read.rejected || read.dropped) dirty = true;
        return entries;
    };

    return {
        lookup: (key) => {
            if (!file) return null;
            return load().get(key) || null;
        },
        touch: (key) => {
            if (!file) return;
            const e = load().get(key);
            if (!e) return;
            const t = now();
            if (t - e.used > TOUCH_GRANULARITY_MS) dirty = true;
            e.used = t;
        },
        record: (key, fp, names) => {
            if (!file || !FINGERPRINT.test(fp) || !Array.isArray(names)) return;
            load().set(key, { fp, names, used: now() });
            dirty = true;
        },
        forget: (key) => {
            if (!file) return;
            if (load().delete(key)) dirty = true;
        },
        flush: () => {
            if (!file || !entries || !dirty) return false;
            // Keep what another window wrote since we loaded; ours wins on a shared key.
            const onDisk = readStoreFile(file, decoderId).entries;
            for (const [key, e] of onDisk) if (!entries.has(key)) entries.set(key, e);
            const kept = boundEntries(entries, limits);
            entries = new Map(kept);
            const doc = { format: FORMAT_NAME, version: FORMAT_VERSION, decoder: decoderId, entries: {} };
            for (const [key, e] of kept) doc.entries[key] = e;
            const tmp = `${file}.${process.pid}.tmp`;
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(doc));
                fs.renameSync(tmp, file);
            } catch (e) {
                try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* nothing left to clean */ }
                return false; // storage unavailable: the cache is an optimisation, never a failure
            }
            dirty = false;
            return true;
        },
        enabled: () => !!file,
        info: () => ({ ...lastInfo })
    };
}

module.exports = {
    createArchiveStore,
    FORMAT_VERSION,
    FORMAT_NAME,
    FILE_NAME,
    MAX_ENTRIES,
    MAX_NAME_CHARS,
    MAX_FILE_BYTES
};
