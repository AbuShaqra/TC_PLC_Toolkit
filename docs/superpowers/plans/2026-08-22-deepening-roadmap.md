# Deepening Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Steps use
> checkbox (`- [ ]`) syntax for tracking. **Each phase additionally requires its own detailed task
> plan (superpowers:writing-plans, saved beside this file as
> `YYYY-MM-DD-deepen-NN-<slug>.md`) written immediately before that phase executes** — this
> roadmap locks the order, scope, interfaces and gates; the per-phase plan carries the actual
> failing tests and code. Writing all nine in full now would produce plans that are stale by
> phase 3, because each phase changes the files the next one touches.

**Goal:** Work through the nine deepening candidates from the 2026-08-22 architecture review in
impact order, each phase leaving the suite FULL-green and the module deeper (more behaviour
behind a smaller interface) than before.

**Architecture:** Every phase is the same move, proven five times in this repo already
(`debounce`, `insertTemplates`, `dndRules`, `referencesTree`, `scanController`): extract the
vscode-free core, give it one owner module with a small interface, make the harness import the
production code, delete the copy/stub/widened export it replaces. No phase changes user-visible
behaviour except where a candidate names a confirmed bug.

**Tech Stack:** Plain CommonJS JS (no build step), `test/run.js` harness suite, tsc `--noEmit`
type gate, Playwright browser harnesses for `media/`, `test/devhost/run.js` for navigation
identity.

**Spec:** The architecture review report —
<https://claude.ai/code/artifact/a2912dea-103a-4069-9751-b0419eb1490b> — condensed per phase
below so this document stands alone. Candidate numbers (01–09) are the report's.

## Global Constraints

Every phase's requirements implicitly include all of these (sources: CLAUDE.md, HANDOFF.md,
DEVELOPMENT.md "Indexing cost"):

- **No build/transpile step.** Everything stays require()-able plain CommonJS.
- **Diagnostics ratchet is zero and stays zero.** `sample/` is ground truth; never raise a
  baseline in `test/_baseline.js`.
- **Library symbols register on demand, per document** — never all up front (measured 1.5 s → 78 s).
- **`custom/reindex` never learns to skip; `_libraries` never enters `SKIP_DIRS`**
  (`PROJECT_SKIP_DIRS` is the excluding set).
- **Cached signature records are cloned per project** (until Phase 2 makes that structural).
- **Webview stays fully offline**; Monaco vendored; CSP unchanged.
- **File writes preserve XML byte-for-byte outside edited CDATA**; `.gitattributes` (CRLF
  pinning) is load-bearing — never delete it.
- **Internal `twincat.*` ids and the `twincat.xmlViewer` viewType are never renamed.**
- **Refactors preserve require-path compatibility or update every consumer in the same phase** —
  there is no bundler to alias old paths.

## Verification gates (referenced by every phase)

- **G1 — suite:** `REQUIRE_FULL_SUITE=1 npm test` → `64/64` (or higher as phases add harnesses),
  `Coverage: FULL`.
- **G2 — types:** `npm run typecheck` → clean.
- **G3 — browser** (required whenever `media/*` changes):
  `HARNESS_CHROMIUM=/opt/pw-browsers/chromium node test/browser/run.js` and
  `node test/browser/run_pragmas.js` → all assertions pass.
- **G4 — dev host** (required whenever navigation identity, reveal parents, or the resolve chain
  changes; needs a machine with VS Code installed): `node test/devhost/run.js` → green.
- **G5 — both library configurations** (required whenever `src/lsp/lib*`/`parseCache` change):
  re-run G1 with `sample/_Libraries/Beckhoff Automation GmbH` moved aside and back (move, never
  delete).

## Working agreement per phase

- One branch per phase: `refactor/deepen-NN-<slug>` off current `main`.
- TDD: the per-phase plan's first step is always a failing test that pins the current defect or
  the new interface; frequent commits; the phase merges only with its gates green.
- After merge: update HANDOFF.md (retire the phase's entry, record any decision made) and
  DEVELOPMENT.md (file map + test table — the module list changes in most phases). This is part
  of the phase, not follow-up.
- The phase order below may be re-cut after any phase if what it uncovers changes the ranking —
  re-cutting is a HANDOFF-recorded decision, not silent drift.

## Order and rationale

Impact = user-visible fixes first, then risk-reduction per unit of effort, then enabling effect
for later phases, discounted by execution risk. Dependencies constrain a little:

```
P1 (02 componentId) ──► P3 (01 livePath) ──► P4 (03 coordinates)
        │
        └────────────► P8 (09 webview extraction)
P2 (08 parseCache)   independent
P5 (04 discovery)    independent
P6 (06 server seam)  independent (easier after P3 trims customEditorProvider)
P7 (05 tree model)   independent
P9 (07 libsymbols)   last, gated on P2+P5 landing cleanly
```

---

### Phase 1 — Candidate 02: own the component-id grammar

**Why first:** smallest Strong candidate; fixes the review's one **confirmed user-visible bug**
(a Transition renders as raw `transition_Ready` in the References view; the peek path shows
`/transition_Ready.impl/…`); establishes the one-owner/many-consumers pattern later phases use.

**Files:**
- Create: `src/componentId.js` (vscode-free), `test/test_component_id.js`
- Modify: `src/xmlParser.js:105–178` (mint sites), `src/lsp/features/core.js:86–92`,
  `src/lsp/features/definition.js` (9 mint sites), `src/editorMapping.js:43`,
  `src/referencesTree.js:13–21`, `src/dndRules.js:47–50,75`,
  `src/commands/clipboardCommands.js:77`, `src/treeDataProvider.js:64–67,543–544`
- `media/editor.js` carries ids opaquely — confirm no parse site exists there before declaring it
  out of scope; if one is found it joins the consumer list and G3 applies.

**Interfaces produced:** `make(kind, name) → string`, `parse(id) → {kind, name, accessor}|null`,
`label(id) → string`, `isAccessor(id) → boolean`, plus the exported kind enum
(`method | prop | action | transition | get | set | root`). Exact minted string shapes are
**frozen** — ids reach saved workbench state and the LSP protocol; this phase changes who owns
the grammar, never the grammar.

**Task sketch:** (1) failing conformance test: every shape `xmlParser` mints × every consumer's
parse — fails today on the two broken sites; (2) implement `componentId.js` from the minted
truth; (3) convert consumers one file per commit, conformance test green after each; (4) delete
the four private regexes.

**Gates:** G1, G2. G4 once at the end (References-view labels and peek navigation are in its
assertions). **Exit:** a Transition shows its name in the References view and peek path; no file
outside `componentId.js` contains a component-id regex.

---

### Phase 2 — Candidate 08: make parseCache's clone rule structural

**Why second:** best effort-to-safety ratio on the list (afternoon-sized). The "clone is
mandatory" rule is documented four times and enforced zero; the second caller that forgets is a
silent cross-project contamination — the exact bug class the per-project registries exist to
prevent.

**Files:**
- Modify: `src/lsp/parseCache.js:96–145` (collapse `readSignatureRecords` +
  `cloneSignatureRecords` into one entry point), `src/lsp/libsymbols.js:1622–1627` (the one
  caller), `test/test_signature_cache.js`

**Interfaces produced:** `signatureRecordsFor(filePath) → SignatureRecords` — cached parse keyed
`(path, size, mtime)`, **always returns a private copy**; the shared template never escapes.
`readBrowserCacheDoc` keeps its current no-clone contract, now documented as the deliberate
asymmetry it is.

**Task sketch:** (1) failing test: mutate project A's returned records, re-request for B, assert
unaffected (fails against the raw read path); (2) implement the collapsed entry point; (3) update
the caller; (4) keep the identity assertion (a value check passes while sharing — the existing
test's own warning).

**Gates:** G1, G2, G5. **Exit:** `cloneSignatureRecords` no longer exported; the unsafe call no
longer exists to be made.

---

### Phase 3 — Candidate 01: give the live language path its module

**Why third:** the deepest payoff. The product's core mechanism (assemble → map → query → map
back) lives as an inline ritual in five handlers of a vscode-bound class, so its 581-line
regression gate (`test/test_live_path.js:60–80`) **re-implements `assembleSt` and tests a
copy** — and the overlay rule has already drifted between the two spellings (`!= null` vs the
copy's variant). Runs after Phase 1 so the unit speaks `componentId` from day one.

**Files:**
- Create: `src/livePath.js` (vscode-free; absorbs `src/editorMapping.js` and
  `createStResolver`), `test/test_live_path_unit.js`
- Modify: `src/customEditorProvider.js:35–89,244–644` (handlers become adapters),
  `test/test_live_path.js` (delete the replicated helpers, import production),
  `test/test_editor_mapping.js` (follows the move)

**Interfaces produced:** `assemble(xmlText, overlay) → Unit|null` where `Unit` exposes
`stText`, `lineMap`, `localToAbsolute(componentId, pane, line, col)`, `locate(absLine0) →
{componentId, pane, localLine0}`, `paneText(componentId, pane)`, and
`peekModelsFor(references, readFile, {maxPanes, maxTextBytes})`. The peek budget logic
(`PEEK_MAX_PANES`/`PEEK_MAX_TEXT_BYTES`) moves in — it is untestable today and becomes tested
here.

**Task sketch:** (1) failing test importing `src/livePath.js` (doesn't exist yet) asserting
`assemble` on a real sample object equals what the current inline path produces; (2) extract
verbatim, no behaviour change; (3) point the five handlers at it, one commit each; (4) delete
`test_live_path.js`'s replicated `assembleSt` and drive production; (5) add the peek-budget
tests.

**Gates:** G1, G2. G4 once (resolve chain touched). **Exit:** `test_live_path.js` contains no
"Replicated extension helpers" section; `customEditorProvider.js` has no coordinate arithmetic.

---

### Phase 4 — Candidate 03: one coordinate dialect, `raw` as a parameter, fossils out

**Why fourth:** stacks directly on Phase 3's unit module; small individually, but removes the
class of bug where diagnostics and references disagree about what a pane is.

**Files:**
- Modify: `src/stConverter.js:12` (`RAW_MODE` module global → threaded parameter or split
  `toStUnit`/`toPortableSt` entry points), `src/stConverter.js:293–344`
  (`mapDiagnosticsToMonaco` becomes a projection over the Phase-3 `locate` primitive, answering
  in ONE vocabulary), `src/stConverter.js:425–462` (hardcoded `ST_MES_*`/`ST_AxisErrors`/
  `fbMCPower` rewrites → explicit data-driven table), `media/editor.js` (collapse the
  `'declaration'/'implementation'` vs `'decl'/'impl'` split — G3 applies)
- Test: round-trip property in `test_live_path_unit.js` (`local→absolute→local` is identity over
  every component/pane of every sample object), plus one assertion that diagnostics and
  references report the same pane token for the same absolute line.

**Decision to make at phase time (record in HANDOFF):** the fossil rewrites change converter
output for any project actually containing those names. Options: (a) keep behaviour, table
default-on, delete nothing; (b) table default-off (behaviour change, cleaner). Do not decide
silently.

**Gates:** G1, G2, G3. **Exit:** grep finds one pane-token vocabulary; `stConverter.js` has no
module-level mutable mode flag and no hardcoded project-specific type names.

---

### Phase 5 — Candidate 04: one owner for workspace discovery

**Why fifth:** highest hot-spot weight of the remaining candidates (`projectMap` ×7,
`extension.js` ×8) and the last two bugs here (URI casing `9efb329`, on-disk spelling `51acdf2`)
were both identity rules restated per walker. Verified duplications: `decodeXmlAttribute`
byte-equivalent twice, the skip-walk five times, `SKIP_DIRS` in seven spellings, the extension
list in eight places, suffix-disambiguation twice with incompatible signatures.

**Files:**
- Create: `src/twincatWorkspace.js` (vscode-free: `walk(roots, {skip, exts})`,
  `decodeXmlAttribute`, `TWINCAT_EXTS`, `disambiguateNames(records)`, and the Windows
  casing/8.3/junction recovery now in `projectMap.js:125–164`), `test/test_twincat_workspace.js`
- Modify: `src/lsp/projectMap.js`, `src/solutionMap.js`, `src/lsp/workspaceScan.js:53–74`,
  `src/lsp/xmlIndexer.js:342–363`, `src/lsp/libsymbols.js:912–943,1399,1583`,
  `src/treeDataProvider.js:284–392`, `extension.js` (inline ext lists), `src/objectKinds.js` +
  `src/lsp/xmlIndexer.js:134–170` (one shared DUT/POU classifier — keep the LSP's extra
  `subrange` value)
- Delete (as drift alarms made obsolete, only after their invariant has a structural owner):
  the `TWINCAT_EXTS` cross-pin in `test_project_map.js`, the skip-set cross-pins in
  `test_collect_scope.js` — **but `test_collect_scope.js`'s proof that `_libraries` in the
  archive walker's skip set costs ~171 false positives stays**, re-pointed at the new owner.

**Interfaces produced:** `SKIP_DIRS` and `PROJECT_SKIP_DIRS` remain two distinct named exports of
the owner; the `_Libraries` rule is a Global Constraint and survives verbatim.

**Gates:** G1, G2, G5. G4 once (labels and grouping feed the Objects tree). **Exit:** one
definition each for the walk, the entity decode, the extension list, the skip sets, the
disambiguator; casing recovery benefits all six walkers.

---

### Phase 6 — Candidate 06: make the server's sync ritual unskippable

**Files:**
- Create: `src/lsp/requestPipeline.js` (vscode/IPC-free: `withDocument(deps, handler)` making
  `indexForUri → syncDocument → handler → catch` structural, plus an ordered
  `libraryIndexPipeline` whose stages declare prerequisites — the "signatures after .tmc,
  browsercache last" ordering moves from prose to structure), `test/test_request_pipeline.js`
- Modify: `src/lsp/server.js:98–137,139–152,263–336` (six handlers become registrations;
  `custom/referencesForSymbol`'s deliberate skip becomes an explicit `withoutDocument` variant,
  not a comment)
- Decide at phase time: fold `src/lsp/features.js` (26-line pass-through, fails the deletion
  test) into direct requires, or keep for require-path stability — either way document
  `features/core.js` as the real shared interface.

**Why here:** `server.js` has **zero tests** (IPC opens at require time); this is the same
extraction `scanController.js` already proved, and it closes the "seventh handler silently
answers against a library-blind index" hole — the one outcome this codebase refuses.

**Gates:** G1, G2, G5. **Exit:** a harness drives all six handlers through the pipeline and
asserts every one syncs; adding an unsynced handler fails a test, not a code review.

---

### Phase 7 — Candidate 05: materialize the Objects-tree model

**Files:**
- Create: `src/objectsTreeModel.js` (vscode-free node graph with parent links, children, stable
  ids; owns the "fewer than two projects → flat" rule that currently lives in
  `projectMap.js:359–364`, an LSP-ownership module deciding a presentation rule),
  `test/test_objects_tree_model.js`
- Modify: `src/treeDataProvider.js:57–70,117–179,186–273` (`getParent` → `node.parent`,
  `getChildren` → `node.children`, provider becomes the adapter), `src/solutionMap.js:224–231`,
  `test/test_tree_reveal.js` (drop the `Module._resolveFilename` patching — the model needs no
  vscode stub)

**Gates:** G1, G2, and G4 is **mandatory, not optional** — reveal ancestry and tab identity are
exactly what this phase touches, and the 0.6.0 duplicate-tab regression proved headless gates
cannot see this class of bug. **Exit:** `getParent` performs no linear scans and constructs no
sibling nodes; `contextValue`/id stay in sync by construction (single assignment site).

---

### Phase 8 — Candidate 09: extract the webview's pure decisions

**Files:**
- Create (each dual-mode like `media/stFolding.js` — `<script>` tag + `require()`):
  `media/peekUri.js` (encode/decode of the synthetic peek/goto URIs, shared with what Phase 1
  left in `editorMapping`/`livePath`), `media/pendingEdits.js` (the pending-edit/auto-sync/dirty
  state machine from `media/editor.js:141–235` — **the highest-value untested surface in the
  repo: it decides whether a user's edits reach disk**, currently verified only by hand),
  `media/diagnosticMarkers.js` (pane split + marker shape, `media/editor.js:53–98`)
- Modify: `media/editor.js` (consume the three), `src/customEditorProvider.js:124–131` (the
  cross-process pending-edit contract gets stated on BOTH sides via the shared module)
- Test: `test/test_pending_edits.js`, `test/test_peek_uri.js`, `test/test_diagnostic_markers.js`

**Why not earlier:** every step here obligates G3 (both browser runners) and the extraction wins
depend on Phase 1 (id grammar) and Phase 3/4 (one coordinate dialect) having landed — doing it
first would extract today's duplicated vocabularies.

**Gates:** G1, G2, **G3 after every change to `media/editor.js`**, G4 once at the end. **Exit:**
the state machine that gates disk writes has a plain-Node test; `media/editor.js` shrinks by the
three modules' line count.

---

### Phase 9 — Candidate 07: split libsymbols.js — only if still warranted

**Speculative by design; re-evaluate before starting** — Phases 2 and 5 will already have
removed `parseCache` coupling and the triple walk from the file. If the remaining file no longer
hurts, record "not done, and why" in HANDOFF and stop; that is a valid completion of this phase.

**Files (if it proceeds):**
- Create: `src/lsp/zipArchive.js`, `src/lsp/libraryCatalog.js`, `src/lsp/tmcTypes.js`,
  `src/lsp/signaturesMerge.js`, `src/lsp/browserCacheMerge.js`, `src/lsp/libraryRegistry.js` —
  with `libraryRegistry` the ONLY module able to write a registry, making the
  "always `ensureLibraryRegistry`" rule structural
- Modify: `src/lsp/libsymbols.js` (becomes the composition point), `src/lsp/server.js:26–34`,
  `src/lsp/features/completions.js`, `src/lsp/types.js`, `test/test_libsymbols.js`,
  `test/test_collect_scope.js`, `test/test_archive_identity.js`
- Retire: the ~10 harness-only exports and the production `defaultRegistry` fallback — **only**
  after every standalone harness that leans on the default registry has been converted to pass an
  index explicitly (≈15 harnesses; count them before starting, that count is the phase's real
  size).

**Hard constraints (from Global Constraints, restated because this file is where they live):**
on-demand registration, `(path,size,mtime)` guards, content-keyed archive identity, the
`SKIP_DIRS`/`PROJECT_SKIP_DIRS` split. This phase moves walls, never behaviour. **Gates:** G1,
G2, G5, plus a timing sanity check against DEVELOPMENT.md "Indexing cost" numbers (startup scan
count and archive-decode count must not regress — `__archiveStats` stays until this phase ends).

---

## Self-review record

- **Coverage:** all nine report candidates map to phases 1–9; the report's test-bypass table is
  addressed by phases 1 (conformance test), 3 (copy deleted), 5 (drift alarms retired), 7
  (loader patching dropped), 9 (widened exports retired).
- **Consistency:** `componentId.js` names (`make/parse/label/isAccessor`) and `livePath.js`
  names (`assemble/locate/paneText/peekModelsFor`) are used identically in every phase that
  references them.
- **Known open decisions** (each recorded in HANDOFF when made): Phase 4 fossil-rewrite default;
  Phase 6 `features.js` fold-or-keep; Phase 9 go/no-go.
