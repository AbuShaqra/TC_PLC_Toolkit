/**
 * @file test_fb_init_def.js
 * @description Go-to-definition on the *named arguments* of a declaration-site FB initialization.
 *
 * TwinCAT has two syntaxes that look alike but bind to entirely different declarations:
 *
 *   inst : FB_Type(p := v);        parentheses directly after the type — these are arguments of the
 *                                  FB's **FB_init METHOD**, so `p` is one of FB_init's VAR_INPUT.
 *   inst : FB_Type := (p := v);    ':=' before the parenthesis — structured initialization, so `p`
 *                                  is one of the **FB's own** VAR_INPUT / VAR_IN_OUT.
 *
 * The names can coincide (the real FB_HMI_X_Achse declares both `VAR ipAxis` and an FB_init
 * `VAR_INPUT ipAxis`), which is what masked the bug: the first form used to jump to the FB's own
 * member. It must land on FB_init's parameter — in the node that actually *declares* FB_init, since
 * FB_init may be inherited from a base FB.
 *
 * Note this is only about picking the right *target*. Diagnostics deliberately accept the union of
 * both parameter sets (see getInitParams in types.js and scratch/test_fb_init.js) — unchanged here.
 *
 * Self-contained: builds synthetic TwinCAT XML in a temp dir; no sample/ dependency.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideDefinition } = require('../src/lsp/features');
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

/** 1-based line of the first line matching `re` in a CDATA block. */
function lineOf(text, re) {
    return text.split('\n').findIndex(l => re.test(l)) + 1;
}

// ---------------------------------------------------------------------------------------------
// The synthetic workspace.
// ---------------------------------------------------------------------------------------------

// FB_Axis mirrors FB_HMI_X_Achse: an own `VAR ipAxis` AND an FB_init `VAR_INPUT ipAxis`.
const FB_AXIS_DECL =
    'FUNCTION_BLOCK FB_Axis\n' +
    'VAR_INPUT\n\tbOwnInput : BOOL;\nEND_VAR\n' +
    'VAR\n\tipAxis : I_Drive;\n\tbBusy : BOOL;\nEND_VAR';
const FB_AXIS_INIT_DECL =
    'METHOD FB_init : BOOL\n' +
    'VAR_INPUT\n' +
    '\tbInitRetains : BOOL;\n' +
    '\tbInCopyCode : BOOL;\n' +
    '\tipAxis : I_Drive;\n' +
    'END_VAR';

// FB_init lives on the base only; the derived FB declares none of its own.
const FB_BASE_DECL = 'FUNCTION_BLOCK FB_Base\nVAR\n\tnIdStored : INT;\nEND_VAR';
const FB_BASE_INIT_DECL =
    'METHOD FB_init : BOOL\n' +
    'VAR_INPUT\n\tbInitRetains : BOOL;\n\tbInCopyCode : BOOL;\n\tnId : INT;\nEND_VAR';

const FILES = {
    'GVL_System.TcGVL': tcgvl('GVL_System', 'VAR_GLOBAL\n\tfbAxisX : I_Drive;\nEND_VAR'),

    'FB_Axis.TcPOU': tcpou('FB_Axis', FB_AXIS_DECL, '', [
        { name: 'FB_init', decl: FB_AXIS_INIT_DECL, impl: 'THIS^.ipAxis := ipAxis;' }
    ]),

    'FB_Base.TcPOU': tcpou('FB_Base', FB_BASE_DECL, '', [
        { name: 'FB_init', decl: FB_BASE_INIT_DECL, impl: '' }
    ]),
    'FB_Derived.TcPOU': tcpou('FB_Derived',
        'FUNCTION_BLOCK FB_Derived EXTENDS FB_Base\nVAR\n\tbFlag : BOOL;\nEND_VAR', ''),

    // Its base is NOT in the index — nothing about it can be resolved with certainty.
    'FB_Orphan.TcPOU': tcpou('FB_Orphan',
        'FUNCTION_BLOCK FB_Orphan EXTENDS FB_ExternalLibBase\nVAR\n\tbFlag : BOOL;\nEND_VAR', '')
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_fbinitdef_'));
const uriOf = (f) => 'file:///' + path.join(dir, f).replace(/\\/g, '/');

// Where the two rival `ipAxis` declarations live, in their own component's declaration pane.
const OWN_IPAXIS_LINE = lineOf(FB_AXIS_DECL, /^\tipAxis\b/);
const INIT_IPAXIS_LINE = lineOf(FB_AXIS_INIT_DECL, /^\tipAxis\b/);
const OWN_INPUT_LINE = lineOf(FB_AXIS_DECL, /^\tbOwnInput\b/);
const BASE_NID_LINE = lineOf(FB_BASE_INIT_DECL, /^\tnId\b/);

/**
 * Runs go-to-definition on a word inside a synthetic document, exactly the way the LSP server does:
 * the whole workspace is indexed from XML first, then the active document is re-parsed from its raw
 * ST unit (parseAndIndexDocument) before the request is answered.
 * @param {string} fileName Name of the active document.
 * @param {string} xml Its TwinCAT XML.
 * @param {RegExp} lineRe Matches the line of the ST unit holding the word.
 * @param {string} word Word to resolve (first occurrence on that line).
 * @returns {Object|null} LSP Location with { uri, range, componentId }, or null.
 */
function defineAt(fileName, xml, lineRe, word) {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    for (const f of Object.keys(FILES)) indexXmlObject(index, FILES[f], uriOf(f));
    indexXmlObject(index, xml, uriOf(fileName));

    // raw:true is what the live editor path uses — the "clean" conversion strips init lists.
    const { stText } = convertXmlToSt(parseTwinCatXml(xml), { raw: true });
    parseAndIndexDocument(stText, uriOf(fileName));

    const lines = stText.split('\n');
    const lineIdx = lines.findIndex(l => lineRe.test(l));
    if (lineIdx === -1) throw new Error(`test bug: no ST line matches ${lineRe}`);
    const character = lines[lineIdx].indexOf(word) + 1; // inside the word
    if (character === 0) throw new Error(`test bug: '${word}' not on line ${lineRe}`);

    return provideDefinition(stText, { line: lineIdx, character }, getWorkspaceSymbolIndex(), uriOf(fileName));
}

/** Prints a definition result, for failure triage. */
function dump(label, def) {
    if (!def) { console.log(`       (${label}) -> null`); return; }
    const f = path.basename(def.uri);
    console.log(`       (${label}) -> ${f} [${def.componentId}] L${def.range.start.line + 1}`);
}

try {
    // ---- 1. Declaration-site FB_init list: `inst : FB_Type(ipAxis := x)` ------------------------
    // THE BUG: this used to land on FB_Axis's own `VAR ipAxis` (componentId 'root').
    const d1 = defineAt('MAIN.TcPOU', tcpou('MAIN',
        'PROGRAM MAIN\nVAR\n\tfbA : FB_Axis(ipAxis := GVL_System.fbAxisX);\nEND_VAR', ''),
        /FB_Axis\(ipAxis/, 'ipAxis');
    dump('FB_init arg', d1);
    assert(!!d1 && d1.componentId === 'method_FB_init',
        `FB_Type(ipAxis := x) opens the FB_init component (got ${d1 && d1.componentId})`);
    assert(!!d1 && d1.range.start.line + 1 === INIT_IPAXIS_LINE,
        `…at FB_init's parameter, decl line ${INIT_IPAXIS_LINE} (got ${d1 && d1.range.start.line + 1}); ` +
        `the FB's own ipAxis is at line ${OWN_IPAXIS_LINE}`);
    assert(!!d1 && path.basename(d1.uri) === 'FB_Axis.TcPOU',
        `…in FB_Axis.TcPOU (got ${d1 && path.basename(d1.uri)})`);

    // ---- 2. Structured init `inst : FB_Type := (p := v)` → the FB's OWN VAR_INPUT ---------------
    const d2 = defineAt('MAIN2.TcPOU', tcpou('MAIN2',
        'PROGRAM MAIN2\nVAR\n\tfbS : FB_Axis := (bOwnInput := TRUE);\nEND_VAR', ''),
        /:= \(bOwnInput/, 'bOwnInput');
    dump('structured init', d2);
    assert(!!d2 && d2.componentId === 'root' && d2.range.start.line + 1 === OWN_INPUT_LINE,
        `FB_Type := (bOwnInput := TRUE) still resolves to the FB's own VAR_INPUT ` +
        `(root, line ${OWN_INPUT_LINE}; got ${d2 && d2.componentId}, line ${d2 && d2.range.start.line + 1})`);

    // ---- 3. An ordinary statement call on an instance → the FB's OWN VAR_INPUT ------------------
    const d3 = defineAt('FB_Caller.TcPOU', tcpou('FB_Caller',
        'FUNCTION_BLOCK FB_Caller\nVAR\n\tfbInst : FB_Axis;\nEND_VAR',
        'fbInst(bOwnInput := TRUE);'),
        /^fbInst\(bOwnInput/, 'bOwnInput');
    dump('statement call', d3);
    assert(!!d3 && d3.componentId === 'root' && d3.range.start.line + 1 === OWN_INPUT_LINE,
        `a statement call fbInst(bOwnInput := TRUE) still resolves to the FB's own VAR_INPUT ` +
        `(got ${d3 && d3.componentId}, line ${d3 && d3.range.start.line + 1})`);

    // The same call behind a CASE label: the ':' before the callee must NOT be mistaken for a
    // declaration `inst : FB_Type(`. The callee there is an *instance*, not a type name.
    const d4 = defineAt('FB_Case.TcPOU', tcpou('FB_Case',
        'FUNCTION_BLOCK FB_Case\nVAR\n\tfbInst : FB_Axis;\n\tnStep : INT;\nEND_VAR',
        'CASE nStep OF\n1: fbInst(bOwnInput := TRUE);\nEND_CASE'),
        /^1: fbInst\(bOwnInput/, 'bOwnInput');
    dump('CASE label call', d4);
    assert(!!d4 && d4.componentId === 'root' && d4.range.start.line + 1 === OWN_INPUT_LINE,
        `a CASE-label call "1: fbInst(bOwnInput := TRUE)" is still an instance call ` +
        `(got ${d4 && d4.componentId}, line ${d4 && d4.range.start.line + 1})`);

    // ---- 4. FB_init inherited from a base FB → jump into the BASE ------------------------------
    const d5 = defineAt('MAIN3.TcPOU', tcpou('MAIN3',
        'PROGRAM MAIN3\nVAR\n\tfbD : FB_Derived(nId := 7);\nEND_VAR', ''),
        /FB_Derived\(nId/, 'nId');
    dump('inherited FB_init', d5);
    assert(!!d5 && path.basename(d5.uri) === 'FB_Base.TcPOU',
        `an inherited FB_init resolves into the base FB's file (got ${d5 && path.basename(d5.uri)})`);
    assert(!!d5 && d5.componentId === 'method_FB_init' && d5.range.start.line + 1 === BASE_NID_LINE,
        `…at FB_Base's FB_init parameter, decl line ${BASE_NID_LINE} ` +
        `(got ${d5 && d5.componentId}, line ${d5 && d5.range.start.line + 1})`);

    // ---- 5. Unresolvable FBs: never invent a target, never crash --------------------------------
    // An FB whose base is not indexed: FB_init may exist but be invisible ⇒ no bogus target.
    const d6 = defineAt('MAIN4.TcPOU', tcpou('MAIN4',
        'PROGRAM MAIN4\nVAR\n\tfbO : FB_Orphan(whoKnows := TRUE);\nEND_VAR', ''),
        /FB_Orphan\(whoKnows/, 'whoKnows');
    dump('orphan base', d6);
    assert(d6 === null, `an FB with an unindexed base yields no definition (got ${JSON.stringify(d6)})`);

    // An entirely unknown (library) FB type.
    const d7 = defineAt('MAIN5.TcPOU', tcpou('MAIN5',
        'PROGRAM MAIN5\nVAR\n\tfbX : FB_SomeLibraryBlock(sNetId := \'1.2.3\');\nEND_VAR', ''),
        /FB_SomeLibraryBlock\(sNetId/, 'sNetId');
    dump('library FB', d7);
    assert(d7 === null, `an unindexed library FB yields no definition (got ${JSON.stringify(d7)})`);

    // A bogus argument name on a fully-resolved FB: not an FB_init parameter and not an own member.
    const d8 = defineAt('MAIN6.TcPOU', tcpou('MAIN6',
        'PROGRAM MAIN6\nVAR\n\tfbA : FB_Axis(refNoSuchThing := TRUE);\nEND_VAR', ''),
        /FB_Axis\(refNoSuchThing/, 'refNoSuchThing');
    dump('bogus arg', d8);
    assert(d8 === null, `a bogus argument name yields no definition (got ${JSON.stringify(d8)})`);
} finally {
    clearWorkspaceIndex();
    fs.rmSync(dir, { recursive: true, force: true });
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll FB_init go-to-definition assertions passed.');
