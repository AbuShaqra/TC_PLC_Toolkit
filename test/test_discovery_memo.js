/**
 * @file test_discovery_memo.js
 * @description R6 part 1: signature-file and `.tmc` discovery is memoized per SCAN, and the memo can
 * never hide an added or removed file from the next scan.
 *
 * Every project of a scan walks the workspace roots for the `library-signatures.xml` dump (it sits
 * above every project) and its own directory for the dump and the `.tmc` — 16 full walks per scan on an
 * 8-project workspace, ~850 ms on Windows. twincatWorkspace.js's `createDirectoryListingMemo` makes
 * each directory a single disk read per scan. Pinned here:
 *   1. a memoized walk returns exactly what an unmemoized walk returns (same files, same order, paths
 *      spelled from the caller's own directory);
 *   2. a scan reads each directory at most once, however many projects walk it;
 *   3. the memo is a snapshot of ONE scan: a dump or `.tmc` added after a scan is found by the next
 *      scan, and one removed is gone from it — through the real scan composition, not a stub;
 *   4. an unreadable directory stays skipped, never thrown, on a replay too.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { walkFiles, createDirectoryListingMemo, PROJECT_SKIP_DIRS } = require('../src/twincatWorkspace');
const { collectSignatureFiles, collectTmcFiles, isLibrarySymbol } = require('../src/lsp/libsymbols');
const { scanWorkspace } = require('../src/lsp/workspaceScan');
const { createIndexLibraries } = require('../src/lsp/libraryIndex');
const { normalizeProjectPath } = require('../src/lsp/projectMap');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_discovery_memo_'));

/** A minimal .plcproj compiling one POU. */
const PLCPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\MAIN.TcPOU"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`;
const POU = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="MAIN" Id="{00000000-0000-0000-0000-0000000000a1}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM MAIN
VAR
END_VAR]]></Declaration>
    <Implementation><ST><![CDATA[]]></ST></Implementation>
  </POU>
</TcPlcObject>`;
/** A dump whose only content is a global constant no other source names. */
const DUMP = `<?xml version="1.0"?>
<LibrarySignatures>
  <Library>
    <LibraryName>Memo_ProbeLib</LibraryName><Version>1.0.0.0</Version><Distributor>Synthetic</Distributor>
    <TypeSignatures>
      <TypeSignature type="VarGlobal"><Name>MemoProbeGlobals</Name>
        <Constants><Constant><Name>cMemoProbe</Name><DataType>INT</DataType></Constant></Constants>
      </TypeSignature>
    </TypeSignatures>
  </Library>
</LibrarySignatures>`;
/** A `.tmc` with one type no other source names. */
const TMC = `<?xml version="1.0"?>
<TcModuleClass><DataTypes>
  <DataType><Name>ST_MemoProbeTmc</Name><BitSize>16</BitSize>
    <SubItem><Name>nValue</Name><Type>INT</Type><BitSize>16</BitSize><BitOffs>0</BitOffs></SubItem>
  </DataType>
</DataTypes></TcModuleClass>`;

const PROJECTS = ['LineA', 'LineB', 'LineC'];
for (const name of PROJECTS) {
    const dir = path.join(root, name, `${name}_PLC`);
    fs.mkdirSync(path.join(dir, 'POUs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Docs', 'Deep', 'Deeper'), { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}_PLC.plcproj`), PLCPROJ);
    fs.writeFileSync(path.join(dir, 'POUs', 'MAIN.TcPOU'), POU);
    fs.writeFileSync(path.join(dir, 'Docs', 'Deep', 'Deeper', 'note.txt'), 'x');
}
const projectDir = (name) => path.join(root, name, `${name}_PLC`);
const dumpPath = path.join(root, 'library-signatures.xml');
const tmcPath = path.join(projectDir('LineB'), 'LineB_PLC.tmc');

// --- 1. A memoized walk is the unmemoized walk ------------------------------------------------------
fs.writeFileSync(dumpPath, DUMP);
fs.writeFileSync(path.join(projectDir('LineA'), 'library-signatures.xml'), DUMP);
fs.writeFileSync(tmcPath, TMC);
{
    const memo = createDirectoryListingMemo();
    for (const dir of [projectDir('LineA'), root, projectDir('LineB'), projectDir('LineC'), root]) {
        const plain = collectSignatureFiles(dir, []);
        const memoized = collectSignatureFiles(dir, [], memo);
        assert(JSON.stringify(plain) === JSON.stringify(memoized),
            `signature discovery under ${path.relative(root, dir) || '<root>'} is identical with and without the memo (${plain.length} file(s))`);
        const plainTmc = collectTmcFiles(dir, []);
        const memoTmc = collectTmcFiles(dir, [], memo);
        assert(JSON.stringify(plainTmc) === JSON.stringify(memoTmc),
            `.tmc discovery under ${path.relative(root, dir) || '<root>'} is identical with and without the memo (${plainTmc.length} file(s))`);
    }
    const sub = collectSignatureFiles(projectDir('LineA'), [], memo);
    assert(sub.length === 1 && sub[0].startsWith(projectDir('LineA')),
        'a replayed walk spells paths from the CALLER\'s directory, not from the walk that first read them');
}

// --- 2. Each directory is read from disk at most once per scan -------------------------------------
{
    const realReaddir = fs.readdirSync;
    let calls = 0;
    fs.readdirSync = function (...args) { calls++; return realReaddir.apply(fs, args); };
    try {
        const memo = createDirectoryListingMemo();
        for (const name of PROJECTS) {
            collectSignatureFiles(projectDir(name), [], memo);
            collectSignatureFiles(root, [], memo);
            collectTmcFiles(projectDir(name), [], memo);
        }
        const distinct = new Set();
        walkFiles(root, { skipDirs: PROJECT_SKIP_DIRS, isMatch: () => false, listing: { list: (d) => { distinct.add(d); return realReaddir.call(fs, d, { withFileTypes: true }); }, reads: () => 0 } });
        assert(calls === distinct.size && memo.reads() === distinct.size,
            `3 projects x 3 walks read ${calls} directories from disk — exactly the ${distinct.size} distinct ones, once each`);
    } finally {
        fs.readdirSync = realReaddir;
    }
}

// --- 3. Through the real scan: the memo never outlives its scan ------------------------------------
fs.rmSync(path.join(projectDir('LineA'), 'library-signatures.xml'));
fs.rmSync(dumpPath);
fs.rmSync(tmcPath);
const indexLibraries = createIndexLibraries();
const scan = () => scanWorkspace([root], { indexLibraries });
const keyOf = (name) => normalizeProjectPath(path.join(projectDir(name), `${name}_PLC.plcproj`));
{
    const before = scan();
    assert(PROJECTS.every(n => !isLibrarySymbol('cMemoProbe', before.indexForKey(keyOf(n)))),
        'no dump on disk: no project knows the dump-only constant (the probe is a real signal)');
    assert(!isLibrarySymbol('ST_MemoProbeTmc', before.indexForKey(keyOf('LineB'))),
        'no .tmc on disk: LineB does not know the .tmc-only type');

    fs.writeFileSync(dumpPath, DUMP);
    fs.writeFileSync(tmcPath, TMC);
    const added = scan();
    assert(PROJECTS.every(n => isLibrarySymbol('cMemoProbe', added.indexForKey(keyOf(n)))),
        'a dump ADDED at the workspace root after a scan is found by the next scan, in every project');
    assert(isLibrarySymbol('ST_MemoProbeTmc', added.indexForKey(keyOf('LineB'))),
        'a .tmc ADDED after a scan is found by the next scan');
    assert(!isLibrarySymbol('ST_MemoProbeTmc', added.indexForKey(keyOf('LineA'))),
        'the new .tmc stays in its own project (a shared memo is a listing cache, not a result cache)');

    fs.rmSync(dumpPath);
    fs.rmSync(tmcPath);
    const removed = scan();
    assert(PROJECTS.every(n => !isLibrarySymbol('cMemoProbe', removed.indexForKey(keyOf(n)))),
        'a dump REMOVED after a scan is gone from the next scan');
    assert(!isLibrarySymbol('ST_MemoProbeTmc', removed.indexForKey(keyOf('LineB'))),
        'a .tmc REMOVED after a scan is gone from the next scan');

    // Deep below a project: a guard on the project directory's own mtime would miss this (adding a
    // file changes only its immediate parent's mtime), which is why the memo uses no such guard.
    const nested = path.join(projectDir('LineC'), 'Docs', 'Deep', 'Deeper', 'library-signatures.xml');
    fs.writeFileSync(nested, DUMP);
    const deep = scan();
    assert(isLibrarySymbol('cMemoProbe', deep.indexForKey(keyOf('LineC'))),
        'a dump added three directories below a project is found by the next scan');
    fs.rmSync(nested);
}

// --- 4. Unreadable directories stay skipped on replay ----------------------------------------------
{
    const memo = createDirectoryListingMemo();
    const missing = path.join(root, 'does-not-exist');
    let threw = false;
    try {
        collectSignatureFiles(missing, [], memo);
        collectSignatureFiles(missing, [], memo);
    } catch (e) {
        threw = true;
    }
    assert(!threw && memo.reads() === 1, 'a missing directory is skipped (never thrown) and read only once');
}

fs.rmSync(root, { recursive: true, force: true });

if (errors > 0) {
    console.error(`\n${errors} discovery-memo assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll discovery-memo assertions passed.');
