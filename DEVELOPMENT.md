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

- **FULL** — sample project, library archives and `.tmc` all present. This is the normal state
  everywhere, and the only run that proves the ratchet held.
- **REDUCED** — lists exactly which fixtures are missing and what that means, and labels the final
  line `(reduced coverage)`.

`REQUIRE_FULL_SUITE=1` turns a reduced run into a hard failure before any suite executes. Use it
before packaging a release, so a degraded run can never be mistaken for a clean gate.

`npm test` runs `node test/run.js`, which runs each harness in `test/` in its own process and reports
per-suite without aborting on the first failure. The main ones:

| Harness | What it checks |
|---------|----------------|
| `test/test_lsp_features.js` | Core LSP: completions, go-to-definition (incl. call parameters), references, diagnostics, on synthetic `.st` units. |
| `test/test_sample_diagnostics.js` | **Diagnostics ratchet** on the real `sample/` TwinCAT project. The sample is valid code, so every diagnostic on it is a false positive; the harness measures them the way the LSP server does, prints a per-category breakdown, and **fails if the total rises above the baseline** in `test/_baseline.js`. The target — currently met — is zero. |
| `test/test_live_path.js` | The live editor pipeline: full-file ST assembly, cursor mapping, per-pane diagnostics, member completion through references, method return types, token-aware and cross-file references. |
| `test/test_typecheck.js` | Semantic type checking: member access, call arguments, declaration types, assignment compatibility — plus the same `sample/` diagnostics ratchet. |
| `test/test_references_scope.js` | Find References scope + coordinate spaces: private method `VAR` vs. parameters, named arguments belonging to the callee, and FB_init declaration-site arguments (`inst : FB_T(p := v)`). |
| `test/test_references_tree.js` | References-view grouping (file → component → occurrence). |
| `test/test_st_shadow.js` | XML is the source of truth: a stray plain `.st` mirror (outside `ST_Files/`) must never steal an XML-backed symbol's index node — the references scan would follow the hijacked uri to the stale mirror and miss the real call sites. |
| `test/test_library_catalog.js` | The data path behind the TwinCAT Libraries view: catalog built from the `.plcproj`, namespaces, `.tmc` types and their members. |
| `test/test_dnd_rules.js` | The Objects-tree drag & drop and copy/paste compatibility matrices: what is draggable/copyable (not virtual folders, not Get/Set accessors; directories move but do not copy), components move only within their own file yet paste cross-file (POU↔interface gated), directory-cycle and no-op rejections, duplicate-in-place file paste. |
| `test/test_xml_rename.js` | Structural rename primitives in `xmlParser`: `renameComponentInXml` (tag Name attr + declaration header + LineIds, Ids kept), `renameVirtualFolderInXml` (folder tag + member FolderPath prefix rewrite), and the no-op-safety composition the rename command relies on (header already renamed by the reference pass → attr/LineIds still fixed, no corruption). |
| `test/test_xml_member_order.js` | WHERE a new member lands, for both `insertComponentIntoXml` (create) and `insertComponentBlockIntoXml` (paste), via the shared `insertMemberIntoXml`. TwinCAT's loader is order-sensitive inside `<POU>`/`<Itf>`: the canonical child order is Declaration, Implementation, `Folder*`, member*, `LineIds*`, so a member must land *before* the LineIds group — appending past it is the same class of defect as the root-`<Folder>` incident that made XAE drop an FB's members from compile. Also pins the seam's 4-space indent, the root close tag keeping its own indent, CRLF preservation (including an LF block pasted into a CRLF document), a `<LineIds` literal inside CDATA not being mistaken for the anchor, and the `.TcIO` fallback (interfaces carry no LineIds at all). |
| `test/test_nested_namespace.js` | Nested library namespaces (`VisuElems.VisuElemBase.▮`): a library's namespace re-exports its dependencies' namespaces, so the inner segment names a library no `.plcproj` references and is resolved by name against the installed-library store, lazily and cached. Asserts the two properties that hold without any library installed — the gate (only a referenced namespace head opens the store, so `stAxis.MotionState.▮` never does) and the miss (uninstalled ⇒ cached empty list, never an exception). Real resolution runs only when the machine has a readable library, and says so when it does not. |
| `test/test_rename_engine.js` | `src/renameEngine.js`: mapping workspace reference positions (raw-ST-unit coords) back into CDATA splices — synthesized-line skips (action headers, `GET`/`SET`), the PROGRAM→FUNCTION_BLOCK raw-mode column skew, the never-write-a-mismatch guard, CRLF byte preservation. |
| `test/test_references_for_symbol.js` | The LSP's by-symbol references entry point (`custom/referencesForSymbol`) that powers rename: FB/GVL/DUT roots (a GVL name never appears in its own ST text, so the position-based API cannot seed it), methods/properties/actions, the name-keyed-index identity guard, and index restoration after the scan. |
| `test/test_config_references.js` | The non-code half of rename (`custom/configReferencesForSymbol`): dotted symbol paths inside visualizations `.TcVIS`/`.TcVMO` (`GVL_X.fb.member`, embedded `STSnippet` code) and text lists `.TcTLO`/`.TcGTLO` (a text entry whose text IS a symbol path) are found only when the chain provably resolves to the renamed symbol — text-list ids, visu-library names, dotted prose (`Encoderpos.Turn1`) and unresolvable prefixes are never touched. Task configs `.TcTTO` use a separate rule: the `<PouCall>` `<Name>` matches only a dot-free name, so a library call (`VisuElems.Visu_Prg`) is never rewritten. BOM/offset fidelity, plus a sample-project pass when `sample/` is present. |
| `test/test_lsp_parser.js` | Lexer, AST parser and symbol indexer on a synthetic FB: keyword tokenisation, `EXTENDS`/`IMPLEMENTS`, variable types and ranges, nested method params, property GET accessors. Lived outside the suite until 2026-08-05 and **printed `[FAIL]` while exiting 0** — it could report a broken parser and still be green. It counts failures and exits non-zero now. |
| `test/test_lsp_types_sync.js` | Completions and go-to-definition still resolve correctly through symbol-index nodes that carry only stubbed ranges (`startLine:1,startCol:1,...`, no real declaration position) rather than ranges parsed from source — a defensive regression test, since no current indexer (`xmlIndexer.js` builds real ranges) produces stub nodes any more. |
| `test/test_method_diagnostics.js` | Diagnostics for a method body analysed on its own, as the webview does — a valid method must produce none once its POU is indexed. |
| `test/test_memory_bank.js` | The shared memory bank in `.claude/memory/` and the `SessionStart` hook that delivers it. The bank fails silently by nature — a malformed note is skipped, a renamed file breaks the `[[links]]` at it, a dropped hook stops the digest — and sessions just stop being told what the project already learned, which looks exactly like having nothing to tell. Pins the hook contract too (JSON carrying `hookSpecificOutput.additionalContext`, exit 0 whatever happens), since that is what the mechanism depends on and nothing else in the repo enforces it. |
| `test/test_folding.js` | Folding ranges (`media/stFolding.js`). Pins the two reported bugs by name — an unmatched `{endregion}` truncating the enclosing `VAR` fold, and an unindented `{attribute …}` growing a fold arrow of its own — plus the case designed for rather than discovered: `{IF defined(X)}` is a conditional *pragma*, not an `IF` block, and reading it as one leaves an unclosed block that eats every fold below. Also covers keywords inside comments/strings (`$`-escapes included), members named like keywords (`axis.Case`), the separate region/block stacks, every `VAR_*` variant, and a sweep over every pane of every `sample/` object asserting no range is ever out of bounds. |
| `test/test_pragmas.js` | Pragma classification and the two catalogs, plus the highlighting rules in **both** grammars and the `{region}` folding markers. Pins the split the design rests on: shape decides the category (and therefore the colour), the catalog only enriches — so a user-defined attribute must be scoped exactly like a documented one. Also asserts catalog integrity (no duplicates, every documented entry has an Infosys node id, the curated file holds nothing Infosys documents, every curated entry carries measured counts), that pragma spans are consumed whole in the lexer and both grammars, and that the three folding-marker declarations — `pragmas.js`, `language-configuration.json`, `media/editor.js` — still agree, which nothing else can check because none of them can import the others. |
| `test/test_plcproj_scope.js` | The index is scoped to the `.plcproj`, not the filesystem: a project's `objectPaths` (from `createProjectMap`) names only the `<Compile>`d objects, so a backup/orphan copy on disk (a duplicate object name, absent from the project) can never win the name-keyed index and steal a real object's references. Includes the no-`.plcproj` empty-map case and a sample-coverage check proving the scoping is a no-op on the ratchet. Predates the project-scoped index (below) — the guarantee it pins now runs through `createProjectMap` per project instead of one workspace-wide union. |
| `test/test_project_map.js` | `src/lsp/projectMap.js`: which `.plcproj` owns which file. Discovery, `objectPaths` per project, `ownersOf()` vs `projectFor()` (a linked file has two owners but a request for it routes to one), the orphan/no-project/case-insensitivity edges, `projectLabel()` (the status-bar text, from `src/projectStatusBar.js`) and `groupRootsByProject()` (the Objects-tree grouping) at both the &lt;2-projects (nothing shown, flat tree) and 2-projects ends. Also pins `TWINCAT_EXTS` staying in sync between `projectMap.js` and `xmlIndexer.js`'s own copies — a real review-caught bug: `projectMap.js`'s copy once missed `.tctleo`, silently dropping every enumeration-text-list object's symbols from a project-scoped scan. |
| `test/test_multi_project_scope.js` | End-to-end: two copies of `sample/` under one workspace root (`test/_multiproject.js` builds the fixture, one copy deliberately diverged), driven through the real `scanWorkspace`. Asserts the partition (one index per project, nothing lost to a name collision), 0 diagnostics on the correct copy while the diverged copy's own real error still reports, references and the rename config scan never crossing the project boundary, and the library namespace/symbol registries staying per-project — including the Libraries-view union fallback when no project is specified. Needs `sample/`; skips cleanly when absent. |

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
```

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
  treeDataProvider      "TwinCAT Objects" explorer tree
  projectStatusBar      Status-bar "which PLC project is this file in" indicator (2+ projects only);
                        projectLabel() is pure/vscode-free so it is unit-testable — vscode is required
                        lazily, inside createProjectStatusBar()
  dndRules              Objects-tree drag & drop + copy/paste compatibility matrices (vscode-free, so testable)
  renameEngine          Rename: maps LSP reference positions back into CDATA splices (vscode-free, so testable)
  treeDragAndDrop       Objects-tree drag & drop controller — executes the matrix's plans (needs VS Code 1.66+)
  libraryTreeProvider   "TwinCAT Libraries" explorer tree (library → types → members)
  referencesProvider    "TwinCAT References" results view (+ referencesTree grouping)
  objectKinds           Kind → codicon → tooltip for the Objects tree (vscode-free, so it is testable)
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

`test/test_project_map.js` covers `projectMap.js`'s ownership rules, `projectLabel()` and
`groupRootsByProject()` (the Objects-tree per-project grouping) in isolation.
`test/test_multi_project_scope.js` covers the whole thing end-to-end against a real two-project fixture
built from `sample/` (the fixture helper is `test/_multiproject.js`, two copies of `sample/` under one
root, one copy deliberately diverged) — the partition, zero diagnostics on correct code in either
project, references and the rename config scan never crossing the project boundary, and the per-project
library registries including the Libraries-view union fallback when no project is specified.

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
