# Development

Building, testing and hacking on TC Toolkit. For what the extension *does*, see
[README.md](README.md); for the current state of the work, see [HANDOFF.md](HANDOFF.md).

**Naming.** The user-facing name is **TC Toolkit**: the display name, the Activity Bar container, the
command category (`TC Toolkit: Compile Project`), the settings sections, the custom editor, status-bar texts,
notifications, quick-pick titles, output channels (`TC Toolkit Language Server`, `TC Toolkit Library
Definitions`) and diagnostic sources (`TC Toolkit compile`, `TC Toolkit ST Validator`). The views are
**PLC Objects**, **PLC Libraries** and **PLC References**, and the start page's tab is `TC Toolkit Start`.
"TwinCAT" is Beckhoff's registered trademark, so it is used only **descriptively** ("for Beckhoff TwinCAT 3
PLC projects", "a TwinCAT solution", "requires TwinCAT XAE") and never as the name of the product or of
anything in its UI; `test/test_start_contributions.js` fails if a contributed name contains it. **Internal
identifiers keep the `twincat.*` prefix** (extension id `twincat-plc-toolkit`, command ids,
view and container ids, context keys, the `twincat.xmlViewer` viewType, the `twincat-compile`
DiagnosticCollection name): renaming those would break users' keybindings and editor associations,
and nobody reads them as a name.

**Setting keys are the exception: they are `tcToolkit.*`** (user report 2026-11-11). VS Code's Settings
editor builds each setting's label from its key, so `twincat.compiler.path` showed as "Twincat › Compiler:
Path". `contributes.configuration` is an array of one section per group (`tcToolkit.diagnostics`,
`.compiler`, `.xaeShell`, `.libraryDefinitions`, `.startPage`), each with a short title and its key prefix
as `id`: the Settings editor trims a setting's category when it starts with its section's id, so browsing
the table of contents (**TC Toolkit › Compiler**, under the display name) a setting reads just "Path".
Search results — which includes the `@ext:` filter and Open Settings' section query — have no section, so
they show the full category built from the key: "Tc Toolkit › Compiler: Path" (VS Code capitalises each
camelCase word; the uppercase "TC" is not reachable through a key).
`src/settingsMigration.js` moves values from the old keys once, at activation (below, file map). The ten
old `twincat.*` keys stay contributed **deprecated** (`deprecationMessage` → the new key), which the
Settings editor hides unless one is set: measured on VS Code 1.145, `inspect` reads an uncontributed key
and removing one works, but writing one is refused, and the older releases `^1.66` admits are not known
to allow even the removal. `test/test_start_contributions.js` guards it: no live key starts with
`twincat.`, all ten exist under `tcToolkit.`, and each deprecated key matches its successor.

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

**What the VSIX must carry for Compile Project.** `resources/compiler/` ships whole (the bundle, its two
libraries, the C++ runtime headers in `include/` that the optional g++ build compiles against (R13), the
GPL-3.0 licence files, `third-party/`, `SOURCE.md`). **The only dialect profile shipped is
`resources/dialects/twincat3.json`** (user rule, 2026-11-10): no CODESYS or other profile, and none copied
from the fork — `test_vendored_compiler.js` pins `resources/dialects/` to exactly that file. (The bundle's
built-in CODESYS *library importer* is compiler code, not a profile, and stays.) After packaging, check:

```bash
unzip -l twincat-plc-toolkit-<version>.vsix | grep -E 'resources/(compiler|dialects)/'
# expect resources/compiler/{compiler.cjs,libs/*.stlib,include/*.hpp,LICENSE,COPYING,COPYING.RUNTIME,SOURCE.md,third-party/*}
# and exactly one profile: resources/dialects/twincat3.json
```

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
npm run lint                  # ESLint 10, flat config — a DEFECT check, not a style check; the
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
`compile-real` (`test/test_compile_real.js`, Compile Project against the REAL compiler —
the bundled `resources/compiler/compiler.cjs`), and `cpp-real` / `gpp-real` (`test/test_cpp_real.js`,
R13: C++ generated for both sample projects in a temp copy, then compiled with g++ against the vendored
headers). `compile-real` and `cpp-real` need a Node >= 22, found the way the command finds
one; without it (CI's Node 16/20 legs) they skip. `gpp-real` also needs a g++ (`TC_TEST_GPP`, else the
command's own detection) and skips without one. One harness reports both of its gates
(`test/_coverage.js` `reportCoverages`; `test/run.js` accepts an array). They run in every `npm test` on
Node 22+ (CI's lint/test leg uses Node 24). To try another compiler build instead of the bundled one:

```bash
TWINCAT_COMPILER_BUNDLE=/path/to/strucpp-bundle.cjs node test/test_compile_real.js
# optional: TWINCAT_COMPILER_NODE=/path/to/node (>= 22)
```

Never make `compile-real`, `cpp-real` or `gpp-real` required in `test/run.js` — a Node < 22 machine,
or one without g++, must still run a FULL suite.

`REQUIRE_FULL_SUITE=1` turns a reduced or filtered run into a hard failure after the harness reports
are collected. Use it before packaging a release, so a silently skipped gate can never be mistaken
for a clean one.

`npm test` runs `node test/run.js`, which runs each harness in `test/` in its own process and reports
per-suite without aborting on the first failure. The main ones:

| Harness | What it checks |
|---------|----------------|
| `test/test_lsp_features.js` | Core LSP: completions, go-to-definition (incl. call parameters), references, diagnostics, on synthetic `.st` units. |
| `test/test_sample_diagnostics.js` | **Diagnostics ratchet** on every PLC project under `sample/` (two solutions), each in its own index as the server partitions a workspace. The samples are valid code, so every diagnostic on them is a false positive; the harness measures them the way the LSP server does — in order, and again with each object opened fresh (scan-time index + that unit) — prints a per-category breakdown, and **fails if the total rises above the baseline** in `test/_baseline.js`. The target — currently met — is zero. |
| `test/test_live_path.js` | The live editor pipeline: full-file ST assembly, cursor mapping, per-pane diagnostics, member completion through references, method return types, token-aware and cross-file references; R12 conditional pragmas per pane (a split IF head silent in its method pane, an unrelated unterminated FOR on its own pane and line, an unsaved overlay adding `{IF}`). |
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
| `test/test_library_catalog.js` | The data path behind the PLC Libraries view: catalog built from the `.plcproj`, namespaces, `.tmc` types and their members. |
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
| `test/test_rename_transaction.js` | `src/renameTransaction.js`, the rollback transaction behind cross-file rename: stage-then-apply with first-staged-order writes, composed re-staging (original text kept from the first read), the pre-write re-read (`changed-on-disk` — a file that changed since staging is never written), reverse-order rollback on first failure, the rollback's own never-clobber verify (`changed-after-write`), per-file rollback-failure reporting, `revert()` after a successful apply, and single-shot apply. Fault-injected over a fake io; the three guards are each verified to FAIL when removed. `applyAsOne` (the rename's single WorkspaceEdit): one commit receives every change, a stale file fails before the commit runs, a commit that throws after landing part of the edit gets exactly the landed files restored, and a file holding neither text is reported, never overwritten. |
| `test/test_rename_family.js` | R7: `memberRenameFamily` (features/references.js) — renaming a Method/Property reaches every implementor of a shared interface method, a second interface one of them also implements (and ITS implementors), an interface's second `EXTENDS` parent, a derived FB that inherits or overrides it, and the call sites through any of them (`itf.Start()` included); NOT a POU that only shares the name, an unrelated interface's same-named method, or another method of the same interface. Applied through `renameEngine` as the command does (structural Method renames, other files byte-identical), and the visualization side follows the same family. Verified to fail 32 ways without the family. |
| `test/test_plcproj_text.js` | `src/plcProjText.js`: the `.plcproj` rewrite a rename makes changes only the Include value (entry kept in place with its children, CRLF kept), case-insensitive, prefix-safe (`FB_A` vs `FB_AB`, `Sub` vs `SubX`), directory renames rewrite their nested Folder/Compile entries, library references are never touched, XML entities round-trip, and on both committed sample `.plcproj` files a rename inserts exactly the new characters and renaming back is byte-identical. |
| `test/test_rename_commands.js` | `src/commands/renameCommands.js` end to end under a stubbed `vscode` with the real by-symbol query: a file, member or directory rename is ONE WorkspaceEdit (text edits, then the move LAST; the `.plcproj` edit inside it), the sibling implementor follows and the name-alike does not, a sibling that already has the new name stops the rename before any write, a failed move restores every landed buffer, and *Undo Last Rename* runs `undo` from a text editor and restores every file byte for byte — refusing once a participating file changed. The stub's `undo` follows the rule measured in a real VS Code (only from a text editor of a file in the group). |
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
| `test/test_pragma_hover.js` | Pragma hover (`src/lsp/features/hover.js`): every directive (`{text}`/`{info}`/`{warning}`/`{error}`, the six conditional heads, `{region}`/`{endregion}`, `{warning disable/restore}`) is titled, described and linked; documented attributes show syntax (the `:=` form when valued) and their own Infosys page; observed ones say so without the maintainers' measurement notes; an unknown attribute gets a NEUTRAL hover; an unknown head, code, comments (nested included), strings and line comments get none. The webview's path: `assembleSt` → `localToAbsolute` → `provideHover` → `mapHoverToLocal` lands on the right pane line and columns in a method's decl and impl panes, and a hover on another line is dropped. `isDocumentationUrl` (what the host will open) and a provenance guard: the generated catalogue holds names, syntax and page ids only, so a copied description cannot slip in. |
| `test/test_pragmas.js` | Pragma classification and the two catalogs, plus the highlighting rules in **both** grammars and the `{region}` folding markers. Pins the split the design rests on: shape decides the category (and therefore the colour), the catalog only enriches — so a user-defined attribute must be scoped exactly like a documented one. Also asserts catalog integrity (no duplicates, every documented entry has an Infosys node id, the curated file holds nothing Infosys documents, every curated entry carries measured counts), that pragma spans are consumed whole in the lexer and both grammars, and that the three folding-marker declarations — `pragmas.js`, `language-configuration.json`, `media/editor.js` — still agree, which nothing else can check because none of them can import the others. |
| `test/test_plcproj_scope.js` | The index is scoped to the `.plcproj`, not the filesystem: a project's `objectPaths` (from `createProjectMap`) names only the `<Compile>`d objects, so a backup/orphan copy on disk (a duplicate object name, absent from the project) can never win the name-keyed index and steal a real object's references. Includes the no-`.plcproj` empty-map case and a sample-coverage check proving the scoping is a no-op on the ratchet. Predates the project-scoped index (below) — the guarantee it pins now runs through `createProjectMap` per project instead of one workspace-wide union. |
| `test/test_uri_fs_path.js` | `uriToFsPath()` must return a path the **running** platform can open. The former copies in `workspaceScan.js` and `features/core.js` once ended in an unconditional `.replace(/\//g,'\\')`, which is correct on Windows and on POSIX ate the root — `file:///home/u/a` became `\home\u\a` — so 11 of 59 suites failed on Linux while CI (`windows-latest`) stayed green. Both callers now delegate to the shared production helper in `src/fileUri.js`. Written to hold on **both** platforms so whichever one CI runs still guards the branch it takes: a round trip through the real filesystem (the load-bearing one — a merely plausible converter cannot satisfy it), paths containing a space in both encoded and unencoded form, separator/root shape per platform, bare-path and empty-input passthrough, caller delegation, and unchanged Windows mapping. |
| `test/test_project_map.js` | `src/lsp/projectMap.js`: which `.plcproj` owns which file. Discovery, `objectPaths` per project, `ownersOf()` vs `projectFor()` (a linked file has two owners but a request for it routes to one), the orphan/no-project/case-insensitivity edges, `projectLabel()` (the status-bar text, from `src/projectStatusBar.js`) and `groupRootsByProject()` (the Objects-tree grouping, now in `src/objectsTreeModel.js`, fed this module's map) at both the &lt;2-projects (nothing shown, flat tree) and 2-projects ends. Also pins `TWINCAT_EXTS` staying in sync between `projectMap.js` and `xmlIndexer.js`'s own copies — a real review-caught bug: `projectMap.js`'s copy once missed `.tctleo`, silently dropping every enumeration-text-list object's symbols from a project-scoped scan. |
| `test/test_solution_map.js` | `src/solutionMap.js`: the real `.sln` → `.tsproj` → `_Config/PLC/*.xti` → `.plcproj` chain, multiple PLC projects under one solution, multiple same-named solutions, project labels scoped within their solution, unrelated Visual Studio solutions ignored, and unreferenced PLC projects retained as top-level fallbacks. |
| `test/test_project_template.js` | `src/projectTemplate.js` on both shipped templates: the committed templates match `scripts/build-project-templates.js --check`; every GUID classified; every identity GUID re-issued with every reference following it and each occurrence's case kept (`.sln` upper, `.plcproj` lower); every type GUID kept; no template name left in a path or a byte; BOM, CRLF/LF, tabs and trailing newline preserved and nothing but names and GUIDs changed; starter objects exactly MAIN, PlcTask (calling MAIN) and an empty GVL_Main; the `.tspproj` (4024) and `.tsproj` + `_Config/` (4026) shapes; the created project read back by `projectMap` and `solutionMap`; refusal of a target holding a solution or a file it would write (nothing touched); name validation. |
| `test/test_template_diagnostics.js` | A project created from each template, indexed like `test_sample_diagnostics.js` with every check on: ZERO diagnostics, again after the first edit a user makes (a variable in the `qualified_only` `GVL_Main` used from MAIN as `GVL_Main.x`), and a deliberate undeclared name IS reported (the gate is live). |
| `test/test_start_contributions.js` | package.json for R2: the branding guard (no contributed name — display name, settings section titles, custom editor, view containers, views, command categories — contains "TwinCAT"; the extension id is unchanged); the setting keys (all 18 live keys under `tcToolkit.`, none under `twincat.`, each old key contributed deprecated with its successor's type/scope/default, sections one per key group, the migration table in step); the `twincat` Activity Bar container (titled `TC Toolkit`) holding Start, PLC Objects, PLC Libraries in that order with ids unchanged, none left in the Explorer, References still in its panel, no dangling view id in a when-clause; each start command contributed under the `TC Toolkit` category, in the palette, registered, with an `onCommand` activation event (needed on 1.66); Start view welcome links; a monochrome offline icon; the start page's strict CSP and no remote load; `.vscodeignore` shipping the derived templates but not the raw XAE source; the `tcToolkit.startPage.recentProjectsShown` and machine-scoped `tcToolkit.xaeShell.path*` settings, and the page's command / settings-section allow-lists. R14: the three XAE command titles ("… (requires TwinCAT)", no TwinCAT-led name), each in the palette on Windows only (`when: isWindows`) with an `onCommand` activation event, the two build commands' `enablement: !twincat.xaeRunning`, the internal `twincat.xaeBuild.goToProblem` registered but not contributed, the start page allow-list holding `twincat.xaeBuild`/`xaeBuildAndActivate` (not `xaeShowTargets`), the settings section `XAE Build` with its five keys and their defaults equal to `xaeBuildSettings`, and no target-NetId setting. `tcToolkit.xaeBuild.platform` is a dropdown equal to `XAE_PLATFORMS` and offers every platform both samples' `.sln` declare; `configuration` stays free text. |
| `test/test_start_commands.js` | `src/commands/startCommands.js` + `src/startPage.js` under a recording `vscode` stub: create with args and with prompts (files, recents, last location, open here/new/add/none), refusals inline vs as a notification, a deleted recent solution pruned, Generate ST's project pick, help links and settings, the singleton panel, its `state` message (including the recent-list length, clamped, and the XAE Shell paths; the g++ path in each state, read-only), a settings change (incl. `tcToolkit.compiler.gppPath`) re-posting state to an open page, g++ *Change…* opening the User settings, `openSettings {section}` and Open Settings' query argument, and the command allow-list. |
| `test/test_check_unit.js` | `src/checkUnit.js`: one origin per emitted line, every pane line exactly once and verbatim in pane order (so a reported line/column IS the pane's), generated lines anchored on their component, members before the body, no rewriting (`REFERENCE TO`, `REF=`, pragmas survive), every sample file round-trips. |
| `test/test_compile_check.js` | `src/compileCheck.js` with a fake child process: the bundled compiler as default and the setting as override, Node discovery (order on Windows, the version gate, the editor runtime as last resort with `ELECTRON_RUN_AS_NODE=1`, a configured Node path as the only candidate), setup messages (compiler missing, Node missing/too old, each naming its setting), the command line, the JSON report (clean, errors, malformed, exit 2, crash), mapping to file/component/pane/line, the pragma-warning filter and its count, temp-dir lifetime, timeout, cancellation, `paneRange`, runChild's `onStdout`/`onStderr` chunk callbacks. |
| `test/test_compiler_defines.js` | `src/compilerDefines.js`: define lists (names, `NAME := 'value'`, spacing, a comma inside quotes, case kept, duplicates, empty and malformed entries with notes, an unclosed quote), `.plcproj` reading (`<CompilerDefines />`, whitespace-only, per-object defines read per item (conditions on the item group, the item and the element, `%(CompilerDefines)`, malformed entries noted), MSBuild last-wins and `$(CompilerDefines)`, XML entities, comments), `Condition`s on groups and elements (`evaluateCondition` case by case over the spellings real `.plcproj` files use; Debug applied, Release and platform mismatches skipped without a note, undecidable ones left out with a note and what they set made unreadable for later conditions, self-closing groups, empty conditions, `Condition=` inside another attribute, MSBuild-set properties, `$(Prop)` in a define value, other properties from earlier groups, the project's own `<Configuration>` default not overriding the check configuration), the `--pragma-define` arguments (numeric values exact), `fileDefineArgs` mapping each item's `Include` to its unit (case-insensitive, a `..\` link, an object with no unit noted), an unreadable file. |
| `test/test_compile_commands.js` | `src/commands/compileCommands.js` + the provider hooks under a recording `vscode` stub: the bundled compiler run when nothing is configured, the toolbar button's host side (`compile-project` from a real `resolveCustomTextEditor` runs the command with the owning project's key, or asks when no single project owns the file; `compileRunning` posted at start and end and carried in `init`; the command's own setup messages), project pick, setup refusal (a missing override), clean run, a run with errors (Problems entries, pane markers, status text, summary), unsaved edits reaching the compiler, Go to Problem and the entry links, an edit dropping its component's results, a failed run keeping the previous results, cancellation, a fresh open landing on the first problem, and the project's compiler defines reaching the compiler as `--pragma-define` (numeric value exact) and an object's own as `--file-define` on its unit (malformed entries and an object with no unit left out, notes in the `TC Toolkit Compile` output channel and the summary, an empty element and an unreadable `.plcproj` passing none, a Debug-conditioned group applied and a Release one skipped with no note). R13: off by default, the dropdown and scope coupling, generation after a clean check only, a project that uses library symbols still generated (only a stripped prefix on a compiler-provided block, `SynLib.TON`, with a clean check: the summary and the channel name the library and the compiler's TON; dump-declared blocks: the compile mode gets the check's declaration files, the `.cpp`/`.hpp` start with the coverage comment and stay owned, g++ runs, the warning names the library and the channel lists the blocks and the compiler's TON; a symbol with no usable declaration: generation fails, the summary names it with its library, and the channel lists only that symbol under "C++ could not be generated", with no coverage lines), the g++ run and its Problems entries, ONE notification for a missing g++ (*Open Setting*; *Detect g++* only with an empty setting), an edited generated file left alone, and `CPP_Files/.gitignore` (written on the first run and noted in the channel only, no warning; unchanged on the next; an edit left alone and noted; deleted → not recreated on two runs, noted, `removed` in the record; a foreign one untouched and noted while the C++ is still written; an edited `PLC.cpp` dropped from it with the summary saying git sees it; a user's `PLC.o` in a fresh folder neither touched nor listed); the build waits for the MSYS2 registry search (`gppReady`) before it resolves g++, and a failing wait does not stop it. |
| `test/test_conditional_pragmas.js` | R12, `src/lsp/conditionals.js` and the diagnostics built on it, through the server's path (`assembleSt` → `indexXmlObject` → `syncDocument` → `provideDiagnostics`). Unit: nesting, segments, `fbRS.SET := TRUE;` and a line-leading named argument (`SET := c,` in a multi-line call) are not boundaries while real GET/SET accessor lines are, a statement-level nested group does not widen the span past its `{END_IF}`, a group wrapping the first VAR block is not an uncertain head, directives in comments/strings ignored, each kind of unbalanced segment marks only itself, selections, the 64 cap, neutral groups, suppression spans, `pickVar`/`AMBIGUOUS`, `scopeUncertain`, `inheritanceUncertain` from both indexers. Zero diagnostics (and every segment balanced, so a zero is never the unbalanced rule by accident) on valid conditional code: the reported split IF head, ELSIF chains, nested groups, WHILE/FOR, REPEAT and CASE split across branches and groups, per-branch declarations (also used outside the group), names only in a branch, `defined(variable:…)`/`defined(pou:…)` guards, a mid-expression group, a directive inside a type, a conditional EXTENDS head, a conditional VAR/VAR_INPUT header with a named call, a multi-line RS call (`SET :=` at line start) next to, after and inside a group, enum members inside and after a group (both indexers). Still reported outside groups: an unterminated FOR, a stray END_WHILE, an undeclared name, a type mismatch, an IF every branch opens and nothing closes (on the group's `{IF}`), a method after an unclosed `{IF}`, the statement after a nested statement-level group, an undeclared name in a POU whose first VAR block is wrapped; the cap silences only its own segment. Byte-identical structural output to the old matcher on every sample unit, per-segment = whole-unit there, and a neutral group appended to every unit (sample and synthetic, including multi-line named-argument calls and a property) leaves its structural output unchanged. Completion and references over both branches. |
| `test/test_compile_real.js` | **Optional gate `compile-real`**: the REAL compiler — the bundled one, or `TWINCAT_COMPILER_BUNDLE` — first proving the bundled IEC libraries load (`TON`, `R_TRIG`, `CTU`, `LIMIT` resolve; `PID`, from a library NOT shipped, does not), then over every PLC project in `sample/`, through the same code the command uses (library preparation included): ZERO errors and zero warnings after the pragma filter (a ratchet, like the diagnostics baseline), nothing library-filtered, plus planted errors in a method body, a method declaration and a GVL landing on the right file/component/pane/line, and — in the second sample — a call to a method only the FIRST sample's same-named `FB_Cylinder` has, reported in the second sample's MAIN (the projects are never compiled together). Then R3.4 on the synthetic library project (`test/_synthLibProject.js`): errors without the declarations, 0 with them; a wrong argument type and an unknown parameter on a library call reported; an archive-only library name filtered; a user typo, a typo on a library FB member and an unknown name behind a qualifier reported (the last at its pane column); 0 errors without the dump. Then compiler defines on a temp copy of the second sample (`{IF defined(X)}` / `{IF hasvalue(X, 'v')}` in MAIN, `<CompilerDefines>` in its `.plcproj`): the defines select the branches; wrong case or value select ELSE; a numeric value is passed exactly and declares no global constant; a Debug-conditioned group's define selects its branch, a Release-only one does not. Then, on another copy: `hasvalue(TkLevel, '4')` holds from a `.plcproj` value `'4'` next to a `VAR_GLOBAL CONSTANT TkLevel`; a per-object define on FB_Valve selects its branch there but not in FB_Cylinder's same `{IF}`; a per-object value wins over the project's for `hasvalue` in that object only. Then R12 parity: each conditional-pragma fixture is compiled with no define, each define it names and all of them; one the compiler accepts under at least one set must get 0 LSP diagnostics (one rejected under every set is printed as advisory). Prints the sample's timing. Skips (and says so) without a Node >= 22. |
| `test/test_cpp_real.js` | **Optional gates `cpp-real` and `gpp-real`** (R13): on a TEMP COPY of `sample/` (the sample is asserted untouched), every PLC project goes through the command's steps — units, library preparation, compiler defines, the check (0 errors), the compile mode, the write into `<project dir>/CPP_Files/` under the ownership record (the folder holds exactly `<project>.cpp`, `.hpp`, the record and the `.gitignore`; a second run replaces its own files). With git on PATH: `git init` over the copy, `git check-ignore -v` ignores each project's `.cpp`/`.hpp`/`.o`/record through `CPP_Files/.gitignore`, a user file there and the `.gitignore` itself are not ignored, `git status` lists only those two, an edited `.cpp` is not ignored (ignored again once restored), a user's own `<stem>.o` there before the first write is not ignored, and a deleted `.gitignore` is not recreated (the `.cpp` is then no longer ignored). With a g++ (`TC_TEST_GPP`, else detection): `-c` against `resources/compiler/include/`, no warnings with the build's flags, a clean build records its `.o`; a failing build must fail ONLY on a `KNOWN_GPP_GAPS` entry (today TcToolkitSample_PLC: a PROPERTY read through a global FB instance emitted as a field access), each error placed on a real line of the generated file; an error planted in a `.cpp` is placed on its line. Library use: a second copy of the sample, with TcToolkitSample2 given the SYNTHETIC library of `_synthLibProject.js` (a `.plcproj` reference, the dump, a `.tmc`) and a POU that calls it (including a function whose array parameter's bound is a library constant) plus a block of the project derived from a library block that reads an inherited variable, is checked (0 errors, nothing filtered), generated with the declarations, the coverage names "Synthetic Motion Library" with its blocks, the files start with the coverage comment, and g++ compiles it with no warning. An inherited variable of a type this compiler lacks (LTIME) and an LTIME-parameter function make the generation fail and are named with the library (the variable through its owner, `FB_SynAxis.tSynSpan`). |
| `test/test_cpp_generate.js` | `src/cppGenerate.js` without the compiler: file stem and `CPP_Files` paths, the compile-mode command line (the check's inputs/defines/list names plus `-o`, no `--check`/`--json`; the check's own line unchanged), ownership in real temp folders (fresh write, replace an unchanged own file, refuse an edited one and a foreign one, per-project record, the `.o` claimed/recorded/deleted, a foreign record stops everything, a record entry with a path ignored), a `.plcproj` rename driven through `cppOutputPaths` + `cppOwnerId` as the command does (old `.cpp`/`.hpp`/`.o` deleted), a case-only rename on a case-insensitive file system, CRLF copies still owned, a half-failed write still recorded, the library coverage (`libraryCoverage` grouping/sorting, the summary sentence with and without g++, the channel lines, the header: line comments only, none for types alone, the file's line endings, owned and replaced like any text), the `CPP_Files/.gitignore` (created with the comment line and each project's `.cpp`/`.hpp`/`.o` plus the record; unchanged / updated for a second project and a rename; CRLF still owned; an edited one left alone; a deleted one never recreated, remembered across runs and across the `.o` steps; a foreign one never overwritten nor adopted; exact wanted text adopted; only the toolkit's own files listed: a foreign `<stem>.o` present before the first write is not (listed once it is gone), an edited generated `.cpp` or recorded `.o` (`changed`) leaves the list; glob characters escaped; a `files` entry named `.gitignore` ignored; the notes), and `runGenerate` over a fake child (files returned, temp dir gone, failure keeps the log, no files = failure, timeout). |
| `test/test_cpp_settings.js` | `src/cppSettings.js`: defaults off; effective values (the build implies generation); `couplingWrites` per scope (build on → generation on in that scope; generation off → build off there; inherited values; a hand edit setting both; no ping-pong); `checkboxWrites` for the dropdown (coupled writes, target = the most specific scope that sets the switch). |
| `test/test_gpp.js` | `src/gpp.js` without g++: detection over a mocked PATH and file system (Windows order, quoted PATH entries, MSYS2/MinGW/WinLibs/w64devkit/Chocolatey roots from the environment or defaults; Linux PATH only), the path setting via `checkConfiguredGpp` (full path, quotes, bare command name on PATH or not, a folder with or without g++, missing → reported not replaced), the g++ version (parse, `-dumpfullversion` → `-dumpversion` → `--version` for clang, the per-path+size+mtime cache, detection preferring g++ 7+ over an earlier g++ 6, `tooOld` on a set or detected g++ 6), the command line (`-std=c++17`, no `-Wno-c++17-extensions`), parsing g++ output (Windows drive letters, notes kept with their message, the include and instantiation chains kept as context, positionless `cc1plus:` errors), placing messages on the `.cpp`/`.hpp` (a header error from a captured real g++ 13.3 instantiation lands on the `required from here` line; a later one in the same header on the generated `#include`; no context → the `.cpp`'s first line naming the header), the summary, `runGpp` over a fake child (no shell, g++'s folder first on PATH, exit codes, spawn failure, timeout, cancel), and `killProcessTree` (POSIX group SIGTERM, Windows `taskkill /T /F`, fallbacks; on POSIX a real timed-out `sh` must leave no grandchild running). |
| `test/test_gpp_commands.js` | `src/commands/gppCommands.js` under a stub: an empty `tcToolkit.compiler.gppPath` is filled (Global), a set value is never overwritten and is checked like the build checks it (`checkConfiguredGpp` on a faked machine: a bare name on PATH or not, a quoted path, a folder with or without g++), a value of only quotes (`""`, `" "`) counts as empty and is filled, nothing found writes nothing, the silent fill never rejects, `twincat.detectGpp` reports with an "Open Setting" button that opens the setting in the User settings; a set g++ 6 is kept but called too old, with a hint to change or clear the setting (not to run *Detect g++*) and a newer detected g++ named but not written; the explicit command fills a detected g++ 6 with a warning, the silent fill does not; the command waits for the MSYS2 registry search before detecting, and does not write a g++ 6 while that search is unfinished; with MSYS2 installed without g++ its "not found" / too-old messages name the root and the pacman command, and after writing (or keeping) a g++ 6 say to install gcc, then clear the setting — no "Detect g++" step, which would keep the old value (a failing wait or check never breaks it). |
| `test/test_cpptools_selection.js` | `src/cppToolsSelection.js` and `createProviderPrompt` (src/commands/cppToolsCommands.js) under a `vscode` stub: JSONC (comments, trailing commas, BOM, string contents kept); which `c_cpp_properties.json` configuration counts (exact `Win32`, else the last), absent/`${default}` → the setting, `""` → no provider; the decision none/setting/file (exact id match, near misses flagged, the display name in the file, another configuration naming another provider → file); the prompt only for a CPP_Files file, with the C/C++ extension installed and the provider registered, in a workspace folder; once per folder per session (also two concurrent checks); *Use TC Toolkit* writes `C_Cpp.default.configurationProvider` in the WorkspaceFolder scope of that folder and re-announces; *Use* / *Don't ask again* remembered across sessions, *Not now* not; multi-root names the folder; a file naming another provider → *Open c_cpp_properties.json*, the file never written; logged (to the console by default). `test/test_cpptools_provider.js` also checks the selection check creates no output channel. |
| `test/test_cpptools_provider.js` | `src/cppToolsProvider.js` and `src/commands/cppToolsCommands.js` with a fake C/C++ API and a `vscode` stub (the dev host has no C/C++ extension): which files the provider answers for (the `.cpp`/`.hpp` in a known project's `CPP_Files`, or beside a `.plcproj`; not the `.o`, sub-folders, other folders; case per platform), the configuration (headers + CPP_Files on the include path, c++17, compiler path and gcc mode only with a g++), the browse configuration, `connectCppTools` (absent → the API is not even asked; installed later → register + notifyReady once; an API without notifyReady; a getter that fails → no throw, no message; dispose), no browse configuration without a `CPP_Files` folder, each item carries the requested Uri object, every request is logged (a failing log never fails it), and the wiring (a g++ path change re-announces; another setting does not; a g++ 6 is not handed over as the compiler; the CPP_Files watcher exists without the C/C++ extension and, after a mid-session install, a generated file re-announces; the MSYS2 registry search settling with a root re-announces, with none sends nothing, failing is ignored; nothing written or shown). |
| `test/test_library_decls.js` | `src/libraryDecls.js` without a compiler, on the SYNTHETIC library project (`test/_synthLibProject.js`: dump, `.tmc`, a generated archive — every name invented): the `.tmc` model (library-owned types only; interfaces and the project's own types skipped; no comment/string text read), gathering, each declaration kind's exact text (a function block's own `VAR` members, an LTIME one left out; an array bound that is a library constant written as its value), `readType` with library constants (plain, qualified; an unknown one, an expression, another list refused), conflicts (compiler names, user names, a dependency the user redefines), dependency-only declarations, nothing guessed for unreadable types, qualifier blanking (same lengths; members/comments/strings/user names untouched; each stripped qualifier reported with its name), library attribution (`libraryOf` → the `.plcproj`'s library name for a `.tmc` type, a dump function, an archive-only name and the namespace; `spellingOf`; `declaredSymbols` and `compilerSubstitutes`; `undeclaredUses`: a member named through its owner, an inherited one found by its name, deduplicated, cascades left out), the filter case by case (a user typo kept; an internal variable of a library block read from outside dropped, of a user block kept), **temp-dir lifetime** (the declarations exist only in runCheck's temp dir during the run; gone after, also on a failed run; project, workspace and `sample/` unchanged), the no-dump case. |
| `test/test_vendored_compiler.js` | `resources/compiler/`: exactly the files `SOURCE.md` lists (the runtime headers in `include/` included), each matching its recorded size and SHA-256; the headers the generated C++ includes are there, `COPYING` puts them under the runtime library exception and `SOURCE.md` states that licence with the right count of headers carrying a per-file notice; a full 40-hex commit and the source link at it; the GPL-3.0, Apache-2.0 and MIT texts; `THIRD-PARTY-NOTICES.md` naming the commit; `.vscodeignore` shipping the directory and dropping `scripts/vendor-compiler.js`; the bundle requiring Node built-ins only; `resources/dialects/` holding exactly `twincat3.json` and no profile anywhere else (user rule). |
| `test/test_settings_migration.js` | `src/settingsMigration.js` over a fake VS Code configuration store: the rename table, User / Workspace / per-folder values each moved within their own scope, a value already under the new key never overwritten (old one still removed), a second run a no-op, a failed copy logged with the old value left for the next run, a synchronous throw / failing removal / throwing `getConfiguration` / unreadable folder list all logged and never thrown. |
| `test/test_recent_projects.js` | `src/recentProjects.js`: newest first, de-duplicated (Windows paths case-insensitive, either separator), capped at 10, missing solutions pruned, malformed stored data ignored, the globalState adapter, and `recentsShownLimit` (the start page's row limit: default 2, clamped to 1..10). |
| `test/test_msys2_detect.js` | `src/msys2Detect.js` with a fake reg.exe and file system (runs off Windows): reg.exe output parsed by `HKEY_` and `REG_SZ` (English and German output, a DWORD ignored), the uninstall search over all four keys (HKCU/HKLM, WOW6432Node), only `DisplayName` starting with MSYS2, `InstallLocation` / the `UninstallString` folder / an expanded `REG_EXPAND_SZ`, an entry found twice read once, a failing reg.exe; `createRegRunner` (argument array, timeout, no shell, errors → null); the usual roots (profile, Scoop, `SCOOP`, `ChocolateyToolsLocation`); the candidate order in `src/gpp.js` (PATH, registry root's environments, usual roots, `C:\MinGW`, `usr\bin` last; PATH/MSYS2 repeats tried once, case-blind); the user report (a PATH MinGW 6.3 loses to a registry-only MSYS2 g++ 14); an MSYS2 without gcc named in `describeGppSetting` / `resolveGpp` (`msys2Root`), not when any environment has g++; the cache (never runs off Windows, once per session, `settled()`, bounded wait longer than both reg.exe phases, never rejects). |
| `test/test_xae_shell_detect.js` | `src/xaeShellDetect.js` with every dependency faked (runs off Windows): the COM registration for both shells (quoted and argument-suffixed `LocalServer32`, the 32-bit view for 4024, a localized value name), the default locations with and without the environment variables, a registered file that is missing, a non-GUID ProgID value, rejecting / throwing registry and existence probes, non-Windows (nothing found, registry never queried), `createRegQuery` over a fake `execFile` (argument array, timeout, errors → null), `describeConfiguredShells`, and `resolveShellExe` (configured-and-existing wins, else default location, else registry). |
| `test/test_xae_shell_commands.js` | `src/commands/xaeShellCommands.js` under a recording `vscode` stub with detection faked: an empty setting is filled (Global target), a non-empty one is kept even when its file is missing, nothing found writes nothing, `autoFill` never rejects, `twincat.detectXaeShell` reports found / kept / not found in one message whose button opens the filtered settings. Also `findTwinCatShells` in `src/xaeShell.js`: `path4026` ↔ the 64-bit shell, `path4024` ↔ the 32-bit one, a missing configured path ignored (those checks are skipped on Windows, where a real shell may be installed). |
| `test/test_xae_build.js` | `src/xaeBuild.js` + `src/xaeBuildSettings.js` over the synthetic fixtures `test/fixtures/xae/*.jsonl` (read through `test/_fakeXaeDriver.js`): **showWindow false/undefined → no `-ShowWindow`, true → exactly one**; `-STA`/`-NonInteractive`/`-ExecutionPolicy Bypass`, no `-TcVersion` unless `shellOverride` (then exactly `-TcVersion <ProgId> -AllowVersionMismatch`, build only, known ProgId only); `missingShell` (the offer, the newest installed shell, a bare-string `installed`, none for activation, the install text); activation only with a valid NetId; the line splitter (CRLF, split prefix, split UTF-8, no final newline); parseLine; the reducer over every fixture; describeExit (0-4, timeout, spawn error, killed, missing `done`, an unconfirmed exit 1 → interrupted with the stderr line, errors counted by severity); `reachedBuildResult`; the summary counting errors/warnings separately; describeUiMode (headless, visible, version switch, mismatch, unreadable, `MainWindow.Visible` unreadable with the window shown or hidden); canCancel (never in target/activate/restart/verify); isStalled; target pick; confirmation text; settings defaults and clamps. Change B/C (2026-11-13): `declaredPairs` on both samples' `.sln`, `activationPlatform` (same / switch / not-declared / unknown, case-insensitive, the solution's spelling), the switch modal's text and buttons, provenance kept on targets, gate 4's multi-line refusal summarised on one line (`oneLine`), `errorDetails` (bare-string reasons too) and `noErrorDetails` (re-run offered only headless, never a claim about the visible run), a free-text platform reaching `-Platform`. |
| `test/test_xae_build_commands.js` | `src/commands/xaeBuildCommands.js` + the provider hooks under a `vscode` stub with the fake driver: the setting and the dropdown's `setXaeOption` decide `-ShowWindow` on the next spawn; the channel's requested and actual UI mode lines; Problems only in `twincat-xae` (Compile Project's collections untouched; a stub `compile` source proves the two sources' pane markers merge, edits reach both, removing `xae` keeps Compile Project's); the entry's `/xaeProblem?id=` link opens the component and pane through the URI handler, `openTarget` once per run; a dismissed modal spawns nothing, the confirmed NetId reaches the argv, `twincat.xaeBuild` never activates, a target readback mismatch is an error; cancel via the cancel file (exit 4, nothing killed); the force stop (PowerShell tree + only an `ours` shell, image-filtered; the launch-phase note); a cancelled, force-stopped, timed-out or unconfirmed-exit-1 run keeps the previous Problems; stderr decoded across chunks; no cancel during activation, nor when activation begins inside the grace period; one run at a time + `twincat.xaeRunning`; timeout, its extension during activation and after a refused stop; the stall re-run with `-ShowWindow` (one channel line, no second shell check; none after a run that exits 0 or refuses the stop); config-not-declared pick; the missing-shell flow on sample 2 (a `.tspproj`, 4024; `projectTcBuild` reads it): the pre-check modal when it can tell (exactly one prompt, the first run already `-TcVersion TcXaeShell.DTE.17.0 -AllowVersionMismatch`, the channel logs the choice), the driver's `progid-not-registered` + `installed` fallback when it cannot (one prompt, one re-run with exactly those args), Cancel keeps the original error, no installed alternative → no prompt and the shell to install, activation never offered another shell (its Run-anyway warning, no override), a shell found only in the registry passes silently; Show Activation Targets; the non-Windows refusal. Target platform: Cancel / Switch for this run (argv `-Platform`, setting never written, the next build back on the setting) / Switch and remember (written once: user, workspace, workspace-folder scope), the plain modal when platforms match, the not-declared refusal before any spawn (sample 2), gate 4's one-line summary; a failed headless build without details: the reasons in the notification, *Build again with the window shown* re-runs once with `-ShowWindow` and writes no setting, no offer after a visible run. |
| `test/test_xae_error_placement.js` | `src/xaeErrorPlacement.js` against `sample/` objects: `.sln`-relative Windows paths, both line bases, the section marker (exact) vs "(location approximate)", a named method, file-known-line-unknown, general, the summary sentence. |
| `test/test_xae_driver_contract.js` | `resources/xae/build-plc-project.ps1` read as text against `src/xaeBuild.js`: ASCII, every flag buildDriverArgs emits is in `param()`, every event type emitted ⇔ handled, phases, fatal codes, prefix/`v`, exit 4, `Exit-Run` for every exit, the builder's safety markers (`$ownShellPid`, `Close($false)`, `Resolve-ActivationTarget`, ADS state 5, readback, the activation show), `UserControl` never set, the hide step guarded by `-not $ShowWindow`, cancel disarmed before activation and every phase entered after the disarm uninterruptible in JS, no real path to a wildcard `-Path` (and `ProviderPath` from Resolve-Path), the `shell-not-ours` refusal before any DTE write and a finally that leaves a foreign shell alone, the unidentified shell made visible again, the error list and output panes read with retries, every builder line kept (additive, with each rewrite listed), the `progid-not-registered` fatal's `installed` census (every `$ProgIdByBuild` ProgId tested in HKCR with `-LiteralPath`, newest first, `progId`/`build`/`projectVersion`/`installed` in the event, the same census printed by the builder and `templates/` copies), `$ProgIdByBuild` equal to `XAE_SHELL_VERSIONS`, and `.vscodeignore` not excluding the driver. Windows-only counterpart: `scripts/Build PLC project/test-emit-event.ps1`. `Get-OutputPaneTexts`: OutputWindow before the Windows.Item route, each null guarded with a reason, identical in the builder and `templates/` (ASCII, CRLF); ErrorItems by plain assignment; `errorDetails` emitted with its reasons. |
| `test/test_multi_project_scope.js` | End-to-end: two copies of `sample/` under one workspace root (`test/_multiproject.js` builds the fixture, one copy deliberately diverged), driven through the real `scanWorkspace`. Asserts the partition (one index per project, nothing lost to a name collision), 0 diagnostics on the correct copy while the diverged copy's own real error still reports, references and the rename config scan never crossing the project boundary, and the library namespace/symbol registries staying per-project — including the Libraries-view union fallback when no project is specified. Needs `sample/`; skips cleanly when absent. |

| `test/test_object_insert.js` | The Objects-tree insert commands' text, built by driving the **real** `buildNodeFromXml` over real `sample/` objects: the bare name for each kind, and the call template — instance name for an FB (`FB_Gripper` → `fbGripper`, since ST calls an instance, not the type), own name for a FUNCTION/PROGRAM, bare for a method/action, `Name();` when there are no parameters. Also pins that the extracted `callTemplate` is byte-identical to what `libraryTreeProvider` produced before the move, and that every `contextValue` named in the two new `when` clauses is one the Objects tree actually emits (read out of `objectsTreeModel.js`, not hard-coded, so a rename cannot silently orphan the menu items). **One case is synthetic on purpose:** no FB in `sample/` declares root `VAR_INPUT`/`VAR_OUTPUT`, so the mixed `:=`/`=>` ordering case is driven from one clearly-marked XML string through the real parser. |
| `test/test_nested_comments.js` | Nested `(* … *)` comments (TwinCAT nests them; Infosys "ST comments" documents the form) across **every** scanner: the `parser.js` lexer, `src/stComments.js` and the helpers on it (object kinds, DUT kind, enum members, the check unit's POU keyword), the fold scanner, the Monarch `comment_block1` state (rebuilt from source and run with a state stack) and the TextMate grammar's self-including rule. One table of cases runs through all of them: `*)`-looking text in an inner level, three levels, a quote / `//` / slash-star inside, unterminated, `(*)`. Plus markers inside STRING/WSTRING literals, slash-star staying non-nesting, token positions after a multi-line nested comment, and the language features on a TcPOU whose comments hide declarations and code: zero diagnostics, only the real variable declared, and Go to Definition mapped back through `localToAbsolute`/`absoluteToLocal` to the right pane line. Verified red on the pre-change code (24 failures). |
| `test/test_st_strings.js` | ST string literals across **all three** grammars that must agree — the `src/lsp/parser.js` lexer, the webview's Monarch tokenizer and `syntaxes/twincat-st.tmLanguage.json`. IEC 61131-3 escapes with `$` (`$'`, `$$`, `$N`, `$0D`, …) and a **backslash is an ordinary character**; both highlighting grammars had C-style `\\.` escape rules copied from Monaco's sample, so `'C:\Temp\x\'` swallowed its own closing quote and ran on to the next apostrophe anywhere below — in the reported case an `FB's` inside a comment 16 lines down. Uses that verbatim case. The lexer was always right; only the two grammars were wrong, which is exactly why one harness now pins all three together. |
| `test/test_scan_controller.js` | `src/lsp/scanController.js`: which of the two scan-triggering requests actually has to run a scan. Pins that `ensureScanned` twice over one root set scans **once** (the duplicate startup scan this replaced), that `rescan` after it scans **again** — the assertion that stops a future "optimisation" from teaching the `.plcproj` watcher to skip, since on a content change the roots are unchanged — and that a throwing scan leaves no completed state. Root sets compare order-, case- and separator-insensitively; the empty set is a legitimate *completed* state, or a window with no folders would re-request forever. |
| `test/test_index_inputs.js` | `src/indexInputs.js`: `*.tmc` and `library-signatures.xml` re-index (case-insensitive) but not when under a directory the scan skips (`_Libraries`, `_CompileInfo`, `ST_Files`, `.git`); the own-write gate suppresses during the write and its grace period and never sticks closed after a throw; a build burst plus a `.plcproj` change is ONE reindex on a fake clock; static checks that `extension.js` and Update Library Definitions are wired to it. |
| `test/test_debounce.js` | `src/util/debounce.js`: trailing edge only, one invocation per burst carrying the **last** arguments, every caller's promise resolved. Timers are injected, so it asserts on a fake clock rather than racing a real one. |
| `test/test_archive_store.js` | R6's persisted archive-name cache (`src/lsp/archiveStore.js` + `harvestArchiveFile`), each "session" a fresh Node process: off when no directory is configured; a second session decodes nothing and gets identical names; an archive rewritten with the SAME size and mtime is caught by the central-directory fingerprint and decoded afresh; garbage, truncated, empty, foreign, other-version and other-decoder files are ignored and rewritten, a malformed entry dropped alone; entry and name-character caps evict least-recently-used; eight vendored copies are one stored entry; only names reach the file; two windows keep each other's entries; file and buffer fingerprints agree, also when the central directory starts before the 66 KB tail window. |
| `test/test_scan_readiness.js` | R6's per-project background scan with a HAND-STEPPED event loop: background indexes equal the one-pass scan's (objects, libraries, routed `.st`); a request for a project is released only when that project's index is complete (snapshot identical to the finished index) while other projects are still unindexed; a waited-for project jumps the queue; a file under no project waits for the whole scan; a reindex supersedes mid-scan and the old scan's waiters are answered from the NEW workspace; a throwing scan leaves the last complete workspace answering; the controller joins an in-flight `ensureScanned`, never lets `rescan` skip, and records completion only for the latest scan. |
| `test/test_server_ipc.js` | The REAL `src/lsp/server.js` in its own process over Node IPC (`vscode-jsonrpc`): `initialize` answers without waiting for the scan and advertises hover; `custom/hover` answers at once; `custom/diagnostics` for the last project sent at once, and right after `custom/reindex`, return ZERO diagnostics on the correct sample (a control shows a partial index gives 10); `custom/indexReady` joins the startup scan; `custom/libraries` answers per project; the archive names land in `initializationOptions.archiveCacheDir` as one entry for four vendored copies, and a second server session only reads that file. |
| `test/test_discovery_memo.js` | R6's per-scan directory-listing memo (`createDirectoryListingMemo`, `src/twincatWorkspace.js`): a memoized signature/`.tmc` walk equals the unmemoized one (same files, order, caller-spelled paths); a 3-project scan reads each directory from disk exactly once; and through the REAL scan composition a dump or `.tmc` added after a scan is found by the next one, a removed one is gone, and one three levels below a project is found — the memo never outlives its scan. |
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
| `run.js` | The references peek: builds for the port it will serve on, drives Find References, asserts. Also pins the page's global error overlay: opening the peek must leave it hidden, Chrome's benign "ResizeObserver loop completed" notice (dispatched by hand, because whether the real loop fires is layout-timing dependent) must not raise it or post `error`, and a genuine error still must. `HARNESS_PORT` moves it off 8123; `HARNESS_SHOT=x.png` saves a screenshot. Also pins the Generate ST split button (roadmap R1): with one project the caret is hidden and the main button keeps its rounded right end; with two or more the inner corners square off to fuse with the caret (`has-caret` on `#generate-st-group`, set by `editor.js` with the caret's `hidden` flag — no `:has()`, which VS Code 1.66's Chromium lacks). Transitions are disabled for that check so it reads the end state, not a frame mid-animation. Step 7e pins Compile Project's pane markers: `compileDiagnostics` → owner `twincat-compile` on the active component's panes, `st-validator` markers surviving both ways and across a diagnostics refresh, a component switch showing only that component's markers, an edit dropping the edited component's markers and posting `compileDiagnosticsStale`; it writes a pane-marker screenshot (`HARNESS_COMPILE_SHOT`, default `test/browser/out/compile-markers.png`; empty = none). Step 7f pins the toolbar's Compile button: right after Generate ST, with its glyph, name and tooltip; a click posts `compile-project`; `compileRunning` disables it (a click then posts nothing) and re-enables it; at 320–1200 px Generate ST, its caret and Compile all stay inside the editor with no sideways scroll, and the Compile label drops to the glyph at <= 1100 px. Then the Compile dropdown (R13, `#compile-caret` / `#compile-menu`): closed and off at start, labelled, opens with focus on *Generate C++*, ArrowUp/Down and Space operate it, ticking *Build with g++* ticks *Generate C++* and unticking *Generate C++* unticks the build (each posting `setCompileOption {key, value}`), Escape closes and refocuses the caret, a host `compileOptions` message updates the boxes live, an outside click closes it, opening one split menu closes the other, and the caret stays inside the editor at every width. `HARNESS_TOOLBAR_SHOTS=<dir>` writes toolbar screenshots (dark and light; 1200, 960, 820, 400 px) and `compile-menu-open.png`. |
| `run_start_page.js` | The start page (roadmap R2): renders the real `renderStartPageHtml()` output WITH its CSP (only `acquireVsCodeApi()` is stubbed, through Playwright's init script), and asserts no request leaves the page's origin, the project name is validated while typing (shared `media/projectName.js` rules, `aria-invalid`), Create posts `{version, name, location}` and shows a host refusal, every other control posts its message, project actions are disabled while no project is open, Compile project is enabled only with `compilerReady` (the compiler file exists — by default the bundled one) AND a project, shows "Compiler file not found" otherwise (and names no compiler product), the form survives in webview state, the recent list shows at most `recentsShown` rows behind a keyboard-operable "Show all (K)" / "Show fewer" tile (local to the page, follows a changed limit), the Settings card shows the two XAE Shell paths with a warning row for a path that is not on disk and posts `openSettings {section}` / the detect command, the g++ row in all four states (set, set via a bare name, detected on PATH / in an install folder, not found, and the three unusable-value warnings styled as the XAE warning row), its Change… / Detect again by click and keyboard, the Compile dropdown (R13: a chevron beside the tile, `aria-expanded`/`aria-controls`, a group of two labelled boxes showing `state.compileOptions`, keyboard-operable, posting `setCompileOption` with the coupling shown at once, never starting a compile), and there is no horizontal scroll at 360/560/1200 px (one column at 360). `HARNESS_START_SHOT=x.png` saves the Project actions card with the options open. Defaults to port 8125. |
| `run_pragmas.js` | Folding and pragma highlighting. Folds real blocks and reads back the rendered lines, then tokenizes through Monaco's **own** tokenizer. Both fail silently if they regress, which is the point of driving a browser: a unit test on `stFolding.js` cannot prove Monaco actually *used* it rather than its own indentation provider. Carries the two reported bugs as regressions, and asserts implementation-pane blocks still fold — registering a provider replaces indentation folding, so that is the thing most likely to disappear unnoticed. Also runs nested `(* (* *) *)` comments through Monaco's own tokenizer (the inner `*)` must not return to code), and the pragma hover end to end in the webview: the stub answers with the real `provideHover` + `mapHoverToLocal` computed in Node, and the harness checks the request's pane position, the rendered widget, that a line with no `{` costs no round trip, and that a clicked documentation link goes to the host (`openDocumentationLink`) rather than navigating the webview. Verified: removing the provider turns 6 assertions red, and the failure text reproduces both original bug reports verbatim. Defaults to port 8124. |

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
real host runs the watcher chain, so this is the one place it can be proven). `run.js` also plants two
OLD `twincat.*` User settings in the fresh profile, and the **settings-migration step** asserts that the
real activation moved one to its `tcToolkit.*` key, kept the other's already-set new value, removed both
old values, and that the extension reads the moved value. The **start-page phase**
(roadmap R2) checks what only a real host shows: every start command registered, the `TC Toolkit` Activity
Bar container and its Start / Objects / Libraries views open (`workbench.view.extension.twincat`,
`<view>.focus`), *TC Toolkit: Open Start Page* opens the `TC Toolkit Start` tab, and *Create New Project* (with
its arguments, so no dialog) writes a 3.1.4026 and a 3.1.4024 solution and refuses a second create. The
**compile phase** (R3.2/R3.3) runs *TC Toolkit: Compile Project* on every PLC project of the fixture
through the real command, with the **bundled** compiler (asserted) — `TWINCAT_COMPILER_BUNDLE` (and
`TWINCAT_COMPILER_NODE`) override it, written by `run.js` into the fresh profile's `tcToolkit.compiler.*`
settings. Only when the host's `checkSetup` finds no Node >= 22 does the phase print `[SKIP]` and assert
nothing. It also clicks the toolbar's Compile button in the station editor for real (hook message `test:clickCompile`) and asserts the host resolved the file's one owning project and the run started and ended (`compile-button` step). It asserts every run finishes, that no
error is reported on the sample's own code (only the identifiers the P8 phases typed on purpose, which
reach the compiler as unsaved edits, plus the object-insert phase's snippet in its file), and that each
project's files in the Problems panel hold exactly that project's results. The **rename-undo phase**
(R7) renames `FB_Station.Reset` (a method of a shared interface) and then `FB_Cylinder.TcPOU` in the
LineB copy through the real `twincat.renameObject` (the input box and confirmation are answered by
wrapping the shared API object), each with the file open in the custom editor, and asserts each rename
is ONE `applyEdit`, the interface method and its calls follow, the `.plcproj` entry is rewritten, the
moved file keeps its UTF-8 BOM, nothing is left dirty, and *TC Toolkit: Undo Last Rename* puts every
file of the copy back byte for byte, the file name included.

`TCDEV_CODE` points `run.js` at another VS Code (a CLI shim, or the `code` binary of an unpacked build)
and `TCDEV_CODE_ARGS` adds launch arguments. Headless Linux as root:
`TCDEV_CODE=<dir>/VSCode-linux-x64/code TCDEV_CODE_ARGS="--no-sandbox --disable-gpu" xvfb-run -a node test/devhost/run.js`.
On Linux the P8 "flushed file is byte-identical to foldEdits" check fails on a line-ending difference
(`\r\n` on disk vs `\n` expected), identically on the pre-R7 commit; it is a Linux-only EOL artefact,
not a product regression, and passes on Windows.

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

- **`build`** (current Node) — `npm run lint` (ESLint 10 needs Node ^20.19 || ^22.13 || ≥ 24, so
  lint lives only in this job; the Node 16/20 legs never run it), `npm run typecheck`, `npm test` with **`REQUIRE_FULL_SUITE=1`** (the
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
    objectCommands      "PLC Objects" create/delete (methods, properties, actions, files, folders);
                        Add Get/Set Accessor re-adds a property's missing accessor (issue #25)
    clipboardCommands   "PLC Objects" copy/paste (duplicate a component cross-file or a file under a new name)
    renameCommands      "PLC Objects" rename (files, members, directories, virtual folders; reference-aware;
                        cross-file updates staged through renameTransaction and written as ONE
                        WorkspaceEdit with the .plcproj entry and the file move, so one undo restores
                        it all) + TC Toolkit: Undo Last Rename (runs `undo` from a text editor)
    libraryCommands     "PLC Libraries" commands (refresh, insert, copy, Update Library Definitions)
    lspBridgeCommands   openComponent navigation + the twincat.lsp.query* Monaco↔LSP bridges
    startCommands       The TwinCAT sidebar's Start view (an empty tree, so its viewsWelcome buttons show)
                        and the start commands: Open Start Page, Create New Project (version → name →
                        location prompts, or all three as args from the start page; then open here /
                        new window / add to workspace), Open Existing Project (.sln or folder, or a
                        recent entry), Generate ST (multi-pick when 2+ projects), Open Settings and the
                        help links. The start page runs these same commands — no second code path.
                        Open Settings takes an optional `tcToolkit.*` section as its Settings-UI query;
                        a change to tcToolkit.startPage.* / tcToolkit.xaeShell.* re-posts an open page's state
    compileCommands     `twincat.compileProject` (roadmap R3.2): project pick, setup refusal with "Open
                        Settings", the run under a cancellable progress notification, and where the
                        results go — a DiagnosticCollection `twincat-compile` (Problems, at the XML
                        position), the panes (through the provider), a status-bar item, a summary
                        notification with "Go to Problem…" (`twincat.compile.goToProblem`), and a URI
                        handler for each entry's code link (`/compileProblem?id=N`), and the output
                        channel `TC Toolkit Compile` (compiler-define notes). The VS Code half of
                        compileCheck. R13: after a clean check, with the switches on, C++ generation
                        (cppGenerate) and the g++ build (gpp) — g++ messages in their own collection
                        `twincat-gpp` (source "TC Toolkit g++") on the generated files; the two switches'
                        coupling on every config change (cppSettings), `setCompileOption` for the
                        dropdowns (provider.setCompileOptionsSource / setCompileOptions → `compileOptions`
                        to every editor; the start page through onSettingsChanged)
    gppCommands         `twincat.detectGpp` + the silent fill of an EMPTY tcToolkit.compiler.gppPath
                        (Global; never overwrites), run when the g++ build is turned on. The VS Code
                        half of gpp
    cppToolsCommands    R13: registers cppToolsProvider with Microsoft's C/C++ extension when it is
                        installed (now or later: extensions.onDidChange), via `vscode-cpptools`
                        getCppToolsApi(Version.v7); the g++ it names is resolveGpp's, re-resolved and
                        re-announced (didChangeCustomConfiguration + …BrowseConfiguration) when
                        tcToolkit.compiler.gppPath changes or a CPP_Files .cpp/.hpp is created;
                        createProviderPrompt: the once-per-folder "Use TC Toolkit" offer
                        (workspaceState `tcToolkit.cppProviderPrompt:<folder uri>`); the
                        "TC Toolkit C/C++" output channel logging each request of the C/C++ extension
    xaeShellCommands    `twincat.detectXaeShell` + the silent activation-time fill of the two
                        `tcToolkit.xaeShell.path*` settings (EMPTY ones only, ConfigurationTarget.Global;
                        never overwrites). The VS Code half of xaeShellDetect
    xaeBuildCommands    R14 Build through XAE: `twincat.xaeBuild`, `twincat.xaeBuildAndActivate`,
                        `twincat.xaeShowTargets`, internal `twincat.xaeBuild.goToProblem`. Spawns
                        resources/xae/build-plc-project.ps1 through runChild (onStdout → xaeBuild's
                        splitter/reducer), the output channel `TC Toolkit XAE Build` (requested UI mode,
                        then the mode read back from DTE), DiagnosticCollection `twincat-xae` (source
                        "TC Toolkit XAE build"), pane markers via provider.setCompileSource(…, 'xae'),
                        status bar, context key `twincat.xaeRunning`, one run at a time; the shell check
                        (one question at most: the other-shell modal for a build, else the driver's
                        progid-not-registered fatal is the fallback); the target pick +
                        modal for activation; cancel file → grace → force stop (PowerShell tree + only an
                        `ours` shell PID), never in activate/restart/verify; timeout; the headless stall
                        offer; `setXaeOption` for the dropdowns. Reuses compileCommands' exported
                        problemDiagnostic / openProblem / pickProjectKey
  checkUnit             Compile Project's check unit: one ST unit per TwinCAT object with a per-LINE
                        origin map back to component/pane/line. Pane text verbatim (never the export's
                        rewrites), members BEFORE the POU body. NOT the live path's unit. vscode-free
  compileCheck          Compile Project's vscode-free half: setup check (the bundled compiler
                        resources/compiler/compiler.cjs unless tcToolkit.compiler.path overrides it;
                        Node >= 22 FOUND by nodeCandidates/findNode), check inputs from object texts, the compiler run as a CHILD
                        PROCESS (`--check --json --dialect-file resources/dialects/twincat3.json`,
                        `--pragma-define` per project compiler define, `--file-define N.st=…` per
                        per-object define, `--global-list N.st=<GVL>` per GVL; never
                        `require()`d, never `--strict`) in
                        a temp dir deleted afterwards, timeout + cancel, JSON report → file/component/
                        pane/line, the pragma-warning filter (counted), the library filter (counted;
                        messages on the generated declarations kept apart), paneRange. Spawn injected.
                        runChild takes optional onStdout/onStderr chunk callbacks (R14 streams events)
  cppGenerate           R13 C++ generation, vscode-free: the compiler's COMPILE mode (`-o <stem>.cpp`, a
                        second run after the check — `--json` exists only with `--check`) in a temp dir;
                        `<project dir>/CPP_Files/<stem>.cpp|.hpp` written under an ownership record
                        (`.tc-toolkit-generated.json`: file → project + SHA-256). Only an owned file
                        that is unchanged is replaced or deleted; a project's leftovers (renamed
                        project, stale .o) are deleted; foreign/edited files are refused and reported.
                        Library coverage: what the C++ does not cover per library (empty-bodied
                        library blocks), as summary sentence, channel lines and a header comment
  cppSettings           R13 switches `tcToolkit.compiler.generateCpp` / `buildWithGpp` (default off):
                        effective values (build ⇒ generate), per-scope coupling after a change made
                        elsewhere, the writes a dropdown checkbox makes. Pure
  gpp                   R13 g++ build, vscode-free: detection (PATH, then each MSYS2 root's
                        ucrt64/mingw64/clang64 (msys2Detect), C:\MinGW, mingw64 under Program Files /
                        WinLibs / w64devkit, Chocolatey mingw, last each MSYS2 root's usr\bin; repeats
                        dropped case-blind; `msys2Root` when MSYS2 has no g++),
                        tcToolkit.compiler.gppPath resolution, `-std=c++17 -fno-strict-aliasing
                        -c <cpp> -I <resources/compiler/include> -I <CPP_Files> -o <obj>`, reading g++ messages and placing them on the generated files, runGpp
                        (no shell, timeout, cancel, g++'s folder first on PATH); describeGppSetting
                        (what the start page shows) and thisMachine (the real fs/env checks and the
                        version reader); the g++ version gate (GPP_MIN_MAJOR 7, gppVersionOf cached
                        per path+size+mtime, detection prefers a g++ 7+)
  cppToolsProvider      R13 C/C++ extension custom configuration provider, vscode-free: answers only for
                        `.cpp`/`.hpp` directly in `<PLC project>/CPP_Files/` (a project the map knows,
                        or a folder beside a `.plcproj`; name case-insensitive on Windows only) with
                        includePath [resources/compiler/include, that CPP_Files], c++17, and — when a
                        g++ is in use — compilerPath + `<os>-gcc-<arch>` intelliSenseMode; browse
                        config = the headers + existing CPP_Files folders. connectCppTools: nothing
                        at all when ms-vscode.cpptools is absent; writes no file
  cppToolsSelection     R13, vscode-free: whether the C/C++ extension will consult TC Toolkit for a
                        folder — JSONC c_cpp_properties.json (config named Win32/Mac/Linux exactly,
                        else the last; absent/`${default}` → C_Cpp.default.configurationProvider;
                        `""` → no provider, no fallback), providerSelection → none/setting/file;
                        ids compared exactly (display name accepted in the file only); another
                        configuration naming another provider → file
  compilerDefines       Compile Project's compiler defines: `<CompilerDefines>` of the project's
                        `.plcproj` → `--pragma-define` arguments (values exact), per-object ones
                        in `<Compile>` items → `--file-define <unit>=…` for that object's check
                        unit (MSBuild `Condition`s evaluated for Debug|TwinCAT RT (x64)), with a
                        note per entry not used as written. vscode-free
  libraryDecls          Compile Project's library declarations (R3.4): reads the project's library
                        knowledge from THIS machine (signatures dump, .tmc, archive names, .plcproj
                        namespaces — through lsp/libsymbols, libraries, parseCache), writes
                        interface-only ST declarations of the referenced library symbols as extra
                        compiler inputs (strings; runCheck's temp dir is the only place they are ever
                        files), blanks library namespace qualifiers column-stably, and builds the
                        filter for undeclared-library-symbol errors. vscode-free. See "Library
                        declarations" under Compile Project below
  projectTemplate       Create a NEW TwinCAT solution from a shipped template (roadmap R2): copy,
                        rename solution/system/PLC project (`<Name>`, `<Name>_PLC`), re-issue every
                        identity GUID consistently, keep every byte else. vscode-free, unit-tested.
                        See "Project templates" below
  settingsMigration     The one-time move from the old `twincat.*` setting keys to `tcToolkit.*`, run
                        un-awaited at the top of activate(): per key and per scope holding an OLD value
                        (User, Workspace, each folder) copy it to the new key unless that scope already
                        has one, then remove the old value; a failed copy keeps the old value so the
                        next activation retries. Never rejects (failures go to console.warn). The XAE
                        Shell auto-fill waits for it, so a detected path never shadows a moved one.
                        vscode-light (config injected)
  startPage             The start page: a singleton webview panel (+ serializer) whose messages map
                        onto the twincat.* commands; command allow-list; links leave via openExternal.
                        Its `state` message also carries the recent-list length
                        (tcToolkit.startPage.recentProjectsShown), the two XAE Shell paths with
                        whether each exists, and `gpp` (gpp.describeGppSetting: set / invalid +
                        reason / detected + source / notFound; read-only, never writes the setting);
                        `openSettings {section}` opens an allow-listed section (`gpp` in the User
                        settings via `twincat.openSettings(query, {target: 'user'})` →
                        workbench.action.openGlobalSettings, as the setting is machine-scoped)
  startPageHtml         The start page's HTML (pure; strict CSP, no remote loads) — the browser
                        harness renders this same function
  recentProjects        Recent TwinCAT solutions for the start page (pure list logic + a globalState
                        adapter): newest first, max 10, case-insensitive on Windows paths, pruned on read;
                        `recentsShownLimit` clamps the shown-rows setting to 1..10 (default 2)
  xaeShell              XAE shell discovery + the library-signature generator (the one non-offline path).
                        A configured tcToolkit.xaeShell.path4026 (64-bit) / path4024 (32-bit) that exists
                        wins for its shell; otherwise default location, then the COM registration
  msys2Detect           R13 where MSYS2 is installed (Windows), for g++ detection: the uninstall
                        registry (HKCU/HKLM + WOW6432Node, `reg query <key> /s /f MSYS2 /d`, then
                        the entries whose DisplayName starts with MSYS2: InstallLocation, else the
                        UninstallString folder), then C:\msys64, D:\msys64, C:\tools\msys64,
                        %USERPROFILE%\msys64, Scoop. The registry search is async and runs once per
                        session (createMsys2RootCache; extension.js starts it, not awaited, and redraws
                        the start page when it finds a root); gpp.thisMachine() carries what it has
                        found so far. *Detect g++*, the silent fill and the g++ build wait for it
                        (msys2RootsWithin, MSYS2_REGISTRY_WAIT_MS = 2 x 3 s + 1.5 s: longer than its two
                        reg.exe phases); *Detect g++* writes a g++ < 7 only once the search has settled
                        (cache.settled()); the C/C++ provider resolves g++ again when it settles with a
                        root. findMsys2WithoutGpp: an MSYS2 root with no g++ in any environment.
                        Reuses xaeShellDetect's reg.exe runner (createRegRunner: no shell, 3 s timeout)
  xaeBuild              R14 Build through XAE, vscode-free: the driver argv (`-ShowWindow` only for
                        showWindow === true, `-TcVersion <ProgId> -AllowVersionMismatch` only for a
                        confirmed `shellOverride` on a build, activation only with a valid NetId),
                        missingShell (the other-shell offer and the install text),
                        the JSON-lines splitter/parser (`@@TCTK ` prefix, v 1), the run-state reducer,
                        describeExit (the exit code decides) / describeUiMode (the DTE readback),
                        canCancel / isStalled, the target pick and the confirmation text
  xaeBuildSettings      R14 `tcToolkit.xaeBuild.*` with defaults and clamps (showWindow false,
                        Release, TwinCAT RT (x64), timeout 5-240 min, stall 2-60 min). Pure
  xaeErrorPlacement     R14 where an XAE ErrorItem goes: the object file (absolute or .sln-relative),
                        its line as pane line (default) or whole-unit line (raw lineMap), exact only with
                        a section marker, else "(location approximate)"; unplaceable → general. Pure
  xaeShellDetect        Where the XAE Shell of 3.1.4024 / 3.1.4026 is installed, for the
                        tcToolkit.xaeShell.path* settings: COM registration (ProgID → CLSID →
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
  objectsTreeModel      The "PLC Objects" tree as a vscode-free node graph: shape rule (solutions →
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
                        failures reported per file). `applyAsOne(commit)` writes everything in ONE
                        caller step (the rename's single WorkspaceEdit) and restores what landed if
                        that step fails. Injected read/write, vscode-free, so testable
  plcProjText           Rename: the in-place `.plcproj` Include rewrite for a renamed file or directory
                        (keeps the entry's place and children, e.g. <LinkAlways>; vscode-free, testable)
  treeDragAndDrop       Objects-tree drag & drop controller — executes the matrix's plans (needs VS Code 1.66+)
  libraryTreeProvider   "PLC Libraries" explorer tree (library → types → members). Scopes to the
                        ACTIVE file's project (revealUri → setActiveFile; refetches only when the
                        owning project changes) and says so in the view description (2+ projects
                        only); union of all projects when nothing owns the active file. The scope
                        decisions are exported pure helpers, pinned by test_library_scope.js
  referencesProvider    "PLC References" results view (+ referencesTree grouping)
  objectKinds           Kind → codicon → tooltip for the Objects tree (vscode-free, so it is testable);
                        also owns the property row's contextValue (`propertyNode[.noGet][.noSet]`,
                        naming the MISSING accessors) and `isPropertyNode` — test property rows with
                        it in code and `viewItem =~ /^propertyNode\b/` in menus, never `== 'propertyNode'`
  stComments            The Node-side ST comment scanner (`blockCommentEnd`, `blankComments`): NESTED
                        `(* (* *) *)` comments as TwinCAT documents them, non-nesting slash-star, `//`,
                        strings recognised so a `(*` inside one is text. Used by every helper that blanks
                        comments before a keyword regex (objectKinds, xmlIndexer's DUT/enum readers,
                        checkUnit/stConverter's POU keyword, libraryDecls). The lexer, stFolding.js, the
                        Monarch tokenizer and the TextMate grammar implement the same rules on their
                        own (none can require it); test_nested_comments.js keeps all of them in step
  insertTemplates       Call/usage templates + parameter ordering, shared by the Libraries AND Objects
                        insert commands so both produce identical text (vscode-free, so testable)
  indexInputs           Which watcher events (`*.tmc`, `library-signatures.xml`) re-index, and the
                        own-write gate for Update Library Definitions (vscode-free, so testable)
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
    workspaceScan.js    One symbol index per PLC project + the request-routing API. Plans a scan as one
                        task per index (`planWorkspaceScan`); `scanWorkspace` runs them in one pass,
                        `startWorkspaceScan` one project at a time in the background with a per-index
                        readiness gate (`readyFor`/`readyAll`). Kept out of server.js on purpose:
                        server.js opens an IPC connection at require time, so nothing that requires it
                        is loadable by a standalone harness — the connection is injected here as
                        log/error callbacks instead.
    workspaceState.js   Which workspace answers while scans come and go (R6): `settledFor(uri)` /
                        `settledAll()` resolve with the CURRENT workspace once the index a request
                        reads is complete; a superseded scan's waiters move to the new one; a failed
                        scan falls back to the last complete workspace.
    requestPipeline.js  The request router (withDocument makes the pre-handler document sync
                        structural; withoutDocument is the EXPLICIT no-sync variant) and the
                        library-index stage table (LIBRARY_INDEX_STAGES, order validated at module
                        load; stage runners injected by server.js). IPC-free — the third instance
                        of the same harness-loadability injection pattern as scanController.js.
    libraryIndex.js     The per-project library composition (`createIndexLibraries`): namespaces,
                        archives, .tmc, signatures (project dir + every workspace root), browsercache,
                        run through the stage table. Moved out of server.js so the harnesses and
                        scripts/measure-indexing.js drive the code the server runs, not a copy.
    scanController.js   Decides WHEN to scan, separately from how. custom/reindex = "rebuild
                        unconditionally"; custom/indexReady = "resolve once these roots are indexed"
                        (JOINS a scan of the same roots in flight). Only the latest scan records
                        completion. Outside server.js for the same harness reason; the scan is injected.
    parseCache.js       library-signatures.xml + browsercache parses, cached on (path, size, mtime).
                        Signature records are CLONED per project — see the warning in its header.
                        `readOnlyParse` / `signatureLibrariesFor` are shared, DEEP-FROZEN parses for
                        readers that build fresh objects from them (libraryDecls.js: the dump's
                        libraries, each .tmc's declaration model).
    archiveStore.js     The PERSISTED archive-name cache (R6): decoded library symbol names kept across
                        sessions in the extension's global storage (`initializationOptions
                        .archiveCacheDir`, set by extension.js). Same content key as the in-memory
                        cache; an entry is used only when the decoder id, the key and the archive's
                        ZIP central-directory fingerprint (read from the file now) all match. Corrupt,
                        partial or foreign files are ignored; bounded (entries, name characters, LRU).
    plcprojRefs.js      One shared, cached .plcproj read (library references + namespaces). The same
                        file used to be read three times per project per scan.
    log.js              Structured, quiet-by-default logging for the LSP process (threshold `warn`,
                        TWINCAT_LSP_LOG=debug to opt in; stderr, one line per record; never throws;
                        below-threshold calls cost one comparison). The request handlers still return
                        their safe defaults on failure — the logger is what makes a default
                        explicable. Routine healthy-project conditions belong at debug, never warn
    parser.js           Structured Text lexer + symbol parser
    symbolNode.js       Single factory for a symbol node's core shape (parser + xmlIndexer build through it)
    features.js         Facade re-exporting features/{core,completions,definition,references,configReferences,highlights,hover,diagnostics}
    features/hover.js   Pragma hover: category summary (this project's own words), syntax form, Infosys
                        link. Reads the document only — no index, so it never waits for a scan
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
    conditionals.js     Conditional pragmas ({IF}/{ELSIF}/{ELSE}/{END_IF}): groups per segment, branch
                        selections for block matching, suppression spans — see "Conditional pragmas"
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
                        size + SHA-256 per file), include/*.hpp (the fork's src/runtime/include, R13:
                        what the g++ build compiles against; GPL-3.0-only WITH the runtime library
                        exception per the fork's COPYING). Ships in the VSIX
  xae/build-plc-project.ps1  R14's driver: an ADDITIVE copy of scripts/Build PLC project/
                        build_plc_project.ps1 (-Json, -ShowWindow, -ListTargets, -CancelFile; exit 4).
                        Ships in the VSIX; hand-synced with the builder (see "XAE build (R14)")
scripts/
  vendor-compiler.js    Copies a BUILT, clean fork checkout into resources/compiler/ and records its
                        commit. Dev-only, .vscodeignored
  build-project-templates.js  Derives resources/templates/tc3.1.40xx/ from the XAE skeletons;
                        `--check` exits 1 when the committed copies are stale. .vscodeignored
  glyphRaster.js        The renderer behind both images: TrueType outline reader, scanline rasterizer,
                        hand-rolled PNG encoder, and drawMark (the logo itself, so both draw the SAME
                        mark). Reads Segoe UI from C:/Windows/Fonts; only the pixels are committed.
                        Dev-only, .vscodeignored, not in the typecheck graph.
  measure-indexing.js   Timing harness for the workspace scan: builds an N-project copy of the sample
                        (synthetic archives, noise directories, a root signatures dump) in a temp dir
                        and times the real scan in fresh processes — cold, warm (second session) and
                        per-project ready time. Measures, never gates; not in `npm test`. Dev-only,
                        .vscodeignored. `--samples` times the committed sample/ as-is.
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
   triggers `custom/reindex` and the Libraries refresh. (The other watcher path that re-indexes is not
   project structure: a `*.tmc` or `library-signatures.xml` event, see "Index inputs" below.)

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
- **`src/lsp/workspaceScan.js`** builds one index per project (`scanWorkspace`, or `startWorkspaceScan`
  in the server — see "The background scan" below) and wraps the
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
   Since the scan runs in the background, an `indexReady` that arrives mid-scan **joins** that scan
   rather than starting another, and only the latest scan records completion (`test_scan_readiness.js`).
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
   proves too weak *in memory*, the hardening is the ZIP central-directory fingerprint the persisted
   cache already uses (below) — a genuine content hash for one small read at the file's end.

**Decoded names persist across sessions** (R6, `src/lsp/archiveStore.js`). The extension passes its
global storage path as `initializationOptions.archiveCacheDir`; `harvestArchiveFile` consults the
store after both in-memory caches miss, and `rescan()` flushes it after every scan (and on shutdown).
It stores only what the in-memory cache holds — the identifier-shaped names — under the same content
key, so the cross-project dedup carries over (eight vendored copies are one entry). **It never trusts
a stale entry:** use requires the file's `decoder` id to equal libsymbols.js `DECODER_ID` (a hash of
the ZIP reader's and string-table parser's *source*, so a decoder change discards old names with no
version to forget), the content key to match, and the archive's central-directory fingerprint (SHA-1
over the CD + EOCD, read from the file *now*; the CD carries every entry's CRC-32) to equal the stored
one. A corrupt, truncated, foreign or other-version file is ignored and rewritten; a malformed entry is
dropped alone; writes are temp-file + rename. Bounded at 4,000 entries / 40 M name characters, least
recently used first. Measured with `scripts/measure-indexing.js --drop-caches` (8 projects, 48
distinct archives of ~1.6 MB): cold 1,711 ms → warm 1,203 ms; the archive stage 1,212 → 625 ms. What
remains warm is filing the names into each project's registry, which no decode cache removes.
4. **`SKIP_DIRS` must never gain `_libraries`.** `collectArchives` walks it; excluding it there finds
   zero archives and costs ~171 false positives. `PROJECT_SKIP_DIRS` is the excluding set, for the
   `.tmc`/signature/`.plcproj` walkers only. `test_collect_scope.js` proves both halves.

**Signature and `.tmc` discovery is memoized per scan** (R6). Every project of a scan walks the
workspace roots for `library-signatures.xml` (it sits above every project) plus its own directory for
the dump and the `.tmc`: 16 full walks per scan on 8 projects, ~850 ms on Windows. `scanWorkspace` now
creates one `createDirectoryListingMemo()` (`src/twincatWorkspace.js`) per scan and hands it to every
project's `indexLibraries`; `walkFiles` replays a directory it has already read. Measured with
`scripts/measure-indexing.js` (8 projects): readdir calls per scan 9,282 → 3,771, the signature/`.tmc`
walks 5,000 → 333 (one root walk). **Invalidation is the scan boundary and nothing else:** the memo
dies with its scan, so an added or removed dump or `.tmc` is found by the next scan (startup, or the
`custom/reindex` the `.plcproj` watcher and Update Library Definitions send) exactly as before. No
directory-mtime guard — a file added two levels down does not change the project directory's mtime.
`test_discovery_memo.js` pins it.

**Index inputs (`src/indexInputs.js`).** Because the memo makes the scan boundary the only
invalidation, the host's workspace watcher sends a `custom/reindex` when a `*.tmc` (a TwinCAT build) or
`library-signatures.xml` is created, changed or deleted outside the walkers' `PROJECT_SKIP_DIRS`
(`isIndexInputFile`). Events go through a 1.5 s debouncer that feeds the `.plcproj` 400 ms debouncer, so
one build rewriting every project's `.tmc` plus a `.plcproj` costs one scan. Update Library Definitions
writes the dump and sends its own reindex inside `createOwnWriteGate().run(...)`; the watcher ignores
events while it runs and for a 2 s grace period after, so our own write never scans twice.
`test_index_inputs.js` pins the matching, the gate and the wiring.

**The background scan (R6).** The scan used to be one synchronous pass: the server's event loop stopped
for its whole duration and every request queued unread until the finished workspace replaced the old one
in a single assignment. It now runs **one project at a time with the loop free in between**, and the
guarantee that made the old design safe — no request ever sees a half-built index — is kept by a
readiness gate per index:

- `planWorkspaceScan` (workspaceScan.js) turns a scan into **one task per index**, and a task holds
  everything that index receives: its objects, its libraries, and the loose `.st` files routed to it
  (collected up front by the same walk; a `.st` under no project still goes to every project, last, as
  before). Once a task has run, nothing writes to that index for the rest of the scan. Tasks share only
  content caches, so order cannot change an index — `test_scan_readiness.js` compares each background
  index with the one-pass `scanWorkspace` index.
- `startWorkspaceScan` yields before the first task (so `initialize` answers at once) and between tasks,
  opens a project's gate when its task ends, and moves a project someone is waiting for to the front.
  A file under no project, and the union catalog, wait for the whole scan.
- `workspaceState.js` owns "the current workspace". **Every server handler that reads an index first
  awaits `settledFor(uri)` / `settledAll()` (server.js `whenIndexed`), then reads `currentWorkspace()`
  with no await in between** — that pairing is the gate; a new handler that reads an index without it
  is the bug this design exists to prevent. A reindex replaces the workspace at once and cancels the old
  scan; its waiters move to the new workspace (as a request queued behind the old synchronous scan
  would have got the new index). A scan that throws reverts to the last complete workspace before any
  waiter wakes.
- `scanController.js` joins: an `ensureScanned` for roots already being scanned awaits that scan, and
  only the latest scan records completion — the "latent" double-scan hazard of an async scan.

Measured with `scripts/measure-indexing.js --drop-caches` on 8 synthetic projects: the first project
answers at ~540 ms cold / ~350 ms warm, against ~1,480 ms for any answer before R6 (the whole scan);
a request for the last-discovered project at startup is answered at the same ~540 ms because it jumps
the queue. The first task costs most: it decodes the shared vendor archives every later project reuses.
`test_server_ipc.js` runs the real server over IPC: requests sent during the startup scan and right
after a reindex return zero diagnostics on the sample (the control shows a partial index does not).
The progress indicator still lives in the **extension host** and is still indeterminate ("TC Toolkit:
indexing…", no `3 of 8`): the server does not report per-project progress to the host yet.

Three processes cooperate, with the extension host as the hub — **the webview never talks to the
language server directly**. The extension bridges them over custom JSON-RPC requests
(`custom/completions`, `custom/definition`, `custom/references`, `custom/referencesForSymbol`,
`custom/configReferencesForSymbol`, `custom/diagnostics`, `custom/hover`, …) layered on the standard LSP transport
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

**Hover.** `src/lsp/features/hover.js` answers both the standard `textDocument/hover` (loose `.st`
files) and the webview's `custom/hover` (Monaco hover provider → host `twincat.lsp.queryHover` →
`mapHoverToLocal`). The text is built from the catalogue: a category summary written for this project,
the syntax form and the Infosys link. **No description text is taken from Beckhoff's documentation** —
the catalogue holds names, syntax forms and page ids only, and `test_pragma_hover.js` fails if an entry
grows any other field. The webview skips the round trip for a line with no `{`, and hands a clicked link
to the host (`openDocumentationLink`), which opens it only if `isDocumentationUrl` says it is a catalogue
page.

### Conditional pragmas in the language server (R12)

`src/lsp/conditionals.js`. TwinCAT compiles one branch of each `{IF}` / `{ELSIF}` / `{ELSE}` / `{END_IF}`
group, picked by defines the LSP cannot all know (the `.plcproj` `<CompilerDefines>`, per-object defines, the
build configuration, `{define}` in the code). So **the LSP never evaluates a condition**: every branch
combination is possible, and a diagnostic is raised only when it holds under every one. Nothing here reads
the `.plcproj`, and the live path (`stConverter` raw output, `assembleSt`, the lineMap) is untouched — no
token is ever removed, so every range stays exact.

- **Annotation.** `tokenize()` sets a flag when it lexes a directive pragma (comments and strings are lexed
  first, so a directive inside one is never seen) and only then calls `annotateConditionals()`; a unit
  without one gets no extra work and byte-identical output. Each token inside a group carries
  `cond = { group, branch }` (innermost), directive pragmas carry `condDirective`, and
  `tokens.conditionals` holds the groups and **segments**. `{define}`/`{undefine}` stay plain pragmas.
- **Segments.** A boundary is a METHOD/PROPERTY/ACTION/GET/SET or END_METHOD/…/END_INTERFACE keyword that
  is the **first code token on its line**, outside parentheses, not after a `.`, and not followed by
  `:=`/`=>`/`,`/`)`/`.`/`(`/`;` — the raw unit's wrapper lines and the user's own method heads, never
  `fbRS.SET := TRUE` and never a named argument on its own line (`fbRS(\n\tSET := c,\n\tRESET1 := FALSE);`).
  A wrong boundary splits one block across two segments, which is a false positive outside any group the
  moment the unit holds a directive. Groups never cross one. A segment is **unbalanced** on a directive with no
  open group, `{ELSIF}` after `{ELSE}`, a second `{ELSE}`, or a group still open at its end (a half-typed
  `{IF`); every token in it then counts as conditional and nothing is reported from it. Re-exposing a
  branch is how the false positives come back, so unbalanced is never "ignore the directive".
- **Block matching** (`features/diagnostics.js` `structuralDiagnostics` → `matchBlocks`). No groups in
  the unit: one pass over the whole unit, exactly as before. Otherwise per segment: no group → matched
  alone; groups → `blockSelections` drops *neutral* groups (each branch balanced on its own), enumerates
  one branch per remaining group (plus an implicit empty branch without `{ELSE}`; nested groups only
  inside their parent's chosen branch), and keeps a diagnostic only if **every** selection has it at the
  same place with the same message. One anchored inside a group is moved to the group's outermost `{IF}`
  first, so an IF that every branch opens and nothing closes is still reported once. Above **64**
  selections the segment reports nothing structural (`log.debug('conditional-selection-cap')`).
- **Semantic checks** (undeclared, member access, call arguments, declaration types, assignments) run
  unchanged, then every diagnostic starting inside a group's **suppression span** is dropped. The span
  runs from the group's `{IF}` to its `{END_IF}`, widened back to the statement start and — when a branch
  ends mid-statement (`x := {IF a}1{ELSE}2{END_IF};`) — forward through the next `;`. A branch ending in
  a nested group's `{END_IF}` is resolved through that group's own branches, so a statement-level nested
  group does not swallow the statement after it. Code outside groups
  keeps every check; declarations from all branches stay in the index, so a branch-only name used outside
  a group is never "undeclared".
- **Declarations** (`parseVariablesBlock`): a variable is `conditional` when its name sits in a group, a
  directive sits in its type/initialiser (`typeConditional`), or its section header does
  (`scopeUncertain`). `types.pickVar` replaces `variables.find` in `lookupMember`/`resolveSymbolType`: a
  conditional name whose branch declarations differ in type (initialisers ignored) resolves to
  `AMBIGUOUS` → unknown, so nothing is flagged on it inside or outside a group. `paramSetFromVars` returns
  null when any variable is `scopeUncertain` (the call check is skipped).
- **Inheritance.** A directive in a POU/DUT head that precedes head content (the name, EXTENDS/IMPLEMENTS,
  a parent/interface name, a modifier) sets `inheritanceUncertain` in both indexers (`headHasDirective`);
  one directly before the first VAR block (a wrapped declaration block) does not, so the POU keeps its
  undeclared check. When set: `walkExtendsChain` reports the chain unresolved (the existing
  "suppress undeclared" path), `lookupMember`/`findMethodOwnerInChain`/`collectParams` treat it as an
  unknown ancestor, and `isRelatedAssignable` accepts it.
- **Enum members** in a group are all kept, in both indexers: `extractEnumMembers` (xmlIndexer) blanks
  pragmas before looking for the list's `)` and commas, and the inline-enum scan (parser) skips pragma tokens.
- **Other features** emit no diagnostics, so they need nothing: completion offers the union of the
  branches, references/highlights/rename cover every branch (a rename must reach all of them, or flipping
  a define breaks the build), definition goes to the first declaration, hover keeps the pragma help.
- **Accepted trade-offs:** a real error inside a branch is not reported; the lexer still reads inactive
  branch text, so an unclosed `(*` or `'` in one branch swallows what follows (direction: fewer
  diagnostics). A future duplicate-declaration check must accept the same name in different branches of
  one group (a note in `diagnostics.js` says so). Informational branch state (evaluating the defines for a
  hover on `{IF}` and greying inactive branches) is Backlog item R12b and must never feed diagnostics.

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
   counted; so are errors the library filter drops (below); nothing else is.
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
the override `tcToolkit.compiler.path` names — and a project is open (`state.compilerReady` +
`hasProject`); only a missing override (or a damaged install) disables it, with "Compiler file not
found". A missing Node is not known to the tile: the command explains it on click. A change to
`tcToolkit.compiler.*` re-posts the page's state. Results live in memory only (problem-link ids included) — a compile result describes
one moment.

**Compiler defines (`src/compilerDefines.js`, VS Code-free).** Before each run the command reads the
project's `.plcproj` (the open document if it is open) for `<CompilerDefines>` in a `<PropertyGroup>`
(a comma-separated list of `NAME` / `NAME := 'value'`; `<CompilerDefines />` or whitespace = none;
several = MSBuild last-wins with `$(CompilerDefines)` expanded; a `Condition` on the group or on the element
is evaluated by `evaluateCondition` for `CHECK_CONFIGURATION` — Debug, `TwinCAT RT (x64)` (user decision
2026-11-11; one constant so a setting can change it later): `'$(Configuration)|$(Platform)' == '…'`, `==`/`!=`
case-insensitive (numbers by value, then booleans: `'on' == 'true'`), `And`/`Or`/`!`/parentheses, bare
`true`/`false`, an empty condition (true, as in MSBuild); other `$(Prop)` from the groups applied before it, else
`''` — except properties MSBuild sets outside the file (`MSBuild*`, `Solution*`, `ProjectDir`, …), which are
unreadable. True → applied in document order; false → skipped silently (a Release group is normal); unreadable
or undecidable (`Exists(...)`, property functions, `<`/`>`) → left out with a note, and every property that group
or element sets becomes unreadable, so a later condition on it is undecided (noted) rather than guessed. A
self-closing `<PropertyGroup … />` (XAE writes them) has no body. `$(Prop)` inside a `<CompilerDefines>` value
expands the same way; a value using an unreadable property is left out with a note.
Real spellings, checked on public GitHub `.plcproj` files: XAE writes `" '$(Configuration)' == 'Debug' "` /
`'Release'` groups (no `$(Platform)` form was found in any public `.plcproj`) and
`<Configuration Condition=" '$(Configuration)' == '' ">Debug</Configuration>` defaults, which never override
the check configuration. `defineArgs` turns the project defines into `--pragma-define NAME` /
`--pragma-define NAME=value` right after `--dialect-file` (`buildCheckArgs`'s `defineArgs`): a pragma define is
seen by `defined()`, `hasvalue()` and `project_defined()` and is **never a global constant**, so a numeric value
is passed exactly and a `VAR_GLOBAL CONSTANT` of the same name still compiles (`-D NAME=4` would declare a
constant `NAME` too — the toolkit no longer uses `-D`). Names keep their case (the compiler's `defined()` is
case-sensitive). **Per-object defines:** a `<CompilerDefines>` inside an `<ItemGroup>` item (`<Compile
Include="POUs\FB_A.TcPOU">`) applies inside that object only, on top of the project's. `readCompilerDefines`
returns them as `objects` (the item group's, the item's and the element's `Condition` evaluated the same way;
several elements = last wins, `%(CompilerDefines)` = the item's value before), and `fileDefineArgs` maps each
`Include` to its check unit: the check builds **one unit per TwinCAT object** (`buildCheckInputs`: `1.st`,
`2.st` … in `project.objectFiles` order), so the `Include` is resolved against the `.plcproj`'s folder,
compared with `normalizeProjectPath` (as the project map built `objectFiles`) to each input's `filePath`, and
passed as `--file-define <N.st>=NAME[=value]`. In the compiler a file define is seen by `defined()` and
`hasvalue()` in that file only (over a project define of the same name), not by `project_defined()`. An item
that matches no unit (an object the check does not compile, such as a task, or a missing file) gets a note.
Malformed entries are skipped; every skipped entry, undecidable condition and unmatched object goes to the
**`TC Toolkit Compile`** output channel (created on first use) and the summary counts them. The
language server ignores the defines (it never evaluates `{IF}`).

**Library declarations (R3.4, `src/libraryDecls.js`).** The compiler knows only the IEC standard
library, so before step 2's run `prepareLibraryCheck` adds what this machine knows about the project's
libraries. Decided by the user 2026-11-10: declarations plus a filter, **local-only** (Beckhoff licence
§4(3): licensed material must not reach third parties).
- **Sources** (a fresh symbol index — the language server's registries are not touched; the archive and
  dump parses come through the existing content-guarded caches): `library-signatures.xml` found under
  the project dir and every workspace root (parsed with `parseLibrarySignaturesXml`, which now keeps
  every function output); the project's `.tmc`, read by `parseTmcDeclarations` — only **library-owned**
  `<DataType>`s (`Namespace="…"` or `TcBaseType="true"` on the name: the project's own types, which a
  stale `.tmc` still lists, are skipped), interfaces (`TcPlcInterfaceType`) skipped, `<Comment>` cut
  before anything is read; archive string-table names; `.plcproj` namespaces.
- **Emitted**, one file per declaration (`lib-N.st`, before the units; a GVL gets `--global-list`):
  FUNCTION (inputs, further outputs, in-outs; the like-named output is the return type),
  FUNCTION_BLOCK (dump parameters, else the `.tmc`'s ItemType members; the `.tmc`'s other members as a
  `VAR` block — a derived block of the project may read an inherited variable — each only when its type
  resolves without pulling in another declaration; `.tmc` methods with parameters, properties from
  `__get`/`__set` accessors, actions — all bodiless; EXTENDS; inherited members not repeated), STRUCT (EXTENDS), enumeration (values and integer base from the `.tmc`; the dump's
  self-typed var lists), alias (`<BaseType>`), VAR_GLOBAL [CONSTANT] lists (dump constants are
  CONSTANT; numeric/boolean `.tmc` defaults only — never a string). **Selection**: the library symbols
  the units name (a GVL or enum also through a member), from the `.tmc` or a dump library the
  `.plcproj` references; then the types those need (from any dump library); then pruned to a closed
  set. An array bound or string length that names a library integer CONSTANT whose value the `.tmc`
  gives (`libraryConstants`: the dump marks it CONSTANT; plain, namespace- or list-qualified; not a name
  the project declares, not one two lists give different values) is written as that value
  (`ARRAY [0..cMax]` → `ARRAY [0..15]`). A type `readType` cannot read exactly (any other constant or an
  expression as a bound, a foreign qualifier, a type the compiler lacks: LTIME, PVOID, XINT …) drops the
  declaration (or just the method/property/field/global/variable), never guessed. **Never redeclared**: names in the bundled `.stlib`
  manifests (TON, R_TRIG, CONCAT …), conversion names, the elementary types, and every top-level name the
  project declares (POUs, types, GVLs, globals — the user's own wins).
- **Qualifiers**: `stripQualifiers` blanks `Ns.` (a `.plcproj` namespace, not a project name, not after
  a `.`, outside comments/strings) with spaces — the compiler cannot parse `p : Ns.T;` — so every column
  is unchanged and mapUnitPosition needs nothing new. The run gets copies of the units.
- **Filter** (`createLibraryFilter`, errors only, counted as `filteredLibraryDiagnostics` and shown in
  the summary): `Undeclared variable/function 'X'`, `Undefined type 'X'`, `'X' is not a constant`
  (array bound) — when X is a known library name the project does not declare; `'T' has no
  member/method 'X'` and `'X' is an internal variable of FUNCTION_BLOCK 'T'` (a library block's `VAR`
  read from outside: whether TwinCAT allows it is not decided here) only when T is a library FB/struct
  this run declared; `T has no input or output
  named X` only when T's parameters came from the `.tmc` alone; `'X' is not a variable of global
  variable list 'G'` only for a generated G; a `… got X` cascade only with X's dropped undefined-type
  error. The compiler's messages about the generated files are returned apart (`libraryMessages`) and
  noted, never placed on the user's code.
- **No dump**: the `.tmc` types and the archive names still work; the summary says once per session
  'Run "TC Toolkit: Update Library Definitions" to check calls into libraries too.'
- **Where it lives**: strings in memory, then files only inside runCheck's `mkdtemp` directory, deleted
  however the run ends (`test_library_decls.js` pins it). Tests use synthetic libraries only.
- **Known limits**: a POU that names a type with no declaration (an interface, an opaque dump type) is
  not checked past that point by the compiler (its undefined-type error is filtered); archive names
  include member and local names, so an undeclared variable that happens to share a name with anything
  in a referenced archive is filtered too.

**The editor toolbar's Compile button** (`#compile-btn`, after the Generate ST split button; an
inline-SVG glyph in the codicon style, since the webview is offline). A click posts **`compile-project`**;
the provider's `compileProjectFor(file)` runs `twincat.compileProject` with `{projectKey}` when exactly
one project `ownersOf` the file, else with no key (the command's own pick). Setup problems come from
the command, so the messages are the palette's. `compileCommands` calls `provider.setCompileRunning`
around each run; the provider posts **`compileRunning {running}`** to every open editor (and puts
`compileRunning` in `init`), and the button is disabled meanwhile. Layout: at <= 1100 px the action
buttons go compact and Compile drops to its glyph (name in the tooltip / `aria-label`); at <= 900 px the
header wraps into rows (it was 680 px, where the status pill already ran off the edge at 700 px).

**The bundled compiler (R3.3).** The compiler ships in `resources/compiler/`, so an empty
`tcToolkit.compiler.path` means `bundledCompilerPath()` (`resolveCompilerPath`); a set path is an
override. It is GPL-3.0 and is only ever run as a child process. The bundle loads every `.stlib` in the
`libs/` next to itself (`findBundledLibsDir` in the fork tries `../../libs` and `../libs` first — neither
exists in the extension); only the two IEC libraries ship, because the fork's others (OSCAT, softmotion,
extra FBs such as `PID`) are not TwinCAT's and would make names resolve that TwinCAT refuses.
`compile-real` pins both directions.

**Node discovery** (`nodeCandidates` → `findNode`, everything injected: `platform`, `env`, `runtime`,
`spawn`, `exists`). A set `tcToolkit.compiler.nodePath` is the ONLY candidate (a configured path that fails
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
The script also copies every `src/runtime/include/*.hpp` to `resources/compiler/include/` and writes
their licence into `SOURCE.md` (it refuses to vendor when the fork's `COPYING` no longer lists
`src/runtime/include/*.hpp` under the runtime library exception). Re-vendoring at the same commit is
byte-identical for the bundle and the libraries (checked for `eb52d2c`: the build is reproducible).

### C++ generation and the g++ build (roadmap R13)

Two switches, both **off by default**: `tcToolkit.compiler.generateCpp` and
`tcToolkit.compiler.buildWithGpp`; plus `tcToolkit.compiler.gppPath` (machine scope, like the XAE Shell
paths). User decisions 2026-11-12: output in the project directory, g++ optional with its own path
setting, separate switches, the build turning generation on.

**Run order** (`compileCommands` → `generateAndBuild`): the check runs as before; only when it finished
with **0 errors** and generation is on does the compiler run a **second time in compile mode**. Verified
against the vendored CLI (eb52d2c): `--json` is refused without `--check` ("--json is only valid with
--check") and `--check` refuses `-o`, and compile mode prints its diagnostics as text only — so one run
cannot both place JSON diagnostics and emit C++. The compile mode gets exactly the check's arguments
(dialect file, `--pragma-define`/`--file-define`, inputs with library qualifiers blanked, the library
declarations of `libraryDecls.js` with their `--global-list`s), plus `-o <stem>.cpp`, in its own temp
dir; the compiler derives `#include "<stem>.hpp"` from the output name. `<stem>` = the `.plcproj` file
stem (`cppFileStem` replaces anything outside `[A-Za-z0-9_.-]`). A failed generation shows the
compiler's first error line and puts its whole output in the *TC Toolkit Compile* channel.

**Library symbols** (user decision 2026-11-12, replacing the earlier "no C++ for a project that needs
library declarations"): a project that uses vendor-library symbols is generated and g++-checked like any
other. The compiler has no implementation of a library's blocks, so from the interface-only declarations
it emits **empty-bodied** C++ (`void FB_X::operator()() {}`, a method/function returning its
default-constructed result) — verified on a synthetic library: g++ compiles it with no warning
(`test_cpp_real.js` LIB). `cppGenerate.libraryCoverage` lists what the C++ therefore does not cover, per
library: `blocks` (function blocks/functions: empty bodies), `types`, `globalLists` (declared from the
interface; a constant whose value the sources do not give is 0), `substitutes` (a qualified name the
compiler provides itself, `Tc2_Standard.TON` → the compiler's TON) and `undeclared` (the uses the check's
library filter hid: no usable declaration). Sources: `prepareLibraryCheck`'s `declaredSymbols`,
`compilerSubstitutes` and `undeclaredUses(CheckResult.filteredLibrary)`. `undeclaredUses` names a member
through its owner (`FB_X.nVar`) and attributes it to the owner's library; a member the compiler reports
with no owner (a derived block reading an inherited variable: "Undeclared variable 'NVAR'") is looked up
among the library function blocks and lists — named through an owner only when exactly one (declared
ones first) has it, else attributed to their common library. Libraries are named as
the `.plcproj` references them (`libraryAttribution` in `libraryDecls.js`: the declaration's `.tmc`
`Namespace` or dump library, then the archives filed under a namespace → the catalog entry's Include
title; an unreferenced dump library keeps its title; else "library not identified"); names are given in
the library's spelling (`spellingOf`, since the compiler reports names upper-cased). It is shown three
ways: one sentence in the summary notification naming the libraries (`libraryCoverageText`; the run is
then a warning), the blocks per library in the *TC Toolkit Compile* channel (`libraryCoverageLines`), and
a line-comment block at the top of the `.cpp` and `.hpp` naming the empty-bodied blocks and the compiler
stand-ins (`libraryCoverageHeader` / `withCoverageHeader`, in the file's own line endings). The header is
part of the text whose hash the ownership record stores, so ownership is unaffected; its absence when no
library block is used keeps those files byte-identical to the compiler's output. The coverage lines go to
the channel only when C++ was written. A name in `undeclared` makes the compile mode fail (it cannot
compile a use of an undeclared symbol): the summary then says which symbols, with their libraries, have no
usable declaration, the channel lists only those (`libraryUndeclaredLines`, under "C++ could not be
generated"), and g++ is not run. What still lands here after the `.tmc` constants and `VAR` members: a
library symbol whose declaration needs a type this compiler lacks (LTIME, PVOID …), an opaque or
interface type, a `VAR` member of an unresolved type, and a library block's `VAR` read from outside.
**User decision 2026-11-12:** these keep blocking the C++ generation and the g++ check, each named with
its library in the summary — **no stand-in types** are emitted for them. Also decided that day: library
declarations may appear in the generated C++ in `CPP_Files` (the declaration-derived class/function
names and member layouts); the 2026-11-10 rule that the library declaration *ST files* stay in memory
(`libraryDecls.js` writes none) is unchanged. The `.gitignore` below keeps that C++ out of commits by
default.

**Ownership** (`cppGenerate.writeOwnedOutputs`): `CPP_Files/.tc-toolkit-generated.json`
(`{generator: "TC Toolkit", version: 1, files: {name: {project, sha256}}}`). `project` is the owner id
`cppOwnerId(<.plcproj text>, stem)` = `guid:<ProjectGuid>` (a rename keeps it), else the stem — NOT the
file stem alone, which a rename changes (that left the old pair and `.o` behind for good). `sha256` is
taken over the bytes with CRLF read as LF, so a `core.autocrlf` checkout of the toolkit's own files is not
an edit. On win32/darwin record names compare case-insensitively (`recordKey`), so a case-only rename
finds its old entry instead of calling the file `foreign`. A target that exists is
replaced only when it is recorded AND its hash matches (`owned`); otherwise it is left and reported
(`foreign` / `changed`). This project's recorded files that the run did not produce are deleted when
unchanged (a renamed project's pair, an object file from an earlier build) and dropped from the record
either way. The record is written in a `finally`, so a write that fails half-way (a locked `.hpp`) still
records the `.cpp` it already wrote — otherwise the next run refuses the toolkit's own file as `foreign`. A foreign file in the record's place stops the write. Entries with a path are ignored, so
the record can never delete outside its folder. g++ writes the `.o` itself: `claimOutput` deletes an
owned `.o` first (a failed build then leaves none) and refuses to run g++ over a foreign/changed one;
`recordOwnedFile` records it after a clean build. When any of the pair was refused, g++ is not run.

**`CPP_Files/.gitignore`** (user decision 2026-11-12; `cppGenerate.maintainGitignore`, called at the end
of every `writeOwnedOutputs`): the toolkit writes a `.gitignore` into the folder so its generated files
are not committed by accident. Text (`gitignoreText`): the comment line `GITIGNORE_COMMENT` ("Written by
TC Toolkit … you may delete this file"), then, sorted and anchored with `/`, every recorded file of
every project in the folder, the `.o` of every recorded `.cpp` (listed before g++ writes it, so a build
never rewrites the file) and the record itself; not the `.gitignore` (the user may commit it). **It lists
only files the toolkit holds as its own** (`gitignoreText(manifest, dir)` asks `ownership` per name): a
recorded file the user edited since (`changed`) is theirs now — refused by the write and dropped from the
list, so git sees it (the summary's "Left alone" note then adds "`.gitignore` does not list it, so git
sees it"; undoing the edit makes it owned and listed again) — and an object-file name already taken by a
file the toolkit did not write (`foreign`, e.g. the user's own `<project>.o` there before the first
run) is not listed; a name with no file yet is. The list is recomputed only when the toolkit writes the
folder, so a file edited after a run stays ignored until the next run. Its
ownership is the record's top-level `gitignore` key — `{sha256}` (same CRLF-insensitive hash), or
`{removed: true}` — never a `files` entry (one named `.gitignore` is ignored by `readManifest`, so
cleanup can never delete it as a project output). Rules: absent and never written → **created**;
recorded and unchanged → rewritten when the list changes (**updated**) else **unchanged**; recorded but
edited → **changed**, left alone; there but not recorded → **foreign**, never overwritten and not
adopted (unless it already holds exactly the wanted text); recorded and then **deleted** → the record
switches to `removed` and it is **never recreated** (**not-recreated**; a `.gitignore` the user makes
afterwards is foreign). A write failure is **failed** and does not stop the C++. Compile Project reports
it in the *TC Toolkit Compile* channel only (`gitignoreNote`: created, changed, foreign, not-recreated,
failed); it never makes the run a warning and is not in the summary. `claimOutput`/`recordOwnedFile` keep
the key (they go through `readManifest`/`writeManifest`). `test_cpp_real.js` checks it against a real
git (`git check-ignore -v`, `git status`, an edited `.cpp` not ignored and ignored again once restored, a
user's own `.o` not ignored) when git is on PATH.

**The g++ build**: `-std=c++17 -fno-strict-aliasing -fdiagnostics-color=never
-fmessage-length=0 -c <cpp> -I resources/compiler/include -I CPP_Files -o <obj>`, cwd `CPP_Files`, no
shell, 2-minute timeout, cancellable with the progress notification. A timeout or cancel stops the whole
process tree (`runChild`'s `killTree` → `compileCheck.killProcessTree`: POSIX spawns g++ `detached` and
SIGTERMs the group; Windows runs `taskkill /PID <pid> /T /F`) — a plain kill stops only the driver and
leaves `cc1plus` running. `-fno-strict-aliasing`: the fork's
docs/RUNTIME.md asks host builds of generated code for it. `-std=c++17`: the generated VAR_GLOBALs are
`inline` variables — g++ 7+ accepts them at C++14 only with one warning each, and g++ < 7 cannot compile
them at all (`'strucpp::X' declared as an 'inline' variable`). The earlier `-Wno-c++17-extensions` is a
GCC 12+ flag that older g++ reports as unrecognized; it is gone. Messages: `parseGppOutput` (one line per message, notes kept with the message
before them; the `required from here`/`required from '…'` chain and the `In file included from` chain —
remembered per header, since g++ prints it once — kept as `context`, `In instantiation of` as
`instantiation`) → `placeGppMessages` (in the `.cpp`/`.hpp`: at their line/column; anywhere else — a
runtime header, where the template runtime surfaces most errors — at the innermost `required from` point
in the generated files, else the innermost generated `#include`, else the `.cpp`'s line 1; the message
names the header and the instantiation) → DiagnosticCollection `twincat-gpp`, source
"TC Toolkit g++", notes as `relatedInformation`. g++'s folder is prepended to PATH for the child (MinGW
DLLs). A missing g++ (setting empty and nothing detected, or a setting that does not work) still writes the
C++; the run's ONE summary notification says so (`gppMissingText`) and carries *Open Setting*
(→ `tcToolkit.compiler.gppPath` in the User settings, `{target: 'user'}`: the setting is machine-scoped, as
is *Detect g++*'s own *Open Setting*), plus *Detect g++* only when the setting is empty (detection never
replaces a set value, so offering it for a bad value promised a fix it cannot make). The build and
*Detect g++* check a set value with the same `gpp.checkConfiguredGpp`, and decide "empty" with the same
`gpp.normalizeGppSetting` as the start page's row (a value of only quotes, `""`, is unset everywhere and
*Detect g++* fills it): quotes stripped, a bare name looked
up on PATH, a folder accepted when it holds `g++(.exe)`; its reason (`missing` / `not-on-path` /
`folder`) is what both messages name.

**The g++ version gate.** The generated C++ needs g++ 7+ (`GPP_MIN_MAJOR`): g++ 6 rejects the C++17
`inline` VAR_GLOBALs outright (and `[[maybe_unused]]` in the runtime headers). `queryGppVersion` asks
`-dumpfullversion` (g++ 7+), then `-dumpversion` (g++ 6 prints `6.3.0` there); a major below 7 is
confirmed with `--version`, because clang answers `-dumpversion` with the GCC 4.2.1 it imitates — clang
and anything unparseable are *unknown*, and unknown runs. `gppVersionOf` (spawnSync, 10 s timeout, g++'s
folder first on PATH) caches per path and re-asks when the file's size or mtime changes. The reader rides
on the machine object (`thisMachine().version`); without one (the older unit tests), results carry no
version fields. With it: `detectGpp` returns the first candidate that is 7+ or unknown, and a too-old one
(marked `tooOld`) only when nothing newer exists; `resolveGpp`/`describeGppSetting` add `version` and
`tooOld` for a set value too (never replaced). Compile Project does not run a `tooOld` g++: `cpp.gpp.status
= 'too-old'` with the g++'s `source`, one note in the summary (`gppTooOldNote`: the text plus
`gppInstallHint`, MSYS2 UCRT64 on Windows), status bar `· g++ too old`. Detection never replaces a set value,
so when the old g++ comes from the setting (`source === 'setting'`) the hint says to set a newer path or clear
the setting, and `gppTooOldButtons` offers only *Open Setting* (User tab); a detected one also gets *Detect g++*.
The explicit *Detect g++* fills an empty setting with a too-old g++ only when it is all there is, and says so as
a warning; the silent fill (`autoFill`, `fillTooOld: false`) leaves the setting empty then (status
`tooOldNotFilled`), so a g++ installed later is detected without clearing anything. For a kept too-old value
*Detect g++* runs detection anyway and names a newer g++ it finds (`newer`), without writing it. The start
page's row gets the warning style with "g++ 6.3.0 is too old: needs 7 or later." and, when detected, the note
"Not set: found on PATH, but a build will not use it."

**MSYS2 without g++** (user report 2026-11-12: MSYS2 installed, but detection found only `C:\MinGW` 6.3).
`src/msys2Detect.js` adds the uninstall registry and more usual roots to detection (see the file map). When
detection finds no g++ a build can use (none, or only a `tooOld` one) and an MSYS2 root exists
(`usr\bin\msys-2.0.dll` or `msys2.exe`) with no g++ in ucrt64/mingw64/clang64/usr, `describeGppSetting` and
`resolveGpp` add `msys2Root`, and the messages say "MSYS2 is installed at <root> but has no g++: in the MSYS2
UCRT64 shell run pacman -S mingw-w64-ucrt-x86_64-gcc": *Detect g++* (`describeGppFill`), the start page's
"not found" row (and a detected too-old one: `.gpp-msys2` note), and the build's missing / too-old note
(not for a too-old g++ the setting names).

**IntelliSense for the generated C++** (user decision 2026-11-12: a configuration provider, not a written
`c_cpp_properties.json`). The generated `.hpp` includes `iec_types.hpp` & co. from
`resources/compiler/include/`, which Microsoft's C/C++ extension cannot find on its own ("cannot open
source file"). `cppToolsCommands` registers `cppToolsProvider` through the extension's public API — the
npm package `vscode-cpptools` (MIT, a runtime dependency: it ships in the VSIX like
`vscode-languageclient`; `.vscodeignore` drops its `out/testApi.*`). Only `out/api.js` is loaded, lazily,
and only once `vscode.extensions.getExtension('ms-vscode.cpptools')` exists — so without the C/C++
extension there is no `console.warn` from the package either.

Registering is not selecting (user report 2026-11-12: provider registered, "cannot open source file
iec_types.hpp" stayed). Checked in the C/C++ extension 1.22.11's own code (`configurations.ts`): the
provider of a folder is `configurationProvider` of the active `c_cpp_properties.json` configuration (a
persisted per-folder index, `CppProperties.currentConfigurationIndex`, not readable from here; when unset, the
one named `Win32`/`Mac`/`Linux`, else the last), falling back to `C_Cpp.default.configurationProvider` when
that is absent or `${default}` (`""` does not fall back); with no properties file, no `C_Cpp.default.*`
value at all and exactly ONE registered provider, it auto-selects that one. So anyone with a
`c_cpp_properties.json`, a default setting such as `cppStandard`, or a second provider (CMake Tools) gets
nothing from the provider. `src/cppToolsSelection.js` computes the effective provider; when it is not TC
Toolkit, `createProviderPrompt` (triggered by a CPP_Files `.cpp`/`.hpp` being created, rewritten or opened,
once the provider is registered) shows one message per workspace folder: *Use TC Toolkit* writes
`C_Cpp.default.configurationProvider` in the WorkspaceFolder scope and calls `didChangeCustomConfiguration`;
*Not now* (or dismissing) asks again next session; *Don't ask again* and *Use* are remembered in
workspaceState. When the properties file names another provider (or `""`, or is unreadable) the file wins:
the message says so and offers *Open c_cpp_properties.json* — the file is never edited. Because the active
configuration cannot be seen, a file where any OTHER configuration names another provider is treated the same
way (naming that configuration), rather than promising a setting that may change nothing. Ids are compared
exactly, as the C/C++ extension looks them up (`providers.has(id)`, no trim or case folding); in the file the
provider's display name `TC Toolkit` also counts, because the C/C++ extension's `checkId` rewrites a
registered provider's name to its id when it parses the file (the setting gets no such rewrite). The message also
shows when auto-selection would have worked (other providers cannot be seen from here); one prompt is the
price of a setting that survives installing CMake Tools later. Verified against the real C/C++ extension
1.22.11 on Linux (scratch harness, not in the suite): with a `c_cpp_properties.json` without a provider, the
exact user symptom ("cannot open source file "iec_types.hpp" (dependency of "PLC.hpp")"); after setting the
folder's `C_Cpp.default.configurationProvider`, the provider is asked and only the planted
undefined-identifier error remains. Every request (`canProvideConfiguration`, `provideConfigurations`,
browse) — and nothing else — is logged to the **TC Toolkit C/C++** output channel, created on the first
request (the selection check logs to the console); each
`provideConfigurations` item carries the very `Uri` object it was asked for (the C/C++ extension accepts only
a string or its own `vscode.Uri`, and keys the result by `uri.toString()`). The extension is activated by
the toolkit's usual activation events, so a generated file opened before the toolkit activates gets the
C/C++ extension's default configuration until it does. A g++ older than 7 is not handed over as
`compilerPath` (the C/C++ extension keeps its own default compiler). `canProvideBrowseConfiguration` is true
only while some project has a `CPP_Files` folder, so the C/C++ extension otherwise keeps its own browse path.
The `**/CPP_Files/*.{cpp,hpp}` watcher is made at registration, whether or not the C/C++ extension is there,
so a first generation after a mid-session install still re-announces the browse configuration.

**Switch coupling** (`cppSettings`): a run uses `generate = generateCpp || buildWithGpp`. On every
`tcToolkit.compiler` change, `couplingWrites(before, after)` fixes the scope that changed (build on →
generation on there if not on at that scope; generation off → build off there); writes made by this
module itself are not re-coupled (`writingOptions`). The dropdowns write through `checkboxWrites`, which
targets the most specific scope that already sets the switch (else User) and writes the coupled switch
in the same call. The g++ path is filled (`gppCommands.autoFill`, empty only) when the build turns on.

**Dropdowns.** Editor toolbar: `#compile-group` (a `.split-btn` like Generate ST's) = `#compile-btn` +
`#compile-caret` (a disclosure: `aria-expanded`/`aria-controls`, deliberately no `aria-haspopup`, which
would announce a menu) + `#compile-menu` (`role=group`, two native checkboxes). The button's tooltip and
the start-page tile's detail follow the options (check / check + write C++ / + build with g++). Messages: `init.compileOptions`,
`compileOptions {options}` (host → webview, on any change), `setCompileOption {key, value}` (webview →
host, allow-listed keys and booleans only). Start page: `#compile-options-toggle` (chevron beside the
tile, `aria-expanded`/`aria-controls`) over `#compile-options`; `state.compileOptions` and the same
`setCompileOption` message. Both show the coupling at once and let the host's answer correct it.

**g++ on the start page.** The Settings card has a `g++` section under the XAE Shell one, drawn with the
same row classes (`#gpp-list` > `li.xae-row`, `data-gpp` = the state): `state.gpp` from
`gpp.describeGppSetting(setting, thisMachine())` — `set` (the value; a `.xae-note` "Runs <path>" when a
bare name or a folder resolves elsewhere), `invalid` (the value + the XAE warning row, text per
`missing` / `not-on-path` / `folder`), `detected` (empty: the g++ a build would use, with where it was
found; nothing is written — filling the setting stays `twincat.detectGpp`'s job), `notFound`. It is
recomputed on every `postState` (a few `stat`s); a `tcToolkit.compiler.gppPath` change re-posts it.
*Change…* posts `openSettings {section: 'gpp'}` (User settings, see `startPage` above); *Detect again*
runs the allow-listed `twincat.detectGpp`.

**Generated output.** `CPP_Files` joins `ST_Files` as generated output (`GENERATED_OUTPUT_DIRS` in
`twincatWorkspace.js`): in `PROJECT_WALK_SKIP_DIRS`, `ARCHIVE_SKIP_DIRS` (so `PROJECT_SKIP_DIRS`) and
`ST_INDEX_SKIP_DIRS`; watcher events under it are not "relevant" and only feed the debounced tree
refresh; the Objects tree shows a project's `CPP_Files` as `generatedDirectory` with its `.cpp`/`.hpp`
as `generatedCppFile` rows that open as text (`twincat.openComponent` treats `.cpp`/`.hpp` like `.st`).

**Known compiler gap (found by `gpp-real`, compiler eb52d2c):** in TcToolkitSample_PLC,
`GVL_System.fbStation.State` (a PROPERTY read through a global FB instance) is emitted as
`FBSTATION.STATE` instead of the getter, so g++ fails on correct code that the check accepts.
`test_cpp_real.js` lists it in `KNOWN_GPP_GAPS`; remove the entry when the fork fixes it.

### XAE build (roadmap R14)

"Build through XAE" builds the real solution with TwinCAT XAE's own compiler and libraries, and
"Build and Activate through XAE…" also activates the configuration on a runtime of THIS machine and
restarts it. Windows with XAE only; elsewhere the commands refuse and the dropdown entries are hidden.

**Process chain.** `xaeBuildCommands` → `runChild` → `powershell.exe -NoProfile -NonInteractive
-ExecutionPolicy Bypass -STA -File resources/xae/build-plc-project.ps1 -SlnPath … -Json …` → DCOM →
`TcXaeShell.exe`. The shell is launched by COM activation, so it is **not** in PowerShell's process
tree: killing PowerShell does not end it. The script censuses the shells before `New-Object` and quits
only the one that appeared (`$ownShellPid`); a shell it cannot prove is its own is never closed. When no
single new shell appeared **and other shells were already running**, COM may have handed it a developer's
IDE: the driver refuses before any SuppressUI, hide, `Open` or `Close` (fatal `shell-not-ours`, exit 2).
When none was running before, it builds, and before releasing the unidentified shell it turns SuppressUI
off and shows the window, so a shell left running can be closed by hand. Every real path goes to
`-LiteralPath` (a folder named `Line [2]` is not a wildcard), and `Resolve-Path` output is read as
`.ProviderPath` (a UNC `.Path` is provider-qualified and DTE cannot open it).

**The driver is a copy, kept additive.** `resources/xae/build-plc-project.ps1` is
`scripts/Build PLC project/build_plc_project.ps1` (the proven headless builder) plus opt-in switches;
without them it behaves exactly like the builder. Three copies exist and are synced **by hand**: the
builder, `templates/build_plc_project.ps1`, and this driver (header line names the builder commit it was
adapted from). `test/test_xae_driver_contract.js` fails if a builder line is lost without a listed
reason. Keep the driver ASCII (Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page).

**Protocol** (`-Json`): stdout lines starting `@@TCTK ` are compact JSON (`v: 1`, `t: <type>`, non-ASCII
escaped `\uXXXX`, flushed per line); every other line is a human log line (UTF-8). `src/xaeBuild.js`
reads both; a garbled event becomes a log line and a counted protocol warning, never an exception.

| Event | Fields |
|---|---|
| `hello` | `mode` build/activate/listTargets, `showWindow` |
| `plan` | `solution, tsproj, projectVersion, progId, pinned, configuration, platform, targetNetId` |
| `shell` | `pid` (null when unproven), `ours`, `preexisting[]` |
| `phase` | `name`: resolve, launch, pin, open, configure, build, errors, target, activate, restart, verify, close |
| `ui` | `requested`, `suppressUI`, `mainWindowVisible` (read back from DTE; null when unreadable), `reason`: headless / requested / version-switch / build / activation / after-activation |
| `warning`, `fatal` | `text`; fatal `code` (no-sln, ambiguous-sln, config-not-declared `data.declared`, no-tsproj, version-mismatch, progid-not-registered, target-refused `data.gate`, com-failure, shell-closed, shell-not-ours) |
| `buildResult` | `failedProjects` (LastBuildInfo: the authority on pass/fail) |
| `errorItem` | raw ErrorList fields `file, line, column, description, project, level` |
| `outputPane` | `name, text, truncated` (failed builds; 256 KB cap) |
| `errorDetails` | failed builds: `errorItems` (items read), `outputPanes` (panes with text), `reasons[]` (one line per step that gave nothing) |
| `target`, `activation` | readback after SetTargetNetId; `adsState`, `stateName`, `outcome` run/incomplete/failed/refused |
| `targets` | ListTargets: `local[{netId, name, kind, platform, provenance}]`, `projectNetId` (the platform is gate 4's: both read `Get-LocalRuntimeRecords`) |
| `done` | last, always (every exit goes through `Exit-Run`): `exitCode`, `ui{requested, buildPhase, versionSwitchKeptVisible, activationShown}` |

**Exit codes decide the result**: 0 built (and activated, when asked), 1 compile errors, 2 harness/COM
error (nothing built), 3 built but activation failed or was refused, 4 cancelled. Events only explain —
with one exception: `powershell.exe -File` also exits 1 when the script never ran (an execution policy set
by Group Policy, a binding error), on a throw outside the driver's handler, or when PowerShell was killed
from outside. So 1 is a compile failure only when the driver confirmed it (`done.exitCode === 1` or
`buildResult.failedProjects > 0`, `compileFailureConfirmed`); otherwise it is "interrupted before it
finished (exit code 1)" with the last stderr or log line. Only a run that reached a build result
(`reachedBuildResult`: 0, 3, a confirmed 1) replaces the Problems; a cancelled, stopped, timed-out or
unconfirmed run keeps the previous ones. Counts go through `countBySeverity` (xaeErrorPlacement) in the
summary, the exit text and the status bar alike: a Medium item is a warning, not an error.

**Problems entries link back.** Like Compile Project's, each XAE entry's code is a link
(`vscode://<extension id>/xaeProblem?id=N`) answered by Compile Project's URI handler (VS Code allows one
per extension; `registerProblemLinkResolver` adds the path), which opens the component, pane and line —
a plain click cannot do that for a custom editor. A freshly opened editor goes to its first XAE problem
once per run (`openTarget`).

**The project's XAE Shell is missing** (user decision, 2026-11-13). The driver maps the project's
build (`TcVersion` in the `.tsproj` / `.tspproj`) to a DTE ProgId (`$ProgIdByBuild`: 4024 →
`TcXaeShell.DTE.15.0`, 4026 → `TcXaeShell.DTE.17.0`; the same pairs as `XAE_SHELL_VERSIONS`, pinned by
the contract test). When that ProgId is not registered it stops with fatal `progid-not-registered`, whose
`data` carries `progId`, `build`, `projectVersion` and `installed` (the mapped ProgIds that ARE
registered, newest build first, a plain `string[]`). For a **build**, the extension then asks ONE modal
— "<solution> was saved with TwinCAT 3.1.4024 and its XAE Shell (4024) is not installed. Build with XAE
Shell 64 (4026) instead? XAE may upgrade the project files." — and on yes runs with exactly `-TcVersion
<ProgId> -AllowVersionMismatch`. The question is asked **before** the run when the pre-run shell check
can already tell (the project's shell is neither in its `tcToolkit.xaeShell.path*` setting nor found by
`detectXaeShells`, and another one is): then the first run already carries the override. When the check
cannot tell (nothing found at all, a registry that cannot be read), it asks nothing and the driver's fatal
is the fallback. Never two questions per build: a run after the pre-check asked never asks again, and the
stall/configuration re-runs keep the confirmed shell. Cancel leaves the original error, which (like the
no-alternative case) names the shell to install. **Activation never runs on another shell**: its pre-check
keeps the "Run anyway" warning and its fatal only explains. What the override means in the driver: a
ProgId names a build family, so the pinned version is `3.1.<that build>.<project revision>`, and the pin
step falls back to the newest installed version of that build; `-AllowVersionMismatch` downgrades the
build mismatch (and an unsatisfiable pin) to a warning. A real pin switch keeps the window visible (`ui`
reason `version-switch`; the driver's rule). XAE may upgrade the project files.

**Headless and the switch.** By default the build is headless: `SuppressUI = true` and, after the pin
step, `MainWindow.Visible = false`. `tcToolkit.xaeBuild.showWindow` (false by default) passes
`-ShowWindow`: `SuppressUI = false` and the window visible for the whole run, the hide step skipped, and
the activation `finally` does not re-suppress. `UserControl` is never set (it would keep the shell alive
after release and break the census/Quit rule). Two exceptions hold in headless mode, both inherited from
the builder:
- **after a real TwinCAT version switch the window stays visible** — the switch reloads the shell
  environment and a hidden window during that reload is what made the switch fragile. From the
  extension it occurs only after the user confirmed another XAE Shell (above), the one time it passes
  `-TcVersion`;
- **activation always shows the window** and turns SuppressUI off — a licence or full-download dialog
  under SuppressUI is an invisible hang, not a question. There is no setting or parameter to hide it.
`describeUiMode` turns the `build` readback into the channel line ("hidden (SuppressUI=True,
MainWindow.Visible=False) - headless"), which is how a user checks on Windows that headless worked.
On the 4026 shell `MainWindow.Visible` reads back as unreadable whether the window is shown or not
(measured 2026-11-13), so the line then reports the requested mode and SuppressUI ("headless
(SuppressUI=True; window visibility not readable)", "visible as requested (SuppressUI=False; …)").

**Cancel and kill rule.** Before activation, cancel writes the `-CancelFile`; the driver checks it at
every phase boundary and in its polling loops and stops with exit 4 (solution closed without saving,
only its own shell quit). After a 60 s grace, a force stop kills PowerShell's tree (`taskkill /T /F`)
and the shell PID **only if `shell.ours`**, and then with an image filter (`/FI "IMAGENAME eq
TcXaeShell*"`) so a PID reused since it was reported is never hit. A force stop during `launch` (before
the shell is identified) says in the channel that a shell may have been left running. The driver disarms
the cancel file right before `target`, so the extension never cancels or force-stops in
target/activate/restart/verify (`UNINTERRUPTIBLE_PHASES`; the contract test checks that every phase the
driver enters after the disarm is in it) — a cancel there would be ignored and could only end in a force
stop at the edge of `activate`. After the grace period the extension yields once (`setImmediate`) so
pending output — an `activate` phase line — is read before it decides. The timeout (default 30 min) uses
the same sequence; inside activation, or when its stop is refused because activation began during the
grace period, it extends once by 5 min and then only reports. The stall watchdog (headless only, outside
the build call and activation) offers to cancel and re-run once with the window shown; the re-run
follows only a run that really stopped (not one that was refused or finished on its own meanwhile), the
stopped run gets one channel line and no notification, and the shell check is not asked again.
`twincat.xaeBuild` / `twincat.xaeBuildAndActivate` are disabled while `twincat.xaeRunning` is set
(`enablement`), and all three XAE commands are in the palette on Windows only (`when: isWindows`).

**Activation** lists the local runtimes (`-ListTargets`, no COM), asks for one (the project's NetId
marked, the last pick preselected from workspaceState — there is no target setting), and shows a
**modal on every run** naming the target; nothing is spawned before it is confirmed. The driver's four
pre-IDE gates (`Resolve-ActivationTarget`) and the post-set readback still refuse any non-local target;
a readback that differs from the confirmed pick is reported as an error. RUN means ADS state 5.

**The target's platform** (user run 2026-11-13; XAE itself asks the same on download). Gate 4 refuses
to activate a platform that is not the target's; the extension decides first, from the platform
`-ListTargets` reported for the pick (the same records gate 4 reads, compared case-insensitively like
PowerShell's `-ne`), with `activationPlatform` (src/xaeBuild.js) over the `.sln`'s declared pairs
(`declaredPairs`, the driver's own regex):
- same platform, or the target's unknown: the plain modal ("Activate on <target>"); unknown is the
  driver's warning and XAE's own check;
- another platform the solution declares as `<configuration>|<it>`: the SAME one modal asks
  "<target> (<NetId>) runs <P>, but <configured> is set. Switch to <P>?" (an inferred platform says
  so) with **Switch for this run** (this run's `-Platform` only; the setting is never written) and
  **Switch and remember** (also writes `tcToolkit.xaeBuild.platform` once, in the scope its value
  comes from: workspace folder, else workspace, else user), or Cancel; the channel names the switch;
- another platform the solution does not declare: refused before XAE starts, naming the platform to
  add in XAE's Configuration Manager;
- the `.sln`'s pairs unreadable: nothing is switched, and gate 4's refusal is the answer.
A driver refusal's summary is the whole message on one line (`oneLine`), never its first line: gate 4
wraps after "activation target <NetId>," and the summary used to end ",.".

**Settings.** `tcToolkit.xaeBuild.platform` is a dropdown (`enum` + `enumDescriptions` = `XAE_PLATFORMS`
in src/xaeBuildSettings.js: the seven platforms a 4026 solution declares plus `TwinCAT CE7 (ARMV7)` and
`TwinCAT OS (ARMT2)` from the 4024 sample); a value typed into settings.json outside the list is passed
on unchanged and the driver's `config-not-declared` (with its pick of the declared pairs) reports it.
`configuration` stays free text: VS Code has no enum that also accepts free text, and solutions can
declare their own configuration names. The start page shows `configuration | platform` as text only:
a picker there would need the solution's own list, and the page is not tied to one solution.

**Error details of a failed build.** The driver reads the ErrorList (`ErrorItems` by plain assignment,
retried by hand: `Invoke-ComRetry`'s `return` writes to the pipeline, which can enumerate a COM
collection, so a one-item list would come back as the bare item) and the Output window panes through
`Get-OutputPaneTexts` — `ToolWindows.OutputWindow` first, then `Windows.Item("{34E76E81-…}").Object`,
with every null (the window, the pane list, each pane, its TextDocument, its Selection) turned into a
one-line reason instead of PowerShell's raw "cannot call a method on a null-valued expression". The
same function is in the builder and `templates/` (the contract test compares them). The reasons arrive
as `errorDetails`. When a confirmed compile failure brought back no error item and no pane text,
`noErrorDetails` says "XAE returned no error details: <reasons>." and, for a headless run, the
notification offers **Build again with the window shown**: one re-run with `-ShowWindow` (and the same
configuration, platform and shell), never a settings write. It does not claim the visible run shows the
errors — whether it does is the open Windows question (HANDOFF).

**Why placement lives in JS.** The ErrorList's file/line semantics are unknown until real Windows
captures exist, and placing needs the XML parse and the raw lineMap the rest of the extension uses;
`src/xaeErrorPlacement.js` is testable here, the ps1 reports raw fields only. Until fixtures exist, a
line is read as a pane line (`lineBase: 'pane'`), exact only with a section marker, otherwise marked
"(location approximate)"; the output-pane parser returns nothing.

**Not done (phase 2, each waits for a Windows probe):** boot project + autostart and PLC RUN on port 851;
remote targets (machine-scope setting, off by default, modal every run); building one nested PLC project
(`BuildProject`); route listing; attaching to a running hidden shell to show it. Never: writing routes,
saving the solution or `.tsproj`, activating without the modal, closing a shell this run did not start,
automating the trial-licence dialog.

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
