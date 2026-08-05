---
name: keep-development-md-current
description: "Always keep DEVELOPMENT.md up to date when architecture, tests, or build change (TC_PLC_Toolkit)"
metadata:
  type: feedback
---

The user asked (2026-07-15) to "set a rule to always keep DEVELOPMENT.md up to date." DEVELOPMENT.md is the durable developer guide (run-from-source, package, tests, architecture) in the TC_PLC_Toolkit repo; it is `.vscodeignore`d so it ships to no user.

**Why:** it had drifted badly — its architecture block predated the M3 refactor + the `features.js` split, and its whole Tests section still pointed at `scratch/test_*.js` when tests had long since moved to `test/` run by `test/run.js`. Stale dev docs cost the next reader real time.

**How to apply:** when a change touches the **architecture** (add/remove/rename a source module, move responsibility, change the process split or the live-language-feature path), the **test layout/commands** (new/renamed/removed harness, how `npm test`/`test/run.js` runs, the typecheck gate, CI), or **build/packaging** (the no-build-step invariant, the VSIX command, offline/Monaco vendoring) — update DEVELOPMENT.md in the *same* change. The rule is also written into the repo's [CLAUDE.md](../../CLAUDE.md) ("Keep DEVELOPMENT.md current — always"). Distinct from HANDOFF.md, which tracks present *state*; see the handoff discipline.
