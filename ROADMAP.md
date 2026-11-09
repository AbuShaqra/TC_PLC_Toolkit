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
| 1 | R5 | Keep PROGRAMs as PROGRAMs; TwinCAT XML parsing fixes; re-add a deleted property Get/Set ([#25](https://github.com/AbuShaqra/TC_PLC_Toolkit/issues/25)) | 3 d | 2026-11-10 | 2026-11-12 | In review: PR [#27](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/27) — XAE check on the user's machine pending |
| 2 | R1 | Generate ST button keeps its rounded end in single-project workspaces | 0.5 d | 2026-11-13 | 2026-11-13 | Planned |
| 3 | R3.1 | STruC++ spike: sample project through the compiler under the TwinCAT dialect | 2 d | 2026-11-16 | 2026-11-17 | Planned |
| 4 | R4 | Objects-tree model (deepening roadmap P7) | 4 d | 2026-11-18 | 2026-11-23 | Planned — needs the user's Windows machine |
| 5 | R2 | Create a new TwinCAT project from the extension's start view | 6 d | 2026-11-24 | 2026-12-01 | Planned — needs a 4024 skeleton from the user's XAE |
| 6 | R3.2 | STruC++ check command with errors mapped to the panes | 5 d | 2026-12-02 | 2026-12-08 | Planned |
| 7 | R3.3 | STruC++ bundling, Node 22 discovery, licence files, settings, docs | 3 d | 2026-12-09 | 2026-12-11 | Planned |

**Total:** 23.5 working days, forecast to finish **2026-12-11**. All decisions are settled (2026-11-09);
targeting two TwinCAT versions added a day to R2, and R5 (added 2026-11-09, first by the user's choice)
added three.

**Why this order.**
1. **R5 first** (user's choice, 2026-11-09): a non-ST POU can hand the language server a method's code as
   its body, and a PROGRAM with methods is checked as a FUNCTION_BLOCK — every feature downstream reads
   wrong input until these are fixed. Issue #25 rides along: it is user-reported and touches the same
   module (`src/xmlParser.js`).
2. **R1 next:** half a day, isolated to the webview, and it fixes a visible defect now.
3. **R3.1 (spike) next:** the STruC++ work is the largest unknown. The spike needs no decisions, and what
   the compiler rejects on the sample decides the size of R3.2–R3.3 while other work proceeds.
4. **R4 before R2:** R2 adds an empty state and a create flow to the Objects tree, and R4 rebuilds the
   Objects tree's model. Doing R4 first means R2 is written once, against the new model.
5. **R2 then R3.2–R3.3:** R2 needs its templates made and proven in XAE on the user's machine, the same
   session R4's dev-host gate needs. R3.2–R3.3 build on what the spike finds.

### R5 — Keep PROGRAMs as PROGRAMs; TwinCAT XML parsing fixes; re-add property accessors

Five bug fixes and one suggestion from the user's 2026-11-06 notes (accepted 2026-11-06; line numbers
re-checked against `dev` @ `caa686d` on 2026-11-09), plus the user-reported issue #25 (added 2026-11-09).
The five fixes only show up on inputs the suite does not cover, so every fix lands with a fixture that
reproduces it first.

**Main change — keep PROGRAM a PROGRAM.** `src/stConverter.js:130-134` rewrites any PROGRAM that has methods
into a FUNCTION_BLOCK, on every path that uses the converter: the live path, the `.st` export and
find-references. TwinCAT does not do this, and it breaks callers: `MAIN.Init()` needs a PROGRAM, while a
function block needs an instance. The code comment says the rewrite is for trust-runtime, which is out of
date — the live path now feeds the toolkit's own language server (`src/livePath.js`). **Plan:** drop the
rewrite on every path (the closing keyword at `:277-281` then follows the real POU kind), and check that
`src/lsp/parser.js` scopes METHODs under a PROGRAM correctly (members, `THIS`/`SUPER`-free calls,
`MAIN.Init()` from another POU resolves).

**Parser fixes (`src/xmlParser.js`).**
1. **Non-ST POU takes a method's code as its body — the most serious.** `:71` reads the root implementation
   with `getCdata(rootContent, '<ST>', '</ST>')`, i.e. the first `<ST>` anywhere in the file. An SFC, LD,
   FBD or CFC POU with an ST method or action therefore shows that method's code as its own body. Fix: read
   only the root's own `<Implementation>` (before the first `<Method|Property|Action|Transition>`), and
   record the real implementation language on the component. **The write side has the same bug** (found
   2026-11-09): `replaceComponentCdata` (`:238-246`) saves the root implementation into the first `<ST>` in
   the file, so editing an SFC POU's "body" overwrites its method. Fix both.
2. **`getCdata` overrun** (`:31-41`): when the requested block has no CDATA, the search for `<![CDATA[`
   runs on into a later block. Bound the search to the requested element.
3. **Entities in attributes:** `parseAttrs` (`:14-22`) does not decode `&amp;`, `&lt;`, `&gt;`, `&quot;`,
   `&apos;` (or numeric references), so names and folder paths come through encoded. Decoding on read means
   every writer that rebuilds a `Name="…"`/`FolderPath="…"` match from a parsed value must encode (and
   regex-escape) it again, or edits to that component or folder silently stop matching.
4. **Lone CR line endings** are not turned into newlines (`stConverter.js:105` splits on `\r?\n` only).
5. **UTF-8 byte-order mark** is kept at the start of the text.

Fixes 3–5 are read-side only: writes must still preserve the file byte-for-byte outside the edited CDATA
(design constraint in CLAUDE.md), so normalise copies, never the text that is written back.

**Issue [#25](https://github.com/AbuShaqra/TC_PLC_Toolkit/issues/25) — re-add a missing Get or Set
accessor.** A user may delete a property's Get or Set accessor — typically in TwinCAT XAE, but it does not
matter where — and later want it back. The toolkit has no way to add one: the user has to delete the whole
property and create it again. Applies to properties of function blocks and of interfaces. A newly added property keeps getting **both**
accessors by default (it already does: `insertComponentIntoXml`, `src/xmlParser.js:509/:511`); the user can
delete either one and re-add it later. **Plan:** the
property node's right-click menu gets two separate entries, *Add Get Accessor* and *Add Set Accessor*, each
shown only while that accessor is missing (as in XAE). That needs the property node's `contextValue` to say which
accessors exist (`src/treeDataProvider.js:541-549` already looks up the Get/Set children) — and every
`viewItem == 'propertyNode'` menu clause in `package.json` must then match all the variants (`=~`) — plus an `xmlParser` insert that adds one accessor block in the shape
`insertComponentIntoXml` already writes (`:509` interface — declaration only; `:511` FB — declaration +
empty ST) with a fresh `Id`, Get placed before Set, and the file byte-for-byte unchanged elsewhere. Reply on
the issue when it ships.

**Suggestion — warn on dropped SFC transitions.** Transitions are silently dropped today; at least warn
(the user's suggestion, not a bug — decide the channel when the item starts: output log or a diagnostic).

**Done when.** Each fix has a fixture that failed before it; `test/test_live_path.js` still passes (it guards
the converter's line map); sample diagnostics stay at 0; a missing Get or Set can be added back, each on its
own, on both an FB and an interface property, and the result opens in XAE (user's machine);
`MAIN.Init()` on a PROGRAM resolves through definition and references; the suite, typecheck and lint pass.

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

**Decisions (settled 2026-11-09).**
1. **Approach:** (a) the template, with (b) XAE automation offered as well where TwinCAT is installed.
2. **Scope:** a new solution only (`.sln` → `.tsproj` → `.plcproj`) in an empty or project-less folder.
   Adding a PLC project to an existing solution is out of scope.
3. **TwinCAT version:** both 3.1.4026 and 3.1.4024, the user picks. The 4026 skeleton comes from the one
   XAE 3.1.4026.22 wrote for `sample/`; the 4024 skeleton must be produced by a 4024 XAE on the user's
   machine. Each template is proven to open and build in its own XAE version.
4. **Starter content:** `PROGRAM MAIN`, the `PlcTask` that calls it, and an empty GVL.

### R3 — Compile TwinCAT projects with STruC++

**Goal.** Compile a TwinCAT project from the extension with the IEC 61131-3 compiler STruC++ (fork:
`AbuShaqra/STruCpp`), selecting the TwinCAT dialect, and show the compiler's errors in the editor panes.

**What exists.**
- The fork (v0.7.0) has **dialect profiles**: JSON files selected with `--dialect`, `--dialect-file` or
  `--dialect-path` (`src/dialect.ts`, `docs/DIALECTS.md`). Profile features today: `program_methods`,
  `pointer_to`, `reference_to`, `ref_assign`.
- The TwinCAT 3 dialect profile is vendored in this repo as `resources/dialects/twincat3.json` (profile id
  `twincat3`, extends `iec`, enables all four features above). It is passed to the compiler with
  `--dialect-file`.
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
1. **R3.1 Spike** — run the `sample/` project's ST through the STruC++ CLI with `resources/dialects/twincat3.json`, under the
   TwinCAT dialect; list every construct it rejects. This sizes the rest.
2. **R3.2 Check command** — a *Check with STruC++* command that converts the project, runs the compiler as a
   full semantic check and maps its errors to the right component and pane (VS Code Problems + pane markers).
3. **R3.3 Packaging** — bundle the compiler, find a Node ≥ 22, ship the licence files, add settings (Node
   path, dialect file) and documentation.

**Decisions (settled 2026-11-09).**
1. **Output:** check only — errors in the panes, no files written, no `g++` needed. Generated C++ or a built
   program can be added later as a new roadmap item.
2. **Compiler source:** bundled in the VSIX (`dist/strucpp-bundle.cjs`), run as a separate process, shipped
   with its GPL licence and a link to its source.
3. **Node ≥ 22:** found on the user's machine (`PATH`, or a setting that names it). When none is found, the
   command explains what is missing and how to fix it. `engines.vscode` stays at `^1.66`.

## Backlog (not scheduled)

Each waits for the reason recorded in [docs/handoff-findings.md](docs/handoff-findings.md) "Deferred work".

- Indexing: memoize `collectSignatureFiles` per root; non-blocking per-project scan; persisted archive cache.
- Rename: `.plcproj` sync inside the rename transaction; rename sibling interface implementors.
- L1 reverse index for references — only past ~1000 files or > 200 ms.
- Tooling: ESLint 10; `brace-expansion` dev advisory.
- Language: nested block comments; pragma hover.

## Done

Shipped work lives in git history and the [releases](https://github.com/AbuShaqra/TC_PLC_Toolkit/releases).
Roadmap items finished from now on are listed here with their PR.

- *(none yet)*
