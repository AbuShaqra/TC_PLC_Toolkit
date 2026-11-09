# HANDOFF

Where the work *stands*. Read before starting; keep current (handoff rule in [CLAUDE.md](CLAUDE.md)). Target under
100 lines — prune finished items rather than appending, but never drop a real finding to hit it. **Shipped features
live in git history (PRs/commits); the findings that would cost to re-derive live in
[docs/handoff-findings.md](docs/handoff-findings.md)** — read the section covering what you are about to touch.

## Status
- **Released:** `package.json` is at **0.10.1**, and **v0.10.1 is PUBLISHED** (2026-11-03 16:13 UTC: dev→main PR #23
  merged at `3210d33`, Release run 41671593015 green, VSIX `twincat-plc-toolkit-0.10.1.vsix` attached).
- **Version history:** 0.10.1 = Generate ST flattens struct EXTENDS from the project's own DUTs, project-specific
  rewrites removed (PR #22); 0.10.0 = Libraries-view active-project scoping (PR #18); 0.9.0 = the five
  improvement-plan phases (2026-08-27); 0.8.2 project-aware Generate ST + picker; 0.8.1 the ResizeObserver
  Find-References fix; 0.8.0 the solution→PLC-project Objects hierarchy.
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
- **Stale remote branches:** `claude/new-session-ynrdo4` (last used by PR #21) and `claude/project-thread-o6i1sa`
  (PRs #22, #24) are merged; delete them when convenient (not done — needs the user's go-ahead).

## Roadmap
Planned work, in order, is in [ROADMAP.md](ROADMAP.md) (page: https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv):
R1 Generate ST split-button corner fix, R2 create a TwinCAT project from the start view, R3 compile with
STruC++ + the TwinCAT dialect. R2 and R3 have open decisions listed there. None started yet.

## Open / deferred (each with the reason it waits)
- **P7 (tree model)** of the deepening roadmap — parked: its dev-host gate is mandatory and needs the user's
  machine. Everything else in that roadmap is shipped or ruled (P9 no-go); rulings in the findings file.
- **Manual residue on the user's machine:** Libraries-view scoping (TreeView description rendering, webview tab
  switches, startup seeding, `.plcproj`-watcher path end-to-end); library member expansion has never been visually
  confirmed; squiggle rendering is eyeballed only; peek dismissal over the real bridge round-trip.
- **Showcase screenshots** (`scratch/showcase/{run.js,runner.js,shot.ps1}`) exist only on the user's machine
  (`scratch/` is git-ignored) — move to `scripts/showcase/` (+ `.vscodeignore`) if they are worth keeping.
- **Indexing cost — next cuts, deliberately not done:** memoize `collectSignatureFiles` per root (cheap; ~850
  ms/scan, mostly 16 directory walks); non-blocking per-project-readiness scan (biggest win, but rewrites the
  multi-project spine — a wrong readiness gate answers against a partial index); persisted cross-session archive
  cache (needs FORMAT_VERSION discipline + a ZIP-central-directory fingerprint). **Latent:** `scanController`
  records completion in a microtask after `await scan(...)` — safe only while the scan is synchronous; an async
  scan needs in-flight de-duplication. Cold startup (~20 s, 8 projects) is PROJECTED, not measured.
- **L1 reverse index** deferred by decision — reference search is 29 ms cold / ~4 ms warm; reopen past ~1000 files
  or >200 ms.
- **Rename v1 limits:** `.plcproj` sync is outside the rename transaction; sibling implementors of a shared
  interface are not renamed (XAE flags them).
- **Tooling:** ESLint 10 bump (9.x deprecated; raises the Node floor, needs re-triage); dev-only `brace-expansion`
  advisory (the fix drags 19 unrelated lockfile packages).
- **Browser harnesses:** each trips its "browser reported no errors" catch-all on a worker-level 404 that reproduces
  with the old code too — environmental, not yet chased down.
- **Small known gaps:** nested block comments `(* (* *) *)` unsupported (a CODESYS option, default off); no pragma
  hover; the lexer's Pragma token is unclassified (nothing consumes it).

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
