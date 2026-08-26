---
name: benign-browser-notices-are-error-events
description: A catch-all window 'error' handler fires on Chrome's benign ResizeObserver notice and no headless gate shows it — filter it, and LOOK at the real window after a webview change
metadata:
  type: feedback
---

Any "catch every error and show it" handler in the webview must filter the browser's benign notices,
and a webview change is not verified until someone has LOOKED at the real window doing the thing.

**Why:** `media/editor.js` painted a full-pane "Webview Runtime Failure" overlay (and toasted
"Webview Error") on every `window` error event. Chrome delivers "ResizeObserver loop completed with
undelivered notifications" as exactly such an event whenever a ResizeObserver callback changes
layout in the same frame — Monaco's `automaticLayout` observer does that when the references peek
zone opens. Result: **every Find References blanked the editor red**, and it shipped in 0.8.0.
Every gate was green the whole time: the Node suite cannot reach the webview; the browser harness
drives the same peek in headless Chromium, where the loop happened not to fire (timing), and its
`pageerror` listener would not have seen it anyway (the notice is an error *event*, not an uncaught
exception); the dev-host harness asserted the peek opened, not that the page stayed usable. It was
found on 2026-08-26 by reading a screenshot taken for a community post.

**How to apply:**
- A global error handler is a *filter*, not a funnel: skip `/ResizeObserver loop/` (and any other
  documented-benign notice you meet) explicitly, and keep a test that a genuine error still surfaces.
- Do not trust a green browser harness for anything timing-dependent — dispatch the exact event by
  hand as the deterministic half of the assertion (`test/browser/run.js` 3b does this).
- When a harness can capture the real window, assert on what the USER sees (overlay hidden, no
  `error` posted), not only on the mechanism under test. And after a webview change, open the real
  thing once and look — `scratch/showcase/` (or its successor under `scripts/`) makes that cheap.

Related: [[stop-at-implausible-results]], [[verify-before-declaring-impossible]],
[[reproduce-on-real-artifacts]].
