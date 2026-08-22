# Phase 4: One Coordinate Dialect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pane vocabulary (`'decl'`/`'impl'`) across the whole system; `stConverter.js` loses
its module-global mode flag and its hardcoded project-specific rewrites become data; the P3
deferral (production resolver coverage) lands.

**Architecture:** `mapDiagnosticsToMonaco` moves out of `stConverter.js` into `livePath.js` as
`mapDiagnosticsToLocal`, emitting the same pane tokens as every other livePath function —
`media/editor.js` stops carrying two dialects for one concept. `RAW_MODE` becomes a threaded
`raw` parameter (the caller-must-know invariant "safe because synchronous" becomes structurally
unnecessary). The three struct-flatten fossils and the `fbMCPower` rewrite become entries in two
data tables, byte-identical output, applied only in clean (non-raw) mode as today.

**Tech Stack:** Plain CommonJS; `test/run.js`; `tsc --noEmit`; Playwright browser harnesses
(`HARNESS_CHROMIUM=/opt/pw-browsers/chromium`).

**Spec:** `docs/superpowers/plans/2026-08-22-deepening-roadmap.md` Phase 4 (+ P3's deferred
resolver-coverage item, recorded in HANDOFF).

**Ruling (recorded here and in the ledger):** the fossil rewrites are KEPT, default-on, as data —
option (a) of the roadmap's open decision. They only affect the clean/portable "Generate ST
files" output (never the live path, which is raw), so removal is a user-visible behaviour choice
that stays open; making them data isolates them for that later decision.

## Global Constraints

- No build step; plain CommonJS; JSDoc; no new dependencies (Playwright only ever `--no-save`).
- **Clean-mode output is byte-identical** before/after T1 (the tables are a refactor of form, not
  behaviour). **Raw-mode output byte-identical** trivially (pass-through).
- **`mapDiagnosticsToLocal` output is identical to `mapDiagnosticsToMonaco` except the pane
  tokens** (`'declaration'`→`'decl'`, `'implementation'`→`'impl'`): same skip-outside-blocks
  behaviour, same relative 1-based Monaco ranges (including an end line past the block mapping
  relative to the SAME block — transcribe the loop, do not "improve" it).
- The webview's diagnostics rendering behaviour is unchanged (same markers, same panes) — only
  the token strings it compares against change with the producer.
- Gates every task: `REQUIRE_FULL_SUITE=1 npm test` → 66/66 FULL; `npm run typecheck` clean.
- **G3 (browser harnesses) is REQUIRED for T2** (it changes `media/editor.js`):
  `npm i --no-save playwright` once, then `HARNESS_CHROMIUM=/opt/pw-browsers/chromium node
  test/browser/run.js` and `... run_pragmas.js`. **Run both at BASE first** and record their
  status — HANDOFF documents a known environmental worker-404 catch-all failure that reproduces
  with old code; the gate is "no assertion regresses relative to the BASE run", not
  "zero failures in this container".
- G4 (dev-host) deferred to the user's machine, as every phase.

---

### Task 1: `raw` as a parameter; fossils as data (stConverter.js only)

**Files:**
- Modify: `src/stConverter.js`
- Create: `test/test_st_converter_portable.js`

**Interfaces:** `convertXmlToSt(parsedXml, options)` signature unchanged. Internal only:
`cleanDeclarationText(declText, raw)` / `cleanImplementationText(implText, raw)`;
`let RAW_MODE` deleted; two module-level frozen tables:

```js
/**
 * Portable-output rewrites for structs whose EXTENDS base cannot be resolved by a standard
 * IEC 61131-3 compiler: the base's fields are flattened into the struct. Data, not code, so the
 * list is auditable and removable per entry; applied only in clean (non-raw) mode. These names
 * come from one real project — kept deliberately (recorded ruling, Phase 4): they only shape the
 * exported .st text, never the live editor path.
 */
const STRUCT_FLATTEN_REWRITES = Object.freeze([
    {
        typeName: 'ST_MES_Interlocking_Data', baseName: 'ST_MES_Basic_Data',
        fields: '\n\t// Fields from ST_MES_Basic_Data\n\tsOperationNumber\t\t: STRING(15);\n\tsMaterialNumber  \t\t: STRING(15);\n\tsOperator\t\t\t\t: STRING(25);\n\tsWorkstationName \t\t: STRING(25);\n\tsOrderNumber\t\t\t: STRING(15);\n\tsTestMethodName\t\t\t: eMESTestMethodNames;\n\tsTestProgramName \t\t: STRING(50);\n\tsTestEquipmentNumber \t: STRING(15);'
    },
    {
        typeName: 'ST_MES_TestUnit_Data', baseName: 'ST_MES_Basic_Data',
        fields: '\n\t// Fields from ST_MES_Basic_Data\n\tsOperationNumber\t\t: STRING(15);\n\tsMaterialNumber  \t\t: STRING(15);\n\tsOperator\t\t\t\t: STRING(25);\n\tsWorkstationName \t\t: STRING(25);\n\tsOrderNumber\t\t\t: STRING(15);\n\tsTestMethodName\t\t\t: eMESTestMethodNames;\n\tsTestProgramName \t\t: STRING(50);\n\tsTestEquipmentNumber \t: STRING(15);'
    },
    {
        typeName: 'ST_AxisErrors', baseName: 'ST_Errors',
        fields: '\n\t// Fields from ST_Errors\n\tbError\t\t\t\t: BOOL;\n\tnExternalErrorID\t: UDINT;\n\teErrorState\t\t\t: E_error_state := E_error_state.no_error;'
    }
]);
```

and the flatten application replacing the three copy-pasted `if` blocks:

```js
    // 6. Flatten struct inheritance the portable output cannot resolve (see table above).
    for (const rw of STRUCT_FLATTEN_REWRITES) {
        const headRe = new RegExp(`\\bTYPE\\s+${rw.typeName}\\s+EXTENDS\\s+${rw.baseName}\\s*:`, 'i');
        if (headRe.test(text)) {
            text = text.replace(headRe, `TYPE ${rw.typeName} :`);
            text = text.replace(/\bSTRUCT\b/i, `STRUCT${rw.fields}`);
        }
    }
```

The `fbMCPower` impl rewrite stays a single named block in `cleanImplementationText` but gains a
comment naming it a project-specific portability rewrite kept by the same ruling (one entry does
not need a table; do NOT invent one).

- [ ] **Step 1: Write the failing/pinning test first** — `test/test_st_converter_portable.js`
(standalone, no fixtures; `check(name, fn)` style like `test_component_id.js`):

```js
// 1. Raw mode is verbatim: convertXmlToSt(parsed, {raw:true}) on a fixture whose decl contains
//    'REFERENCE TO', 'AND_THEN' and an ST_MES_Interlocking_Data EXTENDS head keeps all three
//    byte-for-byte in stText.
// 2. Clean mode still rewrites: same fixture through {raw:false} — 'POINTER TO' present,
//    'AND_THEN' gone (AND), the EXTENDS head replaced and the flattened
//    'Fields from ST_MES_Basic_Data' comment present.
// 3. NO MODE LEAKAGE (the old module-global's hazard, now impossible — pin it): convert raw,
//    then clean, then raw again; first and third stText strictly equal.
// 4. The fossil tables are data: STRUCT_FLATTEN_REWRITES is exported frozen, has exactly 3
//    entries, and removing none is asserted here (length === 3) so a future deletion is a
//    conscious test edit.
```

(Export `STRUCT_FLATTEN_REWRITES` for the test — add it to module.exports.) Use a minimal
TcPlcObject DUT fixture through the real `parseTwinCatXml` like `test_component_id.js` does.
Assertions 1-3 FAIL against nothing yet? No — they PASS today except 4 (no export) and the
leakage pin (which passes today too). This task's test is a **pin-then-refactor**: run it against
the CURRENT code first (only check 4 red), then refactor, then all green — the pins prove the
refactor changed nothing.

- [ ] **Step 2: Refactor** — delete `RAW_MODE`; `convertXmlToSt` captures `const raw =
!!options.raw;` and passes it to every `cleanDeclarationText(x, raw)` /
`cleanImplementationText(x, raw)` call (12 sites in the file); both clean functions take `(text,
raw)` and start with `if (raw) return text;` (after the existing empty-check); replace the three
fossil `if` blocks with the table loop; export `STRUCT_FLATTEN_REWRITES`.

- [ ] **Step 3: Gates** — new test all green; `node test/test_live_path.js` (13/13 — raw path);
full suite 66/66 FULL (wait — 67 with the new harness; expect **67/67 FULL**); typecheck clean.

- [ ] **Step 4: Commit** — `refactor(converter): raw is a parameter, fossil rewrites are data`

---

### Task 2: One pane dialect — diagnostics mapping moves to livePath

**Files:**
- Modify: `src/livePath.js` (add `mapDiagnosticsToLocal`), `src/stConverter.js` (delete
  `mapDiagnosticsToMonaco` + its export), `src/customEditorProvider.js` (import/callsite),
  `media/editor.js` (the `'declaration'`/`'implementation'` pane-token comparisons fed by
  `custom/diagnosticsResponse`), `test/test_live_path.js` (its `mapDiagnosticsToMonaco`
  import/assertions), any other harness importing `mapDiagnosticsToMonaco` (grep first:
  `grep -rn "mapDiagnosticsToMonaco" src/ test/ media/`).

**Interfaces:** `mapDiagnosticsToLocal(diagnostics, lineMap)` in livePath — the transcribed loop
from `stConverter.js:293-344` with exactly two token changes (`'declaration'`→`'decl'`,
`'implementation'`→`'impl'`); same output shape otherwise (componentId, pane, severity, message,
Monaco 1-based relative range).

- [ ] **Step 1: BASE browser-harness run** — `npm i --no-save playwright`, then run BOTH runners
with `HARNESS_CHROMIUM=/opt/pw-browsers/chromium`; record pass/fail per assertion in the report
(HANDOFF documents a known environmental worker-404 catch-all; whatever fails at BASE is the
baseline, not your regression).

- [ ] **Step 2: Failing tests first** — in `test_live_path.js`, change the diagnostics assertions
to expect `'decl'`/`'impl'` panes from the NEW import (`mapDiagnosticsToLocal` from
`../src/livePath`); run → red (function does not exist).

- [ ] **Step 3: Implement** — add `mapDiagnosticsToLocal` to livePath (transcribed loop; JSDoc
notes it deliberately preserves the end-line-past-block behaviour); delete
`mapDiagnosticsToMonaco` from stConverter (exports shrink to `convertXmlToSt` +
`STRUCT_FLATTEN_REWRITES`); convert `customEditorProvider.js`'s diagnostics handler; in
`media/editor.js` convert every pane-token comparison fed by the diagnostics response to
`'decl'`/`'impl'` (grep `'declaration'`/`'implementation'` string literals; convert ONLY
pane-semantics sites — report each site converted and each deliberately left).

- [ ] **Step 4: Gates** — `test_live_path.js` green; full suite **67/67 FULL**; typecheck; grep
shows no `mapDiagnosticsToMonaco` anywhere; **G3: both browser runners re-run — every assertion
that passed at BASE still passes** (diagnostics markers render in the correct panes is covered by
run.js's assertions).

- [ ] **Step 5: Commit** — `refactor: one pane dialect — diagnostics mapping lives in livePath`

---

### Task 3: Production resolver under the unit harness (P3 deferral)

**Files:**
- Modify: `test/test_live_path_unit.js` only.

- [ ] **Step 1:** Replace the hand-written `makeTestResolver` stand-in with the production
`createStResolver({activeUri, activeUnit, readFile})` — the counting `readFile` double already
serves XML strings, and parse+convert produces the same units the assertions were derived from.
Keep the counting semantics: the double counts CALLS REACHING IT (the resolver's cache means a
second request for the same uri never reaches it — which is exactly what the budget assertions
measure; re-derive the expected counts and update them if the stand-in's counting differed).
- [ ] **Step 2:** `node test/test_live_path_unit.js` green; full suite 67/67 FULL; typecheck.
- [ ] **Step 3: Commit** — `test: live-path unit harness drives the production resolver`

---

## Self-review record

- T1's pin-then-refactor order is explicit (the test mostly passes BEFORE the refactor — that is
  its job); the one initially-red check (table export) is called out.
- T2's two-token-change constraint plus transcription requirement makes the diff reviewable
  against the deletion hunk, as in P3.
- Suite count: 66 → 67 with T1's new harness; T2/T3 gates say 67/67.
- The G3 baseline-first protocol handles the documented environmental browser failure without
  weakening the gate.
- Ruling on fossils recorded in the header; close-out records it in HANDOFF.
