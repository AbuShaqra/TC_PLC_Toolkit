---
name: branch-cleanup-names-each-repos-integration-branch
description: A branch-cleanup command must spell out each repository's own protected branches; this repo's integration branch is dev, the fork's is development
metadata:
  type: feedback
---

When handing the user a command that deletes remote branches, write one command **per repository**,
each keeping that repository's own integration branch by name — never one "delete all except …" line
meant for several repos.

**Why:** on 2026-11-11 a PowerShell one-liner written for the STruC++ fork ("delete every remote
branch except `development`, `main` and the working branch") was also run in this repo's folder. This
repo's integration branch is `dev`, not `development`, so `dev` was deleted on GitHub. It was noticed
only hours later, when a PR needed a base; the last tip (`cd52afc`, the #34 merge) was still in a local
remote-tracking ref and was pushed back. Without that ref, merged history would have had to be
recovered from PR merge commits.

**How to apply:**
- In any delete command, list the protected names of *that* repo: here `main`, `dev` and the session's
  working branch; in the fork `main`, `development` and its working branch.
- Prefer listing the exact branches to delete over an exclusion pattern.
- Before opening a PR, run `git ls-remote --heads origin` and confirm the base branch exists.

Related: [[verify-before-declaring-impossible]].
