/**
 * @file test_live_path.js
 * @description Validates the live-editor pipeline end to end: assemble full ST (raw) from a
 * component overlay, map a pane-local Monaco cursor to the absolute unit, run LSP providers, and
 * map results/diagnostics back to component panes. Replicates the logic in customEditorProvider.js
 * (which cannot be imported directly because it depends on `vscode`).
 *
 * The sample-driven tests address named objects of the sample/ project (TcToolkitSample):
 *
 *   FB_Station    — a clean FB whose `Cyclic` method drives a `REFERENCE TO FB_Cylinder`
 *                   (member completion, diagnostics, go-to-def)
 *   FB_Cylinder   — the referenced FB; declared in a GVL via the FB_init init-list syntax, and
 *                   used from FB_Station (cross-file references)
 *   GVL_System    — `fbCylinder : FB_Cylinder(refExtendOut := GVL_Io.bExtendOut, ...)`, i.e. the
 *                   declInitList form that binds to FB_init's VAR_INPUT
 *
 * Positions are deliberately driven through localToAbsolute()/absoluteToLocal() from *pane-local*
 * coordinates (as the webview supplies them) rather than searched for in the assembled unit — that
 * is the mapping this harness exists to guard.
 *
 * The fixtures are checked up front; anything missing SKIPS the dependent tests rather than
 * crashing halfway through. Against the current sample nothing should skip.
 */

const fs = require('fs');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt, mapDiagnosticsToMonaco } = require('../src/stConverter');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideCompletions, provideDefinition, provideDiagnostics, provideReferences } = require('../src/lsp/features');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample');

if (!fs.existsSync(SAMPLE_DIR)) {
    console.log('sample/ project not present — skipping live-path test.');
    process.exit(0);
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '_Libraries') walk(full, out); }
        else if (/\.(TcPOU|TcGVL|TcDUT|TcIO)$/i.test(e.name)) out.push(full);
    }
    return out;
}

let errors = 0;
let skipped = 0;
let ran = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// --- Replicated extension helpers (mirror customEditorProvider.js) ---

/**
 * Assembles the whole XML object into one raw ST compilation unit, applying the webview's unsaved
 * edits for the active component as an overlay.
 * @param {string} xml Backing XML text.
 * @param {Object|null} overlay { componentId, decl?, impl? } live edits for the active component.
 * @returns {Object|null} { stText, lineMap } or null if the XML could not be parsed.
 */
function assembleSt(xml, overlay) {
    const parsed = parseTwinCatXml(xml);
    if (!parsed) return null;
    if (overlay && overlay.componentId) {
        const comp = parsed.components.find(c => c.id === overlay.componentId);
        if (comp) {
            if (typeof overlay.decl === 'string' && comp.declaration != null) comp.declaration = overlay.decl;
            if (typeof overlay.impl === 'string' && comp.implementation != null) comp.implementation = overlay.impl;
        }
    }
    return convertXmlToSt(parsed, { raw: true });
}

/**
 * Maps a Monaco pane position to an absolute 0-based position in the assembled unit.
 * @param {Object} lineMap The lineMap from convertXmlToSt.
 * @param {string} componentId Active component id.
 * @param {string} pane 'decl' or 'impl'.
 * @param {number} lineNumber Monaco 1-based line within the pane.
 * @param {number} column Monaco 1-based column.
 * @returns {Object|null} { line, character } 0-based, or null.
 */
function localToAbsolute(lineMap, componentId, pane, lineNumber, column) {
    const blocks = lineMap[componentId];
    if (!blocks) return null;
    const block = pane === 'decl' ? blocks.decl : blocks.impl;
    if (!block || !block.start) return null;
    return { line: (block.start - 1) + (lineNumber - 1), character: column - 1 };
}

/**
 * Maps an absolute 0-based line in the assembled unit back to a component pane and local line.
 * @param {Object} lineMap The lineMap from convertXmlToSt.
 * @param {number} absLine0 Absolute 0-based line in the unit.
 * @returns {Object|null} { componentId, pane, localLine0 } or null if outside every block.
 */
function absoluteToLocal(lineMap, absLine0) {
    const line1 = absLine0 + 1;
    for (const componentId of Object.keys(lineMap)) {
        const blocks = lineMap[componentId];
        if (blocks.decl && blocks.decl.start && line1 >= blocks.decl.start && line1 <= blocks.decl.end) {
            return { componentId, pane: 'decl', localLine0: line1 - blocks.decl.start };
        }
        if (blocks.impl && blocks.impl.start && line1 >= blocks.impl.start && line1 <= blocks.impl.end) {
            return { componentId, pane: 'impl', localLine0: line1 - blocks.impl.start };
        }
    }
    return null;
}

// --- Index the workspace from XML (as the LSP server does) ---
const files = walk(SAMPLE_DIR);
const byName = {};

/**
 * Rebuilds the workspace symbol index from every sample XML file. Several tests clear the index to
 * run synthetic units, so they call this to restore it.
 * @returns {Object} The (re-populated) workspace symbol index.
 */
function reindexSample() {
    clearWorkspaceIndex();
    const idx = getWorkspaceSymbolIndex();
    for (const f of files) {
        const xml = fs.readFileSync(f, 'utf8');
        const uri = 'file:///' + f.replace(/\\/g, '/');
        const node = indexXmlObject(idx, xml, uri);
        if (node) byName[node.name] = { file: f, uri, xml };
    }
    return idx;
}

let index = reindexSample();

// --- Fixture accessors -------------------------------------------------------------------------

/**
 * Returns the pane text of a component of an indexed object, or null when absent.
 * @param {string} objName Object name as indexed (e.g. 'FB_Clamping').
 * @param {string} componentId Component id (e.g. 'method_Cyclic', 'root').
 * @param {string} pane 'decl' or 'impl'.
 * @returns {string|null} The raw pane text.
 */
function paneText(objName, componentId, pane) {
    const entry = byName[objName];
    if (!entry) return null;
    const parsed = parseTwinCatXml(entry.xml);
    if (!parsed) return null;
    const comp = parsed.components.find(c => c.id === componentId);
    if (!comp) return null;
    const text = pane === 'decl' ? comp.declaration : comp.implementation;
    return typeof text === 'string' ? text : null;
}

/**
 * Splits pane text into the lines Monaco would show (CRLF normalised).
 * @param {string} text Pane text.
 * @returns {Array<string>} Lines.
 */
function paneLines(text) {
    return text.split(/\r?\n/);
}

/**
 * Finds the 0-based pane-local line index matching a pattern.
 * @param {Array<string>} lines Pane lines.
 * @param {RegExp} re Pattern to look for.
 * @returns {number} 0-based index, or -1.
 */
function findLine(lines, re) {
    return lines.findIndex(l => re.test(l));
}

// --- Fixture preconditions ---------------------------------------------------------------------
// The sample-driven tests address named objects, named components, and specific source lines inside
// them. Anything missing means this sample is not the one they were written for: report it and skip
// those tests rather than crashing halfway through.

// Pane-local anchors the tests navigate to. Checked here so a drifted sample skips instead of
// failing an assertion for the wrong reason.
const STATION_MEMBER_ACCESS = /refCylinder\.bIsExtended/;          // FB_Station.Cyclic impl
const STATION_STATE_ASSIGN = /_eState\s*:=\s*E_StationState\.Error/; // FB_Station.Cyclic impl
const GVL_INIT_PARAM = /refExtendOut\s*:=\s*GVL_Io\./;             // GVL_System root decl

const missing = [];
for (const name of ['FB_Station', 'FB_Cylinder', 'GVL_System']) {
    if (!byName[name]) missing.push(`object ${name}`);
}
const stationCyclicImpl = paneText('FB_Station', 'method_Cyclic', 'impl');
if (byName['FB_Station'] && stationCyclicImpl === null) {
    missing.push('FB_Station component method_Cyclic');
} else if (stationCyclicImpl) {
    if (!STATION_MEMBER_ACCESS.test(stationCyclicImpl)) missing.push('FB_Station.Cyclic use of refCylinder.bIsExtended');
    if (!STATION_STATE_ASSIGN.test(stationCyclicImpl)) missing.push('FB_Station.Cyclic line "_eState := E_StationState.Error"');
}
const stationDecl = paneText('FB_Station', 'root', 'decl');
if (stationDecl && !/refCylinder\s*:\s*REFERENCE\s+TO\s+FB_Cylinder/i.test(stationDecl)) {
    missing.push('FB_Station var "refCylinder : REFERENCE TO FB_Cylinder"');
}
const gvlDecl = paneText('GVL_System', 'root', 'decl');
if (gvlDecl && !GVL_INIT_PARAM.test(gvlDecl)) {
    missing.push('GVL_System FB_init init-list arg "refExtendOut := GVL_Io..."');
}
if (paneText('FB_Cylinder', 'method_FB_init', 'decl') === null) {
    missing.push('FB_Cylinder component method_FB_init');
}

const canRunSampleTests = missing.length === 0;
if (!canRunSampleTests) {
    console.log('\nsample/ does not contain the fixtures these tests were written against — skipping the sample-driven tests:');
    missing.forEach(m => console.log(`  - missing: ${m}`));
    console.log('  (The sample-independent tests still run. This is a harness-portability skip, not a product failure.)');
}

/**
 * Runs a sample-fixture-dependent test, or skips it cleanly when the fixtures are absent.
 * @param {string} title Section title.
 * @param {Function} fn Test body.
 */
function sampleTest(title, fn) {
    console.log(`\n--- ${title} ---`);
    if (!canRunSampleTests) {
        console.log('[SKIP] required sample fixtures absent');
        skipped++;
        return;
    }
    ran++;
    fn();
}

/**
 * Runs a sample-independent test.
 * @param {string} title Section title.
 * @param {Function} fn Test body.
 */
function plainTest(title, fn) {
    console.log(`\n--- ${title} ---`);
    ran++;
    fn();
}

// ============================================================
// TEST 1: FB_Station's 'Cyclic' method — valid code, 0 diagnostics in its panes
// ============================================================
sampleTest("TEST 1: FB_Station.Cyclic diagnostics (valid)", () => {
    const { xml, uri } = byName['FB_Station'];
    const { stText, lineMap } = assembleSt(xml, null);
    parseAndIndexDocument(stText, uri); // server re-parses the active unit
    const diags = provideDiagnostics(stText, index, uri);
    const mapped = mapDiagnosticsToMonaco(diags, lineMap);

    // Guard against a vacuous pass: if the lineMap lost the component, "no diagnostics for it" would
    // be trivially true. The block must exist and be non-empty before the count means anything.
    const blocks = lineMap['method_Cyclic'];
    assert(!!blocks && blocks.impl.start > 0 && blocks.impl.end >= blocks.impl.start,
        `lineMap must carry a non-empty impl block for method_Cyclic (got ${JSON.stringify(blocks)})`);

    const cyclicMarkers = mapped.filter(m => m.componentId === 'method_Cyclic');
    assert(cyclicMarkers.length === 0, `FB_Station.Cyclic should have no diagnostics (got ${JSON.stringify(cyclicMarkers)})`);
});

// ============================================================
// TEST 2: member completion inside Cyclic — refCylinder. (REFERENCE TO FB_Cylinder)
// ============================================================
sampleTest('TEST 2: member completion refCylinder.', () => {
    const { xml, uri } = byName['FB_Station'];
    const { stText, lineMap } = assembleSt(xml, null);
    parseAndIndexDocument(stText, uri);

    // Pane-local cursor, just after the dot of "refCylinder." — mapped through the lineMap exactly
    // as the extension maps a webview cursor.
    const lines = paneLines(stationCyclicImpl);
    const localLine0 = findLine(lines, STATION_MEMBER_ACCESS);
    const localCol0 = lines[localLine0].indexOf('refCylinder.') + 'refCylinder.'.length;
    const abs = localToAbsolute(lineMap, 'method_Cyclic', 'impl', localLine0 + 1, localCol0 + 1);

    const comps = provideCompletions(stText, abs, index, uri);
    const labels = comps.map(c => c.label);
    assert(labels.includes('bIsExtended') && labels.includes('bIsRetracted'),
        `refCylinder. should complete FB_Cylinder properties bIsExtended/bIsRetracted (got ${labels.join(', ')})`);
    assert(labels.includes('Extend') && labels.includes('Retract'),
        `refCylinder. should complete FB_Cylinder methods Extend/Retract (got ${labels.join(', ')})`);
});

// ============================================================
// TEST 3: go-to-definition of POU variable '_eState' from inside Cyclic
// ============================================================
sampleTest('TEST 3: go-to-definition of _eState from Cyclic', () => {
    const { xml, uri } = byName['FB_Station'];
    const { stText, lineMap } = assembleSt(xml, null);
    parseAndIndexDocument(stText, uri);

    const lines = paneLines(stationCyclicImpl);
    const localLine0 = findLine(lines, STATION_STATE_ASSIGN);
    const localCol0 = lines[localLine0].indexOf('_eState') + 2; // cursor inside the word
    const abs = localToAbsolute(lineMap, 'method_Cyclic', 'impl', localLine0 + 1, localCol0 + 1);

    const def = provideDefinition(stText, abs, index, uri);
    assert(def && def.targetWord === '_eState' && def.componentId === 'root',
        `_eState should resolve to the root POU var block (got ${JSON.stringify(def)})`);
    assert(def && /FB_Station\.TcPOU$/i.test(def.uri), `_eState resolves inside FB_Station (got ${def && def.uri})`);
});

// ============================================================
// TEST 4: inject a typo into Cyclic's implementation -> exactly one diagnostic, in the impl pane
// ============================================================
sampleTest('TEST 4: typo in Cyclic maps to impl pane', () => {
    const { xml, uri } = byName['FB_Station'];
    // Overlay a broken implementation for method_Cyclic: line 1 is valid code (a real struct member
    // of FB_Station assigned from a real property of FB_Cylinder), line 2 names nothing at all. The
    // first line exists to prove the check is discriminating rather than flagging the whole overlay.
    // (Overlay only — the sample file on disk is never touched.)
    const brokenImpl = '_stStatus.bBusy := refCylinder.bIsExtended;\nbDoesNotExist := TRUE;';
    const { stText, lineMap } = assembleSt(xml, { componentId: 'method_Cyclic', impl: brokenImpl });
    parseAndIndexDocument(stText, uri);
    const diags = provideDiagnostics(stText, index, uri);
    const mapped = mapDiagnosticsToMonaco(diags, lineMap);
    const cyclicImpl = mapped.filter(m => m.componentId === 'method_Cyclic' && m.pane === 'implementation');
    assert(cyclicImpl.some(m => m.message.includes('bDoesNotExist')),
        `typo bDoesNotExist should be flagged in Cyclic implementation (got ${JSON.stringify(mapped)})`);
    assert(cyclicImpl.length === 1, `exactly one diagnostic expected in Cyclic impl (got ${cyclicImpl.length})`);
    // And it must land on the 2nd line of the *pane*, column 1 — the typo's position.
    const m = cyclicImpl.find(x => x.message.includes('bDoesNotExist'));
    assert(m && m.range.startLineNumber === 2 && m.range.startColumn === 1,
        `typo should map to impl pane line 2, column 1 (got ${m && m.range.startLineNumber}:${m && m.range.startColumn})`);
});

// ============================================================
// TEST 5: pointer/reference return type on a method is parsed (not blanked by keywords)
//   Sample-independent.
// ============================================================
plainTest('TEST 5: method return type "REFERENCE TO INT"', () => {
    clearWorkspaceIndex();
    const idx2 = getWorkspaceSymbolIndex();
    const st = `FUNCTION_BLOCK FB_Ret
VAR
END_VAR
METHOD GetRef : REFERENCE TO INT
VAR
END_VAR
GetRef := 0;
END_METHOD
END_FUNCTION_BLOCK`;
    parseAndIndexDocument(st, 'file:///tmp/FB_Ret.st');
    const node = idx2['FB_Ret'];
    const m = node && node.methods.find(x => x.name === 'GetRef');
    assert(m && /REFERENCE\s+TO\s+INT/i.test(m.returnType), `return type should be "REFERENCE TO INT" (got "${m && m.returnType}")`);
    index = reindexSample(); // restore the sample index for the tests that follow
});

// ============================================================
// TEST 6: references are token-aware (no matches inside comments/strings)
//   Sample-independent.
// ============================================================
plainTest('TEST 6: token-aware references', () => {
    const code = [
        "FUNCTION_BLOCK FB_T",                 // 1
        "VAR",                                 // 2
        "    nCounter : INT;",                 // 3
        "END_VAR",                             // 4
        "nCounter := nCounter + 1;",           // 5
        "// nCounter is mentioned here in a comment", // 6
        "sMsg := 'nCounter inside a string';", // 7
        "END_FUNCTION_BLOCK"                   // 8
    ].join('\n');
    const uriT = 'file:///tmp/FB_T.st';
    clearWorkspaceIndex();
    parseAndIndexDocument(code, uriT);
    // Cursor on nCounter in the declaration (line 3, char 4).
    const refs = provideReferences(code, { line: 2, character: 6 }, getWorkspaceSymbolIndex(), uriT);
    const sameFile = refs.filter(r => r.uri === uriT);
    // Expect exactly 3 real occurrences: decl (L3) + two uses on L5. Comment(L6)/string(L7) excluded.
    assert(sameFile.length === 3, `expected 3 token-aware references, got ${sameFile.length} (${JSON.stringify(sameFile.map(r => r.range.start.line + 1))})`);
    const lines = sameFile.map(r => r.range.start.line + 1).sort((a, b) => a - b);
    assert(!lines.includes(6) && !lines.includes(7), `references must not include comment(L6)/string(L7) lines (got ${lines})`);
    index = reindexSample(); // restore the sample index for the tests that follow
});

// ============================================================
// TEST 7: cross-file references for a POU type name (the "find usages of an FB" case)
//   FB_Cylinder is declared in its own file, instantiated in GVL_System, and held as a REFERENCE TO
//   by FB_Station. Three files, three occurrences — measured, not assumed:
//     FB_Cylinder.TcPOU  L6  (the FUNCTION_BLOCK header itself)
//     GVL_System.TcGVL   L8  (fbCylinder : FB_Cylinder(refExtendOut := ...))
//     FB_Station.TcPOU   L8  (refCylinder : REFERENCE TO FB_Cylinder)
//   The customer sample this test was written against had the FB used by three further station
//   modules and asserted >= 4 files; the synthetic project genuinely has only these three, so the
//   real number is asserted exactly. Raising it needs new fixtures, not a looser bound.
// ============================================================
sampleTest('TEST 7: cross-file references to FB_Cylinder', () => {
    const { xml, uri } = byName['FB_Cylinder'];
    // Cursor on "FB_Cylinder" in its own declaration (FUNCTION_BLOCK FB_Cylinder).
    const { stText } = assembleSt(xml, null);
    const lines = stText.split('\n');
    const declLineIdx = lines.findIndex(l => /FUNCTION_BLOCK\s+FB_Cylinder/.test(l));
    const col = lines[declLineIdx].indexOf('FB_Cylinder');
    const refs = provideReferences(stText, { line: declLineIdx, character: col + 1 }, index, uri);
    const fileSet = new Set(refs.map(r => path.basename(r.uri.replace(/^file:\/\/\//, '')).toLowerCase()));
    assert(fileSet.has('gvl_system.tcgvl') && fileSet.has('fb_station.tcpou')
        && fileSet.has('fb_cylinder.tcpou'),
        `FB_Cylinder references should span FB_Cylinder, GVL_System and FB_Station (got files: ${[...fileSet].join(', ')})`);
    assert(fileSet.size === 3, `references span exactly 3 files (got ${fileSet.size}: ${[...fileSet].join(', ')})`);
    assert(refs.length === 3, `expected 3 FB_Cylinder references across the project (got ${refs.length})`);
});

// ============================================================
// TEST 8: a semantic (member-access) error in a method maps through the live pipeline
// ============================================================
sampleTest('TEST 8: member-access diagnostic maps to the right pane', () => {
    const { xml, uri } = byName['FB_Station'];
    const brokenImpl = 'refCylinder.NoSuchMember := 1;';
    const { stText, lineMap } = assembleSt(xml, { componentId: 'method_Cyclic', impl: brokenImpl });
    parseAndIndexDocument(stText, uri);
    const diags = provideDiagnostics(stText, index, uri);
    const mapped = mapDiagnosticsToMonaco(diags, lineMap);
    const m = mapped.find(x => x.componentId === 'method_Cyclic' && x.pane === 'implementation' && x.message.includes('NoSuchMember'));
    assert(!!m, `member typo flagged in Cyclic implementation (got ${JSON.stringify(mapped.map(x => x.message))})`);
    // 'refCylinder.' is 12 chars, so the member starts at pane line 1, column 13.
    assert(m && m.range.startLineNumber === 1 && m.range.startColumn === 13,
        `maps to impl pane line 1, column 13 (got ${m && m.range.startLineNumber}:${m && m.range.startColumn})`);
});

// ============================================================
// TEST 9: go-to-definition on an FB-init parameter resolves to the FB that declares it
//   GVL_System: fbCylinder : FB_Cylinder(refExtendOut := GVL_Io.bExtendOut, ...);
//   The parens straight after the type mean these are FB_init's VAR_INPUT — and FB_Cylinder also
//   has an own member named refExtendOut, so a jump to the member would be the wrong answer.
// ============================================================
sampleTest('TEST 9: go-to-definition on FB-init parameter', () => {
    const { xml, uri } = byName['GVL_System'];
    const { stText, lineMap } = assembleSt(xml, null);
    parseAndIndexDocument(stText, uri);

    const lines = paneLines(gvlDecl);
    const localLine0 = findLine(lines, GVL_INIT_PARAM);
    const localCol0 = lines[localLine0].indexOf('refExtendOut') + 2; // cursor inside the word
    const abs = localToAbsolute(lineMap, 'root', 'decl', localLine0 + 1, localCol0 + 1);

    const def = provideDefinition(stText, abs, index, uri);
    assert(def && /FB_Cylinder\.TcPOU$/i.test(def.uri),
        `refExtendOut resolves into FB_Cylinder (got ${def && def.uri})`);
    assert(def && def.targetWord === 'refExtendOut', `targetWord is refExtendOut (got ${def && def.targetWord})`);
    assert(def && def.componentId === 'method_FB_init',
        `must land on FB_init's VAR_INPUT, not the FB's own member of the same name (got componentId ${def && def.componentId})`);
});

// ============================================================
// TEST 10: the position mapping itself round-trips (local -> absolute -> local)
//   This is the invariant every test above leans on, asserted directly: an absolute position derived
//   from a pane-local one must name the same text, and must map back to the pane it came from.
// ============================================================
sampleTest('TEST 10: pane <-> unit position mapping round-trips', () => {
    const { xml } = byName['FB_Station'];
    const { stText, lineMap } = assembleSt(xml, null);
    const unitLines = stText.split('\n');

    // (a) impl pane of a method.
    const implLines = paneLines(stationCyclicImpl);
    const implLocal0 = findLine(implLines, STATION_MEMBER_ACCESS);
    const absImpl = localToAbsolute(lineMap, 'method_Cyclic', 'impl', implLocal0 + 1, 1);
    assert(unitLines[absImpl.line] === implLines[implLocal0],
        `impl line ${implLocal0 + 1} of method_Cyclic must map to the same text in the unit ` +
        `(pane: ${JSON.stringify(implLines[implLocal0])}, unit@${absImpl.line}: ${JSON.stringify(unitLines[absImpl.line])})`);
    const backImpl = absoluteToLocal(lineMap, absImpl.line);
    assert(backImpl && backImpl.componentId === 'method_Cyclic' && backImpl.pane === 'impl' && backImpl.localLine0 === implLocal0,
        `absolute line ${absImpl.line} must map back to method_Cyclic/impl/${implLocal0} (got ${JSON.stringify(backImpl)})`);

    // (b) decl pane of the root POU.
    const declLines = paneLines(stationDecl);
    const declLocal0 = findLine(declLines, /refCylinder\s*:\s*REFERENCE\s+TO/i);
    const absDecl = localToAbsolute(lineMap, 'root', 'decl', declLocal0 + 1, 1);
    assert(unitLines[absDecl.line] === declLines[declLocal0],
        `decl line ${declLocal0 + 1} of root must map to the same text in the unit ` +
        `(pane: ${JSON.stringify(declLines[declLocal0])}, unit@${absDecl.line}: ${JSON.stringify(unitLines[absDecl.line])})`);
    const backDecl = absoluteToLocal(lineMap, absDecl.line);
    assert(backDecl && backDecl.componentId === 'root' && backDecl.pane === 'decl' && backDecl.localLine0 === declLocal0,
        `absolute line ${absDecl.line} must map back to root/decl/${declLocal0} (got ${JSON.stringify(backDecl)})`);

    // (c) columns are a straight 1-based -> 0-based shift, so a mapped column must index the token.
    const dotCol0 = implLines[implLocal0].indexOf('refCylinder.') + 'refCylinder.'.length;
    const absDot = localToAbsolute(lineMap, 'method_Cyclic', 'impl', implLocal0 + 1, dotCol0 + 1);
    assert(unitLines[absDot.line].startsWith('bIsExtended', absDot.character),
        `mapped column must land immediately before "bIsExtended" (got ${JSON.stringify(unitLines[absDot.line].slice(absDot.character, absDot.character + 11))})`);
});

console.log(`\n--- LIVE PATH TESTS COMPLETE with ${errors} errors, ${ran} run, ${skipped} skipped ---`);
process.exit(errors > 0 ? 1 : 0);
