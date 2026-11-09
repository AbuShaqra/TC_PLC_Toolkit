# HANDOFF

Where the work *stands*. Read before starting; keep current (handoff rule in [CLAUDE.md](CLAUDE.md)). Target under
500 lines (user ruling 2026-11-09) — prune finished items rather than appending, but never drop a real finding to hit it. **Shipped features
live in git history (PRs/commits); the findings that would cost to re-derive live in
[docs/handoff-findings.md](docs/handoff-findings.md)** — read the section covering what you are about to touch.

## Status
- **Released:** `package.json` is at **0.10.1**, and **v0.10.1 is PUBLISHED** (2026-11-03 16:13 UTC: dev→main PR #23
  merged at `3210d33`, Release run 41671593015 green, VSIX `twincat-plc-toolkit-0.10.1.vsix` attached).
- **Version history:** 0.10.1 struct EXTENDS from own DUTs (PR #22); 0.10.0 Libraries scoping (PR #18); 0.9.0
  improvement-plan phases; 0.8.x project-aware Generate ST, ResizeObserver fix, solution→project Objects tree.
- **Last verified:** 2026-11-09 (Linux container, `dev` @ `0ea9fcd`, i.e. after PR #27) — `REQUIRE_FULL_SUITE=1 npm test` green
  (**82/82, Coverage: FULL**), `npm run typecheck` and `npm run lint` exit 0; both browser harnesses green. Last Windows pass 2026-08-25 (user's
  machine): full suite FULL plus **`node test/devhost/run.js` all green** (G4 webview checklist, `.TcTLEO` watcher,
  pending-edit persistence). The dev-host harness has not been re-run since.
- **Sample diagnostics: 0 against a baseline of 0** — verified with the Beckhoff archives present AND moved aside.

## Branching, CI and repo settings
- `dev` collects day-to-day work; a release is a `dev → main` PR, then the manual *Release* workflow on `main`
  (procedure: DEVELOPMENT.md "Publish a GitHub release"). `dev` has no ruleset — direct pushes are allowed.
- **CI is PR-only** (`ci.yml`, `pull_request: [main, dev]`): lint → typecheck → `npm test` with
  `REQUIRE_FULL_SUITE=1` (a REDUCED run fails), plus a VSIX build check (ruled: "releasable" includes "packages").
  Direct pushes to `dev` trigger nothing; use *CI (manual)* (`ci-manual.yml`, `ref` defaults to `dev`).
- Ruleset `main-1` on `main`: PR required, **0 approvals**, no bypass list, **no required status checks** — a red
  CI does not block the merge button (adding the `build` check is the one change that would). Actions permission
  is `selected` + GitHub-owned (`local_only` killed every run with `startup_failure`). Confirm a run's real
  conclusion before trusting a badge; scan workflow YAML bytes before pushing
  (`.claude/memory/workflow-yaml-needs-a-byte-scan.md`).
- Repo is **Private**. History was rewritten twice and the repo deleted-and-recreated 2026-08-26; that sweep is
  complete. Before any future sweep read `.claude/memory/leaks-hide-in-metadata-not-content.md`, and never restate
  the original names that the synthetic ones (`Acme*`, `FB_Gripper`, `Modules_bak\`, …) replaced.
- **Stale remote branches:** `claude/new-session-ynrdo4` and `claude/project-thread-o6i1sa` are merged into `dev`
  (checked 2026-11-09). The user asked to delete them, but this cloud session's git proxy drops every push
  except to the session branch, so they still exist — delete from the GitHub UI or a local clone.
- **Merge `claude/focused-ptolemy-m6acaz` into `dev` by SQUASH only, every time** (PRs #27, #29 so far): after PR #27 the branch was
  restarted from `dev`, but force-pushing was refused, so the old branch was merged back in (no file changes);
  its history still holds commit `2b06874` with a `Co-Authored-By` trailer that must never reach `dev`.
- **Merge `ccr-d5b51254-r1vu2b` into `dev` by SQUASH only** (user decision 2026-11-09): commit `65d5b1c` on it
  names a private repository the user wants kept out of this repo; the final tree is clean. Delete the branch after.

## Start here (next session)
- **R5 + R1 are MERGED into `dev`** (PR #27, `0ea9fcd`) and their **Windows/XAE check PASSED** (user, 2026-11-09:
  accessor add/re-add opens and builds in XAE, `node test/devhost/run.js`, menu pass). That pass found the multi-project
  Generate ST menu clipped in a narrow editor (right-aligned to the caret → ran past the webview's left edge; long names
  scrolled sideways): fixed in `3b93ef1` (`placeGenerateMenu` in `media/editor.js`, ellipsis + tooltip;
  `test/browser/run.js` 7c checks 360/560/1200 px, all three failed before). Still owed: reply on issue #25 when it
  ships in a release. User request 2026-11-09, done: a tri-state *Select all* in that menu (`#generate-st-all`,
  `syncSelectAll`; "Generate selected" disabled while nothing is ticked; harness 7d).
- **R3.1 spike findings are DONE** (2026-11-09): `docs/r3.1-strucpp-spike.md`. Headline: 27 parse errors as
  converted; 1 converter cause (methods/properties emitted after the POU body — the compiler wants them first) +
  9 compiler gaps; with scratch workarounds 0 errors under twincat3, 6 under iec (REFERENCE TO, REF=). No
  check-only CLI flag (`analyze()` is check-only but unreachable from the CLI bundle; a wrapper or a fork
  `--check --json` flag). Export-mode input is WRONG to check (it rewrites REFERENCE TO→POINTER TO, REF=→:=);
  R3.2 must feed a raw-based unit. **Decided 2026-11-09:** wait for the fork (fork-lane item S2, before R3.2;
  the roadmap now has a parallel STruC++ fork lane: S1 language-server dialect profiles — DONE, fork PR #4
  `a529ea9`, client contract in its PR body; S2 compiler gaps: plan DONE and decided 2026-11-09 —
  `docs/s2-strucpp-fork-plan.md`, all 13 steps + 1b (~22.5 d), `iec` = Ed. 3, Annex A precedence). Merged in the fork: step 1
  (`--check --json`, lexer positions; PR #5 `8aea9a7`) and 1b (`iec` renamed `iec-3`, no alias, id reserved; PR #6
  `5fda1bc`). Step 2 (pragmas skipped with a warning, conditional ones refused; PR #7 `47c99fa`) also merged — the toolkit's
  check (R3.2) can now analyse every sample file. Step 3 (`SUPER.` always on, `THIS^` behind `self_caret`; PR #8
  `db0f53c`) merged. Step 4 (member-chain method calls; PR #9 `19f91a7`) merged. Fork follow-ups found
  along the way, not yet scheduled: plain `SUPER()` body call; `SUPER.x :=` as a target; `p^.M()` (C++ for an FB behind
  REF_TO does not build); single-dot `inst.Nope()`/`intVar.M()` pass the checker and fail only in g++; positional
  method calls that omit a VAR_OUTPUT fail in g++; an unknown member in a chain (`x := mid.nothing`) is not flagged.
  Step 5 (interface-typed variables, `IEC_ITF<I>`; diamonds via virtual inheritance on shared edges only; PR #10
  `c5ee894`) merged — not yet: ARRAY OF / STRUCT field of interface type, properties through an interface variable.
  Step 6 (interface PROPERTY behind `property`, explicit GET/SET; PR #11 `5b99425`) merged = **release B**.
  More fork follow-ups: `THIS.a.b` does not parse; an FB that IMPLEMENTS an interface only through a base FB's
  methods/properties passes analysis but fails g++; IMPLEMENTS ignores methods from interface EXTENDS bases;
  an FB property inherited from a base FB fails in g++ when used on the derived instance. Step 7 (chained comparisons, Annex A; PR #12 `5fde942`) merged.
  Step 8 (`postfix_enum_base`; PR #13 `da78fe3`) merged. Also found: `TO_DINT(enumValue)` fails in g++ (pre-existing).
  Step 9 (`named_global_lists`; PR #14 `fafc02e`) merged. List = file stem, override `--global-list <file>=<name>` /
  API `globalListName`; a local may hide a global (`GVL_A.x` still reaches it); the same name in two lists is allowed
  (plain use must be qualified). R3.2's converter must pass each GVL's name. Also found (pre-existing):
  `gfb(a := 2);` on a top-level global FB fails in g++; bundled-library global `speed` collides with a user global;
  `--feature` help text and DIALECTS.md "Checks" list stale; `GVL_A.units[0]()` does not parse; lexer accepts `a__b`.
  Step 10 (`struct_extends`; PR #15 `a962890`) merged: flattened in the AST; derived↔base assignment and arguments
  refused (6.4.4.6); a library STRUCT as base refused for now (manifests carry no initial values). Also found
  (pre-existing, plain STRUCTs): unknown member `s.zz` unflagged in ST; `POINTER TO ST := ADR(s)` refused;
  `REF(s)`/`REF=`/STRUCT `=` fail in g++; unrelated-STRUCT arguments unchecked in ST (fail in g++).
  Step 11 (`union` parse + analysis; PR #16 `337817f`) merged: contextual (no new tokens, `union` stays a name);
  STRING members allowed; initial values refused as "not supported yet" (possible R3.2 false positive); compile()
  refuses UNION until step 12. Found (pre-existing): a STRUCT alias is not assignment-compatible with its STRUCT;
  `STRING[n]` does not parse (B6, use `STRING(n)`). Next: step 12 (UNION C++ lowering, raw storage), running. The vendored profile now extends `iec-3`.
  The IEC Ed. 3 copy the user supplied is licensed to another party: cite clause numbers only, never its text. **R4 DONE 2026-11-09** — `src/objectsTreeModel.js` (VS Code-free node graph; ids and contextValue set
  in one place, `getParent` = `node.parent`), thin `treeDataProvider.js`, `groupRootsByProject` moved out of
  `projectMap.js`; `test_objects_tree_ids.js` pins 396 ids / 301 reveal chains (a required gate); suite 84/84 FULL.
  Intended fix: grouped-mode reveal chains now show the tree's own project label (86 mismatches gone). **MERGED** — PR #30 squash `d97cec3`
  into `dev` 2026-11-09 after the dev-host gate passed on Windows; the session branch was restarted from `dev`. and R3.2 full scope (7 d). Next roadmap item: R4.
- **R2 scope grown 2026-11-09 (user's ask, decided by card):** an Activity Bar container `TwinCAT` with a Start view
  (native `viewsWelcome` buttons) plus Objects and Libraries MOVED out of the Explorer; "Open Start Page" opens a
  webview tab: create project (4024/4026, name, location), open existing (+ recent solutions), project actions
  (Generate ST, Update Library Definitions, STruC++ check once R3.2 ships), help/links, settings. 6 → 8.5 d.
- **Backlog scheduled 2026-11-09 (user's ask):** toolkit R6–R10 (R10 on trigger only) and fork S3a–S8 are now rows in
  ROADMAP.md with my own sizing (not measured) at the Nov 9 velocity, ~4 h of session per working day. **S3a (three
  false positives on correct code) goes before R3.2**; S7 (iec-3 audit) needs the user's decision first; S8 after R3.3.
- **Roadmap re-measured 2026-11-09** (user's ask): ~20 planned days were delivered in ~7 h that day (ROADMAP.md
  "Velocity"). New forecasts assume half that pace; toolkit R2–R3.3 ~2026-11-17, R6–R9 ~2026-11-19, S2 ~2026-11-11, fork S3a–S8 ~2026-11-18. The real pacing
  item is the user's Windows checks (R5 XAE, R4 dev-host via PR #30, R2 skeleton/XAE proofs) — never forecast.
- **Was next: R3.1** (STruC++ spike) — [ROADMAP.md](ROADMAP.md) (page https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv,
  source `docs/roadmap.html`). Order: R3.1 → R4 Objects-tree model (deepening P7) → R2 create a TwinCAT project →
  R3.2 check command → R3.3 packaging. Forecast end 2026-12-05. Every R2/R3 decision is SETTLED (2026-11-09,
  recorded under each item in ROADMAP.md) — do not re-ask them. When an item starts, moves or merges, update
  ROADMAP.md AND `docs/roadmap.html` and republish the page to the same URL (rule in CLAUDE.md).
- **R3 inputs:** STruC++ fork `AbuShaqra/STruCpp`, default branch `development` (@ `2c223c9`, v0.7.0, GPL-3.0-only,
  Node ≥ 22; dialect flags `--dialect-file`/`--dialect-path`, `src/dialect.ts`, `docs/DIALECTS.md`;
  `npm run build:bundle` → `dist/strucpp-bundle.cjs`). The TwinCAT profile is vendored at
  `resources/dialects/twincat3.json` — that file is the only external input. **Do not name, link or describe where
  it came from** in any file, commit or comment (user rule 2026-11-09: the source is a private repository the user
  has disconnected). The STruCpp repo has its own CLAUDE.md process rules — read them before changing it.
- **R2 inputs:** the 3.1.4024 skeleton arrived 2026-11-09 — `resources/templates/xae-3.1.4024/` (XAE 3.1.4024.62
  output, `.vs`/`.bak`/`_Boot`/`_Libraries` left out; README there). It saves the system project as ONE `.tspproj`,
  where 4026 (`sample/`) wrote `.tsproj` + `_Config/` — R2 must handle both shapes. Its GVL has a sample variable
  and `qualified_only`; the template empties it. Still machine-bound: proving each template opens and builds in XAE.
- **Cloud-session traps (2026-11-09):** the git proxy accepts pushes ONLY to the session branch (deleting other
  branches failed every time); `git reset --hard` was refused by the auto-mode classifier — use revert + merge.

## Open / deferred (each with the reason it waits)
- Deepening roadmap: everything but P7 (now roadmap R4) is shipped or ruled (P9 no-go; rulings in the findings file).
- **Manual residue on the user's machine:** Libraries-view scoping (TreeView description rendering, webview tab
  switches, startup seeding, `.plcproj`-watcher path end-to-end); library member expansion has never been visually
  confirmed; squiggle rendering is eyeballed only; peek dismissal over the real bridge round-trip.
- **Showcase screenshots** (`scratch/showcase/{run.js,runner.js,shot.ps1}`) exist only on the user's machine
  (`scratch/` is git-ignored) — move to `scripts/showcase/` (+ `.vscodeignore`) if they are worth keeping.
- **Deferred by decision** (indexing cuts, L1 reverse index, rename v1 limits, ESLint 10, small language gaps): the
  ROADMAP.md backlog lists them; each one's reason and numbers are in `docs/handoff-findings.md` "Deferred work".
- **Browser harnesses:** each trips its "browser reported no errors" catch-all on a worker-level 404 that reproduces
  with the old code too — environmental, not yet chased down.

## Do-not-break list (details in the findings file / DEVELOPMENT.md)
- `sample/` is ground truth: every diagnostic on it is a bug; never raise a baseline. Verify library-related
  changes with `_Libraries/Beckhoff Automation GmbH` present AND moved aside (move it, never delete).
- Never teach `custom/reindex` to skip; never add `_libraries` to `SKIP_DIRS`; register library symbols on demand
  only; cached signature records stay private copies (DEVELOPMENT.md "Indexing cost").
- Library types are anonymous UNKNOWN on purpose; member-checking them stays OFF (four guards in `types.js`).
- Normalized (lowercased) path keys are identity, never file paths or uris
  (`.claude/memory/normalized-keys-are-not-file-paths.md`); scope every name-keyed structure per `.plcproj`.
- `.gitattributes eol=crlf` is load-bearing — never delete it. Use `dir/*`, not `dir/`, before gitignore negations.
- TwinCAT's XML loader is order-sensitive: root `<Folder>` tags and new members must land before `<LineIds>`.
- `templates/` ships in the VSIX and must stay generic; `scripts/Build PLC project/` is the fuller, unshipped
  copy. The user syncs the two BY HAND — never promote one into the other automatically.
- Internal ids (`twincat.*`, `twincat.xmlViewer`) are deliberately not renamed.

## Working agreement
Implementation is delegated to the **`implementer`** agent; the main conversation owns architecture/planning/review/
commits. **Verify every agent claim** (several haven't survived checking); agents run in parallel only with strictly
disjoint file ownership, and never run `git stash`/`checkout`/`reset` while another agent has uncommitted work
in the tree (2026-11-09: one stashed to count old-code failures; harmless only because the other's work was
already committed); `package.json`/`HANDOFF.md` stay centrally owned. **Verify your own claims too** — three
times an unmeasured but plausible assumption was wrong. Measure, then report.
**Hard-won lessons live in `.claude/memory/`** (committed, so they cross machines), injected each session by the
`SessionStart` hook in `.claude/settings.json`. Write new ones THERE, not in the per-machine bank — rules in
CLAUDE.md. Note `autoMemoryDirectory` cannot do this job: it is **ignored from a checked-in settings.json** by
design, which is why this is a hook.
