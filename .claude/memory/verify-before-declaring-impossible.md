---
name: verify-before-declaring-impossible
description: "Never declare something impossible from \"I looked in N places and it wasn't there\" — say what was checked instead."
metadata:
  type: feedback
---

Do not conclude that something is **impossible** or **does not exist** on the strength of "I checked
the places I could think of and it wasn't there." Report what was actually checked, and what remains
unchecked.

**Why:** on 2026-07-13 I searched three sources for TwinCAT library function-block *methods* (the ZIP
archives, Beckhoff's decoder DLLs, the Automation Interface), found none, and wrote "library FB
methods exist in no readable source" into the README, HANDOFF.md, a code comment, and told the user
flatly it could not be done. They were in the project's `.tmc` all along — in `<Method>` blocks that
the parser simply never read. 860 of them in the sample project. Absence of evidence in the places I
looked is not evidence of absence.

**How to apply:** distinguish "I could not find X in A, B and C" from "X does not exist." The first
is a fact; the second is a claim about the world that needs a reason. Before writing an impossibility
into docs or telling the user something cannot be done, re-read the sources already parsed — the
answer is more often in a file we already open than behind a wall we failed to break.
Related: [[stop-at-implausible-results]].
