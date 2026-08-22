'use strict';

/**
 * @file parseCache.js
 * @description Parse-once caches for the two big plain-XML artifacts a workspace scan re-reads for
 * **every** PLC project it indexes: the `library-signatures.xml` dump and a library's browsercache.
 *
 * Why this exists: `indexLibraries` runs per project, and `server.js` additionally scans every
 * workspace root for a signatures dump — so on an 8-project workspace with 4 dumps (8.15 MB) the same
 * bytes were read and parsed dozens of times per scan. Measured split for those 4 dumps: read 24 ms,
 * **parse 68 ms**, merge 13 ms. The parse is the part that does not depend on which project is asking,
 * so it is the part that is cached here; the merge still runs per project, because its whole job is to
 * attribute types to *that* project's namespaces.
 *
 * Cache identity is `(absolute path, mtimeMs, size)` — exactly the strength libsymbols.js's archive
 * cache has always used. Paths are compared lower-cased: TwinCAT is Windows-only, and the same dump is
 * reached under different casings (once as the project directory, once as a workspace root).
 *
 * **The copy is a correctness requirement, not an optimisation.** libsymbols.js
 * `indexLibrarySignaturesFromXml` rewrites each record's `namespace` to the namespace *this* project's
 * `.plcproj` imports the library under, then stores that same object in the project's
 * `typeSystemTypes`; `indexBrowserCache` later pushes onto its `methods` / `properties`. Handing the
 * same record object to two projects would therefore leak project A's namespace attribution and
 * browsercache members into project B — precisely the cross-project contamination the per-project
 * registries exist to prevent. Hence: `signatureRecordsFor` is the only way in, the *template* it
 * caches never escapes the module, and every call returns a fresh copy — there is no separate clone
 * step for a caller to forget.
 */

const fs = require('fs');
const path = require('path');
const { parseLibrarySignaturesXml, toRegistryTypes } = require('./librarySignatures');
const { parseBrowserCache } = require('./browserCache');

/**
 * @typedef {Object} SignatureRecords
 * @property {number} functions Functions the dump declares, across every library in it.
 * @property {number} functionBlocks Function blocks likewise.
 * @property {Array<Object>} types Registry-ready type records (libsymbols.js LibraryType shape), with
 *           `namespace` still holding the library TITLE the dump names — the merge translates it.
 * @property {string[]} symbols Bare symbol names (var-list names and their constants).
 */

/**
 * Observation counters for the harnesses — never read by the extension.
 * `parses` counts an XML actually parsed, `hits` a parse avoided, `clones` a template copied.
 * @type {{parses: number, hits: number, clones: number}}
 */
const __stats = { parses: 0, hits: 0, clones: 0 };

/** @type {Map<string, {mtimeMs: number, size: number, value: SignatureRecords}>} */
const signatureCache = new Map();

/** @type {Map<string, {mtimeMs: number, size: number, value: Map<string, Object>}>} */
const browserCacheDocs = new Map();

/**
 * Looks a file up in one of the caches, guarded by its current mtime and size.
 * @param {Map<string, {mtimeMs: number, size: number, value: *}>} cache The cache to consult.
 * @param {string} filePath Absolute file path.
 * @returns {{key: string, stat: fs.Stats, value: *}|null} The identity key and stat to store under,
 *          with `value` set when the cached entry is still current — or null when the file cannot be
 *          statted (unreadable / gone), which every caller treats as "contribute nothing".
 */
function lookup(cache, filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        return null; // gone or unreadable: the caller skips the file, exactly as it did before
    }
    const key = path.resolve(filePath).toLowerCase();
    const entry = cache.get(key);
    const current = entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
    return { key, stat, value: current ? entry.value : undefined };
}

/**
 * Parses a ProduceAllLibrarySignatures XML string into the registry-ready records the merge consumes.
 * Pure and uncached — the string entry point (`indexLibrarySignaturesFromXml`) needs exactly this, and
 * `readSignatureRecords` needs it too, so it lives in one place.
 * @param {string} xml Raw dump XML.
 * @returns {SignatureRecords} Records; empty counts and lists for XML that declares nothing.
 */
function parseSignatureRecords(xml) {
    const parsed = parseLibrarySignaturesXml(xml);
    let functions = 0;
    let functionBlocks = 0;
    for (const lib of parsed.libraries) {
        functions += lib.functions.length;
        functionBlocks += lib.functionBlocks.length;
    }
    const regTypes = toRegistryTypes(parsed);
    return { functions, functionBlocks, types: regTypes.types, symbols: regTypes.symbols };
}

/**
 * The parsed records of one `library-signatures.xml` — parsed at most once per
 * (path, mtime, size), and returned as a PRIVATE COPY on every call.
 *
 * There is deliberately no way to obtain the cached template: the merge rewrites
 * `record.namespace` and the browsercache enrichment pushes onto `methods`/`properties`,
 * so a shared record would leak one project's attribution into another. The copy depth
 * matches what the merge writes: type records are copied, `symbols` and each record's
 * `members` stay shared (read-only in every consumer; see the file header).
 * @param {string} filePath Absolute path to a `library-signatures.xml`.
 * @returns {SignatureRecords|null} A caller-owned copy, or null when unreadable/unparseable.
 */
function signatureRecordsFor(filePath) {
    const found = lookup(signatureCache, filePath);
    if (!found) return null;
    let template = found.value;
    if (template) {
        __stats.hits++;
    } else {
        let xml;
        try {
            xml = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            return null; // unreadable dump: contribute nothing rather than guess
        }
        template = parseSignatureRecords(xml);
        __stats.parses++;
        signatureCache.set(found.key, { mtimeMs: found.stat.mtimeMs, size: found.stat.size, value: template });
    }
    __stats.clones++;
    return {
        functions: template.functions,
        functionBlocks: template.functionBlocks,
        types: template.types.map(record => ({ ...record })),
        // Strings: nothing can mutate them, so the array is shared like `members`.
        symbols: template.symbols
    };
}

/**
 * The parsed browsercache of one library, parsed at most once per (path, mtime, size).
 *
 * No clone here, unlike the signature records: `indexBrowserCache` only ever *reads* these objects —
 * every value it keeps (`{name, kind}`, `{name}`, the lower-cased member names) is freshly
 * constructed — so nothing it stores can alias the cached document.
 * @param {string} filePath Absolute path to a `browsercache` file.
 * @returns {Map<string, {name: string, kind: string, methods: string[], properties: string[]}>|null}
 *          null when the file cannot be read.
 */
function readBrowserCacheDoc(filePath) {
    const found = lookup(browserCacheDocs, filePath);
    if (!found) return null;
    if (found.value) {
        __stats.hits++;
        return found.value;
    }
    let xml;
    try {
        xml = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return null;
    }
    const value = parseBrowserCache(xml);
    __stats.parses++;
    browserCacheDocs.set(found.key, { mtimeMs: found.stat.mtimeMs, size: found.stat.size, value });
    return value;
}

/**
 * Empties both caches and zeroes the counters — the counters exist only to observe the caches, so a
 * cleared cache with stale counts would be a lie. For the harnesses; the extension never needs it
 * (the identity guard already invalidates an edited file on its own).
 */
function clearParseCaches() {
    signatureCache.clear();
    browserCacheDocs.clear();
    __stats.parses = 0;
    __stats.hits = 0;
    __stats.clones = 0;
}

module.exports = {
    parseSignatureRecords,
    signatureRecordsFor,
    readBrowserCacheDoc,
    clearParseCaches,
    __stats
};
