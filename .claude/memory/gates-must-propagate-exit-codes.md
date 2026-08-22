---
name: gates-must-propagate-exit-codes
description: Never pipe a gate command through tail/head/grep in a && chain — the pipe's exit code replaces the gate's, and a red gate sails through green
metadata:
  type: feedback
---

A verification gate chained as `npm run typecheck 2>&1 | tail -1 && git commit ...` commits on a
FAILING typecheck: the pipeline's exit status is `tail`'s (0), so `&&` proceeds. This shipped a
pushed commit with a TS error during Phase 4's close-out (2026-08-22) — caught only because the
next command's output happened to show the error text.

**How to apply:**
- Run the gate bare (`npm run typecheck && ...`) and trim output some other way, or check the exit
  code explicitly (`npm run typecheck; echo "exit: $?"`) before any commit/push in the same chain.
- `set -o pipefail` works in bash scripts, but tool-invoked one-liners rarely set it — don't rely
  on it being there.
- The same trap applies to `npm test 2>&1 | tail -N` — the suite summary text can say PASS while a
  truncated pipe hides a non-zero exit (or vice versa). When a decision hangs on the gate, the
  EXIT CODE is the gate; the text is commentary.
- Second, related trap from the same incident: a `try/catch` around a write to a frozen object
  proves nothing in sloppy mode (the write silently no-ops). Prove immutability with
  `node --use-strict` or `Object.isFrozen`.
