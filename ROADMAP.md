# TwinCAT PLC Toolkit — Roadmap

The order of planned work for the extension. **This file is the source of truth**; the published page
(<https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv>) is rendered from it by hand out of `docs/roadmap.html`.
Keep both current in the same change — rules in [CLAUDE.md](CLAUDE.md) ("Keep the roadmap current").

**Last updated:** 2026-11-09 (R5, R1 merged) · **Current release:** v0.10.1

How to read it: items run top to bottom in the **Order** column. IDs are stable names and do not change
when the order does. Estimates are working days for one developer; start and end dates are **forecasts**
over working days (Mon–Fri) assuming the items run one after another. An item may start early once the
items before it are done. Only the order is binding. When an item slips, update its dates and every date
after it. An item leaves the table for "Done" once its PR is merged into `dev`, with the PR number.

## Order of work

| Order | ID | Item | Estimate | Start | End | Status |
|-------|----|------|----------|-------|-----|--------|
| 1 | R3.1 | STruC++ spike: sample project through the compiler under the TwinCAT dialect | 2 d | 2026-11-10 | 2026-11-11 | Findings done 2026-11-09 ([docs/r3.1-strucpp-spike.md](docs/r3.1-strucpp-spike.md)); decisions taken |
| 2 | R4 | Objects-tree model (deepening roadmap P7) | 4 d | 2026-11-12 | 2026-11-17 | Code done 2026-11-09 (suite 84/84 FULL) — PR open; the mandatory dev-host gate needs the user's Windows machine before merge |
| 3 | R2 | Create a new TwinCAT project from the extension's start view | 6 d | 2026-11-18 | 2026-11-25 | Planned — needs a 4024 skeleton from the user's XAE |
| 4 | R3.2 | STruC++ check command with errors mapped to the panes | 7 d | 2026-12-10 | 2026-12-18 | Planned (full scope, 2026-11-09) — after S2 |
| 5 | R3.3 | STruC++ bundling, Node 22 discovery, licence files, settings, docs | 3 d | 2026-12-21 | 2026-12-23 | Planned |

**Total remaining (toolkit lane):** 22 working days of work, forecast to finish **2026-12-23** (it waits for S2). Decisions taken 2026-11-09
after the R3.1 spike (`docs/r3.1-strucpp-spike.md`): **wait for the fork** — the check command must not put compiler
errors on correct code, so the gaps are fixed in STruC++ first (S2, fork lane); **R3.2 takes its full scope**
(5 → 7 d).

## STruC++ fork lane (parallel)

Work in the compiler fork (`AbuShaqra/STruCpp`, branch `development`, GPL-3.0-only — its code stays there; read
its CLAUDE.md first). It runs **alongside** the toolkit lane (user's call, 2026-11-09); the toolkit only waits
for it where a row says so.

| Order | ID | Item | Estimate | Start | End | Status |
|-------|----|------|----------|-------|-----|--------|
| 1 | S2 | Close the fork's gaps: 14 PR-sized steps (plan: [docs/s2-strucpp-fork-plan.md](docs/s2-strucpp-fork-plan.md)) | 22.5 d | 2026-11-10 | 2026-12-09 | In progress — steps 1 (fork PR #5), 1b (#6), 2 (#7) and 3 (#8) merged 2026-11-09; step 4 next. R3.2 waits for it |

**Why this order.**
1. **R3.1 (spike) first:** the STruC++ work is the largest unknown. The spike needs no decisions, and what
   the compiler rejects on the sample decides the size of R3.2–R3.3 while other work proceeds.
2. **R4 before R2:** R2 adds an empty state and a create flow to the Objects tree, and R4 rebuilds the
   Objects tree's model. Doing R4 first means R2 is written once, against the new model.
3. **R2, then R3.2–R3.3 once S2 is merged:** R2 needs its templates made and proven in XAE on the user's machine, the same
   session R4's dev-host gate needs. S2 (fork lane) comes before R3.2 because a check command that flags correct code is
   worse than none (decided 2026-11-09); R3.2–R3.3 then build on a compiler that accepts the sample.

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

### S2 — STruC++ fork: close the gaps the spike found

**Plan:** [docs/s2-strucpp-fork-plan.md](docs/s2-strucpp-fork-plan.md) — the R3.1 spike, a first S2 design and
the user's compiler findings document merged and checked against the IEC 61131-3 Ed. 3 text (clause numbers
and paraphrase only; the copy used is licensed to another party, so no text is reproduced).

**Decided 2026-11-09:** all 13 steps plus step 1b (about 22.5 d), one PR each into the fork's `development`; `iec` means Ed. 3, and the built-in profile is renamed `iec-3` with no `iec` alias (so an `iec-4` can be added later; `iec` is refused with an error naming `iec-3`);
standard forms always on (a wrongly refused standard construct is a defect fix), vendor forms behind new
vendor-neutral features that no profile enables by default (`self_caret`, `property`, `postfix_enum_base`,
`named_global_lists`, `struct_extends`, `union_type`, `fb_init`); chained comparisons follow Annex A;
`--check --json`.

**Order:** 1 lexer positions + `--check --json` → 1b `iec-3` profile id (no alias) → 2 pragmas (R3.2 can use the check from here) → 3 `SUPER.` /
`self_caret` → 4 member-chain calls → 5 interface variables → 6 interface properties (standard gaps closed,
11 d) → 7 chained comparisons → 8 postfix enum base → 9 named global lists → 10 struct inheritance → 11–12
UNION → 13 FB_init (the sample compiles with no workarounds).

**Later fork items, not S2** (sizes from the plan, not measured): other Ed. 3 forms the fork refuses (CHAR,
LTIME, string index, `STRING[n]`, typed TRUNC, `STRUCT OVERLAP`; about 7–10 d); an `iec` audit that narrows
what `iec` accepts; runtime safety defects; profile-handling defects; strict-mode policy for vendor profiles;
an Ed. 4 profile.

### R3 — Compile TwinCAT projects with STruC++

**Goal.** Compile a TwinCAT project from the extension with the IEC 61131-3 compiler STruC++ (fork:
`AbuShaqra/STruCpp`), selecting the TwinCAT dialect, and show the compiler's errors in the editor panes.

**What exists.**
- The fork (v0.7.0) has **dialect profiles**: JSON files selected with `--dialect`, `--dialect-file` or
  `--dialect-path` (`src/dialect.ts`, `docs/DIALECTS.md`). Profile features today: `program_methods`,
  `pointer_to`, `reference_to`, `ref_assign`.
- The TwinCAT 3 dialect profile is vendored in this repo as `resources/dialects/twincat3.json` (profile id
  `twincat3`, extends `iec-3` (the fork renamed `iec` to `iec-3`, S2 step 1b), enables all four features above). It is passed to the compiler with
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
2. **R3.2 Check command** (full scope, 7 d, decided 2026-11-09; after fork item S2) — a line-preserving *check* emitter in
   the converter (members before the POU body, pragmas blanked, IEC enum base type), a raw-based unit (export
   mode rewrites `REFERENCE TO`/`REF=` and must not be checked), check-only output, and a *Check with STruC++* command that converts the project, runs the compiler as a
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

- **R5** — PROGRAMs stay PROGRAMs; TwinCAT XML parsing fixes (non-ST bodies, CDATA overrun, attribute
  entities, lone CR; BOM verified not to leak); SFC-transition warnings; Add Get / Add Set Accessor (issue
  [#25](https://github.com/AbuShaqra/TC_PLC_Toolkit/issues/25)). PR [#27](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/27),
  squash-merged into `dev` 2026-11-09 as `0ea9fcd`. **Merged before its XAE check** (user's call): an added
  accessor opening and building in XAE, `node test/devhost/run.js`, and a manual menu pass are still to do on the
  user's Windows machine before the next release.
- **S1** (fork lane) — the fork's language server honours dialect profiles: a client passes a whole profile
  object (`strucpp.dialect`) and overrides (`strucpp.features`) through the `strucpp` workspace configuration;
  every analysis and compile request uses it; malformed profiles are rejected without a crash; no profile means
  the compiler's own default. PR [AbuShaqra/STruCpp#4](https://github.com/AbuShaqra/STruCpp/pull/4),
  squash-merged into the fork's `development` 2026-11-09 as `a529ea9`.
- **R1** — Generate ST keeps its rounded end in single-project workspaces. Same PR #27. Dev-host eyeball pending
  with the R5 checks.
