---
name: agent-heartbeat-and-verification
description: Background agents must send heartbeats; never assume a quiet agent is alive; always re-verify agent claims
metadata:
  type: feedback
---

Background agents must **report progress frequently / send a heartbeat** so it is possible to tell "still working" from "silently dead". The `implementer` agent definition now mandates SendMessage updates to `main` on start, after investigation, after each file, before long steps, and at least every ~10 tool calls.

**Why:** the user raised this after a background agent vanished with no completion notification, no output, and zero file writes — ~45 minutes were lost while I assumed it was merely slow. Separately, multiple agent reports in this project did not survive independent checking (a library reported "not vendored" *was* vendored under a different extension; a baseline was stale before it was written; a brief's premise was outright false).

**How to apply:**
- Never assume a quiet agent is working. Check liveness (TaskOutput on its id, or whether its owned files have been touched). If it is dead, take the task back and do it directly rather than waiting.
- Always re-measure/re-verify an agent's headline claims before relaying them to the user.
- When running agents in parallel, assign strictly disjoint file ownership and keep shared files (`package.json`, `HANDOFF.md`) centrally owned.

See [[implementer-agent-workflow]].
