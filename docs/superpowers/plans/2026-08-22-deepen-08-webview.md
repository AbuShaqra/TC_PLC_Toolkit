# Phase 8: Webview Pure Pieces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The webview's three pure decision surfaces — the pending-edit state machine (the code
that decides whether a user's edits reach disk, today verified only by hand), the synthetic
peek/goto URI vocabulary, and the diagnostics pane-split — move into dual-mode modules
(`<script>` tag + `require()`, exactly like `media/stFolding.js`) with plain-Node harnesses.
`media/editor.js` shrinks by the moved lines; the cross-process pending-edit contract is stated
on BOTH sides via one shared module (`src/customEditorProvider.js` folds edits through it).

**Rulings (recorded):**
- **`peekPath` STAYS in `src/livePath.js`.** The roadmap floated sharing it, but it depends on
  `componentId.memberName` and `fileUriBasename` (src-side vocabulary), and the webview never
  mints a peek path — it embeds the host-minted `pane.path` verbatim (`encodePeekUri`'s
  `pane.path || '/reference'`). Dragging src modules into `media/` to share a function only one
  side computes fails the deletion test. Instead each side gains a one-line cross-reference
  comment naming the other as the producer/consumer of `path`.
- **Dual-mode globals:** `diagnosticMarkers`, `peekUri`, `pendingEditsCore`. The third is named
  to avoid colliding with `editor.js`'s local `pendingEdits` map — which this phase REPLACES
  with a store instance named `editsStore`, so the old name disappears from `editor.js`.

**Tech Stack:** Plain CommonJS; dual-mode UMD-ish shim copied from `media/stFolding.js:8-14`
(including the type-check cast comment); `test/run.js`; `tsc --noEmit`; Playwright browser
harnesses for G3.

**Spec:** `docs/superpowers/plans/2026-08-22-deepening-roadmap.md` Phase 8.

## Global Constraints

- No build step; no new dependencies; webview stays fully offline (new `<script>` tags reference
  vendored local files only, via `webview.asWebviewUri`).
- **Behaviour-neutral throughout**: every postMessage body, status string, className, marker
  shape, and URI query is byte-identical to today. Load-bearing comments MOVE, not vanish.
- All gates run BARE with exit codes checked — never piped through `tail`/`head`/`grep` in a
  `&&` chain (see `.claude/memory/gates-must-propagate-exit-codes.md`).
- Gates: **G1** `REQUIRE_FULL_SUITE=1 npm test` (69 → 71 after T1, 72 after T2); **G2**
  `npm run typecheck`; **G3** (Task 3 only — the only task that touches `media/editor.js` or the
  shipped HTML) both browser runners, protocol below. **G4** (dev-host) deferred to the user's
  machine, recorded in HANDOFF.
- **G3 protocol** (this container materializes sample/ as LF; the harness needs CRLF):

  ```bash
  # 1. convert the sample working tree to CRLF
  find sample -type f \( -name '*.TcPOU' -o -name '*.TcGVL' -o -name '*.TcDUT' \
    -o -name '*.TcIO' -o -name '*.plcproj' -o -name '*.sln' -o -name '*.tsproj' \
    -o -name '*.xti' \) -exec perl -pi -e 's/\r?\n/\r\n/g' {} +
  # 2. run both runners BARE, check both exit codes
  HARNESS_CHROMIUM=/opt/pw-browsers/chromium node test/browser/run.js
  HARNESS_CHROMIUM=/opt/pw-browsers/chromium node test/browser/run_pragmas.js
  # 3. restore BEFORE any commit
  git checkout -- sample/
  ```

  Playwright is already installed (`npm i --no-save playwright` was run; do not re-run unless
  `require('playwright')` fails). **Baseline (commit 137790e, clean tree): run.js 22 PASS,
  run_pragmas.js 38 PASS, both exit 0.** After Task 3 the same counts and exit codes are
  required — any delta in the PASS set is a failure, whatever the totals say. Never commit
  while sample/ is CRLF-converted; `git status` must show no `sample/` changes at commit time.

---

### Task 1: `media/diagnosticMarkers.js` + `media/peekUri.js` + harnesses

**Files:**
- Create: `media/diagnosticMarkers.js`, `media/peekUri.js`, `test/test_diagnostic_markers.js`,
  `test/test_peek_uri.js`
- No consumers change in this task (editor.js untouched → no G3).

**Interfaces produced (Task 3 consumes these exact names):**

```js
// media/diagnosticMarkers.js — global `diagnosticMarkers`
splitDiagnostics(diags, activeComponentId, severities)
// severities: { error, warning, info } — OPAQUE values injected by the caller (the webview
//   passes monaco.MarkerSeverity.Error/Warning/Info; the harness passes sentinels), so the
//   module never touches monaco. Mapping: d.severity 1 → error, 2 → warning, else info —
//   moved verbatim from editor.js:78-79.
// Skips d.componentId !== activeComponentId; d.pane === 'decl' → decl bucket, ELSE impl
//   (yes, anything non-'decl' lands in impl — today's behaviour, preserve it).
// Marker: { severity, message, startLineNumber, startColumn, endLineNumber, endColumn }
//   copied from d.message / d.range (editor.js:77-85 moved verbatim).
// Returns { decl: markers[], impl: markers[] }; null/undefined diags → both empty.

// media/peekUri.js — global `peekUri`
PEEK_SCHEME   // 'twincat-peek'  (doc comment editor.js:891-896 moves here)
GOTO_SCHEME   // 'twincat'       (block comment editor.js:873-888 moves here)
parseQuery(queryString)
// The one query parser both directions share — editor.js has it twice, byte-identical
//   (openPeekTarget :963-968 and decodeGotoUri :1031-1038): split '&', skip empty pairs,
//   eq<0 → key with '' value, else decodeURIComponent the value. Null/undefined → {}.
encodePeekParts(pane)
// { scheme: PEEK_SCHEME, path: pane.path || '/reference', query } with query from
//   editor.js:944-948 verbatim (file/component/pane, encodeURIComponent, 'root'/'impl'
//   defaults). Caller does monaco.Uri.from(parts) — the module never touches monaco.
encodeGotoParts(def, targetWord, activeFileUri)
// { scheme: GOTO_SCHEME, path: '/goto', query } — editor.js:1001-1021 moved verbatim,
//   including the sl/sc/el/ec range block and the pane/ll block with their comments.
//   activeFileUri is a PARAMETER (the current code closes over the module-level variable).
decodeGotoTarget(queryString)
// editor.js:1030-1054 moved verbatim, parsing via parseQuery. Returns { fileUri,
//   componentId, targetWord, pane, localLine, range } with the same defaults
//   ('', 'root', '', null, null, null) and Number() conversions.
peekOpenMessage(queryString, rangeOrNull, targetWord, activeFileUri)
// The pure body of openPeekTarget (editor.js:962-987): parseQuery, line0/startCol0 from the
//   range (1 → 0-indexed), the zero-length-range fallback endCol0 = startCol0 +
//   targetWord.length WITH its comment, and returns the full 'openFile' message body
//   INCLUDING type: 'openFile' — the message IS the cross-process contract. toRange stays in
//   editor.js; its result (or null) is passed in. q.file || activeFileUri and
//   q.component || 'root' defaults preserved.
```

- [ ] **Step 1: Write both harnesses first** (check existing harness style, e.g.
  `test/test_request_pipeline.js`):
  - diagnosticMarkers: severity 1/2/other → the injected error/warning/info sentinels;
    other-component diags dropped; pane 'decl' vs 'impl' vs missing-pane (→ impl) routing;
    marker field shape asserted key-for-key; empty/null diags.
  - peekUri: `parseQuery` round-trips an encoded query, handles empty string, valueless keys,
    and %-encoded values; `encodePeekParts` defaults (path '/reference', component 'root',
    pane 'impl'); `encodeGotoParts` with and without range, with and without pane/localLine,
    and the def.uri-absent → activeFileUri fallback; `decodeGotoTarget` inverts
    `encodeGotoParts` on a full fixture (assert the exact target object) and yields nulls
    when range/pane absent; `peekOpenMessage` with a real range, with null range (word-length
    fallback), and with a zero-length range (same fallback) — assert the exact message body
    including type. Run → red (modules absent).
- [ ] **Step 2: Implement both modules.** Dual-mode shim copied from `media/stFolding.js`
  (same cast comment for the type-check gate). Moved code stays verbatim; moved comments too.
- [ ] **Step 3: Gates** — both harnesses green; `REQUIRE_FULL_SUITE=1 npm test` 71/71 FULL;
  `npm run typecheck` clean. All bare, exit codes checked.
- [ ] **Step 4: Commit** — `feat(webview): diagnosticMarkers + peekUri as dual-mode pure modules`

---

### Task 2: `media/pendingEdits.js` + harness

**Files:**
- Create: `media/pendingEdits.js`, `test/test_pending_edits.js`
- No consumers change in this task.

**Interfaces produced (Task 3 consumes these exact names):**

```js
// media/pendingEdits.js — global `pendingEditsCore`
createStore(initial)
// initial: the cachedEdits object from the host's 'init' message, or undefined → {}.
// The store OWNS the keyed map (today's `pendingEdits` variable, editor.js:35).
//   .stash(componentId, blockType, context, content)
//       // key `${componentId}_${blockType}` (editor.js:220), record
//       // { context, blockType, content } (editor.js:221-225) — THE cross-process edit
//       // record shape; foldEdits below is its consumer.
//   .takeAll()   // → Object.values(map) then clear — the flush/save payload (editor.js:153,167)
//   .count()     // → number of keys
//   .snapshot()  // → the raw keyed object, for the 'updatePendingEdits' message
//                // (editor.js:227-230 sends the map itself)
statusFor(count)
// → { text, className }: count > 0 → { `Unsaved Changes (${count})`,
//   'status-indicator modified' }, else { 'Synced', 'status-indicator' }
//   (updateStatusText, editor.js:141-150, minus the DOM writes). The transient 'Saving...'
//   states are call-site DOM writes and STAY in editor.js.
applyCachedEdits(components, cachedEdits)
// The init-restore matcher, editor.js:1482-1498 moved verbatim: for each cached edit, find
//   the component whose xmlContext matches on subType AND subName AND accessorType, then
//   overwrite comp.declaration (blockType 'Declaration') or comp.implementation (else).
//   Mutates components in place, returns nothing — exactly today. Null/absent cachedEdits →
//   no-op.
foldEdits(text, edits, replace)
// Host-side consumer of the record shape: edits.reduce((t, e) => replace(t, e.context,
//   e.blockType, e.content), text). This is customEditorProvider.js's 'sync-pending' loop
//   (:264-272) and 'save' loop (:288-296) — one statement, stated once, used by both.
```

- [ ] **Step 1: Write the harness first** (`test/test_pending_edits.js`):
  - store: stash two blockTypes of one component → 2 records, distinct keys; re-stash same
    key → overwritten, count stays; takeAll returns records and empties the store (count 0,
    snapshot {}); snapshot returns the keyed object with today's key format (assert the exact
    key string `MyComp_Declaration`); createStore(seed) starts with the seed's keys.
  - statusFor: 0 → Synced/status-indicator; 3 → `Unsaved Changes (3)`/status-indicator
    modified (assert exact strings).
  - applyCachedEdits: a Declaration edit lands in comp.declaration, an ST edit in
    comp.implementation; matching is by the xmlContext TRIPLE (a component differing only in
    accessorType must NOT match — this is the get/set accessor disambiguation); an edit with
    no matching component is silently dropped; null cachedEdits is a no-op.
  - foldEdits: with a recorder replace, edits apply in array order, each receiving the
    previous return value; empty edits → text unchanged; the record fields are passed
    positionally (context, blockType, content).
  Run → red.
- [ ] **Step 2: Implement.** Same dual-mode shim. Moved comments move.
- [ ] **Step 3: Gates** — harness green; full suite 72/72 FULL; typecheck clean. Bare.
- [ ] **Step 4: Commit** — `feat(webview): pendingEditsCore — the edit-sync state machine as a testable module`

---

### Task 3: Consume the three modules; state the contract on both sides

**Files:**
- Modify: `media/editor.js`, `src/customEditorProvider.js`, `src/livePath.js` (one comment)

**Steps:**

- [ ] **Step 1: G3 pre-check.** Run the G3 protocol on the UNTOUCHED tree first and confirm the
  baseline (22 / 38, exit 0). If it does not match, STOP and report — do not start editing on a
  red baseline.
- [ ] **Step 2: `src/customEditorProvider.js`.**
  - `getHtmlForWebview` (:475-480, :579-580): add `asWebviewUri` consts and `<script>` tags for
    `diagnosticMarkers.js`, `peekUri.js`, `pendingEdits.js` — after the `stFolding.js` tag,
    before the `editor.js` tag, with a one-line comment like stFolding's (:477) saying they are
    dual-mode modules editor.js consumes. (test/browser/build.js calls the REAL
    getHtmlForWebview, so the harness page picks these up with no build.js change; verify the
    stub-injection guard `__harnessInit` still passes when G3 runs.)
  - `require` `./../media/pendingEdits.js` (top of file, with the existing requires) and
    replace the 'sync-pending' fold loop (:264-272) and the 'save' fold loop (:288-296) with
    `pendingText = pendingEditsCore.foldEdits(document.getText(), message.edits, replaceComponentCdata)`
    (respectively `saveText = ...`). Everything around the loops — the `!==` guards,
    isEditingFromWebview, save/delete ordering — is UNTOUCHED.
- [ ] **Step 3: `media/editor.js`.**
  - Delete the moved code; consume the globals. `let pendingEdits = {}` → `let editsStore =
    pendingEditsCore.createStore()`. `updateStatusText` keeps its name and DOM writes but reads
    `pendingEditsCore.statusFor(editsStore.count())`. `flushPendingEdits` /
    `triggerManualSave` use `editsStore.takeAll()` — PRESERVE the difference: flush only posts
    when edits.length > 0; manual save ALWAYS posts (even with zero edits, that triggers the
    native save). onEditorChange's manual branch: `editsStore.stash(activeComponentId,
    blockType, activeComp.xmlContext, val)` then posts `editsStore.snapshot()` as
    `pendingEdits` in the 'updatePendingEdits' message (field name in the message is
    UNCHANGED). 'init' handler: `editsStore = pendingEditsCore.createStore(message.cachedEdits)`
    + `pendingEditsCore.applyCachedEdits(components, message.cachedEdits)`.
  - updateDiagnostics: build `{ error: monaco.MarkerSeverity.Error, warning: ..., info: ... }`
    and use `diagnosticMarkers.splitDiagnostics(diags, activeComponentId, severities)`; keep
    the debounce, visibility checks, stale-response guard, and setModelMarkers calls in place.
  - Peek/goto: local PEEK_SCHEME/GOTO_SCHEME consts and encodePeekUri/encodeGotoUri/
    decodeGotoUri/the inline parser in openPeekTarget are deleted; call sites become
    `monaco.Uri.from(peekUri.encodePeekParts(pane))`, `monaco.Uri.from(
    peekUri.encodeGotoParts(def, targetWord, activeFileUri))`,
    `peekUri.decodeGotoTarget(resource.query)`, and openPeekTarget shrinks to
    `vscode.postMessage(peekUri.peekOpenMessage(resource.query, toRange(selectionOrPosition),
    targetWord, activeFileUri))` + the deferred closeReferencePeek with its comment. The
    scheme consts referenced elsewhere (editorForModelUri, provider registrations,
    closeReferencePeek's trigger source string 'twincat') read from `peekUri.*` — grep for
    both scheme literals and convert every reader, EXCEPT string literals that are not the
    scheme (the `ed.trigger('twincat', ...)` source tag at :908 is a trigger source name, not
    the scheme — leave it and say so in a comment if ambiguity was created).
- [ ] **Step 4: `src/livePath.js`** — one comment on `peekPath` naming
  `media/peekUri.js` as the consumer of the minted path (and the ruling that the function
  stays here); `media/peekUri.js`'s `encodePeekParts` doc names `livePath.peekPath` as the
  producer. No code change.
- [ ] **Step 5: Gates.** G1 72/72 FULL; G2 clean; **G3 both runners = baseline (22 / 38, exit
  0)**; `git status` shows no sample/ changes; verify by grep that editor.js no longer
  contains `encodeURIComponent` outside require-free glue (the encoders moved), has no
  `'twincat-peek'` literal, and no `pendingEdits[` map indexing.
- [ ] **Step 6: Commit** — `refactor(webview): editor.js rides the three pure modules; edit-fold contract stated on both sides`

---

## Self-review record

- The `pendingEdits` global-name collision is resolved by RENAMING the webview local to
  `editsStore` (T3 Step 3) and naming the module global `pendingEditsCore`.
- flush-vs-save asymmetry (flush posts only when non-empty; save always posts) is pinned in
  T3 Step 3 and testable only in G3/G4 — the store's takeAll is symmetric, the call sites
  differ, exactly as today.
- `encodeGotoParts`/`peekOpenMessage` take `activeFileUri` as a parameter (module-level
  variable today) — T1's harness pins the fallback branches so the threading cannot drift.
- The `ed.trigger('twincat', ...)` source-tag-vs-scheme trap is called out in T3 Step 3.
- `applyCachedEdits` matching by the xmlContext triple is the accessor-disambiguation
  behaviour; T2's harness pins the accessorType-mismatch case.
- Suite count: 69 → 71 (T1) → 72 (T2); T3's gate says 72/72.
- G3 numbers are recorded with their commit (137790e) so a drifted baseline is detectable.
