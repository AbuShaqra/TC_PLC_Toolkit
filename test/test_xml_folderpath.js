/**
 * @file test_xml_folderpath.js
 * @description setComponentFolderPathInXml (src/xmlParser.js) — the XML edit behind dragging a POU
 * member into a virtual folder. Virtual-folder membership is nothing but the FolderPath attribute
 * on the member's opening tag, so the edit must (a) add / replace / remove exactly that attribute
 * and (b) leave EVERY other byte of the document alone — the file-write invariant: TwinCAT and
 * version control must never see a diff outside the edited spot.
 *
 * Byte-fidelity is asserted the strongest way available: each expected result is built by splicing
 * the expected opening tag into the ORIGINAL text and comparing whole strings, so any stray change
 * anywhere in the document fails the equality.
 */

const { setComponentFolderPathInXml } = require('../src/xmlParser');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Splices `replacement` over the first occurrence of `search` — throws on fixture drift. */
function splice(text, search, replacement) {
    const idx = text.indexOf(search);
    if (idx === -1) throw new Error(`fixture drift: "${search}" not found`);
    return text.substring(0, idx) + replacement + text.substring(idx + search.length);
}

// ── Fixture ──────────────────────────────────────────────────────────────────────────────────────
// The tcpou shape from test_st_shadow.js, extended with what this edit must navigate around: a
// FolderPath-bearing method, an underscore-named method without one, a property WITH Get/Set
// accessors (they share the property's tag pair and must not be touched), an action, a
// defensively self-closing transition, and the LineIds blocks real files carry (their Name
// attributes repeat the component names — the tag match must not land on them).

const xml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Axis" Id="{aaaaaaaa-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Axis
VAR
\tnValue : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Folder Name="Methods" Id="{aaaaaaaa-0000-0000-0000-000000000002}">
      <Folder Name="Internal" Id="{aaaaaaaa-0000-0000-0000-000000000003}" />
    </Folder>
    <Method Name="Home" Id="{aaaaaaaa-0000-0000-0000-000000000004}" FolderPath="Methods\\">
      <Declaration><![CDATA[METHOD Home : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[Home := TRUE;]]></ST>
      </Implementation>
    </Method>
    <Method Name="do_stuff" Id="{aaaaaaaa-0000-0000-0000-000000000005}">
      <Declaration><![CDATA[METHOD do_stuff : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[do_stuff := TRUE;]]></ST>
      </Implementation>
    </Method>
    <Property Name="Value" Id="{aaaaaaaa-0000-0000-0000-000000000006}">
      <Declaration><![CDATA[PROPERTY Value : INT]]></Declaration>
      <Get Name="Get" Id="{aaaaaaaa-0000-0000-0000-000000000007}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[Value := nValue;]]></ST>
        </Implementation>
      </Get>
      <Set Name="Set" Id="{aaaaaaaa-0000-0000-0000-000000000008}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[nValue := Value;]]></ST>
        </Implementation>
      </Set>
    </Property>
    <Action Name="Init" Id="{aaaaaaaa-0000-0000-0000-000000000009}">
      <Implementation>
        <ST><![CDATA[nValue := 0;]]></ST>
      </Implementation>
    </Action>
    <Transition Name="T_Ready" Id="{aaaaaaaa-0000-0000-0000-00000000000a}" />
    <LineIds Name="FB_Axis">
      <LineId Id="3" Count="0" />
    </LineIds>
    <LineIds Name="FB_Axis.Home">
      <LineId Id="5" Count="0" />
    </LineIds>
    <LineIds Name="FB_Axis.do_stuff">
      <LineId Id="7" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`;

// ── Add: attribute absent, non-empty path ────────────────────────────────────────────────────────
// The underscore name doubles as the identifier-safety check: IEC names cannot need regex
// escaping beyond what identifiers allow, but the '_' must survive the componentId round trip.
{
    const result = setComponentFolderPathInXml(xml, 'Method', 'do_stuff', 'Methods\\Internal\\');
    const expected = splice(xml,
        '<Method Name="do_stuff" Id="{aaaaaaaa-0000-0000-0000-000000000005}">',
        '<Method Name="do_stuff" Id="{aaaaaaaa-0000-0000-0000-000000000005}" FolderPath="Methods\\Internal\\">');
    assert(result === expected,
        'ADD: the attribute is inserted before the closing ">" and every other byte is untouched');
}

// ── Replace: attribute present, non-empty path ───────────────────────────────────────────────────
{
    const result = setComponentFolderPathInXml(xml, 'Method', 'Home', 'Methods\\Internal\\');
    const expected = splice(xml,
        'FolderPath="Methods\\">',
        'FolderPath="Methods\\Internal\\">');
    assert(result === expected,
        'REPLACE: an existing FolderPath value is swapped in place, byte-for-byte elsewhere');
}

// ── Remove: attribute present, empty path (back to the file root) ────────────────────────────────
{
    const result = setComponentFolderPathInXml(xml, 'Method', 'Home', '');
    const expected = splice(xml,
        ' FolderPath="Methods\\">',
        '>');
    assert(result === expected,
        'REMOVE: FolderPath \'\' strips the attribute AND its preceding space');
}

// ── No-ops ───────────────────────────────────────────────────────────────────────────────────────
{
    assert(setComponentFolderPathInXml(xml, 'Method', 'do_stuff', '') === xml,
        'NO-OP: attribute absent + empty path returns the input unchanged');
    assert(setComponentFolderPathInXml(xml, 'Method', 'Home', 'Methods\\') === xml,
        'NO-OP: setting the FolderPath a component already has returns the input unchanged');
    assert(setComponentFolderPathInXml(xml, 'Method', 'NoSuchMethod', 'X\\') === xml,
        'NO-OP: an unknown component name returns the input unchanged');
    assert(setComponentFolderPathInXml(xml, 'Transition', 'Home', 'X\\') === xml,
        'NO-OP: a name that exists only under a DIFFERENT tag type returns the input unchanged');
}

// ── Property: the accessors share the tag pair and move with it ──────────────────────────────────
// The whole-string splice compare IS the accessor assertion: if the Get/Set blocks (or their
// CDATA) changed by a single byte, the equality would fail.
{
    const result = setComponentFolderPathInXml(xml, 'Property', 'Value', 'Props\\');
    const expected = splice(xml,
        '<Property Name="Value" Id="{aaaaaaaa-0000-0000-0000-000000000006}">',
        '<Property Name="Value" Id="{aaaaaaaa-0000-0000-0000-000000000006}" FolderPath="Props\\">');
    assert(result === expected,
        'PROPERTY: only the <Property> opening tag changes; the Get/Set accessors\' XML is untouched');
}

// ── Defensive: a self-closing component tag ──────────────────────────────────────────────────────
// Component tags are never self-closing in real TwinCAT files, but the edit must not mangle one.
{
    const result = setComponentFolderPathInXml(xml, 'Transition', 'T_Ready', 'Steps\\');
    const expected = splice(xml,
        '<Transition Name="T_Ready" Id="{aaaaaaaa-0000-0000-0000-00000000000a}" />',
        '<Transition Name="T_Ready" Id="{aaaaaaaa-0000-0000-0000-00000000000a}" FolderPath="Steps\\" />');
    assert(result === expected,
        'SELF-CLOSING (defensive): the attribute lands before the " />" without mangling the tag');
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll FolderPath XML-edit assertions passed.');
