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
npx @vscode/vsce package
code --install-extension twincat-plc-toolkit-<version>.vsix --force
```

On Windows, `scripts\install-vsix.bat` picks the newest `.vsix` in the folder and installs it with whichever
`code` CLI it can find.

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
| `test/test_plcproj_scope.js` | The index is scoped to the `.plcproj`, not the filesystem: `collectPlcProjObjectPaths` lists the `<Compile>`d objects, and `indexTwinCatDirectory` skips on-disk objects outside that set so a backup/orphan copy (a duplicate object name) cannot win the name-keyed index and steal a real object's references. Includes the no-`.plcproj` index-all fallback and a sample-coverage check proving the gate is a no-op on the ratchet. |

`test/run.js <substring>` filters to matching suites. `test/_baseline.js` holds the machine-dependent
diagnostic baselines the sample gates assert against.

The sample-based harnesses run against the committed synthetic project under `sample/`. They still skip
cleanly if a fixture they need is absent, so `npm test` passes even on a pruned tree — but the runner
labels such a run REDUCED rather than letting it pass for FULL.

A few experimental probes live in `scratch/` outside `npm test`: `test_lsp_parser.js`,
`test_lsp_types_sync.js`, `test_method_diagnostics.js` (plus `make_icon.js`, `probe_lib_format.js`).

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
  dndRules              Objects-tree drag & drop + copy/paste compatibility matrices (vscode-free, so testable)
  renameEngine          Rename: maps LSP reference positions back into CDATA splices (vscode-free, so testable)
  treeDragAndDrop       Objects-tree drag & drop controller — executes the matrix's plans (needs VS Code 1.66+)
  libraryTreeProvider   "TwinCAT Libraries" explorer tree (library → types → members)
  referencesProvider    "TwinCAT References" results view (+ referencesTree grouping)
  objectKinds           Kind → codicon → tooltip for the Objects tree (vscode-free, so it is testable)
  xmlParser             Regex-based TwinCAT XML parse / structural edits (preserves formatting)
  stConverter           XML → clean Structured Text + line map (also a raw mode for the live path)
  typesCache            Workspace type index for the webview
  plcProjHelper         Keeps the .plcproj file in sync on create/delete
  lsp/
    server.js           LSP server (Node IPC) + custom JSON-RPC bridge requests; owns the workspace index
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
    librarySignatures.js  Parses library-signatures.xml (function sigs, FB I/O, global constants)
    browserCache.js       Reads TwinCAT's per-library browsercache → FB/interface method + property NAMES
media/
  editor.js / editor.css  Monaco webview front-end (two panes, providers, sync)
```

The workspace index is **scoped to the `.plcproj`**: at startup (and on `custom/reindex`) the server
collects the objects the project actually `<Compile>`s (`collectPlcProjObjectPaths`) and indexes only
those, so a backup or orphan copy on disk — a duplicate object name absent from the project — cannot
win the name-keyed index and shadow the real object. With no `.plcproj` under any root it falls back
to indexing every object file found (fresh clone, or a loose folder of TwinCAT files).

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

Note the **Beckhoff** archives under `_Libraries/` are git-ignored, so a fresh clone has only the
committed MIT archive. That changes how many external symbols resolve, not the diagnostic count: the
synthetic sample names no Beckhoff symbol, so every baseline row measures 0. `test/_baseline.js` records
how each row was measured.
