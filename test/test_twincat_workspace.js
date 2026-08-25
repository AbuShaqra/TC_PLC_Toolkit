/**
 * @file test_twincat_workspace.js
 * @description twincatWorkspace.js is the single owner of discovery knowledge (the directory
 * walker, every skip-dir set, the extension vocabularies, XML attribute decoding, and the
 * duplicate-name suffix core). Every other module that used to carry its own copy of one of these
 * now imports it from here, so this harness pins the exact set memberships and the two suffix
 * behaviours literally — a silent drift in any of them would otherwise only surface as a subtle
 * regression three modules away.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`[PASS] ${name}`); }
    catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failures++; }
}

// The module must not exist yet on the red run; once implemented this require resolves.
const twincatWorkspace = require('../src/twincatWorkspace');
const {
    decodeXmlAttribute,
    walkFiles,
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
} = twincatWorkspace;

// =====================================================================================
// 1. decodeXmlAttribute — null-safe 7-entity chain (solutionMap's R5 superset variant)
// =====================================================================================

check('decodes all 7 legal XML attribute entities', () => {
    assert.strictEqual(decodeXmlAttribute('&lt;'), '<');
    assert.strictEqual(decodeXmlAttribute('&gt;'), '>');
    assert.strictEqual(decodeXmlAttribute('&quot;'), '"');
    assert.strictEqual(decodeXmlAttribute('&apos;'), "'");
    assert.strictEqual(decodeXmlAttribute('&amp;'), '&');
    assert.strictEqual(decodeXmlAttribute('&#65;'), 'A');
    assert.strictEqual(decodeXmlAttribute('&#x41;'), 'A');
});

check('&amp; decodes last, so a real folder name round-trips correctly', () => {
    assert.strictEqual(decodeXmlAttribute('time&amp;date'), 'time&date');
});

check('numeric and hex code points beyond ASCII decode via String.fromCodePoint', () => {
    assert.strictEqual(decodeXmlAttribute('&#233;'), 'é'); // é
    assert.strictEqual(decodeXmlAttribute('&#x2603;'), '☃'); // ☃
});

check('null/undefined decode to the empty string (R5 null-safe superset)', () => {
    assert.strictEqual(decodeXmlAttribute(null), '');
    assert.strictEqual(decodeXmlAttribute(undefined), '');
});

check('a plain string with no entities passes through unchanged', () => {
    assert.strictEqual(decodeXmlAttribute('POUs/MAIN.TcPOU'), 'POUs/MAIN.TcPOU');
});

// =====================================================================================
// 2. walkFiles — the shared directory walker
// =====================================================================================

const WALK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat_workspace_'));

check('walker collects matching files and skips a configured directory (case-insensitive)', () => {
    fs.mkdirSync(path.join(WALK_ROOT, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(WALK_ROOT, 'node_modules', 'pkg', 'ignored.plcproj'), 'x');
    fs.mkdirSync(path.join(WALK_ROOT, '_Libraries'), { recursive: true }); // upper-case on purpose
    fs.writeFileSync(path.join(WALK_ROOT, '_Libraries', 'ignored2.plcproj'), 'x');
    fs.mkdirSync(path.join(WALK_ROOT, 'Real'), { recursive: true });
    fs.writeFileSync(path.join(WALK_ROOT, 'Real', 'App.plcproj'), 'x');
    fs.writeFileSync(path.join(WALK_ROOT, 'Real', 'Notes.txt'), 'x');

    const skipDirs = new Set(['node_modules', '_libraries']);
    const isMatch = (name) => name.toLowerCase().endsWith('.plcproj');
    const found = walkFiles(WALK_ROOT, { skipDirs, isMatch });

    assert.strictEqual(found.length, 1, `expected exactly one match, got ${JSON.stringify(found)}`);
    assert.strictEqual(found[0], path.join(WALK_ROOT, 'Real', 'App.plcproj'));
});

check('walker accepts a single root or an array of roots identically', () => {
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat_workspace_b_'));
    fs.writeFileSync(path.join(rootB, 'Other.plcproj'), 'x');
    const isMatch = (name) => name.toLowerCase().endsWith('.plcproj');
    const single = walkFiles(rootB, { skipDirs: new Set(), isMatch });
    const arr = walkFiles([WALK_ROOT, rootB], { skipDirs: new Set(['node_modules', '_libraries']), isMatch });
    assert.strictEqual(single.length, 1, 'single-root form finds the file');
    assert.ok(arr.some(f => f === path.join(rootB, 'Other.plcproj')), 'array-root form includes it too');
    fs.rmSync(rootB, { recursive: true, force: true });
});

check('walker survives an unreadable subdirectory without throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat_workspace_unreadable_'));
    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'hidden.plcproj'), 'x');
    fs.writeFileSync(path.join(root, 'visible.plcproj'), 'x');

    // Probe whether the chmod is actually ENFORCED, not merely accepted: Windows accepts
    // chmod(0o000) on a directory without restricting reads (mode bits need ACLs there), and
    // root reads a 0o000 dir regardless. If we can still readdir it, skip cleanly.
    let chmodWorked = true;
    try { fs.chmodSync(blocked, 0o000); } catch (e) { chmodWorked = false; }
    let enforced = false;
    if (chmodWorked) {
        try { fs.readdirSync(blocked); } catch (e) { enforced = true; }
    }
    if (!enforced) {
        console.log('[SKIP] unreadable-directory check (chmod not enforced for this process/platform)');
        try { fs.chmodSync(blocked, 0o755); } catch (e) { /* best effort */ }
        fs.rmSync(root, { recursive: true, force: true });
        return;
    }

    let found;
    assert.doesNotThrow(() => {
        found = walkFiles(root, { skipDirs: new Set(), isMatch: (name) => name.toLowerCase().endsWith('.plcproj') });
    }, 'an unreadable subdirectory must not throw out of the walk');
    assert.ok(found.includes(path.join(root, 'visible.plcproj')), 'the readable sibling is still found');
    assert.ok(!found.some(f => f.includes('blocked')), 'nothing from the unreadable directory leaks through');

    fs.chmodSync(blocked, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
});

check('walker appends to a caller-supplied out array and returns it, unsorted (discovery order)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat_workspace_unsorted_'));
    fs.mkdirSync(path.join(root, 'zzz'), { recursive: true });
    fs.mkdirSync(path.join(root, 'aaa'), { recursive: true });
    fs.writeFileSync(path.join(root, 'zzz', 'z.plcproj'), 'x');
    fs.writeFileSync(path.join(root, 'aaa', 'a.plcproj'), 'x');
    const seed = ['PRESEEDED'];
    const isMatch = (name) => name.toLowerCase().endsWith('.plcproj');
    const result = walkFiles(root, { skipDirs: new Set(), isMatch, out: seed });
    assert.strictEqual(result, seed, 'the same array instance is returned (append semantics)');
    assert.strictEqual(result[0], 'PRESEEDED', 'the pre-seeded entry is preserved, not discarded');
    assert.strictEqual(result.length, 3, 'both matches were appended');
    fs.rmSync(root, { recursive: true, force: true });
});

check('walker defaults out to a fresh empty array when omitted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat_workspace_empty_'));
    const result = walkFiles(root, { skipDirs: new Set(), isMatch: () => false });
    assert.deepStrictEqual(result, []);
    fs.rmSync(root, { recursive: true, force: true });
});

check('isMatch receives both the entry name and the full path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat_workspace_ismatch_'));
    fs.writeFileSync(path.join(root, 'thing.st'), 'x');
    let seenName = null, seenFull = null;
    walkFiles(root, {
        skipDirs: new Set(),
        isMatch: (name, full) => { seenName = name; seenFull = full; return false; }
    });
    assert.strictEqual(seenName, 'thing.st');
    assert.strictEqual(seenFull, path.join(root, 'thing.st'));
    fs.rmSync(root, { recursive: true, force: true });
});

check('walker only ever collects regular FILES, never a directory whose name matches isMatch', () => {
    // Deliberate, tracked tightening (Phase 5 Task 3 fix round): the old inline bodies of
    // libsymbols.js's collectTmcFiles/collectSignatureFiles matched on `!entry.isDirectory() &&
    // <pattern>` — the `else` branch of the directory check — with no `isFile()` gate, so a
    // symlink (or, in principle, any non-directory dirent) whose name matched the pattern was
    // collected even though it was not a regular file. walkFiles gates every match on
    // `entry.isFile()`, so a *directory* named to match isMatch is correctly excluded (proven
    // here); the narrower, harder-to-fixture symlink case is the same gate at work.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat_workspace_regularonly_'));
    fs.mkdirSync(path.join(root, 'decoy.tmc')); // a DIRECTORY whose name matches the isMatch pattern
    fs.writeFileSync(path.join(root, 'real.tmc'), 'x');
    const found = walkFiles(root, { skipDirs: new Set(), isMatch: (name) => /\.tmc$/i.test(name) });
    assert.strictEqual(found.length, 1, `expected only the regular file, got ${JSON.stringify(found)}`);
    assert.strictEqual(found[0], path.join(root, 'real.tmc'));
    fs.rmSync(root, { recursive: true, force: true });
});

// =====================================================================================
// 3. THE MATRIX — exact set memberships and their load-bearing relations
// =====================================================================================

function setEquals(actual, expectedArray, label) {
    const expected = new Set(expectedArray.map(s => s.toLowerCase()));
    const got = new Set([...actual]);
    assert.strictEqual(got.size, expected.size,
        `${label}: expected ${expected.size} entries (${[...expected].sort()}), got ${got.size} (${[...got].sort()})`);
    for (const item of expected) {
        assert.ok(got.has(item), `${label}: missing expected member '${item}'`);
    }
}

check('BASE_SKIP_DIRS = {.git, node_modules, .vscode}', () => {
    setEquals(BASE_SKIP_DIRS, ['.git', 'node_modules', '.vscode'], 'BASE_SKIP_DIRS');
});

check('PROJECT_WALK_SKIP_DIRS = BASE + _libraries, st_files, _compileinfo, _boot (7)', () => {
    setEquals(PROJECT_WALK_SKIP_DIRS,
        ['.git', 'node_modules', '.vscode', '_libraries', 'st_files', '_compileinfo', '_boot'],
        'PROJECT_WALK_SKIP_DIRS');
});

check('SOLUTION_SKIP_DIRS = BASE + _libraries, _boot, _compileinfo (6)', () => {
    setEquals(SOLUTION_SKIP_DIRS,
        ['.git', 'node_modules', '.vscode', '_libraries', '_boot', '_compileinfo'],
        'SOLUTION_SKIP_DIRS');
});

check('CONFIG_OBJECT_SKIP_DIRS = BASE + _libraries (4)', () => {
    setEquals(CONFIG_OBJECT_SKIP_DIRS, ['.git', 'node_modules', '.vscode', '_libraries'],
        'CONFIG_OBJECT_SKIP_DIRS');
});

check('ARCHIVE_SKIP_DIRS = BASE + _compileinfo, st_files (5, no _libraries)', () => {
    setEquals(ARCHIVE_SKIP_DIRS, ['.git', 'node_modules', '.vscode', '_compileinfo', 'st_files'],
        'ARCHIVE_SKIP_DIRS');
});

check('PROJECT_SKIP_DIRS = ARCHIVE_SKIP_DIRS + _libraries (6)', () => {
    setEquals(PROJECT_SKIP_DIRS,
        ['.git', 'node_modules', '.vscode', '_compileinfo', 'st_files', '_libraries'],
        'PROJECT_SKIP_DIRS');
});

check('XML_INDEX_SKIP_DIRS = BASE + _libraries', () => {
    setEquals(XML_INDEX_SKIP_DIRS, ['.git', 'node_modules', '.vscode', '_libraries'],
        'XML_INDEX_SKIP_DIRS');
});

check('ST_INDEX_SKIP_DIRS = BASE + st_files', () => {
    setEquals(ST_INDEX_SKIP_DIRS, ['.git', 'node_modules', '.vscode', 'st_files'], 'ST_INDEX_SKIP_DIRS');
});

// Load-bearing relations, called out explicitly in the brief and in DEVELOPMENT.md's Indexing
// cost rule 4: ARCHIVE_SKIP_DIRS must NEVER gain _libraries (collectArchives would go blind), and
// PROJECT_SKIP_DIRS must be exactly ARCHIVE_SKIP_DIRS plus that one entry.
check('!ARCHIVE_SKIP_DIRS.has("_libraries") — collectArchives must still see _Libraries', () => {
    assert.strictEqual(ARCHIVE_SKIP_DIRS.has('_libraries'), false);
});

check('PROJECT_SKIP_DIRS is ARCHIVE_SKIP_DIRS + _libraries and nothing else', () => {
    const expected = new Set([...ARCHIVE_SKIP_DIRS, '_libraries']);
    assert.strictEqual(PROJECT_SKIP_DIRS.size, expected.size);
    for (const item of expected) assert.ok(PROJECT_SKIP_DIRS.has(item));
    for (const item of PROJECT_SKIP_DIRS) assert.ok(expected.has(item));
});

check('sets are plain mutable Sets, not frozen', () => {
    assert.doesNotThrow(() => {
        const probe = new Set([...BASE_SKIP_DIRS]);
        probe.add('__probe__');
        assert.ok(probe.has('__probe__'));
    });
    // The exported sets themselves must tolerate mutation too (a later task's test relies on this).
    assert.doesNotThrow(() => {
        CONFIG_OBJECT_SKIP_DIRS.add('__temp_probe__');
        CONFIG_OBJECT_SKIP_DIRS.delete('__temp_probe__');
    }, 'exported skip-dir sets must not be frozen');
});

// =====================================================================================
// 4. Extension vocabularies
// =====================================================================================

check('TWINCAT_XML_EXTS = {.tcpou, .tcgvl, .tcdut, .tcio, .tctleo}', () => {
    setEquals(TWINCAT_XML_EXTS, ['.tcpou', '.tcgvl', '.tcdut', '.tcio', '.tctleo'], 'TWINCAT_XML_EXTS');
});

check('TWINCAT_EDITOR_EXTS = TWINCAT_XML_EXTS + .st (6)', () => {
    setEquals(TWINCAT_EDITOR_EXTS, ['.tcpou', '.tcgvl', '.tcdut', '.tcio', '.tctleo', '.st'],
        'TWINCAT_EDITOR_EXTS');
});

// `.tctleo` joined 2026-08-24: its omission meant an external `.TcTLEO` edit never reached the
// live LSP index (confirmed and now gated in the dev host — test/devhost/run.js).
check('TWINCAT_WATCH_EXTS = {.tcpou, .tcio, .tcgvl, .tcdut, .tctleo} (5)', () => {
    setEquals(TWINCAT_WATCH_EXTS, ['.tcpou', '.tcio', '.tcgvl', '.tcdut', '.tctleo'], 'TWINCAT_WATCH_EXTS');
});

check('TWINCAT_WATCH_EXTS is a subset of TWINCAT_XML_EXTS', () => {
    for (const ext of TWINCAT_WATCH_EXTS) assert.ok(TWINCAT_XML_EXTS.has(ext), `${ext} missing from TWINCAT_XML_EXTS`);
});

// =====================================================================================
// 5. suffixDisplayNames — the shared duplicate-name suffix core
// =====================================================================================

// Fixture: two same-named records ("Shared") in sibling directories under distinct area roots.
// The directory itself is NOT named after the record (that would need the same-named-dir
// collapse, which is a caller concern — see the dedicated collapse test below) — this mirrors how
// solutionMap.js calls suffixDisplayNames for SOLUTIONS, where dirOf is the .sln's own directory
// and no collapse is applied.
function suffixFixture(rootLabel) {
    const root = path.join(os.tmpdir(), `twincat_workspace_suffix_${rootLabel}_${Date.now()}`);
    const dirA = path.join(root, 'AreaA', 'Cell');
    const dirB = path.join(root, 'AreaB', 'Cell');
    const records = [
        { key: 'A', name: 'Shared', dir: dirA },
        { key: 'B', name: 'Shared', dir: dirB },
        { key: 'C', name: 'Unique', dir: path.join(root, 'AreaC') }
    ];
    return { root, records };
}

check('default options: solution-scoped labels use the immediate distinguishing parent ("Name — Parent")', () => {
    const { records } = suffixFixture('default');
    const labels = suffixDisplayNames(records, r => r.name, r => r.dir);
    // AreaA/Cell vs AreaB/Cell: the immediate parent ("Cell") is NOT unique between them, so the
    // suffix must climb to "AreaA / Cell" and "AreaB / Cell" respectively — matching
    // solutionMap.js's per-record depth loop exactly.
    assert.strictEqual(labels.get('A'), 'Shared — AreaA / Cell');
    assert.strictEqual(labels.get('B'), 'Shared — AreaB / Cell');
});

check('default options: a unique name passes through unsuffixed', () => {
    const { records } = suffixFixture('unique');
    const labels = suffixDisplayNames(records, r => r.name, r => r.dir);
    assert.strictEqual(labels.get('C'), 'Unique');
});

check('{includeRoot: true, sharedMaxDepth: true}: reproduces projectMap root-part behaviour', () => {
    // A root-only distinction: same name, same immediate parent chain, but under different
    // filesystem roots (drive letters on Windows; distinct tmp roots here) — this can only be
    // disambiguated when the root segment itself is part of the compared parts, which is exactly
    // what includeRoot adds (and buildProjectDisplayNames relies on for a same-named-dir collapse
    // that still needs the root to disambiguate).
    const rootX = path.join(os.tmpdir(), `twincat_workspace_rootx_${Date.now()}`);
    const rootY = path.join(os.tmpdir(), `twincat_workspace_rooty_${Date.now()}`);
    const records = [
        { key: 'X', name: 'App', dir: path.join(rootX, 'Cell') },
        { key: 'Y', name: 'App', dir: path.join(rootY, 'Cell') }
    ];
    const labels = suffixDisplayNames(records, r => r.name, r => r.dir, { includeRoot: true, sharedMaxDepth: true });
    // Both must remain distinguishable and each must literally end with its own distinguishing dir.
    assert.notStrictEqual(labels.get('X'), labels.get('Y'), 'root-only difference must still disambiguate');
    assert.ok(labels.get('X').startsWith('App — '));
    assert.ok(labels.get('Y').startsWith('App — '));
});

check('{includeRoot: true, sharedMaxDepth: true}: reproduces the exact projectMap.js duplicate-basename fixture', () => {
    // Mirrors test_project_map.js's duplicate-basename fixture literally: two ".plcproj"s both
    // named "Shared", each sitting in ITS OWN same-named directory (AreaA/Cell/Shared,
    // AreaB/Cell/Shared) — the pattern buildProjectDisplayNames's collapsing dirOf callback exists
    // for. The collapse ("skip the project's own same-named folder") is applied HERE, by the
    // caller's dirOf, exactly as projectMap.js's real call site does — never inside the shared core.
    const root = path.join(os.tmpdir(), `twincat_workspace_suffix_projectfixture_${Date.now()}`);
    const dirA = path.join(root, 'AreaA', 'Cell', 'Shared');
    const dirB = path.join(root, 'AreaB', 'Cell', 'Shared');
    const dupRecords = [
        { key: 'A', name: 'Shared', dir: dirA },
        { key: 'B', name: 'Shared', dir: dirB }
    ];
    const collapsingDirOf = (r) => {
        const sameNamedDir = path.basename(r.dir).toLowerCase() === r.name.toLowerCase();
        return sameNamedDir ? path.dirname(r.dir) : r.dir;
    };
    const labels = suffixDisplayNames(dupRecords, r => r.name, collapsingDirOf, { includeRoot: true, sharedMaxDepth: true });
    assert.strictEqual(labels.get('A'), 'Shared — AreaA / Cell');
    assert.strictEqual(labels.get('B'), 'Shared — AreaB / Cell');
});

check('separators are literal: parts joined by " / ", name/suffix joined by " — " (em dash)', () => {
    const { records } = suffixFixture('separators');
    const labels = suffixDisplayNames(records, r => r.name, r => r.dir);
    const label = labels.get('A');
    assert.ok(label.includes(' — '), `expected literal em-dash separator ' — ' in "${label}"`);
    assert.ok(label.includes(' / '), `expected literal slash separator ' / ' in "${label}"`);
    // Pin the exact character, not just presence of "some dash" (en dash / hyphen would slip past
    // a looser check).
    assert.strictEqual(label.indexOf(String.fromCharCode(0x2014)) >= 0, true, 'the dash must be U+2014 EM DASH');
});

fs.rmSync(WALK_ROOT, { recursive: true, force: true });

// =====================================================================================
// 6. Cross-pins — the two host-side call sites that stay regex/glob (Phase 5 Task 4) must still
//    name exactly the owner's vocabulary, even though they cannot import the Set directly.
// =====================================================================================

check('projectStatusBar.TWINCAT_FILE_EXTS regex source names exactly TWINCAT_EDITOR_EXTS\' members', () => {
    // projectStatusBar.js requires 'vscode' only lazily inside createProjectStatusBar (see its own
    // header comment) so this require is safe standalone, same as test_project_map.js already relies on.
    const { TWINCAT_FILE_EXTS } = require('../src/projectStatusBar');
    assert.ok(TWINCAT_FILE_EXTS instanceof RegExp, 'TWINCAT_FILE_EXTS must be exported as a RegExp');
    const match = TWINCAT_FILE_EXTS.source.match(/\\\.\(([^)]+)\)\$?$/);
    assert.ok(match, `could not parse an alternation list out of ${TWINCAT_FILE_EXTS}`);
    const regexExts = match[1].split('|').map(s => '.' + s.toLowerCase());
    setEquals(new Set(regexExts), [...TWINCAT_EDITOR_EXTS], 'projectStatusBar TWINCAT_FILE_EXTS vs TWINCAT_EDITOR_EXTS');
});

check('customEditorProvider.js findFiles glob names exactly TWINCAT_XML_EXTS\' members in both casings', () => {
    // customEditorProvider.js requires 'vscode' at module top level, so it cannot be require()d
    // here — read it as plain text and extract the glob literal instead.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'customEditorProvider.js'), 'utf8');
    const match = src.match(/findFiles\(\s*'\*\*\/\*\.\{([^}]+)\}'/);
    assert.ok(match, 'could not find the workspace.findFiles(\'**/*.{...}\') glob literal in customEditorProvider.js');
    const globExts = match[1].split(',').map(s => s.trim());

    assert.strictEqual(globExts.length, TWINCAT_XML_EXTS.size * 2,
        `expected ${TWINCAT_XML_EXTS.size * 2} glob entries (each TWINCAT_XML_EXTS member in both casings), got ${globExts.length}: ${globExts}`);

    for (const ext of TWINCAT_XML_EXTS) {
        const bare = ext.slice(1); // strip the leading '.'
        const matchingEntries = globExts.filter(s => s.toLowerCase() === bare);
        assert.strictEqual(matchingEntries.length, 2,
            `expected exactly 2 casings of '${bare}' in the glob, found ${matchingEntries.length}: ${matchingEntries}`);
        assert.ok(matchingEntries.includes(bare), `expected a lower-case '${bare}' entry in the glob`);
        assert.ok(matchingEntries.some(s => s !== bare), `expected a differently-cased '${bare}' entry in the glob (not just lower-case twice)`);
    }

    // No stray extension outside TWINCAT_XML_EXTS is named by the glob.
    for (const entry of globExts) {
        const dotted = '.' + entry.toLowerCase();
        assert.ok(TWINCAT_XML_EXTS.has(dotted), `glob names '${entry}', which is not a TWINCAT_XML_EXTS member`);
    }
});

console.log(`\n--- TWINCAT WORKSPACE TESTS COMPLETE with ${failures} error(s) ---`);
process.exit(failures > 0 ? 1 : 0);
