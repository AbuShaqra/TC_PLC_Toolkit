# Phase 6: Server Request Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The invariant "no language request is answered against an index that has not seen the
document's library usage" moves from prose to structure: a request router makes `syncDocument`
unskippable for document-carrying handlers and makes skipping it an EXPLICIT variant; the
library-index stage ordering ("signatures after .tmc, browsercache last") becomes validated data.
`server.js` gets its logic tested for the first time (via the extracted, IPC-free module).

**Architecture:** `src/lsp/requestPipeline.js` (IPC-free, requires nothing that opens a
connection) exports `createRequestRouter(deps)` → `{ withDocument, withoutDocument }` and
`runLibraryIndexPipeline(stages, deps, ctx)` + the `LIBRARY_INDEX_STAGES` table with declared
`after` prerequisites validated at load. `server.js`'s six language-path `custom/*` handlers
become one-line registrations; `indexLibraries` becomes the pipeline call. The five control
handlers (`reindex`, `indexReady`, `setDiagnosticsConfig`, `libraries`, `indexXmlDocument`) are
DELIBERATELY not wrapped — they are config/control requests with no document to sync, and each
already has its own response-shaped catch; wrapping them would add interface without behaviour
(deletion-test fail).

**Ruling (recorded): `features.js` is KEPT** as the 26-line re-export — it fails the deletion
test in the harmless direction (removing it churns ~6 harness requires and concentrates nothing),
and require-path stability has value. Instead its header gains one sentence naming
`features/core.js` as the real shared interface. Do not fold it.

**Tech Stack:** Plain CommonJS; `test/run.js`; `tsc --noEmit`.

**Spec:** `docs/superpowers/plans/2026-08-22-deepening-roadmap.md` Phase 6.

## Global Constraints

- No build step; plain CommonJS; JSDoc; no new dependencies. `requestPipeline.js` must be
  loadable by a bare harness (no `vscode-languageserver` require, no IPC at load).
- **Behaviour-neutral**: every handler's response and fallback shape is byte-identical (`[]` vs
  `null` vs `{resolved:false,...}` vs `{success:false, error}` — the exact current values, see
  the transcription table in Task 2). The scan-controller semantics, `custom/reindex`'s
  unconditionality, and the load-bearing comments MOVE, not vanish.
- The library stage ORDER is frozen: namespaces → symbols → typeSystem → signatures →
  rootSignatures (skip a root that IS fsPath, aggregate stats) → browsercache. The two prose
  constraints become `after:` data and a load-time validation (a table listing a stage before its
  prerequisite throws at require time).
- Gates per task (bare, exit-code checked): `REQUIRE_FULL_SUITE=1 npm test` (68/68 → 69/69 after
  T1's harness); `npm run typecheck`.
- G4 deferred to the user's machine (server.js wiring is dev-host-covered); no media/ changes.

---

### Task 1: `src/lsp/requestPipeline.js` + harness

**Files:**
- Create: `src/lsp/requestPipeline.js`, `test/test_request_pipeline.js`

**Interfaces produced (Task 2 consumes these exact names):**

```js
createRequestRouter({ getIndexForUri, sync })
    → { withDocument(fallback, handler), withoutDocument(fallback, handler) }
// withDocument(fallback, handler): returns (params) => {
//     try { const index = getIndexForUri(params.fileUri);
//           sync(params.code, params.fileUri, index);
//           return handler(params, index); }
//     catch (e) { return typeof fallback === 'function' ? fallback(e) : fallback; } }
// withoutDocument: same WITHOUT the sync call — the explicit "this handler reads from disk /
//     takes no code" variant; its existence is the point: skipping sync is a visible choice.
LIBRARY_INDEX_STAGES   // frozen array of { name, after: string[] } — see order above
validateStageOrder(stages)   // throws if any stage precedes one of its `after` names; run at load
runLibraryIndexPipeline(runners, ctx)
// runners: { [stageName]: (ctx) => statsPatch } — the actual libsymbols/libraries calls are
//   INJECTED by the caller (server.js supplies them), so the harness drives the pipeline with
//   recorders and the module stays free of heavy requires.
// ctx: { fsPath, index, roots } — runs every stage in table order, merges returned stat patches
//   into { stats, tmc, sig, bc } shaped exactly like today's indexLibraries locals, and returns
//   them plus a preformatted log line (the current template literal moved verbatim, including
//   the singular/plural ternaries) or null when nothing indexed (today's if-guard).
```

- [ ] **Step 1: Write the harness first** (`test/test_request_pipeline.js`, check style):
  1. `withDocument` calls sync exactly once, BEFORE the handler, with (params.code,
     params.fileUri, index-from-getIndexForUri) — recorder asserts call order and arguments.
  2. `withDocument` returns the handler's value; a throwing handler returns the fallback; a
     throwing sync returns the fallback; a FUNCTION fallback receives the error.
  3. `withoutDocument` never calls sync (recorder count 0) and has the same catch semantics.
  4. `validateStageOrder`: the shipped `LIBRARY_INDEX_STAGES` passes; a reordered copy (browsercache
     before signatures) throws with the offending names in the message; the validation ran at
     module load (require the module = no throw, and the table is frozen).
  5. `runLibraryIndexPipeline`: with recorder runners, stages run in table order; ctx passed
     through; stat patches merge; the log line matches today's format on a fixed stats fixture
     (assert the exact string, singular AND plural branch of one ternary); the
     nothing-indexed guard returns null line.
  Run → red (module absent).
- [ ] **Step 2: Implement.** The log-line template and its guard move VERBATIM from
  `server.js:126-135`. `LIBRARY_INDEX_STAGES = Object.freeze([...].map(s => Object.freeze(s)))`
  with `after` arrays: namespaces:[], symbols:[], typeSystem:[], signatures:['typeSystem'],
  rootSignatures:['signatures'], browsercache:['signatures','typeSystem']. Call
  `validateStageOrder(LIBRARY_INDEX_STAGES)` at module load.
- [ ] **Step 3: Gates** — harness green; full suite 69/69 FULL; typecheck clean.
- [ ] **Step 4: Commit** — `feat(lsp): requestPipeline — structural sync + validated library stage order`

---

### Task 2: Convert `server.js`

**Files:**
- Modify: `src/lsp/server.js`, `src/lsp/features.js` (header sentence only)

**Transcription table (responses/fallbacks frozen — every row's fallback is today's catch value):**

| request | wrapper | fallback | handler body (index-threaded) |
|---|---|---|---|
| `custom/completions` | withDocument | `[]` | `provideCompletions(p.code, p.position, index, p.fileUri)` |
| `custom/definition` | withDocument | `null` | `provideDefinition(p.code, p.position, index, p.fileUri)` |
| `custom/references` | withDocument | `[]` | `provideReferences(p.code, p.position, index, p.fileUri)` |
| `custom/diagnostics` | withDocument | `[]` | `provideDiagnostics(p.code, index, p.fileUri)` |
| `custom/updateDocument` | withDocument | `(e) => ({ success: false, error: e.message })` | `{ success: true }` (sync IS the work) |
| `custom/referencesForSymbol` | withoutDocument | `{ resolved: false, references: [], declaration: null }` | `provideReferencesForSymbol(p, index)` |
| `custom/configReferencesForSymbol` | withoutDocument | `{ resolved: false, occurrences: [] }` | `findConfigReferencesForSymbol(p, workspace.indexForUri(p.fileUri), workspace.configFilesFor(p.fileUri))` — note it needs configFilesFor too; give withoutDocument's handler `(params, index)` and read configFilesFor via the same closure the current code uses |

- [ ] **Step 1:** Build the router once: `const router = createRequestRouter({ getIndexForUri:
  (uri) => workspace.indexForUri(uri), sync: syncDocument });` (closure over the mutable
  `workspace` binding — CAREFUL: `workspace` is reassigned by rescan; the arrow reads the CURRENT
  binding, which preserves today's behaviour). Convert the seven table rows to
  `connection.onRequest(name, router.withDocument(fallback, handler))` one-liners. The
  no-sync rationale comments (`:293-296`, `:305-309`) stay attached to their registrations.
  The five control handlers are untouched (add one comment block above them naming the deliberate
  non-wrapping and why).
- [ ] **Step 2:** Replace `indexLibraries`'s body with runner injection + pipeline call:

```js
function indexLibraries(fsPath, index, roots) {
    const result = runLibraryIndexPipeline({
        namespaces: () => indexLibraryNamespaces(fsPath, index),
        symbols: () => indexLibrarySymbols(fsPath, index),
        typeSystem: () => indexTypeSystem(fsPath, index),
        signatures: () => indexLibrarySignatures(fsPath, index),
        rootSignatures: (ctx) => { /* the roots loop moved verbatim, aggregating into sig */ },
        browsercache: () => indexBrowserCache(fsPath, index)
    }, { fsPath, index, roots });
    if (result.logLine) connection.console.log(result.logLine);
}
```

  The `roots`-loop body (skip `normalizeProjectPath(root) === normalizeProjectPath(fsPath)`,
  aggregate the five sig counters) moves verbatim into the rootSignatures runner; its doc
  comment moves with it. The big JSDoc on `indexLibraries` stays on the function.
- [ ] **Step 3:** `features.js` header gains: "The facade exists for require-path stability;
  `features/core.js` is the real shared interface between the feature modules." Nothing else.
- [ ] **Step 4: Gates** — full suite 69/69 FULL; typecheck clean. Also
  `node -e "require('./src/lsp/requestPipeline')"` exits 0 (load-time validation holds), and
  verify by grep that server.js contains NO inline `syncDocument(` call inside a `custom/`
  handler body anymore (the two legit remaining calls: documents.onDidChangeContent, and none
  other).
- [ ] **Step 5: Commit** — `refactor(lsp): server handlers ride the request pipeline; stage order is validated data`

---

## Self-review record

- The `workspace` reassignment hazard is named in T2 Step 1 (arrow reads current binding) — the
  router must NOT capture `workspace.indexForUri` as a bound method at construction.
- `custom/updateDocument`'s error-shaped fallback motivates the function-fallback form; pinned in
  T1 check 2.
- `custom/configReferencesForSymbol` needs two workspace lookups — the table row documents the
  closure approach so the implementer doesn't force it through the single-index signature.
- Control handlers deliberately unwrapped, with the deletion-test reasoning in the plan header
  and a comment in server.js.
- Suite count: 68 → 69 with T1's harness; T2's gate says 69/69.
