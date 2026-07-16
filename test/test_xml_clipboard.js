/**
 * @file test_xml_clipboard.js
 * @description The XML edits behind copy/paste in the Objects explorer (src/xmlParser.js):
 * extractComponentBlockFromXml (copy), insertComponentBlockIntoXml (paste a component into a
 * target file: fresh Ids, new name/folder on the opening tag, header rename only),
 * renameRootObjectInXml (paste a file under a new name), and regenerateObjectIdsInXml (the
 * duplicated file's fresh identity — root AND members). The file-write invariant rules here as
 * everywhere: outside the pasted block / the renamed spots, the target must be byte-identical.
 *
 * Fresh GUIDs make whole-string equality impossible for the insert, so those comparisons run on a
 * GUID-normalized form ({…} → {GUID}) — which still catches any stray byte anywhere else — and
 * the GUIDs themselves are asserted separately: every Id in the pasted block must differ from
 * every source Id AND from each other.
 */

const {
    extractComponentBlockFromXml,
    insertComponentBlockIntoXml,
    renameRootObjectInXml,
    regenerateObjectIdsInXml
} = require('../src/xmlParser');

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

const GUID_RE = /\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}/g;
/** Blinds GUID values so fresh-Id output can be compared byte-for-byte everywhere else. */
const normGuids = (s) => s.replace(GUID_RE, '{GUID}');
/** All GUID values in a text, in order. */
const guidsIn = (s) => (s.match(GUID_RE) || []);

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
// Source: the test_xml_folderpath.js POU shape — a FolderPath-bearing method whose BODY references
// its own name (the rename must not touch it), a method without a FolderPath, and a property with
// Get/Set accessors (three Ids to regenerate). Target: a second POU that already has a member and
// LineIds, so the insert has real bytes to preserve around the splice point.

const sourceXml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Axis" Id="{aaaaaaaa-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Axis
VAR
\tnValue : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
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
    <LineIds Name="FB_Axis">
      <LineId Id="3" Count="0" />
    </LineIds>
    <LineIds Name="FB_Axis.Home">
      <LineId Id="5" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`;

const targetXml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Other" Id="{bbbbbbbb-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Other
VAR
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Method Name="Existing" Id="{bbbbbbbb-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD Existing : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Method>
    <LineIds Name="FB_Other">
      <LineId Id="9" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`;

// ── extractComponentBlockFromXml ─────────────────────────────────────────────────────────────────
// The block must be the EXACT source bytes, opening tag through close tag — proven by slicing the
// same span out of the fixture independently.

const homeStart = sourceXml.indexOf('<Method Name="Home"');
const homeEnd = sourceXml.indexOf('</Method>', homeStart) + '</Method>'.length;
const homeBlock = extractComponentBlockFromXml(sourceXml, 'Method', 'Home');
assert(homeBlock === sourceXml.substring(homeStart, homeEnd),
    'EXTRACT: a method block is returned verbatim, opening tag through </Method>');

const valueBlock = extractComponentBlockFromXml(sourceXml, 'Property', 'Value');
assert(valueBlock !== null && valueBlock.startsWith('<Property Name="Value"')
    && valueBlock.endsWith('</Property>') && valueBlock.includes('</Get>') && valueBlock.includes('</Set>'),
    'EXTRACT: a property block carries its Get/Set accessors (they live inside the tag pair)');

assert(extractComponentBlockFromXml(sourceXml, 'Method', 'NoSuchMethod') === null,
    'EXTRACT: an unknown component name returns null');
assert(extractComponentBlockFromXml(sourceXml, 'Action', 'Home') === null,
    'EXTRACT: a name that exists only under a DIFFERENT tag type returns null');

// ── insertComponentBlockIntoXml: splice point + byte fidelity ────────────────────────────────────
// Expected result built independently: the transformed block, 4-space indented with a trailing
// newline, at lastIndexOf('</POU>') — insertComponentIntoXml's convention. GUID-normalized
// equality proves every byte outside the fresh Ids, the target's existing content included.

{
    const result = insertComponentBlockIntoXml(targetXml, homeBlock, {
        oldName: 'Home', newName: 'Home', newFolderPath: 'Dest\\', isItf: false
    });
    const expectedBlock = splice(homeBlock, 'FolderPath="Methods\\"', 'FolderPath="Dest\\"');
    const closeIdx = targetXml.lastIndexOf('</POU>');
    const expected = targetXml.substring(0, closeIdx) + `    ${expectedBlock}\n` + targetXml.substring(closeIdx);
    assert(normGuids(result) === normGuids(expected),
        'INSERT: the block lands before </POU> (4-space indent, trailing newline); byte-identical elsewhere');

    // Fresh identity: no Id survives from the source, and the new ones are distinct.
    const sourceIds = new Set(guidsIn(homeBlock));
    const insertedIds = guidsIn(result).filter(g => !guidsIn(targetXml).includes(g));
    assert(insertedIds.length === 1 && !sourceIds.has(insertedIds[0]),
        'INSERT: the pasted method\'s Id is a fresh GUID, not the source\'s');
}

// ── insertComponentBlockIntoXml: rename touches the header ONLY ──────────────────────────────────
// The body assigns to the method's own name (`Home := TRUE;` — the return value). Only the
// declaration-header identifier after METHOD may change: bodies may reference the old name, and
// TwinCAT's own paste does not refactor either.

{
    const result = insertComponentBlockIntoXml(targetXml, homeBlock, {
        oldName: 'Home', newName: 'Home2', newFolderPath: '', isItf: false
    });
    let expectedBlock = splice(homeBlock, '<Method Name="Home"', '<Method Name="Home2"');
    expectedBlock = splice(expectedBlock, ' FolderPath="Methods\\"', ''); // '' folder strips the attribute
    expectedBlock = splice(expectedBlock, 'METHOD Home : BOOL', 'METHOD Home2 : BOOL');
    const closeIdx = targetXml.lastIndexOf('</POU>');
    const expected = targetXml.substring(0, closeIdx) + `    ${expectedBlock}\n` + targetXml.substring(closeIdx);
    assert(normGuids(result) === normGuids(expected),
        'INSERT+RENAME: opening-tag Name, header identifier, and FolderPath removal — nothing else');
    assert(result.includes('Home := TRUE;'),
        'INSERT+RENAME: the body\'s reference to the old name survives (no refactoring on paste)');
}

// ── insertComponentBlockIntoXml: a property regenerates ALL nested Ids ───────────────────────────

{
    const result = insertComponentBlockIntoXml(targetXml, valueBlock, {
        oldName: 'Value', newName: 'Value2', newFolderPath: '', isItf: false
    });
    const sourceIds = new Set(guidsIn(valueBlock));
    const targetIds = new Set(guidsIn(targetXml));
    const insertedIds = guidsIn(result).filter(g => !targetIds.has(g));
    assert(insertedIds.length === 3
        && insertedIds.every(g => !sourceIds.has(g))
        && new Set(insertedIds).size === 3,
        'INSERT PROPERTY: property + Get + Set all get fresh GUIDs, mutually distinct');
    assert(result.includes('PROPERTY Value2 : INT') && result.includes('Value := nValue;'),
        'INSERT PROPERTY: the signature header is renamed; the accessor bodies are untouched');
}

// ── insertComponentBlockIntoXml: interface target splices before </Itf> ──────────────────────────

{
    const itfXml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <Itf Name="I_Motion" Id="{cccccccc-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[INTERFACE I_Motion]]></Declaration>
  </Itf>
</TcPlcObject>
`;
    const itfMethod = `<Method Name="Move" Id="{cccccccc-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD Move : BOOL
]]></Declaration>
    </Method>`;
    const result = insertComponentBlockIntoXml(itfXml, itfMethod, {
        oldName: 'Move', newName: 'Move', newFolderPath: '', isItf: true
    });
    const closeIdx = itfXml.lastIndexOf('</Itf>');
    const expected = itfXml.substring(0, closeIdx) + `    ${itfMethod}\n` + itfXml.substring(closeIdx);
    assert(normGuids(result) === normGuids(expected),
        'INSERT INTO ITF: the block lands before </Itf>, byte-identical elsewhere');
}

// ── renameRootObjectInXml: POU ───────────────────────────────────────────────────────────────────
// Exactly three kinds of spots change: the root Name attribute, the header identifier after
// FUNCTION_BLOCK, and the LineIds names ("Old" and the "Old." member prefix). The implementation
// body's self-reference must survive — TwinCAT's own copy leaves it too.

{
    const pou = splice(splice(sourceXml,
        '<ST><![CDATA[]]></ST>', '<ST><![CDATA[nValue := FB_Axis.nValue;]]></ST>'),
        'END_VAR]]></Declaration>\n    <Implementation>',
        'END_VAR\n(* FB_Axis is also mentioned in a comment *)]]></Declaration>\n    <Implementation>');
    let expected = splice(pou, '<POU Name="FB_Axis"', '<POU Name="FB_New"');
    expected = splice(expected, 'FUNCTION_BLOCK FB_Axis', 'FUNCTION_BLOCK FB_New');
    expected = splice(expected, '<LineIds Name="FB_Axis">', '<LineIds Name="FB_New">');
    expected = splice(expected, '<LineIds Name="FB_Axis.Home">', '<LineIds Name="FB_New.Home">');
    assert(renameRootObjectInXml(pou, 'FB_New') === expected,
        'RENAME POU: Name attr + FUNCTION_BLOCK header + both LineIds; the body self-reference and a later declaration mention survive');
}

// ── renameRootObjectInXml: LineIds prefix must match whole segments ──────────────────────────────
// "FB_Ax" is a name-prefix of "FB_Axis" but not its dotted prefix: only exact and "Old." matches
// may be rewritten, or renaming FB_Ax would corrupt FB_Axis's line ids.

{
    const pou = `<TcPlcObject>
  <POU Name="FB_Ax" Id="{aaaaaaaa-0000-0000-0000-00000000000f}">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Ax]]></Declaration>
    <LineIds Name="FB_Ax">
    </LineIds>
    <LineIds Name="FB_Axis.Home">
    </LineIds>
  </POU>
</TcPlcObject>
`;
    let expected = splice(pou, '<POU Name="FB_Ax"', '<POU Name="FB_X"');
    expected = splice(expected, 'FUNCTION_BLOCK FB_Ax', 'FUNCTION_BLOCK FB_X');
    expected = splice(expected, '<LineIds Name="FB_Ax">', '<LineIds Name="FB_X">');
    assert(renameRootObjectInXml(pou, 'FB_X') === expected,
        'RENAME POU: a LineIds name that merely STARTS with the old name (FB_Axis vs FB_Ax) is untouched');
}

// ── renameRootObjectInXml: GVL — attribute only ──────────────────────────────────────────────────
// GVLs have no declaration header naming the object; even a mention of the old name inside the
// declaration must survive.

{
    const gvl = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <GVL Name="GVL_Old" Id="{dddddddd-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[{attribute 'qualified_only'}
VAR_GLOBAL
\t(* GVL_Old keeps this comment *)
\tnCount : INT;
END_VAR
]]></Declaration>
  </GVL>
</TcPlcObject>
`;
    const expected = splice(gvl, '<GVL Name="GVL_Old"', '<GVL Name="GVL_New"');
    assert(renameRootObjectInXml(gvl, 'GVL_New') === expected,
        'RENAME GVL: only the Name attribute changes (no header, declaration mention survives)');
}

// ── renameRootObjectInXml: DUT — TYPE header ─────────────────────────────────────────────────────

{
    const dut = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <DUT Name="ST_Old" Id="{eeeeeeee-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[TYPE ST_Old :
STRUCT
\tnValue : INT;
END_STRUCT
END_TYPE
]]></Declaration>
  </DUT>
</TcPlcObject>
`;
    let expected = splice(dut, '<DUT Name="ST_Old"', '<DUT Name="ST_New"');
    expected = splice(expected, 'TYPE ST_Old :', 'TYPE ST_New :');
    assert(renameRootObjectInXml(dut, 'ST_New') === expected,
        'RENAME DUT: Name attribute + the "TYPE Old :" header');
}

// ── renameRootObjectInXml: no known root — unchanged ─────────────────────────────────────────────

{
    const alien = `<?xml version="1.0"?>\n<Widget Name="X">\n</Widget>\n`;
    assert(renameRootObjectInXml(alien, 'Y') === alien,
        'RENAME: a document without a known TwinCAT root is returned unchanged');
    assert(renameRootObjectInXml(sourceXml, 'FB_Axis') === sourceXml,
        'RENAME: renaming to the SAME name is a no-op (input returned unchanged)');
}

// ── regenerateObjectIdsInXml: a duplicated FILE gets a wholly fresh identity ─────────────────────
// TwinCAT keys objects on the GUID Ids, so the copy must not share a single one with its source —
// the root object AND every member (methods, the property, its Get/Set accessors). Numeric
// `<LineId Id="3">` counters are NOT object ids and must survive untouched — the GUID-shaped
// pattern is what keeps them (and any `Id=` text inside CDATA code) out of reach.

{
    const result = regenerateObjectIdsInXml(sourceXml);
    assert(normGuids(result) === normGuids(sourceXml),
        'REGENERATE IDS: byte-identical everywhere except the GUID values themselves');

    const inputIds = new Set(guidsIn(sourceXml));
    const outputIds = guidsIn(result);
    assert(outputIds.length === inputIds.size && inputIds.size === 6, // root + 2 methods + property + Get + Set
        'REGENERATE IDS: every brace-GUID Id is rewritten (root and all members), none added or lost');
    assert(outputIds.every(g => !inputIds.has(g)) && new Set(outputIds).size === outputIds.length,
        'REGENERATE IDS: all output GUIDs are fresh (none equal any input GUID) and mutually distinct');
    assert(result.includes('<LineId Id="3" Count="0" />') && result.includes('<LineId Id="5" Count="0" />'),
        'REGENERATE IDS: numeric LineId ids are untouched');

    const noGuids = `<TcPlcObject>\n  <POU Name="X">\n    <LineIds Name="X">\n      <LineId Id="3" Count="0" />\n    </LineIds>\n  </POU>\n</TcPlcObject>\n`;
    assert(regenerateObjectIdsInXml(noGuids) === noGuids,
        'REGENERATE IDS: a document with no brace GUIDs is returned unchanged');
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll clipboard XML-edit assertions passed.');
