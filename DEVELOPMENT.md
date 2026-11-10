# Development

Building, testing and hacking on TwinCAT PLC Toolkit. For what the extension *does*, see
[README.md](README.md); for the current state of the work, see [HANDOFF.md](HANDOFF.md).

## Run from source

```bash
npm install
```

Open this repo in VS Code and press **F5** ("Run Extension") to launch an Extension Development Host
with the extension loaded. Open a TwinCAT project folder in that window. After changing code, press
**Ctrl+R** in the dev-host window to reload.

There is **no build or transpile step**: the extension is plain CommonJS JavaScript loaded directly
from `extension.js`, and Monaco is vendored under `media/monaco-editor/` so everything works offline.

## Package a VSIX

```bash
npm prune                 # see below — do this first
npx @vscode/vsce package
code --install-extension twincat-plc-toolkit-<version>.vsix --force
```

On Windows, `scripts\install-vsix.bat` picks the newest `.vsix` in the folder and installs it with whichever
`code` CLI it can find.

**`npm prune` first.** vsce packages whatever sits in `node_modules` that npm does not report as a dev
dependency — and a package installed with `npm i --no-save` (which is how `test/browser/` asks for
Playwright) is *extraneous*, not dev, so it ships. Measured: Playwright added **173 files** to the package
list. Prune removes anything not in `package.json`, which is exactly the right set.

**Bump the version before installing.** VS Code will not replace an installed extension with a VSIX of the
same version: both directories end up under `~/.vscode/extensions/` and the old one is not marked in
`.obsolete` until a **full restart** — a window reload is not always enough. This has already cost one debug
cycle chasing a "feature does nothing" report that was really old code still running.

### Publish a GitHub release

`.github/workflows/release.yml` is a **manual** workflow (`workflow_dispatch`; Actions tab → *Release* →
*Run workflow*, or `gh workflow run release.yml`). It builds the VSIX from the selected ref — normally
`main` — and publishes a GitHub release tagged `v<package.json version>` with the VSIX attached and notes
generated from the PRs since the previous tag. Two toggles: `prerelease` and `draft` (draft lets the notes
be edited before the release goes public). It never overwrites: if the tag or release already exists the
run fails before building, so **the release procedure is: bump `version` in `package.json` on `dev`, open and
merge the `dev → main` PR, run the workflow on `main`**. It runs the same typecheck → test → package gates as CI first (a REDUCED test run, like CI),
and also keeps the VSIX as a run artifact.

## Tests

The language server has a standalone test suite; no VS Code instance is required.

```bash
npm test                     # run the whole suite via test/run.js
node test/run.js references   # run only suites whose name matches a substring
node test/test_live_path.js   # run a single harness directly
node test/test_solution_map.js # solution → PLC-project discovery/grouping
node test/test_tree_reveal.js # exact component → project → solution parent chains
node test/test_objects_tree_model.js # the vscode-free Objects-tree model
node test/test_objects_tree_ids.js   # every Objects-tree id pinned on sample/ (--write regenerates)
npm run typecheck             # type-check gate: tsc --noEmit (no emit — runtime stays plain JS)
npm run lint                  # ESLint 9, flat config — a DEFECT check, not a style check; the
                              # policy and every relaxation are documented in eslint.config.js

REQUIRE_FULL_SUITE=1 npm test # fail unless the full-run fixtures are present (see below)
```

### Full vs reduced runs — read this before trusting a green suite

The sample project, its `.tmc` and one MIT-licensed library archive are **committed**, so a fresh clone
and CI both run at **FULL** coverage. Only the **Beckhoff** archives under `_Libraries/` are git-ignored
(vendor binaries); no assertion depends on them without first gating on their presence, so the suite
passes identically with and without — verify a change against both by moving that vendor directory
aside and back.

This matters because of how it used to be: `sample/` was git-ignored entirely, the harnesses needing it
**skipped themselves and still reported "passed"**, and a green CI silently omitted the diagnostics
ratchet and the live-path guard — the two gates this project leans on hardest. `test_live_path` was
found running 2 of its 10 tests. Hence the classification below: a run states what it actually covered.

`test/run.js` therefore classifies every run and prints it in the summary:

- **FULL** — required fixtures are present **and each load-bearing harness reports that its gate
  actually ran**. Fixture presence alone is not evidence: `test/_coverage.js` writes a per-child
  report that `test/run.js` consumes for the live path, diagnostics/typecheck ratchets, committed
  archive reader, multi-project fixture, Objects-tree id pin and the two-sample workspace.
- **REDUCED** — lists missing fixtures plus every gate that skipped or failed to report execution,
  and labels the final line `(reduced coverage)`.
- **FILTERED** — `node test/run.js <substring>` intentionally ran only a subset and can never claim
  whole-suite FULL coverage.

**Optional gates** are listed in the summary as *ran* or *skipped* but never make a run REDUCED:
today only `compile-real` (`test/test_compile_real.js`, Compile Project against the REAL compiler —
the bundled `resources/compiler/compiler.cjs`). It needs a Node >= 22, found the way the command finds
one; without it (CI's Node 16/20 legs) it skips. It runs in every `npm test` on Node 22+ (CI's lint/test
leg uses Node 24). To try another compiler build instead of the bundled one:

```bash
TWINCAT_COMPILER_BUNDLE=/path/to/strucpp-bundle.cjs node test/test_compile_real.js
# optional: TWINCAT_COMPILER_NODE=/path/to/node (>= 22)
```

Never make `compile-real` required in `test/run.js` — a Node < 22 machine must still run a FULL suite.

`REQUIRE_FULL_SUITE=1` turns a reduced or filtered run into a hard failure after the harness reports
are collected. Use it before packaging a release, so a silently skipped gate can never be mistaken
for a clean one.

`npm test` runs `node test/run.js`, which runs each harness in `test/` in its own process and reports
per-suite without aborting on the first failure. The main ones:

| Harness | What it checks |
|---------|----------------|
| `test/test_lsp_features.js` | Core LSP: completions, go-to-definition (incl. call parameters), references, diagnostics, on synthetic `.st` units. |
| `test/test_sample_diagnostics.js` | **Diagnostics ratchet** on every PLC project under `sample/` (two solutions), each in its own index as the server partitions a workspace. The samples are valid code, so every diagnostic on them is a false positive; the harness measures them the way the LSP server does — in order, and again with each object opened fresh (scan-time index + that unit) — prints a per-category breakdown, and **fails if the total rises above the baseline** in `test/_baseline.js`. The target — currently met — is zero. |
| `test/test_live_path.js` | The live editor pipeline: full-file ST assembly, cursor mapping, per-pane diagnostics, member completion through references, method return types, token-aware and cross-file references. |
| `test/test_editor_mapping.js` | The production `src/livePath.js` coordinate/peek helpers directly: pane↔unit boundary mapping, synthesized-line rejection, pane slicing and encoded peek-model paths. `test_live_path.js` imports the same module (including `assembleSt`) rather than carrying copies. |
| `test/test_live_path_unit.js` | The three pure collectors in `src/livePath.js` — `mapDefinition`, `collectPeekReferences`, `listExternalReferences` — against synthetic in-memory XML fixtures (no `sample/` dependency) plus a counting `readFile` double. Pins the peek budget semantics as tests: `PEEK_MAX_PANES`/`maxTextBytes` bound FILE READS and PANE MODELS, never the mapped references — a ref into an already-opened file still maps past the pane cap, and a pane over the byte budget is skipped but its reference still maps. |
| `test/test_file_uri.js` | The production filesystem-path/file-URI boundary: reserved characters, Unicode, encoded drive colons and UNC round trips. |
| `test/test_request_pipeline.js` | `src/lsp/requestPipeline.js`: withDocument syncs exactly once BEFORE the handler (order pinned by a recorder), withoutDocument provably never syncs, value-vs-function fallbacks on every throw path, the frozen `LIBRARY_INDEX_STAGES` table + load-time order validation (a reordered copy throws naming the stages), and byte-exact log-line output on both singular/plural branches. |
| `test/test_twincat_workspace.js` | `src/twincatWorkspace.js`, the discovery owner: the XML-entity decode chain, the generic walker (skip case-insensitivity, unreadable-dir tolerance, **regular files only** — a directory named like a match is never collected), the full skip-dir set MATRIX with its load-bearing relations (`ARCHIVE_SKIP_DIRS` has no `_libraries`; `PROJECT_SKIP_DIRS` is exactly that plus `_libraries`), the three extension vocabularies, the two-mode suffix-disambiguation core, and cross-pins holding `projectStatusBar`'s regex and `customEditorProvider`'s glob (read as text) to the owner's vocabularies. |
| `test/test_component_id.js` | `src/componentId.js`, the component-id grammar owner: a conformance sweep driving the **real** `parseTwinCatXml` over a fixture minting every id shape (round-trip `parse`→`make` identity), the frozen parse table incl. the pinned `prop_X_get`-is-an-accessor ambiguity, `make`'s programmer-error throws, and the `label`/`memberName` display helpers incl. the transition fix. |
| `test/test_typecheck.js` | Semantic type checking: member access, call arguments, declaration types, assignment compatibility — plus the same `sample/` diagnostics ratchet, per project. |
| `test/test_two_samples.js` | The committed `sample/` as a multi-project workspace (two DIFFERENT solutions, unlike `test_multi_project_scope.js`'s copies): the second sample matches a fresh build of `build-sample-project2.js` and is the 3.1.4024 layout; the real `scanWorkspace` partition (19 + 7 objects, each project's own `FB_Cylinder` in its own index); Go to Definition on `FB_Cylinder` landing in the asking project's own FB; references not crossing projects; the scan reading `IMPLEMENTS` on a CRLF multi-line head; and the real `generateAllStFiles` (under a `vscode` stub, on a temp copy) writing one `.st` per object into each project's own `ST_Files`. Required gate `two-samples`. |
| `test/test_references_scope.js` | Find References scope + coordinate spaces: private method `VAR` vs. parameters, named arguments belonging to the callee, and FB_init declaration-site arguments (`inst : FB_T(p := v)`). |
| `test/test_references_tree.js` | References-view grouping (file → component → occurrence). |
| `test/test_tree_reveal.js` | Objects-tree navigation targets and parent chains, driven on `src/objectsTreeModel.js` with an in-memory host (no `vscode` stub): file/root fallback; exact method, property, action, transition and Get/Set nodes; nested virtual-folder ancestry; solution → PLC-project ancestry ending in the tree's own root rows; and a whole reveal chain reads no project map (`getParent` is a field read). |
| `test/test_objects_tree_model.js` | `src/objectsTreeModel.js` with an in-memory host, no `vscode` stub: the shape rule (solutions → projects; one root per project at 2+; flat below), `makeNode` as the single assignment site of id and contextValue (and the historical id formulas), file classification and icons, directory listing (sorting, skip dirs, symlinked dirs, unreadable dirs, re-read on every expansion), virtual folders and their per-file-kind contextValue, property accessors and `propertyNode[.noGet][.noSet]`, and reveal ancestry (flat stops at the workspace root, a file outside the workspace terminates, a reveal's project ancestor is the tree's own row, with its label). |
| `test/test_objects_tree_ids.js` | Pins every element the VS Code adapter (`src/treeDataProvider.js`) renders on `sample/` against `test/fixtures/objects-tree-ids.json`, recorded from the provider before the R4 model refactor: id, label, contextValue, collapsible state, icon, tooltip, click command and `getParent`, plus the id and ancestor ids `getRevealItem` gives every file and component. Six tree shapes (one solution — the first sample copied alone into a temp root, so its recorded ids are unchanged —, two solutions, two projects with no solution, one project with no solution, flat, and `two-sample-solutions`: the committed `sample/` with its 3.1.4026 and 3.1.4024 solutions). Also asserts directly that `getParent` returns the element that listed the child and that reveal ancestors carry the tree's ids and labels. Ids drive VS Code's expansion state and reveal, so a change here is user-visible; regenerate with `--write` only for a deliberate, reviewed change. Required gate `objects-tree-ids`. |
| `test/test_st_shadow.js` | XML is the source of truth: a stray plain `.st` mirror (outside `ST_Files/`) must never steal an XML-backed symbol's index node — the references scan would follow the hijacked uri to the stale mirror and miss the real call sites. |
| `test/test_st_output_path.js` | The pure output-path mapping behind project-aware **Generate ST** (`src/stOutputPath.js`): each project's objects land inside that project, `<project dir>/ST_Files/<path in the project>.st`, so two projects' identical object paths never collide and nothing is written at the workspace's top level; extensions become `.st`, a linked object cannot escape its project's `ST_Files`, and a path under any `ST_Files` is never an input. The end-to-end export (real provider, real disk, three-project fixture) is asserted by the dev-host `generate-st` phase. |
| `test/test_library_catalog.js` | The data path behind the TwinCAT Libraries view: catalog built from the `.plcproj`, namespaces, `.tmc` types and their members. |
| `test/test_library_scope.js` | The Libraries view's active-project scoping, both halves. Server side: `selectLibraryCatalog` (workspaceScan.js) over REAL routing on a two-`.plcproj` fixture — a file's project answers with its own catalog **even when empty** (an explicit scope never widens to the union; that widening was the old behavior and is pinned OUT), union only for no-fileUri/loose. Host side: `scopeProjectKey`/`scopeDescription`/`readLibraryResponse` plus the provider under the vscode stub — refetch only on owning-project change, description only in 2+-project workspaces (real spelling, never the identity key), bare-array responses degrade to the union, a failed request never throws. |
| `test/test_dnd_rules.js` | The Objects-tree drag & drop and copy/paste compatibility matrices: what is draggable/copyable (not virtual folders, not Get/Set accessors; directories move but do not copy), components move only within their own file yet paste cross-file (POU↔interface gated), directory-cycle and no-op rejections, duplicate-in-place file paste. |
| `test/test_xml_rename.js` | Structural rename primitives in `xmlParser`: `renameComponentInXml` (tag Name attr + declaration header + LineIds, Ids kept), `renameVirtualFolderInXml` (folder tag + member FolderPath prefix rewrite), and the no-op-safety composition the rename command relies on (header already renamed by the reference pass → attr/LineIds still fixed, no corruption). |
| `test/test_xml_member_order.js` | WHERE a new member lands, for both `insertComponentIntoXml` (create) and `insertComponentBlockIntoXml` (paste), via the shared `insertMemberIntoXml`. TwinCAT's loader is order-sensitive inside `<POU>`/`<Itf>`: the canonical child order is Declaration, Implementation, `Folder*`, member*, `LineIds*`, so a member must land *before* the LineIds group — appending past it is the same class of defect as the root-`<Folder>` incident that made XAE drop an FB's members from compile. Also pins the seam's 4-space indent, the root close tag keeping its own indent, CRLF preservation (including an LF block pasted into a CRLF document), a `<LineIds` literal inside CDATA not being mistaken for the anchor, and the `.TcIO` fallback (interfaces carry no LineIds at all). |
| `test/test_xml_property_accessor.js` | Re-adding a missing property accessor (issue #25), `insertPropertyAccessorIntoXml`: the block equals what `insertComponentIntoXml` writes for a NEW property's accessor (FB: `VAR/END_VAR` + empty ST; interface: declaration only) with one fresh Id; Get lands before an existing Set, Set after `</Get>`, either after the property Declaration when neither exists (both orders give Declaration, Get, Set); already present / unknown property / name prefix of another property → unchanged; CRLF, LF and tab-indented files; a `FolderPath` with `&amp;`; re-parse reports the accessor; no LineIds written. Byte fidelity by whole-string comparison against the original with the block spliced in. |
| `test/test_property_node_context.js` | The property row's contextValue (`propertyNode`, `.noGet`, `.noSet`, `.noGet.noSet` — the MISSING accessors) and every consumer: the tree builds the right variant and the same tree id for each; `package.json` has no `viewItem == 'propertyNode'` left, the five property-row entries (insert, delete, copy, paste, rename) each match all four variants and nothing else, *Add Get/Set Accessor* match exactly their two variants and are hidden from the Command Palette; drag & drop accepts every variant; no `src/` file compares with `'propertyNode'` by equality. |
| `test/test_xml_parse_robustness.js` | `xmlParser` on inputs the sample never shows: a non-ST POU/Action/Method (SFC, LD/FBD as `NWL`, CFC, FBD, LD) reads `implementation: null` plus its real `implementationLanguage`, never a member's ST, and an Implementation write to it is refused; empty and self-closing `<Declaration/>`/`<ST/>` never read or write a later block's CDATA; attribute entities (`&amp;`, numeric refs) decode on read and are re-encoded by every writer (folders, FolderPath, Name, LineIds); lone-CR text is normalised in the parse output only; a UTF-8 BOM never leaks into names, text or ST output and survives a write. Byte-fidelity is asserted on whole strings. |
| `test/test_program_methods.js` | A PROGRAM with METHODs stays a PROGRAM through the converter (raw and export; `END_PROGRAM`, also when a comment mentions FUNCTION_BLOCK) and in the index, and `MAIN.Init()` from another POU resolves through diagnostics, definition, references and completion. Fixtures are written to a temp dir because find-references reads other documents from disk. |
| `test/test_transition_warning.js` | `convertXmlToSt` names every SFC transition it cannot convert in `warnings`; export mode marks each with a comment without breaking the lineMap, raw (live) mode adds no text at all. |
| `test/test_nested_namespace.js` | Nested library namespaces (`VisuElems.VisuElemBase.▮`): a library's namespace re-exports its dependencies' namespaces, so the inner segment names a library no `.plcproj` references and is resolved by name against the installed-library store, lazily and cached. Asserts the two properties that hold without any library installed — the gate (only a referenced namespace head opens the store, so `stAxis.MotionState.▮` never does) and the miss (uninstalled ⇒ cached empty list, never an exception). Real resolution runs only when the machine has a readable library, and says so when it does not. |
| `test/test_rename_engine.js` | `src/renameEngine.js`: mapping workspace reference positions (raw-ST-unit coords) back into CDATA splices — synthesized-line skips (action headers, `GET`/`SET`), the PROGRAM→FUNCTION_BLOCK raw-mode column skew, the never-write-a-mismatch guard, CRLF byte preservation. |
| `test/test_rename_transaction.js` | `src/renameTransaction.js`, the rollback transaction behind cross-file rename: stage-then-apply with first-staged-order writes, composed re-staging (original text kept from the first read), the pre-write re-read (`changed-on-disk` — a file that changed since staging is never written), reverse-order rollback on first failure, the rollback's own never-clobber verify (`changed-after-write`), per-file rollback-failure reporting, `revert()` after a successful apply (the failed-disk-rename escape hatch), and single-shot apply. Fault-injected over a fake io; the three guards are each verified to FAIL when removed. |
| `test/test_references_for_symbol.js` | The LSP's by-symbol references entry point (`custom/referencesForSymbol`) that powers rename: FB/GVL/DUT roots (a GVL name never appears in its own ST text, so the position-based API cannot seed it), methods/properties/actions, the name-keyed-index identity guard, and index restoration after the scan. |
| `test/test_config_references.js` | The non-code half of rename (`custom/configReferencesForSymbol`): dotted symbol paths inside visualizations `.TcVIS`/`.TcVMO` (`GVL_X.fb.member`, embedded `STSnippet` code) and text lists `.TcTLO`/`.TcGTLO` (a text entry whose text IS a symbol path) are found only when the chain provably resolves to the renamed symbol — text-list ids, visu-library names, dotted prose (`Palletizer.Turn1`) and unresolvable prefixes are never touched. Task configs `.TcTTO` use a separate rule: the `<PouCall>` `<Name>` matches only a dot-free name, so a library call (`VisuElems.Visu_Prg`) is never rewritten. BOM/offset fidelity, plus a sample-project pass when `sample/` is present. |
| `test/test_lsp_parser.js` | Lexer, AST parser and symbol indexer on a synthetic FB: keyword tokenisation, `EXTENDS`/`IMPLEMENTS`, variable types and ranges, nested method params, property GET accessors. Lived outside the suite until 2026-08-05 and **printed `[FAIL]` while exiting 0** — it could report a broken parser and still be green. It counts failures and exits non-zero now. |
| `test/test_lsp_types_sync.js` | Completions and go-to-definition still resolve correctly through symbol-index nodes that carry only stubbed ranges (`startLine:1,startCol:1,...`, no real declaration position) rather than ranges parsed from source — a defensive regression test, since no current indexer (`xmlIndexer.js` builds real ranges) produces stub nodes any more. |
| `test/test_method_diagnostics.js` | Diagnostics for a method body analysed on its own, as the webview does — a valid method must produce none once its POU is indexed. |
| `test/test_memory_bank.js` | The shared memory bank in `.claude/memory/` and the `SessionStart` hook that delivers it. The bank fails silently by nature — a malformed note is skipped, a renamed file breaks the `[[links]]` at it, a dropped hook stops the digest — and sessions just stop being told what the project already learned, which looks exactly like having nothing to tell. Pins the hook contract too (JSON carrying `hookSpecificOutput.additionalContext`, exit 0 whatever happens), since that is what the mechanism depends on and nothing else in the repo enforces it. |
| `test/test_pending_edits.js` | `media/pendingEdits.js`, the edit-sync state machine: store keying (`${componentId}_${blockType}`), stash-overwrite semantics, `takeAll` clearing, `snapshot` shape, the EXACT status strings/classNames, `applyCachedEdits` matching on the full xmlContext triple (an accessorType mismatch must NOT match — the Get/Set disambiguation), `foldEdits` argument order and text threading, and the pinned ALIASING of `createStore(initial)` (`snapshot() === seed` — editor.js's 'init' path relies on it). |
| `test/test_pending_edits_persistence.js` | `src/pendingEditsStore.js`, the workspaceState-backed persistence behind Manual Sync's unsaved edits — the half that makes them survive a window reload. Runs the store over a fake in-memory Memento: a NEW store instance over the SAME memento still returns the edits (that IS the reload — the object dies, the memento does not), a fingerprint mismatch returns `{}` **and** removes the stale entry from the memento, deletes are per-URI, an empty edits object is a delete, an absent entry reads without writing, and the stored value survives the `JSON.parse(JSON.stringify(...))` round trip workspaceState puts it through. |
| `test/test_peek_uri.js` | `media/peekUri.js`, the synthetic peek/goto URI vocabulary: `parseQuery` against independent %-encoded literals, both encoders' defaults and their exact joined query strings (byte-pinned), `decodeGotoTarget` inverting `encodeGotoParts` incl. the null defaults and `Number()` conversions, and `peekOpenMessage`'s full 'openFile' body incl. the zero-length/null-range fallback to `targetWord.length`. |
| `test/test_diagnostic_markers.js` | `media/diagnosticMarkers.js`: severity mapping (1→error, 2→warning, else info) through caller-injected sentinel values, other-component diagnostics dropped, `pane === 'decl'` vs everything-else routing (non-'decl' lands in impl — today's contract), and the marker field shape key-for-key. |
| `test/test_folding.js` | Folding ranges (`media/stFolding.js`). Pins the two reported bugs by name — an unmatched `{endregion}` truncating the enclosing `VAR` fold, and an unindented `{attribute …}` growing a fold arrow of its own — plus the case designed for rather than discovered: `{IF defined(X)}` is a conditional *pragma*, not an `IF` block, and reading it as one leaves an unclosed block that eats every fold below. Also covers keywords inside comments/strings (`$`-escapes included), members named like keywords (`axis.Case`), the separate region/block stacks, every `VAR_*` variant, and a sweep over every pane of every `sample/` object asserting no range is ever out of bounds. |
| `test/test_pragmas.js` | Pragma classification and the two catalogs, plus the highlighting rules in **both** grammars and the `{region}` folding markers. Pins the split the design rests on: shape decides the category (and therefore the colour), the catalog only enriches — so a user-defined attribute must be scoped exactly like a documented one. Also asserts catalog integrity (no duplicates, every documented entry has an Infosys node id, the curated file holds nothing Infosys documents, every curated entry carries measured counts), that pragma spans are consumed whole in the lexer and both grammars, and that the three folding-marker declarations — `pragmas.js`, `language-configuration.json`, `media/editor.js` — still agree, which nothing else can check because none of them can import the others. |
| `test/test_plcproj_scope.js` | The index is scoped to the `.plcproj`, not the filesystem: a project's `objectPaths` (from `createProjectMap`) names only the `<Compile>`d objects, so a backup/orphan copy on disk (a duplicate object name, absent from the project) can never win the name-keyed index and steal a real object's references. Includes the no-`.plcproj` empty-map case and a sample-coverage check proving the scoping is a no-op on the ratchet. Predates the project-scoped index (below) — the guarantee it pins now runs through `createProjectMap` per project instead of one workspace-wide union. |
| `test/test_uri_fs_path.js` | `uriToFsPath()` must return a path the **running** platform can open. The former copies in `workspaceScan.js` and `features/core.js` once ended in an unconditional `.replace(/\//g,'\\')`, which is correct on Windows and on POSIX ate the root — `file:///home/u/a` became `\home\u\a` — so 11 of 59 suites failed on Linux while CI (`windows-latest`) stayed green. Both callers now delegate to the shared production helper in `src/fileUri.js`. Written to hold on **both** platforms so whichever one CI runs still guards the branch it takes: a round trip through the real filesystem (the load-bearing one — a merely plausible converter cannot satisfy it), paths containing a space in both encoded and unencoded form, separator/root shape per platform, bare-path and empty-input passthrough, caller delegation, and unchanged Windows mapping. |
| `test/test_project_map.js` | `src/lsp/projectMap.js`: which `.plcproj` owns which file. Discovery, `objectPaths` per project, `ownersOf()` vs `projectFor()` (a linked file has two owners but a request for it routes to one), the orphan/no-project/case-insensitivity edges, `projectLabel()` (the status-bar text, from `src/projectStatusBar.js`) and `groupRootsByProject()` (the Objects-tree grouping, now in `src/objectsTreeModel.js`, fed this module's map) at both the &lt;2-projects (nothing shown, flat tree) and 2-projects ends. Also pins `TWINCAT_EXTS` staying in sync between `projectMap.js` and `xmlIndexer.js`'s own copies — a real review-caught bug: `projectMap.js`'s copy once missed `.tctleo`, silently dropping every enumeration-text-list object's symbols from a project-scoped scan. |
| `test/test_solution_map.js` | `src/solutionMap.js`: the real `.sln` → `.tsproj` → `_Config/PLC/*.xti` → `.plcproj` chain, multiple PLC projects under one solution, multiple same-named solutions, project labels scoped within their solution, unrelated Visual Studio solutions ignored, and unreferenced PLC projects retained as top-level fallbacks. |
| `test/test_project_template.js` | `src/projectTemplate.js` on both shipped templates: the committed templates match `scripts/build-project-templates.js --check`; every GUID classified; every identity GUID re-issued with every reference following it and each occurrence's case kept (`.sln` upper, `.plcproj` lower); every type GUID kept; no template name left in a path or a byte; BOM, CRLF/LF, tabs and trailing newline preserved and nothing but names and GUIDs changed; starter objects exactly MAIN, PlcTask (calling MAIN) and an empty GVL_Main; the `.tspproj` (4024) and `.tsproj` + `_Config/` (4026) shapes; the created project read back by `projectMap` and `solutionMap`; refusal of a target holding a solution or a file it would write (nothing touched); name validation. |
| `test/test_template_diagnostics.js` | A project created from each template, indexed like `test_sample_diagnostics.js` with every check on: ZERO diagnostics, again after the first edit a user makes (a variable in the `qualified_only` `GVL_Main` used from MAIN as `GVL_Main.x`), and a deliberate undeclared name IS reported (the gate is live). |
| `test/test_start_contributions.js` | package.json for R2: the `twincat` Activity Bar container holding Start, TwinCAT Objects, TwinCAT Libraries in that order with ids unchanged, none left in the Explorer, References still in its panel, no dangling view id in a when-clause; each start command contributed under TwinCAT, in the palette, registered, with an `onCommand` activation event (needed on 1.66); Start view welcome links; a monochrome offline icon; the start page's strict CSP and no remote load; `.vscodeignore` shipping the derived templates but not the raw XAE source; the `twincat.startPage.recentProjectsShown` and machine-scoped `twincat.xaeShell.path*` settings, and the page's command / settings-section allow-lists. |
| `test/test_start_commands.js` | `src/commands/startCommands.js` + `src/startPage.js` under a recording `vscode` stub: create with args and with prompts (files, recents, last location, open here/new/add/none), refusals inline vs as a notification, a deleted recent solution pruned, Generate ST's project pick, help links and settings, the singleton panel, its `state` message (including the recent-list length, clamped, and the XAE Shell paths), a settings change re-posting state to an open page, `openSettings {section}` and Open Settings' query argument, and the command allow-list. |
| `test/test_check_unit.js` | `src/checkUnit.js`: one origin per emitted line, every pane line exactly once and verbatim in pane order (so a reported line/column IS the pane's), generated lines anchored on their component, members before the body, no rewriting (`REFERENCE TO`, `REF=`, pragmas survive), every sample file round-trips. |
| `test/test_compile_check.js` | `src/compileCheck.js` with a fake child process: the bundled compiler as default and the setting as override, Node discovery (order on Windows, the version gate, the editor runtime as last resort with `ELECTRON_RUN_AS_NODE=1`, a configured Node path as the only candidate), setup messages (compiler missing, Node missing/too old, each naming its setting), the command line, the JSON report (clean, errors, malformed, exit 2, crash), mapping to file/component/pane/line, the pragma-warning filter and its count, temp-dir lifetime, timeout, cancellation, `paneRange`. |
| `test/test_compile_commands.js` | `src/commands/compileCommands.js` + the provider hooks under a recording `vscode` stub: the bundled compiler run when nothing is configured, project pick, setup refusal (a missing override), clean run, a run with errors (Problems entries, pane markers, status text, summary), unsaved edits reaching the compiler, Go to Problem and the entry links, an edit dropping its component's results, a failed run keeping the previous results, cancellation, a fresh open landing on the first problem. |
| `test/test_compile_real.js` | **Optional gate `compile-real`**: the REAL compiler — the bundled one, or `TWINCAT_COMPILER_BUNDLE` — first proving the bundled IEC libraries load (`TON`, `R_TRIG`, `CTU`, `LIMIT` resolve; `PID`, from a library NOT shipped, does not), then over every PLC project in `sample/`, through the same code the command uses: ZERO errors and zero warnings after the pragma filter (a ratchet, like the diagnostics baseline), plus planted errors in a method body, a method declaration and a GVL landing on the right file/component/pane/line, and — in the second sample — a call to a method only the FIRST sample's same-named `FB_Cylinder` has, reported in the second sample's MAIN (the projects are never compiled together). Skips (and says so) without a Node >= 22. |
| `test/test_vendored_compiler.js` | `resources/compiler/`: exactly the files `SOURCE.md` lists, each matching its recorded size and SHA-256; a full 40-hex commit and the source link at it; the GPL-3.0, Apache-2.0 and MIT texts; `THIRD-PARTY-NOTICES.md` naming the commit; `.vscodeignore` shipping the directory and dropping `scripts/vendor-compiler.js`; the bundle requiring Node built-ins only. |
| `test/test_recent_projects.js` | `src/recentProjects.js`: newest first, de-duplicated (Windows paths case-insensitive, either separator), capped at 10, missing solutions pruned, malformed stored data ignored, the globalState adapter, and `recentsShownLimit` (the start page's row limit: default 2, clamped to 1..10). |
| `test/test_xae_shell_detect.js` | `src/xaeShellDetect.js` with every dependency faked (runs off Windows): the COM registration for both shells (quoted and argument-suffixed `LocalServer32`, the 32-bit view for 4024, a localized value name), the default locations with and without the environment variables, a registered file that is missing, a non-GUID ProgID value, rejecting / throwing registry and existence probes, non-Windows (nothing found, registry never queried), `createRegQuery` over a fake `execFile` (argument array, timeout, errors → null), `describeConfiguredShells`, and `resolveShellExe` (configured-and-existing wins, else default location, else registry). |
| `test/test_xae_shell_commands.js` | `src/commands/xaeShellCommands.js` under a recording `vscode` stub with detection faked: an empty setting is filled (Global target), a non-empty one is kept even when its file is missing, nothing found writes nothing, `autoFill` never rejects, `twincat.detectXaeShell` reports found / kept / not found in one message whose button opens the filtered settings. Also `findTwinCatShells` in `src/xaeShell.js`: `path4026` ↔ the 64-bit shell, `path4024` ↔ the 32-bit one, a missing configured path ignored (those checks are skipped on Windows, where a real shell may be installed). |
| `test/test_multi_project_scope.js` | End-to-end: two copies of `sample/` under one workspace root (`test/_multiproject.js` builds the fixture, one copy deliberately diverged), driven through the real `scanWorkspace`. Asserts the partition (one index per project, nothing lost to a name collision), 0 diagnostics on the correct copy while the diverged copy's own real error still reports, references and the rename config scan never crossing the project boundary, and the library namespace/symbol registries staying per-project — including the Libraries-view union fallback when no project is specified. Needs `sample/`; skips cleanly when absent. |

| `test/test_object_insert.js` | The Objects-tree insert commands' text, built by driving the **real** `buildNodeFromXml` over real `sample/` objects: the bare name for each kind, and the call template — instance name for an FB (`FB_Gripper` → `fbGripper`, since ST calls an instance, not the type), own name for a FUNCTION/PROGRAM, bare for a method/action, `Name();` when there are no parameters. Also pins that the extracted `callTemplate` is byte-identical to what `libraryTreeProvider` produced before the move, and that every `contextValue` named in the two new `when` clauses is one the Objects tree actually emits (read out of `objectsTreeModel.js`, not hard-coded, so a rename cannot silently orphan the menu items). **One case is synthetic on purpose:** no FB in `sample/` declares root `VAR_INPUT`/`VAR_OUTPUT`, so the mixed `:=`/`=>` ordering case is driven from one clearly-marked XML string through the real parser. |
| `test/test_st_strings.js` | ST string literals across **all three** grammars that must agree — the `src/lsp/parser.js` lexer, the webview's Monarch tokenizer and `syntaxes/twincat-st.tmLanguage.json`. IEC 61131-3 escapes with `$` (`$'`, `$$`, `$N`, `$0D`, …) and a **backslash is an ordinary character**; both highlighting grammars had C-style `\\.` escape rules copied from Monaco's sample, so `'C:\Temp\x\'` swallowed its own closing quote and ran on to the next apostrophe anywhere below — in the reported case an `FB's` inside a comment 16 lines down. Uses that verbatim case. The lexer was always right; only the two grammars were wrong, which is exactly why one harness now pins all three together. |
| `test/test_scan_controller.js` | `src/lsp/scanController.js`: which of the two scan-triggering requests actually has to run a scan. Pins that `ensureScanned` twice over one root set scans **once** (the duplicate startup scan this replaced), that `rescan` after it scans **again** — the assertion that stops a future "optimisation" from teaching the `.plcproj` watcher to skip, since on a content change the roots are unchanged — and that a throwing scan leaves no completed state. Root sets compare order-, case- and separator-insensitively; the empty set is a legitimate *completed* state, or a window with no folders would re-request forever. |
| `test/test_debounce.js` | `src/util/debounce.js`: trailing edge only, one invocation per burst carrying the **last** arguments, every caller's promise resolved. Timers are injected, so it asserts on a fake clock rather than racing a real one. |
| `test/test_collect_scope.js` | Which directories each library walker descends. The `.tmc` and signature walkers must **skip** `_Libraries` while `collectArchives` must **enter** it, and the harness proves the second half is load-bearing by adding `_libraries` to `SKIP_DIRS` and watching archive collection go blind — the tempting one-line "fix" that would silently cost ~171 false positives. |
| `test/test_signature_cache.js` | `src/lsp/parseCache.js`: one dump, three projects → parsed once, two cache hits, all three resolving its symbols. The load-bearing half is **isolation**: each project must hold a *different record object* (asserted by identity, not value — a value check still passes while sharing), so that the merge's `record.namespace` rewrite and `indexBrowserCache`'s member pushes cannot leak between projects. An mtime bump re-parses. |
| `test/test_plcproj_cache.js` | `src/lsp/plcprojRefs.js`: the same `.plcproj` read **once** across all three indexers that need it, not three times, with an equivalence gate comparing every result against a control run that clears the cache between every call — the two consumers genuinely read the file differently (all `<Namespace>` tags vs the first tag whatever it holds) and the shared record has to preserve both. |
| `test/test_archive_identity.js` | The content-identity archive cache: the same archive at two paths with equal mtime is decoded **once** and both paths get identical names; a different `<title>/<version>` tail is *not* shared; an mtime bump re-decodes; a truncated/non-ZIP file returns null without throwing. Also drives `scanWorkspace` end-to-end with the **real** `indexLibraries` composition (the stub is what let nine earlier reviews miss a bug) over two projects vendoring the same archive, asserting one decode serves both. |

`test/run.js <substring>` filters to matching suites. `test/_baseline.js` holds the machine-dependent
diagnostic baselines the sample gates assert against. `test/_multiproject.js` builds the two-project
fixture (two copies of `sample/` under one root, one deliberately diverged) shared by
`test_multi_project_scope.js` and any future project-scoping harness, so they cannot drift from
each other.

The sample-based harnesses run against the committed synthetic project under `sample/`. They still skip
cleanly if a fixture they need is absent, so `npm test` passes even on a pruned tree — but the runner
labels such a run REDUCED rather than letting it pass for FULL.

`scratch/` is a **git-ignored local playground** — nothing in it is tracked, so anything worth keeping
must be moved into `test/` or `scripts/` before it is lost.

**`test/browser/`** runs `media/editor.js` in a real browser — the one part of the codebase no Node
test can reach. Two runners, both outside `npm test` (its runner only discovers top-level
`test/test_*.js`, so a browser harness can never sneak into a run that has no browser).

```bash
npm i --no-save playwright               # optional dep, deliberately NOT in package.json (see below)
node test/browser/run.js                 # the references peek
node test/browser/run_pragmas.js         # ST folding + the Monarch pragma rules
node test/browser/run_start_page.js      # the TwinCAT start page (R2)

# On a runner that already has a browser and cannot download one (offline, image-based CI):
HARNESS_CHROMIUM=/opt/pw-browsers/chromium node test/browser/run.js
```

`HARNESS_CHROMIUM` is passed straight to `chromium.launch({ executablePath })` and is ignored when
unset, so the normal path is unchanged. It exists because a freshly `npm i`-ed playwright insists on
downloading the exact browser build it was compiled against, which fails on a runner that has a
perfectly good Chromium already.

| file | role |
|---|---|
| `build.js` | Generates the page by calling the **real** `getHtmlForWebview()` with a stubbed `vscode` module — a hand-copied page would quietly stop matching what ships. Substitutes only `acquireVsCodeApi()` (records outgoing messages, answers bridge requests from a fixture built off the real sample) and drops the webview CSP, which names `vscode-webview:` sources that do not exist over http. |
| `serve.js` | Serves it. Monaco's AMD loader and its worker Blob both need a real origin. `require()` it for `start(port)`, or run it standalone to poke at the page by hand. |
| `run.js` | The references peek: builds for the port it will serve on, drives Find References, asserts. Also pins the page's global error overlay: opening the peek must leave it hidden, Chrome's benign "ResizeObserver loop completed" notice (dispatched by hand, because whether the real loop fires is layout-timing dependent) must not raise it or post `error`, and a genuine error still must. `HARNESS_PORT` moves it off 8123; `HARNESS_SHOT=x.png` saves a screenshot. Also pins the Generate ST split button (roadmap R1): with one project the caret is hidden and the main button keeps its rounded right end; with two or more the inner corners square off to fuse with the caret (`has-caret` on `#generate-st-group`, set by `editor.js` with the caret's `hidden` flag — no `:has()`, which VS Code 1.66's Chromium lacks). Transitions are disabled for that check so it reads the end state, not a frame mid-animation. Step 7e pins Compile Project's pane markers: `compileDiagnostics` → owner `twincat-compile` on the active component's panes, `st-validator` markers surviving both ways and across a diagnostics refresh, a component switch showing only that component's markers, an edit dropping the edited component's markers and posting `compileDiagnosticsStale`; it writes a pane-marker screenshot (`HARNESS_COMPILE_SHOT`, default `test/browser/out/compile-markers.png`; empty = none). |
| `run_start_page.js` | The start page (roadmap R2): renders the real `renderStartPageHtml()` output WITH its CSP (only `acquireVsCodeApi()` is stubbed, through Playwright's init script), and asserts no request leaves the page's origin, the project name is validated while typing (shared `media/projectName.js` rules, `aria-invalid`), Create posts `{version, name, location}` and shows a host refusal, every other control posts its message, project actions are disabled while no project is open, Compile project is enabled only with `compilerReady` (the compiler file exists — by default the bundled one) AND a project, shows "Compiler file not found" otherwise (and names no compiler product), the form survives in webview state, the recent list shows at most `recentsShown` rows behind a keyboard-operable "Show all (K)" / "Show fewer" tile (local to the page, follows a changed limit), the Settings card shows the two XAE Shell paths with a warning row for a path that is not on disk and posts `openSettings {section}` / the detect command, and there is no horizontal scroll at 360/560/1200 px (one column at 360). Defaults to port 8125. |
| `run_pragmas.js` | Folding and pragma highlighting. Folds real blocks and reads back the rendered lines, then tokenizes through Monaco's **own** tokenizer. Both fail silently if they regress, which is the point of driving a browser: a unit test on `stFolding.js` cannot prove Monaco actually *used* it rather than its own indentation provider. Carries the two reported bugs as regressions, and asserts implementation-pane blocks still fold — registering a provider replaces indentation folding, so that is the thing most likely to disappear unnoticed. Verified: removing the provider turns 6 assertions red, and the failure text reproduces both original bug reports verbatim. Defaults to port 8124. |

`run.js` asserts what only a browser can show: that the peek lists cross-file hits at all, that exactly
the **non-live** panes get hidden models (a hit in the active component must use the live pane), that a
cross-file entry previews the other file's real text, that double-clicking posts coordinates which
land on the word itself, and that a second search retires the pane it no longer needs instead of
accumulating models. Verified to fail on a regression, not just to pass: disabling the pane texts
drops the peek to `References (1)` — the old behaviour — and four assertions go red.

Not in `npm test`, and **Playwright is not in `package.json`**: it is a heavy dependency that CI would
install on every run for a harness CI cannot execute anyway. Both runners exit 2 with the install
command when it is absent. **Run both whenever `media/editor.js` changes.** Since Phase 8 the pure
decisions extracted from it (`media/pendingEdits.js`, `media/peekUri.js`, `media/diagnosticMarkers.js`)
have plain-Node harnesses in `npm test`, but the wiring, DOM writes and Monaco interplay that remain
in `editor.js` are still browser-only surface — the extraction narrows what only these runners can
catch; it does not waive them.

**`test/devhost/`** runs the extension in a **real VS Code window** — the two links that neither the
Node harnesses nor the browser harness can reach: `vscode.openWith()` URI identity (does a navigation
reuse the open tab, or open a duplicate?) and the live `vscode-languageclient` transport. One runner,
outside `npm test` for the same reason as the browser pass (it needs an installed VS Code, and it opens
a visible window for ~30 s that closes itself):

```bash
node test/devhost/run.js
```

`run.js` copies the committed first sample twice (`LineA`/`LineB`) under one temp workspace, adds a second
PLC project to LineA's solution, copies in the second sample (`TcToolkitSample2/`, the 3.1.4024
`.tspproj` layout) as a third solution, and launches the **installed** VS Code as a separate
instance (fresh `--user-data-dir`/`--extensions-dir`, so a running VS Code is untouched) with this repo
as the development extension and `testRunner.js` as the `--extensionTestsPath` module. In-host, that
module patches `TwinCatCustomEditorProvider.prototype.resolveCustomTextEditor` to trace every panel's
resolve → `ready` → `init` chain (a break anywhere is a permanently blank viewer), opens a GVL, asks the
live client for a cross-file definition and its references, then navigates with exactly the URI the
definition returned. It drives the real Objects provider and status-bar formatter too, asserting two
solution roots, two PLC-project children under LineA, and the globally disambiguated status labels. It also
invokes the two **Objects-tree insert commands** and captures what reaches
the webview — `src/commands/objectInsertCommands.js` is `vscode`-bound, so `test_object_insert.js` can
only cover the pure template half, and this is the only place the rest of the path (tree node → XML
parse → template → posted at the caret) is exercised at all. The same real-host pass intercepts the
`twincatExplorer` TreeView and verifies definition/reference navigation reveals the exact method,
property, Get/Set accessor and virtual-folder action through their PLC-project and solution parents;
switching away from and back to a retained webview must keep that component selected. It asserts the
URI keeps the **on-disk spelling** and that navigation **reuses**
the open tab — the 0.6.0 regression (fixed in 0.6.1) minted lowercased URIs from the normalized project
partition, and every cross-file Go to Definition then opened a duplicate tab titled `gvl_system.tcgvl`
with nothing highlighted. The fixture also injects a **`.TcTLEO`** into LineA's project and the in-host
pass edits it **on disk** and re-queries the live index — the gate for the 2026-08-24 watcher fix
(`TWINCAT_WATCH_EXTS` omitted `.tctleo`, so an external `.TcTLEO` edit never reached the LSP; only a
real host runs the watcher chain, so this is the one place it can be proven). The **start-page phase**
(roadmap R2) checks what only a real host shows: every start command registered, the `TwinCAT` Activity
Bar container and its Start / Objects / Libraries views open (`workbench.view.extension.twincat`,
`<view>.focus`), *TwinCAT: Open Start Page* opens the `TwinCAT Start` tab, and *Create New Project* (with
its arguments, so no dialog) writes a 3.1.4026 and a 3.1.4024 solution and refuses a second create. The
**compile phase** (R3.2/R3.3) runs *TwinCAT: Compile Project* on every PLC project of the fixture
through the real command, with the **bundled** compiler (asserted) — `TWINCAT_COMPILER_BUNDLE` (and
`TWINCAT_COMPILER_NODE`) override it, written by `run.js` into the fresh profile's `twincat.compiler.*`
settings. Only when the host's `checkSetup` finds no Node >= 22 does the phase print `[SKIP]` and assert
nothing. It asserts every run finishes, that no
error is reported on the sample's own code (only the identifiers the P8 phases typed on purpose, which
reach the compiler as unsaved edits, plus the object-insert phase's snippet in its file), and that each
project's files in the Problems panel hold exactly that project's results.

The same pass also automates the **P8 webview checklist** (items 2–7 of
`docs/superpowers/plans/2026-08-22-deepen-08-g4-checklist.md`) through **`media/devHostTestHook.js`** —
webview instrumentation the provider injects **only** when `TCDEV_TEST=1` is set (which only
`test/devhost/run.js` does; the file is also `.vscodeignore`d, so it is absent from the VSIX). The hook
drives the REAL Monaco editors (typing goes through `onDidChangeModelContent`, so editor.js's own
Auto/Manual branch runs) and reads page state back; it must load before `editor.js` because it memoizes
`acquireVsCodeApi`, which throws on a second call. Seven phases cover: Manual-Sync edit accounting and
the cross-process pending-edit round trip (tab **closed** and reopened, Get-vs-Set xmlContext-triple
match, plus the PERSISTED `twincat.pendingEdits` workspaceState entry itself — closing a tab keeps the
host alive, so only the persisted entry can speak to reload survival; the harness reaches the real
`ExtensionContext` through `this.context` inside its provider-prototype patch), byte-identity of the flushed file against `foldEdits` over the webview's own records, the
flush-vs-save asymmetry (an empty manual save still posts 'save'), Auto-mode per-keystroke saves,
real-`MarkerSeverity` diagnostics in the correct pane including the collapsed-decl Action case, exact
cross-file Go to Definition selection, and a cross-file peek row click-through (the peek list is
virtualized and only the focused group opens — the hook expands the target file's group by its twistie
first). The remaining MANUAL residue of that checklist is two gestures: a Ctrl+R window reload with
unsaved Manual-Sync edits pending, and eyeballing that squiggles actually render. Results flow through a
progressive JSON file the runner polls, so a hang
still leaves evidence of the last step reached. **Run it whenever navigation identity, the
custom-editor resolve chain, the file watchers, the webview edit-sync path, or the LSP bridge wiring
changes.**

**`asWebviewUri` must return ABSOLUTE urls.** Root-relative ones look equivalent, but the Monaco worker
runs from a `blob:` URL with no base to resolve them against, and it fails with "Failed trying to load
default language strings" — the same symptom this project already records for a wrong AMD baseUrl.

**Branches.** `main` is what gets released; **`dev`** is where day-to-day work is merged. When a release is
ready: open a `dev → main` PR (CI runs on it), merge, then run the *Release* workflow on `main` (below).

CI (`.github/workflows/ci.yml`) runs on every PR to **`main` or `dev`** — PR-only by design: the `push`
trigger is disabled so a merge does not re-run what the PR already proved, and a direct push to `dev`
triggers nothing. To check a ref without a PR, run **CI (manual)** by hand: Actions tab → *CI (manual)* → *Run workflow*, or
`gh workflow run ci-manual.yml`. Its `ref` input is what gets checked out and tested and **defaults to
`dev`** — the branch dropdown beside it only selects which copy of the workflow files runs (GitHub lists a
`workflow_dispatch` workflow from the default branch), so it can stay on `main`. `ci-manual.yml` is a shell
whose single job `uses: ./.github/workflows/ci.yml` (which declares `workflow_call` with a `ref` input next
to `pull_request` for exactly this; on a PR the input is empty and the checkout is the event's own ref), so
the gates are defined once. CI itself is Windows-only (the platform users are
on), with superseded runs cancelled and a read-only token. Two jobs:

- **`build`** (current Node) — `npm run lint` (ESLint needs Node ≥ 18.18, so lint lives only in
  this job), `npm run typecheck`, `npm test` with **`REQUIRE_FULL_SUITE=1`** (the
  sample is committed, so CI achieves FULL coverage; a run whose load-bearing gates skipped fails
  instead of passing quietly), then a **VSIX build check** (`vsce package`). Packaging is otherwise
  only exercised by hand at release time, where a broken manifest or `.vscodeignore` would surface
  far too late.
- **`runtime-compat`** (Node 16 and 20) — `npm test` only. The extension runs on the Node that VS Code
  bundles, not the CI default: `engines.vscode` is `^1.66.0`, and VS Code 1.66 ships Electron 17
  (Node 16), so the suite must keep working there or that support claim is fiction. Tests only is
  deliberate — the type-check (TypeScript 7) and `vsce` both require a modern Node, so running them
  on 16 would fail on tooling constraints rather than on anything about the product. **If this job
  ever goes red, the honest fixes are to stop using the newer API or to raise `engines.vscode`** —
  not to drop the version from the matrix.

**CI is always a REDUCED run** — see the section above.

Releases are a separate, manual workflow (`.github/workflows/release.yml`, the only one with a write
token) — see "Publish a GitHub release" under "Package a VSIX".

**`sample/` is ground truth.** It holds two *correct* TwinCAT solutions, so every diagnostic reported
on either is a bug. Never fix a red gate by raising the baseline.

- **`sample/TcToolkitSample/`** — XAE 3.1.4026's layout (`.sln` + `.tsproj` + `_Config/`), 19 objects,
  and the library fixtures (the committed `.tmc`, the MIT archive, four library references). Made by
  `scripts/Create sample PLC project/build-sample-solution.ps1` (XAE, once) +
  `build-sample-project.js <plcProjectRoot>` (the objects). Harnesses that pin library facts read this
  solution only (`SAMPLE_PROJECT_DIR` in `test/_baseline.js`).
- **`sample/TcToolkitSample2/`** — the 3.1.4024 layout (`.sln` + a single-file `.tspproj`, the PLC project
  `TcToolkitSample2_PLC` nested under the system project's folder), 7 objects: `MAIN` and `FB_Cylinder`
  (same names as the first sample, different code and members), a GVL, a STRUCT, an enum, the interface
  `I_Valve` and `FB_Valve` implementing it with a method, a GET/SET property and an action. No library
  symbol, no `.tmc`. Generated in full — no XAE needed — by
  `scripts/Create sample PLC project/build-sample-project2.js`: `createProject` from
  `src/projectTemplate.js` over the shipped 3.1.4024 template (identity GUIDs DERIVED from a counter, so a
  rebuild is byte-identical), then the objects through `build-sample-project.js`'s `renderObject` /
  `registerObjectsInPlcProj` (the element shapes the Objects-tree commands write). Regenerate:

  ```bash
  node "scripts/Create sample PLC project/build-sample-project2.js" --check   # committed tree == fresh build?
  node "scripts/Create sample PLC project/build-sample-project2.js" --write   # rewrite the generated files in place
  node "scripts/Create sample PLC project/build-sample-project2.js"           # first creation (refuses if it exists)
  ```

  `test/test_two_samples.js` runs the `--check` comparison, so an edit to the generator, the template or
  the committed files without the other fails the suite. After building it in XAE, the `.tmc` and build
  output stay untracked (`sample/.gitignore`).

The ratchets diagnose **one PLC project at a time** (`sampleProjects()` in `test/_baseline.js`, the
product's `createProjectMap` partition): one flat index over both samples would report their same-named
objects as false positives the product never shows. `test_sample_diagnostics.js` also diagnoses every
object **opened fresh** (the scan-time index plus that one unit) — the state the server is in for the
first file a user opens, which the in-order pass masks.

## Architecture

```
extension.js            Thin activation hub: wires providers/views/watchers/LSP client, delegates commands
src/
  commands/             Command registration, split out of extension.js — each exports register*(context, deps)
    objectCommands      "TwinCAT Objects" create/delete (methods, properties, actions, files, folders);
                        Add Get/Set Accessor re-adds a property's missing accessor (issue #25)
    clipboardCommands   "TwinCAT Objects" copy/paste (duplicate a component cross-file or a file under a new name)
    renameCommands      "TwinCAT Objects" rename (files, members, directories, virtual folders; reference-aware;
                        cross-file updates staged and applied through renameTransaction)
    libraryCommands     "TwinCAT Libraries" commands (refresh, insert, copy, Update Library Definitions)
    lspBridgeCommands   openComponent navigation + the twincat.lsp.query* Monaco↔LSP bridges
    startCommands       The TwinCAT sidebar's Start view (an empty tree, so its viewsWelcome buttons show)
                        and the start commands: Open Start Page, Create New Project (version → name →
                        location prompts, or all three as args from the start page; then open here /
                        new window / add to workspace), Open Existing Project (.sln or folder, or a
                        recent entry), Generate ST (multi-pick when 2+ projects), Open Settings and the
                        help links. The start page runs these same commands — no second code path.
                        Open Settings takes an optional `twincat.*` section as its Settings-UI query;
                        a change to twincat.startPage.* / twincat.xaeShell.* re-posts an open page's state
    compileCommands     `twincat.compileProject` (roadmap R3.2): project pick, setup refusal with "Open
                        Settings", the run under a cancellable progress notification, and where the
                        results go — a DiagnosticCollection `twincat-compile` (Problems, at the XML
                        position), the panes (through the provider), a status-bar item, a summary
                        notification with "Go to Problem…" (`twincat.compile.goToProblem`), and a URI
                        handler for each entry's code link (`/compileProblem?id=N`). The VS Code half
                        of compileCheck
    xaeShellCommands    `twincat.detectXaeShell` + the silent activation-time fill of the two
                        `twincat.xaeShell.path*` settings (EMPTY ones only, ConfigurationTarget.Global;
                        never overwrites). The VS Code half of xaeShellDetect
  checkUnit             Compile Project's check unit: one ST unit per TwinCAT object with a per-LINE
                        origin map back to component/pane/line. Pane text verbatim (never the export's
                        rewrites), members BEFORE the POU body. NOT the live path's unit. vscode-free
  compileCheck          Compile Project's vscode-free half: setup check (the bundled compiler
                        resources/compiler/compiler.cjs unless twincat.compiler.path overrides it;
                        Node >= 22 FOUND by nodeCandidates/findNode), check inputs from object texts, the compiler run as a CHILD
                        PROCESS (`--check --json --dialect-file resources/dialects/twincat3.json`,
                        `--global-list N.st=<GVL>` per GVL; never `require()`d, never `--strict`) in
                        a temp dir deleted afterwards, timeout + cancel, JSON report → file/component/
                        pane/line, the pragma-warning filter (counted), paneRange. Spawn injected
  projectTemplate       Create a NEW TwinCAT solution from a shipped template (roadmap R2): copy,
                        rename solution/system/PLC project (`<Name>`, `<Name>_PLC`), re-issue every
                        identity GUID consistently, keep every byte else. vscode-free, unit-tested.
                        See "Project templates" below
  startPage             The start page: a singleton webview panel (+ serializer) whose messages map
                        onto the twincat.* commands; command allow-list; links leave via openExternal.
                        Its `state` message also carries the recent-list length
                        (twincat.startPage.recentProjectsShown) and the two XAE Shell paths with
                        whether each exists; `openSettings {section}` opens an allow-listed section
  startPageHtml         The start page's HTML (pure; strict CSP, no remote loads) — the browser
                        harness renders this same function
  recentProjects        Recent TwinCAT solutions for the start page (pure list logic + a globalState
                        adapter): newest first, max 10, case-insensitive on Windows paths, pruned on read;
                        `recentsShownLimit` clamps the shown-rows setting to 1..10 (default 2)
  xaeShell              XAE shell discovery + the library-signature generator (the one non-offline path).
                        A configured twincat.xaeShell.path4026 (64-bit) / path4024 (32-bit) that exists
                        wins for its shell; otherwise default location, then the COM registration
  xaeShellDetect        Where the XAE Shell of 3.1.4024 / 3.1.4026 is installed, for the
                        twincat.xaeShell.path* settings: COM registration (ProgID → CLSID →
                        LocalServer32 via `reg.exe query`, 3 s timeout), then the default Program Files
                        location. Pure — platform, env, exists and regQuery are injected; off Windows
                        it finds nothing and spawns nothing. Also `resolveShellExe`, the choice
                        xaeShell makes between a configured path and its own discovery
  customEditorProvider  Webview host: bridges Monaco ↔ LSP via livePath, writes CDATA back. Each
                        custom/* handler is now assemble → query LSP → delegate to a livePath
                        collector → post; it holds no reference/definition mapping loops itself.
  pendingEditsStore     Persistence for Manual Sync's unsaved edits, over `context.workspaceState`
                        (per workspace, never globalState). In Manual mode the webview posts no
                        'edit', so the TextDocument stays CLEAN and nothing else — not hot exit, not
                        retainContextWhenHidden — carries the edits across a window reload; they
                        used to live in an in-memory Map and were lost on Ctrl+R. Each entry is
                        fingerprinted (`length:sha1`) against the document text it was captured
                        from, and a read whose fingerprint no longer matches DISCARDS the entry
                        rather than splicing stale edits into a changed file. vscode-free (it takes
                        any Memento-shaped `{get, update}`), which is what makes it harness-testable.
  livePath              The live language-feature path, vscode-free: ST assembly (assembleSt),
                        pane↔unit coordinate + pane-slice + peek-model helpers, the injected-read
                        unit resolver (createStResolver), and the three collectors that turn a raw
                        LSP answer into what the webview/panel need — mapDefinition (go-to-def),
                        collectPeekReferences (peek panes + mapped refs, budget-bounded by
                        PEEK_MAX_PANES/PEEK_MAX_TEXT_BYTES), listExternalReferences (the References
                        panel's flat item list) — plus mapDiagnosticsToLocal, the diagnostics→pane
                        range mapping (moved out of stConverter, answering in the same
                        'decl'/'impl' dialect as everything else here).
                        Owns what editorMapping.js used to plus the
                        assembly/resolver/collection logic that lived in customEditorProvider.js;
                        the host and the harnesses now drive the SAME functions.
  fileUri               Central Windows path ↔ file URI conversion and comparison boundary
  twincatWorkspace      Single owner of workspace-discovery knowledge (fs/path only, a pure leaf):
                        the recursive skip-walk (walkFiles, regular files only), the skip-dir set
                        MATRIX (variance preserved deliberately — see its header), the three
                        TwinCAT extension vocabularies, XML-entity decode, and the shared
                        suffix-disambiguation core (two option modes: solution-scoped default,
                        workspace-global for projectMap). Consumed by both host and LSP modules.
  componentId           Single owner of the component-id string grammar (root/method_/prop_/
                        prop_*_get/prop_*_set/action_/transition_) shared by webview, host and
                        LSP; vscode-free. The grammar is FROZEN (ids travel over the bridge and
                        into saved state); prop_X_get parses as accessor-of-X by pinned convention
  objectsTreeModel      The "TwinCAT Objects" tree as a vscode-free node graph: shape rule (solutions →
                        projects; one root per project at 2+; else flat), nodes with parent links,
                        children and stable ids; makeNode is the ONE place id and contextValue are set.
                        I/O and uris come from an injected host
  treeDataProvider      Thin VS Code adapter over objectsTreeModel: elements ARE model nodes (commands
                        receive them), getTreeItem builds the TreeItem, getParent = node.parent,
                        getChildren/getRevealItem forward to the model (cached until refresh() or a
                        project/solution map or workspace-folder change)
  solutionMap           TwinCAT .sln → .tsproj → .xti → .plcproj presentation model for that tree (also the
                        single-file .tspproj system project 3.1.4024 writes, whose <Plc><Project> names
                        the .plcproj inline)
  projectStatusBar      Status-bar "which PLC project is this file in" indicator (2+ projects only);
                        projectLabel() is pure/vscode-free so it is unit-testable — vscode is required
                        lazily, inside createProjectStatusBar()
  dndRules              Objects-tree drag & drop + copy/paste compatibility matrices (vscode-free, so testable)
  renameEngine          Rename: maps LSP reference positions back into CDATA splices (vscode-free, so testable)
  renameTransaction     Rename: the stage/apply/rollback transaction over the cross-file writes — a
                        multi-file rename either fully lands or every already-written file is restored
                        (reverse order, verify-before-write and verify-before-restore, rollback
                        failures reported per file). Injected read/write, vscode-free, so testable
  treeDragAndDrop       Objects-tree drag & drop controller — executes the matrix's plans (needs VS Code 1.66+)
  libraryTreeProvider   "TwinCAT Libraries" explorer tree (library → types → members). Scopes to the
                        ACTIVE file's project (revealUri → setActiveFile; refetches only when the
                        owning project changes) and says so in the view description (2+ projects
                        only); union of all projects when nothing owns the active file. The scope
                        decisions are exported pure helpers, pinned by test_library_scope.js
  referencesProvider    "TwinCAT References" results view (+ referencesTree grouping)
  objectKinds           Kind → codicon → tooltip for the Objects tree (vscode-free, so it is testable);
                        also owns the property row's contextValue (`propertyNode[.noGet][.noSet]`,
                        naming the MISSING accessors) and `isPropertyNode` — test property rows with
                        it in code and `viewItem =~ /^propertyNode\b/` in menus, never `== 'propertyNode'`
  insertTemplates       Call/usage templates + parameter ordering, shared by the Libraries AND Objects
                        insert commands so both produce identical text (vscode-free, so testable)
  util/
    debounce.js         Trailing-edge debouncer with injectable timers (vscode-free, so testable)
  xmlParser             TwinCAT XML parse / structural edits (preserves formatting). A small
                        CDATA/comment-aware element scanner: each component reads only its OWN
                        Declaration/Implementation (members = the root's direct children); a non-ST
                        body reads implementation: null + implementationLanguage; attribute values
                        are decoded on read and re-encoded by every writer;
                        insertPropertyAccessorIntoXml re-adds a missing Get/Set (Get before Set)
  stConverter           XML → clean Structured Text + line map (also a raw mode for the live path);
                        keeps the POU kind as written (a PROGRAM stays a PROGRAM) and returns
                        `warnings` for members it cannot convert (SFC transitions);
                        clean mode flattens struct EXTENDS from collectStructDefinitions() over
                        the exported project's own DUTs — no hard-coded type names
  plcProjHelper         Keeps the .plcproj file in sync on create/delete
  lsp/
    server.js           LSP server (Node IPC) + custom JSON-RPC bridge requests; owns the workspace index
    projectMap.js       Which .plcproj owns which file: ownersOf() (every project that <Compile>s the
                        file) vs projectFor() (the one project a request routes to). Dependency-free
                        (fs/path only, no vscode) so both the server and the extension host can use it.
    workspaceScan.js    One symbol index per PLC project + the request-routing API. Kept out of
                        server.js on purpose: server.js opens an IPC connection at require time, so
                        nothing that requires it is loadable by a standalone harness — the connection is
                        injected here as log/error callbacks instead.
    requestPipeline.js  The request router (withDocument makes the pre-handler document sync
                        structural; withoutDocument is the EXPLICIT no-sync variant) and the
                        library-index stage table (LIBRARY_INDEX_STAGES, order validated at module
                        load; stage runners injected by server.js). IPC-free — the third instance
                        of the same harness-loadability injection pattern as scanController.js.
    scanController.js   Decides WHEN to scan, separately from how. custom/reindex = "rebuild
                        unconditionally"; custom/indexReady = "resolve once these roots are indexed".
                        Outside server.js for the same harness reason; the scan is injected.
    parseCache.js       library-signatures.xml + browsercache parses, cached on (path, size, mtime).
                        Signature records are CLONED per project — see the warning in its header.
    plcprojRefs.js      One shared, cached .plcproj read (library references + namespaces). The same
                        file used to be read three times per project per scan.
    log.js              Structured, quiet-by-default logging for the LSP process (threshold `warn`,
                        TWINCAT_LSP_LOG=debug to opt in; stderr, one line per record; never throws;
                        below-threshold calls cost one comparison). The request handlers still return
                        their safe defaults on failure — the logger is what makes a default
                        explicable. Routine healthy-project conditions belong at debug, never warn
    parser.js           Structured Text lexer + symbol parser
    symbolNode.js       Single factory for a symbol node's core shape (parser + xmlIndexer build through it)
    features.js         Facade re-exporting features/{core,completions,definition,references,configReferences,highlights,diagnostics}
    features/completions.js  Autocompletion ORCHESTRATOR + façade (public surface unchanged): walks
                        pragma → member access → named params → caret-context classification and
                        assembles what each context accepts. The systems live in completion/
    completion/         The completion engine's parts, split by seam (behavior-identical extraction):
      pragma.js           completions inside `{ … }` (pure, catalog-backed)
      context.js          classifyCaretContext + the token/keyword vocabularies it reads
      namedParams.js      argument-name completions for calls / FB init lists
      memberAccess.js     the dotted-caret branch: project members, library namespaces (nested too),
                          external (.tmc) type members, chained library member walks
      sources.js          the push* candidate sources, ranking prefixes, snippets and keyword lists
    features/configReferences.js  Rename's non-code half: PLC symbol references inside visualizations, text lists and task configs
    builtins.js         Standard IEC/TwinCAT types, keywords, functions/FBs
    types.js            Type model, resolver, member lookup, assignability
    exprParser.js       Expression type inference (for assignment checks)
    xmlIndexer.js       Indexes TwinCAT XML objects into real-range symbol nodes
    libraries.js        Library namespaces, read from the .plcproj
    libsymbols.js       Library symbols: ZIP reader over the library archives + the project's .tmc
    pragmas.js          Classifies `{ ... }` pragma spans (shape first, catalog second) — see below
    pragmaCatalog.json      GENERATED from Beckhoff Infosys by scripts/fetch-pragma-catalog.js
    pragmaCatalogExtra.json Hand-curated: real attribute names Infosys does not document
    librarySignatures.js  Parses library-signatures.xml (function sigs, FB I/O, global constants)
    browserCache.js       Reads TwinCAT's per-library browsercache → FB/interface method + property NAMES
.claude/
  settings.json         Committed project settings. Declares the SessionStart hook below — so a
                        clone needs no setup — and is the only settings file that is committed.
  memory/               Shared memory bank: lessons this project already paid for, version-controlled
                        so they follow the work across machines. bank.js emits the session digest
                        (and `--check` validates); README.md has the format. Rules in CLAUDE.md.
  agents/               Custom subagent definitions (implementer)
media/
  editor.js / editor.css  Monaco webview front-end (two panes, providers, sync)
  stFolding.js          ST folding ranges from block structure. Dual-mode: a <script> tag in the
                        webview, require()d by extension.js for plain .st files — one algorithm,
                        both editors, no build step. See "Folding" below.
  pendingEdits.js       The pending-edit/manual-sync state machine (store, status text, cached-edit
                        restore) — the logic that decides whether a user's edits reach disk. Dual-mode
                        like stFolding, and ALSO require()d by src/customEditorProvider.js for
                        foldEdits: the cross-process edit-record shape { context, blockType, content }
                        is produced (webview stash) and consumed (host fold) by ONE module, so the
                        contract is stated on both sides of the process boundary.
  peekUri.js            The webview's synthetic peek/goto URI vocabulary: both schemes, the query
                        codec, and the 'openFile' message built from a peek click. Dual-mode; pure
                        (never touches monaco — callers wrap parts in monaco.Uri.from). The peek-model
                        PATH is minted host-side by livePath.peekPath and embedded verbatim (recorded
                        ruling: that function stays in src/).
  diagnosticMarkers.js  Pane split + Monaco marker shape for per-component diagnostics. Dual-mode;
                        monaco-free via caller-injected severity values.
  projectName.js        The project-name rule (identifier-safe, Windows-safe, no `__`, no trailing `_`).
                        Dual-mode: the start page validates while typing, src/projectTemplate.js refuses
                        the same names host-side
  startPage.js / startPage.css  The start page's script and theme-variable stylesheet (single column
                        under ~640 px)
  twincat-activitybar.svg  The Activity Bar icon (monochrome ladder glyph, drawn for this project; no
                        vendor artwork). Inlined into the start page with currentColor
  marketplace-icon.png  The 256px extension icon package.json points at. GENERATED by
                        scripts/make-icon.js — never hand-edited.
  icon.png              The 1280x640 GitHub social preview (same mark beside the name). GENERATED by
                        scripts/make-social-preview.js; .vscodeignored, nothing in the extension uses it.
resources/
  templates/tc3.1.4024/, tc3.1.4026/  The shipped project templates, GENERATED by
                        scripts/build-project-templates.js — never hand-edited
  templates/xae-3.1.4024/  Raw XAE 3.1.4024.62 output, the 4024 template's source (.vscodeignored)
  dialects/twincat3.json   The vendored STruC++ dialect profile (R3)
  compiler/             The bundled STruC++ compiler (R3.3), WRITTEN by scripts/vendor-compiler.js —
                        never hand-edited: compiler.cjs (the fork's dist/strucpp-bundle.cjs, renamed so
                        no product name reaches the UI), libs/iec-standard-fb.stlib +
                        iec-std-functions.stlib, the GPL-3.0 LICENSE/COPYING/COPYING.RUNTIME,
                        third-party/ (chevrotain Apache-2.0, lodash-es MIT), SOURCE.md (repo, commit,
                        size + SHA-256 per file). Ships in the VSIX
scripts/
  vendor-compiler.js    Copies a BUILT, clean fork checkout into resources/compiler/ and records its
                        commit. Dev-only, .vscodeignored
  build-project-templates.js  Derives resources/templates/tc3.1.40xx/ from the XAE skeletons;
                        `--check` exits 1 when the committed copies are stale. .vscodeignored
  glyphRaster.js        The renderer behind both images: TrueType outline reader, scanline rasterizer,
                        hand-rolled PNG encoder, and drawMark (the logo itself, so both draw the SAME
                        mark). Reads Segoe UI from C:/Windows/Fonts; only the pixels are committed.
                        Dev-only, .vscodeignored, not in the typecheck graph.
```

### Project templates (Create New Project, roadmap R2)

Only TwinCAT XAE has ever written a `.sln` → system project → `.plcproj` skeleton that XAE accepts, so
**Create New Project copies an XAE-made skeleton** instead of writing one. Two templates ship:

| version | source | shape |
|---|---|---|
| 3.1.4026 | the XAE 3.1.4026.22 skeleton under `sample/TcToolkitSample/` | `.sln` + `.tsproj` + `_Config/` (PLC `.xti`, instance `.xti`/`.xtv`) |
| 3.1.4024 | `resources/templates/xae-3.1.4024/` (XAE 3.1.4024.62) | `.sln` + one `.tspproj` (PLC project named inline, no `_Config/`) |

`node scripts/build-project-templates.js` derives `resources/templates/tc3.1.4024/` and `tc3.1.4026/`
(names `TcTemplate` / `TcTemplate_PLC`); `--check` fails when the committed copies are stale, and
`test/test_project_template.js` runs that check. What the derivation does:
- **4024:** the GVL becomes `GVL_Main` with its sample variable removed — XAE's own default GVL text,
  `{attribute 'qualified_only'}` / `VAR_GLOBAL` / `END_VAR` — and the `.plcproj` `<Compile>` follows.
- **4026:** strips what `scripts/Create sample PLC project/build-sample-project.js` injected (its objects'
  `<Compile>` entries, read from its exported `OBJECTS`, and every `<Folder>` beyond XAE's
  `DUTs`/`GVLs`/`VISUs`/`POUs`), plus what the sample gained by hand or by building: the
  `TwinCat Dynamic Collections` reference and the `<None Include="….tmc">` item. The sample's `MAIN` was
  overwritten with synthetic code, so `MAIN` and `GVL_Main` take XAE's object text from the 4024 skeleton
  (minus `ProductVersion`, since this `.plcproj` has `WriteProductVersion` false), with derived Ids.
- Never a `.tmc`. Starter content is exactly `MAIN`, the `PlcTask` that calls it, and the empty `GVL_Main`.

`src/projectTemplate.js` then creates `<location>/<Name>/`: solution and system project `<Name>`, PLC
project `<Name>_PLC`, names replaced in paths and text in one longest-first pass; BOMs, CRLF/LF, tabs,
attribute order and a missing trailing newline are carried over byte for byte. It refuses a target that
already holds a `.sln`/`.tsproj`/`.tspproj`/`.plcproj` (scope is a new solution only) or any file it
would write, opens every file exclusively, and removes what it wrote if a write fails.

**GUID inventory.** Every GUID in a template is classified by where it sits (`IDENTITY_CONTEXTS` /
`KEEP_CONTEXTS` in `src/projectTemplate.js`); one that is neither, or both, fails the template build and
every create — a guess either way can produce a project XAE refuses.

Re-issued (same old GUID → same new GUID in every file; each occurrence keeps its letter case — the
`.sln` writes them upper-case, the `.plcproj` lower-case). These are what XAE mints fresh for a new
project; `LibraryReferences`, `Application`, `TypeSystem` and the `Implicit_*` ids differ between the two
XAE skeletons, which is what shows they are per-project ids and not kind GUIDs:

| GUID | where |
|---|---|
| system project | `.sln` `Project(…) = …, "{ID}"`; `.tsproj`/`.tspproj` `ProjectGUID` |
| solution | `.sln` `SolutionGuid` |
| PLC project | `.sln` configuration lines; `.tspproj` or `_Config/PLC/*.xti` `<Project GUID>`; `.plcproj` `ProjectGuid` |
| PLC project objects | `.plcproj` `Application`, `TypeSystem`, `Implicit_Task_Info`, `Implicit_KindOfTask`, `Implicit_Jitter_Distribution`, `LibraryReferences` |
| task | `PlcTask.TcTTO` `Task Id`, `TaskFBGuid`, `Fb_init`, `Fb_exit`, `CycleUpdate`, `PostCycleUpdate` |
| objects | every `Id="{…}"` in `.TcPOU`/`.TcGVL`/`.TcDUT`/`.TcIO` (MAIN, GVL_Main) |

Kept (identical in every project XAE writes):

| GUID | why |
|---|---|
| `.sln` `Project("{…}")` type — `{DFBE7525-…}` (.tspproj), `{B1E792BE-…}` (.tsproj) | the project KIND |
| instance `.xti` `<CLSID>` `{08500001-0000-0000-F000-000000000064}` | the TcCOM class of a PLC instance |
| `.xtv` `TmcHash` | a content hash of the `.tmc`, not an identity; XAE recomputes it on build |
| everything inside the `.plcproj` `<XmlArchive>` (`{40450F57-…}`, `{54dd0eac-…}`, …) | option category and type keys |

Still owed, on the user's Windows machine: each template, created through the command, opened and built
in its own XAE version (3.1.4024 and 3.1.4026).

### Objects tree: solution and PLC-project hierarchy

The Objects tree's grouping is a separate, extension-host-only presentation model. It must not alter
which language-server index owns a file:

1. `src/solutionMap.js` discovers TwinCAT `.sln` files and follows their actual metadata chain:
   `.sln` project entry → `.tsproj` → `<Plc><Project File="…xti">` → the XTI's `PrjFilePath` →
   `.plcproj`. A 3.1.4024 `.tspproj` names the `.plcproj` inline (`<Plc><Project PrjFilePath="…">`, no
   XTI) and is followed too. Unrelated Visual Studio solutions are ignored.
2. A solution is always a top-level node when present, even with one PLC project. One solution may
   contain several PLC projects, and several solutions may coexist in one workspace. Duplicate
   solution names use shortest-unique-parent suffixes; project labels are disambiguated only among
   siblings in the same solution.
3. A PLC project that no solution references remains a top-level fallback. With no TwinCAT solution,
   the pre-0.8.0 behavior remains: two or more projects get project roots; a single project keeps the
   flat directory-driven tree. This shape rule (`groupRootsByProject` included) lives in
   `src/objectsTreeModel.js`, not in the LSP ownership module `src/lsp/projectMap.js`.
4. `src/objectsTreeModel.js` creates every node with its logical parent:
   component → virtual folder/property → file → disk folders → PLC project → solution, so the
   adapter's `getParent` is a field read with no scans and no node construction. A reveal target
   (`revealTarget`) gets its whole ancestor chain when it is built: disk directories up to the tree's
   own project row (a Map lookup by directory uri) or a workspace root (a Set lookup). It parses only
   its backing XML file and consumes the cached host maps; it never starts another workspace scan.
5. `.sln`, `.tsproj`, and `.xti` create/change/delete events rebuild and refresh only the host tree
   model. A `.plcproj` event also rebuilds ownership and remains the sole project-structure event that
   triggers `custom/reindex` and the Libraries refresh.

Coverage is split deliberately: `test/test_solution_map.js` exercises discovery, multi-solution and
multi-project grouping, label scope and fallbacks without VS Code; `test/test_objects_tree_model.js`
and `test/test_tree_reveal.js` pin the model and the logical ancestry without VS Code;
`test/test_objects_tree_ids.js` pins every id the adapter renders on the first sample (copied alone
into a temp root) and on `sample/` itself (two solutions, two layouts); `node test/devhost/run.js` creates
three solutions and four PLC projects (two under one solution, one a 3.1.4024 `.tspproj` solution) and proves the real VS Code TreeView accepts that ancestry. Run the dev-host harness
whenever solution grouping, project grouping or reveal parents change.

### Project-scoped indexing

A TwinCAT workspace can hold **more than one `.plcproj`**, and each is its own compilation unit — XAE
does not resolve symbols across them. The LSP therefore keeps **one symbol index per project**, built
and routed at startup (and on `custom/reindex`), not one flat index for the whole workspace:

- **`src/lsp/projectMap.js`** is the single source of truth for the partition. It requires only
  `fs`/`path` and the dependency-free `src/twincatWorkspace.js` discovery owner — no `vscode` —
  so both the server and the extension host can require it.
  `createProjectMap(roots)` walks every root for `.plcproj` files and, for each, reads its `<Compile
  Include="...">` set into that project's `objectPaths`. Ownership is two different questions, answered
  by two functions: `ownersOf(file)` returns EVERY project that `<Compile>`s the file — a file linked
  into two projects ("add existing item as link", a real TwinCAT pattern) is owned by both and must be
  indexed into both, or it reads as undeclared in the one that did not win. `projectFor(file)` returns
  the ONE project a request for that file routes to — single-valued by necessity, since a completion or
  a diagnostics pass has to be answered against one index; a linked file routes to the project whose
  directory physically contains it, while still being indexed into every owner. A file under no project
  at all (a loose `.st`, a backup copy no `.plcproj` compiles) routes to the shared `(loose)` key.
  The parallel `objectFiles` values are the paths used to mint symbol URIs. On Windows their casing is
  recovered from actual directory entries (cached once per directory), because TwinCAT can retain a
  stale case-only folder spelling in an Include and VS Code treats that as a different resource. The
  walk preserves workspace 8.3 prefixes and junction paths; missing/unreadable includes and all POSIX
  paths retain the project spelling conservatively.
- **`src/lsp/workspaceScan.js`** builds one index per project (`scanWorkspace`) and wraps the
  request-routing API (`indexForUri`, `projectForUri`, `configFilesFor`). It lives outside `server.js` on
  purpose: `server.js` opens a Node IPC connection at require time, so nothing that requires it is
  loadable by a standalone test harness — `workspaceScan.js` takes the connection as injected
  `log`/`error` callbacks instead, so `test_multi_project_scope.js` can exercise the real scan with no
  server process at all. With no `.plcproj` under any root, it falls back to the pre-existing behaviour:
  one `(loose)` index holding every object file found on disk (fresh clone, or a loose folder of
  TwinCAT files).
- Every `custom/*` request the extension bridges to the server routes through `projectForUri`/
  `indexForUri` by the request's `fileUri`, so a completion, a diagnostics pass or a rename answers
  against that file's own project's index — never a union of every project in the workspace. The rename
  config-object scan is scoped the same way (`configFilesFor`): an unscoped walk would rewrite the
  OTHER project's `.TcVIS`/`.TcTLO`/`.TcTTO` files, since two projects can share object names and those
  formats name a PLC symbol by bare name — quietly breaking a neighbour's XAE build in a file the user
  never opened.
- **`src/projectStatusBar.js`** shows the owning project in the status bar (only when a workspace has
  2+ projects — a single-project workspace has nothing to disambiguate). `projectLabel()`, the part
  that decides the text, is pure and `vscode`-free so it is unit-testable under plain Node;
  `createProjectStatusBar()` requires `vscode` lazily, inside the function, specifically so
  `test_project_map.js` can call `projectLabel()` standalone without `vscode` ever being required.
  Duplicate `.plcproj` basenames use the shortest unique parent suffix (for example
  `TcToolkitSample_PLC — LineA`). The status bar needs that workspace-global label because it has no
  solution parent; the Objects tree uses `solutionMap.projectLabel()` and disambiguates only among
  sibling projects beneath the same visible solution.

Two registries hang off each project's index: `Symbol.for('twincat.libraryNamespaces')`
(`src/lsp/libraries.js`) and `Symbol.for('twincat.librarySymbols')` (`src/lsp/libsymbols.js`) — see
"Library symbols" below for what each holds. They are attached under a `Symbol` key rather than a
string property deliberately: `Object.keys()`, `for…in` and `JSON.stringify` all skip symbol-keyed
properties, and a symbol index is iterated by key in several hot paths (the reference scan, the
GVL-global lookup in `types.js`) — a string-keyed registry would show up as a phantom "symbol" in every
one of them. Each registry is created lazily, on that index's first write (`ensureRegistryFor` /
`ensureLibraryRegistry`); reading an index nothing has written to yet falls back to one shared *default*
registry rather than an empty one — the fallback that keeps roughly 15 pre-existing standalone harnesses
(which populate the default registry directly, with no index argument) working unchanged.

`test/test_project_map.js` covers `projectMap.js`'s ownership rules, actual Windows casing without
expanding workspace 8.3/junction identity, the missing-file fallback, `projectLabel()` and
`groupRootsByProject()` (the Objects-tree per-project grouping, owned by `src/objectsTreeModel.js`) in
isolation.
`test/test_multi_project_scope.js` covers the whole thing end-to-end against a real two-project fixture
built from `sample/` (the fixture helper is `test/_multiproject.js`, two copies of `sample/` under one
root, one copy deliberately diverged) — the partition, zero diagnostics on correct code in either
project, references and the rename config scan never crossing the project boundary, and the per-project
library registries including the Libraries-view union fallback when no project is specified.

### Indexing cost, and the four rules that keep it down

Measured on a real 8-project folder (156 MB of library archives): a startup used to cost ~11.7 s warm
and ~42 s cold, with every language feature dead and nothing on screen saying why. It is now ~3.5 s
warm / ~20 s cold projected, and the wait is visible. Four invariants hold that, and each has a gate:

1. **A startup scans once.** `custom/reindex` means *rebuild unconditionally*; `custom/indexReady`
   means *resolve once these roots are indexed*. The host's startup request is only ever the barrier
   (it orders `sendDiagnosticsConfig()` and the Libraries refresh after the index) — sending it as a
   reindex made every startup pay for the whole scan a second time on top of `onInitialize`'s.
   `src/lsp/scanController.js` decides, on exactly two facts: a scan **completed**, and its normalized
   root set matches. **Never teach `reindex` to skip** — on a `.plcproj` change the roots are
   unchanged and it is the content that moved (`test_scan_controller.js` pins both directions).
2. **Read each file once per (path, size, mtime).** `parseCache.js` (signature dumps, browsercache),
   `plcprojRefs.js` (`.plcproj`), `harvestArchiveFile` (archives). A parse that is *stored* per
   project must be a private copy — the signature merge rewrites `record.namespace` and
   `indexBrowserCache` pushes members onto the stored object, so a shared record leaks one project's
   attribution into another. Since Phase 2 this is **structural, not caller discipline**:
   `signatureRecordsFor` (the only way to get signature records) returns a fresh copy on every call
   and the cached template is unreachable. `test_signature_cache.js` asserts isolation by object
   identity *and* by mutation, because a value comparison still passes while sharing.
3. **Decode each archive once per content, not per path.** Every project vendors its own `_Libraries`,
   so the same vendor archives appear many times: 306 files / 156.5 MB on the measured workspace, but
   148 distinct / 74.2 MB. `harvestArchiveFile` keys decoded names on
   `<title>/<version>/<file>` + size + mtime, which took 306 decodes to 157. If that identity ever
   proves too weak, the documented hardening is a ZIP central-directory fingerprint over the ≤66 KB
   EOCD tail (`MAX_EOCD_SEARCH`) — a genuine content hash for one small read.
4. **`SKIP_DIRS` must never gain `_libraries`.** `collectArchives` walks it; excluding it there finds
   zero archives and costs ~171 false positives. `PROJECT_SKIP_DIRS` is the excluding set, for the
   `.tmc`/signature/`.plcproj` walkers only. `test_collect_scope.js` proves both halves.

The scan is still **synchronous**, so the server's event loop stops for its duration and requests
queue unread. That is why the progress indicator lives in the **extension host** — a separate process
whose loop stays free — and why it is deliberately indeterminate ("TwinCAT: indexing…", no `3 of 8`):
per-project counts would need the scan to yield between projects, which it does not do. Making it
yield (with per-project readiness, so the active file's project answers first) is the known next step
and is deliberately not done: it rewrites the multi-project spine, and a wrong readiness gate answers
against a partial index, which means false diagnostics.

Three processes cooperate, with the extension host as the hub — **the webview never talks to the
language server directly**. The extension bridges them over custom JSON-RPC requests
(`custom/completions`, `custom/definition`, `custom/references`, `custom/referencesForSymbol`,
`custom/configReferencesForSymbol`, `custom/diagnostics`, …) layered on the standard LSP transport
(Node IPC).

**Generate ST** is project-aware and lives entirely in the extension host (`customEditorProvider.js`):
the webview asks `requestProjects` on load and shows a checkbox split-button menu only when the host's
`projectList` reply has 2+ projects; clicking the button posts `generate-st` (all projects), the menu
posts `generate-st` with a `projectKeys` subset. `generateAllStFiles` walks each selected project's
`<Compile>` list from the `.plcproj` partition and writes `<project dir>/ST_Files/<path in the project>.st`,
so no two projects collide and nothing lands in the workspace's top-level folder (the path math is the pure,
tested `src/stOutputPath.js`). A workspace with no `.plcproj` falls back to the old flat mirror in
`<workspace root>/ST_Files`. Every scanner (the LSP's indexers, the project and solution walkers) skips a
directory named `ST_Files` at any depth, so generated `.st` files are never indexed as sources. The Objects
tree DOES list the output: an `ST_Files` folder directly in a PLC project's directory (or in a workspace
root, for the flat mirror) and every folder below it get contextValue `generatedDirectory`, and its `.st`
files `generatedStFile` (other files in there are not listed). No menu, paste or drag-and-drop rule names
those two values, so no TwinCAT create/delete/rename/insert command applies; a click opens the `.st` as
text (`twincat.openComponent`). An `ST_Files` folder anywhere else is an ordinary folder. The workspace file
watcher still ignores every individual path under an `ST_Files` folder for re-indexing and refreshes
(`isWatchEventRelevant` in `src/twincatWorkspace.js`) — a run writes hundreds of files, and each one used to
refresh the whole Objects tree. Instead the tree refreshes ONCE when a run ends (`onStFilesWritten`, called
by `generateAllStFiles` and the flat mirror), and hand-made creates/deletes there
(`isGeneratedOutputEvent`) collapse into one trailing refresh 500 ms after the last event
(`ST_FILES_REFRESH_DEBOUNCE_MS` in `extension.js`); during a run that adds at most one refresh after the
end-of-run one. The project-aware export reads and writes with Node `fs.promises`,
not `vscode.workspace.fs`: a burst of writes through the editor's file service was rejected with "Canceled" on a
real multi-project workspace. A failed run names its first error in the notification.

### The live language-feature path

A pane cannot be analysed on its own: methods, properties and actions need the whole POU in scope. So
for each request the extension assembles the **entire** document into one Structured Text compilation
unit (applying the webview's unsaved edits as an overlay first), maps the pane-local cursor into that
unit, queries the LSP, and maps the results back to the right component and pane via a line map.

Changing `stConverter.js` output or `xmlParser.js` component extraction can silently break that
mapping; `test/test_live_path.js` guards it.

**References peek across components and files.** Monaco throws "Model not found" for a Location whose
URI has no loaded model, so the peek could only ever show hits in the two live panes. `custom/references`
therefore resolves *every* hit to a (file, component, pane, local line) and ships that pane's TEXT
alongside; the webview builds a **hidden model** per pane (scheme `twincat-peek:`, the file/component/pane
in its query) and points the Location at it. The live panes are still preferred where they apply — they
hold unsaved edits. Bounded by `PEEK_MAX_PANES` / `PEEK_MAX_TEXT_BYTES` in `src/livePath.js`,
since the peek is a preview and the References panel lists every hit uncapped. Clicking an entry routes
through `twincat.openComponent` with the exact pane + line + columns. The pane-slice coordinates are the
subtle part — a slice is a different frame from the assembled unit — and `test_live_path.js` guards that
arithmetic against every block of a real sample object.

`assembleSt`, the coordinate mapping (`localToAbsolute`/`absoluteToLocal`/`paneTextFromUnit`), the peek
path builder (`peekPath`), the injected-read unit resolver (`createStResolver`), and the three pure
collectors that assemble a raw LSP answer into what the webview/panel post (`mapDefinition`,
`collectPeekReferences`, `listExternalReferences`) all live alongside those constants in
`src/livePath.js` — vscode-free, so they are unit-testable and the production code IS the code the
harnesses exercise (no replica logic to drift out of sync); `test/test_live_path_unit.js` pins the
budget semantics directly. `customEditorProvider.js` supplies `livePath`'s `readFile` as a thin
wrapper over `vscode.workspace.fs.readFile`, and each `custom/*` handler is now a thin
assemble → query LSP → delegate → post.

### Pragmas

`{attribute 'qualified_only'}`, `{region "Inputs"}`, `{IF defined(X)}` — metadata, not code. Handled in
**two tiers, and the order matters**:

1. **Shape decides everything user-visible.** The leading keyword picks one of the five categories
   Beckhoff documents, and that is what drives highlighting. `classifyPragma()` never fails: an unknown
   head is `Unknown`, which is a legitimate answer.
2. **The catalog only enriches** — completion, canonical spelling, a documentation link. It must never
   decide a colour or raise a diagnostic. TwinCAT documents *user-defined attributes* as a feature, so
   tinting an uncatalogued name differently would be wrong on correct code.

The catalog is two files because **Infosys is authoritative but not exhaustive**. Measured on this
machine: `TcGenerated` appears in 150 of 337 installed library archives and `object_name` in 40 places
in real project code, and neither has an Infosys page. So `pragmaCatalog.json` (68 attributes, 14
directives) is generated from the docs, and `pragmaCatalogExtra.json` (10) is hand-curated from
measurement — each entry carrying the counts it was measured at. Anything in neither still works.

```bash
node --use-system-ca scripts/fetch-pragma-catalog.js           # re-scrape, diff, write
node --use-system-ca scripts/fetch-pragma-catalog.js --check   # exit 1 if the committed file is stale
```

Run **by hand only** — the extension must work with no network, so the catalog ships as committed data
and a failed fetch can only fail the script. `--use-system-ca` is needed behind a TLS-inspecting proxy.
The script scrapes the one open-ended list (attribute pragmas publish one child page per name) and
*verifies* the four closed grammars against their own pages, so a documentation rewrite fails loudly
instead of producing a catalog that quietly disagrees.

### Folding

`media/stFolding.js` computes folding ranges from ST's **block structure**. It is registered twice
from one copy — `media/editor.js` for the panes, `extension.js` for plain `.st` files — which is why it
is a dual-mode module (`<script>` tag in the webview, `require()` everywhere else; there is no build
step to unify them). `test/test_folding.js` exercises it directly.

stFolding established the dual-mode pattern; since Phase 8 there are **four** such modules — the
other three (`media/pendingEdits.js`, `media/peekUri.js`, `media/diagnosticMarkers.js`, see the file
map) carry the webview's pure decisions so plain-Node harnesses can reach them, and `pendingEdits.js`
is additionally required by the extension host, stating the cross-process pending-edit contract on
both sides.

It replaced Monaco's indentation folding, which is the wrong model for ST — its blocks are
keyword-delimited — and produced two user-reported bugs:

1. **An unmatched `{endregion}` truncated the enclosing `VAR` fold.** Monaco's `computeRanges` scans
   bottom-up and pushes an `{indent: -2}` sentinel for an end marker it has not matched yet. Only a
   *matching start marker* pops it — the indentation unwind is `while (top.indent > lineIndent)` and
   `-2` is below every real indent — so a lone `{endregion}` was a permanent barrier.
2. **`{attribute 'TcLinkTo' := ''}` at column 0 under an indented `VAR` body grew its own fold arrow.**
   Never about pragmas: an unindented line followed by indented ones simply *is* an indent region.

**Registering a provider replaces the indentation provider outright**, so `stFolding.js` must cover the
keyword blocks (`VAR`…`END_VAR` and family, `IF`, `CASE`, `FOR`, `WHILE`, `REPEAT`, `STRUCT`, `UNION`,
`TYPE`) as well as regions — drop them and `IF … END_IF` silently stops folding. That is asserted in a
browser, not just in Node, because "silently" is the operative word.

Keywords count only where they are **code**: comments, strings and pragma bodies are blanked first.
That is not tidiness — `{IF defined(Variant1)}` is a *conditional pragma*, not an `IF` block, and
counting it leaves an unclosed `IF` on the stack that eats every fold below it. Regions and keyword
blocks use **separate stacks**, so one malformed construct cannot destroy the other's ranges.

The `folding.markers` in `media/editor.js` and `language-configuration.json` are **inert** while the
providers are registered. They are kept as the declarative statement of what a region is, and as a
fallback if a provider is ever removed; neither file can `require()` the regex sources in `pragmas.js`,
so `test_pragmas.js` asserts all three agree.

The one invariant nothing may relax: **a pragma span is consumed whole, stopping at `}` or end of
line.** ST strings are single-quoted, so the apostrophe in `{region "Motion FB's"}` would otherwise
open a string running to the next quote anywhere in the file — which is how IntelliSense once switched
off for a whole VAR block — and an unterminated `{` would swallow the rest of the document. That holds
in three places: the lexer (`parser.js`), the Monarch tokenizer, and the TextMate grammar.

### Compile Project (roadmap R3.2, bundled in R3.3)

`twincat.compileProject` checks one PLC project with an external IEC 61131-3 compiler. The user-facing
surfaces (UI, README) never name the compiler product — a user ruling, pinned by
`test_start_contributions.js`. The pipeline:

1. **Texts** — every object the `.plcproj` `<Compile>`s, read from the open TextDocument when there is one
   (unsaved edits count) with Manual Sync's pending edits folded in, else from disk.
2. **Units** — `buildCheckInputs` → `checkUnit.buildCheckUnit` per object, written as `N.st` in a
   `mkdtemp` directory (deleted however the run ends); a GVL gets `--global-list N.st=<name>`.
3. **Run** — `<node> <compilerPath> --check --json --dialect-file resources/dialects/twincat3.json …` as
   a child process, Node >= 22 probed first, 2-minute timeout, cancellable. **No `--strict`** (decided:
   it refuses TwinCAT-legal DINT→INT narrowing and WORD arithmetic). Exit 1 without errors, or a report
   that is not JSON, is a failed run; a failed/timed-out/cancelled run keeps the previous results.
4. **Map** — each diagnostic's unit line → `origins[line]` → file/component/pane/line (the column is
   the pane's, because pane text is verbatim). Warnings matching `/^Pragma ignored:/` are filtered and
   counted; nothing else is.
5. **Show** — Problems (`twincat-compile` collection, keyed by `normalizeFileUri`, at `paneRange`: the
   PANE's line and column, so the panel's Ln/Col match the pane the user reads — decided 2026-11-10, a
   range inside the XML read as e.g. Ln 23 for implementation line 2; the message names the component
   and pane), and the panes: the provider posts **`compileDiagnostics`
   `{diagnostics: [{componentId, pane, severity, message, range}]}`** to every open webview of that file
   (and includes them in `init`). `media/editor.js` keeps them under marker owner **`twincat-compile`**,
   separate from the language server's `st-validator`, and re-applies them at the top of
   `updateDiagnostics` (the panes share two models across components — keep that call there). An edit
   to a component drops its compile markers and posts **`compileDiagnosticsStale {componentId}`**, so
   the host drops the matching Problems entries.

The start page's *Compile project* tile is enabled when the compiler file exists — the bundled one, or
the override `twincat.compiler.path` names — and a project is open (`state.compilerReady` +
`hasProject`); only a missing override (or a damaged install) disables it, with "Compiler file not
found". A missing Node is not known to the tile: the command explains it on click. A change to
`twincat.compiler.*` re-posts the page's state. Results live in memory only (problem-link ids included) — a compile result describes
one moment.

**The bundled compiler (R3.3).** The compiler ships in `resources/compiler/`, so an empty
`twincat.compiler.path` means `bundledCompilerPath()` (`resolveCompilerPath`); a set path is an
override. It is GPL-3.0 and is only ever run as a child process. The bundle loads every `.stlib` in the
`libs/` next to itself (`findBundledLibsDir` in the fork tries `../../libs` and `../libs` first — neither
exists in the extension); only the two IEC libraries ship, because the fork's others (OSCAT, softmotion,
extra FBs such as `PID`) are not TwinCAT's and would make names resolve that TwinCAT refuses.
`compile-real` pins both directions.

**Node discovery** (`nodeCandidates` → `findNode`, everything injected: `platform`, `env`, `runtime`,
`spawn`, `exists`). A set `twincat.compiler.nodePath` is the ONLY candidate (a configured path that fails
is reported, never silently replaced). Otherwise, in order: `node` on PATH; on Windows
`%ProgramFiles%`/`%ProgramW6432%`/`%ProgramFiles(x86)%\nodejs\node.exe`, `%NVM_SYMLINK%\node.exe`,
`%VOLTA_HOME%\bin`, `%LOCALAPPDATA%\Volta\bin`, `%ProgramFiles%\Volta`, `%FNM_DIR%\aliases\default`,
`%APPDATA%\fnm\aliases\default` (each only if the file exists); last, the editor's own runtime
(`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), only when `process.versions.node` is 22+. Each is
probed with `--version`; the first at 22+ wins, and its `env` travels with it to the check run
(`nodeEnv`). When none qualifies, one message lists what was tried and how to fix it.

**Updating the compiler.** In a scratch clone of the fork (never the checkout another session works in):

```bash
git clone https://github.com/AbuShaqra/STruCpp /tmp/fork && cd /tmp/fork
git checkout <commit on origin/development>     # must be pushed: SOURCE.md links it
npm ci && npm run build:bundle                  # Node 22+
cd <toolkit> && node scripts/vendor-compiler.js /tmp/fork
```

The script refuses a dirty checkout or a bundle older than HEAD, replaces `resources/compiler/` whole,
and warns when the commit is on no remote branch. Then update the version/commit in
`THIRD-PARTY-NOTICES.md` (`test_vendored_compiler.js` fails until it names the new commit), run
`compile-real` and the suite, and package a VSIX to check `resources/compiler/` is in it.

### Writes

On save, only the edited `<![CDATA[ ... ]]>` blocks are rewritten. The surrounding XML is preserved
byte-for-byte, so TwinCAT and version control never see spurious diffs.

### Library symbols

`src/lsp/libsymbols.js` indexes ~32k symbols in about 200 ms and registers them into the workspace
index **on demand, per document** — registering them all up front took the diagnostics pass from 1.5 s
to 78 s, because `Object.keys()` on the index runs per identifier. Several sources feed it, all
load-bearing (dropping any one resurrects false positives, or empties part of the Libraries view):
the ZIP **archives** and the project **`.tmc`** (`libsymbols.js`), the **`.plcproj`** namespaces
(`libraries.js`), the optional **`library-signatures.xml`** (`librarySignatures.js`), and TwinCAT's
per-library **browsercache** (`browserCache.js`, for library FB/interface method + property *names*).
See [docs/handoff-findings.md](docs/handoff-findings.md) ("External symbols") for what each source uniquely provides and the traps.

Each project's index carries its own copy of what `libraries.js`/`libsymbols.js` register — the
`Symbol`-keyed registries described under "Project-scoped indexing" above — so two projects that
reference different libraries never see each other's namespaces or symbol names.

Note the **Beckhoff** archives under `_Libraries/` are git-ignored, so a fresh clone has only the
committed MIT archive. That changes how many external symbols resolve, not the diagnostic count: the
synthetic sample names no Beckhoff symbol, so every baseline row measures 0. `test/_baseline.js` records
how each row was measured.
