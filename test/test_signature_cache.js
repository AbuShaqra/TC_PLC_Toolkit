/**
 * @file test_signature_cache.js
 * @description `library-signatures.xml` is parsed once per workspace, merged once per project — and
 * the per-project merges must not be able to see each other.
 *
 * The cost this guards: `indexLibraries` runs per project and `server.js` additionally scans every
 * workspace root for a dump, so on the real 8-project workspace the same 8.15 MB of XML was parsed
 * dozens of times per scan (parse 68 ms per pass, merge only 13 ms — so the parse is the cacheable
 * half and the merge is not).
 *
 * The correctness this guards is the more important half. The merge rewrites each record's
 * `namespace` to the one the asking project's `.plcproj` imports the library under and then stores
 * that same object in the project's registry, where `indexBrowserCache` later pushes methods and
 * properties onto it. Caching the *records* instead of the *parse* would hand every project the same
 * objects, and one project's namespace attribution and library members would surface in another —
 * the exact cross-project contamination the per-project registries exist to prevent. So the isolation
 * section below asserts object IDENTITY, not just equal values: two projects that merely happen to
 * agree today would still be one shared mutation away from disagreeing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    readSignatureRecords,
    readBrowserCacheDoc,
    clearParseCaches,
    __stats
} = require('../src/lsp/parseCache');
const {
    indexLibraryTitles,
    indexLibrarySignatures,
    getLibraryType,
    isLibrarySymbol
} = require('../src/lsp/libsymbols');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ── Fixture: three projects under one workspace root, one dump at the root ───────────────────────
// This is the normal TwinCAT layout: `twincat.updateLibraryDefinitions` writes the dump to
// `folders[0].fsPath`, one level ABOVE every `.plcproj` directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_sigcache_'));
const dump = path.join(root, 'library-signatures.xml');

fs.writeFileSync(dump, `<?xml version="1.0"?>
<LibrarySignatures>
  <Library>
    <LibraryName>Acme Probe Lib</LibraryName><Version>1.0.0.0</Version><Distributor>Acme</Distributor>
    <TypeSignatures>
      <TypeSignature type="FunctionBlock"><Name>FB_Probe</Name>
        <Inputs><Input><Name>bEnable</Name><DataType>BOOL</DataType></Input></Inputs>
      </TypeSignature>
      <TypeSignature type="VarGlobal"><Name>ProbeGlobals</Name>
        <Constants><Constant><Name>cProbeMax</Name><DataType>INT</DataType></Constant></Constants>
      </TypeSignature>
    </TypeSignatures>
  </Library>
</LibrarySignatures>`);

const projects = ['A', 'B', 'C'].map(name => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.plcproj`), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <LibraryReference Include="Acme Probe Lib,1.0.0.0,Acme">
      <Namespace>AcmeProbe</Namespace>
    </LibraryReference>
  </ItemGroup>
</Project>`);
    return { name, dir, index: /** @type {Object} */ ({}) };
});

// ── 1. One parse for the whole workspace, one merge per project ──────────────────────────────────
{
    clearParseCaches();
    for (const project of projects) {
        indexLibraryTitles(project.dir, project.index);   // title -> namespace; the merge needs it
        indexLibrarySignatures(root, project.index);
    }

    assert(__stats.parses === 1, `the dump is parsed once for the workspace (parses=${__stats.parses})`);
    assert(__stats.hits === 2, `the other two projects hit the cache (hits=${__stats.hits})`);
    assert(__stats.clones === 3, `each project merges its own clone (clones=${__stats.clones})`);

    for (const project of projects) {
        assert(isLibrarySymbol('cProbeMax', project.index),
            `project ${project.name} resolves the dump's global constant`);
    }
}

// ── 2. Isolation: one project's mutations must be invisible to the next ──────────────────────────
{
    const recA = getLibraryType('FB_Probe', projects[0].index);
    const recB = getLibraryType('FB_Probe', projects[1].index);
    assert(!!recA && !!recB, 'every project has its own FB_Probe record');
    assert(recA !== recB, 'the two projects hold DIFFERENT record objects (identity, not value)');
    assert(recA.namespace === 'AcmeProbe' && recB.namespace === 'AcmeProbe',
        'both records start attributed to the namespace their .plcproj declares');

    // Exactly the two mutations the real pipeline performs: the merge rewrites `namespace`, and
    // indexBrowserCache pushes onto `methods`.
    recA.namespace = 'HijackedNS';
    if (!recA.methods) recA.methods = [];
    recA.methods.push({ name: 'LeakedMethod' });

    assert(recB.namespace === 'AcmeProbe',
        "project A's namespace rewrite does not reach project B");
    assert(!(recB.methods || []).some(m => m.name === 'LeakedMethod'),
        "project A's browsercache-style method push does not reach project B");
    assert(getLibraryType('FB_Probe', projects[2].index).namespace === 'AcmeProbe',
        'nor does either reach the third project');

    // `members` is shared ON PURPOSE — it is only ever read (makeLibraryNode hands it to a node's
    // `variables`, getLibraryCatalog copies it out), so copying it per project would be pure waste.
    // Pinned here so that "the clone is shallow" stays a decision rather than an accident.
    assert(recA.members === recB.members,
        'the read-only `members` array is deliberately shared between the clones');
}

// ── 3. An edited dump is re-parsed ───────────────────────────────────────────────────────────────
{
    const before = __stats.parses;
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(dump, future, future);
    indexLibrarySignatures(root, /** @type {Object} */ ({}));
    assert(__stats.parses === before + 1,
        `a changed mtime invalidates the cached parse (parses ${before} -> ${__stats.parses})`);
}

// ── 4. The browsercache document cache behaves the same way ──────────────────────────────────────
// Driven through readBrowserCacheDoc directly: the real caller resolves its path under
// %ProgramData%\…\Managed Libraries, which does not exist on CI.
{
    clearParseCaches();
    const bc = path.join(root, 'browsercache');
    fs.writeFileSync(bc, `<Nodes>
  <Node Name="FB_Probe" TypeGUID="{6f9dac99-8de1-4efc-8465-68ac443b7d08}" ObjectGUID="{1}">
    <Node Name="Execute" TypeGUID="{aa}" ObjectGUID="{2}"/>
    <Node Name="Busy" TypeGUID="{5a3b8626-d3e9-4f37-98b5-66420063d91e}" ObjectGUID="{3}"/>
  </Node>
</Nodes>`);

    const first = readBrowserCacheDoc(bc);
    const second = readBrowserCacheDoc(bc);
    const third = readBrowserCacheDoc(bc);
    assert(__stats.parses === 1 && __stats.hits === 2,
        `a browsercache is parsed once per workspace (parses=${__stats.parses}, hits=${__stats.hits})`);
    assert(first === second && second === third,
        'every caller gets the identical document — no clone, because nothing mutates it');
    assert(first.get('fb_probe').methods.includes('Execute') &&
           first.get('fb_probe').properties.includes('Busy'),
        'the cached document is the real parse (method and property both present)');

    const future = new Date(Date.now() + 5000);
    fs.utimesSync(bc, future, future);
    readBrowserCacheDoc(bc);
    assert(__stats.parses === 2, `a changed mtime re-parses the browsercache (parses=${__stats.parses})`);
}

// ── 5. An unreadable file yields null, never a throw ─────────────────────────────────────────────
{
    assert(readSignatureRecords(path.join(root, 'no-such-dump.xml')) === null,
        'a missing signatures dump reads as null');
    assert(readBrowserCacheDoc(path.join(root, 'no-such-browsercache')) === null,
        'a missing browsercache reads as null');
}

fs.rmSync(root, { recursive: true, force: true });

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll signature-cache assertions passed.');
