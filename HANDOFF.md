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
- **R5 + R1 are MERGED into `dev`** (PR #27, squash `0ea9fcd`, 2026-11-09) — **before their Windows check, at the
  user's call** ("I will test it later when I have access to XAE"). Still owed on the user's machine, before the
  next release: (1) an accessor added via *Add Get/Set Accessor* to an FB property (`sample/` `FB_Station.ErrorId`)
  and an interface property (`I_Station.State`) opens and builds in XAE — the new accessor carries no LineIds,
  as a newly created property never has; (2) the user's real case: delete an accessor IN XAE, re-add it here,
  reopen in XAE; (3) `node test/devhost/run.js`; (4) manual: each Add entry shows only while its accessor is
  missing, and copy/paste/delete/rename/insert stay on every property row (contextValue is now
  `propertyNode[.noGet][.noSet]`); (5) the Generate ST button in a one- and a two-project workspace. Then reply on
  issue #25 when it ships in a release (not yet replied).
- **R3.1 spike findings are DONE** (2026-11-09): `docs/r3.1-strucpp-spike.md`. Headline: 27 parse errors as
  converted; 1 converter cause (methods/properties emitted after the POU body — the compiler wants them first) +
  9 compiler gaps; with scratch workarounds 0 errors under twincat3, 6 under iec (REFERENCE TO, REF=). No
  check-only CLI flag (`analyze()` is check-only but unreachable from the CLI bundle; a wrapper or a fork
  `--check --json` flag). Export-mode input is WRONG to check (it rewrites REFERENCE TO→POINTER TO, REF=→:=);
  R3.2 must feed a raw-based unit. **Decided 2026-11-09:** wait for the fork (fork-lane item S2, before R3.2;
  the roadmap now has a parallel STruC++ fork lane: S1 language-server dialect profiles — DONE, fork PR #4
  `a529ea9`, client contract in its PR body; S2 compiler gaps: plan DONE and decided 2026-11-09 —
  `docs/s2-strucpp-fork-plan.md`, all 13 steps (~22 d), `iec` = Ed. 3, Annex A precedence; step 1 next).
  The IEC Ed. 3 copy the user supplied is licensed to another party: cite clause numbers only, never its text. **R4 started 2026-11-09** (early; an agent is building `src/objectsTreeModel.js`). and R3.2 full scope (7 d). Next roadmap item: R4.
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
- **Machine-bound steps:** R4's `node test/devhost/run.js` gate and R2's templates need the user's Windows machine;
  R2's 3.1.4024 skeleton must be produced by a 4024 XAE there (the 4026.22 one is `sample/`'s).
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
