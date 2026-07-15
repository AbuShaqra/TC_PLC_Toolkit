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
npm test
```

This chains every harness listed in the `test` script of `package.json`. The main ones:

| Harness | What it checks |
|---------|----------------|
| `scratch/test_lsp_features.js` | Core LSP: completions, go-to-definition (incl. call parameters), references, diagnostics, on synthetic `.st` units. |
| `scratch/test_sample_diagnostics.js` | **Diagnostics ratchet** on the real `sample/` TwinCAT project. The sample is valid code, so every diagnostic on it is a false positive; the harness measures them the way the LSP server does, prints a per-category breakdown, and **fails if the total rises above the `BASELINE_DIAGNOSTICS` constant** at the top of the file. An improvement passes and prints the value the baseline can be lowered to. The target — currently met — is zero. |
| `scratch/test_live_path.js` | The live editor pipeline: full-file ST assembly, cursor mapping, per-pane diagnostics, member completion through references, method return types, token-aware and cross-file references. |
| `scratch/test_typecheck.js` | Semantic type checking: member access, call arguments, declaration types, assignment compatibility (strict assertions against a self-contained fixture) — plus the same `sample/` diagnostics ratchet. |
| `scratch/test_references_tree.js` | References-view grouping (file → component → occurrence). |
| `scratch/test_library_catalog.js` | The data path behind the TwinCAT Libraries view: catalog built from the `.plcproj`, namespaces, `.tmc` types and their members. |

The sample-based harnesses need a TwinCAT project under `sample/` (git-ignored); if it is absent they
skip cleanly, so `npm test` still passes. `test_live_path.js` additionally skips the individual tests
that address specific sample objects when the sample at hand does not contain them.

Each harness also runs on its own, e.g. `node scratch/test_live_path.js`. A few more live in
`scratch/` outside `npm test`: `test_lsp_parser.js`, `test_lsp_types_sync.js`,
`test_method_diagnostics.js`.

**`sample/` is ground truth.** It is a real, *correct* TwinCAT project, so every diagnostic reported
on it is a bug. Never fix a red gate by raising the baseline.

## Architecture

```
extension.js            Activation, commands, file watchers, LSP client bootstrap
src/
  customEditorProvider  Webview host: assembles full-file ST, bridges Monaco ↔ LSP, writes CDATA back
  treeDataProvider      "TwinCAT Objects" explorer tree
  libraryTreeProvider   "TwinCAT Libraries" explorer tree (library → types → members)
  referencesProvider    "TwinCAT References" results view (+ referencesTree grouping)
  xmlParser             Regex-based TwinCAT XML parse / structural edits (preserves formatting)
  stConverter           XML → clean Structured Text + line map (also a raw mode for the live path)
  typesCache            Workspace type index for the webview
  plcProjHelper         Keeps the .plcproj file in sync on create/delete
  lsp/
    server.js           LSP server (Node IPC) + custom JSON-RPC bridge requests
    parser.js           Structured Text lexer + symbol parser
    features.js         Completions, definition, references, diagnostics
    builtins.js         Standard IEC/TwinCAT types, keywords, functions/FBs
    types.js            Type model, resolver, member lookup, assignability
    exprParser.js       Expression type inference (for assignment checks)
    xmlIndexer.js       Indexes TwinCAT XML objects into real-range symbol nodes
    libraries.js        Library namespaces, read from the .plcproj
    libsymbols.js       Library symbols: ZIP reader over the library archives + the project's .tmc
media/
  editor.js / editor.css  Monaco webview front-end (two panes, providers, sync)
```

Three processes cooperate, with the extension host as the hub — **the webview never talks to the
language server directly**. The extension bridges them over custom JSON-RPC requests
(`custom/completions`, `custom/definition`, `custom/references`, `custom/diagnostics`, …) layered on
the standard LSP transport (Node IPC).

### The live language-feature path

A pane cannot be analysed on its own: methods, properties and actions need the whole POU in scope. So
for each request the extension assembles the **entire** document into one Structured Text compilation
unit (applying the webview's unsaved edits as an overlay first), maps the pane-local cursor into that
unit, queries the LSP, and maps the results back to the right component and pane via a line map.

Changing `stConverter.js` output or `xmlParser.js` component extraction can silently break that
mapping; `scratch/test_live_path.js` guards it.

### Writes

On save, only the edited `<![CDATA[ ... ]]>` blocks are rewritten. The surrounding XML is preserved
byte-for-byte, so TwinCAT and version control never see spurious diffs.

### Library symbols

`src/lsp/libsymbols.js` indexes ~32k symbols in about 200 ms and registers them into the workspace
index **on demand, per document** — registering them all up front took the diagnostics pass from 1.5 s
to 78 s, because `Object.keys()` on the index runs per identifier. Three sources feed it (archives,
the project `.tmc`, the `.plcproj` namespaces) and all three are load-bearing; dropping any one
resurrects false positives. See [HANDOFF.md](HANDOFF.md) for the details and the traps.

Note that `_Libraries/` and the `.tmc` are git-ignored, so a fresh clone has neither and will measure
~171 diagnostics on the sample rather than 0. The harnesses detect this and assert against the right
baseline.
