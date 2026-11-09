---
name: one-checkout-one-writer
description: While an agent works in a checkout, the orchestrator never switches branches there or edits files the agent will rewrite.
metadata:
  type: feedback
---

While a delegated agent is working in a checkout, treat that checkout as the agent's: do not switch
branches, reset, or edit files the agent is likely to rewrite (HANDOFF.md, ROADMAP.md, docs). Sync with
`git fetch` and read through `git show`/a separate `git worktree`; make your own edits only in files the
agent was told not to touch, and re-check them after its commit lands.

**Why:** 2026-11-09, twice in one session. (1) The R2 agent's docs commit (`d45053b`) rewrote HANDOFF.md
from its own earlier copy and silently dropped two entries the orchestrator had committed meanwhile
(the AGPL switch and R11); they were found only by chance and restored in `b849007`. (2) A post-merge
sync ran `git checkout development && git reset --keep origin/development` in the fork checkout while
the fork agent sat on its feature branch; only luck (its work was untracked) kept that harmless.

**How to apply:** after delegating, run post-merge syncs as `git fetch` only (no checkout) until the
agent reports done; give a docs-touching agent an explicit list of entries it must preserve, and after
its commit, `git diff <your last commit> HEAD -- HANDOFF.md ROADMAP.md` to catch dropped lines.

Related: [[agent-heartbeat-and-verification]].
