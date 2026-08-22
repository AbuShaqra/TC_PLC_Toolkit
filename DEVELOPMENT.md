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

## Tests

The language server has a standalone test suite; no VS Code instance is required.

```bash
npm test                     # run the whole suite via test/run.js
node test/run.js references   # run only suites whose name matches a substring
node test/test_live_path.js   # run a single harness directly
node test/test_solution_map.js # solution → PLC-project discovery/grouping
node test/test_tree_reveal.js # exact component → project → solution parent chains
npm run typecheck             # type-check gate: tsc --noEmit (no emit — runtime stays plain JS)

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
  archive reader and multi-project fixture.
- **REDUCED** — lists missing fixtures plus every gate that skipped or failed to report execution,
  and labels the final line `(reduced coverage)`.
- **FILTERED** — `node test/run.js <substring>` intentionally ran only a subset and can never claim
  whole-suite FULL coverage.

`REQUIRE_FULL_SUITE=1` turns a reduced or filtered run into a hard failure after the harness reports
are collected. Use it before packaging a release, so a silently skipped gate can never be mistaken
for a clean one.

`npm test` runs `node test/run.js`, which runs each harness in `test/` in its own process and reports
per-suite without aborting on the first failure. The main ones:

| Harness | What it checks |
|---------|----------------|
| `test/test_lsp_features.js` | Core LSP: completions, go-to-definition (incl. call parameters), references, diagnostics, on synthetic `.st` units. |
| `test/test_sample_diagnostics.js` | **Diagnostics ratchet** on the real `sample/` TwinCAT project. The sample is valid code, so every diagnostic on it is a false positive; the harness measures them the way the LSP server does, prints a per-category breakdown, and **fails if the total rises above the baseline** in `test/_baseline.js`. The target — currently met — is zero. |
| `test/test_live_path.js` | The live editor pipeline: full-file ST assembly, cursor mapping, per-pane diagnostics, member completion through references, method return types, token-aware and cross-file references. |
| `test/test_editor_mapping.js` | The production `src/editorMapping.js` helpers directly: pane↔unit boundary mapping, synthesized-line rejection, pane slicing and encoded peek-model paths. `test_live_path.js` imports the same helpers rather than carrying copies. |
| `test/test_file_uri.js` | The production filesystem-path/file-URI boundary: reserved characters, Unicode, encoded drive colons and UNC round trips. |
| `test/test_component_id.js` | `src/componentId.js`, the component-id grammar owner: a conformance sweep driving the **real** `parseTwinCatXml` over a fixture minting every id shape (round-trip `parse`→`make` identity), the frozen parse table incl. the pinned `prop_X_get`-is-an-accessor ambiguity, `make`'s programmer-error throws, and the `label`/`memberName` display helpers incl. the transition fix. |
| `test/test_typecheck.js` | Semantic type checking: member access, call arguments, declaration types, assignment compatibility — plus the same `sample/` diagnostics ratchet. |
| `test/test_references_scope.js` | Find References scope + coordinate spaces: private method `VAR` vs. parameters, named arguments belonging to the callee, and FB_init declaration-site arguments (`inst : FB_T(p := v)`). |
| `test/test_references_tree.js` | References-view grouping (file → component → occurrence). |
| `test/test_tree_reveal.js` | Objects-tree navigation targets and parent chains: file/root fallback; exact method, property, action, transition and Get/Set nodes; nested virtual-folder ancestry; solution → PLC-project ancestry; and no project-map lookup until the logical component chain reaches the file/disk boundary. |
| `test/test_st_shadow.js` | XML is the source of truth: a stray plain `.st` mirror (outside `ST_Files/`) must never steal an XML-backed symbol's index node — the references scan would follow the hijacked uri to the stale mirror and miss the real call sites. |
| `test/test_library_catalog.js` | The data path behind the TwinCAT Libraries view: catalog built from the `.plcproj`, namespaces, `.tmc` types and their members. |
| `test/test_dnd_rules.js` | The Objects-tree drag & drop and copy/paste compatibility matrices: what is draggable/copyable (not virtual folders, not Get/Set accessors; directories move but do not copy), components move only within their own file yet paste cross-file (POU↔interface gated), directory-cycle and no-op rejections, duplicate-in-place file paste. |
| `test/test_xml_rename.js` | Structural rename primitives in `xmlParser`: `renameComponentInXml` (tag Name attr + declaration header + LineIds, Ids kept), `renameVirtualFolderInXml` (folder tag + member FolderPath prefix rewrite), and the no-op-safety composition the rename command relies on (header already renamed by the reference pass → attr/LineIds still fixed, no corruption). |
| `test/test_xml_member_order.js` | WHERE a new member lands, for both `insertComponentIntoXml` (create) and `insertComponentBlockIntoXml` (paste), via the shared `insertMemberIntoXml`. TwinCAT's loader is order-sensitive inside `<POU>`/`<Itf>`: the canonical child order is Declaration, Implementation, `Folder*`, member*, `LineIds*`, so a member must land *before* the LineIds group — appending past it is the same class of defect as the root-`<Folder>` incident that made XAE drop an FB's members from compile. Also pins the seam's 4-space indent, the root close tag keeping its own indent, CRLF preservation (including an LF block pasted into a CRLF document), a `<LineIds` literal inside CDATA not being mistaken for the anchor, and the `.TcIO` fallback (interfaces carry no LineIds at all). |
| `test/test_nested_namespace.js` | Nested library namespaces (`VisuElems.VisuElemBase.▮`): a library's namespace re-exports its dependencies' namespaces, so the inner segment names a library no `.plcproj` references and is resolved by name against the installed-library store, lazily and cached. Asserts the two properties that hold without any library installed — the gate (only a referenced namespace head opens the store, so `stAxis.MotionState.▮` never does) and the miss (uninstalled ⇒ cached empty list, never an exception). Real resolution runs only when the machine has a readable library, and says so when it does not. |
| `test/test_rename_engine.js` | `src/renameEngine.js`: mapping workspace reference positions (raw-ST-unit coords) back into CDATA splices — synthesized-line skips (action headers, `GET`/`SET`), the PROGRAM→FUNCTION_BLOCK raw-mode column skew, the never-write-a-mismatch guard, CRLF byte preservation. |
| `test/test_references_for_symbol.js` | The LSP's by-symbol references entry point (`custom/referencesForSymbol`) that powers rename: FB/GVL/DUT roots (a GVL name never appears in its own ST text, so the position-based API cannot seed it), methods/properties/actions, the name-keyed-index identity guard, and index restoration after the scan. |
| `test/test_config_references.js` | The non-code half of rename (`custom/configReferencesForSymbol`): dotted symbol paths inside visualizations `.TcVIS`/`.TcVMO` (`GVL_X.fb.member`, embedded `STSnippet` code) and text lists `.TcTLO`/`.TcGTLO` (a text entry whose text IS a symbol path) are found only when the chain provably resolves to the renamed symbol — text-list ids, visu-library names, dotted prose (`Palletizer.Turn1`) and unresolvable prefixes are never touched. Task configs `.TcTTO` use a separate rule: the `<PouCall>` `<Name>` matches only a dot-free name, so a library call (`VisuElems.Visu_Prg`) is never rewritten. BOM/offset fidelity, plus a sample-project pass when `sample/` is present. |
| `test/test_lsp_parser.js` | Lexer, AST parser and symbol indexer on a synthetic FB: keyword tokenisation, `EXTENDS`/`IMPLEMENTS`, variable types and ranges, nested method params, property GET accessors. Lived outside the suite until 2026-08-05 and **printed `[FAIL]` while exiting 0** — it could report a broken parser and still be green. It counts failures and exits non-zero now. |
| `test/test_lsp_types_sync.js` | Completions and go-to-definition still resolve correctly through symbol-index nodes that carry only stubbed ranges (`startLine:1,startCol:1,...`, no real declaration position) rather than ranges parsed from source — a defensive regression test, since no current indexer (`xmlIndexer.js` builds real ranges) produces stub nodes any more. |
| `test/test_method_diagnostics.js` | Diagnostics for a method body analysed on its own, as the webview does — a valid method must produce none once its POU is indexed. |
| `test/test_memory_bank.js` | The shared memory bank in `.claude/memory/` and the `SessionStart` hook that delivers it. The bank fails silently by nature — a malformed note is skipped, a renamed file breaks the `[[links]]` at it, a dropped hook stops the digest — and sessions just stop being told what the project already learned, which looks exactly like having nothing to tell. Pins the hook contract too (JSON carrying `hookSpecificOutput.additionalContext`, exit 0 whatever happens), since that is what the mechanism depends on and nothing else in the repo enforces it. |
| `test/test_folding.js` | Folding ranges (`media/stFolding.js`). Pins the two reported bugs by name — an unmatched `{endregion}` truncating the enclosing `VAR` fold, and an unindented `{attribute …}` growing a fold arrow of its own — plus the case designed for rather than discovered: `{IF defined(X)}` is a conditional *pragma*, not an `IF` block, and reading it as one leaves an unclosed block that eats every fold below. Also covers keywords inside comments/strings (`$`-escapes included), members named like keywords (`axis.Case`), the separate region/block stacks, every `VAR_*` variant, and a sweep over every pane of every `sample/` object asserting no range is ever out of bounds. |
| `test/test_pragmas.js` | Pragma classification and the two catalogs, plus the highlighting rules in **both** grammars and the `{region}` folding markers. Pins the split the design rests on: shape decides the category (and therefore the colour), the catalog only enriches — so a user-defined attribute must be scoped exactly like a documented one. Also asserts catalog integrity (no duplicates, every documented entry has an Infosys node id, the curated file holds nothing Infosys documents, every curated entry carries measured counts), that pragma spans are consumed whole in the lexer and both grammars, and that the three folding-marker declarations — `pragmas.js`, `language-configuration.json`, `media/editor.js` — still agree, which nothing else can check because none of them can import the others. |
| `test/test_plcproj_scope.js` | The index is scoped to the `.plcproj`, not the filesystem: a project's `objectPaths` (from `createProjectMap`) names only the `<Compile>`d objects, so a backup/orphan copy on disk (a duplicate object name, absent from the project) can never win the name-keyed index and steal a real object's references. Includes the no-`.plcproj` empty-map case and a sample-coverage check proving the scoping is a no-op on the ratchet. Predates the project-scoped index (below) — the guarantee it pins now runs through `createProjectMap` per project instead of one workspace-wide union. |
| `test/test_uri_fs_path.js` | `uriToFsPath()` must return a path the **running** platform can open. The former copies in `workspaceScan.js` and `features/core.js` once ended in an unconditional `.replace(/\//g,'\\')`, which is correct on Windows and on POSIX ate the root — `file:///home/u/a` became `\home\u\a` — so 11 of 59 suites failed on Linux while CI (`windows-latest`) stayed green. Both callers now delegate to the shared production helper in `src/fileUri.js`. Written to hold on **both** platforms so whichever one CI runs still guards the branch it takes: a round trip through the real filesystem (the load-bearing one — a merely plausible converter cannot satisfy it), paths containing a space in both encoded and unencoded form, separator/root shape per platform, bare-path and empty-input passthrough, caller delegation, and unchanged Windows mapping. |
| `test/test_project_map.js` | `src/lsp/projectMap.js`: which `.plcproj` owns which file. Discovery, `objectPaths` per project, `ownersOf()` vs `projectFor()` (a linked file has two owners but a request for it routes to one), the orphan/no-project/case-insensitivity edges, `projectLabel()` (the status-bar text, from `src/projectStatusBar.js`) and `groupRootsByProject()` (the Objects-tree grouping) at both the &lt;2-projects (nothing shown, flat tree) and 2-projects ends. Also pins `TWINCAT_EXTS` staying in sync between `projectMap.js` and `xmlIndexer.js`'s own copies — a real review-caught bug: `projectMap.js`'s copy once missed `.tctleo`, silently dropping every enumeration-text-list object's symbols from a project-scoped scan. |
| `test/test_solution_map.js` | `src/solutionMap.js`: the real `.sln` → `.tsproj` → `_Config/PLC/*.xti` → `.plcproj` chain, multiple PLC projects under one solution, multiple same-named solutions, project labels scoped within their solution, unrelated Visual Studio solutions ignored, and unreferenced PLC projects retained as top-level fallbacks. |
| `test/test_multi_project_scope.js` | End-to-end: two copies of `sample/` under one workspace root (`test/_multiproject.js` builds the fixture, one copy deliberately diverged), driven through the real `scanWorkspace`. Asserts the partition (one index per project, nothing lost to a name collision), 0 diagnostics on the correct copy while the diverged copy's own real error still reports, references and the rename config scan never crossing the project boundary, and the library namespace/symbol registries staying per-project — including the Libraries-view union fallback when no project is specified. Needs `sample/`; skips cleanly when absent. |

| `test/test_object_insert.js` | The Objects-tree insert commands' text, built by driving the **real** `buildNodeFromXml` over real `sample/` objects: the bare name for each kind, and the call template — instance name for an FB (`FB_Gripper` → `fbGripper`, since ST calls an instance, not the type), own name for a FUNCTION/PROGRAM, bare for a method/action, `Name();` when there are no parameters. Also pins that the extracted `callTemplate` is byte-identical to what `libraryTreeProvider` produced before the move, and that every `contextValue` named in the two new `when` clauses is one the Objects tree actually emits (read out of `treeDataProvider.js`, not hard-coded, so a rename cannot silently orphan the menu items). **One case is synthetic on purpose:** no FB in `sample/` declares root `VAR_INPUT`/`VAR_OUTPUT`, so the mixed `:=`/`=>` ordering case is driven from one clearly-marked XML string through the real parser. |
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
| `run.js` | The references peek: builds for the port it will serve on, drives Find References, asserts. `HARNESS_PORT` moves it off 8123; `HARNESS_SHOT=x.png` saves a screenshot. |
| `run_pragmas.js` | Folding and pragma highlighting. Folds real blocks and reads back the rendered lines, then tokenizes through Monaco's **own** tokenizer. Both fail silently if they regress, which is the point of driving a browser: a unit test on `stFolding.js` cannot prove Monaco actually *used* it rather than its own indentation provider. Carries the two reported bugs as regressions, and asserts implementation-pane blocks still fold — registering a provider replaces indentation folding, so that is the thing most likely to disappear unnoticed. Verified: removing the provider turns 6 assertions red, and the failure text reproduces both original bug reports verbatim. Defaults to port 8124. |

`run.js` asserts what only a browser can show: that the peek lists cross-file hits at all, that exactly
the **non-live** panes get hidden models (a hit in the active component must use the live pane), that a
cross-file entry previews the other file's real text, that double-clicking posts coordinates which
land on the word itself, and that a second search retires the pane it no longer needs instead of
accumulating models. Verified to fail on a regression, not just to pass: disabling the pane texts
drops the peek to `References (1)` — the old behaviour — and four assertions go red.

Not in `npm test`, and **Playwright is not in `package.json`**: it is a heavy dependency that CI would
install on every run for a harness CI cannot execute anyway. Both runners exit 2 with the install
command when it is absent. **`media/editor.js` has no other test — run both whenever it changes.**

**`test/devhost/`** runs the extension in a **real VS Code window** — the two links that neither the
Node harnesses nor the browser harness can reach: `vscode.openWith()` URI identity (does a navigation
reuse the open tab, or open a duplicate?) and the live `vscode-languageclient` transport. One runner,
outside `npm test` for the same reason as the browser pass (it needs an installed VS Code, and it opens
a visible window for ~30 s that closes itself):

```bash
node test/devhost/run.js
```

`run.js` copies the committed sample twice (`LineA`/`LineB`) under one temp workspace, adds a second
PLC project to LineA's solution, and launches the **installed** VS Code as a separate
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
with nothing highlighted. Results flow through a progressive JSON file the runner polls, so a hang
still leaves evidence of the last step reached. **Run it whenever navigation identity, the
custom-editor resolve chain, or the LSP bridge wiring changes.**

**`asWebviewUri` must return ABSOLUTE urls.** Root-relative ones look equivalent, but the Monaco worker
runs from a `blob:` URL with no base to resolve them against, and it fails with "Failed trying to load
default language strings" — the same symptom this project already records for a wrong AMD baseUrl.

CI (`.github/workflows/ci.yml`) runs on every push/PR to `main`, Windows-only (the platform users are
on), with superseded runs cancelled and a read-only token. Two jobs:

- **`build`** (current Node) — `npm run typecheck`, `npm test`, then a **VSIX build check**
  (`vsce package`). Packaging is otherwise only exercised by hand at release time, where a broken
  manifest or `.vscodeignore` would surface far too late.
- **`runtime-compat`** (Node 16 and 20) — `npm test` only. The extension runs on the Node that VS Code
  bundles, not the CI default: `engines.vscode` is `^1.66.0`, and VS Code 1.66 ships Electron 17
  (Node 16), so the suite must keep working there or that support claim is fiction. Tests only is
  deliberate — the type-check (TypeScript 7) and `vsce` both require a modern Node, so running them
  on 16 would fail on tooling constraints rather than on anything about the product. **If this job
  ever goes red, the honest fixes are to stop using the newer API or to raise `engines.vscode`** —
  not to drop the version from the matrix.

**CI is always a REDUCED run** — see the section above.

**`sample/` is ground truth.** It is a real, *correct* TwinCAT project, so every diagnostic reported
on it is a bug. Never fix a red gate by raising the baseline.

## Architecture

```
extension.js            Thin activation hub: wires providers/views/watchers/LSP client, delegates commands
src/
  commands/             Command registration, split out of extension.js — each exports register*(context, deps)
    objectCommands      "TwinCAT Objects" create/delete (methods, properties, actions, files, folders)
    clipboardCommands   "TwinCAT Objects" copy/paste (duplicate a component cross-file or a file under a new name)
    renameCommands      "TwinCAT Objects" rename (files, members, directories, virtual folders; reference-aware)
    libraryCommands     "TwinCAT Libraries" commands (refresh, insert, copy, Update Library Definitions)
    lspBridgeCommands   openComponent navigation + the twincat.lsp.query* Monaco↔LSP bridges
  xaeShell              XAE shell discovery + the library-signature generator (the one non-offline path)
  customEditorProvider  Webview host: assembles full-file ST, bridges Monaco ↔ LSP, writes CDATA back
  editorMapping         Pure pane↔unit coordinate, pane-slice and peek-model helpers used by the host + tests
  fileUri               Central Windows path ↔ file URI conversion and comparison boundary
  componentId           Single owner of the component-id string grammar (root/method_/prop_/
                        prop_*_get/prop_*_set/action_/transition_) shared by webview, host and
                        LSP; vscode-free. The grammar is FROZEN (ids travel over the bridge and
                        into saved state); prop_X_get parses as accessor-of-X by pinned convention
  treeDataProvider      "TwinCAT Objects" explorer tree and reveal parent chains
  solutionMap           TwinCAT .sln → .tsproj → .xti → .plcproj presentation model for that tree
  projectStatusBar      Status-bar "which PLC project is this file in" indicator (2+ projects only);
                        projectLabel() is pure/vscode-free so it is unit-testable — vscode is required
                        lazily, inside createProjectStatusBar()
  dndRules              Objects-tree drag & drop + copy/paste compatibility matrices (vscode-free, so testable)
  renameEngine          Rename: maps LSP reference positions back into CDATA splices (vscode-free, so testable)
  treeDragAndDrop       Objects-tree drag & drop controller — executes the matrix's plans (needs VS Code 1.66+)
  libraryTreeProvider   "TwinCAT Libraries" explorer tree (library → types → members)
  referencesProvider    "TwinCAT References" results view (+ referencesTree grouping)
  objectKinds           Kind → codicon → tooltip for the Objects tree (vscode-free, so it is testable)
  insertTemplates       Call/usage templates + parameter ordering, shared by the Libraries AND Objects
                        insert commands so both produce identical text (vscode-free, so testable)
  util/
    debounce.js         Trailing-edge debouncer with injectable timers (vscode-free, so testable)
  xmlParser             Regex-based TwinCAT XML parse / structural edits (preserves formatting)
  stConverter           XML → clean Structured Text + line map (also a raw mode for the live path)
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
    scanController.js   Decides WHEN to scan, separately from how. custom/reindex = "rebuild
                        unconditionally"; custom/indexReady = "resolve once these roots are indexed".
                        Outside server.js for the same harness reason; the scan is injected.
    parseCache.js       library-signatures.xml + browsercache parses, cached on (path, size, mtime).
                        Signature records are CLONED per project — see the warning in its header.
    plcprojRefs.js      One shared, cached .plcproj read (library references + namespaces). The same
                        file used to be read three times per project per scan.
    parser.js           Structured Text lexer + symbol parser
    symbolNode.js       Single factory for a symbol node's core shape (parser + xmlIndexer build through it)
    features.js         Facade re-exporting features/{core,completions,definition,references,configReferences,highlights,diagnostics}
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
```

### Objects tree: solution and PLC-project hierarchy

The Objects tree's grouping is a separate, extension-host-only presentation model. It must not alter
which language-server index owns a file:

1. `src/solutionMap.js` discovers TwinCAT `.sln` files and follows their actual metadata chain:
   `.sln` project entry → `.tsproj` → `<Plc><Project File="…xti">` → the XTI's `PrjFilePath` →
   `.plcproj`. Unrelated Visual Studio solutions are ignored.
2. A solution is always a top-level node when present, even with one PLC project. One solution may
   contain several PLC projects, and several solutions may coexist in one workspace. Duplicate
   solution names use shortest-unique-parent suffixes; project labels are disambiguated only among
   siblings in the same solution.
3. A PLC project that no solution references remains a top-level fallback. With no TwinCAT solution,
   the pre-0.8.0 behavior remains: two or more projects get project roots; a single project keeps the
   flat directory-driven tree.
4. `src/treeDataProvider.js` attaches logical parents for reveal:
   component → virtual folder/property → file → disk folders → PLC project → solution. Rebuilding a
   reveal target parses only its backing XML file and consumes the cached host maps; it never starts
   another workspace scan.
5. `.sln`, `.tsproj`, and `.xti` create/change/delete events rebuild and refresh only the host tree
   model. A `.plcproj` event also rebuilds ownership and remains the sole project-structure event that
   triggers `custom/reindex` and the Libraries refresh.

Coverage is split deliberately: `test/test_solution_map.js` exercises discovery, multi-solution and
multi-project grouping, label scope and fallbacks without VS Code; `test/test_tree_reveal.js` pins the
logical ancestry; `node test/devhost/run.js` creates two solutions and three PLC projects (two under
one solution) and proves the real VS Code TreeView accepts that ancestry. Run the dev-host harness
whenever solution grouping, project grouping or reveal parents change.

### Project-scoped indexing

A TwinCAT workspace can hold **more than one `.plcproj`**, and each is its own compilation unit — XAE
does not resolve symbols across them. The LSP therefore keeps **one symbol index per project**, built
and routed at startup (and on `custom/reindex`), not one flat index for the whole workspace:

- **`src/lsp/projectMap.js`** is the single source of truth for the partition. It is dependency-free
  (`fs`/`path` only — no `vscode`), so both the server and the extension host can require it.
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
`groupRootsByProject()` (the Objects-tree per-project grouping) in isolation.
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
   project must be **cloned** before use — the signature merge rewrites `record.namespace` and
   `indexBrowserCache` pushes members onto the stored object, so a shared record leaks one project's
   attribution into another. `test_signature_cache.js` asserts that by object identity, because a
   value comparison still passes while sharing.
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
hold unsaved edits. Bounded by `PEEK_MAX_PANES` / `PEEK_MAX_TEXT_BYTES` in `customEditorProvider.js`,
since the peek is a preview and the References panel lists every hit uncapped. Clicking an entry routes
through `twincat.openComponent` with the exact pane + line + columns. The pane-slice coordinates are the
subtle part — a slice is a different frame from the assembled unit — and `test_live_path.js` guards that
arithmetic against every block of a real sample object.

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
See [HANDOFF.md](HANDOFF.md) for what each source uniquely provides and the traps.

Each project's index carries its own copy of what `libraries.js`/`libsymbols.js` register — the
`Symbol`-keyed registries described under "Project-scoped indexing" above — so two projects that
reference different libraries never see each other's namespaces or symbol names.

Note the **Beckhoff** archives under `_Libraries/` are git-ignored, so a fresh clone has only the
committed MIT archive. That changes how many external symbols resolve, not the diagnostic count: the
synthetic sample names no Beckhoff symbol, so every baseline row measures 0. `test/_baseline.js` records
how each row was measured.
