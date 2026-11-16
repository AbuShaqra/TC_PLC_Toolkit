---
name: review-loops-hold-the-scope-line
description: A branch merges when it delivers its own decision and adds no new bug; older gaps a review finds go to a follow-up list, not into the branch. One review plus one recheck, then merge.
metadata:
  type: feedback
---

A branch under review merges once three things hold: it implements its own scope (the decision or bug
it was opened for), it adds no **new** bug (one that is not already on the integration branch), and
its new tests fail on the old code. Anything older that a review turns up goes on a follow-up list,
not into the branch. Cap the loop at one review and one recheck, then merge with the follow-ups, unless
the recheck finds something new and high-severity.

**Why:** on 2026-11-14 fork work crawled. Adversarial reviews always find nearby pre-existing gaps, and
asking the lane to fix them inside the same branch touched more code, which the next recheck attacked
again. The lexer branch took six rounds, configuration-references four. Running three review batches at
once also pushed a 4-CPU box to load ~35, so the serial 30-minute gates crawled too. Eight PRs merged
in a day that should have merged twice that. The user chose this mode when asked.

**How to apply:** when a review comes back, sort findings by the verifier's "preexisting" flag. Send the
lane only the new ones plus anything inside the branch's own decision or docs claims; collect the rest
for the release's known-issues list. Run at most one review batch at a time while a gate chain shares
the machine. Prefer a structural fix (one central check, one expected-type pass) over a list of
per-construct patches; patch lists are what kept producing new findings.
