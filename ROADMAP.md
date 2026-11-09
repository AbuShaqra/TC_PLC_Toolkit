# TwinCAT PLC Toolkit — Roadmap

The order of planned work for the extension. **This file is the source of truth**; the published page
(<https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv>) is rendered from it by hand out of `docs/roadmap.html`.
Keep both current in the same change — rules in [CLAUDE.md](CLAUDE.md) ("Keep the roadmap current").

**Last updated:** 2026-11-09 · **Current release:** v0.10.1

How to read it: items run top to bottom in the **Order** column. IDs are stable names and do not change
when the order does. Estimates are working days for one developer; start and end dates are **forecasts**
over working days (Mon–Fri) assuming the items run one after another. An item may start early once the
items before it are done. Only the order is binding. When an item slips, update its dates and every date
after it. An item leaves the table for "Done" once its PR is merged into `dev`, with the PR number.

## Order of work

| Order | ID | Item | Estimate | Start | End | Status |
|-------|----|------|----------|-------|-----|--------|
| 1 | R1 | Generate ST button keeps its rounded end in single-project workspaces | 0.5 d | 2026-11-10 | 2026-11-10 | Planned |
| 2 | R3.1 | STruC++ spike: sample project through the compiler under the TwinCAT dialect | 2 d | 2026-11-11 | 2026-11-12 | Planned |
| 3 | R4 | Objects-tree model (deepening roadmap P7) | 4 d | 2026-11-13 | 2026-11-18 | Planned — needs the user's Windows machine |
| 4 | R2 | Create a new TwinCAT project from the extension's start view | 5 d | 2026-11-19 | 2026-11-25 | Planned — decisions open |
| 5 | R3.2 | STruC++ compile command with errors mapped to the panes | 5 d | 2026-11-26 | 2026-12-02 | Planned — decisions open |
| 6 | R3.3 | STruC++ packaging, licence files, settings, docs | 3 d | 2026-12-03 | 2026-12-07 | Planned — decisions open |

**Total:** 19.5 working days, forecast to finish **2026-12-07**.

**Why this order.**
1. **R1 first:** half a day, isolated to the webview, and it fixes a visible defect now.
2. **R3.1 (spike) next:** the STruC++ work is the largest unknown. The spike needs no decisions, and what
   the compiler rejects on the sample decides R3's size and the open R3 questions while other work proceeds.
3. **R4 before R2:** R2 adds an empty state and a create flow to the Objects tree, and R4 rebuilds the
   Objects tree's model. Doing R4 first means R2 is written once, against the new model.
4. **R2 then R3.2–R3.3:** both need the user's decisions (listed under each item). R2 also needs the
   template proven in XAE on the user's machine, the same session R4's dev-host gate needs.

### R1 — Generate ST button: rounded end in single-project workspaces

**Problem.** The Generate ST control is a split button: the main button plus a caret (`▾`) that opens the
project picker. The caret is shown only when the workspace has two or more PLC projects. With one project
the caret is hidden, but the main button still has its right corners squared off, so it looks cut off.

**Cause (verified).** `media/editor.css:413-416` squares the main button's right corners unconditionally
(`.split-btn #generate-st-btn`). The caret starts `hidden` (`src/customEditorProvider.js:559`) and
`media/editor.js` only shows it for 2+ projects.

**Plan.** Square the corners only while the caret is visible: `media/editor.js` toggles a class on
`#generate-st-group` together with the caret's `hidden` flag, and the CSS rule keys on that class.
CSS `:has()` would avoid the class but is unsafe: `engines.vscode ^1.66` ships a Chromium that predates it.

**Done when.** Both states look right in the dev host (one project, several projects), and the browser
harnesses (`test/browser/run.js`, `run_pragmas.js`) pass, since the webview changed.

### R4 — Objects-tree model (deepening roadmap P7)

**Goal.** Give the TwinCAT Objects view a real, VS Code-free node model, so the tree provider becomes a thin
adapter. The last open phase of the deepening roadmap
(`docs/superpowers/plans/2026-08-22-deepening-roadmap.md`, "Phase 7 — Candidate 05").

**Plan.** Create `src/objectsTreeModel.js`: a node graph with parent links, children and stable ids. It also
takes over the "fewer than two projects → flat tree" rule, which today sits in the LSP-ownership module
`src/lsp/projectMap.js`. `src/treeDataProvider.js` then answers `getParent` from `node.parent` and
`getChildren` from `node.children`. `test/test_tree_reveal.js` stops patching module resolution, because the
model needs no `vscode` stub. New harness: `test/test_objects_tree_model.js`.

**Done when.** `getParent` does no linear scans and builds no sibling nodes; `contextValue` and id are set in
one place; the suite and typecheck pass; and **`node test/devhost/run.js` passes on the user's Windows
machine**. That gate is mandatory: reveal ancestry and tab identity are exactly what this changes, and
headless gates missed the 0.6.0 duplicate-tab regression in this area.

### R2 — Create a new TwinCAT project from the extension

**Goal.** A user with no TwinCAT project in the workspace (or an empty folder) can create one from the
extension, starting from its start view, without opening TwinCAT XAE first.

**Start view.** The TwinCAT Objects view has no empty-state content today (`package.json` `viewsWelcome`
covers only the References and Libraries views). Add one with a **Create TwinCAT Project** button bound to a
new command; the same command goes in the Command Palette.

**Key constraint (from earlier work).** A TwinCAT solution is `.sln` → `.tsproj` → `.plcproj`, and only XAE
has ever written a skeleton that XAE accepts: hand-written ones were refused, and the on-disk template is a
67-byte stub that XAE expands at insertion time (see `docs/handoff-findings.md`, "`sample/` is GROUND TRUTH").
Two ways around it:

- **(a) Template from an XAE-made skeleton** — ship a skeleton XAE produced (as `sample/` was made), and on
  create copy it, rename it and regenerate every identity GUID. Works offline, on any OS, without TwinCAT
  installed. Must be proven to open and build in XAE before it ships.
- **(b) Drive XAE** — automate XAE as `scripts/Create sample PLC project/build-sample-solution.ps1` already
  does. Always valid output, but Windows-only and needs TwinCAT installed.

**Decisions open.** (1) approach (a), (b), or (a) with (b) where TwinCAT is present; (2) what gets created —
a full solution, or a PLC project added to an existing solution as well; (3) which TwinCAT version the
template targets; (4) starter content (an empty `MAIN`, a task, a GVL?).

### R3 — Compile TwinCAT projects with STruC++

**Goal.** Compile a TwinCAT project from the extension with the IEC 61131-3 compiler STruC++ (fork:
`AbuShaqra/STruCpp`), selecting the TwinCAT dialect, and show the compiler's errors in the editor panes.

**What exists.**
- The fork (v0.7.0) has **dialect profiles**: JSON files selected with `--dialect`, `--dialect-file` or
  `--dialect-path` (`src/dialect.ts`, `docs/DIALECTS.md`). Profile features today: `program_methods`,
  `pointer_to`, `reference_to`, `ref_assign`.
- The TwinCAT profile is `twincat3.json` in Lemvane (`adapters/plc-strucpp/src/plc_strucpp/dialects/`).
  **It is vendored as a single file and is the only thing taken from Lemvane**; Lemvane is otherwise
  read-only to this project and nothing else is copied or referenced from it. Record provenance next to the copy.
- The toolkit already turns TwinCAT XML into one ST compilation unit per object with a line map back to each
  pane (`src/stConverter.js`, the live path) — the compiler's input, and the route for mapping its errors back.

**Constraints to respect.**
- **Licence:** STruC++ is GPL-3.0-only (with a runtime-library exception for compiled programs); this
  extension is MIT. Keep the compiler a separate program the extension runs as a process — never
  `require()` it into the extension — and ship its licence and source reference with any bundled copy.
- **Runtime:** STruC++ needs Node ≥ 22; the extension supports VS Code ≥ 1.66, whose bundled Node is older.
- **Offline:** the extension must work offline, so a bundled compiler (`npm run build:bundle` →
  `dist/strucpp-bundle.cjs`) fits better than a download on first use.
- Turning the generated C++ into a binary needs `g++`; checking and generating C++ does not.

**Phases** (scheduled separately in the table above).
1. **R3.1 Spike** — vendor `twincat3.json`; run the `sample/` project's ST through the STruC++ CLI under the
   TwinCAT dialect; list every construct it rejects. This sizes the rest.
2. **R3.2 Compile command** — a *Compile with STruC++* command that converts the project, runs the compiler and
   maps errors to the right component and pane (VS Code Problems + pane markers).
3. **R3.3 Packaging** — bundle or locate the compiler, licence files, settings (compiler path, dialect, output
   folder), documentation.

**Decisions open.** (1) what "compile" produces: checking only, generated C++, or a built binary; (2) bundle
the compiler in the VSIX or use one the user installs; (3) how to supply Node ≥ 22 (raise `engines.vscode`,
or find a Node on the user's machine).

## Backlog (not scheduled)

Carried from [HANDOFF.md](HANDOFF.md) "Open / deferred"; each waits for the reason given there.

- Indexing: memoize `collectSignatureFiles` per root; non-blocking per-project scan; persisted archive cache.
- Rename: `.plcproj` sync inside the rename transaction; rename sibling interface implementors.
- L1 reverse index for references — only past ~1000 files or > 200 ms.
- Tooling: ESLint 10; `brace-expansion` dev advisory.
- Language: nested block comments; pragma hover.

## Done

Shipped work lives in git history and the [releases](https://github.com/AbuShaqra/TC_PLC_Toolkit/releases).
Roadmap items finished from now on are listed here with their PR.

- *(none yet)*
