---
name: shallow-clone-is-not-the-repo
description: A shallow clone passes every casual completeness check — run `git rev-parse --is-shallow-repository` before any audit, mirror-push, or cutover that treats the clone as the source of truth.
metadata:
  type: project
---

Before treating a local clone as a complete copy of the repository — auditing its history, pushing it
to a recreated repo, or deleting the remote it came from — run
`git rev-parse --is-shallow-repository`. If it says `true`, nothing derived from that clone's history
is complete, even though every everyday command looks normal.

**Why:** during the 2026-08-26 delete-and-recreate of the GitHub repo (the final step of the privacy
sweep), the remote container's clone was shallow: it held **147 of 209 commits**, and nothing said so.
`git log --all` walked cleanly to what looked like the root, the identity audit ran without complaint
(silently covering only the fetched portion), and `git rev-list --count` returned a plausible number —
shallow grafts hide the boundary, so there is no visible seam. The first hard failure was the push to
the fresh empty repo: `remote: fatal: did not receive expected object <sha> … index-pack failed`,
because the pack built from a shallow history necessarily lacks the objects below the graft.

Two rules that fall out of it:

1. **An audit over a shallow clone is an audit of the fetched window, not the repo.** The pre-push
   identity check here initially "verified all refs clean" over 147 commits; 62 more existed. Unshallow
   first (`git fetch --unshallow <source> <branch>`), then re-run the audit — here the full-history
   re-audit happened to agree, but that was luck, not method.
2. **Order destructive cutovers so nothing is deleted until the replacement is verified.** The
   recreate was deliberately staged rename-first (`repo` → `repo-old`, create fresh `repo`, push,
   verify SHA/fsck, only then delete `repo-old`). That ordering is what turned this from data loss
   into a retry: the missing 62 commits were still fetchable from the renamed repo. Had the old repo
   been deleted before the push, the only complete clean history would have been gone.

Related trap in the same environment: a renamed GitHub repo leaves a redirect, so pushes and fetches
against the old name silently land on the renamed repo ("Everything up-to-date" from what should have
been an initial push is the tell). The redirect dies only when the name is reoccupied or the repo
deleted — which also means deletion, not renaming, is what actually retracts old SHA-addressed URLs.

Related: [[leaks-hide-in-metadata-not-content]], [[verify-before-declaring-impossible]].
