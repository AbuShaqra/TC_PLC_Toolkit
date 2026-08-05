---
name: stop-at-implausible-results
description: "When a result contradicts logic or domain experience but still looks plausible, double-check it or ask the user — do not build on it."
metadata:
  type: feedback
---

When a measurement or an experiment produces a result that **contradicts logic or the user's domain
experience** — even when it looks internally consistent and plausible — stop. Verify it another way,
or ask the user, before reporting it as a finding or building anything on top of it.

**Why:** on 2026-07-14 I did this twice in one session, and the user caught both.

1. The 32-bit TwinCAT shell produced 2,530 library signatures where the 64-bit one produced 4,889,
   with 44 libraries completely empty. I concluded "the 32-bit shell is a poorer source" and nearly
   shipped that. The user's objection was pure logic: *a machine with only the 32-bit shell installed
   would then be crippled, so that cannot be true.* It wasn't — we were calling
   `ProduceAllLibrarySignatures()` before the library manager had finished loading, and TwinCAT
   returns an **empty `<TypeSignatures />` element rather than an error**. Polling until the count
   stopped growing took it to 5,382 with zero empty libraries.
2. I then "fixed" a missing library version by asking for `*` (newest). It added without error and
   produced an empty library. Right rule: the highest installed version on the *pinned* version's
   major line.

The shared failure is the same one both times: **a plausible-looking result was accepted instead of
asking whether it could be true.** The tells are specific — a silent empty/zero result, a number that
moved the wrong way, an "absence" reported by a source that has no way to say "I don't know."

**How to apply:** before reporting a surprising finding, ask "what would have to be true about the
world for this to be real?" If the answer is absurd (a whole product configuration would be broken,
a vendor would ship something useless), the tool or my usage of it is wrong, not reality. Re-measure
by a different route, or put the contradiction to the user — they have the domain experience I lack.
Related: [[verify-before-declaring-impossible]].
