/**
 * @file libsymbols.js
 * @description Registry of external library *symbol names*, harvested from the binary
 * `.compiled-library` / `.library` archives a TwinCAT project references.
 *
 * Why this exists: `libraries.js` recovers library *namespaces* from the `.plcproj`, which is enough
 * to keep a qualified path (`VisuElems.…`) quiet, but the vast majority of library usage is *bare* —
 * `DEFAULT_ADS_TIMEOUT`, `T_MaxString`, `TIMESTRUCT`, `MC_BufferMode`. Those names live only inside
 * the vendor archives, so the undeclared-identifier check flagged every one of them (171 diagnostics
 * on the sample project — all false positives).
 *
 * Container format (established by probing the 48 archives under sample/**\/_Libraries):
 *   - Every archive is a plain **ZIP** (magic `PK\x03\x04`), all entries deflate-compressed.
 *     Node's built-in `zlib` is therefore sufficient — no new dependency, no build step.
 *   - Entries are `<guid>.meta` / `<guid>.object` (CODESYS-proprietary object graph, not decoded here)
 *     plus a few `.auxiliary` entries. One of them, `__shared_data_storage_string_table__.auxiliary`,
 *     holds **every string the archive serialized** — object names, member names, type names, comments.
 *   - That string table is a flat, length-prefixed sequence:
 *         [count: LEB128] then count × ( [id: LEB128] [byteLength: LEB128] [UTF-8 bytes] )
 *     Verified exact (bytes consumed == inflated size) on all 48 archives.
 *
 * We harvest a **flat set of identifier-shaped names** from that table — no types, no members, no
 * object graph. That is all the undeclared-identifier check needs: registerLibrarySymbolNodes() puts
 * the names a document references into the workspace symbol index as `external: true` nodes, and
 * `typeFromNode()` (types.js) maps those nodes to the `unknown` type so that member access on a
 * library type is never flagged. The harvest therefore only ever *removes* diagnostics — it can never
 * introduce one.
 *
 * Besides the flat set, the registry keeps a **namespace → symbols** map (see "Namespace
 * attribution" below). Completion needs it: ~32k names may never be dumped into a type caret, but
 * once the caret is qualified by a library namespace (`Tc2_MC2.▮`) the list narrows to that one
 * library and becomes useful. The map is built once, at index time — never per keystroke.
 *
 * The archives give names only. The project's **`.tmc`** gives *structure* — see "Type-system
 * structure" below — so the types the project actually uses also carry their real members.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { walkFiles, ARCHIVE_SKIP_DIRS, PROJECT_SKIP_DIRS } = require('../twincatWorkspace');
const { findBrowserCacheFile, MANAGED_LIBRARIES } = require('./browserCache');
const {
    parseSignatureRecords,
    signatureRecordsFor,
    readBrowserCacheDoc
} = require('./parseCache');
const { readLibraryReferences, collectPlcProjFiles } = require('./plcprojRefs');
const log = require('./log');

/** ZIP signatures. */
const SIG_EOCD = 0x06054b50;        // End of central directory
const SIG_CENTRAL = 0x02014b50;     // Central directory file header
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;

/** Maximum size of the EOCD record plus its (optional) trailing comment. */
const MAX_EOCD_SEARCH = 66000;

/**
 * Defensive ZIP limits. Library archives are inputs from the workspace, not trusted application
 * resources: a tiny deflate stream can otherwise make inflateRawSync allocate an arbitrary amount
 * of memory in the language-server process. The largest observed TwinCAT string table is far below
 * this ceiling; keep the limit explicit and raise it only alongside fixture measurements.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100000;
const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;

/** The single archive entry that carries every serialized string. */
const STRING_TABLE_ENTRY = /string_table.*\.auxiliary$/i;

/**
 * Archive extensions to scan.
 *
 * TwinCAT ships the same library under several extensions. `.compiled-library`,
 * `.compiled-library-ge33` and `.library` are all plain ZIP containers (magic `PK\x03\x04`) and
 * decode identically. `.compiled-library-v3` is a DIFFERENT, non-ZIP format (magic `10 a6 d5 a7`);
 * it is skipped deliberately — every library the project references is also shipped in one of the
 * ZIP forms, so nothing is lost.
 *
 * Omitting `-ge33` is what previously left Tc2_EtherCAT, Tc2_ControllerToolbox, Tc3_IotBase and
 * Tc2_XmlDataSrv unindexed (they ship *only* as `-ge33`), stranding 18 false-positive diagnostics.
 */
const LIBRARY_EXT = /\.(compiled-library|compiled-library-ge33|library)$/i;

/** Directories that never contain library archives (build output, VCS, tooling). Same Set object
 *  as twincatWorkspace.js's ARCHIVE_SKIP_DIRS (the discovery owner) — kept under this module's own
 *  name because test_collect_scope.js's mutation pin (adds '_libraries', asserts collectArchives
 *  goes blind, deletes it) exercises SKIP_DIRS by identity. */
const SKIP_DIRS = ARCHIVE_SKIP_DIRS;

/**
 * A harvested name is only useful if it can appear as an identifier in Structured Text. The string
 * table also holds GUIDs, doc comments, paths and version strings — this filter drops all of them.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The registry key on a symbol index. A `Symbol` deliberately: `Object.keys()`, `for…in` and
 * `JSON.stringify` all skip symbol-keyed properties, and the index is iterated by key in several hot
 * paths (the reference scan in features/references.js, the GVL-global lookup in types.js). Attaching
 * the registry to the index therefore costs those loops nothing and needs no signature change where
 * the index is already in hand — notably registerLibrarySymbolNodes(index, code).
 */
const LIBRARY_REGISTRY = Symbol.for('twincat.librarySymbols');

/**
 * All per-project library state in one object. Everything here is scoped to a single `.plcproj`:
 * two PLC projects reference different libraries, and unioning them makes each project quiet about
 * names it cannot actually resolve.
 * @returns {Object} A fresh registry.
 */
function createLibraryRegistry() {
    return {
        librarySymbols: new Map(),
        namespaceSymbols: new Map(),
        namespaceNames: new Map(),
        libraryTitles: new Map(),
        libraryCatalog: new Map(),
        namespaceListCache: new Map(),
        typeSystemTypes: new Map(),
        typeSystemNamespaces: new Map(),
        browserCacheNamespaceTypes: new Map(),
        browserCacheNamespaceMembers: new Map(),
        nestedNamespaceSymbols: new Map()
    };
}

/** The default registry — the fallback for callers with no index (the test harnesses). */
const defaultRegistry = createLibraryRegistry();

/**
 * The library registry for a symbol index — READ side. Never mutates `index`: when this exact index
 * has never had its own registry created (nothing was ever indexed *into* it — see
 * ensureLibraryRegistry, the write-side twin), this falls back to the shared default registry rather
 * than silently reading an empty one.
 *
 * That fallback is what keeps the pre-existing standalone harnesses working unchanged: they populate
 * the registry via the module-level `indexLibrarySymbols(dir)` etc. with NO index (the default), then
 * exercise a feature (provideCompletions, registerLibrarySymbolNodes) against a real, separately-
 * constructed symbol index that was never itself indexed. For any project `indexLibraries` HAS
 * processed (see ensureLibraryRegistry), this branch is never taken — that project's own registry
 * already exists by the time a getter or registerLibrarySymbolNodes runs. It IS taken for an index
 * nothing has indexed yet: workspaceScan.js's `indexForKey` lazily creates an empty `{}` for any
 * project key not yet scanned (reachable for LOOSE_PROJECT_KEY), and that is exactly what made the
 * custom/libraries handler return nothing before its union fallback was added (see server.js,
 * getUnionLibraryCatalog).
 * @param {Object} [index] A project's symbol index. Omit for the default registry.
 * @returns {Object} That project's library registry (or the default's).
 */
function libRegistryFor(index) {
    if (!index) return defaultRegistry;
    return index[LIBRARY_REGISTRY] || defaultRegistry;
}

/**
 * The library registry for a symbol index — WRITE side: creates and attaches this index's OWN
 * registry on first use, even if the write that follows adds nothing to it (a project that
 * references no libraries still gets an empty registry of its own, so a later read is correctly
 * isolated rather than falling back to the default). Every function that populates or clears the
 * registry must go through this, never libRegistryFor — reading-and-creating would let one project's
 * write silently land on the shared default instead of its own index.
 * @param {Object} [index] A project's symbol index. Omit for the default registry.
 * @returns {Object} That project's library registry.
 */
function ensureLibraryRegistry(index) {
    if (!index) return defaultRegistry;
    if (!index[LIBRARY_REGISTRY]) index[LIBRARY_REGISTRY] = createLibraryRegistry();
    return index[LIBRARY_REGISTRY];
}

/**
 * Per-archive harvest cache, in two levels. Archives must never be re-inflated on a language-feature
 * request: indexing runs only at startup / reindex, and even then a re-scan must reuse what it already
 * decoded. Both levels are MODULE GLOBALS and SHARED across every project's registry — they hold
 * decoded ZIP string tables, which are the same bytes whoever asks. Sharing a *cache* is correct;
 * sharing a *namespace* would be the bug the rest of this file exists to fix. Neither is cleared by
 * clearLibrarySymbols(): both are content-guarded, so they stay valid across a registry rebuild.
 *
 * Level 1 — `identityCache`, keyed by lower-cased absolute path. This is literally the check that has
 * always been made: same path, same mtime and size ⇒ same content.
 *
 * Level 2 — `harvestCache`, keyed by CONTENT, so one decode serves every copy of the same archive.
 * Every PLC project vendors its own `_Libraries`, so a multi-project workspace holds the same vendor
 * archives many times over: measured on a real 8-project workspace, 306 archive files / 156.5 MB on
 * disk but only 148 distinct / 74.2 MB — **53% of the bytes are byte-identical copies at different
 * paths**, which a path-keyed cache re-inflates in full.
 *
 * The content key is the last three path segments plus size plus mtime. The real layout is
 * `_Libraries/<company>/<title>/<version>/<file>`, so those three segments are
 * `<title>/<version>/<file>` — identical across every project's copy, and strictly stronger than a
 * bare basename for free. This is no weaker than the level-1 check it extends: that one already
 * assumes mtime+size identifies content, and this adds the library's own identity on top. Of the 90
 * duplicate groups measured, 81 share an identical millisecond mtime; the 9 that do not simply fail to
 * share and are inflated separately — today's outcome, not a worse one. If a false content-share ever
 * does bite, the documented hardening is a ZIP central-directory fingerprint (the ≤66 KB EOCD tail is
 * already read — see MAX_EOCD_SEARCH — so hashing `(entryName, crc32, compressedSize)` is cheap).
 * @type {Map<string, {mtimeMs: number, size: number, contentKey: string}>}
 */
const identityCache = new Map();

/** @type {Map<string, string[]>} Content key → harvested names. See identityCache above. */
const harvestCache = new Map();

/**
 * Observation counters for the harnesses — never read by the extension. `statted` counts calls that
 * got as far as a stat, `inflated` archives actually decoded, `contentHits` decodes saved by a copy at
 * another path, `pathHits` decodes saved by the same path being asked twice.
 * @type {{statted: number, inflated: number, contentHits: number, pathHits: number}}
 */
const __archiveStats = { statted: 0, inflated: 0, contentHits: 0, pathHits: 0 };

/**
 * The content-identity key for an archive: `<title>/<version>/<file>|size|mtimeMs`, lower-cased.
 * @param {string} filePath Absolute archive path.
 * @param {number} size Size in bytes.
 * @param {number} mtimeMs Modification time in milliseconds.
 * @returns {string} Cache key.
 */
function archiveContentKey(filePath, size, mtimeMs) {
    const tail = path.resolve(filePath).split(/[\\/]/).filter(Boolean).slice(-3).join('/');
    return `${tail.toLowerCase()}|${size}|${mtimeMs}`;
}

/**
 * Harvests one archive's symbol names, decoding it at most once per distinct content — the single
 * entry point for every archive read in this module.
 *
 * Never throws: an archive that cannot be statted, read or decoded yields null, and every caller then
 * contributes nothing for it rather than guessing. That is the pre-existing conservative behaviour,
 * and it is deliberately NOT cached as a negative: a failure is cheap and rare, and caching one would
 * make a transient read error stick for the session.
 * @param {string} filePath Absolute archive path.
 * @returns {string[]|null} Harvested names (original spelling, may contain duplicates), or null.
 */
function harvestArchiveFile(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        return null;
    }
    __archiveStats.statted++;
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) return null;

    const pathKey = path.resolve(filePath).toLowerCase();
    const known = identityCache.get(pathKey);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
        const names = harvestCache.get(known.contentKey);
        if (names) {
            __archiveStats.pathHits++;
            return names;
        }
    }

    const contentKey = archiveContentKey(filePath, stat.size, stat.mtimeMs);
    const shared = harvestCache.get(contentKey);
    if (shared) {
        __archiveStats.contentHits++;
        identityCache.set(pathKey, { mtimeMs: stat.mtimeMs, size: stat.size, contentKey });
        return shared;
    }

    let names;
    try {
        names = harvestArchive(fs.readFileSync(filePath));
    } catch (e) {
        // `debug`: an archive that will not decode is a normal fact of a vendored `_Libraries` tree,
        // and the count of them is already reported at info level in the per-project summary line
        // ("N undecodable"). This record only names WHICH one, for a session that is chasing a
        // resurrected false positive back to its missing symbol source.
        log.debug('archive-decode-failed', { file: filePath, error: e });
        return null; // undecodable archive: contribute nothing rather than guess
    }
    __archiveStats.inflated++;
    harvestCache.set(contentKey, names);
    identityCache.set(pathKey, { mtimeMs: stat.mtimeMs, size: stat.size, contentKey });
    return names;
}

/**
 * @typedef {Object} LibraryCatalogEntry
 * @property {string} include The reference's `Include` attribute — the placeholder name
 *           (`Acme Vision Sensor`) or the pinned reference triple
 *           (`Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH`).
 * @property {string} title The library's own title (`Acme Sensor Library TC3`, `Tc2_EtherCAT`).
 * @property {string} version Version exactly as the .plcproj writes it: `3.5.1.0`, `*`, `newest`.
 * @property {string} company Vendor (`Acme GmbH`, `System`, `Beckhoff Automation GmbH`); '' if none.
 * @property {string} namespace The namespace the project imports the library under, in the
 *           .plcproj's own spelling — this is what the programmer actually types.
 * @property {'placeholder'|'reference'} kind Which reference element declared it.
 */

/**
 * The libraries the .plcproj references, keyed `kind|include|namespace` so a re-scan (indexLibraryTitles
 * runs once per index pass, and there are two of them) cannot duplicate an entry.
 *
 * Why a catalog at all: a library's title, its placeholder name and its *namespace* are three different
 * strings, and only the last one is what a programmer types (`Acme Vision Sensor` /
 * `Acme Sensor Library TC3` are both imported as `Acme_Vision_Sensor`). The "TwinCAT Libraries" view
 * exists to show that mapping, and this is the one place all three spellings are already in hand.
 * (`Map<string, LibraryCatalogEntry>`, lives at `registry.libraryCatalog` — see createLibraryRegistry.)
 */

/**
 * getNamespaceSymbols() result cache: namespace (lower-case) → name list. Completion calls it on
 * every keystroke at a namespace-qualified caret, so the list is materialized once, not per call.
 * Invalidated whenever the namespace map is written to.
 * (`Map<string, string[]>`, lives at `registry.namespaceListCache`.)
 */

/**
 * @typedef {Object} LibraryMember
 * @property {string} name Member name, in the library's own spelling.
 * @property {string} type Declaration type string (`LREAL`, `ARRAY [1..17] OF INT`,
 *           `REFERENCE TO AXIS_REF`, `Enum` for an enum member).
 * @property {string} scope Declared scope: 'VAR_INPUT' / 'VAR_OUTPUT' / 'VAR_IN_OUT' for an FB's
 *           call parameters, 'ENUM' for an enum member, '' for a plain struct field.
 */

/**
 * @typedef {Object} LibraryMethod
 * @property {string} name Method name, in the library's own spelling.
 * @property {string} [returnType] Declaration type of the return value ('' when it returns nothing;
 *           absent for a browsercache-sourced method, whose return type is unknown).
 * @property {LibraryMember[]} [params] Parameters, in declaration order. An unmarked parameter is an
 *           input, so `scope` is never '' here. **Absent** (not empty) for a browsercache-sourced
 *           method — its parameters are unknown, which the tree renders as a bare name, not `()`.
 */

/**
 * @typedef {Object} LibraryType
 * @property {string} name Type name, in the `.tmc`'s spelling.
 * @property {'struct'|'fb'|'enum'|'opaque'|'function'|'interface'|'gvl'} kind What the `.tmc` block
 *           (or the signatures dump) describes. `'interface'` and `'gvl'` come only from signatures.
 * @property {string} [namespace] Owning library namespace, in the .plcproj's spelling ('' if none).
 * @property {LibraryMember[]} members Fields / call parameters / enum members. Empty for 'opaque'.
 * @property {LibraryMethod[]} [methods] Methods of an FB or interface (from the `.tmc`, with parameters;
 *           the browsercache adds any it lacks, as bare names).
 * @property {{name: string}[]} [properties] Property NAMES of an FB or interface, from the browsercache
 *           (indexBrowserCache). Names only — no accessor types.
 * @property {string} [extendsType] Base type this one inherits from ('' when it extends nothing).
 * @property {string} [returnType] Return type of a signature-derived FUNCTION ('' / absent otherwise).
 */

/**
 * Structured library types harvested from the project's `.tmc`, keyed lower-case.
 * (`Map<string, LibraryType>`, lives at `registry.typeSystemTypes`.)
 */

/**
 * The `.tmc`'s *top-level* types per library namespace (lower-case) — a subset of
 * namespaceSymbols, whose string-table names cannot tell a type from an internal member name.
 * Completion ranks these first at a namespace-qualified caret.
 * (`Map<string, LibraryType[]>`, lives at `registry.typeSystemNamespaces`.)
 */

/**
 * What the browsercache knows about a namespace's SHAPE, as opposed to its members.
 *
 * The `.tmc` is the better description of a type — it carries fields and parameters — but it only
 * exports the types the project already *uses*. The browsercache lists every FB and interface the
 * library declares, used or not, which is precisely the set a user reaches for at a fresh caret.
 * Both are needed: the `.tmc` for depth, this for breadth.
 *
 *   topLevel — namespace (lower-case) → name (lower-case) → { name, kind: 'fb'|'interface' }
 *              (`Map<string, Map<string, {name: string, kind: string}>>`, `registry.browserCacheNamespaceTypes`)
 *   members  — namespace (lower-case) → set of names (lower-case) that appear ONLY as a method or
 *              property of some type in that library, and so cannot be written as `Namespace.X`
 *              (`Map<string, Set<string>>`, `registry.browserCacheNamespaceMembers`)
 */

/**
 * Symbols of a nested namespace, keyed lower-case, harvested lazily by getNestedNamespaceSymbols.
 * An empty array is a cached MISS — the library is not installed — and must not be retried.
 * (`Map<string, string[]>`, lives at `registry.nestedNamespaceSymbols`.)
 */

// ---------------------------------------------------------------------------------------------
// Minimal ZIP reader (central directory + inflateRaw). No dependencies.
// ---------------------------------------------------------------------------------------------

/**
 * Locates the End Of Central Directory record by scanning backwards from the end of the buffer.
 * @param {Buffer} buf Whole archive.
 * @returns {number} Offset of the EOCD, or -1 if not found.
 */
function findEndOfCentralDirectory(buf) {
    const floor = Math.max(0, buf.length - MAX_EOCD_SEARCH);
    for (let i = buf.length - 22; i >= floor; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) return i;
    }
    return -1;
}

/**
 * @typedef {Object} ZipEntry
 * @property {string} name Entry name.
 * @property {number} method Compression method (0 = stored, 8 = deflate).
 * @property {number} compressedSize Bytes on disk.
 * @property {number} uncompressedSize Bytes after inflation.
 * @property {number} localHeaderOffset Offset of the local file header.
 */

/**
 * Reads a ZIP central directory.
 * @param {Buffer} buf Whole archive.
 * @returns {ZipEntry[]} Entries, in central-directory order.
 * @throws {Error} If the buffer is not a ZIP archive.
 */
function readZipEntries(buf) {
    if (!Buffer.isBuffer(buf) || buf.length > MAX_ARCHIVE_BYTES) {
        throw new Error('ZIP archive exceeds the supported size limit');
    }
    const eocd = findEndOfCentralDirectory(buf);
    if (eocd === -1) throw new Error('not a ZIP archive (no end-of-central-directory record)');

    let count = buf.readUInt16LE(eocd + 10);
    let centralOffset = buf.readUInt32LE(eocd + 16);

    // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64 EOCD record.
    if (count === 0xffff || centralOffset === 0xffffffff) {
        const locator = eocd - 20;
        if (locator >= 0 && buf.readUInt32LE(locator) === SIG_ZIP64_LOCATOR) {
            const z64 = Number(buf.readBigUInt64LE(locator + 8));
            if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === SIG_ZIP64_EOCD) {
                count = Number(buf.readBigUInt64LE(z64 + 32));
                centralOffset = Number(buf.readBigUInt64LE(z64 + 48));
            }
        }
    }

    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ZIP_ENTRIES) {
        throw new Error('ZIP archive contains too many entries');
    }
    if (!Number.isSafeInteger(centralOffset) || centralOffset < 0 || centralOffset > eocd) {
        throw new Error('ZIP archive has an invalid central-directory offset');
    }

    const entries = [];
    let p = centralOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const next = p + 46 + nameLen + extraLen + commentLen;
        if (next > buf.length) throw new Error('truncated ZIP central-directory entry');
        entries.push({
            name: buf.toString('utf8', p + 46, p + 46 + nameLen),
            method: buf.readUInt16LE(p + 10),
            compressedSize: buf.readUInt32LE(p + 20),
            uncompressedSize: buf.readUInt32LE(p + 24),
            localHeaderOffset: buf.readUInt32LE(p + 42)
        });
        p = next;
    }
    return entries;
}

/**
 * Inflates one ZIP entry. The local header is re-read because its name/extra lengths may differ from
 * the central directory's — only it gives the true offset of the compressed data.
 * @param {Buffer} buf Whole archive.
 * @param {ZipEntry} entry Entry from readZipEntries.
 * @returns {Buffer} Uncompressed bytes.
 * @throws {Error} On an unsupported compression method or a corrupt header.
 */
function readZipEntryData(buf, entry) {
    if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
        || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
        throw new Error(`ZIP entry "${entry.name}" exceeds the supported output limit`);
    }
    const off = entry.localHeaderOffset;
    if (off + 30 > buf.length) throw new Error(`truncated local header for "${entry.name}"`);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const start = off + 30 + nameLen + extraLen;
    const end = start + entry.compressedSize;
    if (start < off || end < start || end > buf.length) {
        throw new Error(`truncated data for "${entry.name}"`);
    }
    const raw = buf.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) {
        if (raw.length !== entry.uncompressedSize) {
            throw new Error(`stored size mismatch for "${entry.name}"`);
        }
        return Buffer.from(raw);
    }
    if (entry.method === 8) {
        const inflated = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
        if (inflated.length !== entry.uncompressedSize) {
            throw new Error(`inflated size mismatch for "${entry.name}"`);
        }
        return inflated;
    }
    throw new Error(`unsupported compression method ${entry.method} for "${entry.name}"`);
}

// ---------------------------------------------------------------------------------------------
// CODESYS shared-data string table
// ---------------------------------------------------------------------------------------------

/**
 * Reads an LEB128 (7-bit little-endian) varint.
 * @param {Buffer} buf Source.
 * @param {{i: number}} cursor Mutated read position.
 * @returns {number} The value.
 */
function readVarint(buf, cursor) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
        if (cursor.i >= buf.length) throw new Error('unexpected end of string table');
        byte = buf[cursor.i++];
        result |= (byte & 0x7f) << shift;
        shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
}

/**
 * Parses an inflated `__shared_data_storage_string_table__.auxiliary` entry.
 * Layout: [count][ (id)(byteLength)(UTF-8 bytes) ]*, every integer LEB128-encoded.
 * @param {Buffer} buf Inflated string table.
 * @returns {string[]} Every string in the table, in table order.
 * @throws {Error} If the table does not decode cleanly (a caller must then harvest nothing rather
 *                 than guess — a wrong parse could invent names that are not library symbols).
 */
function parseStringTable(buf) {
    const cursor = { i: 0 };
    const count = readVarint(buf, cursor);
    const strings = [];
    for (let n = 0; n < count; n++) {
        readVarint(buf, cursor); // string id — sequential, not needed
        const len = readVarint(buf, cursor);
        if (cursor.i + len > buf.length) throw new Error(`string table overrun at entry ${n}`);
        strings.push(buf.toString('utf8', cursor.i, cursor.i + len));
        cursor.i += len;
    }
    return strings;
}

/**
 * Harvests the identifier-shaped names from a library archive.
 * @param {Buffer} buf Whole archive.
 * @returns {string[]} Symbol names (original spelling, may contain duplicates).
 * @throws {Error} If the archive or its string table cannot be decoded.
 */
function harvestArchive(buf) {
    const entries = readZipEntries(buf);
    const tables = entries.filter(e => STRING_TABLE_ENTRY.test(e.name));
    const names = [];
    for (const entry of tables) {
        for (const s of parseStringTable(readZipEntryData(buf, entry))) {
            if (IDENTIFIER.test(s)) names.push(s);
        }
    }
    return names;
}

// ---------------------------------------------------------------------------------------------
// Namespace attribution
//
// A harvested name on its own says nothing about *which* library declared it, and the archives do
// not say either: an archive's ZIP entries are `<guid>.object` / `<guid>.meta` plus the auxiliary
// tables — none of them names the library, let alone its namespace. So the namespace is recovered
// from the two places that state it explicitly:
//
//   1. The **.plcproj**, which declares every namespace the project imports alongside the library's
//      title, in up to three spellings:
//
//          <PlaceholderReference Include="System_VisuElems">          <- title (project-side alias)
//            <DefaultResolution>VisuElems, 4.8.0.0 (System)</...>     <- title (vendor-side name)
//            <Namespace>VisuElems</Namespace>                         <- the namespace
//
//      All three are indexed as titles, because which one an archive's *path* echoes varies:
//        _Libraries/beckhoff automation gmbh/tc2_mc2/3.3.72.0/Tc2_MC2.compiled-library-ge33
//            -> file stem "Tc2_MC2"                     matches <Namespace>       -> Tc2_MC2
//        _Libraries/system/recipe management/4.5.0.0/Recipe Management.compiled-library-ge33
//            -> title dir "recipe management"           matches DefaultResolution -> Recipe_Management
//        _Libraries/acme gmbh/acme sensor library tc3/1.1/TwinCAT_V3x_BVS_Sensor_V11.library
//            -> title dir "acme sensor library tc3"  matches DefaultResolution -> Acme_Vision_Sensor
//      (the last one is exactly why the file stem alone is not enough — it echoes nothing).
//
//   2. The **.tmc**, which tags a type with the namespace that owns it, directly:
//          <Type Namespace="Tc2_MC2">ST_AxisStatus</Type>
//          <DataType><Name Namespace="Tc2_Utilities">TIMESTRUCT</Name>…
//
// Matching is exact (after normalization) and never fuzzy: an archive whose path echoes no declared
// title contributes to the flat registry exactly as before and to no namespace. That is not a gap to
// be closed by guessing — the 39 unmapped archives in the sample are *transitive dependencies* the
// project never imports directly (CmpApp, SysFile, VisuElemBase, …), so they genuinely have no
// namespace the user could type. A wrong namespace would put names under a prefix that does not
// resolve them, which is precisely the noise this design exists to avoid.
// ---------------------------------------------------------------------------------------------

// PROJECT_SKIP_DIRS (the `.plcproj`/`.tmc`/signature walk's skip set — ARCHIVE_SKIP_DIRS/SKIP_DIRS
// plus `_libraries`) is imported directly above, by identity, from twincatWorkspace.js — the
// discovery owner. See that module's doc comment for the full rationale (why `_libraries` must be
// excluded here but NOT from SKIP_DIRS, and the measured cost of not excluding it); plcprojRefs.js
// imports the same Set as PLCPROJ_SKIP_DIRS, and test_collect_scope.js pins the two equal.

/**
 * Normalizes a library title for comparison: Structured Text is case-insensitive, and the same
 * library is spelled `Recipe Management` / `recipemanager` / `Recipe_Management` across the .plcproj
 * and the archive path. Stripping everything but [a-z0-9] is what makes those compare equal.
 * @param {string} title Raw title.
 * @returns {string} Normalized key ('' when nothing is left).
 */
function normalizeTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Registers a title → namespace pair. A title claimed by two different namespaces is poisoned
 * (mapped to null) rather than resolved arbitrarily: an archive matching it must stay unattributed.
 * @param {string} title Raw title.
 * @param {string} namespace Namespace, in the .plcproj's spelling.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 */
function addLibraryTitle(title, namespace, index) {
    const key = normalizeTitle(title);
    if (!key) return;
    const reg = ensureLibraryRegistry(index);
    const existing = reg.libraryTitles.get(key);
    if (existing !== undefined && existing !== namespace) {
        reg.libraryTitles.set(key, null); // ambiguous — two libraries answer to this title
        return;
    }
    reg.libraryTitles.set(key, namespace);
}

/**
 * Splits a `<DefaultResolution>` — `Recipe Management, * (System)` — into its three fields.
 * The version is kept **verbatim** (`*`, `newest`, `3.5.1.0`): it is what the .plcproj says, and
 * normalizing it away would hide whether the reference is pinned or resolved.
 * @param {string} text Raw resolution text.
 * @returns {{title: string, version: string, company: string}} Empty strings for absent fields.
 */
function parseDefaultResolution(text) {
    const m = /^\s*([^,]+?)\s*(?:,\s*([^()]*?)\s*)?(?:\(\s*([^)]*?)\s*\)\s*)?$/.exec(String(text || ''));
    if (!m) return { title: String(text || '').trim(), version: '', company: '' };
    return { title: m[1] || '', version: m[2] || '', company: m[3] || '' };
}

/**
 * Splits a pinned reference's `Include` — `Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH` — into its
 * three comma-separated fields. A placeholder's Include carries no commas, so it yields the title
 * alone, which is exactly right: the resolved title/version/company then come from DefaultResolution.
 * @param {string} include Raw Include attribute.
 * @returns {{title: string, version: string, company: string}} Empty strings for absent fields.
 */
function parseIncludeTriple(include) {
    const parts = String(include || '').split(',');
    return {
        title: (parts[0] || '').trim(),
        version: (parts[1] || '').trim(),
        // A company name may itself contain a comma — everything after the version belongs to it.
        company: parts.slice(2).join(',').trim()
    };
}

/**
 * Records one `.plcproj` reference block in the catalog. Keyed on the block's own three strings, so
 * the second index pass over the same project overwrites its own entry rather than adding a twin.
 * @param {'placeholder'|'reference'} kind Which element declared the reference.
 * @param {string} include Raw `Include` attribute.
 * @param {string} resolution Raw `<DefaultResolution>` text ('' when the element has none).
 * @param {string} namespace The declared namespace, in the .plcproj's spelling.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 */
function addCatalogEntry(kind, include, resolution, namespace, index) {
    const fromInclude = parseIncludeTriple(include);
    // DefaultResolution is the vendor's own naming and therefore wins; the Include is the fallback
    // (a pinned LibraryReference has no DefaultResolution at all).
    const resolved = resolution ? parseDefaultResolution(resolution) : { title: '', version: '', company: '' };
    ensureLibraryRegistry(index).libraryCatalog.set(`${kind}|${include}|${namespace}`, {
        include: String(include || '').trim(),
        title: resolved.title || fromInclude.title || namespace,
        version: resolved.version || fromInclude.version || '',
        company: resolved.company || fromInclude.company || '',
        namespace: namespace,
        kind: kind
    });
}

/**
 * True for a compiler-internal library name. TwinCAT/CODESYS reserves the **double-underscore** prefix
 * for auto-generated objects — the backing GVLs behind text lists, enums and the like
 * (`__E_IolPort__GVL`, `__Symbol_Translation__GVL`, `__TL_RecipeManager__GVL`). Nobody references them
 * by hand, so they are hidden from the Libraries **tree**. Display-only: the name stays a declared
 * symbol, so nothing it might appear in is ever flagged.
 * @param {string} name Type name.
 * @returns {boolean}
 */
function isInternalLibraryName(name) {
    return /^__/.test(name);
}

/**
 * The libraries the project references, each with the three spellings that differ in practice — the
 * placeholder/Include name, the resolved library title, and the **namespace** the code must use —
 * plus what we managed to index for it.
 *
 * `symbolCount` and `types` are resolved here rather than at index time because the .plcproj is read
 * *before* the archives and the `.tmc` are harvested. Both are honest about what is actually known: a
 * library with no readable archive and no `.tmc` types reports 0 and `[]` rather than a guess.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {Array<LibraryCatalogEntry & {symbolCount: number, types: LibraryType[]}>} Sorted by
 *          namespace, case-insensitively (Structured Text is case-insensitive).
 */
function getLibraryCatalog(index) {
    const entries = Array.from(libRegistryFor(index).libraryCatalog.values()).map(entry => ({
        include: entry.include,
        title: entry.title,
        version: entry.version,
        company: entry.company,
        namespace: entry.namespace,
        kind: entry.kind,
        symbolCount: getNamespaceSymbols(entry.namespace, index).length,
        // Copied, not shared: the catalog crosses a JSON-RPC boundary, and the registry's own type
        // objects must never be mutable from outside it.
        types: getTypeSystemNamespaceTypes(entry.namespace, index).filter(t => !isInternalLibraryName(t.name)).map(t => ({
            name: t.name,
            kind: t.kind,
            // Only a signature-derived FUNCTION has one; it is what the tree shows as its return type.
            returnType: t.returnType || '',
            extendsType: t.extendsType || '',
            members: (t.members || []).map(m => ({ name: m.name, type: m.type, scope: m.scope })),
            methods: (t.methods || []).map(m => ({
                name: m.name,
                returnType: m.returnType,
                // Absent params (a browsercache method) stay absent — the tree renders those as a bare
                // name, not `()`. A `.tmc` method keeps its real (possibly empty) parameter list.
                params: m.params ? m.params.map(p => ({ name: p.name, type: p.type, scope: p.scope })) : undefined
            })),
            // Property NAMES, from the browsercache (indexBrowserCache). Names only — no accessor types.
            properties: (t.properties || []).map(p => ({ name: p.name }))
        }))
    }));
    entries.sort((a, b) => a.namespace.toLowerCase().localeCompare(b.namespace.toLowerCase()));
    return entries;
}

/**
 * Every project's library catalog, unioned and deduplicated by namespace (case-insensitive: ST is).
 *
 * This is the fallback `custom/libraries` (server.js) reaches for when no specific project's catalog
 * can be resolved — no `fileUri` was sent (the extension host has not been updated to send the active
 * file), or the routed project genuinely references no libraries. The Libraries view is read-only
 * browsing, so a superset is harmless; returning nothing (what happened before this existed) is the
 * actual regression it exists to fix. In a single-project workspace the union IS that project's own
 * catalog, so this restores exactly what `custom/libraries` returned before per-project scoping.
 * @param {Iterable<Object>} indexes Every project's symbol index (e.g. `workspace.indexes.values()`).
 * @returns {Array<LibraryCatalogEntry & {symbolCount: number, types: LibraryType[]}>} First-writer-
 *          wins per namespace, in the order `indexes` iterates; not re-sorted (each project's own
 *          getLibraryCatalog() call already sorted its slice, and a stable merge preserves that).
 */
function getUnionLibraryCatalog(indexes) {
    const seen = new Map(); // namespace (lower-case) -> entry
    for (const index of indexes) {
        for (const entry of getLibraryCatalog(index)) {
            const key = String(entry.namespace || entry.include).toLowerCase();
            if (!seen.has(key)) seen.set(key, entry);
        }
    }
    return Array.from(seen.values());
}

/**
 * Reads the library references of every `.plcproj` under a folder and builds the namespace and
 * title registries the attribution below relies on. Additive and idempotent; never throws.
 * @param {string} rootDir Absolute workspace folder.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {number} Namespaces known after this scan.
 */
function indexLibraryTitles(rootDir, index) {
    const reg = ensureLibraryRegistry(index);
    if (!rootDir || !fs.existsSync(rootDir)) return reg.namespaceNames.size;

    const files = [];
    collectPlcProjFiles(rootDir, files);

    for (const file of files) {
        // Read and parsed once per workspace (plcprojRefs.js): this function alone runs twice per
        // project — indexLibrarySymbols and indexTypeSystem each call it — and libraries.js wanted the
        // same blocks a third time. The records are read-only, so they are shared, not cloned.
        const blocks = readLibraryReferences(file);
        if (!blocks) continue; // unreadable .plcproj: contribute nothing rather than guess
        // Same two reference kinds libraries.js harvests, but the whole block is needed here: the
        // namespace alone cannot be matched against an archive path (see the header above).
        for (const block of blocks) {
            // Only the FIRST <Namespace> of a block, as before: a title maps to one namespace, and a
            // second one in the same block would make the title→namespace pair ambiguous, not richer.
            const namespace = block.namespace;
            if (!namespace) continue;
            reg.namespaceNames.set(namespace.toLowerCase(), namespace);

            // The namespace itself is a title too — most Beckhoff archives are named after it.
            addLibraryTitle(namespace, namespace, index);
            // `Include="Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH"` — the title is the first field.
            if (block.include) addLibraryTitle(block.include.split(',')[0], namespace, index);
            // `<DefaultResolution>Recipe Management, * (System)</DefaultResolution>` — likewise.
            if (block.resolution) addLibraryTitle(block.resolution.split(',')[0], namespace, index);

            // The same three strings, kept whole this time: the "TwinCAT Libraries" view shows the
            // library → namespace mapping, and this block is where all of it is already parsed.
            addCatalogEntry(block.kind, block.include, block.resolution, namespace, index);
        }
    }
    return reg.namespaceNames.size;
}

/**
 * The namespace an archive belongs to, from its path — `…/tc2_mc2/3.3.72.0/Tc2_MC2.compiled-library`
 * is Tc2_MC2's. Both the file stem and the title directory (the parent of the version directory) are
 * tried, since which one carries the library's title varies by vendor.
 * @param {string} filePath Absolute archive path.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string|null} Namespace in the .plcproj's spelling, or null when the path matches no
 *          declared library title (the archive is then a transitive dependency, not an import).
 */
function archiveNamespace(filePath, index) {
    const reg = libRegistryFor(index);
    const stem = path.basename(filePath).replace(LIBRARY_EXT, '');
    const titleDir = path.basename(path.dirname(path.dirname(filePath)));
    for (const candidate of [stem, titleDir]) {
        const ns = reg.libraryTitles.get(normalizeTitle(candidate));
        if (ns) return ns; // null (ambiguous) and undefined (unknown) both fall through
    }
    return null;
}

/**
 * Files a harvested name under a namespace.
 * @param {string} namespace Namespace, any casing.
 * @param {string} name Symbol name, in the library's own spelling.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 */
function addNamespaceSymbol(namespace, name, index) {
    const reg = ensureLibraryRegistry(index);
    const nsKey = String(namespace).toLowerCase();
    let bucket = reg.namespaceSymbols.get(nsKey);
    if (!bucket) {
        bucket = new Map();
        reg.namespaceSymbols.set(nsKey, bucket);
    }
    const key = name.toLowerCase();
    if (!bucket.has(key)) {
        bucket.set(key, name);
        reg.namespaceListCache.delete(nsKey);
    }
}

/**
 * Every symbol of one library namespace, in the library's own spelling.
 * @param {string} namespace Namespace, any casing.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string[]} Symbol names — empty for an unknown or unmapped namespace (never a guess).
 */
function getNamespaceSymbols(namespace, index) {
    if (!namespace) return [];
    const reg = libRegistryFor(index);
    const key = String(namespace).toLowerCase();
    const cached = reg.namespaceListCache.get(key);
    if (cached) return cached;
    const bucket = reg.namespaceSymbols.get(key);
    const list = bucket ? Array.from(bucket.values()) : [];
    reg.namespaceListCache.set(key, list);
    return list;
}

/**
 * The library namespaces the project imports, in the .plcproj's own spelling (`Tc2_MC2`, not
 * `tc2_mc2`). These are the only prefixes getNamespaceSymbols() can answer for.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string[]}
 */
function getLibraryNamespaceNames(index) {
    return Array.from(libRegistryFor(index).namespaceNames.values());
}

/**
 * Namespace-attribution coverage, for the harnesses and for the server's startup log.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {{namespaces: number, mapped: number, symbols: number}} Declared namespaces, how many of
 *          them carry at least one symbol, and how many attributed symbols there are in total.
 */
function getNamespaceCoverage(index) {
    const reg = libRegistryFor(index);
    let symbols = 0;
    reg.namespaceSymbols.forEach(bucket => { symbols += bucket.size; });
    return { namespaces: reg.namespaceNames.size, mapped: reg.namespaceSymbols.size, symbols };
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/**
 * Recursively collects library archives under a directory.
 * @param {string} dirPath Absolute directory path.
 * @param {string[]} out Accumulator, mutated.
 */
function collectArchives(dirPath, out) {
    return walkFiles(dirPath, { skipDirs: SKIP_DIRS, isMatch: (name) => LIBRARY_EXT.test(name), out });
}

/**
 * Scans a workspace folder for library archives and unions their symbol names into the registry.
 * Additive, like indexLibraryNamespaces(): call clearLibrarySymbols() first to rebuild from scratch.
 * Never throws — a library we cannot decode simply contributes nothing (its symbols then stay
 * unknown, which is the pre-existing, conservative behaviour).
 *
 * Each archive is also filed under the namespace its path identifies, when it identifies one (see
 * "Namespace attribution"). An unattributable archive still contributes to the flat registry — the
 * namespace map is an *addition*, never a filter.
 * @param {string} rootDir Absolute folder path.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {{archives: number, failed: number, mapped: number, symbols: number, ms: number}}
 *          Indexing statistics; `mapped` counts the archives attributed to a namespace.
 */
function indexLibrarySymbols(rootDir, index) {
    const started = Date.now();
    const stats = { archives: 0, failed: 0, mapped: 0, symbols: 0, ms: 0 };
    if (!rootDir || !fs.existsSync(rootDir)) return stats;
    const reg = ensureLibraryRegistry(index);

    indexLibraryTitles(rootDir, index); // the .plcproj is what says which namespace an archive belongs to

    const files = [];
    collectArchives(rootDir, files);

    for (const file of files) {
        // The harvest caches stay MODULE GLOBALS, shared across every project's registry — see their
        // declaration above. Only the names they yield are filed per-project, below.
        const names = harvestArchiveFile(file);
        if (!names) {
            stats.failed++;
            continue; // undecodable archive: contribute nothing rather than guess
        }
        stats.archives++;
        const namespace = archiveNamespace(file, index);
        if (namespace) stats.mapped++;
        for (const name of names) {
            const key = name.toLowerCase();
            if (!reg.librarySymbols.has(key)) reg.librarySymbols.set(key, name);
            if (namespace) addNamespaceSymbol(namespace, name, index);
        }
    }

    stats.symbols = reg.librarySymbols.size;
    stats.ms = Date.now() - started;
    return stats;
}

// ---------------------------------------------------------------------------------------------
// Type-system structure (the `.tmc`)
//
// The archives yield names and nothing else. The `.tmc` yields *structure*, and it is right there in
// plain XML — a `<DataType>` block states the type's members and their types:
//
//     <DataType><Name Namespace="Tc2_MC2">ST_AxisStatus</Name>
//       <SubItem><Name>MotionState</Name><Type Namespace="Tc2_MC2">MC_AxisStates</Type>…</SubItem>
//     …
//     <DataType><Name>E_EthercatDeviceState</Name>
//       <EnumInfo><Text>INIT</Text><Enum>1</Enum></EnumInfo>…
//
// so `stAxis.▮` can complete with real fields instead of nothing.
//
// **What this must never become is a source of diagnostics.** The `.tmc` covers only the types the
// project *uses*, holds `<DataType>` blocks only (no constants, no functions), and its member list
// for a given type is not guaranteed complete. A library node therefore carries
// `membersComplete: false`, and types.js honours that: a member it cannot find on such a type is
// "uncertain", never "absent". Completion may use the members freely — a missing suggestion is
// harmless; a fabricated diagnostic on correct code is not.
// ---------------------------------------------------------------------------------------------

/**
 * One member of a `<DataType>`: `<SubItem><Name>X</Name><Type …>T</Type>[<ArrayInfo>…]…</SubItem>`.
 *
 * Anchoring Name directly on the SubItem open tag, and Type directly on Name, is what keeps the
 * *nested* SubItems of a `<Default>` value list (`<SubItem><Name>[1]</Name><Value>0</Value>`) out:
 * they carry no `<Type>`, so they cannot match. Verified on the sample's 10,657 SubItems — zero
 * non-identifier member names are captured.
 */
const TMC_SUBITEM = /<SubItem>\s*<Name>([^<]+)<\/Name>\s*<Type([^>]*)>([^<]*)<\/Type>((?:\s*<ArrayInfo>[\s\S]*?<\/ArrayInfo>)*)([\s\S]*?)<\/SubItem>/g;

/** One dimension of an array member. Multi-dimensional members repeat the block. */
const TMC_ARRAY_DIM = /<LBound>(-?\d+)<\/LBound>\s*<Elements>(\d+)<\/Elements>/g;

/** A member's `ItemType` property — present on FB call parameters, absent on struct fields. */
const TMC_ITEM_TYPE = /<Name>ItemType<\/Name>\s*<Value>([^<]+)<\/Value>/;

/** An enum member: `<EnumInfo><Text>OP</Text><Enum>8</Enum></EnumInfo>`. */
const TMC_ENUM_TEXT = /<EnumInfo>\s*<Text>([^<]*)<\/Text>/g;

/**
 * A method of a function block or interface. `<Method>` blocks do not nest, so a non-greedy body is
 * exact:
 *
 *     <Method><Name>Halt</Name><ReturnType>BOOL</ReturnType><ReturnBitSize>8</ReturnBitSize>
 *       <Parameter><Name>fDeceleration</Name><Type>LREAL</Type><BitSize>64</BitSize></Parameter>
 *       <Parameter><Name>bDone</Name><Type>BOOL</Type><BitSize>8</BitSize>
 *         <Properties><Property><Name>ItemType</Name><Value>Output</Value></Property></Properties>
 *       </Parameter>
 *     </Method>
 */
const TMC_METHOD = /<Method>\s*<Name[^>]*>([^<]+)<\/Name>([\s\S]*?)<\/Method>/g;

/** A method's parameter. Shaped like a SubItem, and it carries the same optional `ItemType`. */
const TMC_PARAM = /<Parameter>\s*<Name[^>]*>([^<]+)<\/Name>\s*<Type([^>]*)>([^<]*)<\/Type>((?:\s*<ArrayInfo>[\s\S]*?<\/ArrayInfo>)*)([\s\S]*?)<\/Parameter>/g;

/** A method's return type. Absent on a method that returns nothing. */
const TMC_RETURN_TYPE = /<ReturnType[^>]*>([^<]*)<\/ReturnType>/;

/** `<ExtendsType>FB_JsonDomParserBase</ExtendsType>` — the base a type inherits its members from. */
const TMC_EXTENDS = /<ExtendsType>([^<]+)<\/ExtendsType>/;

/** `ItemType` value → the VAR scope it means (types.js/features.js speak the ST spelling). */
const ITEM_TYPE_SCOPE = { input: 'VAR_INPUT', output: 'VAR_OUTPUT', inout: 'VAR_IN_OUT' };

/**
 * Rebuilds a member's Structured Text declaration type from its `.tmc` shape.
 * `PointerTo="1"` / `ReferenceTo="true"` become the ST wrappers; `<ArrayInfo>` becomes `ARRAY [..] OF`.
 * The type name is kept *bare* (unqualified): parseTypeString resolves a bare name against the index,
 * which is where the library node for it lives.
 * @param {string} attrs Raw attribute text of the member's `<Type>` tag.
 * @param {string} typeText Text content of the `<Type>` tag.
 * @param {string} arrayInfo The member's `<ArrayInfo>` blocks, concatenated ('' when scalar).
 * @returns {string} Declaration type string ('' when the `.tmc` names no type).
 */
function tmcMemberType(attrs, typeText, arrayInfo) {
    let t = String(typeText || '').trim();
    if (!t) return '';
    if (/\bPointerTo\s*=\s*"(?:1|true)"/i.test(attrs)) t = 'POINTER TO ' + t;
    else if (/\bReferenceTo\s*=\s*"(?:1|true)"/i.test(attrs)) t = 'REFERENCE TO ' + t;

    if (arrayInfo) {
        const dims = [];
        TMC_ARRAY_DIM.lastIndex = 0;
        let dim;
        while ((dim = TMC_ARRAY_DIM.exec(arrayInfo)) !== null) {
            const lower = parseInt(dim[1], 10);
            const count = parseInt(dim[2], 10);
            dims.push(`${lower}..${lower + count - 1}`);
        }
        if (dims.length) t = `ARRAY [${dims.join(', ')}] OF ${t}`;
    }
    return t;
}

/**
 * Parses the `<Method>` blocks of a `<DataType>` — the methods of a library function block or
 * interface, with their parameters and return type.
 *
 * These are the symbols this project spent a long time concluding were unobtainable. They were in
 * the `.tmc` the whole time; this function simply never looked. A method's parameters are shaped
 * exactly like a struct's SubItems and carry the same optional `ItemType` property, with one
 * difference that matters: an unmarked *parameter* is an input (an unmarked SubItem is a plain
 * field), which is why the scope defaults to VAR_INPUT here and to '' there.
 *
 * The list is complete **per type**, but the `.tmc` exports only the types the project uses and
 * carries no ACTIONs at all (`AXIS_REF.ReadStatus` is an action, not a method). So this must feed
 * completion and never a diagnostic — see makeLibraryNode's `membersComplete: false`.
 * @param {string} block Raw `<DataType>…</DataType>` XML.
 * @returns {LibraryMethod[]} Methods, in declaration order ([] when the type declares none).
 */
function parseTmcMethods(block) {
    const methods = [];

    TMC_METHOD.lastIndex = 0;
    let m;
    while ((m = TMC_METHOD.exec(block)) !== null) {
        const methodName = m[1].trim();
        if (!IDENTIFIER.test(methodName)) continue;
        const body = m[2] || '';

        const params = [];
        TMC_PARAM.lastIndex = 0;
        let p;
        while ((p = TMC_PARAM.exec(body)) !== null) {
            const paramName = p[1].trim();
            if (!IDENTIFIER.test(paramName)) continue;
            const itemType = TMC_ITEM_TYPE.exec(p[5] || '');
            const scope = itemType
                ? (ITEM_TYPE_SCOPE[itemType[1].trim().toLowerCase()] || 'VAR_INPUT')
                : 'VAR_INPUT';
            params.push({ name: paramName, type: tmcMemberType(p[2], p[3], p[4]), scope });
        }

        const ret = TMC_RETURN_TYPE.exec(body);
        methods.push({
            name: methodName,
            returnType: ret ? ret[1].trim() : '',
            params
        });
    }
    return methods;
}

/**
 * Parses one `<DataType>` block into a LibraryType.
 *
 * The kind falls out of what the block carries: `<EnumInfo>`s make it an enum; `<SubItem>`s make it a
 * struct, or an **fb** when a member declares an `ItemType` (Input/Output/InOut) — only a function
 * block has call parameters. `<Method>`s make it an fb too, which is what lets an *interface* (all
 * methods, no fields) resolve to a concrete kind rather than to the anonymous unknown. A block with
 * none of those (an alias, a subrange, an opaque handle) is 'opaque': it has no members we could
 * offer, and types.js keeps such a node at the anonymous `unknown` type.
 *
 * Note the kind only controls what we can *offer*; it never licenses a diagnostic. The node stays
 * `external` with `membersComplete: false`, so a member it does not find is "uncertain", not
 * "absent" — see makeLibraryNode.
 * @param {string} block Raw `<DataType>…</DataType>` XML.
 * @param {Object} [index] The project's symbol index, for namespace attribution. Omit for the
 *   default registry (the harness's usual case — the block still parses, just with `namespace: ''`).
 * @returns {LibraryType|null} null when the block names no identifier-shaped type.
 */
function parseTmcDataType(block, index) {
    // Only the *first* Name in a block is the type's own name; SubItem/Property children carry theirs.
    const nameMatch = block.match(/<Name([^>]*)>([^<]+)<\/Name>/);
    if (!nameMatch) return null;
    const name = nameMatch[2].trim();
    if (!IDENTIFIER.test(name)) return null;   // skips e.g. "INT (2..100)" subrange entries

    const members = [];
    let hasCallParams = false;

    TMC_SUBITEM.lastIndex = 0;
    let sub;
    while ((sub = TMC_SUBITEM.exec(block)) !== null) {
        const memberName = sub[1].trim();
        if (!IDENTIFIER.test(memberName)) continue;
        const itemType = TMC_ITEM_TYPE.exec(sub[5] || '');
        const scope = itemType ? (ITEM_TYPE_SCOPE[itemType[1].trim().toLowerCase()] || '') : '';
        if (scope) hasCallParams = true;
        members.push({ name: memberName, type: tmcMemberType(sub[2], sub[3], sub[4]), scope });
    }

    TMC_ENUM_TEXT.lastIndex = 0;
    let en;
    const enumMembers = [];
    while ((en = TMC_ENUM_TEXT.exec(block)) !== null) {
        const text = en[1].trim();
        // 'Enum' / 'ENUM' mirror how parser.js and xmlIndexer.js mark a project enum's members, so
        // isEnumNode-style checks and the completion detail read the same for both.
        if (IDENTIFIER.test(text)) enumMembers.push({ name: text, type: 'Enum', scope: 'ENUM' });
    }

    const methods = parseTmcMethods(block);

    /** @type {'struct'|'fb'|'enum'|'opaque'|'function'} */
    let kind = 'opaque';
    if (enumMembers.length) kind = 'enum';
    else if (methods.length) kind = 'fb';
    else if (members.length) kind = hasCallParams ? 'fb' : 'struct';

    // The base whose members this type inherits. Carried through to the node's `extends`, where the
    // existing chain walks (types.js lookupMember, features.js walkExtendsChain) pick it up — that is
    // what makes `FB_JsonDomParser.GetString()`, declared on the FB_JsonDomParserBase it extends,
    // resolvable at all.
    const ext = TMC_EXTENDS.exec(block);
    const extendsType = ext && IDENTIFIER.test(ext[1].trim()) ? ext[1].trim() : '';

    return {
        name,
        kind,
        namespace: declaredNamespace(nameMatch[1], index) || '',
        members: kind === 'enum' ? enumMembers : (kind === 'opaque' ? [] : members),
        methods,
        extendsType
    };
}

/**
 * Harvests type names — and their structure — from the project's TwinCAT type system (`.tmc`, a
 * TcModuleClass export).
 *
 * Why this exists: the library archives are not a complete source of truth. Some types a project
 * uses are reachable from no readable archive at all —
 *   - `.compiled-library-v3` archives are an opaque, non-ZIP format (magic `10 a6 d5 a7`) we cannot
 *     decode, and some libraries ship *only* in that form;
 *   - some symbols are not in a library's string table (e.g. `CANQUEUE` sits in a
 *     `precompileinfo.auxiliary` entry, not `__shared_data_storage_string_table__`);
 *   - `E_EthercatDeviceState` appears in no readable library byte whatsoever.
 *
 * TwinCAT, however, exports every data type the project actually resolves into the `.tmc`, which is
 * plain XML. Harvesting `<DataType>` from it closes exactly those gaps (357 types in the sample, incl.
 * all of the above). Names are merged into the same registry as archive symbols, so they inherit the
 * same on-demand node registration and its performance guarantee; the members they carry are what
 * gives `stAxis.▮` real fields (see "Type-system structure" above).
 *
 * The `.tmc` is also the *second* namespace source: it tags a type with the namespace that owns it
 * (`<Type Namespace="Tc2_MC2">ST_AxisStatus</Type>`), which reaches types no readable archive holds.
 * @param {string} rootDir Workspace folder to scan.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {{files: number, symbols: number, attributed: number, types: number, structured: number,
 *            ms: number}} Indexing statistics; `attributed` counts the type names the `.tmc` assigned
 *          to a library namespace, `types` the `<DataType>` blocks parsed and `structured` those of
 *          them that carry members (struct / fb / enum).
 */
function indexTypeSystem(rootDir, index) {
    const started = Date.now();
    const stats = { files: 0, symbols: 0, attributed: 0, types: 0, structured: 0, ms: 0 };
    if (!rootDir || !fs.existsSync(rootDir)) return stats;
    const reg = ensureLibraryRegistry(index);

    indexLibraryTitles(rootDir, index); // establishes which namespaces the project actually imports

    const files = [];
    collectTmcFiles(rootDir, files);

    for (const file of files) {
        let xml;
        try {
            xml = fs.readFileSync(file, 'utf8');
        } catch (e) {
            // `debug`: the `.tmc` is a build artifact that a build can be rewriting underneath us.
            // Worth having when struct fields or FB methods have gone missing (this file is their only
            // source), not worth interrupting a healthy session for.
            log.debug('tmc-unreadable', { file, error: e });
            continue; // unreadable: contribute nothing rather than guess
        }
        stats.files++;
        const blocks = xml.match(/<DataType>[\s\S]*?<\/DataType>/g) || [];
        for (const block of blocks) {
            const type = parseTmcDataType(block, index);
            if (!type) continue;
            stats.types++;
            const key = type.name.toLowerCase();
            if (!reg.librarySymbols.has(key)) reg.librarySymbols.set(key, type.name);
            // First definition wins: re-indexing must not flip a type's shape under a live index.
            if (!reg.typeSystemTypes.has(key)) {
                reg.typeSystemTypes.set(key, type);
                if (type.kind !== 'opaque') stats.structured++;
                if (type.namespace) {
                    const nsKey = type.namespace.toLowerCase();
                    if (!reg.typeSystemNamespaces.has(nsKey)) reg.typeSystemNamespaces.set(nsKey, []);
                    reg.typeSystemNamespaces.get(nsKey).push(type);
                }
            }
            if (type.namespace) {
                addNamespaceSymbol(type.namespace, type.name, index);
                stats.attributed++;
            }
        }
        // A type *reference* carries the same tag — and reaches types that have no <DataType> block
        // of their own. Attribution only; the name is NOT added to the flat registry, so what the
        // undeclared-identifier check sees is byte-for-byte what it saw before.
        const typeRefRegex = /<Type\b([^>]*)>([^<]+)<\/Type>/g;
        let ref;
        while ((ref = typeRefRegex.exec(xml)) !== null) {
            const name = ref[2].trim();
            if (!IDENTIFIER.test(name)) continue;
            if (attributeTmcType(ref[1], name, index)) stats.attributed++;
        }
    }

    stats.symbols = reg.librarySymbols.size;
    stats.ms = Date.now() - started;
    return stats;
}

/**
 * The namespace a `Namespace="…"` attribute names, but only when the project imports it *directly*.
 *
 * A dotted value (`Recipe_Management.Stu.SysTimeRtc.SysTimeCore`) is the access path through a chain
 * of library dependencies, and is deliberately rejected: the type is reachable at the end of that
 * path, not under its head, so filing it under `Recipe_Management` would offer a name that
 * `Recipe_Management.` does not actually resolve. A namespace the .plcproj never declares (TwinCAT's
 * internal `MC`, `IO`) is rejected for the same reason — it is not a prefix the user can type.
 * Rejected either way, the name simply stays in the flat, unqualified registry.
 * @param {string} attrs Raw attribute text of a `<Name>` / `<Type>` tag.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string|null} The namespace in the .plcproj's own spelling, or null.
 */
function declaredNamespace(attrs, index) {
    const ns = /\bNamespace\s*=\s*"([^"]+)"/.exec(attrs || '');
    if (!ns) return null;
    const namespace = ns[1].trim();
    if (!namespace || namespace.includes('.')) return null;
    return libRegistryFor(index).namespaceNames.get(namespace.toLowerCase()) || null;
}

/**
 * Files a `.tmc` type under the namespace its `Namespace="…"` attribute names.
 * @param {string} attrs Raw attribute text of the `<Name>` / `<Type>` tag.
 * @param {string} name The type name.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {boolean} True when the type was attributed.
 */
function attributeTmcType(attrs, name, index) {
    const declared = declaredNamespace(attrs, index);
    if (!declared) return false;
    addNamespaceSymbol(declared, name, index);
    return true;
}

/**
 * The `.tmc`'s structural description of a library type, when it has one.
 * @param {string} name Type name, any casing.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {LibraryType|undefined} undefined when the `.tmc` does not know the type — the caller must
 *          then treat it as a bare name with no members (which is what it was before this existed).
 */
function getLibraryType(name, index) {
    if (!name) return undefined;
    return libRegistryFor(index).typeSystemTypes.get(String(name).toLowerCase());
}

/**
 * A node for a library type, built on the spot and NOT registered in the workspace index.
 *
 * That is the whole point: registering library nodes is what has to stay proportional to what the
 * document names — putting all ~32k in took the diagnostics pass from 1.5 s to 78 s, because
 * `Object.keys()` on the index runs per identifier. A transient node lets a completion follow a
 * member chain (`fbAxisRef.NcToPlc.▮`) into types the document never spells, at the cost of one
 * map lookup and no growth in the index at all.
 *
 * Completion-only by construction: nothing that could reach a diagnostic ever sees this node, and
 * it carries `membersComplete: false` like every library node, so a miss stays "uncertain".
 * @param {string} name Type name, unqualified, any casing.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {Object|null} A library node, or null when the `.tmc` does not describe that type.
 */
function getLibraryTypeNode(name, index) {
    if (!name) return null;
    const info = libRegistryFor(index).typeSystemTypes.get(String(name).toLowerCase());
    if (!info) return null;
    return makeLibraryNode(info.name || name, info);
}

/**
 * The `.tmc`'s top-level types for one library namespace — the subset of getNamespaceSymbols() that
 * is known to be a *type* rather than a name the string table happened to serialize.
 * @param {string} namespace Namespace, any casing.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {LibraryType[]} Empty for a namespace the `.tmc` says nothing about (never a guess).
 */
function getTypeSystemNamespaceTypes(namespace, index) {
    if (!namespace) return [];
    return libRegistryFor(index).typeSystemNamespaces.get(String(namespace).toLowerCase()) || [];
}

/**
 * The browsercache's view of a namespace's top-level types — every FB and interface the library
 * declares, including those the project does not use (which the `.tmc` therefore never mentions).
 * Names only: parameters and fields live in the opaque binary `.object` entries, so the `.tmc`
 * still wins wherever both describe a type.
 * @param {string} namespace Library namespace.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {Map<string, {name: string, kind: string}>} Keyed by lower-case name; empty when unknown.
 */
function getBrowserCacheNamespaceTypes(namespace, index) {
    if (!namespace) return new Map();
    return libRegistryFor(index).browserCacheNamespaceTypes.get(String(namespace).toLowerCase()) || new Map();
}

/**
 * True when a name appears in this namespace ONLY as a method or property of some type — an
 * ACTION or accessor the string table lists flatly beside real types. `Tc2_MC2.ActStop` is not
 * something a user can write, so it ranks last rather than being dropped: the browsercache covers
 * only libraries installed on this machine, and a wrong drop hides a real type.
 * @param {string} namespace Library namespace.
 * @param {string} name Candidate symbol name.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {boolean}
 */
function isBrowserCacheMemberName(namespace, name, index) {
    if (!namespace || !name) return false;
    const set = libRegistryFor(index).browserCacheNamespaceMembers.get(String(namespace).toLowerCase());
    return !!set && set.has(String(name).toLowerCase());
}

/**
 * Collects `.tmc` type-system exports under a workspace folder. Skips `_Libraries` (PROJECT_SKIP_DIRS):
 * the `.tmc` is a build output of the *project*, never something a vendor ships in an archive tree.
 * @param {string} dir Directory to scan.
 * @param {string[]} out Accumulator, mutated.
 */
function collectTmcFiles(dir, out) {
    // Regular files only — walkFiles' isFile gate deliberately excludes directory/symlink decoys
    // the old inline walk admitted (see test_twincat_workspace.js's "regular FILES only" check).
    // Cost accepted with the tightening: a LEGITIMATE symlink to a real dump is dropped too — if
    // that ever bites, it presents as resurrected library false positives.
    return walkFiles(dir, { skipDirs: PROJECT_SKIP_DIRS, isMatch: (name) => /\.tmc$/i.test(name), out });
}

// ---------------------------------------------------------------------------------------------
// Library signatures (ProduceAllLibrarySignatures)
//
// The `.tmc` only exports the types the project already *uses*. A generator (scripts/
// generate-library-signatures.ps1) runs TwinCAT's `ITcPlcLibraryManager2.ProduceAllLibrarySignatures()`
// on a machine that has TwinCAT and drops the result as `library-signatures.xml` in the workspace.
// That dump covers EVERY referenced library and adds three things the `.tmc` never carries:
//   - function parameter/return signatures,
//   - function-block input/output signatures (for FBs the project has not adopted yet),
//   - global-constant names.
// It does NOT carry struct fields, enum values or FB methods, so it *complements* the `.tmc` rather
// than replacing it — the merge below lets the `.tmc` win wherever it already has members. Because
// every node it produces is still `external: true`, none of it is ever diagnostic-validated; it can
// only add completions and silence undeclared-identifier reports (see makeLibraryNode / typeFromNode).
// ---------------------------------------------------------------------------------------------

/**
 * Files (or upgrades) a signature-derived type in the namespace list, mirroring the first-definition
 * push in indexTypeSystem but tolerating an in-place upgrade: an opaque `.tmc`/signature entry already
 * pushed under this key is replaced rather than duplicated. No dup can accumulate for a given name.
 * @param {LibraryType} record The type record to file.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 */
function pushNamespaceType(record, index) {
    if (!record.namespace) return;
    const typeSystemNamespaces = ensureLibraryRegistry(index).typeSystemNamespaces;
    const nsKey = record.namespace.toLowerCase();
    if (!typeSystemNamespaces.has(nsKey)) typeSystemNamespaces.set(nsKey, []);
    const bucket = typeSystemNamespaces.get(nsKey);
    const key = record.name.toLowerCase();
    const idx = bucket.findIndex(t => t.name.toLowerCase() === key);
    if (idx === -1) bucket.push(record);
    else bucket[idx] = record;
}

/**
 * Translates the library *title* the signatures XML names a library by into the *namespace* you
 * actually type in ST.
 *
 * This is load-bearing, and getting it wrong silently empties the Libraries view. `ProduceAllLibrary-
 * Signatures` emits `<LibraryName>` = the library's TITLE ("TwinCat Dynamic Collections"), while every
 * other index in the toolkit — the tree view, namespace-dotted completion — keys on the NAMESPACE
 * ("TcDynCollections"). For most libraries the two are different strings, and a title is not even a
 * legal identifier (it has spaces). The `.plcproj` is the only place that maps one to the other, and
 * `indexLibraryTitles()` has already put both into `libraryCatalog`, so resolve through it.
 *
 * Returns '' for a library the `.plcproj` does not reference: the dump also carries transitive CODESYS
 * components ("CmpLog", "Data Server Interfaces") that have no namespace a user could ever type. Their
 * types are still registered by name — they are simply not attributed to a namespace, exactly as an
 * unattributed `.tmc` type is. Attributing them under their title would pollute the namespace index
 * with keys nobody can reference.
 * @param {string} title The signatures XML's `<LibraryName>`.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string} The ST namespace, or '' when the workspace does not reference this library.
 */
function namespaceForLibraryTitle(title, index) {
    if (!title) return '';
    // libraryTitles already maps every spelling the .plcproj offers (the Include, the
    // DefaultResolution, and the namespace itself) onto the namespace, normalized. A `null` value
    // means two libraries answer to this title — ambiguous, so attribute to neither.
    const ns = libRegistryFor(index).libraryTitles.get(normalizeTitle(title));
    return ns || '';
}

/**
 * Merges one dump's already-parsed signature records into THIS project's type registry.
 *
 * Split out from the XML entry point below because the parse is workspace-wide (the same dump is read
 * for every project) while the merge is per-project by nature: it rewrites each record's namespace to
 * the one *this* `.plcproj` imports the library under. Measured on the real 4 dumps (8.15 MB): parse
 * 68 ms, merge 13 ms — so the parse is what parseCache.js caches, and this still runs per project.
 *
 * **`records` must be this project's own to mutate** — `signatureRecordsFor` guarantees that by
 * construction: every call returns a private copy, and there is no way to reach the cached template
 * directly. The loop below reassigns `record.namespace` and then stores that same object in the
 * registry, where indexBrowserCache later pushes methods and properties onto it; a shared record
 * would carry project A's namespace and members into project B.
 *
 * The merge rule is "the `.tmc` (or any richer entry) wins": a `typeSystemTypes` key that already
 * carries members (kind !== 'opaque') is left untouched, because signatures have nothing to add to it
 * (no struct fields, no enum values, no methods). A key that is absent is inserted; a key that is
 * present only as an *opaque* placeholder is upgraded when the signature actually carries members or a
 * return type — the opaque entry had nothing to lose.
 *
 * NB: `libraryCatalog` must already be populated (indexLibraryTitles) or nothing can be attributed to a
 * namespace — see namespaceForLibraryTitle. server.js indexLibraries() guarantees that ordering.
 * @param {import('./parseCache').SignatureRecords} records Records owned by this call.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {{functions: number, functionBlocks: number, types: number, added: number}}
 *          Parsed counts and how many registry types these records inserted or upgraded.
 */
function mergeSignatureRecords(records, index) {
    const stats = {
        functions: records.functions,
        functionBlocks: records.functionBlocks,
        types: records.types.length,
        added: 0
    };
    const reg = ensureLibraryRegistry(index);

    for (const record of records.types) {
        // toRegistryTypes can only fill `namespace` with the library's TITLE — that is all the XML
        // carries. Translate it to the real ST namespace before anything is attributed, or the types
        // land under a key ("TwinCat Dynamic Collections") that nothing ever looks up and the Libraries
        // view shows an empty library.
        record.namespace = namespaceForLibraryTitle(record.namespace, index);

        const key = record.name.toLowerCase();
        const existing = reg.typeSystemTypes.get(key);
        const hasContent = (record.members && record.members.length > 0) || !!record.returnType;

        if (!existing) {
            // Unknown to the `.tmc` — the signature is the only structure we have. Insert it.
            reg.typeSystemTypes.set(key, record);
            if (record.namespace) {
                pushNamespaceType(record, index);
                addNamespaceSymbol(record.namespace, record.name, index);
            }
            stats.added++;
        } else if (existing.kind === 'opaque' && hasContent) {
            // The `.tmc` (or an earlier signature) knew only the bare name — the signature is richer.
            reg.typeSystemTypes.set(key, record);
            if (record.namespace) {
                pushNamespaceType(record, index);
                addNamespaceSymbol(record.namespace, record.name, index);
            }
            stats.added++;
        }
        // else: an entry with real members already owns this key — leave it untouched (`.tmc` wins).

        // The bare name is a library symbol regardless of the merge outcome above.
        if (!reg.librarySymbols.has(key)) reg.librarySymbols.set(key, record.name);
    }

    // Global var-list names and their constants are symbols, not types (no members to model).
    for (const name of records.symbols) {
        const key = name.toLowerCase();
        if (!reg.librarySymbols.has(key)) reg.librarySymbols.set(key, name);
    }

    return stats;
}

/**
 * Merges one ProduceAllLibrarySignatures XML **string** into the workspace type registry.
 *
 * Kept as the module's string entry point because two harnesses (test_library_signatures_merge.js,
 * test_multi_project_scope.js) drive the merge from a literal without writing a file. It is
 * parse-then-merge over the shared mergeSignatureRecords, so the string path and the cached file path
 * can never drift apart. No clone: the records were parsed for this call alone.
 * @param {string} xml Raw ProduceAllLibrarySignatures XML.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {{functions: number, functionBlocks: number, types: number, added: number}}
 *          Parsed counts and how many registry types this XML inserted or upgraded.
 */
function indexLibrarySignaturesFromXml(xml, index) {
    return mergeSignatureRecords(parseSignatureRecords(xml), index);
}

/**
 * Collects `library-signatures.xml` dumps under a workspace folder. Matched by exact (case-insensitive)
 * basename so an unrelated file is never mistaken for a signatures dump. Skips `_Libraries`
 * (PROJECT_SKIP_DIRS): the dump is written to the workspace root by `twincat.updateLibraryDefinitions`,
 * never vendored inside an archive tree.
 * @param {string} dir Directory to scan.
 * @param {string[]} out Accumulator, mutated.
 */
function collectSignatureFiles(dir, out) {
    // Regular files only — walkFiles' isFile gate deliberately excludes directory/symlink decoys
    // the old inline walk admitted (see test_twincat_workspace.js's "regular FILES only" check).
    // Cost accepted with the tightening: a LEGITIMATE symlink to a real dump is dropped too — if
    // that ever bites, it presents as resurrected library false positives.
    return walkFiles(dir, {
        skipDirs: PROJECT_SKIP_DIRS,
        isMatch: (name) => name.toLowerCase() === 'library-signatures.xml',
        out
    });
}

/**
 * Scans a workspace folder for `library-signatures.xml` dumps and merges each into the registry.
 * A no-op — zeroed stats, no registry change — when no such file exists, so a project without a
 * generated dump (like the sample) is entirely unaffected and the diagnostics baseline stays put.
 * Additive and idempotent (first-definition-wins, guarded name inserts); clearLibrarySymbols() resets
 * everything it touches, so a reindex re-merges cleanly.
 * @param {string} rootDir Absolute workspace folder.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {{files: number, functions: number, functionBlocks: number, types: number, added: number,
 *            ms: number}} Indexing statistics.
 */
function indexLibrarySignatures(rootDir, index) {
    const started = Date.now();
    const stats = { files: 0, functions: 0, functionBlocks: 0, types: 0, added: 0, ms: 0 };
    if (!rootDir || !fs.existsSync(rootDir)) return stats;

    const files = [];
    collectSignatureFiles(rootDir, files);

    for (const file of files) {
        // Parsed once per workspace, merged once per project: the same dump is reached by every
        // project's scan (and by every workspace root), and re-parsing 8 MB of XML for each of them
        // was 1.7 s of a startup. signatureRecordsFor hands back a private copy every time, so the
        // copy happens inside the entry point rather than at each call site.
        const records = signatureRecordsFor(file);
        if (!records) continue; // unreadable dump: contribute nothing rather than guess
        stats.files++;
        const one = mergeSignatureRecords(records, index);
        stats.functions += one.functions;
        stats.functionBlocks += one.functionBlocks;
        stats.types += one.types;
        stats.added += one.added;
    }

    stats.ms = Date.now() - started;
    return stats;
}

/**
 * Enriches library FUNCTION_BLOCK and INTERFACE types with their METHOD and PROPERTY names, read from
 * TwinCAT's per-library browsercache (browserCache.js). This is the only offline source for the members
 * of a library type the project has not adopted: the signatures carry FB I/O but no methods, and the
 * `.tmc` describes only used types. **Names only** — the browsercache has no parameters or return types,
 * so a method the `.tmc` already described (with its parameters) is left untouched and only browsercache-
 * only methods are added, as bare names. Purely additive; every enriched node stays `external: true`, so
 * nothing here can license a diagnostic.
 *
 * Must run AFTER indexLibrarySignatures: it enriches types already filed under a namespace (the tree only
 * shows those) and never introduces new ones. Mutates the registry's own type objects in place, which
 * getLibraryCatalog then copies across the JSON-RPC boundary.
 * @param {string} rootDir Absolute workspace folder — its `.plcproj` library references (already in
 *        libraryCatalog) decide which browsercaches are read.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {{libraries: number, types: number, methods: number, properties: number, ms: number}}
 */
function indexBrowserCache(rootDir, index) {
    const started = Date.now();
    const stats = { libraries: 0, types: 0, methods: 0, properties: 0, ms: 0 };
    if (!rootDir || !fs.existsSync(rootDir)) { stats.ms = Date.now() - started; return stats; }
    const reg = ensureLibraryRegistry(index);

    for (const entry of reg.libraryCatalog.values()) {
        if (!entry.namespace) continue;
        // The .plcproj gives a library three spellings; any may be its Managed Libraries folder name.
        const bcFile = findBrowserCacheFile(entry.company, [entry.title, entry.include, entry.namespace]);
        if (!bcFile) continue;
        // Cached across projects, and NOT cloned: everything this function keeps out of `parsed` is
        // freshly constructed, so nothing it stores can alias the shared document (parseCache.js).
        const parsed = readBrowserCacheDoc(bcFile);
        if (!parsed || parsed.size === 0) continue;

        // Record the library's SHAPE before the `.tmc` gate below. This has to happen first: that
        // gate skips a library the `.tmc` says nothing about, and it is exactly those libraries —
        // the ones the project has not adopted yet — whose types a user is most likely hunting for
        // at `Namespace.▮`. On Tc2_MC2 the string table offers 2,269 undifferentiated names; the
        // browsercache names 128 of them as real FBs/interfaces where the `.tmc` names ~57.
        const nsKey = String(entry.namespace).toLowerCase();
        let topLevel = reg.browserCacheNamespaceTypes.get(nsKey);
        if (!topLevel) { topLevel = new Map(); reg.browserCacheNamespaceTypes.set(nsKey, topLevel); }
        let memberNames = reg.browserCacheNamespaceMembers.get(nsKey);
        if (!memberNames) { memberNames = new Set(); reg.browserCacheNamespaceMembers.set(nsKey, memberNames); }
        for (const bcType of parsed.values()) {
            topLevel.set(bcType.name.toLowerCase(), { name: bcType.name, kind: bcType.kind });
            for (const m of bcType.methods || []) memberNames.add(String(m).toLowerCase());
            for (const p of bcType.properties || []) memberNames.add(String(p).toLowerCase());
        }
        // A name that is also a type in its own right is NOT member-only — ActStop is a member,
        // MC_Power is both listed and declared. Resolve the overlap in favour of the type.
        for (const key of topLevel.keys()) memberNames.delete(key);

        const nsTypes = getTypeSystemNamespaceTypes(entry.namespace, index);
        if (nsTypes.length === 0) continue;
        const byName = new Map(nsTypes.map(t => [t.name.toLowerCase(), t]));

        let touched = false;
        for (const [key, bcType] of parsed) {
            const target = byName.get(key);
            if (!target) continue;   // only enrich a type the signatures / `.tmc` already surfaced

            // Methods: keep the `.tmc`'s (they carry parameters); add the browsercache-only names.
            if (!target.methods) target.methods = [];
            const haveM = new Set(target.methods.map(m => m.name.toLowerCase()));
            for (const name of bcType.methods) {
                if (haveM.has(name.toLowerCase())) continue;
                // No `params` key: parameters are unknown (not empty), which the tree shows as a bare
                // name rather than a misleading `()`.
                target.methods.push({ name });
                stats.methods++;
            }
            // Properties: the browsercache is the source; names only, so no accessor types.
            if (!target.properties) target.properties = [];
            const haveP = new Set(target.properties.map(p => p.name.toLowerCase()));
            for (const name of bcType.properties) {
                if (haveP.has(name.toLowerCase())) continue;
                target.properties.push({ name });
                stats.properties++;
            }
            stats.types++;
            touched = true;
        }
        if (touched) stats.libraries++;
    }

    stats.ms = Date.now() - started;
    return stats;
}

/**
 * Symbols of a NESTED library namespace, harvested on demand — the answer to
 * `VisuElems.VisuElemBase.▮`.
 *
 * A library's namespace re-exports the namespaces of the libraries it depends on, so a path can be
 * two namespaces deep before it names anything. Established from real compiling code:
 * `VisuElems.VisuElemBase.IDialogManager`, `VisuElems.VisuElemBase.Visu_Globals.g_ClientManager`.
 * `VisuElems` is what the `.plcproj` references; `VisuElemBase` appears in no `.plcproj` at all —
 * it is reached through the VisuElems library's own `dependencies` file, which lists
 * `#System_VisuElemBase#…`.
 *
 * Resolved by NAME against the Managed Libraries store rather than by walking that dependency graph:
 * `dependencies` is an undocumented binary-ish format, and the segment already IS the namespace we
 * need. The looseness is deliberate and bounded — this only ever adds completion items, never a
 * diagnostic, and the caller gates it on the head being a real referenced namespace.
 *
 * Lazy and cached because the cost is real but only paid when a user actually types the path:
 * VisuElemBase is 6.3 MB / 11,572 symbols, measured at ~40 ms to harvest, once per session. Doing
 * this at index time for every library's every dependency is the 78 s cliff all over again.
 *
 * The harvest goes through harvestArchiveFile like every other archive read. It used to inflate the
 * file directly, so the per-registry cache below was the only thing standing between a multi-project
 * workspace and one full 6.3 MB decode of VisuElemBase *per project*.
 * @param {string} name The nested namespace segment (a library name).
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @param {{findArchive?: (name: string) => (string|null)}} [deps] Seam for the harness — the real
 *   resolver walks the machine's Managed Libraries store, which is absent on CI.
 * @returns {string[]} Symbol names, or an empty array when no such library is installed.
 */
function getNestedNamespaceSymbols(name, index, deps) {
    if (!name) return [];
    // Read-side (libRegistryFor, not ensureLibraryRegistry): this only ever CONSULTS the registry's
    // cache. The write-side twin would CREATE an empty registry on an index nothing has indexed yet
    // (e.g. a not-yet-scanned LOOSE_PROJECT_KEY index — see workspaceScan.js indexForKey), and every
    // later read on that index would then stop falling back to the default and see nothing.
    const reg = libRegistryFor(index);
    const key = String(name).toLowerCase();
    const cached = reg.nestedNamespaceSymbols.get(key);
    if (cached) return cached;

    let symbols = [];
    const findArchive = (deps && deps.findArchive) || findInstalledLibraryArchive;
    const archive = findArchive(name);
    if (archive) {
        const names = harvestArchiveFile(archive);
        // De-duplicated here rather than in the shared cache: the flat registry wants every
        // occurrence, this wants a completion list.
        if (names) symbols = Array.from(new Set(names));
    }
    reg.nestedNamespaceSymbols.set(key, symbols);
    return symbols;
}

/**
 * findInstalledLibraryArchive results, keyed lower-case. A miss (null) is cached too: the resolver
 * `readdirSync`-walks EVERY company directory under Managed Libraries before it can conclude
 * "not installed", and that walk was repeated for every project in the workspace.
 *
 * This adds no staleness that was not already there: getNestedNamespaceSymbols has always cached its
 * own misses permanently per registry ("an empty array is a cached MISS … and must not be retried"),
 * so installing a library mid-session was never picked up without a reload.
 * @type {Map<string, string|null>}
 */
const installedArchiveCache = new Map();

/**
 * Finds an installed library's archive by library name, across every distributor — a nested
 * namespace names a library the `.plcproj` never mentions, so there is no company to key on.
 * Memoized; see installedArchiveCache.
 * @param {string} name Library folder name.
 * @returns {string|null} Absolute path to a readable archive, or null.
 */
function findInstalledLibraryArchive(name) {
    const memoKey = String(name).toLowerCase();
    if (installedArchiveCache.has(memoKey)) return installedArchiveCache.get(memoKey);
    const found = resolveInstalledLibraryArchive(name);
    installedArchiveCache.set(memoKey, found);
    return found;
}

/**
 * The uncached walk behind findInstalledLibraryArchive.
 * @param {string} name Library folder name.
 * @returns {string|null} Absolute path to a readable archive, or null.
 */
function resolveInstalledLibraryArchive(name) {
    let companies;
    try {
        companies = fs.readdirSync(MANAGED_LIBRARIES, { withFileTypes: true });
    } catch (e) {
        return null;
    }
    const wanted = String(name).toLowerCase();
    for (const company of companies) {
        if (!company.isDirectory()) continue;
        const libDir = path.join(MANAGED_LIBRARIES, company.name, name);
        let versions;
        try { versions = fs.readdirSync(libDir, { withFileTypes: true }); } catch (e) { continue; }
        if (path.basename(libDir).toLowerCase() !== wanted) continue;
        for (const version of versions) {
            if (!version.isDirectory()) continue;
            const versionDir = path.join(libDir, version.name);
            let files;
            try { files = fs.readdirSync(versionDir); } catch (e) { continue; }
            // `.compiled-library-v3` is an opaque non-ZIP format and is deliberately skipped, here
            // as everywhere; a library shipped only in that form simply has no readable symbols.
            const hit = files.find(f => /\.(compiled-library(-ge33)?|library)$/i.test(f));
            if (hit) return path.join(versionDir, hit);
        }
    }
    return null;
}

/**
 * True if the name is a symbol declared by an indexed external library (case-insensitive).
 * @param {string} name Identifier to test.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {boolean}
 */
function isLibrarySymbol(name, index) {
    if (!name) return false;
    return libRegistryFor(index).librarySymbols.has(String(name).toLowerCase());
}

/**
 * Returns every harvested library symbol name, in its original spelling.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string[]}
 */
function getLibrarySymbols(index) {
    return Array.from(libRegistryFor(index).librarySymbols.values());
}

/**
 * Returns the library's own spelling of a symbol (`t_maxstring` -> `T_MaxString`), or undefined.
 * @param {string} name Identifier, any casing.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string|undefined}
 */
function getLibrarySymbolName(name, index) {
    if (!name) return undefined;
    return libRegistryFor(index).librarySymbols.get(String(name).toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// Registration into the workspace symbol index
// ---------------------------------------------------------------------------------------------

/** A stub source range for symbols that have no location in the workspace. */
const NO_RANGE = { startLine: 1, startCol: 1, endLine: 1, endCol: 1 };

/** Every identifier-shaped word in a Structured Text unit (comments and strings included: a name
 *  that only appears in a comment is still a real library symbol, so registering it is harmless). */
const IDENTIFIER_SCAN = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Builds the workspace-symbol-index node for a library symbol.
 *
 * Two flags carry the whole conservatism contract, and both are load-bearing:
 *
 * `external: true` — the node is a library's, not the project's. types.js keeps such a node at the
 * **anonymous** `unknown` type unless the `.tmc` described it (see `libKind`), and every check that
 * could flag it (declaration types, call arguments, assignability) tests this flag and stays silent.
 *
 * `membersComplete: false` — whatever members the node carries, the list is a *partial* view. The
 * `.tmc` only exports the types the project uses, only `<DataType>` blocks (no constants, no
 * functions), and its member list for a type is not guaranteed exhaustive. types.js therefore
 * resolves a member it cannot find on such a node to `undefined` ("cannot be sure") and never to
 * `null` ("definitely absent") — so `libInstance.SomeMember` can never be flagged "is not a member
 * of type", which is exactly the false positive this design exists to prevent. Completion, which can
 * only ever *lose* a suggestion by being wrong, uses the members freely.
 *
 * A symbol the `.tmc` says nothing about (the archives are names only) keeps an empty `variables`
 * list and no `libKind` — the pre-existing, fully anonymous behaviour.
 * @param {string} name Symbol name, in the library's own spelling.
 * @param {LibraryType} [info] The `.tmc`'s structure for it, when it has one.
 * @returns {Object} Symbol index node.
 */
function makeLibraryNode(name, info) {
    const structured = info && info.kind !== 'opaque';
    return {
        name: name,
        type: 'LIBRARY',
        external: true,
        membersComplete: false,       // see above — an unknown member is "uncertain", never "absent"
        libKind: structured ? info.kind : null,        // 'struct'|'fb'|'enum'|'function'|'interface'|'gvl'|null
        libNamespace: structured ? (info.namespace || '') : '',
        // A signature-derived function carries its return type for completion detail and future
        // return-type inference. It is deliberately NOT wired into typeFromNode: a library FUNCTION
        // node stays anonymous UNKNOWN (types.js `typeFromNode` has no 'function' case), so it is
        // never diagnostic-validated — consistent with `getCallParams` declining every external node.
        returnType: (info && info.returnType) ? info.returnType : undefined,
        uri: '',            // no location: falsy, so provideReferences skips it
        range: NO_RANGE,
        nameRange: NO_RANGE,
        // The `.tmc`'s `<ExtendsType>`. The chain walks in types.js (lookupMember) and features.js
        // (walkExtendsChain / findMemberInChain) follow it exactly as they follow a project FB's
        // EXTENDS, which is what makes a method declared on a library FB's *base* resolvable at all.
        // It cannot make a diagnostic fire: a miss on an external node is "uncertain", never "absent".
        extends: (info && info.extendsType) ? info.extendsType : null,
        implements: [],
        // The `.tmc`'s members, or [] for a bare archive name. Shared with the registry and never
        // mutated: nodes are read-only lookups, and a copy per document would be pure waste.
        variables: structured ? info.members : [],
        // Shaped like the parser's method nodes — `variables` are the parameters — so lookupMember
        // and the member-completion path read them without knowing where they came from.
        methods: structured && info.methods
            ? info.methods.map(m => ({ name: m.name, returnType: m.returnType, variables: m.params }))
            : [],
        properties: [],
        actions: []
    };
}

/**
 * Registers, as nodes in the workspace symbol index, the library symbols that a given compilation
 * unit actually references.
 *
 * This is what silences the undeclared-identifier check: provideDiagnostics builds its
 * `declaredNames` set from *every key* of the symbol index, so a registered name is simply declared,
 * with no change to features.js.
 *
 * Registration is per-document and on demand rather than "index everything at startup" for a
 * measured reason: the 48 sample archives yield ~14.8k symbols, and features.js resolves scopes with
 * `Object.keys(symbolIndex)` scans on its hottest paths (findActiveScope runs once per identifier
 * token). On a 15k-key object each such scan costs ~1.4 ms, which pushed one diagnostics pass from
 * 10 ms to ~520 ms. Registering only what a document references keeps the index at project scale
 * (the whole sample uses 60 distinct library symbols) and the cost at zero. Correctness is
 * unaffected: a symbol is registered from the very text that is about to be checked, so it can never
 * be flagged before it is known.
 *
 * @param {Object} index Workspace symbol index (mutated).
 * @param {string} code Structured Text of the document being processed.
 * @returns {number} Number of nodes newly registered.
 */
function registerLibrarySymbolNodes(index, code) {
    // No signature change: this already receives the index, so it just reads its registry off it —
    // the whole reason the registry lives on a Symbol key of the index rather than a threaded param.
    // Read-side (libRegistryFor, not ensureLibraryRegistry): this only ever CONSULTS the library
    // registry, it does not populate it, and falling back to the default when this index was never
    // itself indexed is what keeps the standalone harnesses (which index with no argument, then
    // register against a real-but-unindexed symbol index) working unchanged.
    if (!index || !code) return 0;
    const reg = libRegistryFor(index);
    if (reg.librarySymbols.size === 0) return 0;

    // Names already in the index, compared case-insensitively: a real project symbol must never be
    // shadowed by a same-named library symbol, whatever its casing.
    const known = new Set(Object.keys(index).map(k => k.toLowerCase()));
    const seen = new Set();
    let added = 0;

    IDENTIFIER_SCAN.lastIndex = 0;
    let m;
    while ((m = IDENTIFIER_SCAN.exec(code)) !== null) {
        const lower = m[0].toLowerCase();
        if (seen.has(lower) || known.has(lower)) continue;
        seen.add(lower);
        const real = reg.librarySymbols.get(lower);
        if (!real) continue;
        index[real] = makeLibraryNode(real, reg.typeSystemTypes.get(lower));
        known.add(lower);
        added++;
    }
    return added;
}

/**
 * Empties the symbol registry, the namespace map, the `.tmc` type structure, the library catalog, and
 * the namespace/title registries derived from the .plcproj. Used by custom/reindex and by the test
 * harnesses. The per-archive harvest cache is kept: it is keyed on file mtime+size, so it stays
 * correct and makes a reindex cheap (no re-inflation of unchanged archives) — and it is SHARED across
 * every project's registry, so clearing one project's registry must never touch it.
 *
 * Write-side (ensureLibraryRegistry, not libRegistryFor): clearing must create this index's OWN
 * registry if it does not have one yet, never clear the shared default because this specific index
 * had not been indexed yet.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 */
function clearLibrarySymbols(index) {
    const reg = ensureLibraryRegistry(index);
    reg.librarySymbols.clear();
    reg.namespaceSymbols.clear();
    reg.namespaceNames.clear();
    reg.libraryTitles.clear();
    reg.namespaceListCache.clear();
    reg.typeSystemTypes.clear();
    reg.typeSystemNamespaces.clear();
    reg.browserCacheNamespaceTypes.clear();
    reg.browserCacheNamespaceMembers.clear();
    reg.nestedNamespaceSymbols.clear();
    reg.libraryCatalog.clear();
}

module.exports = {
    // Directory walkers and their two skip sets. Exported for test_collect_scope.js, which pins the
    // asymmetry between them: `collectArchives` MUST descend into `_Libraries` while the two
    // project-artifact walkers must not. The harness proves the guard is load-bearing by adding
    // `_libraries` to SKIP_DIRS and watching collectArchives go blind — which is why the Sets
    // themselves are reachable. Nothing in the extension may mutate them.
    collectArchives,
    collectTmcFiles,
    collectSignatureFiles,
    SKIP_DIRS,
    PROJECT_SKIP_DIRS,
    // ZIP / string-table primitives (exported for the harness)
    readZipEntries,
    readZipEntryData,
    parseStringTable,
    harvestArchive,
    // The one entry point for reading an archive off disk: content-identity cached (see its
    // declaration), so the same library vendored into eight projects is decoded once.
    harvestArchiveFile,
    __archiveStats,
    // registry
    indexLibrarySymbols,
    indexTypeSystem,
    indexLibrarySignatures,
    indexLibrarySignaturesFromXml,
    indexBrowserCache,
    isLibrarySymbol,
    getLibrarySymbols,
    getLibrarySymbolName,
    clearLibrarySymbols,
    // namespace attribution
    indexLibraryTitles,
    archiveNamespace,
    getNamespaceSymbols,
    getLibraryNamespaceNames,
    getNamespaceCoverage,
    // library catalog (the "TwinCAT Libraries" view)
    getLibraryCatalog,
    getUnionLibraryCatalog,
    // .tmc type-system structure
    parseTmcDataType,
    getLibraryType,
    getTypeSystemNamespaceTypes,
    getBrowserCacheNamespaceTypes,
    isBrowserCacheMemberName,
    getNestedNamespaceSymbols,
    findInstalledLibraryArchive,
    getLibraryTypeNode,
    // symbol index integration
    registerLibrarySymbolNodes
};
