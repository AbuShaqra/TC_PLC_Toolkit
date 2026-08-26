---
name: workflow-yaml-needs-a-byte-scan
description: A YAML parser passing a GitHub workflow file proves nothing — GitHub rejects control bytes even inside comments, and js-yaml let one through; scan the bytes before pushing
metadata:
  type: feedback
---

Before pushing a change to `.github/workflows/*.yml`, scan the committed bytes for C0 control
characters (anything below 0x20 other than tab, LF, CR), not just parse the YAML.

**Why:** on 2026-08-26 a hand-edited `ci.yml` picked up an invisible 0x03 (Ctrl-C) byte inside a
commented-out `# branches:` line. `npx js-yaml` parsed it without complaint, so the "validated"
file was pushed, PR #3 was merged a minute later, and `main` went to **"Invalid workflow file"** —
CI could not run at all. GitHub's parser follows the YAML spec, which forbids C0 control characters
anywhere in the stream, comments included. The symptom is a run named by the file path
(`.github/workflows/ci.yml` instead of `CI`), event `push`, `failure` with **zero jobs** — and it
appears even when the workflow declares no `push` trigger, because an unparseable file has no
known triggers, so GitHub records a failed run just to surface the error. Fixed in PR #4.

**How to apply:**
- Scan the bytes GitHub will see (the committed blob, not the CRLF working copy):
  `git show HEAD:.github/workflows/ci.yml | node -e 'let n=0;for(const c of require("fs").readFileSync(0))if(c<0x20&&c!==9&&c!==10&&c!==13)n++;console.log(n)'`
  must print `0`. Do not use `grep -P` for this on Windows Git Bash — it exits with "supports only
  unibyte and UTF-8 locales", and a `|| echo none` fallback turns that failure into a green result
  (this happened in the same incident).
- A zero-job run named by the file path is a parse failure, not a test failure — read the file's
  bytes, not the logs (there are none).
- Prefer a real comment stating *why* a trigger is off over commenting the trigger's lines out;
  commented-out YAML invites exactly this kind of stray-character edit.

Related: [[gates-must-propagate-exit-codes]] (a masked check is worse than no check),
[[verify-before-declaring-impossible]].
