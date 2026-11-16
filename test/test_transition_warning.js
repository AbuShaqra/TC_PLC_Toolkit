/**
 * @file test_transition_warning.js
 * @description SFC transitions have no place in a single Structured Text unit, so convertXmlToSt
 * drops them — but it must say so (ROADMAP R5). Checks that every dropped transition is named in
 * the returned `warnings`, that the .st export carries one marker comment per transition without
 * disturbing the lineMap of the members around it, and that the raw live unit gains no text at all.
 * Converter-level only: no vscode, no sample/ needed.
 */

const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/**
 * A method member block.
 * @param {string} name Method name.
 * @param {string} id GUID.
 * @returns {string} `<Method>` XML.
 */
function methodXml(name, id) {
    return `
    <Method Name="${name}" Id="{${id}}">
      <Declaration><![CDATA[METHOD ${name} : BOOL
VAR
END_VAR
]]></Declaration>
      <Implementation>
        <ST><![CDATA[${name} := TRUE;
]]></ST>
      </Implementation>
    </Method>`;
}

/**
 * A transition member block.
 * @param {string} name Transition name.
 * @param {string} id GUID.
 * @returns {string} `<Transition>` XML.
 */
function transitionXml(name, id) {
    return `
    <Transition Name="${name}" Id="{${id}}">
      <Implementation>
        <ST><![CDATA[bStart AND NOT bError]]></ST>
      </Implementation>
    </Transition>`;
}

// Members in XML order: a method, two transitions, then another method — so the second method's
// lineMap is computed AFTER the export's marker comments.
const SFC_XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="P_Sequence" Id="{20000000-0000-0000-0000-000000000000}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM P_Sequence
VAR
	bStart	: BOOL;
	bError	: BOOL;
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[bStart := TRUE;
]]></ST>
    </Implementation>${methodXml('M_First', '20000000-0000-0000-0000-000000000001')}${transitionXml('T_Ready', '20000000-0000-0000-0000-000000000002')}${transitionXml('T_Done', '20000000-0000-0000-0000-000000000003')}${methodXml('M_Last', '20000000-0000-0000-0000-000000000004')}
  </POU>
</TcPlcObject>
`;

const EXPECTED = [
    "Transition 'T_Ready' of 'P_Sequence' is not exported: transitions have no Structured Text equivalent in a single compilation unit",
    "Transition 'T_Done' of 'P_Sequence' is not exported: transitions have no Structured Text equivalent in a single compilation unit",
];

const parsed = parseTwinCatXml(SFC_XML);
assert(parsed && parsed.components.filter(c => c.type === 'Transition').length === 2,
    'fixture: the parser yields two Transition components');

/**
 * Asserts that each component's lineMap block points at that component's own first lines.
 * @param {string} stText Converter output.
 * @param {Object} lineMap Converter lineMap.
 * @param {string} mode Label for messages.
 */
function checkLineMap(stText, lineMap, mode) {
    const lines = stText.split('\n');
    for (const name of ['M_First', 'M_Last']) {
        const block = lineMap[`method_${name}`];
        assert(!!block && lines[block.decl.start - 1] === `METHOD ${name} : BOOL`,
            `${mode}: lineMap decl of ${name} starts on its METHOD line (got ${JSON.stringify(block && lines[block.decl.start - 1])})`);
        assert(!!block && lines[block.impl.start - 1] === `${name} := TRUE;`,
            `${mode}: lineMap impl of ${name} starts on its first body line (got ${JSON.stringify(block && lines[block.impl.start - 1])})`);
    }
    const root = lineMap['root'];
    assert(!!root && lines[root.decl.start - 1] === 'PROGRAM P_Sequence', `${mode}: root lineMap is intact`);
    assert(!Object.keys(lineMap).some(k => /^transition_/i.test(k)), `${mode}: transitions get no lineMap entry`);
}

// --- Export (portable .st) mode ---------------------------------------------------------------
{
    const { stText, lineMap, warnings } = convertXmlToSt(parseTwinCatXml(SFC_XML));
    assert(Array.isArray(warnings) && warnings.length === 2, `export: two warnings (got ${JSON.stringify(warnings)})`);
    assert(JSON.stringify(warnings) === JSON.stringify(EXPECTED), 'export: warnings name each transition and its POU, in XML order');
    const markers = stText.split('\n').filter(l => l.startsWith('// WARNING: Transition '));
    assert(markers.length === 2, `export: one marker comment per dropped transition (got ${markers.length})`);
    assert(markers[0] === `// WARNING: ${EXPECTED[0]}` && markers[1] === `// WARNING: ${EXPECTED[1]}`,
        'export: each marker comment carries its warning text');
    assert(!/bStart AND NOT bError/.test(stText), 'export: the transition body itself is not emitted');
    checkLineMap(stText, lineMap, 'export');
}

// --- Raw (live path) mode: warnings reported, no text added --------------------------------------
{
    const { stText, lineMap, warnings } = convertXmlToSt(parseTwinCatXml(SFC_XML), { raw: true });
    assert(JSON.stringify(warnings) === JSON.stringify(EXPECTED), 'raw: the same warnings are reported');
    assert(!/WARNING|T_Ready|T_Done/.test(stText), 'raw: no warning text is added to the live unit');

    // Byte-identical to the unit built from the same parse with the transitions removed.
    const withoutTransitions = parseTwinCatXml(SFC_XML);
    withoutTransitions.components = withoutTransitions.components.filter(c => c.type !== 'Transition');
    const baseline = convertXmlToSt(withoutTransitions, { raw: true });
    assert(stText === baseline.stText, 'raw: unit is identical to the one without transitions');
    assert(JSON.stringify(lineMap) === JSON.stringify(baseline.lineMap), 'raw: lineMap is identical too');
    assert(baseline.warnings.length === 0, 'a POU without transitions reports no warnings');
    checkLineMap(stText, lineMap, 'raw');
}

// --- Non-POU objects return an empty warnings array -----------------------------------------------
{
    const gvl = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <GVL Name="GVL_X" Id="{30000000-0000-0000-0000-000000000000}">
    <Declaration><![CDATA[VAR_GLOBAL
	bX : BOOL;
END_VAR
]]></Declaration>
  </GVL>
</TcPlcObject>
`;
    const { warnings } = convertXmlToSt(parseTwinCatXml(gvl));
    assert(Array.isArray(warnings) && warnings.length === 0, 'GVL: warnings is an empty array');
}

if (errors > 0) {
    console.error(`\n${errors} assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll transition-warning assertions passed.');
