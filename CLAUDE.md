# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Handoff file — read this first, keep it current

**At the start of every session, read [HANDOFF.md](HANDOFF.md) before doing anything else.** It carries what this file cannot: the *current* state of the work — what changed recently and whether it is committed, which tests pass or fail and why, known bugs with their root causes, and the pending task pipeline with the decisions already made. CLAUDE.md describes the project as it is designed; HANDOFF.md describes where the work actually stands right now.

**Keep it updated as you work.** Update HANDOFF.md whenever you:
- finish a task, or leave one deliberately unfinished (say what remains and why);
- discover a bug, root-cause it, or decide not to fix it (record the finding — a diagnosis you throw away gets re-derived at cost);
- change test status (a new harness, a newly failing or newly passing gate);
- make or receive a decision that constrains future work (record the decision *and its rationale*);
- commit, so "uncommitted work" stays accurate.

Rules for the file: it reflects the present, not a changelog — replace stale entries instead of appending to them, and delete items once they are done and committed. Never let it contradict the repo; if they disagree, the repo wins and HANDOFF.md is what needs fixing. Prefer specifics (`file:line`, real counts, real error text) over summaries.

**Keep HANDOFF.md under 100 lines.** It is read at the start of every session, so length is a real cost. Treat going over as a signal to prune, not to append: delete what is finished, and fold detail into the git history or a linked file. But the limit serves the reader, not the other way round — if information is genuinely necessary to act and cannot be shortened without losing it, keep it and run over. Never drop or garble a real finding just to hit the number.

## Shared memory — read it, and write to it

`.claude/memory/` holds the lessons this project has already paid for, **version-controlled in the
repo** so they follow the work to any machine. A `SessionStart` hook (declared in the committed
`.claude/settings.json`) injects a one-line-per-note digest at the start of every session; cloning the
repo is the whole setup. **If that digest is not in context — a machine with hooks disabled, a
different harness — read `.claude/memory/README.md` and the notes yourself before starting work.**

The digest is an *index*. When a note covers what you are about to do, open the file: the one-liner
cannot carry the incident that produced the rule, and the incident is the part that changes behaviour.

Your per-machine auto-memory (`~/.claude/projects/<sanitized-cwd>/memory/`) still applies and still
loads. The two are complementary:

- **`.claude/memory/` (shared, committed)** — anything about working on *this* project that would
  still be true on a fresh clone on someone else's laptop.
- **per-machine bank** — local paths, installed TwinCAT versions, personal tooling, preferences that
  are yours rather than the project's.

**When you learn something the hard way here, write it to `.claude/memory/`, not the local bank.**
One file per note, `<slug>.md` where the slug equals the frontmatter `name`; format and the bar for
adding one are in `.claude/memory/README.md`. There is no index to update — `bank.js` builds the
digest from the files. It is version-controlled, so it lands in the next commit like any other change;
do not commit it on its own unless asked.

Do not duplicate what the repo already records: architecture belongs in DEVELOPMENT.md, present state
in HANDOFF.md, the rules of the codebase here. The bank is for how to *work* — the judgement no other
file carries. `node .claude/memory/bank.js --check` validates it, and `test/test_memory_bank.js` runs
that in the suite.

## Keep DEVELOPMENT.md current — always

[DEVELOPMENT.md](DEVELOPMENT.md) is the durable developer guide (build, run-from-source, tests, architecture). Unlike HANDOFF.md (which tracks the *present state* of the work), DEVELOPMENT.md describes how the project is *built and laid out* — so **whenever a change makes it stale, update it in the same change.** In particular, update DEVELOPMENT.md when you:
- add/remove/rename a source module or move responsibility between them, or otherwise change the **architecture** (the file map, the process split, or the live-language-feature path);
- change the **test layout or commands** (a new/renamed/removed harness, a change to how `npm test` / `test/run.js` runs, the type-check gate, or CI);
- change **build or packaging** (the no-build-step invariant, the VSIX command, the offline/Monaco-vendoring constraint).

It ships to no user (it is `.vscodeignore`d), so it has no length budget like HANDOFF — but it must never contradict the repo. If they disagree, the repo wins and DEVELOPMENT.md is what needs fixing.

## What this is

A VS Code extension ("TwinCAT PLC Toolkit", id `twincat-plc-toolkit`) that opens Beckhoff TwinCAT PLC source files (`.TcPOU`, `.TcGVL`, `.TcDUT`, `.TcIO`) in a custom two-pane Monaco editor, hiding the XML wrapper around the Structured Text (IEC 61131-3) code, backed by a fully offline built-in language server, plus explorers for the project's objects and its libraries.

It was renamed from "TwinCAT XML Viewer" once it grew past viewing. Internal identifiers still use the `twincat.*` prefix and the custom editor is still `twincat.xmlViewer` — those are deliberate, not leftovers: renaming them would break saved keybindings and editor associations for no user-visible gain.

Plain CommonJS JavaScript throughout — **no build/transpile step**. `extension.js` is the entry point and is loaded directly. There is a **type-check-only** gate (`npm run typecheck` → `tsc --noEmit`, config in `tsconfig.json`) that leans on the existing JSDoc as a safety net; it never emits, so the runtime stays plain JS. No linter.

## Commands

```bash
npm install          # install dependencies
npm test             # run the whole suite via test/run.js (standalone Node, no VS Code needed)
npm run typecheck    # type-CHECK only (tsc --noEmit); no emit — the extension still ships plain JS

# Run a single test harness directly:
node test/test_lsp_features.js       # core LSP: completions, definition, references, diagnostics
node test/test_sample_diagnostics.js # zero-false-positive gate on the real sample/ project
node test/test_live_path.js          # live editor pipeline: ST assembly, cursor mapping, per-pane diagnostics
node test/test_typecheck.js          # semantic type checks (member access, call args, assignments)
node test/test_references_tree.js    # references-view grouping
node test/run.js references          # run only suites whose name matches a substring

# Package a VSIX:
npx @vscode/vsce package --allow-missing-repository --skip-license
```

Manual testing: open this repo in VS Code, press **F5** ("Run Extension") to launch an Extension Development Host, open a TwinCAT project folder there. After code changes, **Ctrl+R** in the dev-host window to reload.

The suite lives in `test/` (run by `test/run.js`, which runs each harness in its own process and reports per-suite without aborting on the first failure). The sample project under `sample/` is **wholly synthetic and committed** (created by driving XAE once via `scripts/build-sample-solution.ps1`, then filled by `scripts/build-sample-project.js`), so the sample-based harnesses run on a fresh clone and on CI. They still skip cleanly if a fixture is missing, and the runner reports the run as **FULL** or **REDUCED** and lists any gate that did not run. Use `REQUIRE_FULL_SUITE=1 npm test` to make a degraded run fail instead. `test/browser/` holds the browser harnesses for `media/editor.js` — deliberately outside `npm test` (they need Playwright and a real Chromium), so **run them by hand whenever the webview changes**. `scratch/` is a **git-ignored local playground**: nothing in it is tracked, so anything worth keeping belongs in `test/` or `scripts/`. CI (`.github/workflows/ci.yml`) runs `npm run typecheck` then `npm test` on every push/PR to `main`.

## Architecture

Three processes cooperate; the extension host is the hub — **the webview never talks to the LSP directly**:

1. **Webview** (`media/editor.js` + `media/editor.css`) — two Monaco panes (Declaration / Implementation) per component, with Monaco vendored under `media/monaco-editor/` (offline). Registers Monaco providers that forward requests to the extension via `postMessage`.
2. **Extension host** (`extension.js`, `src/customEditorProvider.js`) — activation, commands, file watchers, tree views, and the LSP bridge.
3. **LSP server** (`src/lsp/server.js`) — spawned over Node IPC via `vscode-languageclient`. Besides standard LSP, it answers custom JSON-RPC requests used by the bridge: `custom/completions`, `custom/definition`, `custom/references`, `custom/diagnostics`, `custom/updateDocument`, `custom/updateTypesMap`, `custom/reindex`, `custom/setDiagnosticsConfig`, `custom/indexXmlDocument`.

### The live language-feature path (the core trick)

Language features on a pane can't be answered from that pane alone — methods/properties/actions need the whole POU in scope. So for each request, `customEditorProvider.js`:

1. Parses the backing XML (`src/xmlParser.js`) and applies the webview's **unsaved edits as an overlay** on the active component (`assembleSt`).
2. Converts the whole file into **one Structured Text compilation unit** via `src/stConverter.js` in `raw` mode, which also returns a `lineMap` (component → decl/impl line ranges in the unit).
3. Translates pane-local Monaco positions to absolute unit positions (`localToAbsolute`), queries the LSP, and maps results back to the right component/pane (`absoluteToLocal`).

Changing `stConverter.js` output or `xmlParser.js` component extraction can silently break this mapping — `test/test_live_path.js` guards it.

### Other key pieces

- **`src/xmlParser.js`** — regex-based (not a DOM parser) TwinCAT XML parse and structural edits, deliberately preserving TwinCAT's exact formatting/metadata (`LineIds`, UUIDs, folders). Edits are written back into the original `<![CDATA[...]]>` via `replaceComponentCdata`.
- **`src/typesCache.js`** — workspace-wide type index, broadcast to every open webview (`updateTypesMap` message) and pushed to the LSP (`custom/updateTypesMap`) whenever files change.
- **`src/lsp/`** — `parser.js` (ST lexer/symbol parser), `features.js` (completions/definition/references/diagnostics), `types.js` (type model, resolver, assignability), `exprParser.js` (expression type inference), `builtins.js` (standard IEC/TwinCAT types and functions), `xmlIndexer.js` (indexes TwinCAT XML into symbol nodes with real ranges), `libraries.js` (library *namespaces* from the `.plcproj`), `libsymbols.js` (library *symbols*: a dependency-free ZIP reader over the `.compiled-library` archives, plus the project's `.tmc` type system).
- **`src/treeDataProvider.js`** — "TwinCAT Objects" explorer; create/delete of files, folders, methods, properties, actions. `src/plcProjHelper.js` keeps the nearest `.plcproj` in sync on create/delete.
- **`src/referencesProvider.js` / `referencesTree.js`** — "TwinCAT References" panel for cross-file/cross-component usages (the inline peek widget is limited to the active component's panes by the split-pane design).

## Design constraints

- **Diagnostics are conservative by design**: anything that cannot be fully resolved must never be flagged. `sample/` is a *correct* TwinCAT project — **it is the ground truth, so every diagnostic on it is a bug.** It sits at **zero** against a baseline of **zero** (no slack), and `test/test_sample_diagnostics.js` / `test/test_typecheck.js` ratchet that: they fail if the count rises. New checks must hold the line at zero. The sample is committed, so **these gates now run on CI** — but a run is labelled FULL or REDUCED by `test/run.js`, and `REQUIRE_FULL_SUITE=1` makes a degraded run a hard failure.
- **External symbols are indexed, not guessed** (`src/lsp/libsymbols.js`). Three sources, and all three are needed — dropping any one resurrects false positives:
  - `.compiled-library` / `.compiled-library-ge33` / `.library` — ZIP containers; symbol names live in a `__shared_data_storage_string_table__` entry. **`.compiled-library-v3` is an opaque non-ZIP format** (magic `10 a6 d5 a7`) and is deliberately skipped.
  - the project's **`.tmc`** (TwinCAT type system export, plain XML). Not optional: some types the project resolves appear in *no* readable archive.
  - the `.plcproj` namespaces (`src/lsp/libraries.js`).
  Symbols are registered into the workspace index **on demand, per document** — never all at once. Registering all of them up front took the diagnostics pass from 1.5 s to 78 s (measured on a ~32k-symbol customer project), because `Object.keys()` on the index is called per identifier.
  Note `_Libraries/` (Beckhoff vendor binaries) and the `.tmc` are **git-ignored**, so a clone has neither. The synthetic sample names no Beckhoff symbol, so its baseline is **0 in every mode** — `test/_baseline.js` records how each row was measured. Don't "fix" a failing gate by raising a baseline.
- The webview must stay **fully offline** — no CDN loads; Monaco is vendored in `media/monaco-editor/`.
- File writes must preserve TwinCAT's XML structure byte-for-byte outside the edited CDATA blocks, or TwinCAT/version control will see spurious diffs.
