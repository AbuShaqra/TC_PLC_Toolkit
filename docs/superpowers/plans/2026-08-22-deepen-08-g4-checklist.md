# Phase 8 — G4 dev-host checklist (deferred to the user's machine)

The Phase 8 webview refactor (PR pending merge; commits 86a9583/34f4415/4ea1ff0) was verified by
G1 (72/72 FULL), G2 (typecheck), and G3 (both real-Chromium browser harnesses, PASS set identical
to the pre-change baseline). What follows is the residual surface only a real Extension
Development Host can exercise, written by the final whole-branch review. F5 → open a TwinCAT
project folder → open a `.TcPOU`, then walk the seven items.


1. **Script loading under the real webview origin.** The three new `<script>` tags resolve through
   real `asWebviewUri` (`vscode-webview://` resource scheme + real CSP), which the browser harness
   only fakes over http. Failure mode is immediate and loud: the error overlay showing
   "pendingEditsCore is not defined" (editor.js:35 runs at load) the moment any component opens.
   Open a POU, confirm no overlay and no errors in Webview DevTools console.
2. **acquireVsCodeApi timing / retained-webview re-init.** Tab away from an open TcPOU to another
   editor and back (retention), and Ctrl+R the dev-host window with the TcPOU open: the webview
   rebuilds, host resends 'init', `editsStore` is recreated from `message.cachedEdits` and
   `applyCachedEdits` restores pane text. Do this WITH unsaved Manual-Sync edits pending — this is
   the full cross-process round-trip of the record shape ('updatePendingEdits' →
   `pendingEditsMap` → 'init' cachedEdits) that no harness crosses a process boundary to test.
   Include an edit to a property **Get** accessor while a same-named **Set** exists (the
   xmlContext-triple match on real components).
3. **Manual Sync end-to-end through real VS Code documents.** Toggle Auto → Manual; edit decl and
   impl of one component (status must read "Unsaved Changes (2)", re-edit same pane stays 2);
   press Sync: 'sync-pending' → `foldEdits` → WorkspaceEdit; document dirties; save; then
   `git diff` the file — everything outside the two edited CDATA blocks must be byte-identical
   (LineIds, CRLF, attributes untouched).
4. **The flush-vs-save asymmetry.** With ZERO pending edits in Manual mode, trigger the manual
   save: it must still post 'save' and run the native save (empty fold is a no-op, document saves
   clean). `takeAll` is symmetric; only the call sites preserve this — no automated gate covers it.
5. **Cross-file navigation, both encodings.** (a) Go to Definition onto a symbol defined in
   another file: goto URI (`encodeGotoParts` sl/sc/el/ec + pane/ll) → editor opener →
   'openFile' → the OTHER document opens with the exact word selected (not a first-match comment
   hit). (b) Find All References, click a peek entry from another file: `peekOpenMessage`'s
   'openFile' body drives the host, and the peek widget in the origin webview must dismiss
   (deferred `closeReferencePeek`) — the harness stubs the host, so the real handler + dismissal
   is dev-host-only. Also confirm same-file goto (decl↔impl pane jump) still highlights.
6. **Real diagnostics markers.** Introduce a type error in a component; squiggles must appear in
   the correct pane with real `monaco.MarkerSeverity` values (harness used sentinels), and a
   diagnostic in a component whose decl pane is collapsed/hidden must not throw (the
   `display !== 'none'` guards stayed in editor.js).
7. **Auto Sync unaffected.** Ordinary typing in Auto mode still round-trips per-keystroke 'edit'
   messages (path untouched by the branch — one quick sanity edit + save + diff).

