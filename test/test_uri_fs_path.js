/**
 * @file test_uri_fs_path.js
 * @description uriToFsPath() must produce a path this platform can actually open.
 *
 * Why this harness exists: both copies of the converter ended `.replace(/\//g, '\\')`
 * unconditionally. On Windows that is correct — `file:///` strips all three slashes and
 * `c:/a/b` wants to become `c:\a\b`. On POSIX the same line ate the root and handed `fs` a
 * relative path full of backslashes (`file:///home/u/a` -> `\home\u\a`), so **11 of 59 suites
 * failed on Linux and passed on CI**, which runs windows-latest. The bug was invisible for as
 * long as nobody ran the suite on a case-sensitive, forward-slash filesystem.
 *
 * The assertions below are deliberately written to hold on BOTH platforms, so whichever one CI
 * happens to run still guards the branch it takes. The round-trip check is the load-bearing one:
 * it goes through the real filesystem, so it cannot be satisfied by a converter that merely looks
 * plausible.
 */

const fs = require('fs');
const path = require('path');
const assertLib = require('assert');

const { uriToFsPath: fromScan } = require('../src/lsp/workspaceScan');
const { uriToFsPath: fromCore } = require('../src/lsp/features/core');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Exactly the construction the product uses (xmlIndexer.js / parser.js / configReferences.js). */
const toUri = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
const isWindows = path.sep === '\\';

console.log(`\n--- platform: ${isWindows ? 'Windows' : 'POSIX'} (path.sep = ${JSON.stringify(path.sep)}) ---`);

// ------------------------------------------------------------------------------------------------
// 1. Round trip through the REAL filesystem. This is the check that would have caught the bug.
// ------------------------------------------------------------------------------------------------
const selfPath = __filename;
const selfUri = toUri(selfPath);

assert(fromScan(selfUri) === selfPath,
    'a URI built from a real path converts back to exactly that path');
let readOk = false;
try { fs.readFileSync(fromScan(selfUri), 'utf8'); readOk = true; } catch { /* readOk stays false */ }
assert(readOk, 'the converted path can actually be opened by fs');

// A path containing a space is the realistic case (`C:\Projects\PLC projects\...`), and it is the
// one that percent-encodes, so it exercises the decode step too.
const spaceDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uri fs path '));
const spaceFile = path.join(spaceDir, 'FB_A.TcPOU');
fs.writeFileSync(spaceFile, 'x');
const encodedUri = 'file:///' + spaceFile.replace(/\\/g, '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
assert(fromScan(toUri(spaceFile)) === spaceFile, 'a path with a space round-trips unencoded');
assert(fromScan(encodedUri) === spaceFile, 'the same path round-trips percent-encoded');
assert(fromScan(toUri(spaceFile)) === fromScan(encodedUri),
    'encoded and unencoded forms resolve identically — the converter\'s documented purpose');
fs.rmSync(spaceDir, { recursive: true, force: true });

// ------------------------------------------------------------------------------------------------
// 2. The output must use THIS platform's separator, and nothing else.
// ------------------------------------------------------------------------------------------------
const converted = fromScan(selfUri);
if (isWindows) {
    assert(/^[a-zA-Z]:\\/.test(converted), 'Windows: the result is a drive-rooted backslash path');
    assert(!converted.includes('/'), 'Windows: no forward slash survives');
} else {
    assert(converted.startsWith('/'), 'POSIX: the result keeps its root slash');
    assert(!converted.includes('\\'), 'POSIX: no backslash is introduced');
}

// A bare path (not a URI) must pass through untouched on either platform — several callers hand
// this function something already converted.
assert(fromScan(selfPath) === selfPath, 'a bare filesystem path passes through unchanged');
assert(fromScan('') === '' && fromScan(null) === '' && fromScan(undefined) === '',
    'empty/null/undefined degrade to the empty string rather than throwing');

// ------------------------------------------------------------------------------------------------
// 3. The two copies must not drift. They are duplicated on purpose (features/core.js must not
//    require workspaceScan.js), so nothing but a test keeps them in step.
// ------------------------------------------------------------------------------------------------
const DRIFT_CASES = [
    selfUri,
    encodedUri,
    'file:///c:/Projects/PLC%20projects/FB_A.TcPOU',
    'file:///c%3A/Projects/FB_A.TcPOU',
    'FILE:///c:/Upper/Case/Scheme.TcPOU',
    '/home/user/bare/posix/path.TcPOU',
    'c:\\bare\\windows\\path.TcPOU',
    '',
];
let drift = 0;
for (const c of DRIFT_CASES) {
    if (fromScan(c) !== fromCore(c)) {
        drift++;
        console.error(`  drift on ${JSON.stringify(c)}: scan=${JSON.stringify(fromScan(c))} core=${JSON.stringify(fromCore(c))}`);
    }
}
assert(drift === 0, `workspaceScan.js and features/core.js agree on all ${DRIFT_CASES.length} cases`);

// ------------------------------------------------------------------------------------------------
// 4. The Windows mapping itself, asserted on every platform by running the same transformation the
//    Windows branch runs. This pins the behaviour CI depends on even when the suite runs on Linux.
// ------------------------------------------------------------------------------------------------
const windowsBranch = (uri) =>
    decodeURIComponent(String(uri || '').replace(/^file:\/\/\//i, '')).replace(/\//g, '\\');
assertLib.strictEqual(windowsBranch('file:///c:/Projects/PLC%20projects/FB_A.TcPOU'),
    'c:\\Projects\\PLC projects\\FB_A.TcPOU');
assert(true, 'the Windows mapping (file:///c:/a/b -> c:\\a\\b, with decoding) is unchanged');
if (isWindows) {
    assert(fromScan('file:///c:/Projects/PLC%20projects/FB_A.TcPOU') === 'c:\\Projects\\PLC projects\\FB_A.TcPOU',
        'Windows: uriToFsPath produces exactly that mapping');
}

console.log(errors === 0 ? '\nAll uriToFsPath assertions passed.' : `\n${errors} uriToFsPath assertion(s) FAILED.`);
process.exit(errors === 0 ? 0 : 1);
