# TwinCAT PLC Toolkit — Roadmap

The order of planned work for the extension. **This file is the source of truth**; the published page
(<https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv>) is rendered from it by hand out of `docs/roadmap.html`.
Keep both current in the same change — rules in [CLAUDE.md](CLAUDE.md) ("Keep the roadmap current").

**Last updated:** 2026-11-09 (marketplace publishing added after R2, user's ask) · **Current release:** v0.10.1

How to read it: items run top to bottom in the **Order** column. IDs are stable names and do not change
when the order does. Estimates are working days for one developer; start and end dates are **forecasts**
over working days (Mon–Fri) assuming the items run one after another. An item may start early once the
items before it are done. Only the order is binding. When an item slips, update its dates and every date
after it. An item leaves the table for "Done" once its PR is merged into `dev`, with the PR number.

## Order of work

| Order | ID | Item | Planned | Re-measured | Start | End | Status |
|-------|----|------|---------|-------------|-------|-----|--------|
| 1 | R3.1 | STruC++ spike: sample project through the compiler under the TwinCAT dialect | 2 d | ~15 min (done) | 2026-11-09 | 2026-11-09 | Findings done 2026-11-09 ([docs/r3.1-strucpp-spike.md](docs/r3.1-strucpp-spike.md)); decisions taken |
| 3 | R2 | TwinCAT sidebar (Activity Bar icon) + start page; create a new project (3.1.4024 / 3.1.4026) | 8.5 d | ~6 h + XAE proofs | 2026-11-12 | 2026-11-13 | **Phase 1 built** 2026-11-09 on `claude/focused-ptolemy-m6acaz` (sidebar, start page, create from both templates; suite green). Open: both templates proven in XAE on the user's machine, the dev-host pass, then PR; phase 2 (XAE automation) after |
| 3b | R11 | Publish to the VS Code Marketplace (and Open VSX) | 0.5 d | ~1 h + your account step | 2026-11-13 | 2026-11-13 | Planned — **accounts created** on both marketplaces (user, 2026-11-09); ships with the first release after R2 |
| 4 | R3.2 | STruC++ check command with errors mapped to the panes | 7 d | ~4 h | 2026-11-16 | 2026-11-16 | Planned (full scope, 2026-11-09) — after S2 |
| 5 | R3.3 | STruC++ bundling, Node 22 discovery, licence files, settings, docs | 3 d | ~2 h | 2026-11-17 | 2026-11-17 | Planned |
| 6 | R6 | Indexing speed: memoize signature-file discovery per root; persisted archive cache; per-project background scan | 5.5 d | ~4 h | 2026-11-17 | 2026-11-18 | Planned (from the backlog, 2026-11-09) |
| 7 | R7 | Rename v1 limits: `.plcproj` sync inside the rename transaction; rename sibling implementors of a shared interface | 2.5 d | ~2 h | 2026-11-19 | 2026-11-19 | Planned (from the backlog) |
| 8 | R8 | Language: nested block comments; hover help for pragmas | 1.5 d | ~1 h | 2026-11-19 | 2026-11-19 | Planned (from the backlog) |
| 9 | R9 | Tooling: ESLint 10 (re-triage, Node floor); the dev-only `brace-expansion` advisory | 0.75 d | ~30 min | 2026-11-19 | 2026-11-19 | Planned (from the backlog) |
| 10 | R10 | L1 reverse index for Find References | 2 d | ~1.5 h | — | — | **On trigger only:** past ~1000 files or > 200 ms per search (today 29 ms cold) |

**Forecast (re-measured 2026-11-09):** the toolkit lane's code (through R3.3) finishes about **2026-11-17**, the scheduled backlog (R6–R9) about **2026-11-19**. What sets the pace now
is not code but the steps only the user can do on Windows. R5's XAE check, R4's dev-host gate and R2's 4024 skeleton
were done 2026-11-09; R2's XAE proofs remain. Those dates are not forecast; each item stays open until its gate passes. Decisions taken
2026-11-09 after the R3.1 spike (`docs/r3.1-strucpp-spike.md`): **wait for the fork** — the check command must not
put compiler errors on correct code, so the gaps are fixed in STruC++ first (S2, fork lane); **R3.2 takes its full
scope** (5 → 7 d).

### Velocity (measured 2026-11-09)

"Planned" is the original estimate in one developer's working days; "Re-measured" is session time (agents doing
the work in parallel, plus review, checks and merge), taken from the commit and merge times of 2026-11-09:

| Item | Planned | Actual (wall clock) | Notes |
|---|---|---|---|
| R5 (3 fixes + #25) | 3 d | ~30 min to code-complete | three agents in parallel; merged later with R1 |
| R1 | 0.5 d | ~10 min | |
| R3.1 spike | 2 d | ~15 min | |
| S1 (fork language server) | 1.5 d | ~25 min | |
| R4 | 4 d | ~3 h | includes a worker restart and a re-run |
| S2 design pass + merge with the user's findings | — | ~1.7 h | |
| S2 steps 1, 1b, 2, 3, 4, 5 | 9 d | ~2 h 5 min (14:03 → 16:08) | each step 10–30 min, review and full fork checks included |

About **20 planned days in ~7 hours** of one session day. One day is not a trend: these were well-specified items with
a written plan behind them. The re-measured column therefore assumes **about half** the observed speed (~30 min per
planned day for fork steps, more for toolkit items that touch the webview or the tree), and the calendar assumes one
working session per day.

## STruC++ fork lane (parallel)

Work in the compiler fork (`AbuShaqra/STruCpp`, branch `development`, GPL-3.0-only — its code stays there; read
its CLAUDE.md first). It runs **alongside** the toolkit lane (user's call, 2026-11-09); the toolkit only waits
for it where a row says so.

| Order | ID | Item | Planned | Re-measured | Start | End | Status |
|-------|----|------|---------|-------------|-------|-----|--------|
| 1 | S2 | Close the fork's gaps: 13 steps + 1b + the folded-in items | 27.5 d (+ ~11 d folded, measured) | ~11.2 h actual | 2026-11-09 | 2026-11-09 | **Done** 2026-11-09 23:17 UTC — see Done |
| 2 | S3a | False positives on correct code found during S2: a STRUCT alias is not assignment-compatible with its STRUCT; `POINTER TO <STRUCT> := ADR(s)` refused; UNION initial values ("not supported yet"); a method named `Get` is a parse error (`GET` is a keyword); a typed literal with a sign after `#` (`INT#-123`, Ed. 3 Table 5) is refused | 3 d | ~1 h actual | 2026-11-12 | 2026-11-12 | **Done** 2026-11-10 00:13 UTC — five fixes merged (fork PRs #25–#29), see Done |
| 3 | S3b | The other S2 follow-ups (list below): code the checker passes but g++ rejects, checker gaps, parser gaps, housekeeping | 7 d | ~3.5 h | 2026-11-12 | 2026-11-13 | **In progress** (since 2026-11-10 00:14 UTC), batch 1 of the list: omitted inputs take their declared default (#30) undeclared functions reported (#31) unknown method calls (#32) unknown members / array↔value assignments (#33) and unknown STRUCT-initialiser elements (#34) reported, merged |
| 4 | S4 | Ed. 3 forms the fork refuses: CHAR/WCHAR, LTIME, string index, `STRING[n]` (needs a decision), typed `TRUNC_<type>`, g++-only literal cases, `STRUCT OVERLAP` (reuses the UNION lowering) | 8.5 d (7–10) | ~4.5 h | 2026-11-13 | 2026-11-16 | Planned |
| 5 | S5 | Profile-handling defects (S2 plan §1d) | 1 d | ~30 min | 2026-11-16 | 2026-11-16 | Planned |
| 6 | S6 | Runtime safety defects (S2 plan §1d, 14 items: `/0` and `MOD 0`, out-of-range index, SEL evaluating both inputs, VAR_TEMP keeping values, FB_exit never called, conversions and to-string forms, SIZEOF/stride, subrange checks, 32-bit intermediates, silent truncation) | 7 d | ~3.5 h | 2026-11-16 | 2026-11-17 | Planned — estimate not measured |
| 7 | S7 | `iec` audit: narrow what `iec-3` accepts (C1–C9) | 6 d | ~3 h | 2026-11-17 | 2026-11-18 | **Needs a decision first** (what to narrow, and that the no-flag default stays stable) |
| 8 | S8 | Flip the no-flag default to `iec-3`, in its own release | 0.5 d | ~20 min | 2026-11-18 | 2026-11-18 | After R3.3 (downstream callers pass `--dialect`) |

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

### R2 — TwinCAT sidebar, start page, and creating a new project

**Goal.** The extension gets its own icon in the Activity Bar. It opens a TwinCAT sidebar, and from there a user
with no TwinCAT project in the workspace (or an empty folder) can create one without opening TwinCAT XAE first.

**Sidebar and start page (user's ask 2026-11-09; decided that day by card):**
- **Views:** a new Activity Bar container `TwinCAT` (`viewsContainers.activitybar`, own monochrome icon) holds a
  **Start** view plus the **TwinCAT Objects** and **TwinCAT Libraries** views, which *move out of the Explorer*
  (users can still drag them back). References stays in the panel.
- **Form:** sidebar **and** full page. The Start view shows compact native buttons (`viewsWelcome`, offline);
  **Open Start Page** opens a full page in an editor tab (a webview) with the create-project form and the rest.
- **Start page options:** *Create new project* (version 3.1.4024 or 3.1.4026, name, location); *Open existing
  project* (a solution or folder, plus recently opened TwinCAT solutions); *Project actions* (Generate ST for all
  or chosen projects, Update Library Definitions, and Check with STruC++ once R3.2 ships); *Help and links*
  (getting started, the roadmap page, release notes, report an issue); *Settings* (the extension's settings).
- **Command Palette:** every action is also a command (`TwinCAT: Create New Project`, `TwinCAT: Open Start Page`, …).
- **Size:** R2 grows from 6 d to about 8.5 d (~6 h of session); the sidebar and start page are the extra 2.5 d.

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

**Status (2026-11-09).**
- **Phase 1 — built** on `claude/focused-ptolemy-m6acaz`, not yet a PR: the `TwinCAT` Activity Bar container
  (Start, TwinCAT Objects, TwinCAT Libraries; ids unchanged), the start page, and *TwinCAT: Create New
  Project* from templates derived from the XAE skeletons (`scripts/build-project-templates.js` →
  `resources/templates/tc3.1.4024/`, `tc3.1.4026/`; every identity GUID re-issued, inventory in
  DEVELOPMENT.md "Project templates"). Starter content `MAIN`, `PlcTask`, an empty `GVL_Main`. A created
  project shows zero diagnostics. Found on the way: the Objects tree ignored the single-file `.tspproj`
  that 3.1.4024 writes (fixed in `src/solutionMap.js`).
- **Before merge (user, Windows):** create a project with each version through the command and prove it
  opens and builds in XAE 3.1.4024 and 3.1.4026; run `node test/devhost/run.js` (it now has a start-page
  phase); look over the sidebar and the start page by eye.
- **TODO — phase 2:** decision 1's XAE automation — *Create New Project* drives XAE (as
  `scripts/Create sample PLC project/build-sample-solution.ps1` does) where TwinCAT is installed. Not
  started.

### R11 — Publish to the VS Code Marketplace (user's ask 2026-11-09)

**Goal.** The extension installs from the VS Code Marketplace (and Open VSX, for VSCodium, Cursor and similar),
starting with the first release that carries R2's TwinCAT sidebar.

**The user's part (one-off, ~15 min):** accounts on both marketplaces were created 2026-11-09 and the publisher ID is
`a-abushaqra`, matching `package.json` (confirmed by the user). Remaining: the
publisher `a-abushaqra` (must equal `package.json`
`publisher`) at marketplace.visualstudio.com/manage; then either upload the release VSIX by hand, or add an Azure
DevOps token with the *Marketplace → Manage* scope as the repo secret `VSCE_PAT` (and an Open VSX token as
`OVSX_PAT`). The publisher profile's "About" text was drafted 2026-11-09.

**Licence:** switched to **AGPL-3.0-or-later** on 2026-11-09 (user's call); the first marketplace release is the
first under it, and the CHANGELOG says so. **Our part (~1 h):** `CHANGELOG.md`; real `categories` / `keywords` / `homepage` / `bugs`; drop `--skip-license`
from the package commands; a "not affiliated with Beckhoff" line in the README (TwinCAT is their trademark);
README images HTTPS and not SVG; optional `"preview": true` until v1.0; a publish step in `release.yml` that runs
only when the secret exists. **Before R3.3 ships**, the bundled GPL-3.0 STruC++ needs its licence text and source
link in the VSIX (already in R3.3's scope).

### S2 — STruC++ fork: close the gaps the spike found

**Plan:** [docs/s2-strucpp-fork-plan.md](docs/s2-strucpp-fork-plan.md) — the R3.1 spike, a first S2 design and
the user's compiler findings document merged and checked against the IEC 61131-3 Ed. 3 text (clause numbers
and paraphrase only; the copy used is licensed to another party, so no text is reproduced).

**Decided 2026-11-09:** all 13 steps plus step 1b (about 22.5 d), one PR each into the fork's `development`; `iec` means Ed. 3, and the built-in profile is renamed `iec-3` with no `iec` alias (so an `iec-4` can be added later; `iec` is refused with an error naming `iec-3`);
standard forms always on (a wrongly refused standard construct is a defect fix), vendor forms behind new
vendor-neutral features that no profile enables by default (`self_caret`, `property`, `postfix_enum_base`,
`named_global_lists`, `struct_extends`, `union`, `fb_init`); chained comparisons follow Annex A;
`--check --json`.

**Order:** 1 lexer positions + `--check --json` → 1b `iec-3` profile id (no alias) → 2 pragmas (R3.2 can use the check from here) → 3 `SUPER.` /
`self_caret` → 4 member-chain calls → 5 interface variables → 6 interface properties (standard gaps closed,
11 d) → 7 chained comparisons → 8 postfix enum base → 9 named global lists → 10 struct inheritance → 11–12
UNION → 13 FB_init (the sample compiles with no workarounds).

**After S2** the fork lane runs S3a–S8 (rows above). S3a comes before the toolkit's R3.2, because it removes errors
the compiler puts on correct code. **Not estimable yet:** a strict-mode policy for vendor profiles (a decision
first), an Ed. 4 profile (needs a full Ed. 4 read), the rest of the vendor-feature catalogue (explicitly not a plan).

**S3b's list** (each found during an S2 step; all also on `development` before it):
- *Passes the checker, fails in g++:* `p^.M()` on an FB behind REF_TO; `inst.Nope()` / `intVar.M()`; positional
  method calls omitting a VAR_OUTPUT; an FB implementing an interface only through its base FB; an FB property
  inherited from a base FB; `TO_DINT(enumValue)`; `gfb(a := 2);` on a global FB instance; `REF(s)`, `REF=` and `=`
  on STRUCTs; a STRUCT argument of an unrelated STRUCT type.
- *Checker gaps:* an unknown member in a chain (`x := mid.nothing`, `s.zz := 1`); an array member assigned to an INT.
- *Parser and language gaps:* plain `SUPER()`; `SUPER.x :=` as a target; `THIS.a.b`; `GVL_A.units[0]()`; IMPLEMENTS
  ignoring methods from interface EXTENDS bases; ARRAY OF / STRUCT field of an interface type; properties through an
  interface variable; a library STRUCT as an EXTENDS base.
- *Found during S3a and the folded items:* an omitted function input with a default emits `F(, 0)` / `0` instead of
  the default (wrong at run time); an enum member named like a FUNCTION/METHOD hijacks its return; `REF(s)` into a
  REF_TO STRUCT and `REF()`/`ADR()` of a CONFIGURATION global fail in g++; an FB call through a pointer does not
  parse; an unknown STRUCT initialiser element passes; alias-of-base := alias-of-derived STRUCT passes; `SINT#200`
  unchecked; `CONCAT` on WSTRING fails g++; uninitialised alias-typed PROGRAM variables; `p : PRG; p();` fails g++.
- *Housekeeping:* the `--feature` help text and the DIALECTS.md "Checks" list; a bundled-library global (`speed`)
  colliding with a user global; an undeclared name in a plain initial value (`x : INT := zz;`) passing analysis; a
  global named like a standard function (`LOG`) clashing in C++.

**How these were estimated (2026-11-09):** the planned days are my sizing from the lists above, not measured; the
re-measured column applies the velocity below (about 30 min per planned day for fork work, ~45 min for toolkit work),
and the calendar assumes about 4 hours of session per working day, weekends off.

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

The former backlog is now scheduled as R6–R10 (2026-11-09, user's ask); each item's reason and numbers stay in
[docs/handoff-findings.md](docs/handoff-findings.md) "Deferred work". What remains here has no estimate on purpose:

- **On the user's Windows machine (~1 h of the user's time, no date):** Libraries-view scoping (tree descriptions,
  webview tab switches, startup seeding, the `.plcproj`-watcher path end to end); library member expansion seen
  once; squiggle rendering; peek dismissal over the real bridge.
- **Showcase screenshots:** the scripts exist only on the user's machine (`scratch/showcase/`); moving them to
  `scripts/showcase/` takes ~30 min once they are in the repo.

## Done

Shipped work lives in git history and the [releases](https://github.com/AbuShaqra/TC_PLC_Toolkit/releases).
Roadmap items finished from now on are listed here with their PR.

- **S3a** (fork lane) — false errors on correct code, 23:18 UTC 2026-11-09 to 00:13 UTC 2026-11-10: signed typed
  literals and typed CASE labels (#25), `Get`/`Set` as names (#26), STRUCT/UNION alias = same type (#27), `ADR` into a
  POINTER TO a STRUCT/UNION/FB (#28), UNION initial values naming one member (#29, `bc171d0`). Nothing narrowed.
- **S2** (fork lane) — closed the fork's gaps, 12:04–23:17 UTC on 2026-11-09. Steps 1–13 + 1b (fork PRs
  [#5](https://github.com/AbuShaqra/STruCpp/pull/5)–[#18](https://github.com/AbuShaqra/STruCpp/pull/18); releases A, B, C)
  and the folded-in items: `REFERENCE TO` inputs bound at the call (#19), typed `TRUNC_<type>` (#20), `trunc_dint` (#21),
  `interface_zero` (#22), PROGRAMs reached by name (#23), FB `VAR_IN_OUT` by reference (#24, `b286bc2`). Nothing that
  compiled and ran correctly before is refused; every narrowing is listed in its PR and the release notes.

- **R4** — Objects-tree model: a VS Code-free node graph (`src/objectsTreeModel.js`) behind a thin tree provider;
  396 tree ids and 301 reveal chains pinned. Dev-host gate passed on Windows 2026-11-09. PR
  [#30](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/30), squash-merged into `dev` 2026-11-09 as `d97cec3`, with
  the Generate ST menu fixes (clipping, Select all) and the XAE 3.1.4024 skeleton.

- **R5** — PROGRAMs stay PROGRAMs; TwinCAT XML parsing fixes (non-ST bodies, CDATA overrun, attribute
  entities, lone CR; BOM verified not to leak); SFC-transition warnings; Add Get / Add Set Accessor (issue
  [#25](https://github.com/AbuShaqra/TC_PLC_Toolkit/issues/25)). PR [#27](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/27),
  squash-merged into `dev` 2026-11-09 as `0ea9fcd`. Merged before its XAE check (user's call); the check
  **passed** on the user's Windows machine 2026-11-09 (XAE, `node test/devhost/run.js`, the manual menu pass).
- **S1** (fork lane) — the fork's language server honours dialect profiles: a client passes a whole profile
  object (`strucpp.dialect`) and overrides (`strucpp.features`) through the `strucpp` workspace configuration;
  every analysis and compile request uses it; malformed profiles are rejected without a crash; no profile means
  the compiler's own default. PR [AbuShaqra/STruCpp#4](https://github.com/AbuShaqra/STruCpp/pull/4),
  squash-merged into the fork's `development` 2026-11-09 as `a529ea9`.
- **R1** — Generate ST keeps its rounded end in single-project workspaces. Same PR #27. Checked on Windows 2026-11-09; that pass
  found the multi-project Generate ST menu clipped in a narrow editor, fixed in `3b93ef1`; at the user's request the menu also gained a tri-state *Select all*. Both ride with PR #30.
