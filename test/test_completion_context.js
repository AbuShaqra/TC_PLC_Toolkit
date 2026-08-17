/**
 * @file test_completion_context.js
 * @description Caret-context filtering of autocompletion: only what is VALID at the caret is offered.
 *
 * Completion used to be context-blind — the same ~140 items in every position, so a *type* position
 * offered END_IF and a VAR block offered a FOR snippet. classifyCaretContext (src/lsp/features.js)
 * now decides where the caret is, and provideCompletions offers only what that context accepts.
 *
 * The point of this harness is therefore the NEGATIVE assertions: proving the junk is gone. The
 * positive ones only guard the other failure mode — a context that starves the user.
 *
 * The contexts, and the rule each one encodes:
 *   type       `x : ▮`, `ARRAY […] OF ▮`, `POINTER TO ▮`, `EXTENDS ▮`, `METHOD m : ▮`
 *              → types only. No keywords, no snippets, no variables.
 *   varName    inside VAR…END_VAR at the start of a declaration → the user is inventing a name;
 *              nothing to complete but the terminator that closes the open block.
 *   statement  a statement may start here → variables, members, snippets, statement-initiating
 *              keywords, and a terminator ONLY when its block is actually open at the caret.
 *   value      after `:=` / an operator / an IF condition → an expression. No terminators, no
 *              snippets, no declaration keywords.
 *   caseLabel  between `CASE x OF` and its first label → the selector's enum members, ranked first.
 *   unknown    anything the classifier cannot place (including inside a call's parentheses, which
 *              the named-parameter path owns) → the full list, as before. A missing suggestion is a
 *              worse failure than a noisy one.
 *
 * Self-contained: builds synthetic TwinCAT XML in a temp dir; no sample/ dependency. DUTs are
 * indexed via indexXmlObject — a DUT declared in raw ST is NOT indexed by parseAndIndexDocument.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideCompletions } = require('../src/lsp/features');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

let uid = 0;
/** Fabricates a unique TwinCAT GUID (the parser only needs it to be well-formed). */
function guid() {
    const n = String(++uid).padStart(12, '0');
    return `{00000000-0000-0000-0000-${n}}`;
}

/** Builds a .TcPOU document. `methods` is a list of { name, decl, impl }. */
function tcpou(name, decl, impl, methods = []) {
    const methodXml = methods.map(m => `    <Method Name="${m.name}" Id="${guid()}">
      <Declaration><![CDATA[${m.decl}]]></Declaration>
      <Implementation>
        <ST><![CDATA[${m.impl || ''}]]></ST>
      </Implementation>
    </Method>`).join('\n');
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="${guid()}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl || ''}]]></ST>
    </Implementation>
${methodXml}
  </POU>
</TcPlcObject>`;
}

/** Builds a .TcGVL document. */
function tcgvl(name, decl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <GVL Name="${name}" Id="${guid()}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </GVL>
</TcPlcObject>`;
}

/** Builds a .TcDUT document (struct or enum — the declaration text decides which). */
function tcdut(name, decl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <DUT Name="${name}" Id="${guid()}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </DUT>
</TcPlcObject>`;
}

// ---------------------------------------------------------------------------------------------
// The synthetic workspace.
// ---------------------------------------------------------------------------------------------

const FILES = {
    'E_State.TcDUT': tcdut('E_State', 'TYPE E_State :\n(\n\teIdle := 0,\n\teRun,\n\teStop\n);\nEND_TYPE'),
    'ST_Data.TcDUT': tcdut('ST_Data',
        'TYPE ST_Data :\nSTRUCT\n\tnSpeed : INT;\n\tbEnable : BOOL;\nEND_STRUCT\nEND_TYPE'),
    'GVL_System.TcGVL': tcgvl('GVL_System', 'VAR_GLOBAL\n\tg_bRunning : BOOL;\n\tg_nCycle : INT;\nEND_VAR'),
    'FB_Motor.TcPOU': tcpou('FB_Motor',
        'FUNCTION_BLOCK FB_Motor\nVAR_INPUT\n\tbEnable : BOOL;\nEND_VAR\nVAR\n\tnSpeed : INT;\nEND_VAR', '',
        [{ name: 'M_Start', decl: 'METHOD M_Start : BOOL', impl: '' }])
};

// The active document. Every caret in the tests below sits somewhere in this one text, so the
// contexts are exercised against ONE coherent POU rather than a special-cased snippet each.
const MAIN_DECL =
    'PROGRAM MAIN\n' +
    'VAR\n' +
    '\tfbMotor : FB_Motor;\n' +
    '\tnCount : INT;\n' +
    '\tnTotal : INT;\n' +
    '\teState : E_State;\n' +
    '\tstData : ST_Data;\n' +
    '\tarrVals : ARRAY [1..10] OF INT;\n' +
    '\tpData : POINTER TO ST_Data;\n' +
    '\tnInit : INT := 0;\n' +
    'END_VAR';

const MAIN_IMPL =
    'nTotal := 0;\n' +
    'IF nCount > 0 THEN\n' +
    '\tnCount := 0;\n' +
    'END_IF\n' +
    'CASE eState OF\n' +
    '\teIdle:\n' +
    '\t\tnCount := 1;\n' +
    '\teRun:\n' +
    '\t\tnTotal := nCount;\n' +
    'END_CASE\n' +
    'eState := eIdle;\n';

const MAIN_XML = tcpou('MAIN', MAIN_DECL, MAIN_IMPL,
    [{ name: 'M_Calc', decl: 'METHOD M_Calc : INT\nVAR\n\tnLocal : INT;\nEND_VAR', impl: 'nLocal := 0;\n' }]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_complctx_'));
const uriOf = (f) => 'file:///' + path.join(dir, f).replace(/\\/g, '/').replace(/^\//, '');

/**
 * Runs completions inside a document exactly the way the LSP server does: the whole workspace is
 * indexed from XML first, then the active document is re-parsed from its raw ST unit
 * (parseAndIndexDocument) before the request is answered.
 *
 * The caret is placed immediately after the first occurrence of `marker` in the ST unit — so the
 * marker's trailing characters (': ', ';', ':= ', 'OF') decide the context under test.
 * @param {string} fileName Name of the active document.
 * @param {string} xml Its TwinCAT XML.
 * @param {string} marker Text the caret sits directly behind.
 * @returns {Array<Object>} Completion items.
 */
function completionsAt(fileName, xml, marker) {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    for (const f of Object.keys(FILES)) indexXmlObject(index, FILES[f], uriOf(f));
    indexXmlObject(index, xml, uriOf(fileName));

    // raw:true is what the live editor path uses — the "clean" conversion strips init lists.
    const { stText } = convertXmlToSt(parseTwinCatXml(xml), { raw: true });
    parseAndIndexDocument(stText, uriOf(fileName));

    const lines = stText.split('\n');
    const lineIdx = lines.findIndex(l => l.includes(marker));
    if (lineIdx === -1) throw new Error(`test bug: no ST line contains "${marker}"`);
    const character = lines[lineIdx].indexOf(marker) + marker.length;

    return provideCompletions(stText, { line: lineIdx, character }, getWorkspaceSymbolIndex(), uriOf(fileName)) || [];
}

/**
 * Same, but the caret goes to the START of the line containing `marker` — i.e. on a fresh line,
 * which is where a user actually stands after pressing Enter. (Sitting flush behind a keyword,
 * `…OF▮`, is a different thing: there the word under the caret is still being typed.)
 * @param {string} fileName Name of the active document.
 * @param {string} xml Its TwinCAT XML.
 * @param {string} marker Text identifying the line.
 * @returns {Array<Object>} Completion items.
 */
function completionsAtLineStart(fileName, xml, marker) {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    for (const f of Object.keys(FILES)) indexXmlObject(index, FILES[f], uriOf(f));
    indexXmlObject(index, xml, uriOf(fileName));

    const { stText } = convertXmlToSt(parseTwinCatXml(xml), { raw: true });
    parseAndIndexDocument(stText, uriOf(fileName));

    const lines = stText.split('\n');
    const lineIdx = lines.findIndex(l => l.includes(marker));
    if (lineIdx === -1) throw new Error(`test bug: no ST line contains "${marker}"`);

    return provideCompletions(stText, { line: lineIdx, character: 0 }, getWorkspaceSymbolIndex(), uriOf(fileName)) || [];
}

const labelsOf = (items) => items.map(i => i.label);
const has = (items, label) => labelsOf(items).includes(label);
const snippetsOf = (items) => items.filter(i => i.kind === 27).map(i => i.label);
/** Labels ranked ahead of everything else (the '00_' sortText the feature reserves for them). */
const rankedFirst = (items) => items.filter(i => i.sortText && i.sortText.startsWith('00_')).map(i => i.label);

/** Every terminator / mid-construct keyword the old context-blind list offered everywhere. */
const JUNK = ['END_IF', 'END_VAR', 'END_CASE', 'END_WHILE', 'END_FOR', 'END_REPEAT',
    'END_FUNCTION_BLOCK', 'THEN', 'ELSE', 'ELSIF', 'OF', 'DO', 'BY', 'UNTIL'];

/** Reports which of `bad` leaked into the list (empty string when none did). */
function leaked(items, bad) {
    const found = bad.filter(l => has(items, l));
    return found.join(', ');
}

const counts = {};
/** Records an item count for the before/after table printed at the end. */
function record(name, items) {
    counts[name] = items.length;
    return items;
}

try {
    // ---- 0. The context-blind baseline ----------------------------------------------------------
    // Right after the POU's own name nothing can be inferred, so the classifier says 'unknown' and
    // the full list is offered — the fallback that keeps a mid-edit caret from starving. This is
    // also the "before" number every context below is measured against.
    // (stConverter rewrites a PROGRAM header as FUNCTION_BLOCK when the POU has methods, so that is
    // the header the ST unit — and therefore the LSP — actually sees.)
    const cBlind = record('unknown (fallback)', completionsAt('MAIN.TcPOU', MAIN_XML, 'FUNCTION_BLOCK MAIN'));
    assert(cBlind.length > 100 && has(cBlind, 'IF') && has(cBlind, 'BOOL') && has(cBlind, 'GVL_System'),
        `an unclassifiable caret still gets the full list (${cBlind.length} items)`);

    // ---- 1. TYPE position: `nCount : ▮` ----------------------------------------------------------
    const cType = record('type (after ":")', completionsAt('MAIN.TcPOU', MAIN_XML, 'nCount : '));
    assert(leaked(cType, JUNK) === '',
        `type position offers no terminator / mid-construct keyword (leaked: [${leaked(cType, JUNK)}])`);
    assert(snippetsOf(cType).length === 0,
        `…and no snippets (got [${snippetsOf(cType).join(', ')}])`);
    assert(!has(cType, 'nCount') && !has(cType, 'g_bRunning') && !has(cType, 'GVL_System'),
        '…and no variables or GVLs — only a type may be written there');
    assert(has(cType, 'INT') && has(cType, 'BOOL') && has(cType, 'STRING'),
        '…while the standard types are all there');
    assert(has(cType, 'FB_Motor') && has(cType, 'ST_Data') && has(cType, 'E_State'),
        '…and the project FB / struct / enum types too');

    // ---- 2. TYPE position: `ARRAY [1..10] OF ▮` and `POINTER TO ▮` --------------------------------
    const cArr = record('type (ARRAY … OF)', completionsAt('MAIN.TcPOU', MAIN_XML, 'arrVals : ARRAY [1..10] OF '));
    assert(has(cArr, 'INT') && has(cArr, 'ST_Data') && leaked(cArr, JUNK) === '' && snippetsOf(cArr).length === 0,
        `ARRAY […] OF ▮ is a type position (${cArr.length} items, leaked: [${leaked(cArr, JUNK)}])`);

    const cPtr = record('type (POINTER TO)', completionsAt('MAIN.TcPOU', MAIN_XML, 'pData : POINTER TO '));
    assert(has(cPtr, 'ST_Data') && has(cPtr, 'INT') && leaked(cPtr, JUNK) === '',
        `POINTER TO ▮ is a type position (${cPtr.length} items, leaked: [${leaked(cPtr, JUNK)}])`);

    // ---- 3. TYPE position: `EXTENDS ▮` and a METHOD's return type ---------------------------------
    const derivedXml = tcpou('FB_Derived', 'FUNCTION_BLOCK FB_Derived EXTENDS FB_Motor\nVAR\n\tbFlag : BOOL;\nEND_VAR', '');
    const cExt = record('type (EXTENDS)', completionsAt('FB_Derived.TcPOU', derivedXml, 'EXTENDS '));
    assert(has(cExt, 'FB_Motor') && leaked(cExt, JUNK) === '' && snippetsOf(cExt).length === 0,
        `EXTENDS ▮ offers types only (${cExt.length} items, leaked: [${leaked(cExt, JUNK)}])`);

    const cRet = record('type (METHOD return)', completionsAt('MAIN.TcPOU', MAIN_XML, 'METHOD M_Calc : '));
    assert(has(cRet, 'INT') && has(cRet, 'BOOL') && leaked(cRet, JUNK) === '',
        `METHOD m : ▮ is a type position (${cRet.length} items, leaked: [${leaked(cRet, JUNK)}])`);

    // ---- 4. VAR-block NAME position: `nCount : INT;` ▮ --------------------------------------------
    // The user is inventing an identifier. Nothing can be completed for them — except END_VAR, which
    // genuinely closes the block that is open at the caret.
    const cName = record('varName (in VAR block)', completionsAt('MAIN.TcPOU', MAIN_XML, 'nCount : INT;'));
    assert(snippetsOf(cName).length === 0,
        `VAR-block name position offers no control-flow snippets (got [${snippetsOf(cName).join(', ')}])`);
    assert(!has(cName, 'IF') && !has(cName, 'FOR') && !has(cName, 'CASE') && !has(cName, 'THEN'),
        '…and no control-flow keywords');
    assert(!has(cName, 'INT') && !has(cName, 'FB_Motor') && !has(cName, 'nCount'),
        '…and no types or variables — the name is the user\'s to invent');
    assert(has(cName, 'END_VAR'),
        '…but END_VAR is offered: it closes the block that is open at the caret');

    // ---- 5. STATEMENT start, no block open --------------------------------------------------------
    const cStmt = record('statement (no block open)', completionsAt('MAIN.TcPOU', MAIN_XML, 'nTotal := 0;'));
    assert(has(cStmt, 'nCount') && has(cStmt, 'fbMotor') && has(cStmt, 'g_bRunning') && has(cStmt, 'GVL_System'),
        `statement start offers variables, FB instances and globals (${cStmt.length} items)`);
    assert(snippetsOf(cStmt).includes('IF') && snippetsOf(cStmt).includes('FOR') && snippetsOf(cStmt).includes('CASE'),
        `…and the control-flow snippets (got [${snippetsOf(cStmt).join(', ')}])`);
    assert(has(cStmt, 'IF') && has(cStmt, 'WHILE') && has(cStmt, 'RETURN'),
        '…and the statement-initiating keywords');
    assert(!has(cStmt, 'END_IF') && !has(cStmt, 'END_CASE') && !has(cStmt, 'END_FOR') && !has(cStmt, 'UNTIL'),
        '…but no terminator: no block is open at this caret');
    assert(!has(cStmt, 'THEN') && !has(cStmt, 'ELSE') && !has(cStmt, 'OF') && !has(cStmt, 'DO'),
        '…and no mid-construct keyword');
    assert(!snippetsOf(cStmt).includes('ELSIF'),
        '…and not even the ELSIF *snippet*: it continues an IF, and no IF is open here');
    assert(!has(cStmt, 'INT') && !has(cStmt, 'BOOL') && !has(cStmt, 'LREAL'),
        '…and no elementary types — a statement cannot start with one');

    // ---- 6. STATEMENT start inside an open IF ------------------------------------------------------
    // The one place a terminator IS valid: it closes the block that is open right here.
    const cInIf = record('statement (inside IF)', completionsAt('MAIN.TcPOU', MAIN_XML, '\tnCount := 0;'));
    assert(has(cInIf, 'END_IF') && has(cInIf, 'ELSE') && has(cInIf, 'ELSIF') && snippetsOf(cInIf).includes('ELSIF'),
        `inside an open IF, END_IF / ELSE / ELSIF (keyword and snippet) are offered (${cInIf.length} items)`);
    assert(!has(cInIf, 'END_CASE') && !has(cInIf, 'END_FOR') && !has(cInIf, 'END_WHILE') && !has(cInIf, 'UNTIL'),
        '…and only those — no terminator of a block that is not open');

    // ---- 7. VALUE position: `nTotal := ▮` ----------------------------------------------------------
    const cVal = record('value (after ":=")', completionsAt('MAIN.TcPOU', MAIN_XML, 'nTotal := '));
    assert(!has(cVal, 'END_VAR') && !has(cVal, 'END_IF') && !has(cVal, 'END_CASE'),
        `value position offers no block terminator (${cVal.length} items)`);
    assert(snippetsOf(cVal).length === 0,
        `…and no snippets (got [${snippetsOf(cVal).join(', ')}])`);
    assert(!has(cVal, 'VAR') && !has(cVal, 'VAR_INPUT') && !has(cVal, 'METHOD') && !has(cVal, 'IF'),
        '…and no declaration or statement keywords');
    assert(has(cVal, 'nCount') && has(cVal, 'fbMotor') && has(cVal, 'g_bRunning') && has(cVal, 'GVL_System'),
        '…while variables, FB instances and globals are all offered');
    assert(has(cVal, 'TRUE') && has(cVal, 'FALSE') && has(cVal, 'NOT'),
        '…plus the literals and NOT that may open an expression');
    assert(has(cVal, 'eIdle') && has(cVal, 'E_State'),
        '…and the enum members / enum names an expression may name');

    // ---- 8. VALUE position in a declaration initializer: `nInit : INT := ▮` ------------------------
    const cInit = record('value (VAR initializer)', completionsAt('MAIN.TcPOU', MAIN_XML, 'nInit : INT := '));
    assert(!has(cInit, 'END_VAR') && !has(cInit, 'END_IF') && snippetsOf(cInit).length === 0,
        `an initializer inside a VAR block is a value position, not a name (${cInit.length} items)`);
    assert(has(cInit, 'g_nCycle') && has(cInit, 'TRUE'),
        '…and offers what a value may be');

    // ---- 9. VALUE position whose target is an enum: `eState := ▮` ----------------------------------
    const cEnumVal = record('value (enum target)', completionsAt('MAIN.TcPOU', MAIN_XML, 'eState := '));
    const rankedVal = rankedFirst(cEnumVal);
    assert(rankedVal.includes('eIdle') && rankedVal.includes('eRun') && rankedVal.includes('eStop'),
        `eState := ▮ ranks the target enum's members first (got [${rankedVal.join(', ')}])`);
    assert(!has(cEnumVal, 'END_VAR') && !has(cEnumVal, 'END_IF'),
        '…and still offers no block terminator');

    // ---- 10. CASE label: the fresh line after `CASE eState OF` --------------------------------------
    const cCase = record('caseLabel (after OF)', completionsAtLineStart('MAIN.TcPOU', MAIN_XML, '\teIdle:'));
    const rankedCase = rankedFirst(cCase);
    assert(rankedCase.includes('eIdle') && rankedCase.includes('eRun') && rankedCase.includes('eStop'),
        `CASE eState OF ▮ offers the selector's enum members, ranked first (got [${rankedCase.join(', ')}])`);
    assert(!has(cCase, 'END_IF') && !has(cCase, 'END_VAR') && snippetsOf(cCase).length === 0,
        `…and nothing that cannot be a label (${cCase.length} items)`);
    assert(!has(cCase, 'INT') && !has(cCase, 'nCount'),
        '…no elementary types, no variables');

    // ---- 11. Inside a CASE body a label may begin as readily as a statement ------------------------
    const cCaseBody = record('statement (inside CASE)', completionsAt('MAIN.TcPOU', MAIN_XML, '\t\tnCount := 1;'));
    assert(rankedFirst(cCaseBody).includes('eIdle'),
        `inside the CASE body the selector's members still rank first (got [${rankedFirst(cCaseBody).join(', ')}])`);
    assert(has(cCaseBody, 'END_CASE') && !has(cCaseBody, 'END_IF'),
        '…END_CASE is offered (its block is open) and END_IF is not (its block is not)');
    assert(snippetsOf(cCaseBody).length > 0 && has(cCaseBody, 'nTotal'),
        '…and a statement is possible here too, so snippets and variables remain');

    // ---- 12. Partially typed identifiers still complete in every context ----------------------------
    // The caret is mid-word by definition; the word under it is what is being completed, not context.
    const pType = record('type (partial "IN")', completionsAt('P1.TcPOU',
        tcpou('P1', 'PROGRAM P1\nVAR\n\tnPartial : IN\nEND_VAR', ''), 'nPartial : IN'));
    assert(has(pType, 'INT') && leaked(pType, JUNK) === '',
        `"nPartial : IN▮" still completes INT, still no junk (${pType.length} items)`);

    const pValue = record('value (partial "g_")', completionsAt('P2.TcPOU',
        tcpou('P2', 'PROGRAM P2\nVAR\n\tn : INT;\nEND_VAR', 'n := g_'), 'n := g_'));
    assert(has(pValue, 'g_bRunning') && !has(pValue, 'END_VAR') && !has(pValue, 'END_IF'),
        `"n := g_▮" still completes the global, still no terminators (${pValue.length} items)`);

    // (the instance is named fbDrive so that the marker 'fbM' cannot also match its declaration line)
    const pStmt = record('statement (partial "fbM")', completionsAt('P3.TcPOU',
        tcpou('P3', 'PROGRAM P3\nVAR\n\tfbDrive : FB_Motor;\n\tn : INT;\nEND_VAR', 'n := 0;\nfbM'), 'fbM'));
    assert(has(pStmt, 'fbDrive') && snippetsOf(pStmt).length > 0 && !has(pStmt, 'END_IF'),
        `"fbM▮" at a statement start still completes the instance (${pStmt.length} items)`);

    // ---- 13. Garbled / unparseable code: never crash, fall back gracefully --------------------------
    const garbled = tcpou('P4', 'PROGRAM P4\nVAR\n\tn : INT;\nEND_VAR',
        "n := (((%%% 'unterminated\nn := ((\nCASE ) OF ;;;\n");
    const cG1 = record('garbled (broken expr)', completionsAt('P4.TcPOU', garbled, 'n := (('));
    assert(Array.isArray(cG1) && cG1.length > 0,
        `a broken expression yields a usable list instead of a crash (${cG1.length} items)`);
    const cG2 = record('garbled (broken CASE)', completionsAt('P4.TcPOU', garbled, 'CASE ) OF'));
    assert(Array.isArray(cG2),
        `a broken CASE header does not crash the classifier (${cG2.length} items)`);

    // An empty implementation: the caret has no prefix at all.
    const cEmpty = completionsAt('P5.TcPOU', tcpou('P5', 'PROGRAM P5\nVAR\n\tn : INT;\nEND_VAR', ''), 'PROGRAM');
    assert(Array.isArray(cEmpty) && cEmpty.length > 0,
        `a caret with no usable prefix falls back to the full list (${cEmpty.length} items)`);

    // ---- The numbers ------------------------------------------------------------------------------
    const blind = counts['unknown (fallback)'];
    console.log(`\nItems offered per context (context-blind baseline: ${blind}):`);
    Object.keys(counts).forEach(name => {
        const n = counts[name];
        const delta = n - blind;
        console.log(`  ${name.padEnd(28)} ${String(n).padStart(4)}   (${delta >= 0 ? '+' : ''}${delta})`);
    });
} finally {
    clearWorkspaceIndex();
    fs.rmSync(dir, { recursive: true, force: true });
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll caret-context completion assertions passed.');
