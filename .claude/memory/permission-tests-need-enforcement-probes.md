---
name: permission-tests-need-enforcement-probes
description: chmod(0o000) succeeds on Windows without restricting anything — a test that gates on the CALL succeeding ships a red suite to every Windows checkout; probe enforcement (readdir) instead
metadata:
  type: project
---

# POSIX permission semantics in a test must be probed, not assumed from the API call

## Incident (2026-08-24)

`test_twincat_workspace.js` (written in the Linux container during Phase 5) built an "unreadable"
directory with `fs.chmodSync(blocked, 0o000)` and skipped only if the *call threw* or the process
was root. On Windows the call **succeeds silently and restricts nothing** — mode bits on
directories are not enforced there (that needs ACLs) — so the walker read the "blocked" dir, the
"nothing leaks through" assertion failed, and the first `REQUIRE_FULL_SUITE=1` run on the user's
machine after pulling was red: 71/72. This is the exact mirror of the 2026-08-17 lesson (11 suites
Windows-shaped, red on Linux) with the platforms swapped.

## Rules

- A test that depends on a permission/filesystem restriction must **probe that the restriction is
  actually in effect** (e.g. after `chmod 0o000`, try `readdirSync` — if it succeeds, skip
  cleanly). "The API call didn't throw" proves nothing on the other platform; the probe also
  subsumes special cases like root.
- This suite runs on Windows *and* POSIX checkouts as a matter of course. Whichever platform you
  are on, the test you write today runs on the other one tomorrow — anything platform-dependent
  (permissions, path shape, case sensitivity, EOL) needs either both-platform behaviour or an
  honest `[SKIP]`.
