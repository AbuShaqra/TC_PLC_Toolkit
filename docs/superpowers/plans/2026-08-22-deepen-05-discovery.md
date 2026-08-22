# Phase 5: One Owner for Workspace Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. The duplication inventory this plan is built from is
> reproduced in the constraints and task texts — exact members and line references are at
> HEAD `bca029d`; re-locate by name if lines drift.

**Goal:** `src/twincatWorkspace.js` (dependency-free: fs/path only) owns the five kinds of
workspace-discovery knowledge — XML-entity decode, the recursive skip-walk, the skip-dir sets,
the TwinCAT extension vocabularies, and the suffix-disambiguation algorithm — while **preserving
every deliberate variance exactly** (the skip-set membership matrix, the two suffix modes, every
extension-list membership).

**Architecture:** One generic walker parameterized by (skipDirs, isMatch); each call site keeps
its own skip-set and predicate. Skip-sets are composed in the owner from a shared base and
re-exported where tests/consumers already import them (libsymbols, plcprojRefs) — they stay
MUTABLE Sets (test_collect_scope's mutation pin depends on it). The suffix core becomes one
algorithm with two option-selected modes matching today's pinned behaviours. Extension lists
become named constants with memberships preserved byte-for-byte. **Deliberately NOT unified:**
the DUT/POU classifiers (objectKinds vs xmlIndexer — different vocabularies AND different
defaults, each load-bearing for its consumer; recorded ruling below).

**Tech Stack:** Plain CommonJS; `test/run.js`; `tsc --noEmit`.

**Spec:** `docs/superpowers/plans/2026-08-22-deepening-roadmap.md` Phase 5.

## Rulings (recorded here and in the ledger)

- **R1 — case-insensitive skip matching everywhere.** `xmlIndexer.indexTwinCatDirectory` and
  `parser.indexStDirectory` currently compare skip names case-SENSITIVELY (`'_Libraries'`,
  `'ST_Files'`); every other walker lower-cases. Unifying on case-insensitive is a documented
  hardening: the only behaviour change is that a lower-case-named `_libraries`/`st_files`
  directory is now skipped by those two walkers too — on the Windows filesystems TwinCAT targets,
  directory names are case-insensitive anyway. Cost if wrong: an exotic POSIX layout that WANTED
  a lowercase `_libraries` indexed — implausible, and the old behaviour was the accident.
- **R2 — classifier unification DEFERRED.** `classifyPou/classifyDut` (icons; default
  `'functionBlock'`/`'struct'`; strips pragmas) vs `specificPouType/dutKindFromDecl` (symbol
  semantics; default `'POU'`/`'alias'`; no pragma strip) differ in vocabulary AND defaults, and
  each default is load-bearing for its consumer. Not this phase. One doc fix rides the close-out:
  `symbolNode.js` documents a `'subrange'` dutKind value that no code ever produces.
- **R3 — skip-set membership variance is deliberate and preserved exactly.** The owner composes
  today's sets without changing a single membership; the new harness pins the full matrix.
- **R4 — extension-list memberships preserved exactly**, including the 4-member lists that omit
  `.tctleo`. The omission in the save/create/change watchers and plcProjHelper is a PROBABLE BUG
  (a `.TcTLEO` edit likely never triggers reindex/plcproj-sync) but is verifiable only in a dev
  host — recorded in HANDOFF for the user, NOT fixed in this behaviour-neutral phase.
- **R5 — `decodeXmlAttribute` unifies on the null-safe variant** (`String(value || '')` — a
  strict superset of the bare variant; projectMap's callers always pass strings).

## Global Constraints

- No build step; plain CommonJS; JSDoc; no new dependencies. `src/twincatWorkspace.js` requires
  ONLY `fs` and `path` (so lsp/ modules and plcprojRefs can import it with no cycle).
- **Behaviour-neutral except R1.** All existing harnesses green UNCHANGED (in particular
  `test_project_map`, `test_solution_map`, `test_collect_scope` incl. its runtime-mutation pin,
  `test_multi_project_scope`, `test_plcproj_scope`, `test_archive_identity`).
- Exported surfaces that tests/consumers import today keep working: `libsymbols` continues to
  export `SKIP_DIRS`/`PROJECT_SKIP_DIRS`/`collectArchives`/`collectTmcFiles`/
  `collectSignatureFiles`; `plcprojRefs` continues to export `PLCPROJ_SKIP_DIRS`/
  `collectPlcProjFiles`; `projectMap` continues to export `TWINCAT_EXTS`/`findPlcProjFiles`;
  `xmlIndexer` continues to export `TWINCAT_EXTS`/`indexTwinCatDirectory`. Re-export from the
  owner — identity-shared objects, not copies.
- Skip-sets stay mutable `Set`s (no freeze): `test_collect_scope.js` adds/deletes `_libraries`
  at runtime to prove the trap.
- Sort behaviour stays at call sites (`findPlcProjFiles` does `out.sort()`;
  `findSolutionFiles` does `localeCompare`; others unsorted).
- The four indexing-cost invariants hold (DEVELOPMENT.md "Indexing cost"), especially:
  `collectArchives` walks `_Libraries` (its skip-set has no `_libraries`), and
  `PROJECT_SKIP_DIRS` = `SKIP_DIRS` + `_libraries` exactly.
- Gates per task: `REQUIRE_FULL_SUITE=1 npm test` (67/67 FULL → 68/68 after T1's harness lands);
  `npm run typecheck` clean — **run gates bare, never piped through tail (memory-bank note
  `gates-must-propagate-exit-codes`)**.
- G4 deferred to the user's machine as every phase; no media/ changes, so no G3.

---

### Task 1: `src/twincatWorkspace.js` + its harness

**Files:**
- Create: `src/twincatWorkspace.js`, `test/test_twincat_workspace.js`

**Interfaces produced (every later task consumes these exact names):**

```js
decodeXmlAttribute(value) → string           // null-safe variant (R5), 7-entity chain
walkFiles(rootOrRoots, {skipDirs, isMatch, out?}) → string[]
    // readdirSync(withFileTypes) walk; try/catch → skip unreadable; skips a directory when
    // skipDirs.has(entry.name.toLowerCase()); isMatch(entryName, fullPath) decides files
    // (entry.isFile() gated by the walker); returns out (default []); NO sorting.
BASE_SKIP_DIRS      // new Set(['.git', 'node_modules', '.vscode'])
PROJECT_WALK_SKIP_DIRS   // BASE + _libraries, st_files, _compileinfo, _boot   (today's projectMap SKIP_DIRS, 7)
SOLUTION_SKIP_DIRS       // BASE + _libraries, _boot, _compileinfo             (today's solutionMap set, 6)
CONFIG_OBJECT_SKIP_DIRS  // BASE + _libraries                                  (today's workspaceScan set, 4)
ARCHIVE_SKIP_DIRS        // BASE + _compileinfo, st_files                      (today's libsymbols SKIP_DIRS, 5 — NO _libraries)
PROJECT_SKIP_DIRS        // ARCHIVE_SKIP_DIRS + _libraries                     (today's libsymbols PROJECT_SKIP_DIRS / plcprojRefs set, 6)
XML_INDEX_SKIP_DIRS      // BASE + _libraries                                  (xmlIndexer inline chain, now case-insensitive per R1)
ST_INDEX_SKIP_DIRS       // BASE + st_files                                    (parser inline chain, now case-insensitive per R1)
TWINCAT_XML_EXTS         // new Set(['.tcpou', '.tcgvl', '.tcdut', '.tcio', '.tctleo'])
TWINCAT_EDITOR_EXTS      // TWINCAT_XML_EXTS + '.st' (6) — the reveal/status-bar vocabulary
TWINCAT_WATCH_EXTS       // new Set(['.tcpou', '.tcio', '.tcgvl', '.tcdut']) — the 4-member list, preserved per R4 with a comment naming the probable .tctleo gap and pointing at HANDOFF
suffixDisplayNames(records, nameOf, dirOf, options?) → Map<key, label>
    // options: { includeRoot?: boolean (default false), sharedMaxDepth?: boolean (default false) }
    // Default options = today's solutionMap semantics; { includeRoot: true, sharedMaxDepth: true }
    //   = today's projectMap semantics. The same-named-dir collapse stays a CALLER concern
    //   (projectMap passes it via dirOf). Separators frozen: parts ' / ', name ' — ' (em dash).
```

Sets are built by composition (`new Set([...BASE_SKIP_DIRS, ...])`) — plain mutable Sets.

- [ ] **Step 1: Write the harness first** (`test/test_twincat_workspace.js`, `check` style):
  1. decode chain: the 7 entities each decode; `time&amp;date` → `time&date`; numeric/hex
     code points; `null`/`undefined` → `''` (the R5 superset behaviour).
  2. walker: over a fixture tree built in the OS tmpdir (use `fs.mkdtempSync`) — skips a
     `node_modules` and an upper-case `_Libraries` dir when the skip-set holds `_libraries`
     (case-insensitivity), collects by predicate, survives an unreadable subdir (chmod 000 where
     the platform allows; skip that check cleanly on failure to chmod), returns unsorted.
  3. THE MATRIX: pin every exported set's exact membership (table above, copied literally) and
     the load-bearing relations: `!ARCHIVE_SKIP_DIRS.has('_libraries')`;
     `PROJECT_SKIP_DIRS` = `ARCHIVE_SKIP_DIRS` + `_libraries` and nothing else.
  4. ext vocabularies: exact members of all three sets; `TWINCAT_WATCH_EXTS` ⊂ `TWINCAT_XML_EXTS`.
  5. suffix core: one fixture with two same-named records in sibling dirs — default options give
     solution-scoped labels (`Name — Parent`); `{includeRoot: true, sharedMaxDepth: true}` with a
     root-only distinction reproduces projectMap's root-part behaviour; unique names pass through
     unsuffixed; separators asserted literally (`' / '`, `' — '`).
  Run → red (module absent).
- [ ] **Step 2: Implement** — transcribe the decode chain (solutionMap variant), the walker
  (projectMap's shape: `entry.isFile() && isMatch(...)`), the set compositions, the ext sets, and
  the suffix algorithm as ONE function whose two option flags reproduce the two existing bodies
  (`buildProjectDisplayNames`'s maxDepth loop + root unshift behind the flags; the
  per-record-depth loop as the default). Every export JSDoc'd; the file header explains the
  preserved-variance principle and points at DEVELOPMENT.md "Indexing cost" rule 4.
- [ ] **Step 3: Gates** (bare, exit-code checked) — new harness green; full suite 68/68 FULL;
  typecheck clean.
- [ ] **Step 4: Commit** — `feat: twincatWorkspace.js owns discovery knowledge (walker, sets, exts, decode, suffixes)`

---

### Task 2: Convert `projectMap.js` and `solutionMap.js`

**Files:** Modify `src/lsp/projectMap.js`, `src/solutionMap.js`, `test/test_project_map.js` (one
assertion, see below). Nothing else.

- [ ] **Step 1:** `projectMap.js` — delete its local `SKIP_DIRS` + `decodeXmlAttribute` +
  `buildProjectDisplayNames`; import `{ PROJECT_WALK_SKIP_DIRS, TWINCAT_XML_EXTS, decodeXmlAttribute,
  walkFiles, suffixDisplayNames }` from `../twincatWorkspace`. `findPlcProjFiles` becomes
  `walkFiles(roots, { skipDirs: PROJECT_WALK_SKIP_DIRS, isMatch: n => n.toLowerCase().endsWith('.plcproj') })`
  + its existing `out.sort()`. `TWINCAT_EXTS` becomes a RE-EXPORT of `TWINCAT_XML_EXTS`
  (`const TWINCAT_EXTS = TWINCAT_XML_EXTS;` — identity, so the cross-pin can tighten). The
  display-name call site becomes
  `suffixDisplayNames([...projects.values()], p => p.name, p => collapseOwnDir(p), { includeRoot: true, sharedMaxDepth: true })`
  where `collapseOwnDir` is the existing basename-collapse rule kept LOCAL (it is projectMap
  policy, not shared knowledge). `pathWithDiskSpelling` and everything else untouched.
- [ ] **Step 2:** `solutionMap.js` — delete its local `SKIP_DIRS` + `decodeXmlAttribute` +
  `suffixDisplayNames`; import from `./twincatWorkspace`; `findSolutionFiles` = walkFiles +
  existing `localeCompare` sort; both suffix call sites use the shared core with default options.
- [ ] **Step 3:** `test_project_map.js` — the TWINCAT_EXTS cross-pin (~:35-38) TIGHTENS to
  identity: `assert(TWINCAT_EXTS === XML_INDEXER_TWINCAT_EXTS, 'one shared Set object')` — leave
  the pin in place until Task 3 converts xmlIndexer, so in THIS task only prepare it as
  size+membership (unchanged) and add a TODO(T3) comment; Task 3 flips it to identity.
- [ ] **Step 4: Gates** — `test_project_map`, `test_solution_map`, `test_twincat_workspace` green
  unchanged; full suite 68/68 FULL; typecheck clean.
- [ ] **Step 5: Commit** — `refactor: projectMap and solutionMap consume the discovery owner`

---

### Task 3: Convert the LSP walkers

**Files:** Modify `src/lsp/workspaceScan.js`, `src/lsp/libsymbols.js`, `src/lsp/plcprojRefs.js`,
`src/lsp/xmlIndexer.js`, `src/lsp/parser.js`, `test/test_project_map.js` (flip the pin to
identity). Nothing else.

- [ ] **Step 1:** `workspaceScan.js` — local `CONFIG_OBJECT_SKIP_DIRS` deleted; import from
  `../twincatWorkspace`; `collectConfigObjectFiles` = walkFiles with its `CONFIG_OBJECT_EXTS`
  predicate (that ext set is genuinely local — config objects, not source objects — keep it).
- [ ] **Step 2:** `libsymbols.js` — local `SKIP_DIRS`/`PROJECT_SKIP_DIRS` become imports
  (`ARCHIVE_SKIP_DIRS as SKIP_DIRS`-style aliasing: `const SKIP_DIRS = ARCHIVE_SKIP_DIRS;`) and
  the module KEEPS exporting them under the existing names (same Set identity — the
  test_collect_scope mutation pin then exercises the owner's actual set, which is the point).
  `collectArchives`/`collectTmcFiles`/`collectSignatureFiles` become walkFiles calls with their
  existing predicates (`LIBRARY_EXT.test`, `/\.tmc$/i`, basename equality), keeping their
  exported `(dir, out)` signatures as thin wrappers (`walkFiles(dir, {skipDirs, isMatch, out})`).
  The 15-line PROJECT_SKIP_DIRS rationale comment MOVES to the owner (pointer left behind).
- [ ] **Step 3:** `plcprojRefs.js` — `PLCPROJ_SKIP_DIRS` becomes `const PLCPROJ_SKIP_DIRS =
  PROJECT_SKIP_DIRS;` (imported; the cycle its comment feared does not exist against the
  dependency-free owner — update that comment), still exported; `collectPlcProjFiles` wraps
  walkFiles.
- [ ] **Step 4:** `xmlIndexer.js` — inline chain replaced by `XML_INDEX_SKIP_DIRS` with
  lower-cased matching (R1; note the behaviour change in the commit body); `TWINCAT_EXTS` becomes
  a re-export of the owner's `TWINCAT_XML_EXTS` (identity). The walk stays side-effecting
  (`indexXmlFile` per hit) — use walkFiles' `isMatch` with a push into a list then index, OR keep
  the recursive shape and only swap the skip test; prefer the SMALLER diff (keep recursion, swap
  the membership test to `XML_INDEX_SKIP_DIRS.has(entry.name.toLowerCase())`). Same choice in
  `parser.js` `indexStDirectory` with `ST_INDEX_SKIP_DIRS`.
- [ ] **Step 5:** `test_project_map.js` — flip the TWINCAT_EXTS cross-pin to object identity; its
  failure message updates accordingly (the drift alarm becomes a structural assertion).
- [ ] **Step 6: Gates** — `test_collect_scope` green UNCHANGED (all four behaviour pins + the
  mutation pin), `test_plcproj_cache`, `test_archive_identity`, `test_multi_project_scope`,
  `test_plcproj_scope` green; full suite 68/68 FULL; typecheck clean.
- [ ] **Step 7: Commit** — `refactor(lsp): all walkers consume the discovery owner; skip matching case-insensitive everywhere`

---

### Task 4: Convert the host-side extension lists

**Files:** Modify `extension.js`, `src/treeDataProvider.js`, `src/plcProjHelper.js`,
`src/commands/renameCommands.js`, `src/projectStatusBar.js`, `test/test_twincat_workspace.js`
(add the regex/glob cross-pins). Nothing else.

- [ ] **Step 1:** `extension.js` — the four inline arrays become imports: `:130`'s 6-member
  reveal list → `TWINCAT_EDITOR_EXTS.has(ext)`; `:355`/`:423`/`:444`'s 4-member lists →
  `TWINCAT_WATCH_EXTS.has(extName)`. The `:399` project-structure list (`.sln/.tsproj/.xti/
  .plcproj`) is different knowledge — leave it, add no constant. The `:365-372` watcher gate's
  3-member segment check: leave as-is (path-segment semantics, not a directory walk).
- [ ] **Step 2:** `treeDataProvider.js` — mapping A (`getRevealItem`) and mapping B (`readDir`)
  keep their DIFFERENT kind logic (that divergence incl. the `.tctleo` readDir gap is recorded in
  HANDOFF per R4 — do not "fix" it here); only the raw ext-membership tests that duplicate the
  owner's vocabularies convert where drop-in (`ext === '.tcpou' || ext === '.tcio' || ...`
  chains stay if converting would entangle the kind branches — implementer judgment, report the
  choice). The `:332` 3-member readDir skip chain → `BASE_SKIP_DIRS.has(name.toLowerCase())`.
- [ ] **Step 3:** `plcProjHelper.js:145` and `renameCommands.js:47` → `TWINCAT_WATCH_EXTS`
  (memberships identical today; renameCommands' `TC_SOURCE_EXTS` name disappears or aliases it).
- [ ] **Step 4:** `projectStatusBar.js:22`'s regex and `customEditorProvider.js`'s glob stay
  regex/glob (different mechanisms) — instead ADD to `test_twincat_workspace.js` two cross-pins:
  the regex source contains exactly `TWINCAT_EDITOR_EXTS`'s members; the glob names exactly
  `TWINCAT_XML_EXTS`'s members in both casings. (Import the regex via
  `require('../src/projectStatusBar')` — `TWINCAT_FILE_EXTS` is module-level; export it if it
  is not already exported, as a named export addition, not a behaviour change. The glob string:
  read `customEditorProvider.js` as TEXT in the test and extract the findFiles literal — the file
  requires vscode so it cannot be required.)
- [ ] **Step 5: Gates** — full suite 68/68 FULL; typecheck clean. (extension.js and
  treeDataProvider are dev-host-covered; the conversions are membership-preserving by
  construction, and the new cross-pins hold the regex/glob line.)
- [ ] **Step 6: Commit** — `refactor: host extension lists come from the discovery owner`

---

## Self-review record

- Every set/list membership in T1's owner is copied from the inventory at HEAD `bca029d`, and the
  new harness pins the matrix — a transcription slip fails loudly.
- The mutation pin survives because libsymbols re-exports the owner's Set by identity and the
  sets are never frozen (Global Constraints).
- The suffix core's two modes are pinned on both sides by the EXISTING `test_project_map`
  `:246-250` and `test_solution_map` `:75-89` assertions, which stay untouched.
- R1 is the phase's only behaviour change and is called out in T3's commit body.
- Deleted drift alarms: none deleted — the TWINCAT_EXTS pin is TIGHTENED to identity, and
  test_collect_scope's pins now exercise the owner's sets through the same imports.
- The `.tctleo` watcher gap and the readDir mapping divergence go to HANDOFF (user-verifiable
  only in a dev host), per R4.
