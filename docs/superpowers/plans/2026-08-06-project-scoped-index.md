# Project-Scoped Symbol Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one workspace folder holding several TwinCAT PLC projects behave correctly — each project gets its own symbol index, so same-named objects in different projects stop colliding.

**Architecture:** A new dependency-free `src/lsp/projectMap.js` answers "which `.plcproj` owns this file". The LSP server replaces its single `workspaceIndex` object with a `Map<projectKey, index>` and routes every `custom/*` request to the index owning the request's `fileUri`. The library registries (namespaces, archive symbols, `.tmc`) move from module globals to per-project registries reached through a `Symbol` key on the index itself — invisible to `Object.keys()`, so no existing iteration changes. The extension host uses the same project map for a status-bar indicator and for grouping the Objects tree.

**Tech Stack:** Plain CommonJS Node (no build step), `vscode-languageserver` over Node IPC, standalone Node test harnesses under `test/`.

## Global Constraints

- **No build/transpile step.** Plain CommonJS JavaScript. `npm run typecheck` (`tsc --noEmit`) must stay clean; the JSDoc is the type source.
- **Diagnostics on `sample/` must stay at exactly 0**, baseline 0, no slack. `test/test_sample_diagnostics.js` and `test/test_typecheck.js` ratchet it. Never raise a baseline to make a gate pass.
- **`REQUIRE_FULL_SUITE=1 npm test` must pass**, i.e. the run must stay `Coverage: FULL`.
- **Diagnostics are conservative**: anything not fully resolvable is never flagged. A scoping change must only ever *remove* diagnostics, never add one.
- **Library symbols stay registered on demand, per document** (`registerLibrarySymbolNodes`). Registering all of them up front took a diagnostics pass from 1.5 s to 78 s. Do not "simplify" this.
- **Backward compatibility for the ~30 existing test harnesses**: `getWorkspaceSymbolIndex()`, `clearWorkspaceIndex()`, `indexLibraryNamespaces(root)`, `clearLibrarySymbols()` and friends must keep working with their current signatures against module-global default state.
- **Every new/changed public function carries JSDoc** in the style of the surrounding file.
- Commit after each task. Branch: `fix/project-scoped-index`.

## File Structure

**New:**
- `src/lsp/projectMap.js` — project discovery and file→project ownership. Pure `fs`/`path`, no `vscode`, so both processes can require it.
- `src/lsp/workspaceScan.js` — the scan itself (one index per project) and the request routing, with the LSP connection injected as callbacks so a standalone harness can drive it. `server.js` keeps only the JSON-RPC wiring.
- `test/_multiproject.js` — shared fixture builder: the committed sample copied twice into a temp root, one copy diverged.
- `test/test_project_map.js` — unit tests for the project map.
- `test/test_multi_project_scope.js` — the end-to-end gate: index, diagnostics, references, config-rename, all across two projects.
- `src/projectStatusBar.js` — status-bar indicator (extension host).

**Modified:**
- `src/lsp/server.js` — `Map<projectKey, index>`, request routing, scan/reindex.
- `src/lsp/parser.js:1227` — `indexStDirectory` gains a per-file index router.
- `src/lsp/libraries.js` — namespace registry per index.
- `src/lsp/libsymbols.js` — 11 module-global Maps become a per-index registry; `archiveCache` stays shared.
- `src/lsp/features/completions.js`, `features/diagnostics.js` — pass the index to the library accessors.
- `extension.js` — types-cache delete bug, dead types broadcast, status bar wiring.
- `src/typesCache.js` — scope or delete the unscoped crawl.
- `src/treeDataProvider.js` — group roots by project.
- `DEVELOPMENT.md`, `HANDOFF.md`.

**Deliberately NOT changed:** `src/xmlParser.js`, `src/stConverter.js`, `src/renameEngine.js`, `media/*`. The live-language-feature path and the XML write path are untouched by scoping.

---

### Task 1: The project map

**Files:**
- Create: `src/lsp/projectMap.js`
- Test: `test/test_project_map.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `LOOSE_PROJECT_KEY: string` — the key for files under no `.plcproj`.
  - `normalizeProjectPath(p: string): string` — `path.resolve` + forward slashes + lower-case.
  - `findPlcProjFiles(roots: string[]): string[]` — absolute `.plcproj` paths, sorted.
  - `createProjectMap(roots: string[]): ProjectMap` where `ProjectMap` is
    `{ projects: Map<string, Project>, isEmpty(): boolean, keys(): string[], get(key): Project|null, projectFor(fsPath): string, ownersOf(fsPath): string[], displayName(key): string }`
    and `Project` is `{ key, plcprojPath, dir, name, objectPaths: Set<string> }`.

- [ ] **Step 1: Write the failing test**

Create `test/test_project_map.js`:

```js
/**
 * @file test_project_map.js
 * @description The project map decides which .plcproj owns a file.
 *
 * Two PLC projects under one workspace folder is a normal TwinCAT layout, and each is its own
 * compilation unit — symbols do NOT resolve across them in XAE. Everything downstream (one symbol
 * index per project, scoped references, scoped rename) rests on this module getting ownership right.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    LOOSE_PROJECT_KEY,
    normalizeProjectPath,
    findPlcProjFiles,
    createProjectMap
} = require('../src/lsp/projectMap');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// A root with two sibling projects; LineB additionally links LineA's shared FB.
const ROOT = path.join(os.tmpdir(), 'projmap_' + Date.now());
const A = path.join(ROOT, 'LineA');
const B = path.join(ROOT, 'LineB');
fs.mkdirSync(path.join(A, 'POUs'), { recursive: true });
fs.mkdirSync(path.join(B, 'POUs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'Loose'), { recursive: true });

for (const dir of [A, B]) {
    fs.writeFileSync(path.join(dir, 'POUs', 'MAIN.TcPOU'), '<TcPlcObject/>');
    fs.writeFileSync(path.join(dir, 'POUs', 'Orphan.TcPOU'), '<TcPlcObject/>');
}
fs.writeFileSync(path.join(A, 'POUs', 'FB_Shared.TcPOU'), '<TcPlcObject/>');
fs.writeFileSync(path.join(ROOT, 'Loose', 'Stray.TcPOU'), '<TcPlcObject/>');

fs.writeFileSync(path.join(A, 'LineA.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\MAIN.TcPOU"><SubType>Code</SubType></Compile>
    <Compile Include="POUs\\FB_Shared.TcPOU"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`);
// LineB links LineA's FB_Shared — a real TwinCAT pattern (add existing item as link).
fs.writeFileSync(path.join(B, 'LineB.plcproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0">
  <ItemGroup>
    <Compile Include="POUs\\MAIN.TcPOU"><SubType>Code</SubType></Compile>
    <Compile Include="..\\LineA\\POUs\\FB_Shared.TcPOU"><SubType>Code</SubType></Compile>
  </ItemGroup>
</Project>`);

const map = createProjectMap([ROOT]);
const keyA = normalizeProjectPath(path.join(A, 'LineA.plcproj'));
const keyB = normalizeProjectPath(path.join(B, 'LineB.plcproj'));

// --- discovery -----------------------------------------------------------------------------
assert(findPlcProjFiles([ROOT]).length === 2, 'both .plcproj files are discovered');
assert(map.projects.size === 2, 'the map holds two projects');
assert(!map.isEmpty(), 'a root with projects is not empty');
assert(map.get(keyA).name === 'LineA', 'a project carries its display name');

// --- ownership -----------------------------------------------------------------------------
assert(map.projectFor(path.join(A, 'POUs', 'MAIN.TcPOU')) === keyA, "LineA's MAIN routes to LineA");
assert(map.projectFor(path.join(B, 'POUs', 'MAIN.TcPOU')) === keyB, "LineB's MAIN routes to LineB");
assert(map.get(keyA).objectPaths.size === 2, 'LineA <Compile>s exactly its two objects');
assert(map.get(keyB).objectPaths.has(normalizeProjectPath(path.join(A, 'POUs', 'FB_Shared.TcPOU'))),
    'the linked FB_Shared is in LineB\'s object set too');

// A file two projects compile belongs to BOTH — it must be indexed into each.
const sharedOwners = map.ownersOf(path.join(A, 'POUs', 'FB_Shared.TcPOU'));
assert(sharedOwners.length === 2, `a linked file has two owners (got ${sharedOwners.length})`);
assert(sharedOwners.includes(keyA) && sharedOwners.includes(keyB), 'both projects own the linked file');
// ...but routing a REQUEST for it is single-valued: the project it physically sits under.
assert(map.projectFor(path.join(A, 'POUs', 'FB_Shared.TcPOU')) === keyA,
    'a linked file routes to the project whose directory contains it');

// Not <Compile>d anywhere: routes to the nearest ancestor project (so an open orphan still gets
// answers), and outside every project directory to the loose key.
assert(map.projectFor(path.join(B, 'POUs', 'Orphan.TcPOU')) === keyB,
    'an orphan object routes to its nearest ancestor project');
assert(map.projectFor(path.join(ROOT, 'Loose', 'Stray.TcPOU')) === LOOSE_PROJECT_KEY,
    'a file under no project routes to the loose key');
assert(map.ownersOf(path.join(ROOT, 'Loose', 'Stray.TcPOU')).length === 0,
    'a loose file is owned by no project');

// --- no project at all ---------------------------------------------------------------------
const bare = path.join(os.tmpdir(), 'projmap_none_' + Date.now());
fs.mkdirSync(bare, { recursive: true });
const empty = createProjectMap([bare]);
assert(empty.isEmpty(), 'a root with no .plcproj yields an empty map');
assert(empty.projectFor(path.join(bare, 'X.TcPOU')) === LOOSE_PROJECT_KEY,
    'with no project, everything is loose (preserves the index-everything fallback)');

// --- case-insensitivity (Windows/TwinCAT) ----------------------------------------------------
assert(map.projectFor(path.join(A, 'pous', 'main.tcpou')) === keyA,
    'ownership is case-insensitive');

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(bare, { recursive: true, force: true });

console.log(`\n--- PROJECT MAP TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/test_project_map.js`
Expected: FAIL — `Cannot find module '../src/lsp/projectMap'`.

- [ ] **Step 3: Write the implementation**

Create `src/lsp/projectMap.js`:

```js
/**
 * @file projectMap.js
 * @description Which PLC project owns which file.
 *
 * A TwinCAT solution can hold several PLC projects, and each `.plcproj` is its own compilation unit:
 * XAE does not resolve symbols across them. Opening a folder that contains more than one is normal,
 * and it used to break everything downstream, because the symbol index was one flat map keyed by
 * object name — two projects with a `GVL_System` each collapsed onto one key, last-write-wins.
 *
 * This module is the single source of truth for the partition. It is deliberately dependency-free
 * (`fs`/`path` only, no `vscode`) so the LSP server and the extension host can both require it.
 *
 * Ownership has two flavours, and they are not the same question:
 *   - `ownersOf(file)`  — every project that `<Compile>`s the file. A file linked into two projects
 *     (a real TwinCAT pattern: "add existing item as link") is owned by both and must be indexed into
 *     both, or it would read as undeclared in all but one.
 *   - `projectFor(file)` — the ONE project a request for that file routes to. Single-valued by
 *     necessity: a completion has to be answered against one index.
 */

const fs = require('fs');
const path = require('path');

/** TwinCAT object extensions a `.plcproj` can `<Compile>` (lower-cased). */
const TWINCAT_EXTS = new Set(['.tcpou', '.tcgvl', '.tcdut', '.tcio']);

/** Directories that never hold a `.plcproj`: VCS, tooling, vendor archives, generated/build output. */
const SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    '.vscode',
    '_libraries',
    'st_files',
    '_compileinfo',
    '_boot'
]);

/**
 * The project key for files under no `.plcproj` — loose `.st` files, a bare folder of TwinCAT
 * objects, anything outside every project directory. They share one index, which is exactly the
 * pre-existing "no project found, index everything" behaviour.
 * @type {string}
 */
const LOOSE_PROJECT_KEY = '(loose)';

/**
 * Normalizes an absolute path for comparison: resolved, forward slashes, lower-cased. The extension
 * targets Windows/TwinCAT and the rest of the codebase already compares paths case-insensitively.
 * @param {string} p Absolute path.
 * @returns {string} Comparison key.
 */
function normalizeProjectPath(p) {
    return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Recursively finds every `.plcproj` under the given roots.
 * @param {Array<string>} roots Absolute workspace-root paths.
 * @returns {Array<string>} Absolute `.plcproj` paths, sorted for deterministic ordering.
 */
function findPlcProjFiles(roots) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return; // unreadable directory: skip, never throw out of discovery
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
                walk(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj')) {
                out.push(full);
            }
        }
    };
    for (const root of (roots || [])) walk(root);
    out.sort();
    return out;
}

/**
 * The TwinCAT objects a single `.plcproj` compiles.
 * @param {string} plcprojPath Absolute `.plcproj` path.
 * @returns {Set<string>} Normalized absolute object paths (empty when the file is unreadable).
 */
function readCompileIncludes(plcprojPath) {
    let xml;
    try {
        xml = fs.readFileSync(plcprojPath, 'utf8');
    } catch (e) {
        return new Set();
    }
    const projDir = path.dirname(plcprojPath);
    const out = new Set();
    // <Compile Include="POUs\Modules\FB_Loading.TcPOU"> — relative to the .plcproj, and TwinCAT
    // writes backslashes regardless of platform. A link uses the same element with a ..\ path.
    const includeRe = /<Compile\b[^>]*?\bInclude="([^"]+)"/gi;
    let m;
    while ((m = includeRe.exec(xml)) !== null) {
        const abs = path.resolve(projDir, m[1].replace(/\\/g, path.sep));
        if (TWINCAT_EXTS.has(path.extname(abs).toLowerCase())) out.add(normalizeProjectPath(abs));
    }
    return out;
}

/**
 * @typedef {Object} Project
 * @property {string} key Normalized `.plcproj` path — the partition key.
 * @property {string} plcprojPath Absolute `.plcproj` path, in its on-disk spelling.
 * @property {string} dir The project directory (where the `.plcproj` sits).
 * @property {string} name Display name (the `.plcproj` basename without extension).
 * @property {Set<string>} objectPaths Normalized paths of the objects this project `<Compile>`s.
 */

/**
 * Builds the workspace's project partition.
 * @param {Array<string>} roots Absolute workspace-root paths.
 * @returns {{projects: Map<string, Project>, isEmpty: function(): boolean, keys: function(): string[],
 *   get: function(string): Project|null, projectFor: function(string): string,
 *   ownersOf: function(string): string[], displayName: function(string): string}}
 */
function createProjectMap(roots) {
    const projects = new Map();
    /** @type {Map<string, string[]>} normalized object path → the keys of every project compiling it. */
    const owners = new Map();

    for (const plcprojPath of findPlcProjFiles(roots)) {
        const key = normalizeProjectPath(plcprojPath);
        const objectPaths = readCompileIncludes(plcprojPath);
        projects.set(key, {
            key,
            plcprojPath,
            dir: path.dirname(plcprojPath),
            name: path.basename(plcprojPath, path.extname(plcprojPath)),
            objectPaths
        });
        for (const obj of objectPaths) {
            if (!owners.has(obj)) owners.set(obj, []);
            owners.get(obj).push(key);
        }
    }

    /** The project directory as a normalized prefix, so `startsWith` cannot match a sibling. */
    const dirPrefix = (proj) => normalizeProjectPath(proj.dir) + '/';

    /**
     * The project whose directory is the longest prefix of the path.
     * @param {string} norm Normalized file path.
     * @param {Array<Project>} candidates Projects to consider.
     * @returns {Project|null}
     */
    const nearestByDirectory = (norm, candidates) => {
        let best = null;
        for (const proj of candidates) {
            const prefix = dirPrefix(proj);
            if (!norm.startsWith(prefix)) continue;
            if (!best || prefix.length > dirPrefix(best).length) best = proj;
        }
        return best;
    };

    const projectFor = (fsPath) => {
        if (!fsPath) return LOOSE_PROJECT_KEY;
        const norm = normalizeProjectPath(fsPath);
        const owning = owners.get(norm);
        if (owning && owning.length === 1) return owning[0];
        // Either several projects compile it (a link) or none does (an orphan, a new file, a .st).
        // Both route the same way: the project the file physically sits under. A link therefore
        // answers requests from its home project, while still being indexed into every owner.
        const candidates = owning && owning.length > 1
            ? owning.map(k => projects.get(k))
            : Array.from(projects.values());
        const best = nearestByDirectory(norm, candidates);
        if (best) return best.key;
        return owning && owning.length > 1 ? owning[0] : LOOSE_PROJECT_KEY;
    };

    const ownersOf = (fsPath) => {
        if (!fsPath) return [];
        const owning = owners.get(normalizeProjectPath(fsPath));
        return owning && owning.length ? owning.slice() : [];
    };

    return {
        projects,
        isEmpty: () => projects.size === 0,
        keys: () => Array.from(projects.keys()),
        get: (key) => projects.get(key) || null,
        projectFor,
        ownersOf,
        displayName: (key) => (key === LOOSE_PROJECT_KEY
            ? 'Loose files'
            : ((projects.get(key) || {}).name || key))
    };
}

module.exports = {
    LOOSE_PROJECT_KEY,
    TWINCAT_EXTS,
    normalizeProjectPath,
    findPlcProjFiles,
    readCompileIncludes,
    createProjectMap
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/test_project_map.js`
Expected: PASS on all assertions, exit 0.

- [ ] **Step 5: Run the full suite and the type-check**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; suite green with one additional harness (`project_map`). No existing suite changes behaviour — nothing imports the new module yet.

- [ ] **Step 6: Commit**

```bash
git add src/lsp/projectMap.js test/test_project_map.js
git commit -m "feat(lsp): add project map — which .plcproj owns which file"
```

---

### Task 2: One symbol index per project

**Files:**
- Create: `src/lsp/workspaceScan.js`
- Modify: `src/lsp/server.js:27` (the `workspaceIndex` global), `:142-163` (`collectConfigObjectFiles` moves out), `:171-194` (`onInitialize`), `:274-343` (the `custom/*` handlers), `:397-423` (`custom/reindex`), `:449-457` (`custom/indexXmlDocument`)
- Modify: `src/lsp/parser.js:1227` (`indexStDirectory` gains a router)
- Create: `test/_multiproject.js`
- Create: `test/test_multi_project_scope.js`

**Why a separate `workspaceScan.js`:** `server.js` opens an IPC connection at require time, so nothing in it can be loaded by a standalone harness. Putting the scan and the request routing in their own module — with the connection injected as two log callbacks — makes the behaviour this plan is built to fix into something a test can actually assert, instead of a manual dev-host check. `server.js` keeps only the JSON-RPC wiring.

**Interfaces:**
- Consumes: `createProjectMap`, `LOOSE_PROJECT_KEY`, `normalizeProjectPath` from Task 1.
- Produces (from `src/lsp/workspaceScan.js`):
  - `scanWorkspace(rootPaths: string[], deps: {log?: (m: string) => void, error?: (m: string) => void, indexLibraries?: (dir: string, index: Object) => void}): Workspace`
  - `Workspace` = `{ projectMap, indexes: Map<string, Object>, rootPaths: string[], indexForKey(key: string): Object, indexForUri(fileUri: string): Object, projectForUri(fileUri: string): Object|null, configFilesFor(fileUri: string): string[] }`
  - `createEmptyWorkspace(): Workspace` — the pre-scan state, so handlers never see `null`.
  - `uriToFsPath(uri: string): string` — moved here from `server.js:60` so both modules share one implementation.
- Produces (from `test/_multiproject.js`, used by Tasks 3 and 4):
  - `buildTwoProjectFixture(): {root: string, lineA: string, lineB: string, plcprojA: string, plcprojB: string, cleanup(): void}` — the committed sample copied to `LineA`/`LineB` under one temp root, with `LineB`'s `GVL_System` missing `fbDerived`.
  - `objectPath(projectDir: string, relative: string): string` — absolute path of a sample object inside a fixture copy.
- Produces (from `src/lsp/parser.js`): `indexStDirectory(dirPath, index, indexForFile?)` where `indexForFile` is `(fsPath: string) => Object`.

- [ ] **Step 1: Write the shared fixture builder**

Create `test/_multiproject.js`:

```js
/**
 * @file _multiproject.js
 * @description Fixture: the committed sample project copied twice under ONE workspace root.
 *
 * This is the reported bug's real shape — a folder holding several TwinCAT projects whose objects
 * share names. LineB is diverged the way two real machine projects diverge (its GVL_System has no
 * fbDerived), so a leak from B into A shows up as a diagnostic on A's correct code rather than as a
 * silent pass. Shared by the scope, library and rename harnesses so they cannot drift.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** The committed synthetic sample — ground truth, and correct TwinCAT code. */
const SAMPLE_PROJECT = path.join(__dirname, '..', 'sample', 'TcToolkitSample');

/**
 * True when the sample is present. Harnesses skip cleanly (exit 0) when it is not, the way every
 * other sample-based harness does; test/run.js then reports the run as REDUCED.
 * @returns {boolean}
 */
function sampleAvailable() {
    return fs.existsSync(SAMPLE_PROJECT);
}

/**
 * Absolute path of a sample object inside one fixture copy.
 * @param {string} projectDir A fixture copy root (the `lineA`/`lineB` returned by the builder).
 * @param {string} relative Path relative to the PLC project, e.g. 'POUs/MAIN.TcPOU'.
 * @returns {string} Absolute path.
 */
function objectPath(projectDir, relative) {
    return path.join(projectDir, 'TcToolkitSample_PLC', ...relative.split('/'));
}

/**
 * Builds the two-project fixture in a temp directory.
 * @returns {{root: string, lineA: string, lineB: string, plcprojA: string, plcprojB: string,
 *   cleanup: function(): void}}
 */
function buildTwoProjectFixture() {
    const root = path.join(os.tmpdir(), 'tc_multiproj_' + process.pid + '_' + Date.now());
    const lineA = path.join(root, 'LineA');
    const lineB = path.join(root, 'LineB');
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(SAMPLE_PROJECT, lineA, { recursive: true });
    fs.cpSync(SAMPLE_PROJECT, lineB, { recursive: true });

    // LineB's machine has no derived station, so its GVL_System does not declare fbDerived. LineA's
    // MAIN calls GVL_System.fbDerived.Cyclic() — correct in LineA, and a false positive if B wins.
    const bGvl = objectPath(lineB, 'GVLs/GVL_System.TcGVL');
    const patched = fs.readFileSync(bGvl, 'utf8').replace(/\n\tfbDerived.*?;/, '');
    if (patched.includes('fbDerived')) {
        throw new Error('fixture: failed to remove fbDerived from LineB GVL_System — sample changed?');
    }
    fs.writeFileSync(bGvl, patched);

    return {
        root,
        lineA,
        lineB,
        plcprojA: path.join(lineA, 'TcToolkitSample_PLC', 'TcToolkitSample_PLC.plcproj'),
        plcprojB: path.join(lineB, 'TcToolkitSample_PLC', 'TcToolkitSample_PLC.plcproj'),
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

module.exports = { SAMPLE_PROJECT, sampleAvailable, objectPath, buildTwoProjectFixture };
```

- [ ] **Step 2: Write the failing scope test**

Create `test/test_multi_project_scope.js`:

```js
/**
 * @file test_multi_project_scope.js
 * @description Two PLC projects under one workspace folder must not contaminate each other.
 *
 * The bug this guards (reported 2026-08-06, reproduced on this exact fixture): the symbol index was
 * one flat name-keyed map for the whole workspace, so LineA's and LineB's same-named objects
 * collapsed onto one key. Measured before the fix: 38 object files produced 19 index entries, every
 * shared name resolved to LineB, LineA's correct MAIN reported `"fbDerived" is not a member of type
 * "GVL_System"`, and Find References returned 7 hits of which 3 were in the wrong project.
 */

const fs = require('fs');
const path = require('path');
const { sampleAvailable, buildTwoProjectFixture, objectPath } = require('./_multiproject');

if (!sampleAvailable()) {
    console.log('sample/ project not present — skipping multi-project scope test.');
    process.exit(0);
}

const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { createProjectMap, normalizeProjectPath } = require('../src/lsp/projectMap');
const { scanWorkspace } = require('../src/lsp/workspaceScan');
const { parseAndIndexDocument } = require('../src/lsp/parser');
const { provideDiagnostics, provideReferences } = require('../src/lsp/features');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const fx = buildTwoProjectFixture();
const map = createProjectMap([fx.root]);
const keyA = normalizeProjectPath(fx.plcprojA);
const keyB = normalizeProjectPath(fx.plcprojB);

// --- the partition -------------------------------------------------------------------------
assert(map.projects.size === 2, `two projects are discovered (got ${map.projects.size})`);
const objectsA = map.get(keyA).objectPaths;
const objectsB = map.get(keyB).objectPaths;
assert(objectsA.size === objectsB.size && objectsA.size > 0,
    `both projects compile the same object count (${objectsA.size})`);
assert([...objectsA].every(p => !objectsB.has(p)), 'no object path is shared between the two copies');

// --- one index per project, built by the REAL scan --------------------------------------------
// Libraries are stubbed out: this harness is about the partition, and Task 3 covers the registries.
const ws = scanWorkspace([fx.root], { indexLibraries: () => {} });
const indexes = ws.indexes;
assert(indexes.size === 2, `the scan produces one index per project (got ${indexes.size})`);

const namesA = Object.keys(indexes.get(keyA));
const namesB = Object.keys(indexes.get(keyB));
assert(namesA.length === objectsA.size,
    `LineA indexes every one of its objects (${namesA.length} of ${objectsA.size}) — nothing is lost to a collision`);
assert(namesB.length === objectsB.size,
    `LineB indexes every one of its objects (${namesB.length} of ${objectsB.size})`);
assert(/LineA/i.test(indexes.get(keyA)['GVL_System'].uri), "LineA's GVL_System resolves inside LineA");
assert(/LineB/i.test(indexes.get(keyB)['GVL_System'].uri), "LineB's GVL_System resolves inside LineB");
assert(/LineA/i.test(indexes.get(keyA)['MAIN'].uri), "LineA's MAIN resolves inside LineA");

// --- diagnostics: correct code in BOTH projects scores zero ---------------------------------
/**
 * Diagnoses one object the way server.js does.
 * @param {string} file Absolute object path.
 * @param {Object} index The owning project's index.
 * @returns {{diags: Array<Object>, stText: string, uri: string}}
 */
function diagnose(file, index) {
    const parsed = parseTwinCatXml(fs.readFileSync(file, 'utf8'));
    const { stText } = convertXmlToSt(parsed, { raw: true });
    const uri = 'file:///' + file.replace(/\\/g, '/');
    parseAndIndexDocument(stText, uri, index);
    return { diags: provideDiagnostics(stText, index, uri), stText, uri };
}

const mainA = objectPath(fx.lineA, 'POUs/MAIN.TcPOU');
const a = diagnose(mainA, indexes.get(keyA));
assert(a.diags.length === 0,
    `LineA MAIN scores 0 diagnostics (got ${a.diags.length}: ${a.diags.map(d => d.message).join(' | ')})`);

const mainB = objectPath(fx.lineB, 'POUs/MAIN.TcPOU');
const b = diagnose(mainB, indexes.get(keyB));
// LineB genuinely calls a member its own GVL_System no longer declares — the fixture's divergence.
// It must be flagged in B and must NOT be silenced by A's copy.
assert(b.diags.some(d => /fbDerived/.test(d.message)),
    "LineB's own missing fbDerived is still reported in LineB (A's copy does not mask it)");

// --- references never cross the project boundary ---------------------------------------------
const lines = a.stText.split('\n');
const line = lines.findIndex(l => l.includes('GVL_System.fbCylinder'));
const character = lines[line].indexOf('GVL_System') + 2;
const refs = provideReferences(a.stText, { line, character }, indexes.get(keyA), a.uri) || [];
assert(refs.length > 0, `references are found at all (got ${refs.length})`);
assert(refs.every(r => /LineA/i.test(r.uri)),
    `every reference stays in LineA (leaked: ${refs.filter(r => !/LineA/i.test(r.uri)).map(r => r.uri).join(', ')})`);

// --- routing -----------------------------------------------------------------------------------
assert(map.projectFor(mainA) === keyA, 'a request for LineA MAIN routes to LineA');
assert(map.projectFor(mainB) === keyB, 'a request for LineB MAIN routes to LineB');
assert(ws.indexForUri('file:///' + mainA.replace(/\\/g, '/')) === indexes.get(keyA),
    "the scan routes a request for LineA's MAIN to LineA's index");
assert(ws.indexForUri('file:///' + mainB.replace(/\\/g, '/')) === indexes.get(keyB),
    "the scan routes a request for LineB's MAIN to LineB's index");

fx.cleanup();
console.log(`\n--- MULTI-PROJECT SCOPE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node test/test_multi_project_scope.js`
Expected: FAIL — `Cannot find module '../src/lsp/workspaceScan'`. Every assertion after that point is unreachable until Step 5 exists, which is the point: this harness asserts against the real scan, not against a model of it.

- [ ] **Step 4: Add the per-file router to `indexStDirectory`**

In `src/lsp/parser.js:1227`, replace the signature and the two recursion/index sites:

```js
/**
 * Scans directories recursively for standalone .st files to index. The generated-export folder
 * (ST_Files) is skipped: those are derived from the XML objects and would shadow them in the index.
 * @param {string} dirPath Absolute folder path.
 * @param {Object} [index] Fallback index, used when no router is supplied.
 * @param {function(string): Object} [indexForFile] Routes a file to its owning project's index. A
 *   workspace with several .plcproj files has one index per project, and a loose .st belongs to the
 *   project whose directory contains it.
 */
function indexStDirectory(dirPath, index = workspaceSymbolIndex, indexForFile = null) {
    if (!fs.existsSync(dirPath)) return;
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.vscode' || entry.name === 'ST_Files') {
                continue;
            }
            indexStDirectory(fullPath, index, indexForFile);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.st')) {
            try {
                const code = fs.readFileSync(fullPath, 'utf8');
                const fileUri = 'file:///' + fullPath.replace(/\\/g, '/');
                parseAndIndexDocument(code, fileUri, indexForFile ? indexForFile(fullPath) : index);
            } catch (err) {
                console.error(`Failed to parse and index ${entry.name}:`, err);
            }
        }
    }
}
```

- [ ] **Step 5: Create `src/lsp/workspaceScan.js`**

```js
/**
 * @file workspaceScan.js
 * @description The workspace partition: one symbol index per PLC project, and the routing that
 * decides which index answers a request.
 *
 * This lives outside server.js on purpose. server.js opens an IPC connection at require time, so
 * nothing in it is loadable by a standalone harness — and the behaviour here (which project owns a
 * file, which index a request lands in, which configuration objects a rename may touch) is exactly
 * what needs a regression gate. The connection is injected as log callbacks instead.
 *
 * The `.plcproj` — not the filesystem — defines a project. An object on disk but absent from every
 * `.plcproj` (a backup or experimental copy) is never indexed and so cannot shadow a real object.
 * An object linked into two projects is indexed into BOTH, because it genuinely belongs to both.
 */

const fs = require('fs');
const path = require('path');

const { indexXmlFile, indexTwinCatDirectory } = require('./xmlIndexer');
const { indexStDirectory } = require('./parser');
const {
    LOOSE_PROJECT_KEY,
    createProjectMap,
    normalizeProjectPath
} = require('./projectMap');

/**
 * TwinCAT non-code object extensions that can carry a PLC symbol reference (lower-cased): the two
 * visualization formats, the two text-list formats, and the task configuration.
 * @type {Set<string>}
 */
const CONFIG_OBJECT_EXTS = new Set(['.tcvis', '.tcvmo', '.tctlo', '.tcgtlo', '.tctto']);

/** Directories skipped when walking for configuration objects — the same set the XML indexer skips. */
const CONFIG_OBJECT_SKIP_DIRS = new Set(['.git', 'node_modules', '.vscode', '_libraries']);

/**
 * Converts an LSP file URI (file:///C:/...) to a filesystem path.
 * @param {string} uri File or folder URI.
 * @returns {string} Filesystem path.
 */
function uriToFsPath(uri) {
    return decodeURIComponent(String(uri || '').replace(/^file:\/\/\//i, '')).replace(/\//g, '\\');
}

/**
 * Recursively collects every TwinCAT configuration object under the given roots. Rename is a rare,
 * deliberate action, so an on-demand walk is fine — no standing index of these files is kept.
 * @param {Array<string>} roots Absolute paths to walk.
 * @returns {Array<string>} Absolute configuration-object file paths.
 */
function collectConfigObjectFiles(roots) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (CONFIG_OBJECT_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
                walk(full);
            } else if (entry.isFile()) {
                if (CONFIG_OBJECT_EXTS.has(path.extname(entry.name).toLowerCase())) out.push(full);
            }
        }
    };
    for (const root of (roots || [])) walk(root);
    return out;
}

/**
 * @typedef {Object} Workspace
 * @property {Object|null} projectMap The partition (see projectMap.js), or null before a scan.
 * @property {Map<string, Object>} indexes Project key → symbol index.
 * @property {Array<string>} rootPaths The workspace roots this was scanned from.
 * @property {function(string): Object} indexForKey
 * @property {function(string): Object} indexForUri
 * @property {function(string): Object|null} projectForUri
 * @property {function(string): Array<string>} configFilesFor
 */

/**
 * Wraps a set of indexes and a partition in the routing API the request handlers use.
 * @param {Object|null} projectMap The partition, or null.
 * @param {Array<string>} rootPaths Workspace roots.
 * @returns {Workspace}
 */
function makeWorkspace(projectMap, rootPaths) {
    const indexes = new Map();

    const indexForKey = (key) => {
        if (!indexes.has(key)) indexes.set(key, {});
        return indexes.get(key);
    };

    const keyForUri = (fileUri) => {
        if (!projectMap) return LOOSE_PROJECT_KEY;
        return projectMap.projectFor(uriToFsPath(fileUri));
    };

    return {
        projectMap,
        indexes,
        rootPaths,
        indexForKey,
        indexForUri: (fileUri) => indexForKey(keyForUri(fileUri)),
        projectForUri: (fileUri) => {
            if (!projectMap) return null;
            return projectMap.get(keyForUri(fileUri));
        },
        /**
         * The configuration objects a rename of a symbol in this file may touch — its own project's,
         * and nothing else. An unscoped walk rewrites the OTHER project's .TcVIS/.TcTLO/.TcTTO:
         * those name PLC symbols by bare name, two projects share object names, and the edit breaks
         * the neighbour's XAE build in a file the user never opened.
         * @param {string} fileUri The renamed symbol's document URI.
         * @returns {Array<string>} Absolute configuration-object paths.
         */
        configFilesFor: (fileUri) => {
            if (!projectMap) return collectConfigObjectFiles(rootPaths);
            const project = projectMap.get(keyForUri(fileUri));
            if (!project) return collectConfigObjectFiles(rootPaths);
            return collectConfigObjectFiles([project.dir]);
        }
    };
}

/**
 * The pre-scan state, so a handler that fires before onInitialize never sees null.
 * @returns {Workspace}
 */
function createEmptyWorkspace() {
    return makeWorkspace(null, []);
}

/**
 * Discovers the projects under the given roots and indexes each one's objects into its own index.
 * @param {Array<string>} rootPaths Absolute workspace-root paths.
 * @param {{log?: function(string): void, error?: function(string): void,
 *   indexLibraries?: function(string, Object): void}} [deps] Injected side effects. `indexLibraries`
 *   is stubbed by the harnesses that only care about the partition.
 * @returns {Workspace}
 */
function scanWorkspace(rootPaths, deps) {
    const { log = () => {}, error = () => {}, indexLibraries = () => {} } = deps || {};
    const roots = rootPaths || [];
    const projectMap = createProjectMap(roots);
    const workspace = makeWorkspace(projectMap, roots.slice());

    if (projectMap.isEmpty()) {
        // No .plcproj anywhere: a fresh clone, or a loose folder of TwinCAT files. Index everything
        // into one index — the pre-existing fallback, unchanged.
        const loose = workspace.indexForKey(LOOSE_PROJECT_KEY);
        for (const root of roots) {
            try {
                indexTwinCatDirectory(loose, root, null);
                indexStDirectory(root, loose);
                indexLibraries(root, loose);
            } catch (e) {
                error(`Failed to index folder ${root}: ${e.message}`);
            }
        }
        return workspace;
    }

    for (const project of projectMap.projects.values()) {
        const index = workspace.indexForKey(project.key);
        for (const objectPath of project.objectPaths) {
            indexXmlFile(index, objectPath);
        }
        try {
            indexLibraries(project.dir, index);
        } catch (e) {
            error(`Failed to index libraries for ${project.name}: ${e.message}`);
        }
    }

    // Loose .st files route to the project whose directory contains them (loose index otherwise).
    const routeFile = (fsPath) => workspace.indexForKey(projectMap.projectFor(fsPath));
    for (const root of roots) {
        try {
            indexStDirectory(root, workspace.indexForKey(LOOSE_PROJECT_KEY), routeFile);
        } catch (e) {
            error(`Failed to index .st files under ${root}: ${e.message}`);
        }
    }

    log(`Indexed ${projectMap.projects.size} PLC project(s): ` + projectMap.keys()
        .map(k => `${projectMap.displayName(k)} (${Object.keys(workspace.indexForKey(k)).length} symbols)`)
        .join(', '));
    return workspace;
}

module.exports = {
    CONFIG_OBJECT_EXTS,
    uriToFsPath,
    collectConfigObjectFiles,
    createEmptyWorkspace,
    scanWorkspace,
    normalizeProjectPath
};
```

- [ ] **Step 6: Rewire `server.js` onto it**

Delete from `src/lsp/server.js`: the `workspaceIndex` global (`:27`), the `workspaceRootPaths` array (`:32`), `uriToFsPath` (`:60`), `CONFIG_OBJECT_SKIP_DIRS`/`CONFIG_OBJECT_EXTS`/`collectConfigObjectFiles` (`:126-163`). Replace with:

```js
const {
    createEmptyWorkspace,
    scanWorkspace,
    uriToFsPath
} = require('./workspaceScan');

// The server OWNS the workspace and threads its indexes explicitly into the parser/indexer and every
// language-feature call, rather than reaching for the parser.js module global. There is ONE INDEX
// PER PLC PROJECT: a `.plcproj` is its own compilation unit (XAE does not resolve symbols across
// projects), and a single flat name-keyed map made two projects' same-named objects collide —
// last-write-wins, so half the workspace vanished and references pointed into the wrong project.
/** @type {import('./workspaceScan').Workspace} */
let workspace = createEmptyWorkspace();

/**
 * Rebuilds the partition and every index from the given roots.
 * @param {Array<string>} rootPaths Absolute workspace-root paths.
 */
function rescan(rootPaths) {
    workspace = scanWorkspace(rootPaths, {
        log: (m) => connection.console.log(m),
        error: (m) => connection.console.error(m),
        indexLibraries
    });
}
```

`onInitialize` becomes:

```js
connection.onInitialize((params) => {
    const folders = params.workspaceFolders;
    if (folders && folders.length > 0) {
        rescan(folders.map(f => uriToFsPath(f.uri)));
    }
    return { /* capabilities unchanged */ };
});
```

`custom/reindex` becomes:

```js
connection.onRequest('custom/reindex', (params) => {
    try {
        // The converted-file cache keys on mtime, so it self-heals on edits; this drops entries for
        // files that no longer exist (deleted or renamed) rather than letting them accumulate.
        clearStFileCache();
        if (params.folders) {
            // A .plcproj edit (a file added, removed or renamed) is exactly what triggers a reindex,
            // so the partition itself is rebuilt here — a new project must produce a new index.
            rescan(params.folders.map(f => uriToFsPath(f)));
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});
```

`indexLibraries(fsPath)` gains a second parameter `index` and forwards it to the library calls — Task 3 implements that. For this task, add the parameter and ignore it (`function indexLibraries(fsPath, index)`), so the call sites are already correct when Task 3 lands. Note `clearWorkspaceIndex`, `clearLibraryNamespaces` and `clearLibrarySymbols` are no longer called on reindex: `scanWorkspace` builds fresh indexes, and the old registries go with the old ones. Remove the now-unused imports.
- [ ] **Step 7: Route every request handler**

Replace every `workspaceIndex` use in the handlers with `workspace.indexForUri(...)`. Exact list (`src/lsp/server.js`):

| Handler | Old | New |
|---|---|---|
| `documents.onDidChangeContent` | `syncDocument(doc.getText(), doc.uri)` then `provideDiagnostics(doc.getText(), workspaceIndex, doc.uri)` | `const index = workspace.indexForUri(doc.uri); syncDocument(doc.getText(), doc.uri, index); provideDiagnostics(doc.getText(), index, doc.uri)` |
| `onCompletion` / `onDefinition` / `onReferences` | `workspaceIndex` | `workspace.indexForUri(params.textDocument.uri)` |
| `custom/completions`, `custom/definition`, `custom/references`, `custom/diagnostics` | `workspaceIndex` | `workspace.indexForUri(params.fileUri)` |
| `custom/updateDocument` | `syncDocument(params.code, params.fileUri)` | `syncDocument(params.code, params.fileUri, workspace.indexForUri(params.fileUri))` |
| `custom/referencesForSymbol` | `workspaceIndex` | `workspace.indexForUri(params.fileUri)` — the spec's field is `fileUri` (see `configReferences.js`, which reads `spec.fileUri`) |
| `custom/indexXmlDocument` | `workspaceIndex` | `workspace.indexForUri(params.fileUri)` |
| `custom/configReferencesForSymbol` | `workspaceIndex` + `collectConfigObjectFiles(workspaceRootPaths)` | `workspace.indexForUri(params.fileUri)` + `workspace.configFilesFor(params.fileUri)` — this is Task 4's fix, and it lands here for free |
| `custom/updateTypesMap` | `workspaceIndex` | leave as-is for now, routing per entry by `typeInfo.uri`; Task 5 deletes the handler |

And `syncDocument` takes the index explicitly:

```js
/**
 * Brings a project's symbol index up to date with a document before any language feature runs on it.
 * @param {string} code Structured Text of the document.
 * @param {string} fileUri Document URI.
 * @param {Object} index The owning project's symbol index.
 */
function syncDocument(code, fileUri, index) {
    parseAndIndexDocument(code, fileUri, index);
    registerLibrarySymbolNodes(index, code);
}
```

`onDocumentHighlight` needs no change — it is text-local and takes no index.

- [ ] **Step 8: Verify**

Run: `npm run typecheck && node test/test_multi_project_scope.js && npm test`
Expected: typecheck clean, the scope harness green, full suite green. `test_plcproj_scope.js` still passes — `collectPlcProjObjectPaths` is untouched and still used by nothing else; leave it in place until Task 8 removes it.

Then confirm the single-project path did not regress, which is the case that matters to every existing user:

```bash
node -e "const {scanWorkspace}=require('./src/lsp/workspaceScan');const w=scanWorkspace(['sample'],{});console.log([...w.indexes.keys()].length,'index(es),',[...w.indexes.values()].map(i=>Object.keys(i).length).join('+'),'symbols')"
```
Expected: `1 index(es), 19 symbols` — one project, every object indexed, nothing lost.

- [ ] **Step 9: Commit**

```bash
git add src/lsp/workspaceScan.js src/lsp/server.js src/lsp/parser.js test/_multiproject.js test/test_multi_project_scope.js
git commit -m "fix(lsp): one symbol index per PLC project, routed by file ownership"
```

---

### Task 3: Per-project library registries

**Files:**
- Modify: `src/lsp/libraries.js` (the `libraryNamespaces` global at `:35`, and the four exported functions)
- Modify: `src/lsp/libsymbols.js` (11 module-global Maps at `:84-221`; `archiveCache` at `:93` stays shared)
- Modify: `src/lsp/features/completions.js:690,744,749,804,814,829`, `src/lsp/features/diagnostics.js:459`
- Modify: `src/lsp/server.js` (`indexLibraries(fsPath, index)`)
- Test: extend `test/test_multi_project_scope.js`

**Interfaces:**
- Consumes: the per-project `index` object from Task 2.
- Produces:
  - `libraries.js`: `indexLibraryNamespaces(rootDir, index?)`, `isLibraryNamespace(name, index?)`, `getLibraryNamespaces(index?)`, `clearLibraryNamespaces(index?)`.
  - `libsymbols.js`: every exported accessor gains a trailing optional `index` parameter; `registerLibrarySymbolNodes(index, code)` is **unchanged** (it already receives the index and reads the registry off it).

**Severity note for the implementer:** this is the largest and least urgent task. A shared library registry produces *false negatives* only — a project stays quiet about a library it does not reference — never a wrong jump or a wrong edit, because library nodes are `external:true` and map to the anonymous UNKNOWN type. The one visible symptom is the Libraries view showing the union of both projects' libraries. **If effort has to be cut, this is the task to defer**; Tasks 1, 2, 4 and 5 are the correctness-critical ones.

- [ ] **Step 1: Write the failing test**

Append to `test/test_multi_project_scope.js`, before `fx.cleanup()`:

```js
// --- library namespaces are per project ------------------------------------------------------
// LineB additionally references a library LineA does not. A namespace known only to B must not
// silence B's namespace head inside A (that is a diagnostic suppressed on the wrong project).
const { indexLibraryNamespaces, isLibraryNamespace, clearLibraryNamespaces } = require('../src/lsp/libraries');

const plcprojB = fs.readFileSync(fx.plcprojB, 'utf8').replace(
    '</Project>',
    `  <ItemGroup>
    <PlaceholderReference Include="Tc2_LineBOnly">
      <DefaultResolution>Tc2_LineBOnly, 1.0.0.0 (Beckhoff Automation GmbH)</DefaultResolution>
      <Namespace>Tc2_LineBOnly</Namespace>
    </PlaceholderReference>
  </ItemGroup>
</Project>`);
fs.writeFileSync(fx.plcprojB, plcprojB);

const idxA = indexes.get(keyA);
const idxB = indexes.get(keyB);
clearLibraryNamespaces(idxA);
clearLibraryNamespaces(idxB);
indexLibraryNamespaces(path.dirname(fx.plcprojA), idxA);
indexLibraryNamespaces(path.dirname(fx.plcprojB), idxB);

assert(isLibraryNamespace('Tc2_LineBOnly', idxB), "LineB knows its own library namespace");
assert(!isLibraryNamespace('Tc2_LineBOnly', idxA),
    "LineA does NOT know LineB's library namespace (registries are per project)");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/test_multi_project_scope.js`
Expected: FAIL — `isLibraryNamespace('Tc2_LineBOnly', idxA)` returns `true`, because the registry is a single module-global Set.

- [ ] **Step 3: Convert `libraries.js` to a per-index registry**

Replace `src/lsp/libraries.js:35` and the four exported functions:

```js
/**
 * The registry key on a symbol index. A `Symbol` deliberately: `Object.keys()`, `for…in` and
 * `JSON.stringify` all skip symbol-keyed properties, and the index is iterated by key in several hot
 * paths (the reference scan, the GVL-global lookup in types.js). Attaching the registry to the index
 * therefore costs those loops nothing and needs no signature change where the index is already in
 * hand — notably registerLibrarySymbolNodes(index, code).
 */
const NAMESPACE_REGISTRY = Symbol.for('twincat.libraryNamespaces');

/**
 * Known library namespaces for the DEFAULT (unscoped) registry, stored lower-cased: Structured Text
 * is case-insensitive. This module global remains the fallback for callers with no index — the
 * standalone test harnesses, and any single-project path that has not been threaded yet.
 * @type {Set<string>}
 */
const libraryNamespaces = new Set();

/**
 * The namespace registry for a symbol index, created on first use.
 * @param {Object} [index] A project's symbol index. Omit for the default registry.
 * @returns {Set<string>} The lower-cased namespace set for that project.
 */
function registryFor(index) {
    if (!index) return libraryNamespaces;
    if (!index[NAMESPACE_REGISTRY]) index[NAMESPACE_REGISTRY] = new Set();
    return index[NAMESPACE_REGISTRY];
}
```

Then in `indexLibraryNamespaces`, `isLibraryNamespace`, `getLibraryNamespaces` and `clearLibraryNamespaces`, add a trailing `index` parameter and replace every `libraryNamespaces` use with `registryFor(index)`. For example:

```js
/**
 * Scans a workspace folder for .plcproj files and unions their library namespaces into the given
 * project's registry. Additive: call clearLibraryNamespaces(index) first to rebuild from scratch.
 * @param {string} rootDir Absolute folder path — for a scoped call, the PROJECT directory, so only
 *   that project's .plcproj is read.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string[]} The namespaces found in this scan (as written in the XML).
 */
function indexLibraryNamespaces(rootDir, index) {
    if (!rootDir || !fs.existsSync(rootDir)) return [];
    const registry = registryFor(index);
    const found = [];
    const files = [];
    collectPlcProjFiles(rootDir, files);
    for (const file of files) {
        let xml;
        try {
            xml = fs.readFileSync(file, 'utf8');
        } catch (e) {
            continue; // unreadable .plcproj: skip, never throw out of indexing
        }
        for (const name of extractNamespaces(xml)) {
            found.push(name);
            registry.add(name.toLowerCase());
        }
    }
    return found;
}
```

Export `NAMESPACE_REGISTRY` alongside the existing four.

- [ ] **Step 4: Convert `libsymbols.js` to a per-index registry**

Replace the 11 module-global Maps (`librarySymbols`, `namespaceSymbols`, `namespaceNames`, `libraryTitles`, `libraryCatalog`, `namespaceListCache`, `typeSystemTypes`, `typeSystemNamespaces`, `browserCacheNamespaceTypes`, `browserCacheNamespaceMembers`, `nestedNamespaceSymbols`) with a registry factory:

```js
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
 * The library registry for a symbol index, created on first use.
 * @param {Object} [index] A project's symbol index. Omit for the default registry.
 * @returns {Object} That project's library registry.
 */
function libRegistryFor(index) {
    if (!index) return defaultRegistry;
    if (!index[LIBRARY_REGISTRY]) index[LIBRARY_REGISTRY] = createLibraryRegistry();
    return index[LIBRARY_REGISTRY];
}
```

**`archiveCache` (`:93`) stays a module global and stays shared.** It is keyed by archive path and holds the decoded string table — two projects referencing the same `Tc2_System` archive must decode it once. Sharing a *cache* is correct; sharing a *namespace* is the bug.

Then, mechanically: every function in the file that touches one of the 11 maps gains a trailing optional `index` parameter, opens with `const reg = libRegistryFor(index);`, and uses `reg.<map>`. `registerLibrarySymbolNodes(index, code)` needs **no signature change** — it already has the index:

```js
function registerLibrarySymbolNodes(index, code) {
    const reg = libRegistryFor(index);
    if (!index || !code || reg.librarySymbols.size === 0) return 0;
    // …unchanged body, with librarySymbols → reg.librarySymbols and
    // typeSystemTypes → reg.typeSystemTypes
}
```

`clearLibrarySymbols(index)` clears the registry's maps but **must not** clear `archiveCache`.

- [ ] **Step 5: Thread the index through the feature call sites**

`src/lsp/features/completions.js` — the index is already a parameter of `provideCompletions(code, position, index, uri)`; pass it down to the six library accessors (`:690` `getLibraryNamespaces(index)`, `:744` `getTypeSystemNamespaceTypes(namespace, index)`, `:749` `getNamespaceSymbols(namespace, index)`, `:804` `getLibraryTypeNode(bareTypeName(member.type), index)`, `:814` inside the local `isLibraryNamespace` helper, `:829` `getNestedNamespaceSymbols(inner, index)`). Add `index` to the signature of each local helper that needs it.

`src/lsp/features/diagnostics.js:459` — `isLibraryNamespace(tok.value)` becomes `isLibraryNamespace(tok.value, index)`; the enclosing function already has `index` in scope.

`src/lsp/server.js` — `indexLibraries(fsPath, index)` forwards:

```js
function indexLibraries(fsPath, index) {
    indexLibraryNamespaces(fsPath, index);
    const stats = indexLibrarySymbols(fsPath, index);
    const tmc = indexTypeSystem(fsPath, index);
    const sig = indexLibrarySignatures(fsPath, index);
    const bc = indexBrowserCache(fsPath, index);
    // …logging unchanged
}
```

and `custom/libraries` answers per project:

```js
connection.onRequest('custom/libraries', (params) => {
    try {
        // The catalog is per project — two projects reference different libraries. The extension
        // passes the active file so the view shows that project's libraries.
        return getLibraryCatalog(indexForUri((params && params.fileUri) || ''));
    } catch (e) {
        return [];
    }
});
```

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && npm test`
Expected: all green. The ~15 library harnesses (`test_libsymbols`, `test_library_catalog`, `test_library_types`, `test_library_completion`, `test_library_methods`, `test_library_signatures*`, `test_nested_namespace`, `test_browser_cache`, `test_libraries`, `_baseline.js`) call the accessors with no index and therefore hit `defaultRegistry` — behaviour identical to today. **If any of them fails, a map reference was missed inside `libsymbols.js`; do not "fix" it by widening a baseline.**

Run: `node test/test_multi_project_scope.js`
Expected: the two new namespace assertions pass.

- [ ] **Step 7: Verify the sample ratchet in both library configurations**

Run: `REQUIRE_FULL_SUITE=1 npm test`
Then move `sample/**/_Libraries/Beckhoff Automation GmbH` aside (it is git-ignored — **move it, never delete**), re-run, and move it back.
Expected: **0 diagnostics on the sample in both configurations**, exactly as before.

- [ ] **Step 8: Commit**

```bash
git add src/lsp/libraries.js src/lsp/libsymbols.js src/lsp/features/completions.js src/lsp/features/diagnostics.js src/lsp/server.js test/test_multi_project_scope.js
git commit -m "fix(lsp): scope library namespaces, archive symbols and .tmc types per project"
```

---

### Task 4: Prove the rename config-object scan is scoped

**Files:**
- Test: extend `test/test_multi_project_scope.js`
- Modify: `src/lsp/server.js` (`custom/configReferencesForSymbol`) — only if Task 2 Step 7 left it unrouted

**Interfaces:**
- Consumes: `workspace.configFilesFor(fileUri)` and `workspace.indexForUri(fileUri)` from Task 2.
- Produces: no new API. Task 2's `workspaceScan.js` already implements the scoping; this task is the **gate that proves it**, and it is separated because the failure it guards against is the only one in this plan that damages data.

**The measured behaviour, before the fix** (run on the two-copy fixture with the old flat index):

```
MAIN in the flat index -> /LineB/.../MAIN.TcPOU
rename LineB's MAIN (the project that WON the name key): resolved=true, 2 occurrences
    /LineA/TcToolkitSample_PLC/PlcTask.TcTTO      <-- rewrites the OTHER project
    /LineB/TcToolkitSample_PLC/PlcTask.TcTTO
rename LineA's MAIN (the project that LOST):            resolved=false, 0 occurrences
```

Two distinct failures, and an implementer needs both in mind:

1. **The winner corrupts its neighbour.** `findConfigReferencesForSymbol` matches a task config's `<PouCall><Name>MAIN</Name>` by bare name with no notion of which project the file belongs to, so it rewrites both projects' `PlcTask.TcTTO`. The neighbour's XAE build then breaks, in a file the user never opened.
2. **The loser silently does nothing.** The function's identity guard (`configReferences.js`: `normalizeUri(node.uri) !== normalizeUri(spec.fileUri)` → `resolved:false`) rejects the request outright, because the index's `MAIN` node belongs to the other project. The rename appears to succeed and the config update is silently skipped — the same class of gap the user's own 0.3.0 smoke test caught.

Per-project indexes fix (2): each project's node now matches its own `fileUri`. `configFilesFor` fixes (1). This task asserts both.

**Spec shape — get this right:** `findConfigReferencesForSymbol(spec, symbolIndex, configFilePaths)` takes `spec = { rootName, fileUri, member? }`. Not `name`/`uri`. Check `test/test_config_references.js:347` for a worked call.

- [ ] **Step 1: Write the failing test**

Append to `test/test_multi_project_scope.js`, before `fx.cleanup()`:

```js
// --- a rename's config scan never leaves its own project --------------------------------------
// The sample ships XAE's PlcTask.TcTTO, which names MAIN in a <PouCall>; both copies have one.
// Before per-project indexes, renaming the MAIN that won the flat index rewrote BOTH task files
// (measured: 2 occurrences, one of them in the other project), while renaming the MAIN that lost
// resolved to nothing at all and silently skipped the config update.
const { findConfigReferencesForSymbol } = require('../src/lsp/features');

const uriA = 'file:///' + mainA.replace(/\\/g, '/');
const uriB = 'file:///' + mainB.replace(/\\/g, '/');

// Both directions must now resolve — neither project is a "loser" any more.
const fromA = findConfigReferencesForSymbol(
    { rootName: 'MAIN', fileUri: uriA }, ws.indexForUri(uriA), ws.configFilesFor(uriA));
const fromB = findConfigReferencesForSymbol(
    { rootName: 'MAIN', fileUri: uriB }, ws.indexForUri(uriB), ws.configFilesFor(uriB));

assert(fromA.resolved, "renaming LineA's MAIN resolves (the identity guard no longer rejects it)");
assert(fromB.resolved, "renaming LineB's MAIN resolves");
assert(fromA.occurrences.length > 0, `LineA's task config is found (got ${fromA.occurrences.length})`);
assert(fromA.occurrences.every(o => /LineA/i.test(o.uri)),
    `renaming LineA's MAIN touches only LineA (leaked: ${fromA.occurrences.filter(o => !/LineA/i.test(o.uri)).map(o => o.uri).join(', ')})`);
assert(fromB.occurrences.every(o => /LineB/i.test(o.uri)),
    `renaming LineB's MAIN touches only LineB (leaked: ${fromB.occurrences.filter(o => !/LineB/i.test(o.uri)).map(o => o.uri).join(', ')})`);

// The scoping is in configFilesFor, so assert it directly too — a future refactor that widens the
// walk would still pass the assertions above by luck if the matcher happened not to hit.
const filesA = ws.configFilesFor(uriA);
assert(filesA.length > 0, `LineA has config objects to scan (got ${filesA.length})`);
assert(filesA.every(f => /LineA/i.test(f)),
    `configFilesFor never offers another project's files (leaked: ${filesA.filter(f => !/LineA/i.test(f)).join(', ')})`);

// And pin the hazard: handed BOTH projects' files, the matcher does cross over. This is why the
// scoping must live in the file-collection step and not be left to the matcher.
const unscoped = findConfigReferencesForSymbol(
    { rootName: 'MAIN', fileUri: uriB },
    ws.indexForUri(uriB),
    filesA.concat(ws.configFilesFor(uriB))
);
assert(unscoped.occurrences.some(o => /LineA/i.test(o.uri)),
    'sanity: an UNSCOPED file list does reach the other project — the guard above is load-bearing');
```

- [ ] **Step 2: Run it**

Run: `node test/test_multi_project_scope.js`
Expected: **PASS** if Task 2 Step 7 routed `custom/configReferencesForSymbol` through `workspace.configFilesFor`. If any of the three scoping assertions fails, `configFilesFor` is wrong — fix it in `workspaceScan.js`, not in the test.

The final "sanity" assertion must also pass. If it *fails*, the matcher stopped crossing projects for some other reason; find out why before trusting the rest — a guard that cannot fail proves nothing.

- [ ] **Step 3: Verify the handler is actually wired**

Run: `grep -n "configReferencesForSymbol" -A 8 src/lsp/server.js`
Expected: the handler body uses `workspace.indexForUri(params.fileUri)` and `workspace.configFilesFor(params.fileUri)`, and **no** reference to `workspaceRootPaths` remains anywhere in the file:

```bash
grep -n "workspaceRootPaths" src/lsp/server.js   # expected: no output
```

- [ ] **Step 4: Manual verification in the Extension Development Host**

1. `F5` to launch the dev host; open a folder containing the two-project fixture (build one with `node -e "require('./test/_multiproject').buildTwoProjectFixture()"`, or copy `sample/TcToolkitSample` twice by hand).
2. `git init && git add -A && git commit -m baseline` inside that folder so changes are visible.
3. Open `LineA/…/POUs/MAIN.TcPOU`, press `F2`, rename `MAIN` → `MAIN_A`, choose **update all references**.
4. `git status` must show changes **only** under `LineA/`. Any `LineB/` file in the list means the scoping is incomplete — stop and fix.
5. `LineA/…/PlcTask.TcTTO` must contain `<PouCall><Name>MAIN_A</Name>` — the update must actually happen, not merely be scoped away.

Record the outcome in the commit message.

- [ ] **Step 5: Commit**

```bash
git add test/test_multi_project_scope.js src/lsp/server.js
git commit -m "test(lsp): gate the rename config scan against crossing project boundaries

Before per-project indexes, renaming the MAIN that won the flat name key rewrote both
projects' PlcTask.TcTTO (measured: 2 occurrences, one in the neighbour), while renaming
the MAIN that lost resolved to nothing and silently skipped the config update entirely.
Both directions now resolve, and each touches only its own project. Verified in the dev
host: renaming LineA's MAIN leaves every LineB file untouched."
```


---

### Task 5: Extension-host cache fixes

**Files:**
- Modify: `extension.js:147-160` (`broadcastTypesMap`), `:368-371` (the delete-by-name bug)
- Modify: `src/typesCache.js` (the unscoped crawl)
- Modify: `src/lsp/server.js` (`custom/updateTypesMap`)
- Modify: `media/editor.js:24,1375,1418-1421` (dead `typesMap`)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new API. This task *removes* a redundant, unscoped path.

**Finding this rests on:** `media/editor.js` assigns `typesMap` at lines 1375 and 1419 and **never reads it** — `grep -n "typesMap" media/editor.js` returns only the declaration and the two assignments. The webview half of this pipeline is dead code. The live half is `custom/updateTypesMap`, which inserts stub-ranged nodes into the LSP index from a **whole-workspace crawl with no `.plcproj` gate at all** (`typesCache.js:125-189`) — re-introducing exactly the cross-project and orphan names the index deliberately excludes.

- [ ] **Step 1: Confirm the dead path before deleting anything**

Run: `grep -rn "typesMap" media/ src/ extension.js`
Expected: exactly the sites listed above — declaration, two assignments in `media/editor.js`, the `postMessage` in `extension.js:151`, the `getWorkspaceTypesCache()` read in `customEditorProvider.js:297`, and the LSP handler. **No read of `typesMap` inside `media/editor.js`.** If a read exists, stop and re-scope this task.

- [ ] **Step 2: Delete the dead webview broadcast**

In `media/editor.js`: delete the `let typesMap = {};` declaration (`:24`), the `typesMap = message.typesMap || {};` line in the `load` handler (`:1375`), and the whole `case 'updateTypesMap':` block (`:1418-1421`).
In `extension.js:147-160`: delete the `for (const panel of provider.activePanels.values())` loop and its `postMessage`.
In `src/customEditorProvider.js:297`: delete the `typesMap: getWorkspaceTypesCache(),` property and the now-unused `require` on line 10.

- [ ] **Step 3: Delete the unscoped LSP types-map push**

In `extension.js`, delete the `client.sendRequest('custom/updateTypesMap', …)` call — with `broadcastTypesMap`'s other half gone, the whole function goes.
In `src/lsp/server.js`, delete the `custom/updateTypesMap` handler (`:345-395`) entirely.

Rationale to put in the commit message: the handler existed to backfill symbols the LSP had not parsed. It no longer can be right — it is fed by a crawl that ignores the `.plcproj`, so in a multi-project workspace it injects the *other* project's names, with stub ranges, into an index that had correctly excluded them. Every symbol it supplied is already indexed from XML by `scanWorkspace` with real ranges.

- [ ] **Step 4: Fix the name-keyed cache delete**

`extension.js:368-370` deletes by object name, so deleting one project's `MAIN.TcPOU` drops the cache entry for both. With Step 3 the types cache has one remaining consumer to check. Run:

```bash
grep -rn "getWorkspaceTypesCache\|indexWorkspaceTypes\|updateCacheForFile" --include=*.js src/ extension.js
```

If the only remaining hits are inside `src/typesCache.js` itself and the watcher in `extension.js`, **delete `src/typesCache.js` and its watcher wiring** — the whole module is then unreferenced. If a consumer remains, key the cache by URI instead of by root name:

```js
// Keyed by URI, not by object name: two projects can each hold a MAIN, and deleting one must not
// evict the other's entry.
workspaceTypesCache[uri.toString().toLowerCase()] = { name: parsed.rootName, /* …unchanged… */ };
```

and change the watcher to `delete cache[uri.toString().toLowerCase()]`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && REQUIRE_FULL_SUITE=1 npm test`
Expected: green, sample still at 0 diagnostics.

Run the webview browser harnesses by hand (they are outside `npm test` and `media/editor.js` changed):

```bash
npm i --no-save playwright
node test/browser/run.js
node test/browser/run_pragmas.js
```
Expected: 17 and 29 assertions passing.

Then `F5` into the dev host, open a TwinCAT file, and confirm completions, go-to-definition and diagnostics all still work — this is the check that the deleted types map really was redundant.

- [ ] **Step 6: Commit**

```bash
git add extension.js src/typesCache.js src/customEditorProvider.js src/lsp/server.js media/editor.js
git commit -m "refactor: drop the unscoped workspace types map

The webview never read it (assigned, never used) and the LSP half was fed by a
whole-workspace crawl with no .plcproj gate, re-injecting other projects' names into
an index that had correctly excluded them. Every symbol it supplied is already indexed
from XML with real ranges."
```

---

### Task 6: Status-bar project indicator

**Files:**
- Create: `src/projectStatusBar.js`
- Modify: `extension.js` (activation, and the existing `onActiveFileChange` hook at `:144`)
- Test: `test/test_project_map.js` (extend — the pure label logic only)

**Interfaces:**
- Consumes: `createProjectMap`, `LOOSE_PROJECT_KEY` from Task 1.
- Produces:
  - `projectLabel(projectMap, fsPath): string` — pure, testable: the display name, or `''` when the workspace has fewer than two projects (nothing to disambiguate).
  - `createProjectStatusBar(context): {refresh(uri): void, dispose(): void}`.

- [ ] **Step 1: Write the failing test**

Append to `test/test_project_map.js`, before the cleanup:

```js
// --- status-bar label ---------------------------------------------------------------------
const { projectLabel } = require('../src/projectStatusBar');

assert(projectLabel(map, path.join(A, 'POUs', 'MAIN.TcPOU')) === 'LineA',
    'the label names the owning project');
assert(projectLabel(map, path.join(ROOT, 'Loose', 'Stray.TcPOU')) === 'Loose files',
    'a file under no project is labelled as loose');
assert(projectLabel(empty, path.join(bare, 'X.TcPOU')) === '',
    'a workspace with no project shows nothing — there is nothing to disambiguate');

// One project is the common case: the indicator must stay out of the way.
const soloRoot = path.join(os.tmpdir(), 'projmap_solo_' + Date.now());
fs.mkdirSync(path.join(soloRoot, 'POUs'), { recursive: true });
fs.writeFileSync(path.join(soloRoot, 'Solo.plcproj'),
    '<Project><ItemGroup><Compile Include="POUs\\MAIN.TcPOU"/></ItemGroup></Project>');
const solo = createProjectMap([soloRoot]);
assert(projectLabel(solo, path.join(soloRoot, 'POUs', 'MAIN.TcPOU')) === '',
    'a single-project workspace shows nothing');
```

Leave `soloRoot` in place — Task 7 reuses it. Add `fs.rmSync(soloRoot, { recursive: true, force: true });` to the existing cleanup block at the bottom of the file, beside the `ROOT` and `bare` removals.

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/test_project_map.js`
Expected: FAIL — `Cannot find module '../src/projectStatusBar'`.

- [ ] **Step 3: Write the implementation**

Create `src/projectStatusBar.js`:

```js
/**
 * @file projectStatusBar.js
 * @description Shows which PLC project the active file belongs to.
 *
 * A workspace can hold several `.plcproj` files, and each is its own compilation unit: symbols,
 * references and rename are all scoped to one project. Without an indicator that scoping is
 * invisible — two same-named objects look identical in the tab bar. Shown only when there is
 * something to disambiguate (two or more projects); a single-project workspace sees nothing.
 */

const vscode = require('vscode');
const { LOOSE_PROJECT_KEY } = require('./lsp/projectMap');

/** Extensions whose editor should show the indicator (lower-cased). */
const TWINCAT_FILE_EXTS = /\.(tcpou|tcgvl|tcdut|tcio|st)$/i;

/**
 * The label for a file, or '' when there is nothing worth showing.
 * Pure — no `vscode` use — so it is unit-testable.
 * @param {{projects: Map<string, Object>, projectFor: function(string): string,
 *   displayName: function(string): string}} projectMap The workspace partition.
 * @param {string} fsPath Absolute file path.
 * @returns {string} Display name, or '' for a workspace with fewer than two projects.
 */
function projectLabel(projectMap, fsPath) {
    if (!projectMap || projectMap.projects.size < 2) return '';
    const key = projectMap.projectFor(fsPath);
    return key === LOOSE_PROJECT_KEY ? 'Loose files' : projectMap.displayName(key);
}

/**
 * Creates the status-bar item and returns a handle the extension refreshes on file change.
 * @param {vscode.ExtensionContext} context Extension context (the item is registered for disposal).
 * @param {function(): Object|null} getProjectMap Supplies the current partition; re-read on every
 *   refresh because a `.plcproj` edit rebuilds it.
 * @returns {{refresh: function(vscode.Uri|null): void, dispose: function(): void}}
 */
function createProjectStatusBar(context, getProjectMap) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.tooltip = 'The PLC project this file belongs to. References, rename and diagnostics are scoped to it.';
    context.subscriptions.push(item);

    const refresh = (uri) => {
        const label = uri && TWINCAT_FILE_EXTS.test(uri.fsPath)
            ? projectLabel(getProjectMap(), uri.fsPath)
            : '';
        if (!label) { item.hide(); return; }
        item.text = `$(circuit-board) ${label}`;
        item.show();
    };

    return { refresh, dispose: () => item.dispose() };
}

module.exports = { projectLabel, createProjectStatusBar };
```

- [ ] **Step 4: Wire it into the extension**

In `extension.js`, build the partition on the host side (the LSP's copy is in the other process) and refresh on active-file change. Add near the tree/provider setup:

```js
const { createProjectMap } = require('./src/lsp/projectMap');
const { createProjectStatusBar } = require('./src/projectStatusBar');

let hostProjectMap = null;
/**
 * Rebuilds the extension host's copy of the project partition. Cheap (a `.plcproj` walk plus one
 * regex per file) and only run on activation and on a `.plcproj` change.
 */
const refreshProjectMap = () => {
    const folders = vscode.workspace.workspaceFolders || [];
    hostProjectMap = createProjectMap(folders.map(f => f.uri.fsPath));
};
refreshProjectMap();

const projectStatusBar = createProjectStatusBar(context, () => hostProjectMap);
```

Extend the existing `onActiveFileChange` hook (`extension.js:144`) so it also calls `projectStatusBar.refresh(uri)`, and call `refreshProjectMap()` wherever a `.plcproj` change already triggers `custom/reindex`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && node test/test_project_map.js && npm test`
Expected: green.

Then `F5` into the dev host with the two-project fixture: switching between `LineA/…/MAIN.TcPOU` and `LineB/…/MAIN.TcPOU` must flip the status bar between `LineA` and `LineB`; opening the single-project `sample/` must show nothing.

- [ ] **Step 6: Commit**

```bash
git add src/projectStatusBar.js extension.js test/test_project_map.js
git commit -m "feat: status-bar indicator for the active file's PLC project"
```

---

### Task 7: Group the Objects tree by project

**Files:**
- Modify: `src/treeDataProvider.js:125-152` (`getChildren` root case), `:95-118` (`getParent`)
- Test: `test/test_project_map.js` (extend — the pure grouping helper)

**Interfaces:**
- Consumes: `createProjectMap` from Task 1.
- Produces: `groupRootsByProject(projectMap, folderPaths: string[]): Array<{key: string, name: string, dir: string}>` — exported from `src/lsp/projectMap.js`; returns `[]` when the workspace has fewer than two projects, so the tree keeps today's flat shape in the common case.

- [ ] **Step 1: Write the failing test**

Append to `test/test_project_map.js`:

```js
// --- tree grouping ----------------------------------------------------------------------------
const { groupRootsByProject } = require('../src/lsp/projectMap');

const groups = groupRootsByProject(map, [ROOT]);
assert(groups.length === 2, `two projects produce two tree groups (got ${groups.length})`);
assert(groups.map(g => g.name).sort().join(',') === 'LineA,LineB', 'groups are named after the projects');
assert(groups.every(g => fs.existsSync(g.dir)), 'each group points at a real directory');
assert(groupRootsByProject(solo, [soloRoot]).length === 0,
    'a single-project workspace produces no groups — the tree stays flat');
```

(Move the `solo`/`soloRoot` fixture from Task 6 above this block so both use it, and remove the duplicate cleanup.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/test_project_map.js`
Expected: FAIL — `groupRootsByProject is not a function`.

- [ ] **Step 3: Implement the helper**

Add to `src/lsp/projectMap.js` and export it:

```js
/**
 * The tree groups for a workspace: one per PLC project, sorted by name. Returns an EMPTY array when
 * there are fewer than two projects — the Objects tree then keeps its flat, directory-driven shape,
 * which is the right thing for the overwhelmingly common single-project workspace.
 * @param {{projects: Map<string, Object>}} projectMap The workspace partition.
 * @param {Array<string>} folderPaths Absolute workspace-root paths (unused today; kept so a future
 *   multi-root workspace can label a group with its containing folder without a signature change).
 * @returns {Array<{key: string, name: string, dir: string}>} Groups, or [] to stay flat.
 */
function groupRootsByProject(projectMap, folderPaths) {
    if (!projectMap || projectMap.projects.size < 2) return [];
    return Array.from(projectMap.projects.values())
        .map(p => ({ key: p.key, name: p.name, dir: p.dir }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Use it in the tree**

In `src/treeDataProvider.js`, replace the root case of `getChildren`:

```js
    async getChildren(element) {
        if (!element) {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders) return [];

            // Several PLC projects under one folder: give each its own top-level node. Symbols,
            // references and rename are scoped per project, so a flat tree would show two identical
            // MAIN entries with no way to tell them apart.
            const groups = groupRootsByProject(
                createProjectMap(folders.map(f => f.uri.fsPath)),
                folders.map(f => f.uri.fsPath)
            );
            if (groups.length > 0) {
                return groups.map(g => new TwinCatTreeItem(
                    g.name,
                    vscode.Uri.file(g.dir),
                    vscode.TreeItemCollapsibleState.Expanded,
                    'directory',
                    null,
                    new vscode.ThemeIcon('circuit-board')
                ));
            }

            let allItems = [];
            for (const folder of folders) {
                const items = await this.readDir(folder.uri);
                allItems = allItems.concat(items);
            }
            return allItems;
        }
        // …rest unchanged
```

`getParent` (`:95-118`) already returns `null` for anything whose parent is a workspace root; add the project directories to that check so `reveal()` stops at a group node:

```js
        const isProjectRoot = groupRootsByProject(
            createProjectMap(folders.map(f => f.uri.fsPath)),
            folders.map(f => f.uri.fsPath)
        ).some(g => vscode.Uri.file(g.dir).toString() === parentUri.toString());
        if (isParentRoot || isProjectRoot) return null;
```

Add the two requires at the top of the file.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && node test/test_project_map.js && npm test`
Expected: green. `test_object_kinds` is unaffected — icon selection is untouched.

`F5` into the dev host: the two-project fixture must show `LineA` and `LineB` as top-level nodes, each expanding into its own directories; the single-project `sample/` must look exactly as it does today. Check that **Find References → reveal** still scrolls to the right node in both.

- [ ] **Step 6: Commit**

```bash
git add src/lsp/projectMap.js src/treeDataProvider.js test/test_project_map.js
git commit -m "feat: group the Objects tree by PLC project when a folder holds more than one"
```

---

### Task 8: Retire the old include-set API and update the docs

**Files:**
- Modify: `src/lsp/xmlIndexer.js:326-412` (`collectPlcProjObjectPaths`, `indexTwinCatDirectory`)
- Modify: `test/test_plcproj_scope.js`
- Modify: `DEVELOPMENT.md`, `HANDOFF.md`
- Create: `.claude/memory/multi-project-workspaces.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new API — this removes the superseded one.

- [ ] **Step 1: Find the remaining callers**

Run: `grep -rn "collectPlcProjObjectPaths" --include=*.js src/ test/ extension.js`
Expected: `src/lsp/xmlIndexer.js` (definition + export) and `test/test_plcproj_scope.js` only — the server stopped calling it in Task 2.

- [ ] **Step 2: Decide its fate and act**

`collectPlcProjObjectPaths` is now redundant: `createProjectMap` answers the same question per project instead of as one union. **Delete it and its export**, and keep `indexTwinCatDirectory(index, dirPath, includedPaths)` — the loose/no-project fallback in `scanWorkspace` still uses it with `null`.

Rewrite `test/test_plcproj_scope.js` to assert the same guarantee through the new API: build the same orphan fixture (`POUs/Modules/FB_Loading.TcPOU` in the `.plcproj`, `POUs/Modulezzz/FB_Loading.TcPOU` not), then:

```js
const map = createProjectMap([ROOT]);
const key = normalizeProjectPath(path.join(ROOT, 'Proj.plcproj'));
const objects = map.get(key).objectPaths;

assert(objects.has(normalizeProjectPath(realFb)), 'the real Modules\\FB_Loading is in the project');
assert(!objects.has(normalizeProjectPath(orphanFb)), 'the orphan Modulezzz\\FB_Loading is NOT');
assert(objects.size === 2, `exactly the two <Compile>d objects (got ${objects.size})`);

const index = {};
for (const p of objects) indexXmlFile(index, p);
assert(/POUs\/Modules\/FB_Loading\.TcPOU$/i.test(index['FB_Loading'].uri),
    'the .plcproj copy wins the name key — the orphan is never indexed');
```

Keep the file's existing header comment (the Modulezzz incident is the reason it exists) and keep its sample-coverage check, rewritten against `map.get(key).objectPaths`.

- [ ] **Step 3: Update DEVELOPMENT.md**

Under the architecture section, document: the process split is unchanged, but the LSP now holds **one symbol index per `.plcproj`**, `src/lsp/projectMap.js` owns the partition, and every `custom/*` request routes by the `fileUri`'s owning project. Note the `Symbol.for('twincat.libraryNamespaces')` / `Symbol.for('twincat.librarySymbols')` registries hanging off each index and *why* they are symbols (invisible to `Object.keys()`, which several hot paths iterate). Add `test_project_map` and `test_multi_project_scope` to the test list, and `test/_multiproject.js` to the fixture helpers.

- [ ] **Step 4: Update HANDOFF.md**

Replace the "OPEN BUG — multiple PLC projects under one workspace folder collide" entry with a short shipped-state entry: what the partition is, the load-bearing decisions (a linked file is indexed into every owner but routes to its home project; the config scan is project-scoped because an unscoped one corrupts the other project's HMI; the shared `archiveCache` vs per-project registries split), and anything deliberately left undone. Keep it tight — the file is over its 100-line target already, so prune a finished item while you are in there.

- [ ] **Step 5: Write the memory note**

Create `.claude/memory/multi-project-workspaces.md`:

```markdown
---
name: multi-project-workspaces
description: A TwinCAT workspace can hold several .plcproj files; every symbol/name-keyed structure must be scoped per project, never workspace-flat.
metadata:
  type: project
---

Opening a folder with more than one PLC project used to break references, diagnostics and
navigation: the symbol index was one flat map keyed by object name, so two projects' same-named
objects collapsed onto one key (last-write-wins). Measured on two copies of `sample/`: **38 object
files produced 19 index entries**, every shared name resolved to the second copy, correct code got a
false diagnostic, and Find References returned hits from the wrong project.

**Why:** the `.plcproj` — not the workspace folder — is the compilation unit. XAE does not resolve
symbols across PLC projects, so anything keyed by symbol name must be partitioned per project.

**How to apply:** before adding any name-keyed workspace structure, ask which project owns each
entry, and route it through `src/lsp/projectMap.js`. Two traps found the hard way: a file can be
`<Compile>`d by more than one project (a link — index it into every owner, route requests to the one
whose directory contains it), and the **rename config-object scan** must be project-scoped, because
an unscoped walk rewrites the other project's `.TcVIS`/`.TcTLO`/`.TcTTO` and silently breaks its XAE
build. Verify multi-project changes on a real two-project fixture — `test/_multiproject.js` builds
one from the committed sample. See [[reproduce-on-real-artifacts]].
```

- [ ] **Step 6: Full verification**

```bash
npm run typecheck
REQUIRE_FULL_SUITE=1 npm test
node .claude/memory/bank.js --check
npm i --no-save playwright && node test/browser/run.js && node test/browser/run_pragmas.js
```
Expected: typecheck clean; suite green at `Coverage: FULL` with 0 diagnostics on the sample; memory bank valid; both browser harnesses green (17 and 29 assertions).

Then move `sample/**/_Libraries/Beckhoff Automation GmbH` aside, re-run `npm test`, confirm still 0, move it back.

- [ ] **Step 7: Commit**

```bash
git add src/lsp/xmlIndexer.js test/test_plcproj_scope.js DEVELOPMENT.md HANDOFF.md .claude/memory/multi-project-workspaces.md
git commit -m "chore: retire the unioned include-set API, document project scoping"
```

---

## Verification Summary

The whole plan is judged by five checks, run at the end:

1. `npm run typecheck` — clean.
2. `REQUIRE_FULL_SUITE=1 npm test` — green, `Coverage: FULL`, **0 diagnostics on `sample/`**.
3. `node test/test_multi_project_scope.js` — every object indexed (no collisions), 0 diagnostics on LineA's correct code, no reference leaves its project, no config occurrence leaves its project.
4. Both browser harnesses green (`media/editor.js` changed in Task 5).
5. Dev-host manual pass on the two-project fixture: status bar flips per file, tree groups per project, and **renaming in LineA leaves every LineB file untouched**.
