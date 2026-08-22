/**
 * @file test_live_path_unit.js
 * @description Unit tests for the pure collectors in livePath.js — mapDefinition,
 * collectPeekReferences, listExternalReferences — against synthetic in-memory fixtures (no sample/
 * dependency, no vscode). Pins the budget semantics that are otherwise only prose: PEEK_MAX_PANES and
 * the text-byte budget bound FILE READS and PANE MODELS, never the mapped references themselves — a
 * ref into an already-opened file still maps past the pane cap, and a pane over budget is skipped but
 * its reference still maps.
 */

const assert = require('assert');
const { parseTwinCatXml } = require('../src/xmlParser');
const { normalizeFileUri } = require('../src/fileUri');
const {
    assembleSt, localToAbsolute, absoluteToLocal, createStResolver,
    mapDefinition, collectPeekReferences, listExternalReferences
} = require('../src/livePath');

let failures = 0;
const checks = [];
/**
 * Registers a (possibly async) test case; run in order by the runner at the bottom of the file.
 * @param {string} name Test title.
 * @param {Function} fn Test body, sync or async.
 */
function check(name, fn) {
    checks.push({ name, fn });
}

// --- Synthetic fixtures -------------------------------------------------------------------------
// FB_A: the "active" file — a single root component, decl + impl one line each.
const XML_A = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_A" Id="{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_A
VAR
    nVal : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[nVal := nVal + 1;]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;

// FB_B: two methods (DoIt, Other) so refs can land in two different (component, pane) pairs of the
// SAME file — the fixture the pane-dedupe and "already-read file past the cap" tests need.
const XML_B = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_B" Id="{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_B
VAR
    nCount : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[;]]></ST>
    </Implementation>
    <Method Name="DoIt" Id="{bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb}">
      <Declaration><![CDATA[METHOD DoIt : BOOL
VAR
END_VAR]]></Declaration>
      <Implementation>
        <ST><![CDATA[nCount := nCount + 1;
nCount := nCount + 2;]]></ST>
      </Implementation>
    </Method>
    <Method Name="Other" Id="{bbbbbbbb-0002-0002-0002-bbbbbbbbbbbb}">
      <Declaration><![CDATA[METHOD Other : BOOL
VAR
END_VAR]]></Declaration>
      <Implementation>
        <ST><![CDATA[nCount := 0;]]></ST>
      </Implementation>
    </Method>
  </POU>
</TcPlcObject>`;

// FB_C: minimal third file, used only as "the second file that must never be read".
const XML_C = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_C" Id="{cccccccc-cccc-cccc-cccc-cccccccccccc}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_C
VAR
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[;]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;

const URI_A = 'file:///tmp/livepath-unit/FB_A.TcPOU';
const URI_B = 'file:///tmp/livepath-unit/FB_B.TcPOU';
const URI_C = 'file:///tmp/livepath-unit/FB_C.TcPOU';
const URI_MISSING = 'file:///tmp/livepath-unit/FB_Missing.TcPOU';

const unitA = assembleSt(XML_A, null);
const unitB = assembleSt(XML_B, null);
const unitC = assembleSt(XML_C, null);
assert.ok(unitA && unitB && unitC, 'fixture setup: all three synthetic units must assemble');

/**
 * Builds a { readFile, countFor } test double backed by a Map of normalized-uri -> xml text.
 * Counts calls per normalized uri so budget tests can assert exactly which files were opened.
 * Throws (like a real ENOENT) for any uri not in the map, mirroring vscode.workspace.fs.readFile.
 * @param {Object<string,string>} filesByUri uri -> xml text.
 * @returns {Function} async readFile(uri) with a `.countFor(uri)` helper attached.
 */
function makeCountingReadFile(filesByUri) {
    const files = new Map();
    for (const uri of Object.keys(filesByUri)) files.set(normalizeFileUri(uri), filesByUri[uri]);
    const counts = new Map();
    async function readFile(uri) {
        const key = normalizeFileUri(uri);
        counts.set(key, (counts.get(key) || 0) + 1);
        if (!files.has(key)) throw new Error('ENOENT (synthetic): ' + uri);
        return files.get(key);
    }
    readFile.countFor = (uri) => counts.get(normalizeFileUri(uri)) || 0;
    return readFile;
}

/**
 * Locates the 0-based local line of the first line matching `re` in a pane's raw text, via the
 * REAL component extraction (parseTwinCatXml), so fixture line numbers are never hand-counted.
 * @param {string} xml Source XML.
 * @param {string} componentId Component id.
 * @param {string} pane 'decl' | 'impl'.
 * @param {RegExp} re Pattern identifying the target line.
 * @returns {number} 0-based local line index.
 */
function localLineOf(xml, componentId, pane, re) {
    const parsed = parseTwinCatXml(xml);
    const comp = parsed.components.find(c => c.id === componentId);
    const text = pane === 'decl' ? comp.declaration : comp.implementation;
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex(l => re.test(l));
    assert.ok(idx !== -1, `fixture: pattern ${re} not found in ${componentId}/${pane}`);
    return idx;
}

/**
 * Builds an LSP-shaped reference/definition location from known LOCAL coordinates, going through
 * the real localToAbsolute — the same translation the extension host performs — so the absolute
 * line handed to the collector is never a hand-typed number.
 * @param {string} uri Target file uri.
 * @param {Object} lineMap The unit's lineMap.
 * @param {string} componentId Component id.
 * @param {string} pane 'decl' | 'impl'.
 * @param {number} localLine0 0-based local line.
 * @param {number} startCol0 0-based start character.
 * @param {number} endCol0 0-based end character.
 * @returns {Object} { uri, range: { start: {line, character}, end: {character} } }
 */
function makeLoc(uri, lineMap, componentId, pane, localLine0, startCol0, endCol0) {
    const abs = localToAbsolute(lineMap, componentId, pane, localLine0 + 1, startCol0 + 1);
    assert.ok(abs, `fixture: localToAbsolute failed for ${componentId}/${pane}:${localLine0}`);
    return { uri, range: { start: { line: abs.line, character: startCol0 }, end: { character: endCol0 } } };
}

// ==================================================================================================
// 1. mapDefinition
// ==================================================================================================
check('mapDefinition augments with (componentId, pane, localLine) agreeing with absoluteToLocal', async () => {
    const readFile = makeCountingReadFile({ [URI_B]: XML_B });
    const resolveSt = createStResolver({ activeUri: URI_A, activeUnit: unitA, readFile });

    const localLine0 = localLineOf(XML_B, 'method_DoIt', 'impl', /nCount := nCount \+ 1/);
    const def = makeLoc(URI_B, unitB.lineMap, 'method_DoIt', 'impl', localLine0, 0, 7);

    const result = await mapDefinition(def, resolveSt);
    const expected = absoluteToLocal(unitB.lineMap, def.range.start.line);

    assert.strictEqual(result.componentId, expected.componentId, 'componentId matches absoluteToLocal');
    assert.strictEqual(result.pane, expected.pane, 'pane matches absoluteToLocal');
    assert.strictEqual(result.localLine, expected.localLine0, 'localLine matches absoluteToLocal');
    assert.strictEqual(result.componentId, 'method_DoIt');
    assert.strictEqual(result.pane, 'impl');
    assert.strictEqual(result.localLine, localLine0);
    // Original fields survive untouched.
    assert.strictEqual(result.uri, URI_B);
    assert.strictEqual(readFile.countFor(URI_B), 1, 'exactly one read for the one definition target');
});

check('mapDefinition passes through an unresolvable/missing definition unchanged', async () => {
    const readFile = makeCountingReadFile({});
    const resolveSt = createStResolver({ activeUri: URI_A, activeUnit: unitA, readFile });
    assert.strictEqual(await mapDefinition(null, resolveSt), null, 'null definition passes through');
    const partial = { uri: URI_B }; // no .range
    assert.strictEqual(await mapDefinition(partial, resolveSt), partial, 'a definition missing .range passes through unchanged');
});

// ==================================================================================================
// 2. collectPeekReferences — active-file ref needs no read, and reports sameFile: true
// ==================================================================================================
check('a reference in the active file uses the active unit (no read) and is sameFile: true', async () => {
    const readFile = makeCountingReadFile({ [URI_A]: XML_A }); // present, but must never be hit
    const resolveSt = createStResolver({ activeUri: URI_A, activeUnit: unitA, readFile });
    const localLine0 = localLineOf(XML_A, 'root', 'impl', /nVal := nVal \+ 1/);
    const ref = makeLoc(URI_A, unitA.lineMap, 'root', 'impl', localLine0, 0, 4);

    const { references, panes } = await collectPeekReferences([ref], { activeUri: URI_A, resolveSt });

    assert.strictEqual(readFile.countFor(URI_A), 0, 'the active file is never read from disk');
    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].sameFile, true, 'a ref in the active file is sameFile: true');
    assert.strictEqual(references[0].componentId, 'root');
    assert.strictEqual(references[0].pane, 'impl');
    assert.strictEqual(references[0].line, localLine0);
    assert.strictEqual(panes.length, 1, 'the active file still gets a pane entry like any other');
});

// ==================================================================================================
// 3. Pane dedupe — two refs into the same (file, component, pane) => one pane entry, two refs
// ==================================================================================================
check('two references into the same (file, component, pane) dedupe to one pane entry', async () => {
    const readFile = makeCountingReadFile({ [URI_B]: XML_B });
    const resolveSt = createStResolver({ activeUri: URI_A, activeUnit: unitA, readFile });
    const line0 = localLineOf(XML_B, 'method_DoIt', 'impl', /nCount := nCount \+ 1/);
    const line1 = localLineOf(XML_B, 'method_DoIt', 'impl', /nCount := nCount \+ 2/);
    const refA = makeLoc(URI_B, unitB.lineMap, 'method_DoIt', 'impl', line0, 0, 7);
    const refB = makeLoc(URI_B, unitB.lineMap, 'method_DoIt', 'impl', line1, 0, 7);

    const { references, panes } = await collectPeekReferences([refA, refB], { activeUri: URI_A, resolveSt });

    assert.strictEqual(references.length, 2, 'both references map');
    assert.strictEqual(panes.length, 1, 'one pane entry for the shared (file, component, pane)');
    assert.strictEqual(references[0].paneKey, references[1].paneKey, 'both references share the pane key');
    assert.strictEqual(panes[0].key, references[0].paneKey, 'the pane entry key matches the references’ paneKey');
    assert.strictEqual(readFile.countFor(URI_B), 1, 'the file is opened once regardless of hit count');
});

// ==================================================================================================
// 4. maxPanes budget bounds FILE READS and PANES, not mapped references
// ==================================================================================================
check('maxPanes: 1 bounds file reads — the second file is never opened, its refs are absent', async () => {
    const readFile = makeCountingReadFile({ [URI_B]: XML_B, [URI_C]: XML_C });
    const resolveSt = createStResolver({ activeUri: URI_A, activeUnit: unitA, readFile });
    const doItLine = localLineOf(XML_B, 'method_DoIt', 'impl', /nCount := nCount \+ 1/);
    const otherLine = localLineOf(XML_B, 'method_Other', 'impl', /nCount := 0/);
    const cLine = localLineOf(XML_C, 'root', 'impl', /;/);

    const refB1 = makeLoc(URI_B, unitB.lineMap, 'method_DoIt', 'impl', doItLine, 0, 7);   // first: opens file B, fills the one pane slot
    const refB2 = makeLoc(URI_B, unitB.lineMap, 'method_Other', 'impl', otherLine, 0, 7); // second: same (already-read) file, different pane -> past cap
    const refC = makeLoc(URI_C, unitC.lineMap, 'root', 'impl', cLine, 0, 1);              // third: a NEW file -> must never be opened

    const { references, panes } = await collectPeekReferences([refB1, refB2, refC], {
        activeUri: URI_A, resolveSt, maxPanes: 1
    });

    assert.strictEqual(readFile.countFor(URI_C), 0, 'the second file is never read once the pane cap is hit');
    assert.strictEqual(readFile.countFor(URI_B), 1, 'the already-open file is read exactly once');
    assert.strictEqual(panes.length, 1, 'only the first pane slot is filled');

    assert.strictEqual(references.length, 2, 'both refs into the already-read file still map; the new file’s ref does not');
    assert.ok(references.some(r => r.componentId === 'method_DoIt'), 'first ref (its own pane) maps');
    assert.ok(references.some(r => r.componentId === 'method_Other'), 'second ref (past the pane cap, same file) STILL maps');
    assert.ok(!references.some(r => r.uri === URI_C), 'the ref into the never-opened file is absent');
    // The second ref's pane key differs from the first (different component) and has no pane entry.
    const otherRef = references.find(r => r.componentId === 'method_Other');
    assert.ok(!panes.some(p => p.key === otherRef.paneKey), 'the past-cap pane key has no pane entry');
});

// ==================================================================================================
// 5. maxTextBytes budget — pane skipped, reference still maps
// ==================================================================================================
check('maxTextBytes smaller than the pane text skips the pane but the reference still maps', async () => {
    const readFile = makeCountingReadFile({ [URI_B]: XML_B });
    const resolveSt = createStResolver({ activeUri: URI_A, activeUnit: unitA, readFile });
    const line0 = localLineOf(XML_B, 'method_DoIt', 'impl', /nCount := nCount \+ 1/);
    const ref = makeLoc(URI_B, unitB.lineMap, 'method_DoIt', 'impl', line0, 0, 7);

    const { references, panes } = await collectPeekReferences([ref], {
        activeUri: URI_A, resolveSt, maxTextBytes: 1 // impl pane text is well over 1 byte
    });

    assert.strictEqual(panes.length, 0, 'no pane entry — the text exceeds the byte budget');
    assert.strictEqual(references.length, 1, 'the reference still maps');
    assert.strictEqual(references[0].componentId, 'method_DoIt');
    assert.ok(references[0].paneKey, 'the reference still carries its paneKey even with no pane entry');
});

// ==================================================================================================
// 6. listExternalReferences
// ==================================================================================================
check('listExternalReferences: item fields, searchedWord from the first ref, unreadable uri skipped', async () => {
    const readFile = makeCountingReadFile({ [URI_B]: XML_B }); // URI_MISSING deliberately absent
    const resolveSt = createStResolver({ activeUri: URI_A, activeUnit: unitA, readFile });
    const line0 = localLineOf(XML_B, 'method_DoIt', 'impl', /nCount := nCount \+ 1/);
    const col0 = 0; // 'nCount' starts at column 0 of that line
    const refGood = makeLoc(URI_B, unitB.lineMap, 'method_DoIt', 'impl', line0, col0, col0 + 6);
    const refMissing = { uri: URI_MISSING, range: { start: { line: 0, character: 0 }, end: { character: 3 } } };

    const { items, searchedWord } = await listExternalReferences([refGood, refMissing], resolveSt);

    assert.strictEqual(items.length, 1, 'the unreadable uri contributes nothing (and did not throw)');
    assert.strictEqual(searchedWord, 'nCount', 'searchedWord is the first (successfully resolved) ref’s word');

    const item = items[0];
    assert.strictEqual(item.uri, URI_B);
    assert.strictEqual(item.componentId, 'method_DoIt');
    assert.strictEqual(item.targetWord, 'nCount');
    assert.strictEqual(item.lineText, 'nCount := nCount + 1;');
    assert.strictEqual(item.line, refGood.range.start.line, 'line stays ABSOLUTE (unit line), for .st navigation');
    assert.strictEqual(item.pane, 'impl');
    assert.strictEqual(item.localLine, line0);
    assert.strictEqual(item.startCharacter, col0);
    assert.strictEqual(item.endCharacter, col0 + 6);
});

check('listExternalReferences: a ref outside any known block still yields componentId "root", pane null', async () => {
    // A location whose line the lineMap does not cover (e.g. absoluteToLocal returns null) must not
    // throw and must fall back to the documented default shape.
    const readFile = makeCountingReadFile({ [URI_B]: XML_B });
    const resolveSt = createStResolver({ activeUri: URI_A, activeUnit: unitA, readFile });
    // Line far past the end of the assembled unit — absoluteToLocal must return null for it.
    const outOfRangeLine = unitB.stText.split('\n').length + 50;
    const ref = { uri: URI_B, range: { start: { line: outOfRangeLine, character: 0 }, end: { character: 1 } } };
    const { items } = await listExternalReferences([ref], resolveSt);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].componentId, 'root');
    assert.strictEqual(items[0].pane, null);
    assert.strictEqual(items[0].localLine, null);
});

(async () => {
    for (const { name, fn } of checks) {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
        } catch (e) {
            console.error(`[FAIL] ${name}: ${e.message}`);
            failures++;
        }
    }
    console.log(`\n--- LIVE PATH UNIT TESTS COMPLETE with ${failures} failures ---`);
    process.exit(failures > 0 ? 1 : 0);
})();
