'use strict';

/**
 * @file plcprojRefs.js
 * @description One read, one parse, one walk for the `.plcproj`'s library reference blocks.
 *
 * Why this exists: a single project scan opened the same `.plcproj` **three times** — once in
 * libraries.js `indexLibraryNamespaces` (for the namespace set) and twice in libsymbols.js
 * `indexLibraryTitles`, which `indexLibrarySymbols` and `indexTypeSystem` each call to establish the
 * title → namespace map before they attribute anything. Three reads, three regex passes, three
 * directory walks, per project per scan, over identical bytes.
 *
 * The three consumers want different views of the *same* blocks, so this parses each reference block
 * once into a record that carries every field any of them needs:
 *
 *     <PlaceholderReference Include="System_VisuElems">          <- include
 *       <DefaultResolution>VisuElems, 4.8.0.0 (System)</...>     <- resolution
 *       <Namespace>VisuElems</Namespace>                         <- namespace
 *     </PlaceholderReference>
 *
 * The records are **read-only** and shared between projects: unlike the signature records in
 * parseCache.js, nothing downstream mutates them (each consumer copies the strings it needs into its
 * own registry), so no clone is needed here. Identity is `(absolute path, mtimeMs, size)`, the same
 * guard the archive and parse caches use.
 *
 * The skip set lives here too, because it is the *project-artifact* set — see PROJECT_SKIP_DIRS in
 * libsymbols.js for the half of that story that must NOT skip `_libraries`.
 */

const fs = require('fs');
const path = require('path');

/**
 * Directories that never hold a project's own `.plcproj`, `.tmc` or signatures dump: vendored library
 * archives, generated ST exports, build output, VCS and tooling. Compared lower-cased.
 *
 * Verified identical to the two sets it replaces before they were unified — libraries.js's own
 * `SKIP_DIRS` and libsymbols.js's `PLCPROJ_SKIP_DIRS` listed exactly these six entries. That check
 * mattered: unifying two skip sets that quietly differ would silently change which files are indexed.
 *
 * Restated rather than imported because libsymbols.js imports THIS module, so taking its
 * `PROJECT_SKIP_DIRS` would be a require cycle. test_collect_scope.js pins the two equal, and pins the
 * one entry that must NOT be in libsymbols.js's archive-walker set.
 * @type {Set<string>}
 */
const PLCPROJ_SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    '.vscode',
    '_libraries',
    'st_files',
    '_compileinfo'
]);

/**
 * @typedef {Object} LibraryReferenceBlock
 * @property {'placeholder'|'reference'} kind Which element declared the reference.
 * @property {string} include Raw `Include` attribute ('' when the element has none).
 * @property {string} resolution Raw `<DefaultResolution>` text ('' when the element has none).
 * @property {string} namespace The FIRST `<Namespace>` tag in the block, trimmed ('' when the block
 *           declares none, or when that first tag is blank) — what libsymbols.js attributes archives
 *           and types to.
 * @property {string[]} namespaces EVERY `<Namespace>` in the block, in document order. libraries.js
 *           has always taken all of them; keeping both views is what lets one parse serve both
 *           consumers without changing either one's behaviour.
 */

/**
 * Observation counters for the harnesses — never read by the extension.
 * `reads` counts a `.plcproj` actually read and parsed, `hits` a read avoided.
 * @type {{reads: number, hits: number}}
 */
const __stats = { reads: 0, hits: 0 };

/** @type {Map<string, {mtimeMs: number, size: number, value: LibraryReferenceBlock[]}>} */
const refsCache = new Map();

/** Only `<Namespace>` tags INSIDE a reference block count — the tag is generic enough that it also
 *  appears under `<Compile>`, and matching it document-wide would pick up unrelated settings. */
const REFERENCE_BLOCK = /<(PlaceholderReference|LibraryReference)\b([^>]*)>([\s\S]*?)<\/\1>/g;

/**
 * Parses the library reference blocks out of a `.plcproj`'s XML.
 * @param {string} xml Raw `.plcproj` text.
 * @returns {LibraryReferenceBlock[]} Blocks in document order (a block with no `<Namespace>` is kept:
 *          it still has no namespace to contribute, and dropping it here would hide that from a
 *          future consumer that cares about the Include alone).
 */
function parseLibraryReferences(xml) {
    /** @type {LibraryReferenceBlock[]} */
    const blocks = [];
    REFERENCE_BLOCK.lastIndex = 0;
    let block;
    while ((block = REFERENCE_BLOCK.exec(xml)) !== null) {
        const attrs = block[2] || '';
        const body = block[3] || '';

        // Two views of the same tags, because the two consumers have always differed and neither may
        // change: libraries.js takes every non-empty one, libsymbols.js takes the FIRST tag whatever
        // it holds — a block whose first `<Namespace>` is blank contributed no title before this
        // module existed, and must still contribute none.
        const namespaces = [];
        let first = null;
        const nsRegex = /<Namespace>([^<]+)<\/Namespace>/g;
        let ns;
        while ((ns = nsRegex.exec(body)) !== null) {
            const name = ns[1].trim();
            if (first === null) first = name;
            if (name) namespaces.push(name);
        }

        const include = /Include\s*=\s*"([^"]*)"/i.exec(attrs);
        const resolution = /<DefaultResolution>([^<]+)<\/DefaultResolution>/.exec(body);

        blocks.push({
            kind: block[1] === 'PlaceholderReference' ? 'placeholder' : 'reference',
            include: include ? include[1] : '',
            resolution: resolution ? resolution[1] : '',
            namespace: first || '',
            namespaces
        });
    }
    return blocks;
}

/**
 * The library reference blocks of one `.plcproj`, read and parsed at most once per
 * (path, mtimeMs, size).
 *
 * The returned array is shared — see the file header: these records are read-only by contract.
 * @param {string} filePath Absolute path to a `.plcproj`.
 * @returns {LibraryReferenceBlock[]|null} null when the file cannot be statted or read; every caller
 *          then contributes nothing for it rather than guessing, which is the pre-existing behaviour.
 */
function readLibraryReferences(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        return null;
    }
    const key = path.resolve(filePath).toLowerCase();
    const entry = refsCache.get(key);
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
        __stats.hits++;
        return entry.value;
    }
    let xml;
    try {
        xml = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return null; // unreadable .plcproj: skip, never throw out of indexing
    }
    const value = parseLibraryReferences(xml);
    __stats.reads++;
    refsCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
}

/**
 * Recursively collects `.plcproj` files under a directory. The one implementation both libraries.js
 * and libsymbols.js use, so their results can never drift apart.
 * @param {string} dirPath Absolute directory path.
 * @param {string[]} out Accumulator, mutated.
 */
function collectPlcProjFiles(dirPath, out) {
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
        return; // unreadable directory: skip, never throw out of indexing
    }
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (PLCPROJ_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
            collectPlcProjFiles(fullPath, out);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj')) {
            out.push(fullPath);
        }
    }
}

/**
 * Empties the cache and zeroes the counters — the counters exist only to observe the cache, so a
 * cleared cache with stale counts would be a lie. For the harnesses; the extension never needs it
 * (the identity guard already invalidates an edited `.plcproj` on its own, which is what keeps the
 * `.plcproj` watcher's `custom/reindex` honest).
 */
function clearPlcProjRefsCache() {
    refsCache.clear();
    __stats.reads = 0;
    __stats.hits = 0;
}

module.exports = {
    PLCPROJ_SKIP_DIRS,
    parseLibraryReferences,
    readLibraryReferences,
    collectPlcProjFiles,
    clearPlcProjRefsCache,
    __stats
};
