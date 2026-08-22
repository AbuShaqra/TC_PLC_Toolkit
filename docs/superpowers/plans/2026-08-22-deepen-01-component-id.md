# Phase 1: Component-Id Grammar Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** One vscode-free module (`src/componentId.js`) owns the component-id string grammar that
today exists as string literals and four disagreeing regexes across three processes — fixing the
confirmed bug where a Transition renders as raw `transition_Ready` in the References view and peek
path.

**Architecture:** `src/xmlParser.js` is the minting truth (`root`, `prop_X`, `prop_X_get`,
`prop_X_set`, `method_X`, `action_X`, `transition_X`). The new module freezes exactly that grammar
— ids reach the LSP protocol and saved state, so **this phase changes who owns the grammar, never
the grammar** — and every mint/parse site converts to it. `media/editor.js` only
encodes/decodes ids opaquely (verified: `encodeURIComponent` at :946/:1004, decode at :979/:1041;
no prefix parse), so the webview is out of scope and no browser-harness run is required.

**Tech Stack:** Plain CommonJS, `test/run.js` harnesses, `tsc --noEmit` gate.

**Spec:** `docs/superpowers/plans/2026-08-22-deepening-roadmap.md` (Phase 1 section) — itself
condensed from the 2026-08-22 architecture review artifact.

## Global Constraints

- No build step; everything plain CommonJS, require()-able from host and LSP processes alike.
- **The minted id strings are frozen byte-for-byte.** The conformance test (Task 1) is the proof.
- Diagnostics ratchet stays at zero (`REQUIRE_FULL_SUITE=1 npm test` → FULL, all green).
- `npm run typecheck` stays clean; new code carries JSDoc like its neighbours.
- No behaviour change anywhere except the two named bug sites (transition label, transition peek
  path).
- Match surrounding code style: JSDoc headers, 4-space indent, no new dependencies.
- The dev-host gate (G4) cannot run in this container (no VS Code); it is deferred to the user's
  machine and recorded in HANDOFF at phase end.

## The frozen grammar (reference for every task)

Minted by `src/xmlParser.js` (`id:` sites at :73, :105, :130, :156, :178):

| id shape | meaning |
|---|---|
| `root` | the root POU/GVL/DUT component |
| `method_<name>` | Method (name may itself contain `_`, e.g. `method_do_stuff`) |
| `prop_<name>` | Property signature |
| `prop_<name>_get` / `prop_<name>_set` | the property's Get/Set accessor |
| `action_<name>` | Action |
| `transition_<name>` | Transition |

Prefixes are lowercase (minted via `subType.toLowerCase()`), matching is case-sensitive (as
`dndRules.js` already does). **Known, deliberate ambiguity:** `prop_X_get` could denote a property
named `X_get`; every existing consumer (`dndRules.js:75`, `clipboardCommands.js:77`,
`referencesTree.js:17`) already resolves it as *accessor of X* — the owner module pins that
convention, it does not invent it.

---

### Task 1: `src/componentId.js` + conformance test

**Files:**
- Create: `src/componentId.js`
- Create: `test/test_component_id.js`

**Interfaces:**
- Consumes: `parseTwinCatXml` from `src/xmlParser.js` (test only).
- Produces (later tasks rely on these exact signatures):
  - `make(kind, name, accessor) → string` — `kind` ∈ `'root'|'method'|'prop'|'action'|'transition'`; `accessor` ∈ `'get'|'set'|null`, valid only with `kind:'prop'`; throws `Error` on an invalid combination (programmer error, not data).
  - `parse(id) → {kind, name, accessor} | null` — `null` for anything outside the grammar; `{kind:'root', name:null, accessor:null}` for `'root'`.
  - `isAccessor(id) → boolean`
  - `label(id) → string` — display name: `root`/empty → `'Main'`; method → `name + '()'`; prop/accessor → property name; action/transition → name; unknown id → the id unchanged (current `componentLabel` fallback, preserved).
  - `memberName(id) → string` — peek-path segment: `root` → `'root'`; accessor → `name_accessor` (preserves today's `Foo_get`); others → name; unknown → id unchanged.
  - `KIND_TO_XML_TAG` — `{ method:'Method', prop:'Property', action:'Action', transition:'Transition' }` (frozen object).

- [ ] **Step 1: Write the failing test**

`test/test_component_id.js` (follow the harness pattern of `test/test_editor_mapping.js`: plain
asserts, `process.exitCode` on failure, `test/_coverage.js` not needed — this is not a gated
fixture suite):

```js
/**
 * @file test_component_id.js
 * @description The component-id grammar owner: make/parse round-trips, the frozen minted
 * shapes (driven through the REAL parseTwinCatXml), and the consumer-facing helpers.
 */
const assert = require('assert');
const { parseTwinCatXml } = require('../src/xmlParser');
const cid = require('../src/componentId');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`[PASS] ${name}`); }
    catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failures++; }
}

// --- Conformance: every shape the real parser mints round-trips through parse/make ---
const FIXTURE_XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_Fixture" Id="{11111111-1111-1111-1111-111111111111}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Fixture
VAR
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[;]]></ST>
    </Implementation>
    <Method Name="do_stuff" Id="{22222222-2222-2222-2222-222222222222}">
      <Declaration><![CDATA[METHOD do_stuff : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[;]]></ST>
      </Implementation>
    </Method>
    <Property Name="Speed" Id="{33333333-3333-3333-3333-333333333333}">
      <Declaration><![CDATA[PROPERTY Speed : INT]]></Declaration>
      <Get Name="Get" Id="{44444444-4444-4444-4444-444444444444}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[Speed := 1;]]></ST>
        </Implementation>
      </Get>
      <Set Name="Set" Id="{55555555-5555-5555-5555-555555555555}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[;]]></ST>
        </Implementation>
      </Set>
    </Property>
    <Action Name="Reset" Id="{66666666-6666-6666-6666-666666666666}">
      <Implementation>
        <ST><![CDATA[;]]></ST>
      </Implementation>
    </Action>
    <Transition Name="Ready" Id="{77777777-7777-7777-7777-777777777777}">
      <Implementation>
        <ST><![CDATA[TRUE]]></ST>
      </Implementation>
    </Transition>
  </POU>
</TcPlcObject>`;

check('fixture parses and mints every id shape', () => {
    const parsed = parseTwinCatXml(FIXTURE_XML);
    assert.ok(parsed, 'parseTwinCatXml returned null for the fixture');
    const ids = parsed.components.map(c => c.id);
    for (const expected of ['root', 'method_do_stuff', 'prop_Speed', 'prop_Speed_get',
                            'prop_Speed_set', 'action_Reset', 'transition_Ready']) {
        assert.ok(ids.includes(expected), `minted ids missing ${expected} (got: ${ids.join(', ')})`);
    }
    for (const id of ids) {
        const p = cid.parse(id);
        assert.ok(p, `parse(${id}) returned null on a minted id`);
        const remade = p.kind === 'root' ? 'root' : cid.make(p.kind, p.name, p.accessor);
        assert.strictEqual(remade, id, `round trip broke: ${id} -> ${remade}`);
    }
});

// --- parse: the frozen table ---
check('parse table', () => {
    assert.deepStrictEqual(cid.parse('root'), { kind: 'root', name: null, accessor: null });
    assert.deepStrictEqual(cid.parse('method_do_stuff'), { kind: 'method', name: 'do_stuff', accessor: null });
    assert.deepStrictEqual(cid.parse('prop_Speed'), { kind: 'prop', name: 'Speed', accessor: null });
    assert.deepStrictEqual(cid.parse('prop_Speed_get'), { kind: 'prop', name: 'Speed', accessor: 'get' });
    assert.deepStrictEqual(cid.parse('prop_Speed_set'), { kind: 'prop', name: 'Speed', accessor: 'set' });
    assert.deepStrictEqual(cid.parse('action_Reset'), { kind: 'action', name: 'Reset', accessor: null });
    assert.deepStrictEqual(cid.parse('transition_Ready'), { kind: 'transition', name: 'Ready', accessor: null });
    // The pinned ambiguity convention: accessor wins (matches dndRules/clipboard/referencesTree).
    assert.deepStrictEqual(cid.parse('prop_X_get'), { kind: 'prop', name: 'X', accessor: 'get' });
    // Outside the grammar:
    assert.strictEqual(cid.parse('trans_Ready'), null);
    assert.strictEqual(cid.parse('Method_Init'), null);   // prefixes are lowercase, case-sensitive
    assert.strictEqual(cid.parse('method_'), null);        // empty name is not a component
    assert.strictEqual(cid.parse(''), null);
    assert.strictEqual(cid.parse(null), null);
});

// --- make: valid combinations + programmer-error guard ---
check('make', () => {
    assert.strictEqual(cid.make('method', 'do_stuff'), 'method_do_stuff');
    assert.strictEqual(cid.make('prop', 'Speed'), 'prop_Speed');
    assert.strictEqual(cid.make('prop', 'Speed', 'get'), 'prop_Speed_get');
    assert.strictEqual(cid.make('transition', 'Ready'), 'transition_Ready');
    assert.strictEqual(cid.make('root'), 'root');
    assert.throws(() => cid.make('method', 'X', 'get'), /accessor/);
    assert.throws(() => cid.make('bogus', 'X'), /kind/);
    assert.throws(() => cid.make('method', ''), /name/);
});

// --- consumer helpers ---
check('isAccessor', () => {
    assert.strictEqual(cid.isAccessor('prop_Speed_get'), true);
    assert.strictEqual(cid.isAccessor('prop_Speed_set'), true);
    assert.strictEqual(cid.isAccessor('prop_Speed'), false);
    assert.strictEqual(cid.isAccessor('method_get_thing'), false);
    assert.strictEqual(cid.isAccessor('root'), false);
});
check('label — including the transition fix', () => {
    assert.strictEqual(cid.label('root'), 'Main');
    assert.strictEqual(cid.label(''), 'Main');
    assert.strictEqual(cid.label('method_Cyclic'), 'Cyclic()');
    assert.strictEqual(cid.label('prop_Speed'), 'Speed');
    assert.strictEqual(cid.label('prop_Speed_get'), 'Speed');
    assert.strictEqual(cid.label('action_Reset'), 'Reset');
    assert.strictEqual(cid.label('transition_Ready'), 'Ready');   // THE BUG: was 'transition_Ready'
    assert.strictEqual(cid.label('weird_thing'), 'weird_thing');  // preserved fallback
});
check('memberName — including the transition fix', () => {
    assert.strictEqual(cid.memberName('root'), 'root');
    assert.strictEqual(cid.memberName('method_Cyclic'), 'Cyclic');
    assert.strictEqual(cid.memberName('prop_Speed_get'), 'Speed_get'); // preserves today's peek path
    assert.strictEqual(cid.memberName('transition_Ready'), 'Ready');   // THE BUG: was 'transition_Ready'
    assert.strictEqual(cid.memberName('weird_thing'), 'weird_thing');
});
check('KIND_TO_XML_TAG', () => {
    assert.deepStrictEqual(cid.KIND_TO_XML_TAG,
        { method: 'Method', prop: 'Property', action: 'Action', transition: 'Transition' });
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/test_component_id.js`
Expected: FAIL — `Cannot find module '../src/componentId'`.

- [ ] **Step 3: Implement `src/componentId.js`**

```js
/**
 * @file componentId.js
 * @description The single owner of the component-id string grammar (`root`, `method_X`,
 * `prop_X`, `prop_X_get`, `prop_X_set`, `action_X`, `transition_X`) shared by the webview,
 * the extension host and the LSP server. vscode-free so all three can require it.
 *
 * The grammar is FROZEN: ids travel over the LSP bridge and into saved workbench state, so
 * this module reproduces exactly what xmlParser.js has always minted — byte for byte.
 * Deliberate ambiguity, pinned here because every consumer already resolved it this way:
 * `prop_X_get` parses as the Get accessor of property X, never as a property named `X_get`.
 */

/** Component kinds, in minted spelling. `root` has no name; only `prop` takes an accessor. */
const KINDS = ['root', 'method', 'prop', 'action', 'transition'];

/** Kind → the TwinCAT XML tag that holds that component (root and accessors excluded). */
const KIND_TO_XML_TAG = Object.freeze({
    method: 'Method', prop: 'Property', action: 'Action', transition: 'Transition'
});

const ACCESSOR_RE = /^prop_(.+)_(get|set)$/;
const KIND_RE = /^(method|prop|action|transition)_(.+)$/;

/**
 * Builds a component id. Throws on invalid combinations — bad input here is a programmer
 * error, not user data.
 * @param {'root'|'method'|'prop'|'action'|'transition'} kind
 * @param {string} [name] Required for every kind except 'root'.
 * @param {'get'|'set'|null} [accessor] Only valid with kind 'prop'.
 * @returns {string}
 */
function make(kind, name, accessor) {
    if (!KINDS.includes(kind)) throw new Error(`componentId.make: unknown kind '${kind}'`);
    if (kind === 'root') return 'root';
    if (!name) throw new Error('componentId.make: name is required');
    if (accessor) {
        if (kind !== 'prop') throw new Error('componentId.make: accessor is only valid on prop');
        if (accessor !== 'get' && accessor !== 'set') {
            throw new Error(`componentId.make: unknown accessor '${accessor}'`);
        }
        return `prop_${name}_${accessor}`;
    }
    return `${kind}_${name}`;
}

/**
 * Parses a component id. Returns null for anything outside the grammar (matching is
 * case-sensitive: mint sites always produce lowercase prefixes).
 * @param {string|null|undefined} id
 * @returns {{kind: string, name: string|null, accessor: string|null}|null}
 */
function parse(id) {
    if (typeof id !== 'string' || id === '') return null;
    if (id === 'root') return { kind: 'root', name: null, accessor: null };
    const acc = ACCESSOR_RE.exec(id);
    if (acc) return { kind: 'prop', name: acc[1], accessor: acc[2] };
    const m = KIND_RE.exec(id);
    if (m) return { kind: m[1], name: m[2], accessor: null };
    return null;
}

/** @param {string|null|undefined} id @returns {boolean} True for a Get/Set accessor id. */
function isAccessor(id) {
    const p = parse(id);
    return !!(p && p.accessor);
}

/**
 * Display label: 'Main' for root/empty, `name()` for a method, the property name for a
 * property or its accessor, the bare name otherwise. Unknown ids pass through unchanged
 * (the References view's long-standing fallback).
 * @param {string|null|undefined} id @returns {string}
 */
function label(id) {
    if (!id || id === 'root') return 'Main';
    const p = parse(id);
    if (!p) return id;
    if (p.kind === 'method') return `${p.name}()`;
    return p.name;
}

/**
 * The member segment used in synthetic peek-model paths: `root` for the root panes,
 * `Name_get`/`Name_set` for accessors (today's path shape, preserved), the bare name
 * otherwise. Unknown ids pass through unchanged.
 * @param {string|null|undefined} id @returns {string}
 */
function memberName(id) {
    if (!id || id === 'root') return 'root';
    const p = parse(id);
    if (!p) return id;
    if (p.accessor) return `${p.name}_${p.accessor}`;
    return p.name;
}

module.exports = { KINDS, KIND_TO_XML_TAG, make, parse, isAccessor, label, memberName };
```

- [ ] **Step 4: Run the test — all green**

Run: `node test/test_component_id.js` → `ALL PASS`, exit 0.

- [ ] **Step 5: Register visibility + gates**

`test/run.js` discovers `test/test_*.js` automatically — verify with `node test/run.js component`
(one suite, green). Then `npm run typecheck` (clean).

- [ ] **Step 6: Commit**

```bash
git add src/componentId.js test/test_component_id.js
git commit -m "feat(lsp): componentId.js owns the component-id grammar"
```

---

### Task 2: Convert the LSP mint/parse sites

**Files:**
- Modify: `src/lsp/features/core.js:86–92` (3 mint sites)
- Modify: `src/lsp/features/definition.js:156,171,235,244,247,250,260,263,266` (9 mint sites)
- Modify: `src/lsp/features/references.js:132–134,144` (2 parse sites)

**Interfaces:**
- Consumes: `make`, `parse` from Task 1 (`require('../../componentId')` from `features/`).
- Produces: byte-identical LSP responses (the suite is the proof).

- [ ] **Step 1: Convert the mint sites**

Mechanical substitution, e.g. in `core.js:86`:

```js
// before
if (m) return { uri: owner.uri, range: convertToLspRange(m.nameRange), componentId: `method_${m.name}` };
// after
if (m) return { uri: owner.uri, range: convertToLspRange(m.nameRange), componentId: cidMake('method', m.name) };
```

with `const { make: cidMake, parse: cidParse } = require('../../componentId');` at the top of each
file (match the file's existing require style). Same shape for every `prop_${...}` → `cidMake('prop', ...)`
and `action_${...}` → `cidMake('action', ...)` site.

- [ ] **Step 2: Convert the parse sites in `references.js`**

```js
// before (:132-134)
if (pou && typeof def.componentId === 'string' && def.componentId.startsWith('method_')) {
    const methodName = def.componentId.slice('method_'.length).toLowerCase();
// after
const defCid = cidParse(def.componentId);
if (pou && defCid && defCid.kind === 'method') {
    const methodName = defCid.name.toLowerCase();
```

and at `:144` replace the `startsWith('method_')` test with the same parsed `kind === 'method'`
check (parse once per function, not per condition).

- [ ] **Step 3: Run the covering suites**

Run: `node test/run.js references && node test/run.js lsp_features && node test/run.js live`
Expected: all green (no behaviour change — identical strings minted).

- [ ] **Step 4: Full gates**

Run: `REQUIRE_FULL_SUITE=1 npm test && npm run typecheck` → FULL, green, clean.

- [ ] **Step 5: Commit**

```bash
git add src/lsp/features/core.js src/lsp/features/definition.js src/lsp/features/references.js
git commit -m "refactor(lsp): mint and parse component ids through componentId.js"
```

---

### Task 3: Fix the two broken consumers (the user-visible bug)

**Files:**
- Modify: `src/referencesTree.js:13–21` (`componentLabel`)
- Modify: `src/editorMapping.js:38–45` (`peekPath`)
- Test: `test/test_references_tree.js`, `test/test_editor_mapping.js` (add transition cases)

**Interfaces:**
- Consumes: `label`, `memberName` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `test/test_references_tree.js` (match its existing assert style):

```js
// Transition components must label like actions do — the raw-id fallback was the bug.
assert.strictEqual(componentLabel('transition_Ready'), 'Ready',
    'a Transition must display its name, not its raw id');
```

Append to `test/test_editor_mapping.js`:

```js
// A transition peek path carries the member name, not the raw id (trans_ never matched transition_).
assert.ok(peekPath('file:///c%3A/x/FB_A.TcPOU', 'transition_Ready', 'impl').startsWith('/Ready.impl/'),
    'transition peek path must strip the kind prefix');
```

- [ ] **Step 2: Run both — verify they fail**

Run: `node test/test_references_tree.js && node test/test_editor_mapping.js`
Expected: both FAIL on the new assertions (label returns `transition_Ready`; path starts
`/transition_Ready.impl/`).

- [ ] **Step 3: Convert both functions**

`src/referencesTree.js` — `componentLabel` becomes a delegation (keep the exported name; the
References view and its harness use it):

```js
const { label: componentIdLabel } = require('./componentId');

/**
 * Humanizes a component id for display (e.g. 'method_cyclic' -> 'cyclic()', 'root' -> 'Main').
 * Delegates to the grammar owner in componentId.js.
 * @param {string} componentId
 * @returns {string}
 */
function componentLabel(componentId) {
    return componentIdLabel(componentId);
}
```

`src/editorMapping.js` — `peekPath` uses `memberName` instead of its private (and wrong) regex:

```js
const { memberName } = require('./componentId');

function peekPath(fileUri, componentId, pane) {
    let base = 'object';
    try { base = fileUriBasename(fileUri) || base; } catch (e) { /* keep default */ }
    return `/${memberName(componentId)}.${pane}/${base}`;
}
```

- [ ] **Step 4: Run the tests — green — then the full gates**

Run: `node test/test_references_tree.js && node test/test_editor_mapping.js` → all PASS.
Run: `REQUIRE_FULL_SUITE=1 npm test && npm run typecheck` → FULL, green, clean.
(If an existing assertion pinned the OLD broken output, that assertion pinned the bug — update it
and say so in the report.)

- [ ] **Step 5: Commit**

```bash
git add src/referencesTree.js src/editorMapping.js test/test_references_tree.js test/test_editor_mapping.js
git commit -m "fix: transitions display their name in the References view and peek path"
```

---

### Task 4: Convert the remaining host-side consumers, retire the private copies

**Files:**
- Modify: `src/xmlParser.js:73,105,130,156,178` (mint through `make`)
- Modify: `src/dndRules.js:41–51,67–86` (drop `COMPONENT_ID_TAGS` + the accessor regex)
- Modify: `src/commands/clipboardCommands.js:77` (accessor regex → `isAccessor`)
- Modify: `src/treeDataProvider.js:543–544` (id concatenation → `make`)

**Interfaces:**
- Consumes: `make`, `parse`, `isAccessor`, `KIND_TO_XML_TAG` from Task 1.

- [ ] **Step 1: Convert `xmlParser.js` mint sites**

`const { make: makeComponentId } = require('./componentId');` and:
`'root'` → `makeComponentId('root')`; `` `prop_${subName}` `` → `makeComponentId('prop', subName)`;
`` `prop_${subName}_get` `` → `makeComponentId('prop', subName, 'get')` (same for `_set`);
`` `${subType.toLowerCase()}_${subName}` `` → `makeComponentId(/** @type {any} */ (subType.toLowerCase()), subName)` —
subType here is always `Method`/`Action`/`Transition` (the enclosing regex guarantees it), note
that in a comment only if the typechecker needs the cast.

- [ ] **Step 2: Convert `dndRules.js`**

Replace `COMPONENT_ID_TAGS` and the inline regex with the owner:

```js
const { parse: parseComponentId, isAccessor, KIND_TO_XML_TAG } = require('./componentId');
```

and inside `describeDragged` (the `component`/`propertyNode` branch):

```js
if (cv === 'component' || cv === 'propertyNode') {
    const id = item.componentId || '';
    // Get/Set accessors live inside the property's tag and move with it.
    if (isAccessor(id)) return null;
    const p = parseComponentId(id);
    if (p && p.kind !== 'root') {
        return {
            kind: 'component',
            uri: item.resourceUri,
            componentType: /** @type {'Method'|'Property'|'Action'|'Transition'} */ (KIND_TO_XML_TAG[p.kind]),
            componentName: p.name
        };
    }
    return null;
}
```

Preserve the function's surrounding logic and doc comments; only the id mechanics change.
`describeCopied` gets the same treatment if it carries its own copy of either pattern.

- [ ] **Step 3: Convert `clipboardCommands.js:77` and `treeDataProvider.js:543–544`**

```js
// clipboardCommands.js: before
const isAccessor = /^prop_.+_(get|set)$/.test(node.componentId || '');
// after (rename the local, the module function takes the name)
const accessor = componentIdIsAccessor(node.componentId || '');
```

```js
// treeDataProvider.js: before
const getAcc = parsedComponents.find(x => x.id === `${c.id}_get`);
const setAcc = parsedComponents.find(x => x.id === `${c.id}_set`);
// after — mint the accessor ids properly instead of string-concatenating on another id
const propName = (parseComponentId(c.id) || {}).name;
const getAcc = propName ? parsedComponents.find(x => x.id === makeComponentId('prop', propName, 'get')) : null;
const setAcc = propName ? parsedComponents.find(x => x.id === makeComponentId('prop', propName, 'set')) : null;
```

- [ ] **Step 4: Verify no grammar knowledge survives outside the owner**

Run: `grep -rnE "(method|prop|action|transition|trans)_\\$|prop_\\.\\+_|COMPONENT_ID_TAGS|(method\\|prop\\|action)" src/ --include='*.js' | grep -v componentId.js`
Expected: no line that mints or parses a component id remains (hits inside comments or unrelated
identifiers are fine — judge each survivor and list them in the report).

- [ ] **Step 5: Full gates**

Run: `REQUIRE_FULL_SUITE=1 npm test && npm run typecheck` → FULL, green, clean. The dnd/clipboard
matrices are pinned by `test_dnd_rules` and `test_xml_clipboard`; the tree by `test_tree_reveal`.

- [ ] **Step 6: Commit**

```bash
git add src/xmlParser.js src/dndRules.js src/commands/clipboardCommands.js src/treeDataProvider.js
git commit -m "refactor: all component-id minting and parsing goes through componentId.js"
```

---

## Self-review record

- **Coverage vs roadmap Phase 1:** owner module ✓ (T1), conformance test ✓ (T1), consumer
  conversion ✓ (T2–T4), bug fix ✓ (T3), webview checked and excluded with evidence ✓ (header).
- **Types/names:** `make/parse/isAccessor/label/memberName/KIND_TO_XML_TAG` used identically in
  all four tasks.
- **G4 (dev host)** cannot run in this container — deferred to the user's machine, recorded in
  HANDOFF at phase end (References-view transition labels are covered headlessly by the new
  `test_references_tree` assertions; the dev-host pass is confirmation, not the only gate).
