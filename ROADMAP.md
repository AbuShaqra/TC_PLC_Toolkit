# TC Toolkit — Roadmap

The order of planned work for the extension. **This file is the source of truth**; the published page
(<https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv>) is rendered from it by hand out of `docs/roadmap.html`.
Keep both current in the same change — rules in [CLAUDE.md](CLAUDE.md) ("Keep the roadmap current").

**Last updated:** 2026-11-12 (S4 started 05:45 UTC; outside reads of an FB's VAR/VAR_INPUT stay refused in every profile (user); fork F4 merged as #130 (`c1faca7`), **S3b done**, release K cut at `c1faca7`; R12 open as [PR #36](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/36) into `dev`, awaiting the user's Windows check (F5 dev host); next on the fork: S4 after the user's go, then S10; R3.5 merged as PR #35 (`791fc3a`); fork #82–#130 merged, releases H `a5da588`, I `fe4d492`, J `ba4d2c2` and K `c1faca7`) · **Current release:** v0.10.1

How to read it: items run top to bottom in the **Order** column. IDs are stable names and do not change
when the order does. Estimates are working days for one developer; start and end dates are **forecasts**
over working days (Mon–Fri) assuming the items run one after another. An item may start early once the
items before it are done. Only the order is binding. When an item slips, update its dates and every date
after it. An item is listed under "Done" once its PR is merged into `dev`, with the PR number; its row stays in the
table, marked **Done**, until the next prune.

## Order of work

| Order | ID | Item | Planned | Re-measured | Start | End | Status |
|-------|----|------|---------|-------------|-------|-----|--------|
| 1 | R3.1 | STruC++ spike: sample project through the compiler under the TwinCAT dialect | 2 d | ~15 min (done) | 2026-11-09 | 2026-11-09 | **Done** 2026-11-09 — PR #29, see Done ([docs/r3.1-strucpp-spike.md](docs/r3.1-strucpp-spike.md)); decisions taken |
| 2 | R4 | Objects-tree model: a VS Code-free node graph behind a thin tree provider | 4 d | ~3 h | 2026-11-09 | 2026-11-09 | **Done** 2026-11-09 — PR #30, see Done |
| 3 | R2 | TC Toolkit sidebar (Activity Bar icon) + start page; create a new project (3.1.4024 / 3.1.4026) | 8.5 d | ~7 h actual + your XAE proofs | 2026-11-09 | 2026-11-10 | **Done** 2026-11-10 — PR #31, see Done. Phase 2 (create through XAE where TwinCAT is installed) is in the Backlog; the XAE Shell path detection was confirmed on Windows by the user |
| 4 | R3.2 | Compile project: a check command with the compiler's errors mapped to the panes | 7 d | ~5 h actual + your Windows checks | 2026-11-10 | 2026-11-10 | **Done** 2026-11-10 — PR #32, see Done |
| 5 | R3.3 | STruC++ bundling, Node 22 discovery, licence files, settings, docs | 3 d | ~2 h | 2026-11-10 | 2026-11-11 | **Done** 2026-11-11 — PR #33, see Done |
| 6 | R3.4 | Library declarations for Compile Project: build declarations of the vendor-library symbols the project uses from the user's own installed libraries (the *Update Library Definitions* signature dump + the project's `.tmc`; names from the archives), pass them to the compiler as an extra input so library calls are type-checked, and drop errors on library symbols still missing | 2 d | ~1.5 h | 2026-11-10 | 2026-11-11 | **Done** 2026-11-11 — PR #33, see Done |
| 7 | R6 | Indexing speed: memoize signature-file discovery per root; persisted archive cache; per-project background scan | 5.5 d | ~1 h actual | 2026-11-10 | 2026-11-11 | **Done** 2026-11-11 — PR #33, see Done |
| 8 | R7 | Rename v1 limits: `.plcproj` sync inside the rename transaction; rename sibling implementors of a shared interface | 2.5 d | ~25 min actual | 2026-11-10 | 2026-11-11 | **Done** 2026-11-11 — PR #33, see Done |
| 9 | R8 | Language: nested block comments; hover help for pragmas | 1.5 d | ~1 h | 2026-11-11 | 2026-11-11 | **Done** 2026-11-11 — PR #33, see Done |
| 10 | R9 | Tooling: ESLint 10 (re-triage, Node floor); the dev-only `brace-expansion` advisory | 0.75 d | ~30 min | 2026-11-11 | 2026-11-11 | **Done** 2026-11-11 — PR #33, see Done |
| 11 | R3.5 | Compile Project: compiler at release I, conditional pragmas, `.plcproj` compiler defines | — | ~6.8 h actual | 2026-11-11 | 2026-11-11 | **Done** 2026-11-11 23:55 UTC — [PR #35](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/35), squash `791fc3a` into `dev` (user: merge, 2026-11-11), see Done. Bundled compiler at `eb52d2c` (release I plus fork #118–#119); `conditional_pragmas` on in `resources/dialects/twincat3.json`; `<CompilerDefines>` read from each `.plcproj` (case kept; MSBuild last-wins, `$(CompilerDefines)` and `$(Prop)` expanded); conditions evaluated for `Debug\|TwinCAT RT (x64)` (user, 2026-11-11); project defines passed with `--pragma-define` (values exact, no global constant) and per-object defines with `--file-define` on that object's check unit — S11b's toolkit follow-up, folded in; notes in a "TC Toolkit Compile" output channel |
| 12 | R12 | Language server: `{IF}`-aware diagnostics — every branch combination is considered, so valid conditional code (a different block head per branch, per-branch declarations, branch-only names) gets no false diagnostic, while code outside `{IF}` groups keeps every check | 1 d | ~45 min | 2026-11-12 | 2026-11-12 | **In progress** (since 2026-11-11 23:57 UTC, user: start R12). Built 2026-11-11 23:57 – 2026-11-12 00:39 UTC on `claude/focused-ptolemy-m6acaz`, review findings fixed (named-argument segment boundaries, enum members in a group, nested-group spans, wrapped first VAR block), pushed and open as [PR #36](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/36) into `dev`: 111/111 suites FULL, lint/typecheck 0, dev-host 103/1 (known P8). Awaiting the user's Windows check (F5 dev host); estimates are my sizing, not measured |
| 13 | R11 | Publish to the VS Code Marketplace (and Open VSX) | 0.5 d | ~1 h + your account step | 2026-11-20 | 2026-11-20 | Planned — **last, after the toolkit lane AND the fork lane are finished (user, 2026-11-10: "release to marketplace once the fork is also ready")**. Our part (changelog, package metadata, licence in the package, a publish step that runs only when the token secrets exist), then your step: add `VSCE_PAT` / `OVSX_PAT` and run *Release* on `main`. Accounts and publisher `a-abushaqra` done (user, 2026-11-09) |
| — | R10 | L1 reverse index for Find References | 2 d | ~1.5 h | — | — | **On trigger only:** past ~1000 files or > 200 ms per search (today 29 ms cold) |

**Forecast (2026-11-12):** R2 merged 2026-11-10 (PR #31), R3.2 2026-11-10 (PR #32), R3.3–R9 2026-11-11 (PR #33),
R3.5 2026-11-11 (PR #35). R12 ({IF}-aware diagnostics) is open as PR #36, waiting for the user's Windows check. In the
fork, S3b is done (release K, `c1faca7`); S4 follows after the user's go. R10 runs on trigger only; R11, publishing, comes last, after the fork
lane (S10 forecast 2026-11-19), so about **2026-11-20**. Decisions taken
2026-11-09 after the R3.1 spike (`docs/r3.1-strucpp-spike.md`): **wait for the fork** — the check command must not
put compiler errors on correct code, so the gaps are fixed in STruC++ first (S2, fork lane); **R3.2 takes its full
scope** (5 → 7 d).

### Velocity (measured 2026-11-09, re-measured 2026-11-11)

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
| S9 (fork, raw memory layout) | 4 d | ~2 h 30 min (09:40 → 12:07, Nov 10) | 7 PRs |
| R3.2 | 7 d | ~1 h 30 min (20:53 → 22:21, Nov 10) | plus the user's Windows checks |
| R3.3, R3.4, R6, R7, R8, R9 | 15.25 d | ~3 h of build (22:25 → 01:30, Nov 10–11) | merged 09:33 Nov 11 after the user's overnight Windows check |
| S3b fork fixes (#88–#111) | — | ~35 min per PR | probe, fix, full gates with g++, review, merge; 24 PRs Nov 10–11 |

**Re-measured 2026-11-11:** Nov 10–11 confirm the pace — the toolkit lane's code (about 30 planned days) was built in about 6 hours of agent time; what sets the calendar is the user's Windows checks, not the build. Fork fixes run about 35 minutes each. About **20 planned days in ~7 hours** of one session day. One day is not a trend: these were well-specified items with
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
| 2 | S3a | False positives on correct code found during S2: a STRUCT alias is not assignment-compatible with its STRUCT; `POINTER TO <STRUCT> := ADR(s)` refused; UNION initial values ("not supported yet"); a method named `Get` is a parse error (`GET` is a keyword); a typed literal with a sign after `#` (`INT#-123`, Ed. 3 Table 5) is refused | 3 d | ~1 h actual | 2026-11-09 | 2026-11-10 | **Done** 2026-11-10 00:12 UTC — five fixes merged (fork PRs #25–#29), see Done |
| 3 | S3b | The other S2 follow-ups (list below): code the checker passes but g++ rejects, checker gaps, parser gaps, housekeeping | 7 d | ~3.5 h | 2026-11-10 | 2026-11-12 | **Done** 2026-11-12 00:20 UTC (since 2026-11-10 00:14 UTC) — batches 1–5, Part C, F1–F4, #128 and #129 merged (fork #30–#130, without #48, #58–#64 and #116), releases E–K; last: F4, STRING stored as Windows-1252 (#130, `c1faca7`), release K. See Done |
| 4 | S11 | Conditional compilation pragmas (`{IF defined(X)}` / `{ELSIF}` / `{ELSE}` / `{END_IF}`, with `AND`/`OR`/`NOT`) as a dialect feature (on in `twincat3`), defines passed with `-D`; the toolkit then passes the `.plcproj` compiler defines to Compile Project | 2 d | ~3 h actual | 2026-11-11 | 2026-11-11 | **Done** 2026-11-11 16:05 UTC — fork #116 (squash `1080fd6`), see Done; in release I (`fe4d492`). Feature `conditional_pragmas`, off by default and under `iec-3`: `defined()`, `project_defined()`, `hasvalue(N,'text')`, `AND`/`OR`/`NOT`; project defines from `-D`, `pragmaDefines`, `library.json` or the language-server setting; define names case-sensitive (user); `{define N}` / `{define N 'v'}` / `{undefine N}` in source, to the end of the file; `{undefine}` cannot remove a project define; `project_defined()` sees project defines only (the CODESYS operator). The symbol operators (`defined(variable:/type:/pou:)`, `hasattribute`, `hastype`, `hasconstantvalue`, `hasconstanttype`) are refused with a positioned error — a follow-up in the Backlog. **Toolkit side:** R3.5, PR #35, merged 2026-11-11 with the compiler at `eb52d2c` (S11b included). **Follow-up S11b (decided by the user 2026-11-11):** a pragma-only define CLI option (an integer value creates no global constant) and per-file defines, as TwinCAT applies per-object compiler defines; **merged** as fork #119 (`eb52d2c`, 2026-11-11 18:37 UTC): `--pragma-define NAME[=VALUE]` and `--file-define <file>=NAME[=VALUE]`; the toolkit follow-up is folded into R3.5 (PR #35) |
| 5 | S4 | Ed. 3 forms the fork refuses: LTIME first (type, `LTIME#`, arithmetic, the timers' L-variants), then LDATE/LTOD/LDT, CHAR/WCHAR, string index, `STRING[n]` and `WSTRING[n]` (decided 2026-11-10: accepted in every profile, Ed. 3 form), typed `TRUNC_<type>`, g++-only literal cases, `STRUCT OVERLAP` (reuses the UNION lowering) | 8.5 d (7–10) | ~4.5 h | 2026-11-12 | 2026-11-14 | **In progress** (since 2026-11-12 05:45 UTC, user: start S4); LTIME first. **Decided (user, 2026-11-12):** outside code may not read an FB's `VAR` or `VAR_INPUT` in any profile (coordination doc row 34; no vendor feature) |
| 6 | S5 | Profile-handling defects (S2 plan §1d) | 1 d | ~30 min | 2026-11-16 | 2026-11-16 | Planned |
| 7 | S6 | Runtime safety defects (S2 plan §1d, 14 items: `/0` and `MOD 0`, out-of-range index, SEL evaluating both inputs, VAR_TEMP keeping values, FB_exit never called, conversions and to-string forms, SIZEOF/stride, subrange checks, 32-bit intermediates, silent truncation) | 7 d | ~3.5 h | 2026-11-16 | 2026-11-17 | Planned — estimate not measured |
| 8 | S7 | `iec` audit: narrow what `iec-3` accepts (C1–C9) | 6 d | ~3 h | 2026-11-17 | 2026-11-18 | **Needs a decision first** (what to narrow, and that the no-flag default stays stable) |
| 9 | S8 | Flip the no-flag default to `iec-3`, in its own release | 0.5 d | ~20 min | 2026-11-18 | 2026-11-18 | Planned — R3.3 merged 2026-11-11 (PR #33); the toolkit passes `--dialect-file` |
| 10 | S9 | Raw memory layout in the runtime: a variable is just its value (`IECVar<T>` = one `T`, `sizeof` as on a PLC), STRING a NUL-terminated `char[N+1]`, enums `: INT`; forcing moves to a bounded table written at cycle start and end. Fixes byte access through a differently shaped pointer (`POINTER TO ARRAY OF BYTE` over a DWORD or STRING — 14 bundled OSCAT functions — `POINTER TO BYTE` walking an array or STRUCT). Steps, one PR each: S0 library manifest lists FUNCTION locals as inputs (OSCAT functions not callable) · S1 force table · S2 codegen (`ForceScope` in `run()`, enum base) · S3a forcing users (debugger, REPL, extension) · S3b layout · S4 STRING · S5 OSCAT real-call e2e | 4 d (3–5) | ~2.5 h actual | 2026-11-10 | 2026-11-10 | **Done** 2026-11-10 12:07 UTC — seven PRs (fork #58–#64), see Done. **Release F cut at `e071f4f`** (user kept STRING(n) = n+1 bytes, the vendor layout); note posted in the coordination doc |
| 11 | S10 | Vendor types and forms for the `twincat3` and `codesys3` profiles (CODESYS findings arrived 2026-11-10): `__ISVALIDREF` (on with `reference_to`) first; `vendor_operators` (`XSIZEOF`, `BITADR`, `INDEXOF`, `__POSITION`, `__POUNAME`); `type_colon_optional` (`TYPE name STRUCT` without the colon) under `codesys3` and `twincat3`, and `conditional_return` (`RETURN (cond);`) under `codesys3`; `platform_types` (`__XINT`/`XINT`, `__UXINT`/`UXINT`, `XWORD`, `PVOID`); `bit_type` (BIT as a STRUCT member); a hint on "missing required input" for implicit-parameter attributes. Each off by default and under `iec-3`. Not planned until real code needs it: multicore operators, the vector type, quoted identifiers, persistent instance paths, `__CURRENTTASK`/`__POOL`, `INI`/`CALC`. Library types (HRESULT, OTCID, VERSION) come from a vendor library, not the compiler. **Decided (user, 2026-11-11):** `type_colon_optional` is also on under `twincat3`; `conditional_return` stays CODESYS-only until a real TwinCAT export shows it | 3 d | ~1.5 h | 2026-11-19 | 2026-11-19 | Planned — after S4 (can move earlier if imported code needs it) |

**Why this order.**
1. **R3.1 (spike) first:** the STruC++ work is the largest unknown. The spike needs no decisions, and what
   the compiler rejects on the sample decides the size of R3.2–R3.3 while other work proceeds.
2. **R4 before R2:** R2 adds an empty state and a create flow to the Objects tree, and R4 rebuilds the
   Objects tree's model. Doing R4 first means R2 is written once, against the new model.
3. **R2, then R3.2–R3.3 once S2 is merged:** R2 needs its templates made and proven in XAE on the user's machine, the same
   session R4's dev-host gate needs. S2 (fork lane) comes before R3.2 because a check command that flags correct code is
   worse than none (decided 2026-11-09); R3.2–R3.3 then build on a compiler that accepts the sample.
4. **R6–R9 after R3:** the former backlog, scheduled 2026-11-09, followed R3.4; all four merged with R3.3–R3.4 in PR #33.
5. **R3.5, then R12:** R3.5 brings the compiler's conditional pragmas to Compile Project; R12 then stops the
   language server's own diagnostics from flagging valid code inside `{IF}` branches (user, 2026-11-11).
6. **Publishing (R11) last:** no Marketplace release until the toolkit lane and the fork lane are both finished
   (user, 2026-11-10).

### R4 — Objects-tree model (deepening roadmap P7)

**Goal.** Give the Objects view (now *PLC Objects*) a real, VS Code-free node model, so the tree provider becomes a thin
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

### R2 — TC Toolkit sidebar, start page, and creating a new project

**Goal.** The extension gets its own icon in the Activity Bar. It opens a sidebar (named TC Toolkit since PR #33), and from there a user
with no TwinCAT project in the workspace (or an empty folder) can create one without opening TwinCAT XAE first.

**Sidebar and start page (user's ask 2026-11-09; decided that day by card):**
- **Views:** a new Activity Bar container (`viewsContainers.activitybar`, own monochrome icon; named **TC Toolkit**
  since PR #33) holds a **Start** view plus the **PLC Objects** and **PLC Libraries** views (shipped as "TwinCAT
  Objects" / "TwinCAT Libraries", renamed in PR #33), which *move out of the Explorer*
  (users can still drag them back). References stays in the panel.
- **Form:** sidebar **and** full page. The Start view shows compact native buttons (`viewsWelcome`, offline);
  **Open Start Page** opens a full page in an editor tab (a webview) with the create-project form and the rest.
- **Start page options:** *Create new project* (version 3.1.4024 or 3.1.4026, name, location); *Open existing
  project* (a solution or folder, plus recently opened TwinCAT solutions); *Project actions* (Generate ST for all
  or chosen projects, Update Library Definitions, and *Compile Project* since R3.2); *Help and links*
  (getting started, the roadmap page, release notes, report an issue); *Settings* (the extension's settings).
- **Command Palette:** every action is also a command (`TC Toolkit: Create New Project`, `TC Toolkit: Open Start Page`, …;
  the category was `TwinCAT` until PR #33).
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

**Status (2026-11-10):** merged as PR #31 (`e5310ae`, 2026-11-10 20:51 UTC); both templates proven in XAE
3.1.4024/3.1.4026 by the user; dev-host green. Container and views renamed TC Toolkit / PLC Objects / PLC Libraries
in PR #33. Templates: `scripts/build-project-templates.js` → `resources/templates/tc3.1.4024/`, `tc3.1.4026/`
(inventory in DEVELOPMENT.md "Project templates").
- **TODO — phase 2:** decision 1's XAE automation — *Create New Project* drives XAE (as
  `scripts/Create sample PLC project/build-sample-solution.ps1` does) where TwinCAT is installed. Not
  started; listed in the Backlog.

### R3.5 — Compile Project: compiler at release I, conditional pragmas, `.plcproj` compiler defines

**Status:** merged 2026-11-11 23:55 UTC as [PR #35](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/35)
(`791fc3a`), see Done.

**What it does.** Re-vendors the bundled compiler at fork `eb52d2c` (release I plus #118 and #119, S11b) and turns on S11's `conditional_pragmas` in
`resources/dialects/twincat3.json`. Compile Project reads `<CompilerDefines>` from each `.plcproj` (case kept; MSBuild
semantics: the last assignment wins, `$(CompilerDefines)` and `$(Prop)` are expanded) and passes them with `--pragma-define NAME[=VALUE]`:
values exact, numbers too, never a global constant, seen by `project_defined()`. `<CompilerDefines>` inside a
`<Compile Include>` item are passed with `--file-define <unit>=NAME[=VALUE]` on the check unit built from that object;
an item with no unit gets a note. Conditions on property groups, item groups and items are evaluated for `Debug|TwinCAT RT (x64)` (user decision, 2026-11-11). Notes go to a
"TC Toolkit Compile" output channel.

**S11b folded in (2026-11-11).** S11b merged in the fork as #119, so its toolkit follow-up is part of this PR instead
of a separate item; the earlier name-only passing of numeric values and the "per-object defines not applied" note are
gone.

### R12 — `{IF}`-aware diagnostics in the language server (decided 2026-11-11)

**Goal.** The language server's own diagnostics stop flagging valid code inside `{IF}` / `{ELSIF}` / `{ELSE}` /
`{END_IF}` groups — a different block head per branch, a declaration whose type differs per branch, a name declared
only in a branch — without losing diagnostics on code outside groups. Scheduled by the user to follow PR #35
(merged 2026-11-11 23:55 UTC); started 2026-11-11 23:57 UTC. Must hold the `sample/` diagnostics gate at zero.

**Design (decided 2026-11-11, from two reviewed designs).** The LSP never evaluates a define: every branch
combination counts as possible. Block errors are kept only when every branch selection has them (cap 64 per
segment; an unbalanced segment reports nothing); semantic diagnostics inside a group's statement are dropped; a
name whose type differs per branch resolves to unknown; a conditional VAR header or POU head makes the parameter set
or the inheritance chain unknown. A unit with no directive keeps the old output byte for byte. Details:
DEVELOPMENT.md "Conditional pragmas in the language server (R12)".

**Built 2026-11-11 23:57 – 2026-11-12 00:39 UTC** on `claude/focused-ptolemy-m6acaz`, review findings fixed, open as
[PR #36](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/36) into `dev` (111/111 suites FULL): new
`src/lsp/conditionals.js`; `test/test_conditional_pragmas.js`; R12 cases in `test_live_path.js` and compiler parity
in `test_compile_real.js`. **Owed:** the user's F5 check (no squiggle on a split IF head in either pane; completion
and references in both branches; an unrelated missing END_FOR still shows). **Proposed:** add a conditional POU and
`<CompilerDefines>` to TcToolkitSample2 once the user has built it in XAE.

### R11 — Publish to the VS Code Marketplace (user's ask 2026-11-09)

**Goal.** The extension installs from the VS Code Marketplace (and Open VSX, for VSCodium, Cursor and similar),
starting with the first release that carries R2's TC Toolkit sidebar.

**The user's part (one-off, ~15 min):** accounts on both marketplaces were created 2026-11-09 and the publisher ID is
`a-abushaqra`, matching `package.json` (confirmed by the user). Remaining: either upload the release VSIX by
hand, or add an Azure DevOps token with the *Marketplace → Manage* scope as the repo secret `VSCE_PAT` (and an Open VSX token as
`OVSX_PAT`). The publisher profile's "About" text was drafted 2026-11-09.

**Licence:** switched to **AGPL-3.0-or-later** on 2026-11-09 (user's call); the first marketplace release is the
first under it, and the CHANGELOG says so. **Our part (~1 h):** `CHANGELOG.md`; real `categories` / `keywords` / `homepage` / `bugs`; drop `--skip-license`
from the package commands; a "not affiliated with Beckhoff" line in the README (TwinCAT is their trademark);
README images HTTPS and not SVG; optional `"preview": true` until v1.0; a publish step in `release.yml` that runs
only when the secret exists. **Done in PR #33:** the bundled compiler ships with its GPL licence, runtime exception
and source link (`resources/compiler/`).

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

**S3b's list: closed** (2026-11-12). Everything on it merged (fork #30–#130 without #48, #58–#64 and #116), the last
item F4 as #130 (`c1faca7`), cut as release K; batch 5 skipped D6 (already works) and kept D7 refused (user). Nothing
is open; next on the fork is S4, then S10.

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
  extension is AGPL-3.0-or-later (since PR #31). Keep the compiler a separate program the extension runs as a process — never
  `require()` it into the extension — and ship its licence and source reference with any bundled copy.
- **Runtime:** STruC++ needs Node ≥ 22; the extension supports VS Code ≥ 1.66, whose bundled Node is older.
- **Offline:** the extension must work offline, so a bundled compiler (the fork's `npm run build:bundle`, shipped
  as `resources/compiler/compiler.cjs` since PR #33) fits better than a download on first use.
- Turning the generated C++ into a binary needs `g++`; checking and generating C++ does not.

**Phases** (scheduled separately in the table above).
1. **R3.1 Spike** — run the `sample/` project's ST through the STruC++ CLI with `resources/dialects/twincat3.json`, under the
   TwinCAT dialect; list every construct it rejects. This sizes the rest.
2. **R3.2 Check command** (full scope, 7 d, decided 2026-11-09; after fork item S2) — a line-preserving *check* emitter in
   the converter (members before the POU body, pragmas blanked, IEC enum base type), a raw-based unit (export
   mode rewrites `REFERENCE TO`/`REF=` and must not be checked), check-only output, and a *Compile Project* command (TC Toolkit: Compile Project) that converts the project, runs the compiler as a
   full semantic check and maps its errors to the right component and pane (VS Code Problems + pane markers).
3. **R3.3 Packaging** — bundle the compiler, find a Node ≥ 22, ship the licence files, add settings (Node
   path, dialect file) and documentation.

**Decisions (settled 2026-11-09).**
1. **Output:** check only — errors in the panes, no files written, no `g++` needed. Generated C++ or a built
   program can be added later as a new roadmap item.
2. **Compiler source:** bundled in the VSIX as `resources/compiler/compiler.cjs` (built from the fork's bundle), with
   COPYING and SOURCE.md, run as a separate process.
3. **Node ≥ 22:** found on the user's machine (`PATH`, or a setting that names it). When none is found, the
   command explains what is missing and how to fix it. `engines.vscode` stays at `^1.66`.

## Backlog (not scheduled)

The former backlog was scheduled as R6–R10 on 2026-11-09 (the user asked). R6–R9 merged in PR #33 (`6424968`,
2026-11-11), and R10 only runs on a trigger. Each item's reason and numbers stay in
[docs/handoff-findings.md](docs/handoff-findings.md) "Deferred work". What remains here has no estimate on purpose:

- **On the user's Windows machine (~1 h of the user's time, no date):** Libraries-view scoping (tree descriptions,
  webview tab switches, startup seeding, the `.plcproj`-watcher path end to end); library member expansion seen
  once; squiggle rendering; peek dismissal over the real bridge.
- **Showcase screenshots:** the scripts exist only on the user's machine (`scratch/showcase/`); moving them to
  `scripts/showcase/` takes ~30 min once they are in the repo.
- **R12b informational branch state** (follow-up from R12): evaluate the `.plcproj` defines in the language server
  (a cached reader over `src/compilerDefines.js`, three-valued) for a hover on `{IF}` and greying of inactive
  branches. Must never feed diagnostics or the index. **Open decision (user):** Debug configuration only, or only
  where all configurations agree.
- **Go to Definition on a name declared in several `{IF}` branches** returns only the first declaration today;
  returning all of them needs `mapDefinition` to accept arrays. Optional: merge same-name completion items with a
  `BOOL | INT (conditional)` detail. Follow-ups from R12.
- **Indexing progress "3 of 8 projects"** in the status bar (possible since R6's per-project scan; needs a server → host
  progress notification). Raised 2026-11-11.
- **Measure indexing speed on Windows, on a real multi-project workspace** (cold and warm startup, time until the first
  project is ready) with `scripts/measure-indexing.js`. Cold startup (~20 s for 8 projects) is still projected, not
  measured. Needs the user's machine. Raised 2026-11-11.
- **Find References across a shared interface's sibling implementors.** R7's `memberRenameFamily` covers rename only;
  Find References still uses the pairwise relation. Follow-up from PR #33, 2026-11-11.
- **F2 rename from a call site in the editor panes.** F2 works only in the PLC Objects tree today (keybinding
  `focusedView == twincatExplorer`); the panes would need a Monaco rename provider bridged to `twincat.renameObject` /
  `custom/referencesForSymbol`. Raised 2026-11-11.
- **Open question: should pragma hover show syntax forms, or only the name and the Infosys link?** Today it shows a
  category summary, the syntax form and the link (no Beckhoff description text). The user decides. Raised 2026-11-11.
- **Dev-only advisory: minimatch 10.2.6 via ESLint 10** (GHSA-g3hv-75wg-m249, moderate). Wait for ESLint to allow
  minimatch 11, or force it with an npm `overrides` entry if lint and the suite still pass. Nothing ships with it
  (`npm audit --omit=dev` is clean). Raised 2026-11-11.
- **Regenerate the social preview** (`node scripts/make-social-preview.js` on Windows, which needs Segoe UI) so
  `media/icon.png` says TC Toolkit instead of the old name, then upload it under the GitHub repo's Settings → Social
  preview. The script changed in `98948c5` (2026-11-10); the PNG dates from `142e541` (2026-08-26).
- **Open question: cut 0.11.0 now?** A version bump and a `CHANGELOG.md` covering PRs #27 and #29–#34, plus a
  `dev → main` release. Offered to the user, not decided; otherwise the CHANGELOG waits for R11. Raised 2026-11-11.
- **R2 phase 2: Create New Project through XAE** where TwinCAT is installed (decision 1 of R2, as
  `scripts/Create sample PLC project/build-sample-solution.ps1` does). The XAE Shell path settings it will use exist
  (`src/xaeShellDetect.js`); `src/xaeShell.js` keeps its own discovery for Update Library Definitions. Not started.
  Left open by PR #31.
- **Deprecated `twincat.*` setting stand-ins** (PR #34): decide in which release they and the migration in
  `src/settingsMigration.js` are removed.
- **Fork: S11's symbol operators** — `defined(variable:…)`, `defined(type:…)`, `defined(pou:…)`, `hasattribute`,
  `hastype`, `hasconstantvalue`, `hasconstanttype` in `{IF}` pragmas. #116 refuses them with a positioned error;
  evaluating them needs the symbol tables. Follow-up from fork #116, 2026-11-11.
- **Re-vendor the compiler at release K (`c1faca7`)** in a later toolkit PR (R3.5 bundles `eb52d2c`). Raised 2026-11-11.
- **Reply on issue [#25](https://github.com/AbuShaqra/TC_PLC_Toolkit/issues/25)** once the next release carries Add
  Get / Add Set Accessor (PR #27, `0ea9fcd`).

## Done

Shipped work lives in git history and the [releases](https://github.com/AbuShaqra/TC_PLC_Toolkit/releases).
Roadmap items finished from now on are listed here with their PR.

- **S3b** (fork lane) — the other S2 follow-ups, 2026-11-10 00:14 UTC to 2026-11-12 00:20 UTC: batches 1–5, Part C,
  F1–F4, the argument check with libraries (#128) and OSCAT `ROUND(IN, N)` (#129), fork #30–#130 (without #48, #58–#64 and #116); releases E–K. Last,
  F4 ([#130](https://github.com/AbuShaqra/STruCpp/pull/130), `c1faca7`): STRING stored as Windows-1252, the debug wire
  stays `len8-utf8` (new status 0x89 for an unencodable write), non-CP1252 STRING literals refused. **Release K** cut at
  `c1faca7` (#129–#130; lint, format, typecheck, purity, build, bundle, 5759 tests passed, 7 skipped, 345 language-server tests; note in the coordination doc).
- **R3.5** — Compile Project with the compiler at `eb52d2c`, conditional pragmas and `.plcproj` compiler defines,
  2026-11-11 17:05–23:55 UTC ([PR #35](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/35), squash `791fc3a`): project defines via
  `--pragma-define`, per-object defines via `--file-define`, Conditions evaluated for `Debug|TwinCAT RT (x64)`, notes in
  a "TC Toolkit Compile" output channel.
- **S11** (fork lane) — conditional compilation pragmas, 2026-11-11 13:10–16:05 UTC
  ([#116](https://github.com/AbuShaqra/STruCpp/pull/116), squash `1080fd6`; in release I `fe4d492`): feature
  `conditional_pragmas` (off by default and under `iec-3`) with `defined()`, `project_defined()`, `hasvalue(N,'text')`,
  `AND`/`OR`/`NOT`; project defines from `-D`, `pragmaDefines`, `library.json` or the language-server setting, names
  case-sensitive; `{define}`/`{undefine}` in source to the end of the file, never removing a project define. Symbol
  operators refused with a positioned error (Backlog).
- **S3b fork PRs #112–#115, #117** (fork lane) — merged 2026-11-11: FB member access per IEC
  with access specifiers ([#112](https://github.com/AbuShaqra/STruCpp/pull/112)), STRUCT field defaults
  ([#113](https://github.com/AbuShaqra/STruCpp/pull/113), 21e), standard-function arguments of an alias type checked
  against its base type ([#114](https://github.com/AbuShaqra/STruCpp/pull/114), 7e, `f77b5c7`), plain `SUPER()`, `SUPER.x :=` and
  access paths after THIS/SUPER ([#115](https://github.com/AbuShaqra/STruCpp/pull/115), D1–D3, `8185adb`), calling an
  FB held in a global array element, `units[0](...)` and `GVL_A.units[0](...)`
  ([#117](https://github.com/AbuShaqra/STruCpp/pull/117), D4, `fe4d492`). **Release I** cut at `fe4d492` the same day
  (#111–#117).
- **S3b fork PRs #118–#129** (fork lane) — merged 2026-11-11 from 18:37 UTC: an INTERFACE as an ARRAY element or STRUCT field
  holds a reference ([#118](https://github.com/AbuShaqra/STruCpp/pull/118), D5, `38ad2ca`); S11b, pragma-only and
  per-file defines, `--pragma-define` and `--file-define` ([#119](https://github.com/AbuShaqra/STruCpp/pull/119),
  `eb52d2c`). The extension bundles `eb52d2c` in R3.5 (PR #35). D8, STRUCT aliases related through their targets'
  EXTENDS ([#120](https://github.com/AbuShaqra/STruCpp/pull/120), `a4d7809`), merged the same evening; D9, out-of-range typed literals refused
  ([#121](https://github.com/AbuShaqra/STruCpp/pull/121), `caf3d93`; release J note); D10, CONFIGURATION pointer and
  reference globals ([#122](https://github.com/AbuShaqra/STruCpp/pull/122), `b77f36f`); D12, empty `--feature` id message and the
  DIALECTS.md Checks list ([#123](https://github.com/AbuShaqra/STruCpp/pull/123), `aacc31a`); D11, forced and debugged globals
  take the global's lock in threaded builds ([#124](https://github.com/AbuShaqra/STruCpp/pull/124), `039d65f`). Batch 5 is done. F1, private/protected
  properties refused from outside ([#125](https://github.com/AbuShaqra/STruCpp/pull/125)), and F2, a VAR_EXTERNAL in an FB reaching another
  resource's global refused ([#126](https://github.com/AbuShaqra/STruCpp/pull/126)), and F3, a name declared twice in one
  CONFIGURATION or one RESOURCE `VAR_GLOBAL` refused at the second declaration
  ([#127](https://github.com/AbuShaqra/STruCpp/pull/127), `f8dee95`; user decision); all three refuse code that ran
  (release J note). Standard-function arguments checked when libraries are loaded: `LEN(i)` with an INT is refused at
  analysis instead of failing in g++ ([#128](https://github.com/AbuShaqra/STruCpp/pull/128), `ba4d2c2`; probed on 161
  `.st` files × 3 modes, nothing that builds today newly refused). **Release J** cut at `ba4d2c2` the same day (#118–#128;
  lint, format, typecheck, purity, build, bundle, 5715 tests passed with 7 skipped, 345 language-server tests; note in
  the coordination doc).
- **Settings keys `tcToolkit.*`** — 2026-11-11 09:48–10:28 UTC ([PR #34](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/34), `cd52afc`): VS Code labels settings from their keys, so the 10 settings moved from `twincat.*` with a one-time migration (user report).
- **R3.3–R9** — merged together 2026-11-11 09:33 UTC after the user's Windows checks ([PR #33](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/33), `6424968`):
  the compiler bundled (GPL licence + source link, only the TwinCAT dialect profile, Node 22+ found automatically, a
  toolbar Compile button); the visible name **TC Toolkit** (trademark; internal ids unchanged); R3.4 vendor-library
  declarations built locally per check (never stored or shipped — Beckhoff licence §4(3)); R6 indexing (memoized
  discovery, persisted archive names, per-project background scan with a readiness gate); R7 rename as one undoable
  edit with an Undo button and interface-method families; R8 nested comments and pragma hover; R9 ESLint 10 and
  brace-expansion 2.1.7.
- **R3.2** — Compile Project, 2026-11-10 20:53–22:21 UTC ([PR #32](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/32), `28f24f1`):
  Compile Project (TC Toolkit: Compile Project; shipped as "TwinCAT: Compile Project", renamed in PR #33) runs the external compiler's check (no `--strict`, the vendored TwinCAT profile, unsaved
  edits included) and shows its results in the Problems panel at the pane's own line and column (changed on the
  user's report: the XML position confused) and as pane markers; compiler path and Node path settings; a start-page
  tile. Generate ST writes each project's files into its own `ST_Files`, shown in the Objects tree. A second sample
  solution, `TcToolkitSample2` (3.1.4024). **Proven on Windows by the user:** both samples 0 errors, an undeclared
  variable reported and cleared on edit, the dev-host test green with and without the compiler.
- **R2** — sidebar, start page and Create New Project, 2026-11-09 19:57 UTC to 2026-11-10 20:51 UTC ([PR #31](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/31), `e5310ae`):
  an Activity Bar container with Start, TwinCAT Objects and TwinCAT Libraries (renamed TC Toolkit, PLC Objects / PLC Libraries in PR #33); a start page (create, open with
  recent projects — two shown, Show all — project actions, help, settings); projects created from real XAE output for
  3.1.4024 and 3.1.4026, **both proven to open and build in XAE by the user**; XAE Shell path settings with
  detection; the Objects tree follows the active file only while visible; the licence changed to AGPL-3.0-or-later.
- **S9** (fork lane) — raw memory layout, 09:40–12:07 UTC 2026-11-10 (user: fix the root cause): library manifests
  list only a FUNCTION's inputs/outputs/in-outs (#58), force table (#59), a force scope in every PROGRAM cycle and
  2-byte enums (#60), forcing at cycle boundaries through the table (#61, user decision), variables laid out as their
  values with alias-safe pointer punning (#62), NUL-terminated STRING/WSTRING (#63), and the 14 pointer-based OSCAT
  string functions pinned through real calls (#64, `e071f4f`). Byte access through any pointer shape now reads real
  bytes; `SIZEOF` returns PLC sizes; RAM per elementary variable drops to a third.
- **S3a** (fork lane) — false errors on correct code, 23:18 UTC 2026-11-09 to 00:12 UTC 2026-11-10: signed typed
  literals and typed CASE labels (#25), `Get`/`Set` as names (#26), STRUCT/UNION alias = same type (#27), `ADR` into a
  POINTER TO a STRUCT/UNION/FB (#28), UNION initial values naming one member (#29, `bc171d0`). Nothing narrowed.
- **S2** (fork lane) — closed the fork's gaps, 12:04–23:17 UTC on 2026-11-09. Steps 1–13 + 1b (fork PRs
  [#5](https://github.com/AbuShaqra/STruCpp/pull/5)–[#18](https://github.com/AbuShaqra/STruCpp/pull/18); releases A, B, C)
  and the folded-in items: `REFERENCE TO` inputs bound at the call (#19), typed `TRUNC_<type>` (#20), `trunc_dint` (#21),
  `interface_zero` (#22), PROGRAMs reached by name (#23), FB `VAR_IN_OUT` by reference (#24, `b286bc2`). Nothing that
  compiled and ran correctly before is refused; every narrowing is listed in its PR and the release notes.

- **R4** — Objects-tree model: a VS Code-free node graph (`src/objectsTreeModel.js`) behind a thin tree provider;
  396 tree ids and 301 reveal chains pinned. Dev-host gate passed on Windows 2026-11-09. PR
  [#30](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/30), squash-merged into `dev` 2026-11-09 19:56 UTC as `d97cec3`, with
  the Generate ST menu fixes (clipping, Select all) and the XAE 3.1.4024 skeleton.

- **R3.1** — STruC++ spike findings (`docs/r3.1-strucpp-spike.md`), decisions taken 2026-11-09; merged with the
  two-lane roadmap in [PR #29](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/29), 2026-11-09 12:03 UTC, `1b82d08`.

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
- **Roadmap set-up** (housekeeping, not a roadmap item) — this roadmap, a pruned HANDOFF.md and the vendored dialect profile,
  [PR #26](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/26), merged into `dev` 2026-11-09 09:07 UTC as `caa686d`.
