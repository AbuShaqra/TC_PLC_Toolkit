---
name: stubbed-vscode-is-not-vscode
description: A change to how the extension drives VS Code's own UI (tree refresh, views, focus) must be checked in a real VS Code, not only against the recording vscode stub.
metadata:
  type: feedback
---

When a change depends on how VS Code itself reacts (TreeView refresh, view visibility, focus,
progress), prove it in a real VS Code before telling the user it works. The harnesses' `vscode` stub
records what the extension sends; it cannot show what VS Code does with it.

**Why:** on 2026-11-16 PLC Watch was changed to redraw only the changed row (`fire(row)`), to stop
VS Code's progress bar flashing on every value. The stubbed test passed (the event carried the right
object). On the user's PC the value never appeared at all, and the change had to be reverted. A
real VS Code (1.95.3 and 1.146.0, run under xvfb with Playwright's `_electron`) reproduced it: the
provider reused the same row object across full reloads, and VS Code silently drops a one-row
redraw of an object it saw in an earlier reload. New objects per reload fixed it (19 values in 3 s,
progress bar 0 of 150 samples).

**How to apply:** download VS Code into the scratchpad with `@vscode/test-electron`
(`downloadAndUnzipVSCode`), load a tiny probe extension that uses the real module under test with a
fake data source shaped like the live one (same event order: here, the first value arriving inside
`subscribe()`), launch it with Playwright's `_electron` under `xvfb-run`, and sample the DOM. Ask the
user first: downloading and launching it may need their approval. Do the probe before the user
tests, not after their report.
