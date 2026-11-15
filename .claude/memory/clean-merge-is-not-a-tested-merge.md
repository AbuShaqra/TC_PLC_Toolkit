---
name: clean-merge-is-not-a-tested-merge
description: A branch gated on an old base must be re-tested on top of current development before merging, even when git merges it with no conflict.
metadata:
  type: feedback
---

Before merging a branch whose gate ran on an older base, merge current `development` into it and run
the full build and test suite on that result, whenever any file it changes was also changed on
`development` since its gate. "Git reported no conflict" proves nothing about behaviour.

**Why:** on 2026-11-15, the bool-input branch had turned an `if (this.strict) {` block in
`type-checker.ts` into an unconditional one, so it could warn in every mode. Meanwhile `development`
gained a strict-only check inside that same block. Git auto-merged it with no conflict, and the
strict-only check silently started running in every mode. Each side passed its own gate; only the
combined build caught it, when OSCAT's library rebuild failed with 12 false "Implicit conversion …
is not allowed" errors. Merged blind, every OSCAT user would have been hit.

**How to apply:** use the combined-test step (worktree on the branch, `git merge origin/development`,
`cp -al` node_modules, build, full vitest, extension tests) for every overlapping branch. When
`development` moves again before the merge and touches the same files, re-run it. Watch especially
for hunks that change a guard (`if`, early `return`) around code another branch also edits.
