/**
 * @file twincatWorkspace.js
 * @description The single owner of workspace-discovery knowledge: the directory walker every
 * scanner drives, the skip-dir sets that decide what each scanner is allowed to see, the TwinCAT
 * file-extension vocabularies, XML attribute decoding, and the duplicate-name suffix algorithm
 * used to label same-named solutions/projects.
 *
 * Before this module existed, seven call sites (solutionMap.js, lsp/projectMap.js,
 * lsp/workspaceScan.js, lsp/libsymbols.js, lsp/plcprojRefs.js, lsp/xmlIndexer.js, lsp/parser.js)
 * each carried its own copy of a `readdirSync`-based walk and its own skip-dir Set — several with
 * subtly different memberships for a reason (see below), which made "does this scanner see
 * `_Libraries`?" a question you could only answer by re-reading six files. This module makes the
 * PRESERVED VARIANCE explicit and literal instead of implicit and scattered: every skip-dir set a
 * scanner used is reproduced here by name, so a reader (or a diff) sees the full menu of "what
 * skips what" in one place, and a change to one no longer risks silently drifting from its
 * neighbours.
 *
 * The variance itself is real, not accidental — see DEVELOPMENT.md "Indexing cost, and the four
 * rules that keep it down", rule 4: `ARCHIVE_SKIP_DIRS` (the set `collectArchives` walks) must
 * NEVER gain `_libraries`, because that is exactly where the vendor archives it needs to find
 * live; `PROJECT_SKIP_DIRS` (for the `.tmc`/signature/`.plcproj` walkers, which have no business
 * reading vendored binaries) is that same set plus `_libraries`. Collapsing the two into one
 * "the" skip set would either blind the archive scan or resurrect the false positives that made
 * the split necessary in the first place.
 *
 * Kept dependency-free (Node `fs`/`path` only, no `vscode`) so both the LSP server process and the
 * extension host can require it with no cycle, matching the constraint lsp/projectMap.js already
 * documents for itself.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --- XML attribute decoding -----------------------------------------------------------------

/**
 * Decodes the XML character entities legal in an attribute value (null-safe superset of
 * lsp/projectMap.js's `decodeXmlAttribute`: TwinCAT XML never carries a null/undefined attribute
 * value in practice, but the presentation-model callers that read solution/project metadata do
 * see optional fields, and a `String(value || '')` guard here means every caller gets the same
 * decoder instead of each writing its own null guard around a shared regex chain).
 *
 * Order matters: `&amp;` decodes LAST, so a real folder named `time&date` — written by TwinCAT as
 * `Include="POUs\time&amp;date\..."` — round-trips correctly instead of the `&` in `&amp;`
 * re-triggering an earlier entity pattern.
 * @param {string|null|undefined} value Raw attribute value.
 * @returns {string} Decoded text, or '' for null/undefined.
 */
function decodeXmlAttribute(value) {
    return String(value || '')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// --- The shared directory walker ------------------------------------------------------------

/**
 * Recursively walks one or more roots, collecting files an `isMatch` predicate accepts while
 * refusing to descend into any directory named in `skipDirs`. Transcribes lsp/projectMap.js's
 * `findPlcProjFiles` walk shape exactly: `readdirSync` with `withFileTypes`, an unreadable
 * directory is skipped (never thrown out of the walk), directory-name matching against
 * `skipDirs` is case-insensitive, and a file only reaches `isMatch` after `entry.isFile()` has
 * already gated it.
 *
 * Deliberately does NOT sort the result — callers that need a deterministic order sort it
 * themselves (as solutionMap.js's `findSolutionFiles` and projectMap.js's `findPlcProjFiles`
 * already do); baking a sort in here would cost every caller that does not need one.
 * @param {string|Array<string>} rootOrRoots One root, or several roots to walk in order.
 * @param {Object} options
 * @param {Set<string>} options.skipDirs Lower-cased directory names never to descend into.
 * @param {(entryName: string, fullPath: string) => boolean} options.isMatch REQUIRED. Decides whether a
 *   FILE (never a directory) is collected. Receives both the bare entry name and its full path.
 * @param {Array<string>} [options.out] Array to append matches to (returned as-is); a fresh array
 *   is used when omitted.
 * @param {DirectoryListingMemo|null} [options.listing] A scan's listing memo (see
 *   createDirectoryListingMemo): each directory is then read from disk at most once per memo, however
 *   many walks cross it. The result is identical to an unmemoized walk of the same snapshot.
 * @returns {Array<string>} `options.out`, or a new array, containing every matched file path.
 */
function walkFiles(rootOrRoots, options) {
    const skipDirs = (options && options.skipDirs) || new Set();
    const isMatch = options && options.isMatch;
    const out = (options && options.out) || [];
    const listing = (options && options.listing) || null;
    const roots = Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots];

    const walk = (dir) => {
        let entries;
        try {
            entries = listing ? listing.list(dir) : fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return; // unreadable directory: skip, never throw out of discovery
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (skipDirs.has(entry.name.toLowerCase())) continue;
                walk(full);
            } else if (entry.isFile() && isMatch(entry.name, full)) {
                out.push(full);
            }
        }
    };
    for (const root of roots) walk(root);
    return out;
}

/**
 * @typedef {Object} DirectoryListingMemo
 * @property {(dir: string) => Array<fs.Dirent>} list The directory's entries (`readdirSync` with
 *   `withFileTypes`), read from disk on the first call for that directory and replayed after; a
 *   directory that could not be read throws the same way on every call.
 * @property {() => number} reads Directories actually read from disk (for the harnesses).
 */

/**
 * A memo of directory listings for the lifetime of ONE workspace scan.
 *
 * Every project of a scan walks the same workspace roots for the `library-signatures.xml` dump (it is
 * a workspace-level artifact that sits above every project), and each project directory again for its
 * own dump and `.tmc` — on an 8-project workspace that was 16 full walks per scan, ~850 ms on Windows.
 * Sharing the listings makes the first walk pay for the disk and every later one an in-memory
 * replay, and because the walker itself is unchanged (same skip sets, same order, same paths spelled
 * from the caller's own `dir`), the result is exactly what an unmemoized walk of that snapshot returns.
 *
 * **Invalidation is the scan boundary, and nothing else.** A memo is created at the start of a scan
 * and dropped with it; it is never stored across scans. So a `library-signatures.xml` or `.tmc` that is
 * added or removed is found by the next scan — startup, or the `custom/reindex` that the `.plcproj`
 * watcher, the `.tmc`/dump watcher (src/indexInputs.js) and Update Library Definitions send. No time
 * window and no mtime sampling: a directory's own mtime does not change when a file appears two levels
 * below it, so a guard on it would call a stale listing current.
 *
 * Keys are absolute paths, case-folded only on Windows (where the filesystem is case-insensitive).
 * @returns {DirectoryListingMemo}
 */
function createDirectoryListingMemo() {
    /** @type {Map<string, {entries?: Array<fs.Dirent>, error?: Error}>} */
    const cache = new Map();
    let reads = 0;
    const keyOf = (dir) => {
        const resolved = path.resolve(dir);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return {
        list: (dir) => {
            const key = keyOf(dir);
            let hit = cache.get(key);
            if (!hit) {
                reads++;
                try {
                    hit = { entries: fs.readdirSync(dir, { withFileTypes: true }) };
                } catch (e) {
                    hit = { error: e };
                }
                cache.set(key, hit);
            }
            if (hit.error) throw hit.error;
            return hit.entries;
        },
        reads: () => reads
    };
}

// --- Skip-dir sets ----------------------------------------------------------------------------
// Built by composition from BASE_SKIP_DIRS so the shared floor is visible at every call site,
// rather than each caller re-listing '.git', 'node_modules', '.vscode' by hand. Plain mutable
// Sets — NOT frozen: a caller is free to extend one at runtime (a workspace setting adding an
// extra ignored directory, for example), and freezing would silently break that.

/** The floor every scanner shares: VCS, package manager, and editor metadata directories. */
const BASE_SKIP_DIRS = new Set(['.git', 'node_modules', '.vscode']);

/**
 * The generated-output folders, lower-cased: Generate ST's `ST_Files` (derived `.st` mirrors) and
 * Compile Project's `CPP_Files` (generated C++ and g++'s object file, R13). Never indexed, never an
 * input, and their watcher events never trigger a per-event refresh.
 */
const GENERATED_OUTPUT_DIRS = new Set(['st_files', 'cpp_files']);

/**
 * lsp/projectMap.js's `.plcproj` walk: vendor archives, ST_Files (derived .st mirrors that would
 * shadow the XML objects), CPP_Files (generated C++), TwinCAT's compile-info cache, and boot-project output.
 */
const PROJECT_WALK_SKIP_DIRS = new Set([...BASE_SKIP_DIRS, '_libraries', 'st_files', 'cpp_files', '_compileinfo', '_boot']);

/** solutionMap.js's `.sln` walk — the same idea as PROJECT_WALK_SKIP_DIRS, minus `st_files` (a
 *  `.sln` never sits under a derived ST mirror, so excluding it bought nothing there). */
const SOLUTION_SKIP_DIRS = new Set([...BASE_SKIP_DIRS, '_libraries', '_boot', '_compileinfo']);

/** lsp/workspaceScan.js's config-object walk: just the floor plus vendor archives. */
const CONFIG_OBJECT_SKIP_DIRS = new Set([...BASE_SKIP_DIRS, '_libraries']);

/**
 * lsp/libsymbols.js's `collectArchives` walk. Deliberately does NOT include `_libraries` — that
 * is exactly where the vendor `.compiled-library`/`.tmc` archives this walk exists to find live.
 * See DEVELOPMENT.md "Indexing cost" rule 4: adding `_libraries` here would blind the scan and
 * reintroduce the ~171 false positives that made the ARCHIVE/PROJECT split necessary.
 */
const ARCHIVE_SKIP_DIRS = new Set([...BASE_SKIP_DIRS, '_compileinfo', 'st_files', 'cpp_files']);

/**
 * lsp/libsymbols.js's `PROJECT_SKIP_DIRS` (mirrored by plcprojRefs.js's `PLCPROJ_SKIP_DIRS`, pinned
 * equal to it by test_collect_scope.js): the `.tmc`/signature/`.plcproj` walkers, which have no
 * business reading vendored binaries, so they exclude `_libraries` on top of ARCHIVE_SKIP_DIRS.
 */
const PROJECT_SKIP_DIRS = new Set([...ARCHIVE_SKIP_DIRS, '_libraries']);

/** lsp/xmlIndexer.js's directory-skip chain (its own inline `entry.name === ...` checks, now
 *  expressed as a set — still case-insensitive per the walker's own R1 lower-casing). */
const XML_INDEX_SKIP_DIRS = new Set([...BASE_SKIP_DIRS, '_libraries']);

/** lsp/parser.js's `.st` directory-skip chain (its own inline checks against `ST_Files`; `CPP_Files` holds no `.st`). */
const ST_INDEX_SKIP_DIRS = new Set([...BASE_SKIP_DIRS, 'st_files', 'cpp_files']);

// --- Extension vocabularies --------------------------------------------------------------------

/** TwinCAT XML object extensions (lower-cased) a `.plcproj` can `<Compile>`. `.tctleo`
 *  (EnumerationTextList) declares a real ST enum — xmlParser normalises its root element to DUT,
 *  so it indexes as one; `.tctto` (task) and `.tctlo` (HMI text list) are NOT ST types. */
const TWINCAT_XML_EXTS = new Set(['.tcpou', '.tcgvl', '.tcdut', '.tcio', '.tctleo']);

/** The reveal/status-bar vocabulary: every TwinCAT XML object type, plus the loose `.st` files
 *  the editor also opens directly. */
const TWINCAT_EDITOR_EXTS = new Set([...TWINCAT_XML_EXTS, '.st']);

/**
 * The file-watcher vocabulary (`.st` is watched separately). Same membership as TWINCAT_XML_EXTS
 * but a distinct set on purpose: this one gates what the save/create/change watchers push to the
 * LSP and what plcProjHelper (re)registers, while TWINCAT_XML_EXTS says what a `.plcproj` can
 * `<Compile>`. `.tctleo` was missing until 2026-08-24 — an external `.TcTLEO` edit never reached
 * the live index (confirmed in the dev host, which now gates it: test/devhost/run.js).
 */
const TWINCAT_WATCH_EXTS = new Set([...TWINCAT_XML_EXTS]);

// --- Duplicate-name suffix core ------------------------------------------------------------

/**
 * Produces compact but unambiguous labels for a set of same-named records (solutions, projects, …)
 * by suffixing each with the shortest unique parent-directory path. One record whose name is
 * unique in `records` passes through unsuffixed.
 *
 * This single function reproduces TWO existing bodies byte-for-byte in behaviour, selected by
 * `options`, because they differ only in three respects and duplicating the shared 90% risked the
 * two drifting apart silently (which is exactly the bug class this module exists to close off):
 *   - default options ({}): solutionMap.js's `suffixDisplayNames` semantics — the depth search
 *     for each record is bounded by that record's OWN part count, and the compared parts never
 *     include the filesystem root.
 *   - `{ includeRoot: true, sharedMaxDepth: true }`: lsp/projectMap.js's `buildProjectDisplayNames`
 *     semantics — the depth search is bounded by the SHARED maximum part count across the whole
 *     same-named group (floored at 1), and the root segment (trailing separator stripped) is
 *     unshifted onto each record's parts so a root-only difference can still disambiguate.
 * The same-named-DIRECTORY collapse projectMap.js applies (skipping a project's own folder when
 * it repeats the project's name) stays OUT of this core — it is a caller concern, applied by the
 * `dirOf` callback the caller passes in, exactly as projectMap.js already does.
 *
 * Separators are frozen: parts join with `' / '`, and the disambiguated label joins name and
 * suffix with `' — '` (U+2014 EM DASH, not a hyphen or en dash).
 * @param {Array<{key: string}>} records Records to label; each needs a stable `key`.
 * @param {(record: Object) => string} nameOf The record's display name (compared case-insensitively
 *   for grouping).
 * @param {(record: Object) => string} dirOf The directory whose ancestry disambiguates the record.
 * @param {{includeRoot?: boolean, sharedMaxDepth?: boolean}} [options]
 * @returns {Map<string, string>} record key → display label.
 */
function suffixDisplayNames(records, nameOf, dirOf, options) {
    const includeRoot = !!(options && options.includeRoot);
    const sharedMaxDepth = !!(options && options.sharedMaxDepth);

    const result = new Map();
    const buckets = new Map();
    for (const record of records) {
        const name = nameOf(record);
        const key = name.toLowerCase();
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(record);
    }

    for (const sameName of buckets.values()) {
        if (sameName.length === 1) {
            result.set(sameName[0].key, nameOf(sameName[0]));
            continue;
        }

        const partsFor = new Map();
        let sharedDepth = 1;
        for (const record of sameName) {
            const dir = dirOf(record);
            const parsed = path.parse(dir);
            const values = dir.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
            if (includeRoot && parsed.root) values.unshift(parsed.root.replace(/[\\/]+$/, ''));
            partsFor.set(record.key, values);
            if (sharedMaxDepth) sharedDepth = Math.max(sharedDepth, values.length);
        }

        for (const record of sameName) {
            const own = partsFor.get(record.key);
            const depthLimit = sharedMaxDepth ? sharedDepth : own.length;
            let suffix = own.join(' / ');
            for (let depth = 1; depth <= depthLimit; depth++) {
                const candidate = own.slice(-depth).join(' / ');
                const matches = sameName.filter(other =>
                    partsFor.get(other.key).slice(-depth).join(' / ').toLowerCase() === candidate.toLowerCase());
                if (matches.length === 1) { suffix = candidate; break; }
            }
            result.set(record.key, `${nameOf(record)} — ${suffix}`);
        }
    }
    return result;
}

/**
 * Whether a file-system watcher event is worth reacting to (tree refresh, project-structure
 * rebuild, re-index). Not for VCS/package/editor metadata, and not for anything under an `ST_Files`
 * or `CPP_Files` folder at any depth: that is generated output (Generate ST's, written in bursts of
 * hundreds of files, and reacting to each one refreshed the whole Objects tree once per generated
 * file; Compile Project's C++).
 * @param {string} fsPath The event's path, with either separator.
 * @returns {boolean}
 */
function isWatchEventRelevant(fsPath) {
    const parts = String(fsPath || '').split(/[\\/]+/);
    // The last part is the entry itself: a created FOLDER named ST_Files is output too.
    return !parts.some(part => BASE_SKIP_DIRS.has(part.toLowerCase()) || GENERATED_OUTPUT_DIRS.has(part.toLowerCase()));
}

/**
 * Whether a watcher event is inside generated output (an `ST_Files` or `CPP_Files` folder, or that folder itself) and
 * outside VCS/editor metadata. Such events never re-index or refresh per event (see
 * isWatchEventRelevant); the host collects them into ONE debounced Objects-tree refresh, so files the
 * user adds or deletes there by hand still show.
 * @param {string} fsPath The event's path, with either separator.
 * @returns {boolean}
 */
function isGeneratedOutputEvent(fsPath) {
    const parts = String(fsPath || '').split(/[\\/]+/).map(p => p.toLowerCase());
    return parts.some(part => GENERATED_OUTPUT_DIRS.has(part)) && !parts.some(part => BASE_SKIP_DIRS.has(part));
}

module.exports = {
    GENERATED_OUTPUT_DIRS,
    isWatchEventRelevant,
    isGeneratedOutputEvent,
    decodeXmlAttribute,
    walkFiles,
    createDirectoryListingMemo,
    BASE_SKIP_DIRS,
    PROJECT_WALK_SKIP_DIRS,
    SOLUTION_SKIP_DIRS,
    CONFIG_OBJECT_SKIP_DIRS,
    ARCHIVE_SKIP_DIRS,
    PROJECT_SKIP_DIRS,
    XML_INDEX_SKIP_DIRS,
    ST_INDEX_SKIP_DIRS,
    TWINCAT_XML_EXTS,
    TWINCAT_EDITOR_EXTS,
    TWINCAT_WATCH_EXTS,
    suffixDisplayNames
};
