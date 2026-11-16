---
name: treeview-reveal-shows-hidden-views
description: TreeView.reveal shows a hidden view; guard it with view.visible once a view lives in its own container, and re-reveal on onDidChangeVisibility.
metadata:
  type: feedback
---

`TreeView.reveal()` makes a hidden view visible, whatever `focus` says. A view that follows the active
editor must therefore reveal only while `view.visible`, remember the last target, and reveal it from
`onDidChangeVisibility` when the view is shown.

**Why:** 2026-11-10. R2 moved the Objects view from the Explorer into its own Activity Bar container.
The unconditional reveal on every file activation, harmless while the view sat in the Explorer, would
have switched the sidebar to the TwinCAT container each time a TwinCAT file was opened. It surfaced only
on the user's Windows dev-host run (a first reveal had to open the container and raced a fixed sleep);
no suite in `npm test` can see it, because none has a real TreeView.

**How to apply:** when moving a view between containers, re-read every `reveal`/`focus` call on it as if
the view were hidden. In dev-host tests, show the view first and wait for the recorded reveal instead of
sleeping.

Related: [[one-checkout-one-writer]].
