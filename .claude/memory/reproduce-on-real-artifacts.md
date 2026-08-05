---
name: reproduce-on-real-artifacts
description: "Reproduce a reported bug against the user's REAL project through the REAL code path before theorizing — synthetic repros encode your assumptions."
metadata:
  type: feedback
---

When the user reports a bug, reproduce it against **their actual project, through the actual code
path the product uses**, before forming any theory. A synthetic test case you write yourself encodes
the assumptions you already have — which are the very things that are wrong.

**Why:** on 2026-07-14 the user reported that Find References on `bDone` listed every `bDone` in the
project. I "fixed" it four times against `.st` files I wrote by hand, shipped each fix, and each time
they came back saying it was still broken. Every fix was a real bug, but none was *the* bug:
- my synthetic `bDone` was a plain `VAR`; in their code it is a method `VAR_OUTPUT` — a different
  code path entirely;
- my synthetic files were indexed with `parseAndIndexDocument`, but the product indexes other files
  with `xmlIndexer`, whose ranges are in a *different coordinate space* — so my harness could never
  show the failure;
- the actual root cause was in the **parser**, not references at all: `fbQueue.Get(Item := n)` was
  read as a PROPERTY accessor, so the parser scanned for an `END_GET` that never comes and swallowed
  24 of that FB's 44 methods. Every variable in them became invisible, and Find References keeps
  whatever it cannot resolve.

The moment I ran their real `FB_Axis` through the real server path (`indexTwinCatDirectory` +
`syncDocument` + `provideReferences`), the cause was obvious in one pass.

**How to apply:** first reproduce on the real artifact, and when a subsystem "cannot resolve"
something, ask *why the symbol is missing from the index* rather than patching the consumer that
copes with it missing. Also: measure before optimising a hypothesis — counting showed only 8 of 1,893
bad references matched the shape I had spent three rounds fixing, and 1,885 matched one I had not
looked at.
Related: [[stop-at-implausible-results]], [[verify-before-declaring-impossible]].
