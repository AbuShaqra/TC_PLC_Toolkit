/**
 * @file test_references_cache.js
 * @description Find References caches each file's converted ST (and its tokens) across searches, and
 * skips files that cannot contain the word before tokenizing them. Both are pure speed — the results
 * must be identical to the uncached scan — and both have an obvious way to be wrong:
 *
 *   - a stale cache would keep answering from a file's OLD contents after it changed on disk;
 *   - the "does this file contain the word at all" pre-filter is a substring test, and ST is
 *     case-insensitive, so a filter that respected case would silently drop real references.
 *
 * Measured before caching: one search re-read, re-parsed, re-converted and re-tokenized every indexed
 * document — 75 ms on the 152-file sample, and Go to References runs two searches (peek + panel).
 */

const fs = require('fs');
const path = require('path');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideReferences, clearStFileCache } = require('../src/lsp/features');

const TEST_DIR = path.join(__dirname, 'test_refcache_project');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const uriOf = (name) => 'file:///' + path.join(TEST_DIR, name).replace(/\\/g, '/').replace(/^\//, '');

/** Writes a file and waits until its mtime actually differs, so the test cannot race the cache key. */
function write(name, text, previousMtime) {
    const p = path.join(TEST_DIR, name);
    fs.writeFileSync(p, text, 'utf8');
    if (previousMtime !== undefined) {
        const deadline = Date.now() + 2000;
        while (fs.statSync(p).mtimeMs === previousMtime && Date.now() < deadline) {
            fs.writeFileSync(p, text, 'utf8');
        }
    }
    return fs.statSync(p).mtimeMs;
}

const FB = `FUNCTION_BLOCK FB_Pump
VAR_INPUT
    bEnable : BOOL;
END_VAR
`;
// The caller starts with ONE reference to FB_Pump, and its file is rewritten later to hold two.
const CALLER_V1 = `PROGRAM MAIN
VAR
    fbA : FB_Pump;
END_VAR
fbA(bEnable := TRUE);
`;
const CALLER_V2 = `PROGRAM MAIN
VAR
    fbA : FB_Pump;
    fbB : FB_Pump;
END_VAR
fbA(bEnable := TRUE);
`;
const CALLER_SAME_SIZE_NO_REF = CALLER_V1.replace(/FB_Pump/g, 'FB_Dump');
// Spelled in a different case, because ST is case-insensitive: the pre-filter must not drop this.
const OTHER = `FUNCTION_BLOCK FB_Other
VAR
    fbC : fb_pump;
END_VAR
`;

write('FB_Pump.st', FB);
write('MAIN.st', CALLER_V1);
const callerPath = path.join(TEST_DIR, 'MAIN.st');
const fixedMtime = new Date((Math.floor(Date.now() / 1000) - 5) * 1000);
fs.utimesSync(callerPath, fixedMtime, fixedMtime);
const callerMtime = fs.statSync(callerPath).mtimeMs;
write('FB_Other.st', OTHER);

const reindex = () => {
    clearWorkspaceIndex();
    clearStFileCache();
    for (const name of ['FB_Pump.st', 'MAIN.st', 'FB_Other.st']) {
        parseAndIndexDocument(fs.readFileSync(path.join(TEST_DIR, name), 'utf8'), uriOf(name));
    }
    return getWorkspaceSymbolIndex();
};

const search = (index) => {
    // From the declaration of FB_Pump itself, at the type name.
    const code = fs.readFileSync(path.join(TEST_DIR, 'FB_Pump.st'), 'utf8');
    return provideReferences(code, { line: 0, character: 17 }, index, uriOf('FB_Pump.st'));
};

const countIn = (refs, name) => refs.filter(r => String(r.uri).toLowerCase().includes(name.toLowerCase())).length;

let index = reindex();
let refs = search(index);

assert(countIn(refs, 'FB_Pump.st') === 1, `the FB's own declaration is a reference (got ${countIn(refs, 'FB_Pump.st')})`);
assert(countIn(refs, 'MAIN.st') === 1, `MAIN's single instance is found (got ${countIn(refs, 'MAIN.st')})`);
assert(countIn(refs, 'FB_Other.st') === 1,
    `a differently-cased spelling (fb_pump) is found — ST is case-insensitive, and the pre-filter must be too (got ${countIn(refs, 'FB_Other.st')})`);

// Searching again must return exactly the same thing from the cache, not a subset.
const refsAgain = search(index);
assert(refsAgain.length === refs.length,
    `a repeat search returns the same references from cache (${refs.length} then ${refsAgain.length})`);

// Deployment/copy tools can preserve mtime. This rewrite also preserves byte length, so an
// mtime+size cache would still answer from CALLER_V1 even though MAIN no longer names FB_Pump.
const beforePreservedEdit = fs.statSync(callerPath);
fs.writeFileSync(callerPath, CALLER_SAME_SIZE_NO_REF, 'utf8');
fs.utimesSync(callerPath, beforePreservedEdit.atime, beforePreservedEdit.mtime);
const afterPreservedEdit = fs.statSync(callerPath);
assert(afterPreservedEdit.mtimeMs === beforePreservedEdit.mtimeMs,
    'fixture restored the original mtime after a same-size rewrite');
const refsAfterPreservedEdit = search(index);
assert(countIn(refsAfterPreservedEdit, 'MAIN.st') === 0,
    `a same-size rewrite with preserved mtime invalidates the cache (got ${countIn(refsAfterPreservedEdit, 'MAIN.st')} stale hits)`);

// The file changes on disk. The cache keys on mtime, so the new reference must appear WITHOUT any
// reindex — a cache that ignored this would keep serving the old contents forever.
write('MAIN.st', CALLER_V2, callerMtime);
const refsAfterEdit = search(index);
assert(countIn(refsAfterEdit, 'MAIN.st') === 2,
    `after MAIN gains a second instance on disk, the search sees both (got ${countIn(refsAfterEdit, 'MAIN.st')}) — the cache is not stale`);
assert(refsAfterEdit.length === refs.length + 1,
    `exactly one reference was added (${refs.length} -> ${refsAfterEdit.length})`);

// A word that appears in no OTHER file: every indexed file is skipped by the pre-filter, which must
// leave the active document's own occurrence intact (it is scanned from memory, not from the cache)
// rather than throwing or returning nothing.
const none = provideReferences('FUNCTION_BLOCK FB_Absent\n', { line: 0, character: 17 }, index, uriOf('FB_Absent.st'));
assert(none.length === 1 && String(none[0].uri).includes('FB_Absent'),
    `a symbol found in no indexed file still reports its own declaration, and the skipped files do not throw (got ${none.length})`);

fs.rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n--- REFERENCE CACHE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
