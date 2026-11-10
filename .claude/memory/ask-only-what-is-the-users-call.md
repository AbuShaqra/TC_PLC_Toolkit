---
name: ask-only-what-is-the-users-call
description: Decide routine calls yourself from the standing rules; interrupt the user only for decisions that are genuinely theirs.
metadata:
  type: feedback
---

Do not stop the work to ask the user about every choice. Decide routine calls yourself from the rules
already on record (the narrowing rule, earlier card answers, CLAUDE.md, HANDOFF.md decisions), record the
choice and its reason in HANDOFF.md, and keep going. Ask (as a card) only when the answer is genuinely the
user's and cannot be derived: it breaks code or behaviour that works today, it is a licence, publishing,
money or public-facing wording call, it is irreversible, or the standing rules conflict.

**Why:** 2026-11-10, the user, after a run of card questions on fork details: "Don't keep pausing to ask me
questions about everything! I am not always watching the conversation here. Just ask the important and
necessary questions." A blocking question while the user is away stalls the whole pipeline for hours.

**How to apply:** before an AskUserQuestion, check whether an existing rule already answers it; if it
does, apply it and say so in the status update instead. When a real question is needed, keep other
independent work moving meanwhile, and batch questions rather than asking one at a time. Brief agents
the same way: decide by the rules, report the choice, stop only for a user-level decision.

Related: [[one-checkout-one-writer]].
