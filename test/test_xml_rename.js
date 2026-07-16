/**
 * @file test_xml_rename.js
 * @description The in-place rename XML edits in src/xmlParser.js — the edits behind renaming an
 * object member or a virtual folder in the Objects explorer:
 *
 * renameComponentInXml — renames a Method/Property/Action/Transition: the member's opening-tag Name
 * attribute, its declaration-header identifier (Method/Property only), and every LineIds name rooted
 * on it. A rename-in-place deliberately KEEPS the object Ids/GUIDs (the contrast with paste/
 * duplicate, which re-identify) and does NOT refactor code bodies — self-references keep the old
 * name, exactly as TwinCAT's own rename leaves them.
 *
 * renameFirstHeaderOccurrence — the shared header-identifier splice (now exported), exercised
 * directly for its no-op edges.
 *
 * renameVirtualFolderInXml — renames a virtual folder: the one <Folder> tag's Name attribute plus
 * the FolderPath attribute on every member inside it (nested sub-folder tags derive their path from
 * nesting and are left alone; a sibling folder with a common name prefix must be untouched).
 *
 * The file-write invariant rules here as everywhere: outside the renamed spots the document must be
 * byte-identical. Byte-fidelity is asserted the strongest way available — each expected result is
 * built by splicing the expected text into the ORIGINAL fixture and comparing whole strings, so any
 * stray change anywhere fails the equality. Fixtures use CRLF line endings, as TwinCAT writes.
 */

const {
    renameComponentInXml,
    renameFirstHeaderOccurrence,
    renameRootObjectInXml,
    renameVirtualFolderInXml
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

/** TwinCAT writes CRLF; author fixtures in LF and normalize so the edits are proven CRLF-safe. */
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// ── Fixture: a POU with the full member zoo ────────────────────────────────────────────────────────
// A method whose BODY references its own name (the rename must not touch it), a second method whose
// name is a SUBSTRING of the first (Home vs HomeAll — HomeAll must stay put), a property with Get/Set
// (two dotted LineIds), an action whose body mentions its own name, a non-self-closing transition,
// and the LineIds blocks real files carry (root + one per member).

const xml = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_X" Id="{aaaaaaaa-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_X
VAR
\tnValue : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Method Name="Home" Id="{aaaaaaaa-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD Home : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[Home := TRUE;]]></ST>
      </Implementation>
    </Method>
    <Method Name="HomeAll" Id="{aaaaaaaa-0000-0000-0000-000000000003}">
      <Declaration><![CDATA[METHOD HomeAll : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[HomeAll := FALSE;]]></ST>
      </Implementation>
    </Method>
    <Property Name="Value" Id="{aaaaaaaa-0000-0000-0000-000000000004}">
      <Declaration><![CDATA[PROPERTY Value : INT]]></Declaration>
      <Get Name="Get" Id="{aaaaaaaa-0000-0000-0000-000000000005}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[Value := nValue;]]></ST>
        </Implementation>
      </Get>
      <Set Name="Set" Id="{aaaaaaaa-0000-0000-0000-000000000006}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[nValue := Value;]]></ST>
        </Implementation>
      </Set>
    </Property>
    <Action Name="Init" Id="{aaaaaaaa-0000-0000-0000-000000000007}">
      <Implementation>
        <ST><![CDATA[(* Init resets state *)
nValue := 0;]]></ST>
      </Implementation>
    </Action>
    <Transition Name="T_Ready" Id="{aaaaaaaa-0000-0000-0000-000000000008}">
      <Implementation>
        <ST><![CDATA[bReady AND NOT bError]]></ST>
      </Implementation>
    </Transition>
    <LineIds Name="FB_X">
      <LineId Id="3" Count="0" />
    </LineIds>
    <LineIds Name="FB_X.Home">
      <LineId Id="5" Count="0" />
    </LineIds>
    <LineIds Name="FB_X.HomeAll">
      <LineId Id="7" Count="0" />
    </LineIds>
    <LineIds Name="FB_X.Value.Get">
      <LineId Id="9" Count="0" />
    </LineIds>
    <LineIds Name="FB_X.Value.Set">
      <LineId Id="11" Count="0" />
    </LineIds>
    <LineIds Name="FB_X.Init">
      <LineId Id="13" Count="0" />
    </LineIds>
    <LineIds Name="FB_X.T_Ready">
      <LineId Id="15" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);

// ── renameComponentInXml: Method ───────────────────────────────────────────────────────────────────
// Tag Name + METHOD header + the FB_X.Home LineIds all rename; the body self-reference, the
// substring-named HomeAll (tag + FB_X.HomeAll LineIds), and every Id survive.
{
    const result = renameComponentInXml(xml, 'FB_X', 'Method', 'Home', 'Park');
    let expected = splice(xml, '<Method Name="Home"', '<Method Name="Park"');
    expected = splice(expected, 'METHOD Home : BOOL', 'METHOD Park : BOOL');
    expected = splice(expected, '<LineIds Name="FB_X.Home">', '<LineIds Name="FB_X.Park">');
    assert(result === expected,
        'METHOD: tag Name + METHOD header + FB_X.Home LineIds rename; every other byte identical');
    assert(result.includes('Home := TRUE;'),
        'METHOD: the body self-reference to the old name survives (no refactoring on rename)');
    assert(result.includes('<Method Name="HomeAll"') && result.includes('<LineIds Name="FB_X.HomeAll">')
        && result.includes('METHOD HomeAll : BOOL'),
        'METHOD: the substring-named sibling HomeAll is untouched (tag, header, LineIds)');
}

// ── renameComponentInXml: Property (Get/Set dotted LineIds) ─────────────────────────────────────────
{
    const result = renameComponentInXml(xml, 'FB_X', 'Property', 'Value', 'Level');
    let expected = splice(xml, '<Property Name="Value"', '<Property Name="Level"');
    expected = splice(expected, 'PROPERTY Value : INT', 'PROPERTY Level : INT');
    expected = splice(expected, '<LineIds Name="FB_X.Value.Get">', '<LineIds Name="FB_X.Level.Get">');
    expected = splice(expected, '<LineIds Name="FB_X.Value.Set">', '<LineIds Name="FB_X.Level.Set">');
    assert(result === expected,
        'PROPERTY: tag Name + PROPERTY header + both dotted .Get/.Set LineIds rename; nothing else');
    assert(result.includes('Value := nValue;') && result.includes('nValue := Value;'),
        'PROPERTY: the Get/Set accessor bodies (referencing the old name) are untouched');
}

// ── renameComponentInXml: Action (NO header edit, self-reference untouched) ─────────────────────────
{
    const result = renameComponentInXml(xml, 'FB_X', 'Action', 'Init', 'Setup');
    let expected = splice(xml, '<Action Name="Init"', '<Action Name="Setup"');
    expected = splice(expected, '<LineIds Name="FB_X.Init">', '<LineIds Name="FB_X.Setup">');
    assert(result === expected,
        'ACTION: only the tag Name and FB_X.Init LineIds change — no declaration header exists to edit');
    assert(result.includes('(* Init resets state *)'),
        'ACTION: the body self-reference to the old name survives');
}

// ── renameComponentInXml: Transition (tag + LineIds, no header) ─────────────────────────────────────
{
    const result = renameComponentInXml(xml, 'FB_X', 'Transition', 'T_Ready', 'T_Done');
    let expected = splice(xml, '<Transition Name="T_Ready"', '<Transition Name="T_Done"');
    expected = splice(expected, '<LineIds Name="FB_X.T_Ready">', '<LineIds Name="FB_X.T_Done">');
    assert(result === expected,
        'TRANSITION: tag Name + FB_X.T_Ready LineIds rename; no header edit, body untouched');
}

// ── renameComponentInXml: no-ops ───────────────────────────────────────────────────────────────────
{
    assert(renameComponentInXml(xml, 'FB_X', 'Method', 'NoSuchMethod', 'X') === xml,
        'NO-OP: an unknown component name returns the input unchanged (byte-identical)');
    assert(renameComponentInXml(xml, 'FB_X', 'Method', 'Home', 'Home') === xml,
        'NO-OP: renaming to the same name returns the input unchanged');
    assert(renameComponentInXml(xml, 'FB_X', 'Transition', 'Home', 'X') === xml,
        'NO-OP: a name that exists only under a DIFFERENT tag type returns the input unchanged');
}

// ── renameComponentInXml: case-only rename ─────────────────────────────────────────────────────────
// Home -> home differs only by case; the tag Name, the METHOD header (matched case-insensitively),
// and the LineIds (compared case-insensitively) all rename.
{
    const result = renameComponentInXml(xml, 'FB_X', 'Method', 'Home', 'home');
    let expected = splice(xml, '<Method Name="Home"', '<Method Name="home"');
    expected = splice(expected, 'METHOD Home : BOOL', 'METHOD home : BOOL');
    expected = splice(expected, '<LineIds Name="FB_X.Home">', '<LineIds Name="FB_X.home">');
    assert(result === expected,
        'CASE-ONLY: Home -> home renames tag Name, header, and LineIds despite differing only in case');
}

// ── renameComponentInXml: a name needing regex escaping does not blow up ────────────────────────────
// IEC identifiers cannot carry metacharacters, but a malformed name must never throw or corrupt.
// '$' is doubly dangerous: special in a regex AND in a String.replace replacement — the slice-based
// splices must swallow it literally.
{
    const escXml = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_E" Id="{bbbbbbbb-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_E]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Method Name="M$1" Id="{bbbbbbbb-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[METHOD M$1 : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[M$1 := TRUE;]]></ST>
      </Implementation>
    </Method>
    <LineIds Name="FB_E">
      <LineId Id="3" Count="0" />
    </LineIds>
    <LineIds Name="FB_E.M$1">
      <LineId Id="5" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);
    const result = renameComponentInXml(escXml, 'FB_E', 'Method', 'M$1', 'Renamed');
    let expected = splice(escXml, '<Method Name="M$1"', '<Method Name="Renamed"');
    expected = splice(expected, 'METHOD M$1 : BOOL', 'METHOD Renamed : BOOL');
    expected = splice(expected, '<LineIds Name="FB_E.M$1">', '<LineIds Name="FB_E.Renamed">');
    assert(result === expected,
        'REGEX ESCAPE: a $-bearing name renames cleanly (tag/header/LineIds); the body M$1 survives');
}

// ── renameFirstHeaderOccurrence (now exported): direct edges ────────────────────────────────────────
{
    const decl = '<Declaration><![CDATA[METHOD Foo : BOOL]]></Declaration>';
    assert(renameFirstHeaderOccurrence(decl, /\bMETHOD\b/i, 'Foo', 'Bar')
            === '<Declaration><![CDATA[METHOD Bar : BOOL]]></Declaration>',
        'HEADER: the first identifier after the keyword is renamed');
    assert(renameFirstHeaderOccurrence(decl, /\bMETHOD\b/i, 'Nope', 'Bar') === decl,
        'HEADER: a missing name is a no-op (input returned unchanged)');
    const noKw = '<Declaration><![CDATA[Foo : BOOL]]></Declaration>';
    assert(renameFirstHeaderOccurrence(noKw, /\bMETHOD\b/i, 'Foo', 'Bar') === noKw,
        'HEADER: a missing keyword is a no-op (input returned unchanged)');
}

// ── Composition no-op safety: renameRootObjectInXml after a header-only pre-rename ──────────────────
// The orchestrator may run a reference pass that has ALREADY rewritten the declaration header. A
// subsequent renameRootObjectInXml must then update the Name attr + LineIds and leave the (already
// correct) header alone — never double-rename or corrupt it.
{
    const preRenamed = splice(xml, 'FUNCTION_BLOCK FB_X', 'FUNCTION_BLOCK FB_New');
    const result = renameRootObjectInXml(preRenamed, 'FB_New');
    let expected = splice(preRenamed, '<POU Name="FB_X"', '<POU Name="FB_New"');
    expected = splice(expected, '<LineIds Name="FB_X">', '<LineIds Name="FB_New">');
    expected = splice(expected, '<LineIds Name="FB_X.Home">', '<LineIds Name="FB_New.Home">');
    expected = splice(expected, '<LineIds Name="FB_X.HomeAll">', '<LineIds Name="FB_New.HomeAll">');
    expected = splice(expected, '<LineIds Name="FB_X.Value.Get">', '<LineIds Name="FB_New.Value.Get">');
    expected = splice(expected, '<LineIds Name="FB_X.Value.Set">', '<LineIds Name="FB_New.Value.Set">');
    expected = splice(expected, '<LineIds Name="FB_X.Init">', '<LineIds Name="FB_New.Init">');
    expected = splice(expected, '<LineIds Name="FB_X.T_Ready">', '<LineIds Name="FB_New.T_Ready">');
    assert(result === expected,
        'COMPOSE ROOT: after a header-only pre-rename, renameRootObjectInXml updates Name attr + LineIds, header untouched');
    assert((result.match(/FUNCTION_BLOCK FB_New/g) || []).length === 1
        && !result.includes('FUNCTION_BLOCK FB_X'),
        'COMPOSE ROOT: the header is not double-renamed (exactly one FUNCTION_BLOCK FB_New)');
}

// ── Composition no-op safety: renameComponentInXml after a header-only pre-rename ──────────────────
{
    const preRenamed = splice(xml, 'METHOD Home : BOOL', 'METHOD Park : BOOL');
    const result = renameComponentInXml(preRenamed, 'FB_X', 'Method', 'Home', 'Park');
    let expected = splice(preRenamed, '<Method Name="Home"', '<Method Name="Park"');
    expected = splice(expected, '<LineIds Name="FB_X.Home">', '<LineIds Name="FB_X.Park">');
    assert(result === expected,
        'COMPOSE COMPONENT: after a header-only pre-rename, tag Name + LineIds update, header left as-is');
    assert((result.match(/METHOD Park : BOOL/g) || []).length === 1
        && !result.includes('METHOD Home : BOOL'),
        'COMPOSE COMPONENT: the header is not double-renamed (exactly one METHOD Park : BOOL)');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// renameVirtualFolderInXml
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Two top-level folders whose names share a prefix (Methods vs Methods2), a nested folder inside
// Methods, and members spread across all three folder paths plus one at the root. Folder membership
// is nothing but the folder nesting + the members' FolderPath attributes.

const folderXml = crlf(`<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_F" Id="{cccccccc-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_F]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
    <Folder Name="Methods" Id="{cccccccc-0000-0000-0000-000000000002}">
      <Folder Name="Internal" Id="{cccccccc-0000-0000-0000-000000000003}" />
    </Folder>
    <Folder Name="Methods2" Id="{cccccccc-0000-0000-0000-000000000004}" />
    <Method Name="A" Id="{cccccccc-0000-0000-0000-000000000005}" FolderPath="Methods\\">
      <Declaration><![CDATA[METHOD A : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Method>
    <Method Name="B" Id="{cccccccc-0000-0000-0000-000000000006}" FolderPath="Methods\\Internal\\">
      <Declaration><![CDATA[METHOD B : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Method>
    <Method Name="C" Id="{cccccccc-0000-0000-0000-000000000007}" FolderPath="Methods2\\">
      <Declaration><![CDATA[METHOD C : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Method>
    <Method Name="D" Id="{cccccccc-0000-0000-0000-000000000008}">
      <Declaration><![CDATA[METHOD D : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[]]></ST>
      </Implementation>
    </Method>
    <LineIds Name="FB_F">
      <LineId Id="3" Count="0" />
    </LineIds>
  </POU>
</TcPlcObject>
`);

// ── Top-level folder rename: the tag + all member FolderPaths inside it (nested included) ───────────
{
    const result = renameVirtualFolderInXml(folderXml, 'Methods\\', 'Tools');
    let expected = splice(folderXml, ' Name="Methods"', ' Name="Tools"');
    expected = splice(expected, 'FolderPath="Methods\\Internal\\"', 'FolderPath="Tools\\Internal\\"');
    expected = splice(expected, 'FolderPath="Methods\\"', 'FolderPath="Tools\\"');
    assert(result === expected,
        'FOLDER TOP: the Methods tag renames; member A (Methods\\) and nested member B (Methods\\Internal\\) repoint');
    assert(result.includes('<Folder Name="Internal"'),
        'FOLDER TOP: the nested sub-folder tag derives its path from nesting and is NOT renamed');
    assert(result.includes(' Name="Methods2"') && result.includes('FolderPath="Methods2\\"'),
        'FOLDER TOP: the sibling Methods2 (common name prefix) and its member are untouched');
    assert(!/FolderPath="Methods\\"/.test(result) && !/FolderPath="Methods\\Internal\\"/.test(result),
        'FOLDER TOP: no stale Methods\\ path remains on any member');
}

// ── Nested folder rename: only the sub-prefix is rewritten ─────────────────────────────────────────
{
    const result = renameVirtualFolderInXml(folderXml, 'Methods\\Internal\\', 'Private');
    let expected = splice(folderXml, ' Name="Internal"', ' Name="Private"');
    expected = splice(expected, 'FolderPath="Methods\\Internal\\"', 'FolderPath="Methods\\Private\\"');
    assert(result === expected,
        'FOLDER NESTED: the Internal tag + only the Methods\\Internal\\ member repoint to Methods\\Private\\');
    assert(result.includes('<Folder Name="Methods"') && result.includes('FolderPath="Methods\\"'),
        'FOLDER NESTED: the parent Methods folder and its direct member (Methods\\) are untouched');
}

// ── renameVirtualFolderInXml: no-ops ───────────────────────────────────────────────────────────────
{
    assert(renameVirtualFolderInXml(folderXml, 'DoesNotExist\\', 'X') === folderXml,
        'NO-OP: an unknown folder path returns the input unchanged (byte-identical)');
    assert(renameVirtualFolderInXml(folderXml, 'Methods\\', 'Methods') === folderXml,
        'NO-OP: renaming a folder to its own name returns the input unchanged');
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll rename XML-edit assertions passed.');
