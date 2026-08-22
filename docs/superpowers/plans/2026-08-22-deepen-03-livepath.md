# Phase 3: livePath Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live language-feature path (assemble → map → query → map back) becomes one
vscode-free module, `src/livePath.js`; the five webview handlers in `customEditorProvider.js`
become thin adapters; `test/test_live_path.js` finally drives production code instead of a copy;
the peek budget logic gets its first tests ever.

**Architecture:** `livePath.js` absorbs `editorMapping.js` (its four pure helpers), the host's
`assembleSt` (already string-in — the vscode.TextDocument only contributed `getText()`), a
`createStResolver` with the file read injected, the `PEEK_MAX_*` budgets, and three new collector
functions that are today inline handler loops: `mapDefinition`, `collectPeekReferences`,
`listExternalReferences`. The handlers keep ONLY: read the document, call the LSP bridge command,
delegate, post the response. `editorMapping.js` is deleted (3 consumers, all converted).
Diagnostics mapping (`mapDiagnosticsToMonaco`) is deliberately NOT touched — unifying the two
coordinate dialects is Phase 4's whole job.

**Tech Stack:** Plain CommonJS, `test/run.js` harnesses, `tsc --noEmit`.

**Spec:** `docs/superpowers/plans/2026-08-22-deepening-roadmap.md` Phase 3.

## Global Constraints

- No build step; plain CommonJS; JSDoc like the neighbours; no new dependencies; no `vscode`
  require anywhere in `livePath.js`.
- **Behaviour-neutral end to end.** Every moved function is a verbatim transcription; the five
  handlers' observable messages (`custom/*Response` payload shapes, `showReferences` items) are
  byte-identical. `test_live_path.js` (10 tests over the real sample) and `test_editor_mapping.js`
  are the net, plus the full suite.
- The disk-read consequence stays and stays documented: a resolver target inside a file with
  unsaved edits in another tab is located against the SAVED text.
- The peek budget semantics are FROZEN: caps bound FILE READS and PANES, not mapped references —
  refs past the pane cap still map when their file was already read; a pane whose text exceeds the
  remaining byte budget is skipped but its refs still map. (These exact behaviours become tests.)
- Gates per task: `REQUIRE_FULL_SUITE=1 npm test` → 65/65+ FULL; `npm run typecheck` clean.
- G4 (dev-host) cannot run in this container — record as deferred in HANDOFF at close-out, as in
  Phases 1–2.

---

### Task 1: `src/livePath.js` — assembly, mapping, resolver, budgets; `editorMapping.js` retired

**Files:**
- Create: `src/livePath.js`
- Delete: `src/editorMapping.js`
- Modify: `src/customEditorProvider.js` (:11-13 imports; :35-51 `assembleSt` deleted — call sites
  switch to `livePathAssemble(document.getText(), message)`; :68-89 `createStResolver` deleted —
  call sites switch to the injected-read version; :97-98 constants deleted)
- Modify: `test/test_editor_mapping.js:9` (import path), `test/test_live_path.js:33` (import
  path) and `:60-80` (DELETE the replicated `assembleSt`; the production one has the identical
  `(xml, overlay)` signature, so the ~12 call sites need no change)

**Interfaces (produced — Task 2 and the host rely on these exact names):**

```js
// src/livePath.js — all vscode-free
assembleSt(xmlText, overlay) → { stText, lineMap } | null
localToAbsolute(lineMap, componentId, pane, lineNumber, column) → {line, character} | null
absoluteToLocal(lineMap, absLine0) → {componentId, pane, localLine0} | null
paneTextFromUnit(stLines, lineMap, componentId, pane) → string | null
peekPath(fileUri, componentId, pane) → string
createStResolver({ activeUri, activeUnit, readFile }) → async (uri) => {st, lines} | null
PEEK_MAX_PANES /* 50 */, PEEK_MAX_TEXT_BYTES /* 2 MiB */
```

`readFile` is `async (uriString) => string` — the host passes a wrapper over
`vscode.workspace.fs.readFile`; tests pass an in-memory map lookup.

- [ ] **Step 1: Create `src/livePath.js`**

Header + content, all transcribed verbatim from the current sources (cite in comments where each
piece came from is NOT needed — the git move is the record):

```js
/**
 * @file livePath.js
 * @description The live language-feature path, as one vscode-free module: assemble a TwinCAT XML
 * object into a single Structured Text compilation unit (webview overlay applied), map pane-local
 * coordinates to unit coordinates and back, slice pane texts, build peek-model paths, and resolve
 * other files' units through an injected reader. The custom editor host and the harnesses drive
 * the SAME functions — this file exists so the live-path regression gate tests shipped code.
 */

const { parseTwinCatXml } = require('./xmlParser');
const { convertXmlToSt } = require('./stConverter');
const { normalizeFileUri, fileUriBasename } = require('./fileUri');
const { memberName } = require('./componentId');
```

Then move, byte-for-byte (bodies unchanged):
1. `assembleSt` from `customEditorProvider.js:35-51`, with the first line becoming
   `const parsed = parseTwinCatXml(xmlText);` (parameter `xmlText` instead of
   `document.getText()`) and its JSDoc updated to say the caller passes the XML text.
2. `localToAbsolute`, `absoluteToLocal`, `paneTextFromUnit`, `peekPath` from `editorMapping.js`
   (including `peekPath`'s `memberName` delegation and try/catch basename fallback).
3. `createStResolver` from `customEditorProvider.js:68-89`, reshaped to the injected form:

```js
function createStResolver({ activeUri, activeUnit, readFile }) {
    const cache = new Map();
    return async function getSt(uri) {
        const key = normalizeFileUri(uri);
        if (cache.has(key)) return cache.get(key);
        let result = null;
        if (key === normalizeFileUri(activeUri)) {
            result = { st: activeUnit, lines: activeUnit.stText.split('\n') };
        } else {
            try {
                const text = await readFile(uri);
                const parsed = parseTwinCatXml(text);
                if (parsed) {
                    const converted = convertXmlToSt(parsed, { raw: true });
                    result = { st: converted, lines: converted.stText.split('\n') };
                }
            } catch (e) { /* unreadable: the caller degrades, it never guesses */ }
        }
        cache.set(key, result);
        return result;
    };
}
```

(keep the original's full JSDoc including the saved-text consequence), and
4. the two `PEEK_MAX_*` constants with their comment block from `customEditorProvider.js:91-98`.

Export everything listed under Interfaces.

- [ ] **Step 2: Convert the three consumers**

`customEditorProvider.js`:
- `:13` becomes `const { assembleSt, localToAbsolute, absoluteToLocal, paneTextFromUnit, peekPath, createStResolver, PEEK_MAX_PANES, PEEK_MAX_TEXT_BYTES } = require('./livePath');`
  (drop the now-unused `editorMapping` require and the local `assembleSt`/`createStResolver`/constants).
- Every `assembleSt(document, message)` call becomes `assembleSt(document.getText(), message)`
  (sites at :393, :416, :461, :552, :574).
- Every `createStResolver(message.fileUri, ctx)` becomes:

```js
createStResolver({
    activeUri: message.fileUri,
    activeUnit: ctx,
    readFile: async (uri) => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri))).toString('utf8')
})
```

  (sites at :437, :487, :590 — define one local `const readFile = …` helper next to `normUri` and
  pass it three times rather than inlining thrice).

`test/test_editor_mapping.js:9` → `require('../src/livePath')` (same names).
`test/test_live_path.js`: `:33` → `require('../src/livePath')` adding `assembleSt` to the
destructure; delete the "Replicated extension helpers" block (`:60-80`). No call-site changes.

- [ ] **Step 3: Gates** — `node test/test_live_path.js` (all 10 tests, FULL), `node
test/test_editor_mapping.js`, then `REQUIRE_FULL_SUITE=1 npm test` (65/65 FULL) and
`npm run typecheck`. Also verify: `grep -rn "editorMapping" src/ test/` → no hits.

- [ ] **Step 4: Commit** — `refactor: livePath.js owns ST assembly, coordinate mapping and the unit resolver`
(use `git add -A` so the `editorMapping.js` deletion is staged).

---

### Task 2: The collectors — definition/references/external-list as pure functions, budgets tested

**Files:**
- Modify: `src/livePath.js` (add `mapDefinition`, `collectPeekReferences`, `listExternalReferences`)
- Modify: `src/customEditorProvider.js` (`custom/definition` :427-448, `custom/references`
  :461-538, `showExternalReferences` :584-623 — each becomes assemble → query → delegate → post)
- Create: `test/test_live_path_unit.js`

**Interfaces (produced):**

```js
async mapDefinition(definition, resolveSt) → definition | augmented definition
async collectPeekReferences(refs, { activeUri, resolveSt, maxPanes = PEEK_MAX_PANES, maxTextBytes = PEEK_MAX_TEXT_BYTES }) → { references, panes }
async listExternalReferences(refs, resolveSt) → { items, searchedWord }
```

`resolveSt` is the function returned by `createStResolver`. `refs`/`definition` are exactly what
the `twincat.lsp.query*` commands return — the collectors never call the LSP themselves, so they
stay pure over their inputs.

- [ ] **Step 1: Write the failing unit tests first** — `test/test_live_path_unit.js`, standalone
Node, no sample requirement (synthetic XML via `parseTwinCatXml`-compatible strings; reuse the
fixture pattern from `test_component_id.js`). Build two small in-memory "files" (an active FB with
a method, and a second FB), a `readFile` that serves them from a Map (and counts reads), and a
resolver over them. Then pin, with real assertions:

```js
// 1. mapDefinition augments with (componentId, pane, localLine) agreeing with absoluteToLocal.
// 2. collectPeekReferences: a ref in the active file uses the ACTIVE unit (readFile count for
//    the active uri stays 0) and reports sameFile: true.
// 3. Pane dedupe: two refs into the same (file, component, pane) produce ONE pane entry, two
//    mapped references sharing its paneKey.
// 4. maxPanes budget bounds FILE READS: with maxPanes: 1 and refs in two other files, the second
//    file is never read (readFile count 1) and its refs are absent from `references`; refs into
//    the ALREADY-READ file past the pane cap still map (cap bounds reads and panes, not refs).
// 5. maxTextBytes budget: with maxTextBytes smaller than the pane text, the pane is skipped but
//    the ref still maps (no pane entry, reference present with its paneKey).
// 6. listExternalReferences: items carry (uri, componentId, targetWord, lineText, absolute line,
//    pane, localLine, start/end characters); searchedWord is the FIRST ref's word; an unreadable
//    uri contributes nothing and does not throw.
```

Write each as a concrete assertion against the synthetic fixtures (exact expected values, not
shapes). Run: fails — the three functions do not exist.

- [ ] **Step 2: Implement the three collectors in `livePath.js`** — verbatim transcriptions of the
current handler bodies with the vscode names parameterized:

`mapDefinition` = `customEditorProvider.js:427-448`'s mapping block:

```js
async function mapDefinition(definition, resolveSt) {
    if (!(definition && definition.uri && definition.range)) return definition;
    const entry = await resolveSt(definition.uri);
    const loc = entry ? absoluteToLocal(entry.st.lineMap, definition.range.start.line) : null;
    if (!loc) return definition;
    return Object.assign({}, definition, {
        componentId: loc.componentId,
        pane: loc.pane,
        localLine: loc.localLine0
    });
}
```

`collectPeekReferences` = the loop at `:486-537` verbatim (stCache, paneByKey, textBudget,
`sameFile` computed against `normalizeFileUri(activeUri)`), returning `{ references: mapped,
panes: [...paneByKey.values()] }`. Keep the original comment block about the two-pass design.

`listExternalReferences` = the loop at `:592-619` verbatim, returning `{ items, searchedWord }`.
Preserve JSDoc from the originals, including the per-reference line-split caching rationale.

- [ ] **Step 3: Unit tests green** — `node test/test_live_path_unit.js` all pass.

- [ ] **Step 4: Convert the three handlers** to delegates; e.g. `custom/definition`'s mapping
block becomes:

```js
definition = await mapDefinition(definition, createStResolver({ activeUri: message.fileUri, activeUnit: ctx, readFile }));
```

`custom/references` becomes the assemble/abs/query preamble plus:

```js
const { references: mapped2, panes: panes2 } = await collectPeekReferences(refs, {
    activeUri: message.fileUri,
    resolveSt: createStResolver({ activeUri: message.fileUri, activeUnit: ctx, readFile })
});
```

(keep the response postMessage payload field names EXACTLY: `references`, `panes`), and
`showExternalReferences` posts through `this.options.showReferences(searchedWord, items)` from
`listExternalReferences`'s result. Delete the now-inlined loops.

- [ ] **Step 5: Gates** — `node test/test_live_path.js` (10/10, FULL), `node
test/test_live_path_unit.js`, full suite (66/66 FULL — one new harness), typecheck. Verify with
`git diff` that the handler bodies contain no residual mapping loops.

- [ ] **Step 6: Commit** — `refactor: peek/reference/definition collection moves into livePath, budgets get tests`

---

## Self-review record

- The moved `assembleSt` signature `(xmlText, overlay)` matches `test_live_path.js`'s replicated
  copy exactly, so Task 1's deletion needs zero call-site edits — checked against the harness's 12
  call sites.
- `createStResolver`'s injected shape is used identically in T1 (host) and T2 (tests); the
  `readFile` contract (async, returns string, throws on unreadable) matches both the vscode
  wrapper and a Map-backed test double.
- The budget-semantics constraints ("caps bound reads/panes, not refs") are stated in Global
  Constraints AND as unit tests 4-5 — the tests are the frozen spec.
- Phase 4 dependency honoured: `mapDiagnosticsToMonaco` stays in `stConverter.js`, untouched.
