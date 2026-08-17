/**
 * @file test_xml_folderpath.js
 * @description The virtual-folder XML edits in src/xmlParser.js:
 *
 * setComponentFolderPathInXml — the edit behind dragging a POU member into a virtual folder.
 * Virtual-folder membership is nothing but the FolderPath attribute on the member's opening tag,
 * so the edit must (a) add / replace / remove exactly that attribute and (b) leave EVERY other
 * byte of the document alone — the file-write invariant: TwinCAT and version control must never
 * see a diff outside the edited spot.
 *
 * insertFolderIntoXml (root-level branch) — where the <Folder> tag itself lands. TwinCAT's XML
 * loader is ORDER-SENSITIVE inside <POU>/<Itf>: root folders must sit between the root
 * Implementation (Declaration for interfaces) and the first member element. A folder appended
 * after the members (the pre-fix behavior: inserted just before </POU>) made XAE drop the FB's
 * members from compile entirely (C0004 per method/property) — so these assertions pin the
 * canonical position, the 4-space indent, and the contiguity of the folder group.
 *
 * Byte-fidelity is asserted the strongest way available: each expected result is built by splicing
 * the expected text into the ORIGINAL fixture and comparing whole strings, so any stray change
 * anywhere in the document fails the equality.
 */

const { setComponentFolderPathInXml, insertFolderIntoXml } = require('../src/xmlParser');

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

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// insertFolderIntoXml — root-level placement (the TwinCAT element-order invariant)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

// A POU in TwinCAT's canonical shape with NO folders yet: root Declaration + Implementation, then
// two methods, a LineIds block, and the two-space-indented closing tag. This is the shape of the
// user incident: creating folders here used to append them before </POU> — after the members —
// which XAE answers with C0004 for every member.
const pouXml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Gripper" Id="{bbbbbbbb-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Gripper
VAR
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Method Name="Clamp" Id="{bbbbbbbb-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD Clamp : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[Clamp := TRUE;]]></ST>
      </Implementation>
    </Method>
    <Method Name="Release" Id="{bbbbbbbb-0000-0000-0000-000000000003}">
      <Declaration><![CDATA[METHOD Release : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[Release := TRUE;]]></ST>
      </Implementation>
    </Method>
    <LineIds Name="FB_Gripper">
      <LineId Id="3" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`;

const methodsId = '{bbbbbbbb-0000-0000-0000-00000000000f}';
const propsId = '{bbbbbbbb-0000-0000-0000-000000000010}';
const methodsTag = `<Folder Name="Methods" Id="${methodsId}" />`;
const propsTag = `<Folder Name="Properties" Id="${propsId}" />`;

// ── First root folder: after the root </Implementation>, before the first member ────────────────
// The whole-string splice equality IS the byte-preservation assertion: the "  </POU>" line, the
// LineIds block, and everything after the last member are untouched or the compare fails.
const afterFirst = insertFolderIntoXml(pouXml, '', 'Methods', methodsId);
{
    const expected = splice(pouXml,
        '    </Implementation>\n    <Method Name="Clamp"',
        `    </Implementation>\n    ${methodsTag}\n    <Method Name="Clamp"`);
    assert(afterFirst === expected,
        'ROOT INSERT: the folder lands after the root </Implementation>, before the first <Method>, indented 4 spaces');
    const folderIdx = afterFirst.indexOf('<Folder');
    assert(folderIdx > afterFirst.indexOf('</Implementation>') && folderIdx < afterFirst.indexOf('<Method'),
        'ROOT INSERT: index order is </Implementation> < <Folder> < first <Method>');
}

// ── Second root folder: appended to the group, which stays contiguous ────────────────────────────
const afterSecond = insertFolderIntoXml(afterFirst, '', 'Properties', propsId);
{
    const expected = splice(afterFirst, methodsTag, `${methodsTag}\n    ${propsTag}`);
    assert(afterSecond === expected,
        'ROOT INSERT (2nd): lands immediately after the existing root folder — group contiguous, still before the first member');
}

// ── Interface fixture: no root <Implementation> → after the root </Declaration> ──────────────────
{
    const itfXml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <Itf Name="I_Device" Id="{cccccccc-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[INTERFACE I_Device]]></Declaration>
    <Method Name="Start" Id="{cccccccc-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD Start : BOOL]]></Declaration>
    </Method>
  </Itf>
</TcPlcObject>
`;
    const groupId = '{cccccccc-0000-0000-0000-000000000003}';
    const result = insertFolderIntoXml(itfXml, '', 'Group', groupId);
    const expected = splice(itfXml,
        'INTERFACE I_Device]]></Declaration>',
        `INTERFACE I_Device]]></Declaration>\n    <Folder Name="Group" Id="${groupId}" />`);
    assert(result === expected,
        'ITF: with no root implementation the folder lands after the root </Declaration>, before the first <Method>');
}

// ── Existing NON-self-closing root folder with a nested child: past its </Folder> ────────────────
// Reuses the setComponentFolderPathInXml fixture, whose "Methods" folder wraps a nested "Internal":
// the new root folder must land after Methods' matching </Folder> (its full extent), not after the
// nested self-closing child.
{
    const extraId = '{aaaaaaaa-0000-0000-0000-00000000000b}';
    const result = insertFolderIntoXml(xml, '', 'Extra', extraId);
    const expected = splice(xml,
        '    </Folder>\n    <Method Name="Home"',
        `    </Folder>\n    <Folder Name="Extra" Id="${extraId}" />\n    <Method Name="Home"`);
    assert(result === expected,
        'NESTED-PARENT EXTENT: the new root folder lands past the last root folder\'s matching </Folder>');
}

// ── End-to-end: the user-incident shape ──────────────────────────────────────────────────────────
// Fresh POU → create two folders → move one member into each. The root-level element order must be
// TwinCAT's canonical Declaration, Implementation, Folder, Folder, Method, Method, LineIds — the
// order the pre-fix code violated (folders after LineIds), losing the members from compile.
{
    const moved = setComponentFolderPathInXml(
        setComponentFolderPathInXml(afterSecond, 'Method', 'Clamp', 'Methods\\'),
        'Method', 'Release', 'Properties\\');
    // Root-level children all sit at exactly 4-space indent; nested content is deeper and the
    // CDATA bodies never match `    <word` in this fixture.
    const seq = [...moved.matchAll(/^    <(\w+)/gm)].map(m => m[1]).join(',');
    assert(seq === 'Declaration,Implementation,Folder,Folder,Method,Method,LineIds',
        `END-TO-END: canonical element order Declaration,Implementation,Folder,Folder,Method,Method,LineIds (got ${seq})`);
    assert(moved.includes('<Method Name="Clamp" Id="{bbbbbbbb-0000-0000-0000-000000000002}" FolderPath="Methods\\">')
        && moved.includes('<Method Name="Release" Id="{bbbbbbbb-0000-0000-0000-000000000003}" FolderPath="Properties\\">'),
        'END-TO-END: both members carry their FolderPath attributes');
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll FolderPath XML-edit assertions passed.');
