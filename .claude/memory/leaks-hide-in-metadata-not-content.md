---
name: leaks-hide-in-metadata-not-content
description: A privacy sweep that only greps file CONTENT will pass a repo whose commit headers leak an employer and a hostname — check metadata, and check comments for transcribed real-world names.
metadata:
  type: project
---

When sweeping this repo for customer or private data, grep the **content** of every historical blob
*and* separately check the things content-grep structurally cannot see: commit author/committer
headers, commit messages, tag metadata, unreachable objects, and generated/binary files that were
committed (`.tmc`, `.tsproj`, `.xti`, `.library`). Then check source **comments** for real-world names
transcribed as examples.

**Why:** on 2026-08-17 a full sweep of the working tree and all 823 unique blobs across all 125
commits came back completely clean — no emails, no `C:\Users\` paths, no keys, every IPv4 an RFC 5737
placeholder. HANDOFF recorded the history as already purged, and by that measure it was. Two real
leaks survived anyway:

1. **Commit metadata.** 44 of 125 commits were authored *and* committed as an employer address
   (`…@tq-group.com`), and 50 more as `abushaqraa@ABUSHAQRAA-M` — a git-default identity that puts the
   development machine's hostname in the email domain. HANDOFF claimed machine codenames were purged;
   they had been purged from *content*. No amount of blob grepping would ever have found these.
2. **Real names in illustrative comments.** `Balluff BVS Sensor` / `Balluff Sesnor Library TC3` in a
   `libraryTreeProvider.js` doc comment, `Encoderpos.Turn1` as a test decoy, `FB_Clamping`,
   `FB_Loading`, `POUs\Modulezzz\`, `ST_Fanuc_DI`. All transcribed verbatim from the customer project
   the extension was built against — the misspelling "Sesnor" is what proved they were copied rather
   than invented. Two of the sites shipped inside the VSIX. They read as generic placeholders, which
   is exactly why every previous sweep walked past them.

**How to apply:** run `git log --all --pretty='%an <%ae> | %cn <%ce>' | sort | uniq -c` early — it is
one command and it found the worst item here. Treat a plausible-looking vendor or POU name in a
comment as suspect until you can say where it came from; a name that is *oddly specific* (a typo, an
unusual compound, a brand) is transcribed, not invented. When replacing such names, preserve the
property the comment exists to teach — the three-different-spellings point, the decoy that must not
resolve, the backup directory that must still sort last — or the rename quietly destroys the test.

Note the fix asymmetry: content leaks are an ordinary commit, but metadata leaks need
`git filter-repo` plus a force-push, and GitHub keeps force-pushed objects reachable by SHA, so
recreating the repository is the only hard guarantee. That makes metadata the thing to check
**first**, while it is still cheap to fix.

Related: [[reproduce-on-real-artifacts]], [[verify-before-declaring-impossible]].
