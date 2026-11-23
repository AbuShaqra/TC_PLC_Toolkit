# TC Toolkit — Roadmap

The order of planned work for the extension. **This file is the source of truth**; the published page
(<https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv>) is rendered from it by hand out of `docs/roadmap.html`.
Keep both current in the same change — rules in [CLAUDE.md](CLAUDE.md) ("Keep the roadmap current").

**Last updated:** 2026-11-23 · **Current release:** v0.11.1 · **Re-measured:** 2026-11-11 · **Next:** fork S13 (in progress since 2026-11-23); toolkit R11, the marketplace uploads · **Lanes:** 2

How to read it: items run top to bottom in the **Order** column. IDs are stable names and do not change
when the order does. Estimates are working days for one developer; start and end dates are **forecasts**
over working days (Mon–Fri) assuming the items run one after another. An item may start early once the
items before it are done. Only the order is binding. When an item slips, update its dates and every date
after it. An item is listed under "Done" once its PR is merged into `dev`, with the PR number; its row stays in the
table, marked **Done**, until the next prune.

## Order of work

| Order | ID | Item | Planned | Re-measured | Start | End | Status |
|-------|----|------|---------|-------------|-------|-----|--------|
| 1 | R3.1 | STruC++ spike: sample project through the compiler under the TwinCAT dialect | 2 d | ~15 min | 2026-11-09 | 2026-11-09 | **Done** 2026-11-09 — PR #29 |
| 2 | R4 | Objects-tree model: a VS Code-free node graph behind a thin tree provider | 4 d | ~3 h | 2026-11-09 | 2026-11-09 | **Done** 2026-11-09 — PR #30 |
| 3 | R2 | TC Toolkit sidebar (Activity Bar icon) + start page; create a new project (3.1.4024 / 3.1.4026) | 8.5 d | ~7 h + your XAE proofs | 2026-11-09 | 2026-11-10 | **Done** 2026-11-10 — PR #31 |
| 4 | R3.2 | Compile project: a check command with the compiler's errors mapped to the panes | 7 d | ~5 h + your Windows checks | 2026-11-10 | 2026-11-10 | **Done** 2026-11-10 — PR #32 |
| 5 | R3.3 | STruC++ bundling, Node 22 discovery, licence files, settings, docs | 3 d | ~2 h | 2026-11-10 | 2026-11-11 | **Done** 2026-11-11 — PR #33 |
| 6 | R3.4 | Library declarations for Compile Project, built from the user's own installed libraries | 2 d | ~1.5 h | 2026-11-10 | 2026-11-11 | **Done** 2026-11-11 — PR #33 |
| 7 | R6 | Indexing speed: memoized signature-file discovery; persisted archive cache; per-project background scan | 5.5 d | ~1 h | 2026-11-10 | 2026-11-11 | **Done** 2026-11-11 — PR #33 |
| 8 | R7 | Rename v1 limits: `.plcproj` sync inside the rename transaction; rename sibling implementors of a shared interface | 2.5 d | ~25 min | 2026-11-10 | 2026-11-11 | **Done** 2026-11-11 — PR #33 |
| 9 | R8 | Language: nested block comments; hover help for pragmas | 1.5 d | ~1 h | 2026-11-11 | 2026-11-11 | **Done** 2026-11-11 — PR #33 |
| 10 | R9 | Tooling: ESLint 10 (re-triage, Node floor); the dev-only `brace-expansion` advisory | 0.75 d | ~30 min | 2026-11-11 | 2026-11-11 | **Done** 2026-11-11 — PR #33 |
| 11 | R3.5 | Compile Project: compiler at release I, conditional pragmas, `.plcproj` compiler defines | — | ~6.8 h | 2026-11-11 | 2026-11-11 | **Done** 2026-11-11 — PR #35 |
| 12 | R12 | Language server: `{IF}`-aware diagnostics | 1 d | ~45 min + your check | 2026-11-12 | 2026-11-12 | **Done** 2026-11-12 — PR #36 |
| 13 | R13 | Compile button: optional C++ generation into `CPP_Files/` and a g++ compile check | 3 d | ~2.5 h + your check | 2026-11-12 | 2026-11-13 | **Done** 2026-11-13 — PR #37 |
| 14 | R14 | Build and activate through XAE's Automation Interface | 3 d | ~2 h + your check | 2026-11-12 | 2026-11-14 | **Done** 2026-11-13 — PR #38 |
| 15 | R15 | ADS online monitoring: watch and write variables of the running PLC from the editor | 3 d | ~2 h + 1.5 d | 2026-11-16 | 2026-11-18 | **Done** 2026-11-16 — PR #41, released in v0.11.0 |
| 16 | R11 | Publish to the VS Code Marketplace (and Open VSX) | 0.5 d | ~1 h + your account step | 2026-11-17 | 2026-11-17 | **In progress** (started 2026-11-17 10:12 UTC): our part merged (PR #48 into dev, PR #49 into main, version 0.11.1). **VS Code Marketplace live** since 2026-11-17 15:25 UTC with 0.11.0 (uploaded by the user; [listing](https://marketplace.visualstudio.com/items?itemName=a-abushaqra.twincat-plc-toolkit)); **v0.11.1 released on GitHub** 2026-11-17 16:32 UTC (Release run 44126083730; the publish jobs skipped both marketplaces: no `VSCE_PAT`/`OVSX_PAT` secrets yet). Open: 0.11.1 on the Marketplace (upload the VSIX or add the secret and run *Publish* with tag `v0.11.1`) and Open VSX. S12 and S13 do not hold it. Then your step: add `VSCE_PAT` / `OVSX_PAT` and run *Release* on `main` |
| — | R10 | L1 reverse index for Find References | 2 d | ~1.5 h | — | — | **On trigger only:** past ~1000 files or > 200 ms per search (today 29 ms cold) |

**Forecast (2026-11-17):** the toolkit lane is finished — R15 merged on 2026-11-16 (PR #41) and shipped in v0.11.0 the
same day, with the compiler at fork release N (PR #40). In the fork, everything up to S7 is done; S12 waits for the Ed. 4
text and S8 waits on S12; S13, the release-N follow-ups, started 2026-11-23 and runs to about 2026-11-28. R11, publishing,
is the only open toolkit item and is planned for today (user, 2026-11-17); neither S12 nor S13 holds it.
R10 runs on trigger only.

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
| 1 | S2 | Close the fork's gaps: 13 steps + 1b + the folded-in items | 27.5 d (+ ~11 d folded) | ~11.2 h | 2026-11-09 | 2026-11-09 | **Done** 2026-11-09 — fork #5–#24 |
| 2 | S3a | False positives on correct code found during S2 | 3 d | ~1 h | 2026-11-09 | 2026-11-10 | **Done** 2026-11-10 — fork #25–#29 |
| 3 | S3b | The other S2 follow-ups: code the checker passes but g++ rejects, checker and parser gaps, housekeeping | 7 d | ~3.5 h | 2026-11-10 | 2026-11-12 | **Done** 2026-11-12 — fork #30–#130, releases E–K |
| 4 | S11 | Conditional compilation pragmas (`{IF defined(X)}` …) as a dialect feature, on in `twincat3` | 2 d | ~3 h | 2026-11-11 | 2026-11-11 | **Done** 2026-11-11 — fork #116 and #119 (S11b), release I |
| 5 | S4 | Ed. 3 forms the fork refused: LTIME, LDATE/LTOD/LDT, CHAR/WCHAR, string index, `STRING[n]`, typed `TRUNC_<type>`, `STRUCT OVERLAP` | 8.5 d (7–10) | ~4.5 h | 2026-11-12 | 2026-11-12 | **Done** 2026-11-12 — fork #131–#139, release L |
| 6 | S5 | Profile-handling defects (S2 plan §1d) | 1 d | ~30 min | 2026-11-12 | 2026-11-13 | **Done** 2026-11-13 — fork #149 |
| 7 | S6 | Runtime safety defects (S2 plan §1d, 14 items) | 7 d | ~3.5 h | 2026-11-13 | 2026-11-18 | **Done** 2026-11-15 — fork #151–#185, release N |
| 8 | S7 | `iec` audit: narrow what `iec-3` accepts (C1–C9) | 6 d | ~3 h | 2026-11-15 | 2026-11-17 | **Done** 2026-11-15 — fork #188–#189 (C6 moved to S12) |
| 9 | S13 | Release-N follow-ups: the consolidated open fork findings (~65 items, [docs/fork-followups.md](docs/fork-followups.md)) in four batches, in this order: (1) silent wrong results, (2) library manifest lengths and kinds, (3) accepted code that then fails in g++, (4) missing diagnostics, tooling and test hygiene, (5) further findings added 2026-11-23 (8: lazy test parser, DT/TOD minus a literal, test-mode docs and install, ADVANCE_TIME in loops, then literal underscores refused under iec-3 — user, 2026-11-23 — long TO_ conversion names and member access on a call result, after checking the standard), (6) OOP through interfaces, added 2026-11-23 and run right after batch 5 (user, 2026-11-23): a method result through an indexed interface element, an interface variable in a POU's VAR crashing the generator, a global named like a method, NOT over an AND of comparisons | — (~77 items) | ~4–5 d (my sizing) | 2026-11-23 | 2026-11-28 | **In progress** (started 2026-11-23): batch 5's quick items merged 2026-11-23 (fork #190 lazy test parser, #191 DT/TOD minus a literal, #192 test-mode docs, #193 test header install), then #194 long TO_ conversion names, #195 ADVANCE_TIME in loops, #196 literal underscores (iec-3/--strict); #197 member access on a call result (feature call_result_access) — **batch 5 done 2026-11-23**; batch 6 started 2026-11-23, then 1–4 |
| 10 | S8 | Flip the no-flag default to the strict dialect, in its own release | 0.5 d | ~20 min | 2026-12-01 | 2026-12-01 | **On hold until S12** (user, 2026-11-15): the default moves to `iec-4` once that dialect exists, not to `iec-3`; until then a build with no flag stays as lenient as today. The toolkit passes `--dialect-file`, so it is unaffected |
| 11 | S9 | Raw memory layout in the runtime: a variable is just its value, STRING a NUL-terminated `char[N+1]`, forcing in a bounded table | 4 d (3–5) | ~2.5 h | 2026-11-10 | 2026-11-10 | **Done** 2026-11-10 — fork #58–#64, release F |
| 12 | S10 | Vendor types and forms for the `twincat3` and `codesys3` profiles | 3 d | ~1.5 h | 2026-11-12 | 2026-11-13 | **Done** 2026-11-13 — fork #144–#148, #154–#155, release M |
| 13 | S12 | A new built-in `iec-4` dialect (IEC 61131-3 Ed. 4, 2025): properties with `PROPERTY_GET`/`PROPERTY_SET` (default PROTECTED), `USTRING`/`UCHAR` (UTF-8) with `LEN_MAX`/`LEN_CODE_UNIT`, `${…}` character codes, string/byte-array conversions, new and changed conversions, `ASSERT`, mutexes and semaphores; IL, octal literals and untyped TRUNC removed, BCD deprecated; also decides C6 (override without `OVERRIDE`, from S7) | 9 d | ~5 h | 2026-11-24 | 2026-11-28 | **Waiting for the standard text** (user will send the full Ed. 4 document; the list so far is from a published comparison that calls itself a selection). Decided 2026-11-15: after S7, does not hold the Marketplace release |

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
   (user, 2026-11-10); S12 does not hold it (user, 2026-11-15).

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

**Status:** merged 2026-11-12 10:56 UTC as [PR #36](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/36)
(`02f2b96`) after the user's Windows checks; new `src/lsp/conditionals.js` and `test/test_conditional_pragmas.js`.

### R11 — Publish to the VS Code Marketplace (user's ask 2026-11-09)

**Goal.** The extension installs from the VS Code Marketplace (and Open VSX, for VSCodium, Cursor and similar),
starting with the first release that carries R2's TC Toolkit sidebar.

**The user's part (one-off, ~15 min):** accounts on both marketplaces were created 2026-11-09 and the publisher ID is
`a-abushaqra`, matching `package.json` (confirmed by the user). Remaining: either upload the release VSIX by
hand, or add an Azure DevOps token with the *Marketplace → Manage* scope as the repo secret `VSCE_PAT` (and an Open VSX token as
`OVSX_PAT`). The publisher profile's "About" text was drafted 2026-11-09.

**Licence:** switched to **AGPL-3.0-or-later** on 2026-11-09 (user's call); the first marketplace release is the
first under it, and the CHANGELOG says so. **Our part (~1 h):** `CHANGELOG.md` (exists since v0.11.0); real `categories` / `keywords` / `homepage` / `bugs`; drop `--skip-license`
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
item F4 as #130 (`c1faca7`), cut as release K; batch 5 skipped D6 (already works) and kept D7 refused (user).

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

No estimates on purpose. Older reasons and numbers stay in [docs/handoff-findings.md](docs/handoff-findings.md)
"Deferred work".

**Toolkit**
- **Windows checks owed (v0.11.0):** the Start/Stop PLC toggle, the ADS DLL path settings and the new editor header;
  a run of `test-activation-target.ps1` plus one real stale-target refusal (`b5b2544`); the NetId-trust PowerShell test script (`c95d52b`).
- **Start/Stop in an Error/Exception state:** offer Start or Stop there (disabled today)? The user decides.
- **A confirmed user-mode NetId could be a remote system's** (found 2026-11-16): the ADS confirmation trusts a stale file
  NetId if another system answers at it through a route. Unlikely; a check against the router's route list would close it.
- **Newer elementary types in library declarations** (found by the release N pin): `src/libraryDecls.js` ELEMENTARY lacks
  LTIME, LDATE, LTOD, LDT, CHAR, WCHAR, PVOID, XINT, UXINT, XWORD, __XINT, __UXINT, so library declarations using them are
  left out. Needs the "no usable declaration" fixtures moved to a type still refused (ANY, HRESULT).
- **Next compiler pin: S7's features in the `twincat3` profile** — release N predates S7, so the profile must list
  `fb_property`, `st_actions`, `bare_self_caret`, `enum_dot_qualify`, `struct_compare`, `dynamic_memory`, `var_inst` when
  the toolkit next pins a fork release that contains #188, and `call_result_access` once the pin contains fork #197
  (user, 2026-11-23: turn it on for TwinCAT). Not before: the release-N compiler refuses an unknown feature id, so the
  profile would stop loading.
- **R14 phase 2** (each needs a Windows probe): remote targets (routes), build one project of a multi-project solution,
  and the Build-pane line numbering inside methods/actions ("approximate" today). The boot project shipped with R15.
- **R2 phase 2: Create New Project through XAE** where TwinCAT is installed (as
  `scripts/Create sample PLC project/build-sample-solution.ps1` does); the XAE Shell path settings it needs exist. Not started.
- **Double-click on a Problems row** opens a `.TcPOU` without jumping (VS Code gives a custom editor no position); the code
  link jumps. Look for a supported way, else say so in the README.
- **R12b informational branch state:** evaluate the `.plcproj` defines in the language server for a hover on `{IF}` and
  greying of inactive branches; never for diagnostics. **Open decision (user):** Debug configuration only, or only where all configurations agree.
- **R12 follow-ups:** Go to Definition on a name declared in several `{IF}` branches returns only the first (needs array
  results from `mapDefinition`); optionally one merged completion item per such name; a conditional POU and
  `<CompilerDefines>` in TcToolkitSample2 once the user has built it in XAE.
- **Find References across a shared interface's sibling implementors** (R7's rename family covers rename only).
- **F2 rename from a call site in the editor panes** (works only in the PLC Objects tree today).
- **Indexing progress "3 of 8 projects"** in the status bar (needs a server → host progress notification).
- **Measure indexing speed on Windows** on a real multi-project workspace with `scripts/measure-indexing.js` (cold
  startup, ~20 s for 8 projects, is still projected).
- **On the user's Windows machine (~1 h):** Libraries-view scoping, library member expansion, squiggle rendering, peek
  dismissal over the real bridge.
- **Open question: pragma hover** — syntax forms, or only the name and the Infosys link? The user decides.
- **Deprecated `twincat.*` setting stand-ins** (PR #34): decide in which release they and `src/settingsMigration.js` go.
- **Dev-only advisory: minimatch 10.2.6 via ESLint 10** (GHSA-g3hv-75wg-m249, moderate): wait for ESLint, or an npm
  `overrides` entry if lint and the suite still pass. Nothing ships with it.
- **Regenerate the social preview** (`node scripts/make-social-preview.js` on Windows, needs Segoe UI) and upload it
  under the repo's Settings → Social preview.
- **Showcase screenshots:** move the scripts from the user's `scratch/showcase/` to `scripts/showcase/` (~30 min).
- **Reply on issue [#25](https://github.com/AbuShaqra/TC_PLC_Toolkit/issues/25):** v0.11.0 carries Add Get / Add Set
  Accessor (PR #27), so the reply is due.
- **Simulation program** (moved from R14 by the user, 2026-11-12): the generated C++ built with g++ into a standalone
  program that runs the PLC code cyclically on the PC; it cannot run vendor-library blocks (only their signatures exist).
- **ADS coupling of the simulation program** (user, 2026-11-12; after the simulation program): exchange variables with a
  running TwinCAT PLC over ADS, e.g. to feed simulated I/O.

**Fork**
- **Release N follow-ups → S13** (fork lane, scheduled 2026-11-17): the open fork findings — older gaps from the S6
  reviews, the smaller S6 PR follow-ups and lane 2's #156 list among them — are consolidated in
  [docs/fork-followups.md](docs/fork-followups.md).
- **Lifecycle methods for dynamic instances** (user, 2026-11-15; after release N; feature `fb_init`): `__NEW` runs FB_init
  and `__DELETE` runs FB_exit, as for static instances. FB_exit at program stop for static instances needs a stop hook.
- **"Accepted means it builds" property test** (user, 2026-11-14): fuzz ST programs; every program `--check` accepts must
  build and run under g++ with ASan/UBSan.
- **Differential tests** (user, 2026-11-14): the same expression as a body assignment, an initial value and a STRUCT
  field default must give the same value.
- **S11's symbol operators** in `{IF}` pragmas (`defined(variable:/type:/pou:)`, `hasattribute`, `hastype`,
  `hasconstantvalue`, `hasconstanttype`): #116 refuses them with a positioned error; evaluating them needs the symbol tables.

## Done

Shipped work lives in git history and the [releases](https://github.com/AbuShaqra/TC_PLC_Toolkit/releases).
Newest first; details are in each PR.

**Toolkit**
- **v0.11.0 released 2026-11-16 23:10 UTC** ([release](https://github.com/AbuShaqra/TC_PLC_Toolkit/releases/tag/v0.11.0);
  dev → main PR #42, `ce688ea`; user: release it, 1.0.0 later) — everything since 0.10.1, with a `CHANGELOG.md`:
  - **R15 ADS online monitoring** — [PR #41](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/41), squash `fbf2bdd`
    into `dev` 2026-11-16 21:09 UTC (started 2026-11-13 13:20 UTC). Go Online, inline values in both panes, a PLC Watch
    view, confirmed and logged writes (off by default); user decisions D1–D9 in
    [docs/r15-ads-decision.md](docs/r15-ads-decision.md). When the local router refuses (4026 user-mode runtime), Go
    Online falls back to a PowerShell helper over Beckhoff's installed TwinCAT.Ads.dll. *Local runtime* targets the
    user-mode runtime's own NetId. Confirmed on the user's PC: Go Online through the helper, inline values, PLC Watch,
    writes, the user-mode NetId, Build and Activate on the first try, boot project with autostart, no helper left after closing.
  - **Compiler at fork release N** — [PR #40](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/40) (`3c24371`); the
    `twincat3` profile gains `string_default_80`; fixes a library FUNCTION named LTIME read as a type.
  - **Activation (R14 follow-ups):** every activation installs the boot project with autostart; a user-mode NetId is
    trusted only for a running instance (`c95d52b`) or confirmed over ADS (`0978d5e`); a stale target offers
    "Change the solution's target…" (`b5b2544`).
  - **Native look** (`674bebc`, `7911c1b`, `b1675e6`): one slim themed editor header, a themed Start Page, a new flat TC mark.
  - **Editor Actions menu** (`db32da5`) with status chips; **title-bar buttons** for Build, Build and Activate,
    activation targets and Go Online/Offline, also in the PLC Objects header and on the Start Page (`d27c161`).
  - **Start/Stop PLC** toggle while online, confirmed each time (`cd896ef`).
  - **ADS DLL path settings** `tcToolkit.adsDll.dotNetLibrary` / `nativeDllFolder` (`0f7161f`).
  - **PLC Watch** in the bottom panel by default (`tcToolkit.online.watchLocation` = `sidebar` moves it); per-row
    redraws batched every 300 ms (`c5566b2`, `e17109a`).
  - **Show Problems** opens the Problems panel; the build time also comes from `_CompileInfo` (`f7eeb31`).
- **Release M pinned** — [PR #39](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/39), 2026-11-14 (`c370b64`): compiler
  and runtime headers at `75a55de`, the TcToolkitSample g++ gap gone, profile gains the S10 features.
- **R14 Build and Activate through XAE** — [PR #38](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/38), 2026-11-13 (`64ff7d9`).
- **R13 C++ generation + g++ compile check** — [PR #37](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/37), 2026-11-13 (`02236c8`).
- **R12 `{IF}`-aware language-server diagnostics** — [PR #36](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/36), 2026-11-12 (`02f2b96`).
- **R3.5 compiler at `eb52d2c`, conditional pragmas, `.plcproj` compiler defines** — [PR #35](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/35), 2026-11-11 (`791fc3a`).
- **Settings keys `tcToolkit.*`** — [PR #34](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/34), 2026-11-11 (`cd52afc`).
- **R3.3, R3.4, R6–R9** (bundled compiler, library declarations, indexing, rename, comments/pragma hover, ESLint 10; the name TC Toolkit) — [PR #33](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/33), 2026-11-11 (`6424968`).
- **R3.2 Compile Project** — [PR #32](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/32), 2026-11-10 (`28f24f1`).
- **R2 sidebar, start page, Create New Project** — [PR #31](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/31), 2026-11-10 (`e5310ae`); licence to AGPL-3.0-or-later.
- **R4 Objects-tree model** — [PR #30](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/30), 2026-11-09 (`d97cec3`).
- **R3.1 STruC++ spike** (`docs/r3.1-strucpp-spike.md`) — [PR #29](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/29), 2026-11-09 (`1b82d08`).
- **R5 and R1** (PROGRAMs stay PROGRAMs, XML parsing fixes, Add Get/Set Accessor; Generate ST rounded end) — [PR #27](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/27), 2026-11-09 (`0ea9fcd`).
- **Roadmap set-up** (housekeeping) — [PR #26](https://github.com/AbuShaqra/TC_PLC_Toolkit/pull/26), 2026-11-09 (`caa686d`).

**Fork** (`AbuShaqra/STruCpp`, branch `development`)
- **S7 `iec-3` audit** — fork [#188](https://github.com/AbuShaqra/STruCpp/pull/188) (`648137f`) and
  [#189](https://github.com/AbuShaqra/STruCpp/pull/189) (`b6788aa`), 2026-11-15, after release N. **Decided by the user
  2026-11-15:** each construct goes behind a feature that is on without a flag and in the TwinCAT profile, so only
  `--dialect iec-3` changes. Refused under iec-3: PROPERTY, ACTION in ST, bare `THIS^`/`SUPER^`, enum `E.Member`, STRUCT
  `=`/`<>`, `__NEW`/`__DELETE`, `VAR_INST`, names with `__` or a trailing `_`. Warned: `{external}`, `1E-4`, assigning
  the FOR variable, `8#`, IL, plain TRUNC. METHOD default access stays PUBLIC (C4 dropped); C9 closed; C6 moved to S12.
- **Release N cut 2026-11-15** at `d9b7c01` (user: fix the two high follow-ups first, then cut):
  - **S6 runtime safety** — fork #151–#185, 2026-11-13 00:10 to 2026-11-15 11:45 UTC. **Decided by the user 2026-11-13:**
    `/` and DIV by 0, a bad index, NULL or unbound reference, and a subrange store fault at run time (task, POU, line;
    `STRUCPP_NO_BOUNDS_CHECK` opts out); SEL/MUX evaluate every input (documented); FB_exit warns that it is never called;
    `*_TO_STRING` gives IEC literal forms; overflow wraps (narrow types computed wide) with a `--strict` warning on
    constant overflow; dependent global initialisers refused under iec-3/`--strict`; a too-long string literal warns;
    pointer arithmetic counts bytes; NOT on an untyped literal typed from context, on INT refused under iec-3/`--strict`;
    INT into a BOOL input warns; `ADR` into a narrower integer refused in every mode. **2026-11-14:** TIME/DATE/TOD/DT are
    4 bytes and unsigned as on TwinCAT, in every profile (negative and sub-ms TIME literals refused); a plain
    STRING/WSTRING is 80 under `twincat3`; MOD by 0 stays 0; to-string keeps the long IEC prefixes.
  - **Fixes on the way:** CONFIGURATION globals and `REFERENCE TO` initial values (#156); non-ASCII names refused with
    exact positions after them (#160); narrow `ADR` refused on every store path (#161, #167); checker crash on
    unrecoverable statements (#163); test runner runs nested ASSERTs and TEARDOWN after a fault (#168); language-server
    crash fixes (#169); library pointer and array parameter shapes (#177); EN/ENO only on a statement or a whole
    right-hand side (#186, breaking); malformed standard-function calls refused instead of crashing (#187).
- **Release M cut 2026-11-13** at `75a55de`: **S10** vendor types and forms (fork #144–#148, #154, #155:
  `__ISVALIDREF`, `XSIZEOF`, `__POUNAME`, `__POSITION`, `BITADR`, `type_colon_optional`, `conditional_return` (CODESYS),
  platform types, BIT as packed bitfields; user: `type_colon_optional` also under `twincat3`, `conditional_return`
  CODESYS-only, a body `udint := ADR(x)` refused in every mode; multicore operators, the vector type and quoted
  identifiers stay unplanned until real code needs them); **S5** profile handling (#149); the post-S4 follow-ups
  (#140–#143: property reads through a global FB instance, `--strict` per Figures 11/12 for bit strings); RETURN nested
  in a test block (#150).
- **Release L cut 2026-11-12** at `3acc3f6`: **S4** Ed. 3 forms (fork #131–#139). **Decided by the user 2026-11-12:**
  Table 36 functions added; DT_TO_DATE/DATE arithmetic fixed (run-time change); the debug map keeps short type names;
  `T#1_500ms` = 1500 ms; `STRING(1_0)` = 10.
- **Releases E–K, 2026-11-10 to 2026-11-12:** **S3b**, the other S2 follow-ups (fork #30–#130 without #48, #58–#64 and
  #116; last F4, STRING stored as Windows-1252, #130 `c1faca7`); **S11** conditional pragmas (#116, release I) and S11b's
  `--pragma-define` / `--file-define` (#119, `eb52d2c`).
- **Release F cut 2026-11-10** at `e071f4f`: **S9** raw memory layout (fork #58–#64; user kept STRING(n) = n+1 bytes).
- **S3a** false errors on correct code — fork #25–#29, 2026-11-10 (`bc171d0`).
- **S2** the fork's gaps — fork [#5](https://github.com/AbuShaqra/STruCpp/pull/5)–[#24](https://github.com/AbuShaqra/STruCpp/pull/24), 2026-11-09, releases A–C (`b286bc2`).
- **S1** the fork's language server honours dialect profiles — fork [#4](https://github.com/AbuShaqra/STruCpp/pull/4), 2026-11-09 (`a529ea9`).
