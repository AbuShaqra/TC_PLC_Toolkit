/**
 * @file test_fb_init.js
 * @description Two TwinCAT idioms the semantic checker used to misread, both of which produced
 * false positives on real code:
 *
 *   1. Declaration-site FB initialization lists — `inst : FB_Type(a := v);`. TwinCAT passes those
 *      arguments to the FB's **FB_init method** (its VAR_INPUT), *not* to the FB's own VAR_INPUT.
 *      The checker validated them against the FB's own inputs and flagged every one of them.
 *   2. The IEC return-value idiom — `FunctionName := <value>;` inside `FUNCTION FunctionName : T`,
 *      which sets the return value. The checker typed the bare name as the *function* and reported
 *      a type mismatch against it.
 *
 * The over-suppression guards matter as much as the fixes: a genuinely bogus argument name on an FB
 * whose FB_init IS fully resolved must still be flagged, statement calls must still be validated,
 * and a genuinely incompatible assignment must still be reported.
 *
 * Self-contained: builds synthetic TwinCAT XML in a temp dir; no sample/ dependency.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideDiagnostics } = require('../src/lsp/features');
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

/** Builds a .TcDUT document. */
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

const FB_INIT_CYL = {
    name: 'FB_init',
    decl: 'METHOD FB_init : BOOL\nVAR_INPUT\n' +
        '\tbInitRetains       : BOOL;\n' +
        '\tbInCopyCode        : BOOL;\n' +
        '\trefSensorExtended  : REFERENCE TO BOOL;\n' +
        '\trefExtendOut       : REFERENCE TO BOOL;\n' +
        'END_VAR',
    impl: ''
};

// An FB with NO VAR_INPUT of its own — every init-list argument can only come from FB_init.
const FILES = {
    'GVL_IO.TcGVL': tcgvl('GVL_IO',
        'VAR_GLOBAL\n\tbSensor : BOOL;\n\tbOut : BOOL;\nEND_VAR'),

    'FB_Cylinder.TcPOU': tcpou('FB_Cylinder',
        'FUNCTION_BLOCK FB_Cylinder\nVAR\n' +
        '\trefSensorExtended : REFERENCE TO BOOL;\n' +
        '\trefExtendOut      : REFERENCE TO BOOL;\n' +
        '\tbBusy             : BOOL;\n' +
        'END_VAR',
        '', [FB_INIT_CYL]),

    // FB_init lives on the base; the derived FB declares none of its own.
    'FB_Base.TcPOU': tcpou('FB_Base',
        'FUNCTION_BLOCK FB_Base\nVAR\n\tnIdStored : INT;\nEND_VAR',
        '', [{
            name: 'FB_init',
            decl: 'METHOD FB_init : BOOL\nVAR_INPUT\n\tbInitRetains : BOOL;\n\tbInCopyCode : BOOL;\n\tnId : INT;\nEND_VAR',
            impl: ''
        }]),
    'FB_Derived.TcPOU': tcpou('FB_Derived',
        'FUNCTION_BLOCK FB_Derived EXTENDS FB_Base\nVAR\n\tbFlag : BOOL;\nEND_VAR', ''),

    // Its base is NOT in the index — nothing about it can be resolved with certainty.
    'FB_Orphan.TcPOU': tcpou('FB_Orphan',
        'FUNCTION_BLOCK FB_Orphan EXTENDS FB_ExternalLibBase\nVAR\n\tbFlag : BOOL;\nEND_VAR', ''),

    // Own VAR_INPUT, no FB_init: the target of the structured-init form `:= (bEnable := TRUE)`.
    'FB_Inputs.TcPOU': tcpou('FB_Inputs',
        'FUNCTION_BLOCK FB_Inputs\nVAR_INPUT\n\tbEnable : BOOL;\n\tnMode : INT;\nEND_VAR\nVAR\n\tbBusy : BOOL;\nEND_VAR', ''),

    'ST_Point.TcDUT': tcdut('ST_Point',
        'TYPE ST_Point :\nSTRUCT\n\tx : INT;\n\ty : INT;\nEND_STRUCT\nEND_TYPE'),

    // The IEC return-value idiom, in both a BOOL and a STRING function.
    'ActivateMachine.TcPOU': tcpou('ActivateMachine',
        'FUNCTION ActivateMachine : BOOL\nVAR_INPUT\n\tbForce : BOOL;\nEND_VAR',
        'ActivateMachine := TRUE;\nIF bForce THEN\n\tActivateMachine := FALSE;\nEND_IF'),
    'P_2Digits.TcPOU': tcpou('P_2Digits',
        'FUNCTION P_2Digits : STRING\nVAR_INPUT\n\tn : INT;\nEND_VAR',
        'P_2Digits := TO_STRING(n);')
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_fbinit_'));

/**
 * Diagnoses one synthetic document exactly the way the LSP server does: the whole workspace is
 * indexed from XML first, then the active document is re-parsed from its raw ST unit
 * (parseAndIndexDocument) before provideDiagnostics runs.
 * @param {string} fileName Key into FILES.
 * @param {string} [extraXml] Optional extra document, indexed and then diagnosed instead.
 * @returns {Object[]} LSP diagnostics for that document.
 */
function diagnose(fileName, extraXml) {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    const uriOf = (f) => 'file:///' + path.join(dir, f).replace(/\\/g, '/').replace(/^\//, '');

    for (const f of Object.keys(FILES)) indexXmlObject(index, FILES[f], uriOf(f));
    const xml = extraXml || FILES[fileName];
    if (extraXml) indexXmlObject(index, xml, uriOf(fileName));

    // raw:true is what the live editor path uses — the "clean" conversion strips init lists.
    const { stText } = convertXmlToSt(parseTwinCatXml(xml), { raw: true });
    parseAndIndexDocument(stText, uriOf(fileName));
    return provideDiagnostics(stText, getWorkspaceSymbolIndex(), uriOf(fileName));
}

/** Prints diagnostics, for failure triage. */
function dump(label, diags) {
    diags.forEach(d => console.log(`       (${label}) L${d.range.start.line + 1}: ${d.message}`));
}

const notParam = (diags) => diags.filter(d => /is not a parameter of/.test(d.message));
const mismatch = (diags) => diags.filter(d => /^Type mismatch/.test(d.message));

try {
    // ---- 1. FB_init named arguments at a declaration site --------------------------------------
    const d1 = diagnose('GVL_Sys.TcGVL', tcgvl('GVL_Sys',
        'VAR_GLOBAL\n' +
        '\tfbCyl : FB_Cylinder(refSensorExtended := GVL_IO.bSensor, refExtendOut := GVL_IO.bOut);\n' +
        'END_VAR'));
    dump('FB_init args', d1);
    assert(notParam(d1).length === 0,
        `FB_init parameters are accepted in a declaration init list (got ${notParam(d1).length})`);
    assert(d1.length === 0, `…and the declaration is clean overall (got ${d1.length} diagnostics)`);

    // The implicit FB_init parameters are always accepted, declared or not.
    const d2 = diagnose('GVL_Impl.TcGVL', tcgvl('GVL_Impl',
        'VAR_GLOBAL\n' +
        '\tfbA : FB_Cylinder(bInitRetains := FALSE, bInCopyCode := FALSE, refSensorExtended := GVL_IO.bSensor);\n' +
        // FB_Inputs declares no FB_init at all — the implicit parameters still apply.
        '\tfbB : FB_Inputs(bInitRetains := FALSE, bInCopyCode := FALSE);\n' +
        'END_VAR'));
    dump('implicit params', d2);
    assert(notParam(d2).length === 0,
        `bInitRetains / bInCopyCode never flag, even without an explicit FB_init (got ${notParam(d2).length})`);

    // ---- 2. FB_init inherited from a base FB via EXTENDS ---------------------------------------
    const d3 = diagnose('GVL_Inh.TcGVL', tcgvl('GVL_Inh',
        'VAR_GLOBAL\n\tfbD : FB_Derived(nId := 7);\nEND_VAR'));
    dump('inherited FB_init', d3);
    assert(notParam(d3).length === 0,
        `an FB_init inherited through EXTENDS is found (got ${notParam(d3).length})`);

    // ---- 3. The structured-init form `inst : FB_Type := (input := v)` --------------------------
    const d4 = diagnose('GVL_Struct.TcGVL', tcgvl('GVL_Struct',
        'VAR_GLOBAL\n\tfbI : FB_Inputs := (bEnable := TRUE, nMode := 2);\nEND_VAR'));
    dump('structured init', d4);
    assert(notParam(d4).length === 0,
        `the structured-init form initializes the FB's own VAR_INPUT (got ${notParam(d4).length})`);

    // The same FB's own inputs must also be accepted in the parenthesised form (the union rule).
    const d5 = diagnose('GVL_Union.TcGVL', tcgvl('GVL_Union',
        'VAR_GLOBAL\n\tfbI : FB_Inputs(bEnable := TRUE);\nEND_VAR'));
    dump('union', d5);
    assert(notParam(d5).length === 0,
        `the FB's own VAR_INPUT is part of the accepted set (got ${notParam(d5).length})`);

    // ---- 4. Over-suppression guard: a genuinely bogus argument is STILL flagged ----------------
    const d6 = diagnose('GVL_Bogus.TcGVL', tcgvl('GVL_Bogus',
        'VAR_GLOBAL\n\tfbCyl : FB_Cylinder(refNoSuchThing := GVL_IO.bSensor);\nEND_VAR'));
    dump('bogus arg', d6);
    assert(notParam(d6).length === 1,
        `a bogus argument on a fully-resolved FB_init is still flagged (got ${notParam(d6).length})`);
    assert(notParam(d6).length === 1 && /refNoSuchThing/.test(notParam(d6)[0].message),
        'the flagged argument is refNoSuchThing');

    // Statement calls must still be validated against the FB's own parameters, not FB_init's.
    const d7 = diagnose('FB_Caller.TcPOU', tcpou('FB_Caller',
        'FUNCTION_BLOCK FB_Caller\nVAR\n\tfbI : FB_Inputs;\nEND_VAR',
        'fbI(bEnable := TRUE, bNotAnInput := FALSE);'));
    dump('statement call', d7);
    assert(notParam(d7).length === 1 && /bNotAnInput/.test(notParam(d7)[0].message),
        `statement calls are still validated (got ${notParam(d7).length}: ${notParam(d7).map(d => d.message).join('; ')})`);

    // ---- 5. Unresolvable base FB ⇒ never flag anything ------------------------------------------
    const d8 = diagnose('GVL_Orphan.TcGVL', tcgvl('GVL_Orphan',
        'VAR_GLOBAL\n\tfbO : FB_Orphan(anything := TRUE, whoKnows := 3);\nEND_VAR'));
    dump('unresolvable base', d8);
    assert(notParam(d8).length === 0,
        `an FB whose base is not indexed is never parameter-checked (got ${notParam(d8).length})`);
    assert(d8.length === 0, `…and yields no diagnostics at all (got ${d8.length})`);

    // An entirely unknown (library) FB type must likewise never be parameter-checked.
    const d9 = diagnose('GVL_Lib.TcGVL', tcgvl('GVL_Lib',
        'VAR_GLOBAL\n\tfbX : FB_SomeLibraryBlock(sNetId := \'1.2.3.4.5.6\');\nEND_VAR'));
    assert(notParam(d9).length === 0,
        `an unindexed library FB is never parameter-checked (got ${notParam(d9).length})`);

    // ---- 6. The IEC function-return idiom -------------------------------------------------------
    const d10 = diagnose('ActivateMachine.TcPOU');
    dump('ActivateMachine', d10);
    assert(mismatch(d10).length === 0,
        `"FuncName := TRUE" in a BOOL function is not a type mismatch (got ${mismatch(d10).length})`);
    assert(d10.length === 0, `…and the function is clean overall (got ${d10.length})`);

    const d11 = diagnose('P_2Digits.TcPOU');
    dump('P_2Digits', d11);
    assert(mismatch(d11).length === 0,
        `"FuncName := TO_STRING(n)" in a STRING function is not a type mismatch (got ${mismatch(d11).length})`);

    // Over-suppression guard: a genuinely incompatible assignment must still be reported.
    const d12 = diagnose('FB_BadAssign.TcPOU', tcpou('FB_BadAssign',
        'FUNCTION_BLOCK FB_BadAssign\nVAR\n\tnCount : INT;\n\tstPoint : ST_Point;\nEND_VAR',
        'nCount := stPoint;'));
    dump('bad assign', d12);
    assert(mismatch(d12).length === 1,
        `assigning a STRUCT to an INT is still flagged (got ${mismatch(d12).length})`);

    // A function that assigns the wrong category to its own name is still flagged: the return type
    // is what the value is checked against, so the check stays live — it is not merely suppressed.
    const d13 = diagnose('BadRet.TcPOU', tcpou('BadRet',
        'FUNCTION BadRet : INT\nVAR\n\tstPoint : ST_Point;\nEND_VAR',
        'BadRet := stPoint;'));
    dump('bad return', d13);
    assert(mismatch(d13).length === 1,
        `assigning a STRUCT to an INT-returning function's name is still flagged (got ${mismatch(d13).length})`);
} finally {
    clearWorkspaceIndex();
    fs.rmSync(dir, { recursive: true, force: true });
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll FB_init / function-return assertions passed.');
