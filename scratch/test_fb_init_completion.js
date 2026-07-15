/**
 * @file test_fb_init_completion.js
 * @description Named-parameter autocomplete inside a call's parentheses.
 *
 * Three syntaxes put the caret between parentheses, and each binds its argument names to a
 * *different* declaration (the same rule provideDefinition follows — see test_fb_init_def.js):
 *
 *   inst : FB_Type(<caret>)       arguments of the FB's **FB_init METHOD** — FB_init's VAR_INPUT.
 *   inst : FB_Type := (<caret>)   structured init — the **FB's own** VAR_INPUT.
 *   fbInst(<caret>)               ordinary call — the instance's VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT.
 *
 * Structured init also applies to a **struct DUT** — `st : ST_T := (<caret>)` — where the same
 * syntax reaches the struct's FIELDS instead. An **enum** DUT is not field initialization and must
 * therefore stay out of it.
 *
 * The names can coincide (FB_T declares both `VAR ipAxis` and an FB_init `VAR_INPUT ipAxis`), which
 * is exactly why the completion list must be built from the right one.
 *
 * Two invariants beyond "the right names appear":
 *   - ADDITIVE: injecting parameter names must not *cost* the user the ordinary suggestions. Both
 *     carets inside the parentheses still get the value list (variables, globals, project symbols,
 *     enum members, TRUE/FALSE/NULL); parameters merely sort to the top of it.
 *   - CONSERVATIVE: an FB (or FB_init, or ancestor) that cannot be resolved yields *no* parameter
 *     suggestions rather than invented ones.
 *
 * Both carets also have to be *clean*. Everything writable between the parentheses is an expression
 * — the argument VALUE after `:=` / `=>`, and, at the argument-NAME caret, a POSITIONAL argument. So
 * `IF`, `END_VAR`, `END_IF` and the control-flow snippets are not merely useless in there, they are
 * illegal. They used to be offered at both (the caret sits inside parentheses, which the context
 * classifier could not read), and the negative assertions below are what keeps them out.
 *
 * Self-contained: builds synthetic TwinCAT XML in a temp dir; no sample/ dependency.
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

// FB_T mirrors the real FB_HMI_X_Achse: an own `VAR ipAxis` AND an FB_init `VAR_INPUT ipAxis`.
const FB_T_DECL =
    'FUNCTION_BLOCK FB_T\n' +
    'VAR_INPUT\n\tbOwnInput : BOOL;\nEND_VAR\n' +
    'VAR\n\tipAxis : I_Axis;\n\tnInternal : INT;\nEND_VAR';
const FB_T_INIT_DECL =
    'METHOD FB_init : BOOL\n' +
    'VAR_INPUT\n' +
    '\tbInitRetains : BOOL;\n' +
    '\tbInCopyCode : BOOL;\n' +
    '\tipAxis : I_Axis;\n' +
    '\tnSlaveAddr : INT;\n' +
    'END_VAR';

// FB_init lives on the base only; the derived FB declares none of its own.
const FB_BASE_DECL = 'FUNCTION_BLOCK FB_Base\nVAR\n\tnIdStored : INT;\nEND_VAR';
const FB_BASE_INIT_DECL =
    'METHOD FB_init : BOOL\n' +
    'VAR_INPUT\n\tbInitRetains : BOOL;\n\tbInCopyCode : BOOL;\n\tnId : INT;\nEND_VAR';

const FILES = {
    'GVL_System.TcGVL': tcgvl('GVL_System', 'VAR_GLOBAL\n\tfbAxisX : I_Axis;\nEND_VAR'),

    'FB_T.TcPOU': tcpou('FB_T', FB_T_DECL, '', [
        { name: 'FB_init', decl: FB_T_INIT_DECL, impl: 'THIS^.ipAxis := ipAxis;' }
    ]),

    'FB_Base.TcPOU': tcpou('FB_Base', FB_BASE_DECL, '', [
        { name: 'FB_init', decl: FB_BASE_INIT_DECL, impl: '' }
    ]),
    'FB_Derived.TcPOU': tcpou('FB_Derived',
        'FUNCTION_BLOCK FB_Derived EXTENDS FB_Base\nVAR\n\tbFlag : BOOL;\nEND_VAR', ''),

    // Its base is NOT in the index — nothing about it can be resolved with certainty.
    'FB_Orphan.TcPOU': tcpou('FB_Orphan',
        'FUNCTION_BLOCK FB_Orphan EXTENDS FB_ExternalLibBase\nVAR\n\tbFlag : BOOL;\nEND_VAR', ''),

    // Struct DUTs — structured initialization of these targets their fields.
    'ST_T.TcDUT': tcdut('ST_T',
        'TYPE ST_T :\nSTRUCT\n\tnSpeed : INT;\n\tbEnable : BOOL;\n\tsName : STRING;\nEND_STRUCT\nEND_TYPE'),
    'ST_Base.TcDUT': tcdut('ST_Base',
        'TYPE ST_Base :\nSTRUCT\n\tnBaseId : INT;\nEND_STRUCT\nEND_TYPE'),
    'ST_Derived.TcDUT': tcdut('ST_Derived',
        'TYPE ST_Derived EXTENDS ST_Base :\nSTRUCT\n\tbDerivedFlag : BOOL;\nEND_STRUCT\nEND_TYPE'),
    // Its base is NOT in the index — its own fields are still certain, the inherited ones are not.
    'ST_Orphan.TcDUT': tcdut('ST_Orphan',
        'TYPE ST_Orphan EXTENDS ST_ExternalLibBase :\nSTRUCT\n\tnOwnField : INT;\nEND_STRUCT\nEND_TYPE'),

    // An enum DUT: `e : E_T := (…)` is NOT structured init of fields.
    'E_T.TcDUT': tcdut('E_T', 'TYPE E_T :\n(\n\teIdle := 0,\n\teRun,\n\teStop\n);\nEND_TYPE')
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_fbinitcompl_'));
const uriOf = (f) => 'file:///' + path.join(dir, f).replace(/\\/g, '/');

/**
 * Runs completions inside a synthetic document exactly the way the LSP server does: the whole
 * workspace is indexed from XML first, then the active document is re-parsed from its raw ST unit
 * (parseAndIndexDocument) before the request is answered.
 *
 * The caret is placed immediately after the first occurrence of `marker` in the ST unit — so the
 * marker's trailing characters ('(' , ', ', 'ipA', ':= ') decide the completion context.
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

/** Labels of the items the feature injected as named parameters (they alone carry the '00_' sortText). */
function paramLabels(items) {
    return items.filter(i => i.sortText && i.sortText.startsWith('00_')).map(i => i.label);
}

/** Every label offered, parameters and generic scope suggestions alike. */
function allLabels(items) {
    return items.map(i => i.label);
}

/**
 * True when the ordinary suggestions an argument can be *written from* are still in the list — the
 * additive-not-subtractive rule. It asks for what a value position actually accepts: a GVL, a global
 * variable, a project symbol. It deliberately does NOT ask for `IF` or `BOOL`: a statement keyword
 * and a type name are not values, and at the value caret their absence is the point (see
 * hasNoStatementJunk). Both carets must satisfy this.
 */
function hasValueCompletions(items) {
    const labels = allLabels(items);
    return labels.includes('GVL_System') && labels.includes('fbAxisX') && labels.includes('FB_T');
}

/**
 * True when nothing that is illegal at an argument-*value* position is being offered: block
 * keywords, declaration keywords, and the control-flow snippets that insert them.
 */
function hasNoStatementJunk(items) {
    const labels = allLabels(items);
    return !labels.includes('IF') && !labels.includes('END_VAR') && !labels.includes('END_IF')
        && !items.some(i => i.kind === 27 /* Snippet */);
}

/** Prints a completion result, for failure triage. */
function dump(label, items) {
    const params = paramLabels(items);
    console.log(`       (${label}) ${items.length} items; params: [${params.join(', ')}]`);
}

try {
    // ---- 1. Declaration-site FB_init list: `fb : FB_T(<caret>)` ---------------------------------
    // THE ASK: offer FB_init's VAR_INPUT, not the FB's own members.
    const c1 = completionsAt('MAIN.TcPOU', tcpou('MAIN',
        'PROGRAM MAIN\nVAR\n\tfb : FB_T();\nEND_VAR', ''), 'FB_T(');
    dump('FB_init list', c1);
    const p1 = paramLabels(c1);
    assert(p1.includes('ipAxis') && p1.includes('nSlaveAddr'),
        `fb : FB_T(<caret>) offers FB_init's params ipAxis + nSlaveAddr (got [${p1.join(', ')}])`);
    assert(!p1.includes('bInitRetains') && !p1.includes('bInCopyCode'),
        `…and hides the runtime-supplied bInitRetains / bInCopyCode (got [${p1.join(', ')}])`);
    assert(!p1.includes('bOwnInput') && !p1.includes('nInternal'),
        `…and does not offer the FB's own members as FB_init params (got [${p1.join(', ')}])`);
    assert(hasValueCompletions(c1),
        `…while the ordinary suggestions survive — the same caret may be a positional argument (${c1.length} items)`);
    // …and that positional argument is an EXPRESSION, so the argument-name caret is a value position
    // too: a parameter name or a value, never a statement. This is the caret that used to dump the
    // whole context-blind list (~150 items, IF / END_VAR / snippets included).
    assert(hasNoStatementJunk(c1),
        `…and offers no IF / END_VAR / END_IF / snippet — an argument is never a statement (${c1.length} items)`);
    assert(allLabels(c1).includes('eIdle') && allLabels(c1).includes('fb') && allLabels(c1).includes('TRUE'),
        `…while enum members, the scope's own variables and TRUE/FALSE/NULL are all offered (${c1.length} items)`);

    // The parameters must sort ahead of every generic item.
    const key = (i) => i.sortText || i.label;
    const sorted = c1.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const top = sorted.slice(0, p1.length).map(i => i.label).sort();
    assert(JSON.stringify(top) === JSON.stringify(p1.slice().sort()),
        `…and rank above every generic item (top ${p1.length} by sortText: [${top.join(', ')}])`);

    // ---- 2. Structured init `fb : FB_T := (<caret>)` → the FB's OWN VAR_INPUT -------------------
    const c2 = completionsAt('MAIN2.TcPOU', tcpou('MAIN2',
        'PROGRAM MAIN2\nVAR\n\tfb : FB_T := ();\nEND_VAR', ''), 'FB_T := (');
    dump('structured init', c2);
    const p2 = paramLabels(c2);
    assert(p2.includes('bOwnInput'),
        `fb : FB_T := (<caret>) offers the FB's own VAR_INPUT bOwnInput (got [${p2.join(', ')}])`);
    assert(!p2.includes('nSlaveAddr'),
        `…and NOT FB_init's params — a different binding (got [${p2.join(', ')}])`);
    assert(!p2.includes('nInternal'),
        `…and not the FB's plain VAR members either (got [${p2.join(', ')}])`);

    // ---- 3. Statement call `fbInst(<caret>)` → the instance's own inputs ------------------------
    const c3 = completionsAt('FB_Caller.TcPOU', tcpou('FB_Caller',
        'FUNCTION_BLOCK FB_Caller\nVAR\n\tfbInst : FB_T;\nEND_VAR',
        'fbInst();'), 'fbInst(');
    dump('statement call', c3);
    const p3 = paramLabels(c3);
    assert(p3.includes('bOwnInput'),
        `fbInst(<caret>) offers the instance's own VAR_INPUT bOwnInput (got [${p3.join(', ')}])`);
    assert(!p3.includes('nSlaveAddr'),
        `…and not FB_init's params (got [${p3.join(', ')}])`);

    // ---- 4. A partially typed argument name still resolves --------------------------------------
    const c4 = completionsAt('MAIN4.TcPOU', tcpou('MAIN4',
        'PROGRAM MAIN4\nVAR\n\tfb : FB_T(ipA);\nEND_VAR', ''), 'FB_T(ipA');
    dump('partial name', c4);
    assert(paramLabels(c4).includes('ipAxis'),
        `fb : FB_T(ipA<caret>) still offers ipAxis (got [${paramLabels(c4).join(', ')}])`);

    // ---- 5. The argument VALUE side: no parameter names, and no statement junk either ------------
    // An argument value is an *expression*. `IF` / `END_VAR` / `END_IF` / a snippet cannot be written
    // there at all, and the whole point of classifying the caret is that they are not offered.
    const c5 = completionsAt('MAIN5.TcPOU', tcpou('MAIN5',
        'PROGRAM MAIN5\nVAR\n\tfb : FB_T(ipAxis := GVL_System.fbAxisX);\nEND_VAR', ''), 'FB_T(ipAxis := ');
    dump('value side', c5);
    assert(paramLabels(c5).length === 0,
        `fb : FB_T(ipAxis := <caret>) injects no parameter names (got [${paramLabels(c5).join(', ')}])`);
    assert(hasNoStatementJunk(c5),
        `…and offers no IF / END_VAR / END_IF / snippet — none of them is a value (${c5.length} items)`);
    assert(hasValueCompletions(c5),
        `…while everything a value can be made of is still there (${c5.length} items)`);
    assert(allLabels(c5).includes('eIdle'),
        `…including enum members (got ${allLabels(c5).includes('eIdle') ? 'eIdle' : 'no eIdle'})`);
    assert(allLabels(c5).includes('fb') && allLabels(c5).includes('TRUE'),
        `…and the scope's own variables plus TRUE/FALSE/NULL (${c5.length} items)`);

    // ---- 6. FB_init inherited from a base FB ----------------------------------------------------
    const c6 = completionsAt('MAIN6.TcPOU', tcpou('MAIN6',
        'PROGRAM MAIN6\nVAR\n\tfbD : FB_Derived();\nEND_VAR', ''), 'FB_Derived(');
    dump('inherited FB_init', c6);
    assert(paramLabels(c6).includes('nId'),
        `fbD : FB_Derived(<caret>) offers the base FB_init's nId (got [${paramLabels(c6).join(', ')}])`);
    assert(!paramLabels(c6).includes('bInitRetains'),
        `…still without the implicit params (got [${paramLabels(c6).join(', ')}])`);

    // ---- 7. Unresolvable FBs: offer nothing, never invent, never crash --------------------------
    // An entirely unknown (library) FB type.
    const c7 = completionsAt('MAIN7.TcPOU', tcpou('MAIN7',
        'PROGRAM MAIN7\nVAR\n\tfbX : FB_SomeLibraryBlock();\nEND_VAR', ''), 'FB_SomeLibraryBlock(');
    dump('library FB', c7);
    assert(paramLabels(c7).length === 0,
        `an unindexed library FB offers no parameters (got [${paramLabels(c7).join(', ')}])`);
    assert(hasValueCompletions(c7), `…and the ordinary suggestions are intact (${c7.length} items)`);

    // An FB whose base is not indexed: FB_init may exist but be invisible ⇒ nothing is certain.
    const c8 = completionsAt('MAIN8.TcPOU', tcpou('MAIN8',
        'PROGRAM MAIN8\nVAR\n\tfbO : FB_Orphan();\nEND_VAR', ''), 'FB_Orphan(');
    dump('orphan base', c8);
    assert(paramLabels(c8).length === 0,
        `an FB with an unindexed base offers no parameters (got [${paramLabels(c8).join(', ')}])`);
    assert(hasValueCompletions(c8), `…and the ordinary suggestions are intact (${c8.length} items)`);

    // ---- 8. A CASE label is not a declaration ---------------------------------------------------
    // `1: fbInst(` — the ':' before the callee must not make this look like `inst : FB_Type(`.
    const c9 = completionsAt('FB_Case.TcPOU', tcpou('FB_Case',
        'FUNCTION_BLOCK FB_Case\nVAR\n\tfbInst : FB_T;\n\tnStep : INT;\nEND_VAR',
        'CASE nStep OF\n1: fbInst();\nEND_CASE'), '1: fbInst(');
    dump('CASE label call', c9);
    const p9 = paramLabels(c9);
    assert(p9.includes('bOwnInput') && !p9.includes('nSlaveAddr'),
        `"1: fbInst(<caret>)" is an instance call, not an FB_init list (got [${p9.join(', ')}])`);

    // ---- 9. Structured init of a STRUCT `st : ST_T := (<caret>)` → the struct's FIELDS -----------
    const s1 = completionsAt('MAIN10.TcPOU', tcpou('MAIN10',
        'PROGRAM MAIN10\nVAR\n\tst : ST_T := ();\nEND_VAR', ''), 'ST_T := (');
    dump('struct init', s1);
    const q1 = paramLabels(s1);
    assert(q1.includes('nSpeed') && q1.includes('bEnable') && q1.includes('sName'),
        `st : ST_T := (<caret>) offers every struct field (got [${q1.join(', ')}])`);
    assert(hasValueCompletions(s1),
        `…while the ordinary suggestions survive — the same caret may be a positional field (${s1.length} items)`);
    assert(hasNoStatementJunk(s1),
        `…and offers no IF / END_VAR / END_IF / snippet — a field initializer is not a statement (${s1.length} items)`);

    // The fields must sort ahead of every generic item, exactly like FB parameters do.
    const skey = (i) => i.sortText || i.label;
    const ssorted = s1.slice().sort((a, b) => (skey(a) < skey(b) ? -1 : skey(a) > skey(b) ? 1 : 0));
    const stop = ssorted.slice(0, q1.length).map(i => i.label).sort();
    assert(JSON.stringify(stop) === JSON.stringify(q1.slice().sort()),
        `…and rank above every generic item (top ${q1.length} by sortText: [${stop.join(', ')}])`);

    // ---- 10. A partially typed field name still resolves -----------------------------------------
    const s2 = completionsAt('MAIN11.TcPOU', tcpou('MAIN11',
        'PROGRAM MAIN11\nVAR\n\tst : ST_T := (nSp);\nEND_VAR', ''), 'ST_T := (nSp');
    dump('struct partial name', s2);
    assert(paramLabels(s2).includes('nSpeed'),
        `st : ST_T := (nSp<caret>) still offers nSpeed (got [${paramLabels(s2).join(', ')}])`);

    // ---- 11. The field VALUE side: no field names, and no statement junk either -------------------
    // Same rule as the FB_init argument value (test 5) — and reached by the same classifier branch,
    // which is why both shapes are pinned: the init list is inside a VAR block, so a regression there
    // shows up as declaration keywords being offered mid-expression.
    const s3 = completionsAt('MAIN12.TcPOU', tcpou('MAIN12',
        'PROGRAM MAIN12\nVAR\n\tst : ST_T := (nSpeed := 100);\nEND_VAR', ''), 'ST_T := (nSpeed := ');
    dump('struct value side', s3);
    assert(paramLabels(s3).length === 0,
        `st : ST_T := (nSpeed := <caret>) injects no field names (got [${paramLabels(s3).join(', ')}])`);
    assert(hasNoStatementJunk(s3),
        `…and offers no IF / END_VAR / END_IF / snippet — none of them is a value (${s3.length} items)`);
    assert(hasValueCompletions(s3),
        `…while everything a value can be made of is still there (${s3.length} items)`);
    assert(allLabels(s3).includes('eIdle') && allLabels(s3).includes('st'),
        `…including enum members and the scope's own variables (${s3.length} items)`);

    // ---- 12. A struct that EXTENDS another inherits its fields ------------------------------------
    const s4 = completionsAt('MAIN13.TcPOU', tcpou('MAIN13',
        'PROGRAM MAIN13\nVAR\n\tstD : ST_Derived := ();\nEND_VAR', ''), 'ST_Derived := (');
    dump('struct EXTENDS', s4);
    const q4 = paramLabels(s4);
    assert(q4.includes('bDerivedFlag') && q4.includes('nBaseId'),
        `stD : ST_Derived := (<caret>) offers own + inherited fields (got [${q4.join(', ')}])`);

    // An unresolvable base costs the inherited suggestions but must never crash or drop the own ones.
    const s5 = completionsAt('MAIN14.TcPOU', tcpou('MAIN14',
        'PROGRAM MAIN14\nVAR\n\tstO : ST_Orphan := ();\nEND_VAR', ''), 'ST_Orphan := (');
    dump('struct orphan base', s5);
    assert(paramLabels(s5).includes('nOwnField'),
        `a struct with an unindexed base still offers its own fields (got [${paramLabels(s5).join(', ')}])`);
    assert(hasValueCompletions(s5), `…and the ordinary suggestions are intact (${s5.length} items)`);

    // ---- 13. An ENUM DUT is not structured init of fields -----------------------------------------
    const s6 = completionsAt('MAIN15.TcPOU', tcpou('MAIN15',
        'PROGRAM MAIN15\nVAR\n\te : E_T := ();\nEND_VAR', ''), 'E_T := (');
    dump('enum DUT', s6);
    assert(paramLabels(s6).length === 0,
        `e : E_T := (<caret>) injects no members — an enum has no fields to initialize (got [${paramLabels(s6).join(', ')}])`);
    assert(hasValueCompletions(s6), `…and the ordinary suggestions are intact (${s6.length} items)`);

    // ---- 14. An unresolvable struct type: offer nothing, never crash ------------------------------
    const s7 = completionsAt('MAIN16.TcPOU', tcpou('MAIN16',
        'PROGRAM MAIN16\nVAR\n\tstX : ST_SomeLibraryStruct := ();\nEND_VAR', ''), 'ST_SomeLibraryStruct := (');
    dump('library struct', s7);
    assert(paramLabels(s7).length === 0,
        `an unindexed library struct offers no fields (got [${paramLabels(s7).join(', ')}])`);
    assert(hasValueCompletions(s7), `…and the ordinary suggestions are intact (${s7.length} items)`);
} finally {
    clearWorkspaceIndex();
    fs.rmSync(dir, { recursive: true, force: true });
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll named-parameter completion assertions passed.');
