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
- **Last verified:** 2026-11-09 (Linux container, `dev` @ `8c19d42`) — `REQUIRE_FULL_SUITE=1 npm test` green
  (**77/77, Coverage: FULL**), `npm run typecheck` and `npm run lint` exit 0. Last Windows pass 2026-08-25 (user's
  machine): full suite FULL plus **`node test/devhost/run.js` all green** (G4 webview checklist, `.TcTLEO` watcher,
  pending-edit persistence). The dev-host and browser harnesses have not been re-run since.
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
- **Merge `claude/focused-ptolemy-m6acaz` into `dev` by SQUASH only** (user decision 2026-11-09): its commit
  `2b06874` carries a `Co-Authored-By: Claude` trailer, which CLAUDE.md forbids; force-pushing a fix was refused
  in the cloud session, and the user chose to leave it and squash. Write the squash message without the trailer.
- **Merge `ccr-d5b51254-r1vu2b` into `dev` by SQUASH only** (user decision 2026-11-09): commit `65d5b1c` on it
  names a private repository the user wants kept out of this repo; the final tree is clean. Delete the branch after.

## Start here (next session)
- **Next task: R5** — the first item of [ROADMAP.md](ROADMAP.md) (page https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv,
  source `docs/roadmap.html`). Work strictly in the roadmap's order: R5 keep PROGRAMs as PROGRAMs + five
  `xmlParser` fixes + issue #25 (re-add a missing property Get/Set) → R1 Generate ST split-button fix → R3.1
  STruC++ spike → R4 Objects-tree model (deepening P7) → R2 create a TwinCAT project → R3.2 check command →
  R3.3 packaging. Forecast end 2026-12-11. R5 was added 2026-11-09 and put first by the user; its full plan
  (verified line numbers, what "done" means) is in ROADMAP.md. Nothing is started. Every R2/R3 decision is SETTLED (2026-11-09, recorded under each
  item in ROADMAP.md) — do not re-ask them. When an item starts, moves or merges, update ROADMAP.md AND
  `docs/roadmap.html` and republish the page to the same URL (rule in CLAUDE.md).
- **R1 in one line:** `media/editor.css:413-416` squares `#generate-st-btn`'s right corners even when the caret is
  hidden (single project). Toggle a class on `#generate-st-group` with the caret's `hidden` and key the CSS on it;
  no `:has()` (VS Code 1.66's Chromium lacks it). Webview change → run both `test/browser/` harnesses.
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
disjoint file ownership; `package.json`/`HANDOFF.md` stay centrally owned. **Verify your own claims too** — three
times an unmeasured but plausible assumption was wrong. Measure, then report.
**Hard-won lessons live in `.claude/memory/`** (committed, so they cross machines), injected each session by the
`SessionStart` hook in `.claude/settings.json`. Write new ones THERE, not in the per-machine bank — rules in
CLAUDE.md. Note `autoMemoryDirectory` cannot do this job: it is **ignored from a checked-in settings.json** by
design, which is why this is a hook.
