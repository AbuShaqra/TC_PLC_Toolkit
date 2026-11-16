/**
 * @file test_xml_parse_robustness.js
 * @description Inputs the rest of the suite never feeds src/xmlParser.js, each one a reproduced bug
 * (roadmap R5, parser fixes 1-5):
 *
 *  1. A non-ST POU (SFC/LD/FBD/CFC) with an ST member: the root's body must come from the root's OWN
 *     <Implementation> — never from the first <ST> anywhere in the file, which is a member's code —
 *     and a write to the root body must never land in that member. The real language is recorded as
 *     `implementationLanguage`; a non-ST body is `implementation: null` (no ST pane).
 *  2. An element with no CDATA (`<Declaration />`, `<Declaration></Declaration>`, `<ST/>`): reads
 *     and writes must stay inside that element, never run on into the next block's CDATA.
 *  3. XML entities in attributes (`&amp;`, numeric references, …) are decoded on read, and every
 *     writer that finds or inserts an attribute value re-encodes it, so folders/members whose
 *     FolderPath contains `&` can still be moved, renamed and deleted.
 *  4. Lone-CR line breaks are normalised to LF in the text the parser RETURNS (not in the file).
 *  5. A UTF-8 byte-order mark never reaches the parse output or the generated ST (regression pin:
 *     it did not leak when this was checked), and writes keep it.
 *
 * Byte-fidelity is asserted by rebuilding the expected document from the ORIGINAL fixture with a
 * single splice and comparing whole strings.
 */

const {
    parseAttrs, getCdata, parseTwinCatXml, replaceComponentCdata, getFoldersDetailedFromXml,
    insertFolderIntoXml, insertComponentIntoXml, setComponentFolderPathInXml, deleteFolderTagFromXml,
    renameVirtualFolderInXml, deleteComponentFromXml, renameComponentInXml, extractComponentBlockFromXml
} = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');

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

const byId = (parsed, id) => parsed.components.find(c => c.id === id);

// ── Fix 1: non-ST POU bodies ────────────────────────────────────────────────────────────────────
// TwinCAT's SFC body is an <SFC> element; LD/FBD are <NWL> networks; CFC is <CFC>. Member bodies
// are ST here — exactly the shape where "first <ST> in the file" picks the member's code.
const SFC_POU = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">',
    '  <POU Name="SFC_Main" Id="{aaaaaaaa-0000-0000-0000-000000000001}" SpecialFunc="None">',
    '    <Declaration><![CDATA[PROGRAM SFC_Main',
    'VAR',
    'END_VAR',
    ']]></Declaration>',
    '    <Implementation>',
    '      <SFC>',
    '        <SFCStep Name="Init" IsInitial="true" />',
    '      </SFC>',
    '    </Implementation>',
    '    <Action Name="Init_active" Id="{aaaaaaaa-0000-0000-0000-000000000002}">',
    '      <Implementation>',
    '        <ST><![CDATA[nCount := 0;]]></ST>',
    '      </Implementation>',
    '    </Action>',
    '    <Method Name="Reset" Id="{aaaaaaaa-0000-0000-0000-000000000003}">',
    '      <Declaration><![CDATA[METHOD Reset : BOOL',
    ']]></Declaration>',
    '      <Implementation>',
    '        <ST><![CDATA[Reset := TRUE;]]></ST>',
    '      </Implementation>',
    '    </Method>',
    '  </POU>',
    '</TcPlcObject>',
    ''
].join('\r\n');

{
    const p = parseTwinCatXml(SFC_POU);
    const root = byId(p, 'root');
    assert(root.implementation === null,
        `SFC root: implementation is null, not a member's code (got ${JSON.stringify(root.implementation)})`);
    assert(root.implementationLanguage === 'SFC',
        `SFC root: implementationLanguage is 'SFC' (got ${JSON.stringify(root.implementationLanguage)})`);
    assert(root.declaration.startsWith('PROGRAM SFC_Main'), 'SFC root: declaration is the root\'s own');
    const act = p.components.find(c => c.type === 'Action');
    const meth = p.components.find(c => c.type === 'Method');
    assert(act && act.implementation === 'nCount := 0;' && act.implementationLanguage === 'ST',
        'SFC root: its ST action keeps its own body and language ST');
    assert(meth && meth.implementation === 'Reset := TRUE;' && meth.implementationLanguage === 'ST',
        'SFC root: its ST method keeps its own body and language ST');

    // Write side: the root body is not ST — refuse, never overwrite the action's ST.
    const out = replaceComponentCdata(SFC_POU, root.xmlContext, 'Implementation', 'HIJACK;');
    assert(out === SFC_POU, 'SFC root: an Implementation write is refused (file unchanged)');
    // The root Declaration write still lands in the root Declaration only.
    const declOut = replaceComponentCdata(SFC_POU, root.xmlContext, 'Declaration', 'PROGRAM SFC_Main\r\nVAR x : INT; END_VAR\r\n');
    assert(declOut === splice(SFC_POU, 'PROGRAM SFC_Main\r\nVAR\r\nEND_VAR\r\n', 'PROGRAM SFC_Main\r\nVAR x : INT; END_VAR\r\n'),
        'SFC root: a Declaration write changes only the root Declaration CDATA');
    // Member writes still work and touch nothing else.
    const methOut = replaceComponentCdata(SFC_POU, meth.xmlContext, 'Implementation', 'Reset := FALSE;');
    assert(methOut === splice(SFC_POU, 'Reset := TRUE;', 'Reset := FALSE;'),
        'SFC root: a member Implementation write changes only that member');

    const st = convertXmlToSt(p, { raw: true }).stText;
    assert(!st.includes('Reset := TRUE;\n') || st.indexOf('Reset := TRUE;') === st.lastIndexOf('Reset := TRUE;'),
        'SFC root: the method body is emitted once (not duplicated as the POU body)');
}

for (const lang of ['NWL', 'CFC', 'FBD', 'LD']) {
    const xml = SFC_POU.replace('<SFC>', `<${lang}>`).replace('</SFC>', `</${lang}>`);
    const root = byId(parseTwinCatXml(xml), 'root');
    assert(root.implementation === null && root.implementationLanguage === lang,
        `${lang} root: implementation null, implementationLanguage '${lang}' (got ${JSON.stringify([root.implementation, root.implementationLanguage])})`);
}

// An SFC ACTION inside an ST POU whose SFC body itself holds an inline <ST> condition: the action is
// not ST, even though `<ST>` appears inside its block.
const ST_POU_SFC_ACTION = [
    '<TcPlcObject>',
    '  <POU Name="FB_X" Id="{bbbbbbbb-0000-0000-0000-000000000001}">',
    '    <Declaration><![CDATA[FUNCTION_BLOCK FB_X]]></Declaration>',
    '    <Implementation>',
    '      <ST><![CDATA[A();]]></ST>',
    '    </Implementation>',
    '    <Action Name="A" Id="{bbbbbbbb-0000-0000-0000-000000000002}">',
    '      <Implementation>',
    '        <SFC>',
    '          <Condition><ST><![CDATA[bGo]]></ST></Condition>',
    '        </SFC>',
    '      </Implementation>',
    '    </Action>',
    '  </POU>',
    '</TcPlcObject>'
].join('\n');
{
    const p = parseTwinCatXml(ST_POU_SFC_ACTION);
    const root = byId(p, 'root');
    const act = p.components.find(c => c.type === 'Action');
    assert(root.implementation === 'A();' && root.implementationLanguage === 'ST', 'ST root: body and language ST');
    assert(act.implementation === null && act.implementationLanguage === 'SFC',
        `SFC action: implementation null, language SFC (got ${JSON.stringify([act.implementation, act.implementationLanguage])})`);
    const out = replaceComponentCdata(ST_POU_SFC_ACTION, act.xmlContext, 'Implementation', 'HIJACK');
    assert(out === ST_POU_SFC_ACTION, 'SFC action: an Implementation write is refused (file unchanged)');
    assert(p.components.length === 2, 'SFC action: nothing inside its SFC body is taken for a component');
}

// A POU with no root Declaration/Implementation of its own, only a member's: the root must not
// borrow them, and root writes must not land in the member.
const ROOTLESS = [
    '<TcPlcObject>',
    '  <POU Name="P" Id="{cccccccc-0000-0000-0000-000000000001}">',
    '    <Method Name="M" Id="{cccccccc-0000-0000-0000-000000000002}">',
    '      <Declaration><![CDATA[METHOD M : BOOL]]></Declaration>',
    '      <Implementation>',
    '        <ST><![CDATA[M := TRUE;]]></ST>',
    '      </Implementation>',
    '    </Method>',
    '  </POU>',
    '</TcPlcObject>'
].join('\n');
{
    const p = parseTwinCatXml(ROOTLESS);
    const root = byId(p, 'root');
    assert(root.declaration === '', `root without Declaration: declaration '' (got ${JSON.stringify(root.declaration)})`);
    assert(root.implementation === null && root.implementationLanguage === null,
        `root without Implementation: implementation null, language null (got ${JSON.stringify([root.implementation, root.implementationLanguage])})`);
    assert(replaceComponentCdata(ROOTLESS, root.xmlContext, 'Declaration', 'X') === ROOTLESS,
        'root without Declaration: a Declaration write is refused');
    assert(replaceComponentCdata(ROOTLESS, root.xmlContext, 'Implementation', 'X') === ROOTLESS,
        'root without Implementation: an Implementation write is refused');
}

// GVL/DUT/Itf roots carry no implementation at all.
{
    const gvl = parseTwinCatXml('<TcPlcObject><GVL Name="G"><Declaration><![CDATA[VAR_GLOBAL END_VAR]]></Declaration></GVL></TcPlcObject>');
    assert(byId(gvl, 'root').implementation === null && byId(gvl, 'root').implementationLanguage === null,
        'GVL root: implementation null, language null');
}

// ── Fix 2: getCdata / write overrun ─────────────────────────────────────────────────────────────
assert(getCdata('<A></A><B><![CDATA[x]]></B>', '<A>', '</A>') === '', 'getCdata: empty element does not read the next block');
assert(getCdata('<A/><A><![CDATA[x]]></A>', '<A>', '</A>') === '', 'getCdata: self-closing element does not read the next block');

const EMPTY_BLOCKS = [
    '<TcPlcObject>',
    '  <POU Name="FB_E" Id="{dddddddd-0000-0000-0000-000000000001}">',
    '    <Declaration><![CDATA[FUNCTION_BLOCK FB_E]]></Declaration>',
    '    <Implementation>',
    '      <ST />',
    '    </Implementation>',
    '    <Method Name="M1" Id="{dddddddd-0000-0000-0000-000000000002}">',
    '      <Declaration />',
    '      <Implementation>',
    '        <ST></ST>',
    '      </Implementation>',
    '    </Method>',
    '    <Method Name="M2" Id="{dddddddd-0000-0000-0000-000000000003}">',
    '      <Declaration></Declaration>',
    '      <Implementation>',
    '        <ST><![CDATA[M2 := TRUE;]]></ST>',
    '      </Implementation>',
    '    </Method>',
    '    <Method Name="M3" Id="{dddddddd-0000-0000-0000-000000000004}">',
    '      <Declaration><![CDATA[METHOD M3 : BOOL]]></Declaration>',
    '      <Implementation>',
    '        <ST><![CDATA[M3 := TRUE;]]></ST>',
    '      </Implementation>',
    '    </Method>',
    '  </POU>',
    '</TcPlcObject>'
].join('\n');
{
    const p = parseTwinCatXml(EMPTY_BLOCKS);
    const root = byId(p, 'root');
    const m1 = p.components.find(c => c.name === 'M1');
    const m2 = p.components.find(c => c.name === 'M2');
    assert(root.implementation === '' && root.implementationLanguage === 'ST',
        `<ST /> root: implementation '' (got ${JSON.stringify(root.implementation)})`);
    assert(m1.declaration === '', `<Declaration /> : '' (got ${JSON.stringify(m1.declaration)})`);
    assert(m1.implementation === '', `<ST></ST> : '' (got ${JSON.stringify(m1.implementation)})`);
    assert(m2.declaration === '', `<Declaration></Declaration> : '' (got ${JSON.stringify(m2.declaration)})`);

    // Writes into a CDATA-less element stay inside that element (a CDATA is created there).
    const r1 = replaceComponentCdata(EMPTY_BLOCKS, root.xmlContext, 'Implementation', 'x := 1;');
    assert(r1 === splice(EMPTY_BLOCKS, '<ST />', '<ST><![CDATA[x := 1;]]></ST>'),
        'write into root <ST />: only that element changes');
    const r2 = replaceComponentCdata(EMPTY_BLOCKS, m1.xmlContext, 'Declaration', 'METHOD M1 : BOOL');
    assert(r2 === splice(EMPTY_BLOCKS, '<Declaration />', '<Declaration><![CDATA[METHOD M1 : BOOL]]></Declaration>'),
        'write into <Declaration />: only that element changes');
    const r3 = replaceComponentCdata(EMPTY_BLOCKS, m1.xmlContext, 'Implementation', 'M1 := TRUE;');
    assert(r3 === splice(EMPTY_BLOCKS, '<ST></ST>', '<ST><![CDATA[M1 := TRUE;]]></ST>'),
        'write into <ST></ST>: only that element changes');
    const r4 = replaceComponentCdata(EMPTY_BLOCKS, m2.xmlContext, 'Declaration', 'METHOD M2 : BOOL');
    assert(r4 === splice(EMPTY_BLOCKS, '<Declaration></Declaration>', '<Declaration><![CDATA[METHOD M2 : BOOL]]></Declaration>'),
        'write into <Declaration></Declaration>: only that element changes');
    assert(byId(parseTwinCatXml(r4), m2.id).declaration === 'METHOD M2 : BOOL', 'write into empty element round-trips');
}

// ── Fix 3: entities in attributes ───────────────────────────────────────────────────────────────
{
    const a = parseAttrs(' Name="a&amp;b&lt;c&gt;d&quot;e&apos;f" X="&#38;&#x26;" Z="&#X26;" Y="&bogus; &#xZZ;"');
    assert(a.Name === 'a&b<c>d"e\'f', `parseAttrs decodes named entities (got ${JSON.stringify(a.Name)})`);
    assert(a.X === '&&', `parseAttrs decodes numeric references (got ${JSON.stringify(a.X)})`);
    assert(a.Z === '&#X26;', `parseAttrs leaves the non-XML uppercase '&#X' form alone (got ${JSON.stringify(a.Z)})`);
    assert(a.Y === '&bogus; &#xZZ;', `parseAttrs leaves unknown entities alone (got ${JSON.stringify(a.Y)})`);
}

const ENT_POU = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">',
    '  <POU Name="FB_Ent" Id="{eeeeeeee-0000-0000-0000-000000000001}">',
    '    <Declaration><![CDATA[FUNCTION_BLOCK FB_Ent]]></Declaration>',
    '    <Implementation>',
    '      <ST><![CDATA[]]></ST>',
    '    </Implementation>',
    '    <Folder Name="In &amp; Out" Id="{eeeeeeee-0000-0000-0000-000000000002}">',
    '      <Folder Name="&lt;Sub&gt;" Id="{eeeeeeee-0000-0000-0000-000000000003}" />',
    '    </Folder>',
    '    <Folder Name="Plain" Id="{eeeeeeee-0000-0000-0000-000000000004}" />',
    '    <Method Name="Go" Id="{eeeeeeee-0000-0000-0000-000000000005}" FolderPath="In &amp; Out\\">',
    '      <Declaration><![CDATA[METHOD Go : BOOL]]></Declaration>',
    '      <Implementation>',
    '        <ST><![CDATA[Go := TRUE;]]></ST>',
    '      </Implementation>',
    '    </Method>',
    '    <Method Name="Deep" Id="{eeeeeeee-0000-0000-0000-000000000006}" FolderPath="In &amp; Out\\&lt;Sub&gt;\\">',
    '      <Declaration><![CDATA[METHOD Deep : BOOL]]></Declaration>',
    '      <Implementation>',
    '        <ST><![CDATA[Deep := TRUE;]]></ST>',
    '      </Implementation>',
    '    </Method>',
    '    <LineIds Name="FB_Ent">',
    '      <LineId Id="1" Count="0" />',
    '    </LineIds>',
    '  </POU>',
    '</TcPlcObject>',
    ''
].join('\r\n');
{
    const p = parseTwinCatXml(ENT_POU);
    const go = p.components.find(c => c.name === 'Go');
    const deep = p.components.find(c => c.name === 'Deep');
    assert(go.folderPath === 'In & Out\\', `FolderPath decoded (got ${JSON.stringify(go.folderPath)})`);
    assert(deep.folderPath === 'In & Out\\<Sub>\\', `nested FolderPath decoded (got ${JSON.stringify(deep.folderPath)})`);
    const folders = getFoldersDetailedFromXml(ENT_POU).map(f => f.path);
    assert(folders.includes('In & Out\\') && folders.includes('In & Out\\<Sub>\\'),
        `folder names decoded (got ${JSON.stringify(folders)})`);
    assert(folders.includes(go.folderPath) && folders.includes(deep.folderPath),
        'decoded FolderPath values match the decoded folder paths (tree grouping)');

    // Round trip: edit a component whose FolderPath contains '&' — file unchanged outside the edit.
    const edited = replaceComponentCdata(ENT_POU, go.xmlContext, 'Implementation', 'Go := FALSE;');
    assert(edited === splice(ENT_POU, 'Go := TRUE;', 'Go := FALSE;'),
        'round trip: CDATA edit of a member in "In & Out" changes only that CDATA');

    // Move into a folder whose name holds entities: the value is written encoded.
    const moved = setComponentFolderPathInXml(ENT_POU, 'Method', 'Go', 'In & Out\\<Sub>\\');
    assert(moved === splice(ENT_POU, 'FolderPath="In &amp; Out\\">', 'FolderPath="In &amp; Out\\&lt;Sub&gt;\\">'),
        'move: FolderPath is written encoded, nothing else changes');
    assert(parseTwinCatXml(moved).components.find(c => c.name === 'Go').folderPath === 'In & Out\\<Sub>\\',
        'move: round-trips through the parser');

    // New folder under a parent whose name holds entities (self-closing parent is expanded).
    const withFolder = insertFolderIntoXml(ENT_POU, 'In & Out\\<Sub>\\', 'A & "B"', '{eeeeeeee-0000-0000-0000-00000000000a}');
    assert(withFolder.includes('<Folder Name="A &amp; &quot;B&quot;" Id="{eeeeeeee-0000-0000-0000-00000000000a}" />'),
        'new folder: its name is written encoded');
    assert(getFoldersDetailedFromXml(withFolder).some(f => f.path === 'In & Out\\<Sub>\\A & "B"\\'),
        'new folder: lands under the entity-named parent');
    assert(withFolder.includes('<Folder Name="&lt;Sub&gt;" Id="{eeeeeeee-0000-0000-0000-000000000003}">'),
        'new folder: the self-closing parent keeps its encoded name when expanded');

    // New member in an entity-named folder.
    const withMember = insertComponentIntoXml(ENT_POU, null, false, 'Added', 'Method', 'In & Out\\');
    assert(withMember.includes('<Method Name="Added" Id="') && /<Method Name="Added" Id="\{[^"]+\}" FolderPath="In &amp; Out\\">/.test(withMember),
        'new member: FolderPath is written encoded');

    // Delete a folder by its decoded path.
    const noSub = deleteFolderTagFromXml(ENT_POU, 'In & Out\\<Sub>\\');
    assert(noSub === splice(ENT_POU, '\r\n      <Folder Name="&lt;Sub&gt;" Id="{eeeeeeee-0000-0000-0000-000000000003}" />', ''),
        'delete folder: an entity-named nested folder is found and removed');

    // Rename a folder whose name holds entities: tag Name and every FolderPath prefix, encoded.
    const renamed = renameVirtualFolderInXml(ENT_POU, 'In & Out\\', 'I/O & More');
    let expected = splice(ENT_POU, '<Folder Name="In &amp; Out"', '<Folder Name="I/O &amp; More"');
    expected = splice(expected, 'FolderPath="In &amp; Out\\">', 'FolderPath="I/O &amp; More\\">');
    expected = splice(expected, 'FolderPath="In &amp; Out\\&lt;Sub&gt;\\">', 'FolderPath="I/O &amp; More\\&lt;Sub&gt;\\">');
    assert(renamed === expected, 'rename folder: tag Name and FolderPath prefixes rewritten encoded, nothing else');

    // Member operations still find members that live in entity-named folders.
    assert(extractComponentBlockFromXml(ENT_POU, 'Method', 'Deep') !== null, 'extract: member in entity folder found');
    assert(deleteComponentFromXml(ENT_POU, 'FB_Ent', 'Method', 'Deep') !== ENT_POU, 'delete: member in entity folder found');
    assert(renameComponentInXml(ENT_POU, 'FB_Ent', 'Method', 'Deep', 'Deeper').includes('<Method Name="Deeper" Id="{eeeeeeee-0000-0000-0000-000000000006}" FolderPath="In &amp; Out\\&lt;Sub&gt;\\">'),
        'rename member: entity-encoded FolderPath kept byte-for-byte');
}

// Member delete drops exactly the member's LineIds (compared on decoded names), and a self-closing
// LineIds elsewhere cannot make the removal swallow a neighbour.
{
    const xml = [
        '<TcPlcObject>',
        '  <POU Name="FB_L" Id="{abababab-0000-0000-0000-000000000001}">',
        '    <Declaration><![CDATA[FUNCTION_BLOCK FB_L]]></Declaration>',
        '    <Implementation>',
        '      <ST><![CDATA[]]></ST>',
        '    </Implementation>',
        '    <Method Name="Go" Id="{abababab-0000-0000-0000-000000000002}">',
        '      <Declaration><![CDATA[METHOD Go : BOOL]]></Declaration>',
        '    </Method>',
        '    <LineIds Name="FB_L" />',
        '    <LineIds Name="FB_L.Go">',
        '      <LineId Id="1" Count="0" />',
        '    </LineIds>',
        '    <LineIds Name="FB_L.Gone">',
        '      <LineId Id="1" Count="0" />',
        '    </LineIds>',
        '  </POU>',
        '</TcPlcObject>'
    ].join('\n');
    let expected = splice(xml, '\n    <Method Name="Go" Id="{abababab-0000-0000-0000-000000000002}">\n      <Declaration><![CDATA[METHOD Go : BOOL]]></Declaration>\n    </Method>', '');
    expected = splice(expected, '\n    <LineIds Name="FB_L.Go">\n      <LineId Id="1" Count="0" />\n    </LineIds>', '');
    assert(deleteComponentFromXml(xml, 'FB_L', 'Method', 'Go') === expected,
        'delete member: its block and only its LineIds go (not FB_L, not FB_L.Gone)');
}

// An SFC root body that itself holds member-named elements: none is taken for a component.
{
    const xml = SFC_POU.replace('<SFCStep Name="Init" IsInitial="true" />',
        '<SFCStep Name="Init" IsInitial="true" />\r\n        <Transition Name="T1"><ST><![CDATA[bDone]]></ST></Transition>');
    const p = parseTwinCatXml(xml);
    assert(p.components.length === 3 && !p.components.some(c => c.name === 'T1'),
        `SFC body: an element nested in the root Implementation is not a component (got ${p.components.map(c => c.name).join(', ')})`);
}

// ── Fix 4: lone CR line endings ─────────────────────────────────────────────────────────────────
const CR_POU = '<TcPlcObject>\r  <POU Name="FB_Cr" Id="{ffffffff-0000-0000-0000-000000000001}">\r' +
    '    <Declaration><![CDATA[FUNCTION_BLOCK FB_Cr\rVAR\r  x : INT;\rEND_VAR\r]]></Declaration>\r' +
    '    <Implementation>\r      <ST><![CDATA[x := 1;\rx := 2;\r\nx := 3;]]></ST>\r    </Implementation>\r' +
    '  </POU>\r</TcPlcObject>\r';
{
    const p = parseTwinCatXml(CR_POU);
    const root = byId(p, 'root');
    assert(root.declaration === 'FUNCTION_BLOCK FB_Cr\nVAR\n  x : INT;\nEND_VAR\n',
        `lone CR: declaration normalised to LF (got ${JSON.stringify(root.declaration)})`);
    assert(root.implementation === 'x := 1;\nx := 2;\r\nx := 3;',
        `lone CR: implementation normalised, CRLF left alone (got ${JSON.stringify(root.implementation)})`);
    const { stText, lineMap } = convertXmlToSt(p, { raw: true });
    const unitLines = stText.split(/\r?\n/);
    const declRange = lineMap.root && lineMap.root.decl;
    // lineMap is 1-based: the pane's second line is unit line start+1, i.e. index `start`.
    assert(!!declRange && unitLines[declRange.start] === 'VAR'
        && declRange.end - declRange.start + 1 === root.declaration.split('\n').length,
        'lone CR: the unit has one line per pane line');
    // Writing an edited component replaces only its CDATA; the rest of the file keeps its lone CRs.
    const out = replaceComponentCdata(CR_POU, root.xmlContext, 'Implementation', 'x := 9;');
    assert(out === splice(CR_POU, 'x := 1;\rx := 2;\r\nx := 3;', 'x := 9;'), 'lone CR: write leaves the file\'s other CRs');
}

// ── Fix 5: UTF-8 byte-order mark (regression pin) ───────────────────────────────────────────────
{
    const BOM = '﻿';
    for (const [label, text] of [['with prolog', BOM + SFC_POU], ['without prolog', BOM + EMPTY_BLOCKS.replace('<TcPlcObject>\n', '')]]) {
        const p = parseTwinCatXml(text);
        const leaks = [];
        if (p.rootName.includes(BOM)) leaks.push('rootName');
        for (const c of p.components) {
            for (const k of ['name', 'folderPath', 'declaration', 'implementation']) {
                if (typeof c[k] === 'string' && c[k].includes(BOM)) leaks.push(`${c.id}.${k}`);
            }
        }
        assert(leaks.length === 0, `BOM ${label}: no parse output carries U+FEFF (${leaks.join(', ') || 'none'})`);
        for (const raw of [true, false]) {
            assert(!convertXmlToSt(p, { raw }).stText.includes(BOM), `BOM ${label}: generated ST (raw=${raw}) carries no U+FEFF`);
        }
        const root = byId(p, 'root');
        const out = replaceComponentCdata(text, root.xmlContext, 'Declaration', root.declaration + '// edited');
        assert(out.startsWith(BOM) && out === splice(text, root.declaration + ']]>', root.declaration + '// edited]]>'),
            `BOM ${label}: a write keeps the BOM and changes only the edited CDATA`);
    }
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll XML parse-robustness assertions passed.');
