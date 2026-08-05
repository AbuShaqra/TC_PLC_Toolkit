# Shared project memory

Lessons this project has already paid for, kept **in the repo** so they follow the work to any
machine instead of living in one developer's `~/.claude`.

Every note here was earned the expensive way — a wrong conclusion shipped, a day lost to a silently
dead agent, four "fixes" for a bug that was somewhere else entirely. That is the bar for adding one.

## How it reaches a session

`.claude/settings.json` declares a `SessionStart` hook that runs `bank.js`, which prints one line per
note — the name, the description, and the path — as session context. Cloning the repo is the entire
setup.

It is a hook rather than the `autoMemoryDirectory` setting because that setting is **deliberately
ignored when it comes from a checked-in `.claude/settings.json`**. A repo cannot redirect Claude's
memory directory; every machine would have to opt in by hand, and one that forgot would silently lose
every shared note.

The per-machine bank under `~/.claude/projects/<sanitized-cwd>/memory/` still works and still loads.
The two are complementary — see "Which bank" below.

## The format

One note per file, named `<slug>.md` where `<slug>` **must equal** the frontmatter `name` (that is
what `[[wikilinks]]` resolve against, and `--check` enforces it):

```markdown
---
name: some-hard-won-lesson
description: One line. This is the index entry a session reads to decide whether to open the note.
metadata:
  type: feedback
---

What to do, stated as a rule.

**Why:** what happened that makes this worth a file. Be concrete — dates, counts, the actual failure.

**How to apply:** what to do differently, specifically enough to act on.

Related: [[another-note]].
```

`type` is one of `user`, `feedback`, `project`, `reference`. A `[[link]]` to a note that does not
exist yet is fine — it marks one worth writing — and `--check` reports it without failing.

## Which bank

| Goes here (shared, committed) | Goes in the per-machine bank |
|---|---|
| Lessons about working on *this* project that hold anywhere | Anything tied to one machine: local paths, installed TwinCAT versions, personal tooling |
| Corrections that would otherwise be re-learned by the next person | Preferences that are yours rather than the project's |

If a note would still be true on a fresh clone on someone else's laptop, it belongs here.

Do **not** duplicate what the repo already records. Architecture belongs in `DEVELOPMENT.md`, current
state in `HANDOFF.md`, and the rules of the codebase in `CLAUDE.md`. This bank is for how to *work* —
the judgement that no file in the repo would otherwise carry.

## Adding one

Write the file. It is version-controlled, so it lands in the next commit like any other change —
there is no index to update, because `bank.js` builds the digest from the files themselves.

```bash
node .claude/memory/bank.js --digest   # what a session will be shown
node .claude/memory/bank.js --check    # validate; also runs in `npm test`
```
