/**
 * @file test_rename_engine.js
 * @description The edit-application half of the rename feature (src/renameEngine.js). Given a TwinCAT
 * file and a symbol's reference occurrences expressed in the RAW-converted Structured Text unit's
 * coordinate space, applyReferenceEditsToXml maps every occurrence back into the backing CDATA and
 * splices oldName -> newName — never corrupting a byte outside the edited identifiers.
 *
 * Occurrence positions are derived the honest way, mirroring the live pipeline instead of
 * hand-computed numbers: each fixture is run through convertXmlToSt(parseTwinCatXml(xml), {raw:true}),
 * and the resulting ST unit is scanned for `\boldName\b`. To mirror what the LSP actually reports —
 * usages inside real declaration/implementation regions, not the generated file-header comment or the
 * separator lines — a scanned hit is kept only when it classifies into a real block (classifyLine).
 *
 * The file-write invariant rules here as everywhere: outside the spliced identifiers (and any
 * structural member renames) the document must be byte-identical. That is asserted the strongest way
 * available — each expected result is built by splicing the expected edits into the ORIGINAL fixture
 * and comparing whole strings, so any stray change anywhere fails the equality. Fixtures use CRLF, as
 * TwinCAT writes.
 */

const { applyReferenceEditsToXml, classifyLine, computeLineStarts } = require('../src/renameEngine');
const { parseTwinCatXml, renameComponentInXml, renameRootObjectInXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** TwinCAT writes CRLF; author fixtures in LF and normalize so the edits are proven CRLF-safe. */
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

/** Splices `replacement` over the first occurrence of `search` — throws on fixture drift. */
function splice(text, search, replacement) {
    const idx = text.indexOf(search);
    if (idx === -1) throw new Error(`fixture drift: "${search}" not found`);
    return text.substring(0, idx) + replacement + text.substring(idx + search.length);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Derives a symbol's occurrences the same way the live path does: raw-convert the file, scan the ST
 * unit for `\bname\b`, and keep only hits inside a real block (what the LSP would report).
 */
function occurrencesOf(xml, name) {
    const parsed = parseTwinCatXml(xml);
    const { stText, lineMap } = convertXmlToSt(parsed, { raw: true });
    const lines = stText.split('\n');
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
    const occ = [];
    for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lines[i])) !== null) {
            if (classifyLine(i + 1, lineMap)) occ.push({ line: i, character: m.index });
        }
    }
    return occ;
}

/** Returns lineMap['id'].{decl|impl}.start (1-based) for fabricating precise probe positions. */
function blockStart(xml, id, pane) {
    const { lineMap } = convertXmlToSt(parseTwinCatXml(xml), { raw: true });
    return lineMap[id][pane].start;
}

function sameComponents(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].componentType !== b[i].componentType || a[i].componentName !== b[i].componentName) return false;
    }
    return true;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// computeLineStarts — the CRLF-preserving line-offset math the splice guard rides on.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
{
    assert(JSON.stringify(computeLineStarts('a\nbb\nccc')) === JSON.stringify([0, 2, 5]),
        'computeLineStarts: LF line offsets');
    // CRLF: a line's `\r` is the last byte before the next line's start, never a line start itself.
    assert(JSON.stringify(computeLineStarts('a\r\nbb\r\nccc')) === JSON.stringify([0, 3, 7]),
        'computeLineStarts: CRLF line offsets keep the \\r inside the preceding line');
    assert(JSON.stringify(computeLineStarts('')) === JSON.stringify([0]),
        'computeLineStarts: empty string is one line starting at 0');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Splices land in every reachable block: root decl, root impl, method decl, method impl,
//    property-signature decl, Get impl, action impl. A type `Foo` referenced across a POU is renamed.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const xmlRefs = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Test" Id="{00000000-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Test
VAR
\tinst : Foo;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[Foo.doRoot();]]></ST>
    </Implementation>
    <Method Name="Calc" Id="{00000000-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD Calc : Foo]]></Declaration>
      <Implementation>
        <ST><![CDATA[Calc := Foo.value;]]></ST>
      </Implementation>
    </Method>
    <Property Name="Level" Id="{00000000-0000-0000-0000-000000000003}">
      <Declaration><![CDATA[PROPERTY Level : Foo]]></Declaration>
      <Get Name="Get" Id="{00000000-0000-0000-0000-000000000004}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[Level := Foo.get();]]></ST>
        </Implementation>
      </Get>
    </Property>
    <Action Name="Run" Id="{00000000-0000-0000-0000-000000000005}">
      <Implementation>
        <ST><![CDATA[Foo.doAction();]]></ST>
      </Implementation>
    </Action>
    <LineIds Name="FB_Test">
      <LineId Id="3" Count="0" />
    </LineIds>
    <LineIds Name="FB_Test.Calc">
      <LineId Id="5" Count="0" />
    </LineIds>
    <LineIds Name="FB_Test.Level.Get">
      <LineId Id="7" Count="0" />
    </LineIds>
    <LineIds Name="FB_Test.Run">
      <LineId Id="9" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);

{
    const occ = occurrencesOf(xmlRefs, 'Foo');
    assert(occ.length === 7, `REFS: seven genuine Foo occurrences derived across the blocks (got ${occ.length})`);

    const r = applyReferenceEditsToXml(xmlRefs, occ, { oldName: 'Foo', newName: 'Bar' });

    let expected = xmlRefs;
    expected = splice(expected, 'inst : Foo;', 'inst : Bar;');            // root decl
    expected = splice(expected, 'Foo.doRoot();', 'Bar.doRoot();');         // root impl
    expected = splice(expected, 'METHOD Calc : Foo', 'METHOD Calc : Bar'); // method decl (return type)
    expected = splice(expected, 'Calc := Foo.value;', 'Calc := Bar.value;');// method impl
    expected = splice(expected, 'PROPERTY Level : Foo', 'PROPERTY Level : Bar'); // property signature decl
    expected = splice(expected, 'Level := Foo.get();', 'Level := Bar.get();');   // Get impl
    expected = splice(expected, 'Foo.doAction();', 'Bar.doAction();');     // action impl

    assert(r.applied === 7, `REFS: all seven occurrences applied (got ${r.applied})`);
    assert(r.skipped.length === 0, `REFS: nothing skipped (got ${r.skipped.length})`);
    assert(r.renamedDeclComponents.length === 0, 'REFS: no declaration components renamed (Foo is not a member)');
    assert(r.xmlText === expected,
        'REFS: root decl/impl, method decl/impl, property-signature decl, Get impl, action impl all splice; every other byte identical');

    // CRLF fidelity: no newline added or removed, and a known unedited line keeps its \r\n.
    assert((r.xmlText.match(/\r\n/g) || []).length === (xmlRefs.match(/\r\n/g) || []).length,
        'REFS: CRLF count unchanged (splices touch only identifiers, never line terminators)');
    assert(r.xmlText.includes('    <Implementation>\r\n      <ST>'),
        'REFS: an unedited line retains its \\r\\n byte-for-byte');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Multiple occurrences on ONE line — proof the splice runs descending by (line, column) so a
//    length change (newName longer, then shorter) never shifts a not-yet-applied offset.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const xmlMulti = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Multi" Id="{11111111-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Multi]]></Declaration>
    <Implementation>
      <ST><![CDATA[res := Foo + Foo * Foo;]]></ST>
    </Implementation>
    <LineIds Name="FB_Multi">
      <LineId Id="3" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);

{
    const occ = occurrencesOf(xmlMulti, 'Foo');
    assert(occ.length === 3, `MULTI: three Foo occurrences on one line (got ${occ.length})`);

    const longer = applyReferenceEditsToXml(xmlMulti, occ, { oldName: 'Foo', newName: 'WidgetName' });
    assert(longer.applied === 3
        && longer.xmlText === splice(xmlMulti, 'res := Foo + Foo * Foo;', 'res := WidgetName + WidgetName * WidgetName;'),
        'MULTI (longer): all three renamed correctly — descending order holds when newName is longer');

    const shorter = applyReferenceEditsToXml(xmlMulti, occ, { oldName: 'Foo', newName: 'Fo' });
    assert(shorter.applied === 3
        && shorter.xmlText === splice(xmlMulti, 'res := Foo + Foo * Foo;', 'res := Fo + Fo * Fo;'),
        'MULTI (shorter): all three renamed correctly — descending order holds when newName is shorter');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Action-decl occurrence: the synthesized `ACTION <name>` line has no CDATA, so it is skipped and
//    flagged coveredByStructuralRename. A call to the action elsewhere splices; propagation renames
//    the action's tag + LineIds when the flag is on, and does not when it is off.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const xmlAct = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Act" Id="{22222222-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Act]]></Declaration>
    <Implementation>
      <ST><![CDATA[Foo();]]></ST>
    </Implementation>
    <Action Name="Foo" Id="{22222222-0000-0000-0000-000000000002}">
      <Implementation>
        <ST><![CDATA[nCount := nCount + 1;]]></ST>
      </Implementation>
    </Action>
    <LineIds Name="FB_Act">
      <LineId Id="3" Count="0" />
    </LineIds>
    <LineIds Name="FB_Act.Foo">
      <LineId Id="5" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);

{
    const occ = occurrencesOf(xmlAct, 'Foo');
    assert(occ.length === 2, `ACTION: the call site and the synthesized ACTION header are found (got ${occ.length})`);

    // Flag ON: call spliced, action renamed structurally.
    const on = applyReferenceEditsToXml(xmlAct, occ, { oldName: 'Foo', newName: 'Bar', propagateDeclRenames: true });
    let expectedOn = splice(xmlAct, 'Foo();', 'Bar();');
    expectedOn = renameComponentInXml(expectedOn, 'FB_Act', 'Action', 'Foo', 'Bar');
    assert(on.applied === 1, `ACTION (on): only the call site splices (got ${on.applied})`);
    const actSkip = on.skipped.find(s => s.coveredByStructuralRename);
    assert(on.skipped.length === 1 && actSkip,
        'ACTION (on): the synthesized ACTION header is skipped and flagged coveredByStructuralRename');
    assert(sameComponents(on.renamedDeclComponents, [{ componentType: 'Action', componentName: 'Foo' }]),
        'ACTION (on): renamedDeclComponents reports the Action');
    assert(on.xmlText === expectedOn,
        'ACTION (on): call site spliced AND the action tag + FB_Act.Foo LineIds renamed via propagation');

    // Flag OFF: call spliced, action NOT renamed, but the skip is still flagged covered.
    const off = applyReferenceEditsToXml(xmlAct, occ, { oldName: 'Foo', newName: 'Bar', propagateDeclRenames: false });
    assert(off.applied === 1 && off.xmlText === splice(xmlAct, 'Foo();', 'Bar();'),
        'ACTION (off): only the call site splices; the action declaration is left entirely alone');
    assert(off.renamedDeclComponents.length === 0,
        'ACTION (off): no structural rename applied');
    assert(off.skipped.length === 1 && off.skipped[0].coveredByStructuralRename === true,
        'ACTION (off): the header skip is still recorded as coveredByStructuralRename');
    assert(off.xmlText.includes('<Action Name="Foo"') && off.xmlText.includes('<LineIds Name="FB_Act.Foo">'),
        'ACTION (off): the action tag and its LineIds are untouched');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 4. Property accessor (Get) declaration: the synthesized `GET` keyword line offsets the CDATA by one.
//    4a: Get decl carries real CDATA (a local var typed as the renamed name) -> the -1 offset lands.
//    4b: Get decl is whitespace-only `VAR END_VAR` (stConverter omits it) -> a probe in that region is
//        skipped and nothing is corrupted; a genuine Get-impl reference still splices.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const xmlGet = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Get" Id="{33333333-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Get]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Property Name="Level" Id="{33333333-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[PROPERTY Level : INT]]></Declaration>
      <Get Name="Get" Id="{33333333-0000-0000-0000-000000000003}">
        <Declaration><![CDATA[VAR
\ttmp : Foo;
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[Level := tmp.v;]]></ST>
        </Implementation>
      </Get>
    </Property>
    <LineIds Name="FB_Get">
      <LineId Id="3" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);

{
    const occ = occurrencesOf(xmlGet, 'Foo');
    assert(occ.length === 1, `GET-CDATA: the Foo in the Get's VAR block is found (got ${occ.length})`);
    const r = applyReferenceEditsToXml(xmlGet, occ, { oldName: 'Foo', newName: 'Bar' });
    assert(r.applied === 1 && r.skipped.length === 0
        && r.xmlText === splice(xmlGet, 'tmp : Foo;', 'tmp : Bar;'),
        'GET-CDATA: the -1 synthesized-GET offset lands the splice inside the Get declaration CDATA');
}

const xmlGetOmit = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_GetO" Id="{44444444-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_GetO]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Property Name="Level" Id="{44444444-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[PROPERTY Level : INT]]></Declaration>
      <Get Name="Get" Id="{44444444-0000-0000-0000-000000000003}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[Level := Foo;]]></ST>
        </Implementation>
      </Get>
    </Property>
    <LineIds Name="FB_GetO">
      <LineId Id="3" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);

{
    // The omitted VAR block is not present in the ST unit, so the honest scan finds only the Get-impl
    // reference; it splices, and the whitespace-only VAR END_VAR is left byte-for-byte identical.
    const occ = occurrencesOf(xmlGetOmit, 'Foo');
    assert(occ.length === 1, `GET-OMIT: only the Get-impl Foo is found; the omitted decl has none (got ${occ.length})`);
    const r = applyReferenceEditsToXml(xmlGetOmit, occ, { oldName: 'Foo', newName: 'Bar' });
    assert(r.applied === 1 && r.xmlText === splice(xmlGetOmit, 'Level := Foo;', 'Level := Bar;'),
        'GET-OMIT: the Get-impl reference splices; the omitted VAR END_VAR block is untouched');
    assert(r.xmlText.includes('<Declaration><![CDATA[VAR\r\nEND_VAR]]></Declaration>\r\n        <Implementation>'),
        'GET-OMIT: the whitespace-only Get declaration CDATA is byte-identical (no corruption)');

    // A probe pointing at the synthesized GET line (the only line the omitted decl block spans) is
    // skipped, and the file is returned byte-identical.
    const getLine = blockStart(xmlGetOmit, 'prop_Level_get', 'decl'); // 1-based ST line of `GET`
    const probe = applyReferenceEditsToXml(xmlGetOmit, [{ line: getLine - 1, character: 0 }], { oldName: 'Foo', newName: 'Bar' });
    assert(probe.applied === 0 && probe.skipped.length === 1 && probe.xmlText === xmlGetOmit,
        'GET-OMIT: a probe at the synthesized GET line is skipped, output byte-identical');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 5. The mandatory guard: a fabricated occurrence pointing where oldName is NOT present is skipped and
//    never written — the output is byte-identical.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

{
    // xmlAct's root impl is `Foo();`; point one char in, where the slice is "oo(" — not a match.
    const implLine = blockStart(xmlAct, 'root', 'impl'); // 1-based ST line of `Foo();`
    const bogus = applyReferenceEditsToXml(xmlAct, [{ line: implLine - 1, character: 1 }], { oldName: 'Foo', newName: 'Bar' });
    assert(bogus.applied === 0, 'GUARD: a fabricated wrong-column occurrence applies nothing');
    assert(bogus.skipped.length === 1 && /guard/.test(bogus.skipped[0].reason),
        'GUARD: the skip is recorded with the guard reason');
    assert(bogus.xmlText === xmlAct, 'GUARD: the output is byte-identical to the input');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 6. PROGRAM-with-methods: the presence of a method makes stConverter rewrite `PROGRAM`->`FUNCTION_BLOCK`
//    in the raw ST unit (line count preserved, columns shifted on that line). The program's own name
//    sits AFTER the keyword, so its column IS shifted; the guard therefore skips it (covered by the
//    caller's renameRootObjectInXml). Verify the actual behavior, and that renameRootObjectInXml then
//    yields a consistent file.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const xmlProg = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="MAIN" Id="{55555555-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[PROGRAM MAIN
VAR
\tnState : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[nState := nState + 1;]]></ST>
    </Implementation>
    <Method Name="DoIt" Id="{55555555-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD DoIt : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[DoIt := TRUE;]]></ST>
      </Implementation>
    </Method>
    <LineIds Name="MAIN">
      <LineId Id="3" Count="0" />
    </LineIds>
    <LineIds Name="MAIN.DoIt">
      <LineId Id="5" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);

{
    // Confirm the rewrite really shifts the name's column in the ST unit (design premise).
    const { stText } = convertXmlToSt(parseTwinCatXml(xmlProg), { raw: true });
    assert(/FUNCTION_BLOCK MAIN/.test(stText) && !/PROGRAM MAIN/.test(stText),
        'PROGRAM: the raw ST unit shows FUNCTION_BLOCK MAIN (PROGRAM rewritten for method compilation)');

    const occ = occurrencesOf(xmlProg, 'MAIN');
    assert(occ.length === 1 && occ[0].character === 15,
        `PROGRAM: the sole in-block MAIN is the header, shifted to column 15 (got ${occ.length} @ ${occ[0] && occ[0].character})`);

    const r = applyReferenceEditsToXml(xmlProg, occ, { oldName: 'MAIN', newName: 'PRG_Main' });
    // The name sits after the rewritten keyword, so the column is shifted -> the guard skips it.
    assert(r.applied === 0 && r.xmlText === xmlProg,
        'PROGRAM: the shifted header occurrence is not spliced; the file is unchanged by the engine');
    assert(r.skipped.length === 1 && r.skipped[0].coveredByStructuralRename === true,
        'PROGRAM: the header skip is flagged coveredByStructuralRename (the caller completes it)');

    // The caller completes the rename structurally; the result must be consistent.
    const finished = renameRootObjectInXml(r.xmlText, 'PRG_Main');
    assert(finished.includes('<POU Name="PRG_Main"') && !/ Name="MAIN"/.test(finished),
        'PROGRAM: renameRootObjectInXml updates the root Name attribute');
    assert(finished.includes('PROGRAM PRG_Main') && !finished.includes('PROGRAM MAIN'),
        'PROGRAM: the declaration header is renamed exactly once, consistently');
    assert(finished.includes('<LineIds Name="PRG_Main">') && finished.includes('<LineIds Name="PRG_Main.DoIt">')
        && !/<LineIds Name="MAIN/.test(finished),
        'PROGRAM: the LineIds are re-rooted; no stale MAIN remains');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 7. Interface method declaration (propagation on): the method header is renamed AND the tag + LineIds
//    are renamed structurally via renameComponentInXml; renamedDeclComponents reports it. With the flag
//    off, nothing changes but the covered skip is still recorded.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const xmlItf = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <Itf Name="I_Drive" Id="{66666666-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[INTERFACE I_Drive]]></Declaration>
    <Method Name="Foo" Id="{66666666-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD Foo : BOOL]]></Declaration>
    </Method>
    <LineIds Name="I_Drive.Foo">
      <LineId Id="3" Count="0" />
    </LineIds>
  </Itf>
</TcPlcObject>
`);

{
    const occ = occurrencesOf(xmlItf, 'Foo');
    assert(occ.length === 1, `ITF: the interface method header Foo is found (got ${occ.length})`);

    const on = applyReferenceEditsToXml(xmlItf, occ, { oldName: 'Foo', newName: 'Bar', propagateDeclRenames: true });
    const expectedOn = renameComponentInXml(xmlItf, 'I_Drive', 'Method', 'Foo', 'Bar');
    assert(on.applied === 0, 'ITF (on): the header is not CDATA-spliced (it is diverted to a structural rename)');
    assert(on.skipped.length === 1 && on.skipped[0].coveredByStructuralRename === true,
        'ITF (on): the header occurrence is skipped and flagged coveredByStructuralRename');
    assert(sameComponents(on.renamedDeclComponents, [{ componentType: 'Method', componentName: 'Foo' }]),
        'ITF (on): renamedDeclComponents reports the interface Method');
    assert(on.xmlText === expectedOn,
        'ITF (on): header renamed AND tag Name + I_Drive.Foo LineIds renamed via renameComponentInXml');
    assert(on.xmlText.includes('METHOD Bar : BOOL') && on.xmlText.includes('<Method Name="Bar"')
        && on.xmlText.includes('<LineIds Name="I_Drive.Bar">'),
        'ITF (on): the resulting file is internally consistent (header, tag, LineIds all Bar)');

    const off = applyReferenceEditsToXml(xmlItf, occ, { oldName: 'Foo', newName: 'Bar', propagateDeclRenames: false });
    assert(off.xmlText === xmlItf && off.renamedDeclComponents.length === 0,
        'ITF (off): with propagation off, the file is unchanged');
    assert(off.skipped.length === 1 && off.skipped[0].coveredByStructuralRename === true,
        'ITF (off): the covered skip is still recorded');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 8. Defensive edges: empty occurrences, an unparseable file, and a position outside every block.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

{
    const empty = applyReferenceEditsToXml(xmlRefs, [], { oldName: 'Foo', newName: 'Bar' });
    assert(empty.xmlText === xmlRefs && empty.applied === 0 && empty.skipped.length === 0,
        'DEFENSIVE: no occurrences -> input returned unchanged');

    const junk = applyReferenceEditsToXml('not xml at all', [{ line: 0, character: 0 }], { oldName: 'Foo', newName: 'Bar' });
    assert(junk.xmlText === 'not xml at all' && junk.applied === 0 && junk.skipped.length === 1,
        'DEFENSIVE: an unparseable file skips every occurrence and changes nothing');

    // Point at the generated file-header comment (ST line 2), which is not inside any block.
    const outside = applyReferenceEditsToXml(xmlRefs, [{ line: 1, character: 0 }], { oldName: 'Foo', newName: 'Bar' });
    assert(outside.applied === 0 && outside.xmlText === xmlRefs
        && /not within any editable block/.test(outside.skipped[0].reason),
        'DEFENSIVE: a position outside every block is skipped, output byte-identical');
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll rename-engine assertions passed.');
