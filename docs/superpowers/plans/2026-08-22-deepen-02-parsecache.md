# Phase 2: parseCache Clone Rule Made Structural — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `readSignatureRecords` + `cloneSignatureRecords` into one entry point that
always returns a private copy, so the "clone is mandatory" rule becomes unstateable instead of
documented; fold in the three Phase-1 deferred minors on `componentId.js`.

**Architecture:** The cached *template* stops being exported — `signatureRecordsFor(filePath)`
does the cached parse AND the copy in one call, so no caller can ever hold the shared object.
`readBrowserCacheDoc`'s no-clone contract is untouched (its consumers only read). Separately,
`componentId.js` gains `Object.freeze(KINDS)`, a pinned degenerate-parse case, and an
`accessorIdsFor` helper so even `treeDataProvider`'s deliberate concatenation speaks through the
grammar owner.

**Tech Stack:** Plain CommonJS, `test/run.js` harnesses, `tsc --noEmit`.

**Spec:** `docs/superpowers/plans/2026-08-22-deepening-roadmap.md` Phase 2 (+ the Phase-1
final-review deferred minors, recorded in HANDOFF.md).

## Global Constraints

- No build step; plain CommonJS; JSDoc like the neighbours; no new dependencies.
- **Cache identity stays `(resolved lowercase path, mtimeMs, size)`** — the strength every cache
  in this codebase uses. Do not change `lookup`.
- **The shallow-copy shape is load-bearing and must not deepen:** `types` records are copied
  per-record (`{...record}`), `symbols` and each record's `members` stay SHARED by design (read-only
  consumers; copying `members` per project is pure waste on the hottest part of the merge). The new
  entry point preserves exactly `cloneSignatureRecords`'s current copy depth.
- `parseSignatureRecords` (pure string parse) keeps its name and export — `indexLibrarySignaturesFromXml`
  path needs it.
- `__stats` counters and `clearParseCaches` stay exported for the harnesses; `clones` now counts
  copies handed out by the new entry point.
- Gates for every task: `REQUIRE_FULL_SUITE=1 npm test` → 65/65 FULL; `npm run typecheck` clean.
  For Task 1 additionally G5: re-run the suite with `sample/_Libraries/Beckhoff Automation GmbH`
  moved aside and back (move, never delete) — if that directory does not exist in this clone
  (it is git-ignored), note that in the report and the plain run stands.
- The componentId grammar stays FROZEN — Task 2 adds helpers and hardening, never changes a
  minted or parsed string.

---

### Task 1: `signatureRecordsFor` — cached parse, private copy, template never escapes

**Files:**
- Modify: `src/lsp/parseCache.js` (collapse the two functions; update file header + exports)
- Modify: `src/lsp/libsymbols.js:44-45` (imports), `:1490` area (the `mergeSignatureRecords`
  doc-comment sentence about cloning), `:1620-1627` (the call site)
- Modify: `test/test_signature_cache.js` (rewrite around the single entry point)

**Interfaces:**
- Produces: `signatureRecordsFor(filePath) → SignatureRecords|null` — cached parse keyed
  `(path,mtime,size)`; **every call returns a fresh copy** at exactly the old clone depth
  (`types` records copied, `symbols`/`members` shared); `null` for unreadable/unparseable, same
  as before. `readSignatureRecords` and `cloneSignatureRecords` are **no longer exported** (the
  clone helper survives only as a private function if the implementation wants it).

- [ ] **Step 1: Rewrite the failing test first**

Rewrite `test/test_signature_cache.js` to consume `signatureRecordsFor` (keep its existing
fixture-building machinery and assert style; it currently imports
`readSignatureRecords`/`cloneSignatureRecords` at :26). The rewritten suite must assert:

```js
const { parseSignatureRecords, signatureRecordsFor, readBrowserCacheDoc,
        clearParseCaches, __stats } = require('../src/lsp/parseCache');

// 1. One dump, requested for three "projects": parsed ONCE, two cache hits, three copies.
clearParseCaches();
const a = signatureRecordsFor(dumpPath);
const b = signatureRecordsFor(dumpPath);
const c = signatureRecordsFor(dumpPath);
assert(a && b && c, 'dump must parse');
assert(__stats.parses === 1, `parsed once, got ${__stats.parses}`);
assert(__stats.hits === 2, `two cache hits, got ${__stats.hits}`);
assert(__stats.clones === 3, `three copies handed out, got ${__stats.clones}`);

// 2. Isolation by IDENTITY: distinct result objects, distinct types arrays, distinct records.
assert(a !== b && b !== c, 'each call returns its own object');
assert(a.types !== b.types, 'each call returns its own types array');
assert(a.types.length === 0 || a.types[0] !== b.types[0], 'type records are per-call copies');

// 3. Isolation by MUTATION — the assertion that failed while records were shared:
//    project A's merge rewrites namespace; project B must not see it.
if (a.types.length > 0) {
    a.types[0].namespace = 'CONTAMINATED';
    const d = signatureRecordsFor(dumpPath);
    assert(d.types[0].namespace !== 'CONTAMINATED', 'the cached template never escapes');
}

// 4. Documented sharing stays: symbols array and each record's members are the same objects.
assert(a.symbols === b.symbols, 'symbols stay shared by design');

// 5. The old API is gone — the unsafe call no longer exists to be made.
const parseCache = require('../src/lsp/parseCache');
assert(parseCache.readSignatureRecords === undefined, 'readSignatureRecords is retired');
assert(parseCache.cloneSignatureRecords === undefined, 'cloneSignatureRecords is retired');
```

Keep the suite's existing cases that still apply: the mtime-bump-reparses case (now through
`signatureRecordsFor`), the missing-file→null case (:168), and the browsercache equivalence-gate
half (`readBrowserCacheDoc` is untouched). Drop only what asserts the retired API.

- [ ] **Step 2: Run it — must fail** (`signatureRecordsFor` is not exported yet).

- [ ] **Step 3: Implement in `parseCache.js`**

```js
/**
 * The parsed records of one `library-signatures.xml` — parsed at most once per
 * (path, mtime, size), and returned as a PRIVATE COPY on every call.
 *
 * There is deliberately no way to obtain the cached template: the merge rewrites
 * `record.namespace` and the browsercache enrichment pushes onto `methods`/`properties`,
 * so a shared record would leak one project's attribution into another. The copy depth
 * matches what the merge writes: type records are copied, `symbols` and each record's
 * `members` stay shared (read-only in every consumer; see the file header).
 * @param {string} filePath Absolute path to a `library-signatures.xml`.
 * @returns {SignatureRecords|null} A caller-owned copy, or null when unreadable/unparseable.
 */
function signatureRecordsFor(filePath) {
    const found = lookup(signatureCache, filePath);
    if (!found) return null;
    let template = found.value;
    if (template) {
        __stats.hits++;
    } else {
        let xml;
        try {
            xml = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            return null; // unreadable dump: contribute nothing rather than guess
        }
        template = parseSignatureRecords(xml);
        __stats.parses++;
        signatureCache.set(found.key, { mtimeMs: found.stat.mtimeMs, size: found.stat.size, value: template });
    }
    __stats.clones++;
    return {
        functions: template.functions,
        functionBlocks: template.functionBlocks,
        types: template.types.map(record => ({ ...record })),
        // Strings: nothing can mutate them, so the array is shared like `members`.
        symbols: template.symbols
    };
}
```

Delete `readSignatureRecords` and `cloneSignatureRecords`; update the exports to
`{ parseSignatureRecords, signatureRecordsFor, readBrowserCacheDoc, clearParseCaches, __stats }`;
rewrite the file-header paragraph that says "every consumer merges a clone" to say the entry
point copies for you and the template is unreachable.

- [ ] **Step 4: Convert the caller in `libsymbols.js`**

```js
// imports (:44-45): readSignatureRecords, cloneSignatureRecords  →  signatureRecordsFor
// call site (:1620-1627):
const records = signatureRecordsFor(file);
if (!records) continue; // unreadable dump: contribute nothing rather than guess
stats.files++;
const one = mergeSignatureRecords(records, index);
```

Update the comment above the call site (parsed once / merged per project stays true — the copy
now happens inside the entry point) and the `mergeSignatureRecords` doc-comment sentence around
`:1490` that instructs callers to clone first.

- [ ] **Step 5: Gates** — `node test/test_signature_cache.js` green; `node test/run.js signature`
green; `REQUIRE_FULL_SUITE=1 npm test` 65/65 FULL; `npm run typecheck` clean; G5 per Global
Constraints.

- [ ] **Step 6: Commit** — `refactor(lsp): signatureRecordsFor makes the parse-cache clone rule structural`

---

### Task 2: componentId hardening — freeze, pin, and the accessor-id helper

**Files:**
- Modify: `src/componentId.js` (freeze `KINDS`; add `accessorIdsFor`)
- Modify: `src/treeDataProvider.js:543-549` (consume `accessorIdsFor`)
- Modify: `test/test_component_id.js` (three new checks)

**Interfaces:**
- Produces: `accessorIdsFor(propertyId) → {get: string, set: string}` — appends `_get`/`_set` to
  a property SIGNATURE id by concatenation. Concatenation is the point: it reproduces
  `xmlParser`'s mint exactly and is immune to the parse ambiguity (a property named `Foo_get`
  round-trips correctly, where parse-then-remint self-matches — the Phase 1 Critical). Throws if
  `propertyId` is not a parseable non-accessor prop id (programmer error, same policy as `make`).

- [ ] **Step 1: Extend the test first** (append to `test/test_component_id.js`, its `check` style):

```js
check('KINDS is frozen', () => {
    assert.ok(Object.isFrozen(cid.KINDS), 'KINDS must be frozen like KIND_TO_XML_TAG');
});
check('degenerate prop__get parse is pinned', () => {
    // A property named '_get': the accessor regex requires a non-empty name before the suffix,
    // so this is NOT an accessor — it is the correct reading, pinned so nobody "fixes" it.
    assert.deepStrictEqual(cid.parse('prop__get'), { kind: 'prop', name: '_get', accessor: null });
});
check('accessorIdsFor builds mint-identical accessor ids by concatenation', () => {
    assert.deepStrictEqual(cid.accessorIdsFor('prop_Speed'), { get: 'prop_Speed_get', set: 'prop_Speed_set' });
    // The Phase-1 Critical shape: a property literally named Data_get must NOT self-collapse.
    assert.deepStrictEqual(cid.accessorIdsFor('prop_Data_get'), { get: 'prop_Data_get_get', set: 'prop_Data_get_set' });
    assert.throws(() => cid.accessorIdsFor('method_Run'), /prop/);
    assert.throws(() => cid.accessorIdsFor('root'), /prop/);
});
```

Note the second `accessorIdsFor` case: `parse('prop_Data_get')` reads as an ACCESSOR of `Data`,
so a parse-based guard would wrongly reject it. The guard must therefore accept any id that
**starts with `prop_`** and is not itself produced by appending `_get`/`_set` to the SAME call —
concretely: require `typeof id === 'string' && /^prop_.+/.test(id)`; do NOT require
`parse(id).accessor === null` (that misreads `prop_Data_get`). Rejecting genuine accessor ids
(`prop_X_get`) is impossible to do reliably for this reason — the helper's contract is
"give me a property SIGNATURE id" and the doc-comment says so.

- [ ] **Step 2: Run — the two new checks fail** (no `accessorIdsFor`, `KINDS` unfrozen).

- [ ] **Step 3: Implement in `componentId.js`**

```js
const KINDS = Object.freeze(['root', 'method', 'prop', 'action', 'transition']);

/**
 * The Get/Set accessor ids of a property SIGNATURE id, by suffix concatenation.
 *
 * Concatenation is deliberate and load-bearing: it reproduces xmlParser's mint exactly
 * (`prop_${name}` + `_get`) and is immune to the grammar's accessor ambiguity — parsing a
 * property named `Foo_get` misreads it as an accessor of Foo, which is how the Objects tree
 * once recursed infinitely. Callers must pass the property's own id, not an accessor id.
 * @param {string} propertyId A `prop_<name>` id as minted for the property signature.
 * @returns {{get: string, set: string}}
 */
function accessorIdsFor(propertyId) {
    if (typeof propertyId !== 'string' || !/^prop_.+/.test(propertyId)) {
        throw new Error(`componentId.accessorIdsFor: not a prop signature id: '${propertyId}'`);
    }
    return { get: `${propertyId}_get`, set: `${propertyId}_set` };
}
```

Add `accessorIdsFor` to the exports.

- [ ] **Step 4: Convert `treeDataProvider.js:543-549`** — replace the inline concatenation and its
comment with the helper (the WHY now lives in the owner):

```js
// Accessor ids come from the grammar owner, which builds them by concatenation on purpose —
// parsing c.id would misread a property named `*_get` as its own accessor (see componentId.js).
const accessorIds = accessorIdsFor(c.id);
const getAcc = parsedComponents.find(x => x.id === accessorIds.get);
const setAcc = parsedComponents.find(x => x.id === accessorIds.set);
```

with the require added to the file's existing import block.

- [ ] **Step 5: Gates** — `node test/test_component_id.js` green; `node test/test_tree_reveal.js`
green **including the Data_get regression cases**; full suite 65/65 FULL; typecheck clean.

- [ ] **Step 6: Commit** — `refactor: componentId hardening — frozen KINDS, pinned degenerate parse, accessorIdsFor`

---

## Self-review record

- Task 1's new entry point is byte-for-byte the old read+clone composition (same copy depth, same
  null policy, same counters), so behaviour outside the retired exports is unchanged; the suite's
  signature/archive gates plus G5 cover it.
- Task 2's helper guard deliberately does NOT parse (documented in both the test and the code) —
  the `prop_Data_get` case in the test is the reason, and it is the same trap Phase 1 paid for.
- The two tasks share no files; either can land first, but execute in order for ledger clarity.
