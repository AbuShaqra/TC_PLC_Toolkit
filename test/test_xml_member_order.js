/**
 * @file test_xml_member_order.js
 * @description WHERE a new POU/Itf member lands — insertMemberIntoXml, shared by
 * insertComponentIntoXml (create a Method/Property/Action) and insertComponentBlockIntoXml (paste).
 *
 * TwinCAT's XML loader is ORDER-SENSITIVE inside <POU>/<Itf>. The canonical child order is
 *     Declaration, Implementation, Folder*, member*, LineIds*
 * and the folder incident proved the loader acts on it: root <Folder> tags appended after the
 * members made XAE drop the FB's members from compile entirely, C0004 per method/property. Member
 * insertion carried the same latent defect — `lastIndexOf('</POU>') + splice` put every new member
 * PAST the whole LineIds group. These assertions pin the canonical slot so it cannot come back.
 *
 * The same splice was wrong three further ways, each guarded below: it inherited the close tag's
 * indentation (opening tag at 6 spaces, not 4), it stranded `</POU>` at column 0, and it wrote bare
 * LF into TwinCAT's CRLF files — a mixed-ending diff that violates the byte-fidelity invariant.
 *
 * Byte-fidelity is asserted the strongest way available: the expected result is built by splicing
 * the expected block into the ORIGINAL fixture and comparing whole strings, so any stray change
 * anywhere else in the document fails the equality.
 */

const { insertComponentIntoXml, insertComponentBlockIntoXml } = require('../src/xmlParser');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Root-level children sit at exactly 4-space indent; nested content is deeper. */
function elementOrder(xml) {
    return [...xml.matchAll(/^ {4}<(\w+)/gm)].map(m => m[1]).join(',');
}

/**
 * The inserted region, delimited explicitly: from the new member's opening tag up to the anchor it
 * was placed before. Deliberately NOT a common-prefix/suffix diff — `</Method>` and `</Property>`
 * share their closing `>`, so a scan from each end absorbs it and reports a region off by one byte.
 */
function spliceRegion(out, startMarker, endMarker) {
    const start = out.indexOf(startMarker);
    const end = out.indexOf(endMarker, start === -1 ? 0 : start);
    if (start === -1 || end === -1) {
        // A failed assertion, not a throw: against broken code the markers are exactly what goes
        // missing, and throwing here would abort the suite and hide every later regression.
        assert(false, `BYTES: both region markers are present (${startMarker.trim()} .. ${endMarker.trim()})`);
        return null;
    }
    return { start, end, block: out.slice(start, end) };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
// CRLF throughout, as TwinCAT writes them. The POU carries a root Folder, an existing method and a
// property with a Get accessor, then the LineIds group — everything the anchor must navigate past.

const CRLF = '\r\n';
const pouLines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">',
    '  <POU Name="FB_Axis" Id="{aaaaaaaa-0000-0000-0000-000000000001}" SpecialFunc="None">',
    '    <Declaration><![CDATA[FUNCTION_BLOCK FB_Axis',
    'VAR',
    '\tnValue : INT;',
    'END_VAR]]></Declaration>',
    '    <Implementation>',
    '      <ST><![CDATA[nValue := 1;]]></ST>',
    '    </Implementation>',
    '    <Folder Name="Methods" Id="{aaaaaaaa-0000-0000-0000-000000000002}" />',
    '    <Method Name="Home" Id="{aaaaaaaa-0000-0000-0000-000000000003}">',
    '      <Declaration><![CDATA[METHOD Home : BOOL]]></Declaration>',
    '      <Implementation>',
    '        <ST><![CDATA[Home := TRUE;]]></ST>',
    '      </Implementation>',
    '    </Method>',
    '    <Property Name="nPos" Id="{aaaaaaaa-0000-0000-0000-000000000004}">',
    '      <Declaration><![CDATA[PROPERTY nPos : INT]]></Declaration>',
    '      <Get Name="Get" Id="{aaaaaaaa-0000-0000-0000-000000000005}">',
    '        <Declaration><![CDATA[]]></Declaration>',
    '      </Get>',
    '    </Property>',
    '    <LineIds Name="FB_Axis">',
    '      <LineId Id="1" Count="0" />',
    '    </LineIds>',
    '    <LineIds Name="FB_Axis.Home">',
    '      <LineId Id="2" Count="0" />',
    '    </LineIds>',
    '  </POU>',
    '</TcPlcObject>',
    '',
];
const pouXml = pouLines.join(CRLF);

// Interfaces carry no executable lines, so a .TcIO has NO LineIds group at all — it exercises the
// fallback branch exclusively, which is why the fallback's indentation has to be right.
const itfXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">',
    '  <Itf Name="I_Axis" Id="{bbbbbbbb-0000-0000-0000-000000000001}">',
    '    <Declaration><![CDATA[INTERFACE I_Axis]]></Declaration>',
    '    <Method Name="Stop" Id="{bbbbbbbb-0000-0000-0000-000000000002}">',
    '      <Declaration><![CDATA[METHOD Stop : BOOL]]></Declaration>',
    '    </Method>',
    '  </Itf>',
    '</TcPlcObject>',
    '',
].join(CRLF);

// ── 1. The canonical slot: before the LineIds group ──────────────────────────────────────────────
{
    const out = insertComponentIntoXml(pouXml, null, false, 'Park', 'Method', '');

    assert(elementOrder(out) === 'Declaration,Implementation,Folder,Method,Property,Method,LineIds,LineIds',
        `ORDER: the new Method joins the member run, before both LineIds blocks (got ${elementOrder(out)})`);
    assert(out.indexOf('<Method Name="Park"') < out.indexOf('<LineIds'),
        'ORDER: the new member precedes the FIRST LineIds block');
    assert(out.indexOf('</Property>') < out.indexOf('<Method Name="Park"'),
        'ORDER: it lands AFTER the existing members, not among them');
}

// ── 2. Indentation on both sides of the seam ─────────────────────────────────────────────────────
{
    const out = insertComponentIntoXml(pouXml, null, false, 'Park', 'Method', '');

    assert(out.includes(`${CRLF}    <Method Name="Park"`),
        'INDENT: the opening tag sits at exactly 4 spaces (the old splice inherited 2 more)');
    assert(out.includes(`${CRLF}  </POU>${CRLF}`),
        'INDENT: </POU> keeps its own 2-space indent (the old splice stranded it at column 0)');
    assert(out.includes(`${CRLF}    <LineIds Name="FB_Axis">`),
        'INDENT: the anchor LineIds block keeps its 4-space indent');
}

// ── 3. Line endings follow the document ──────────────────────────────────────────────────────────
{
    const out = insertComponentIntoXml(pouXml, null, false, 'Park', 'Method', '');
    assert(!/(?<!\r)\n/.test(out), 'EOL: not one bare LF is introduced into a CRLF document');

    const lfXml = pouXml.replace(/\r\n/g, '\n');
    const lfOut = insertComponentIntoXml(lfXml, null, false, 'Park', 'Method', '');
    assert(!lfOut.includes('\r'), 'EOL: an LF document stays LF — no CR is introduced either');
}

// ── 4. Byte fidelity: nothing outside the inserted block moves ───────────────────────────────────
{
    const out = insertComponentIntoXml(pouXml, null, false, 'Park', 'Method', '');
    const region = spliceRegion(out, '    <Method Name="Park"', '    <LineIds Name="FB_Axis">');
    if (region) {
        assert(out.slice(0, region.start) + out.slice(region.end) === pouXml,
            'BYTES: cutting the inserted region back out reproduces the original exactly — nothing else moved');
        assert(region.block.startsWith('    <Method Name="Park"') && region.block.endsWith(`</Method>${CRLF}`),
            'BYTES: the inserted region is exactly the member block, indent to trailing newline');
    }
}

// ── 5. Every component type, and the accessors a Property brings ─────────────────────────────────
for (const kind of ['Method', 'Property', 'Action']) {
    const out = insertComponentIntoXml(pouXml, null, false, `New${kind}`, kind, '');
    assert(out.indexOf(`<${kind} Name="New${kind}"`) < out.indexOf('<LineIds'),
        `TYPES: a new ${kind} lands before the LineIds group`);
    assert(!/(?<!\r)\n/.test(out), `TYPES: a new ${kind} introduces no bare LF`);
}
{
    // The Get/Set accessors are nested, so they must NOT appear at root-child indent.
    const out = insertComponentIntoXml(pouXml, null, false, 'NewProp', 'Property', '');
    assert(elementOrder(out) === 'Declaration,Implementation,Folder,Method,Property,Property,LineIds,LineIds',
        `TYPES: a Property's Get/Set stay nested inside it (got ${elementOrder(out)})`);
}

// ── 6. FolderPath still rides along ──────────────────────────────────────────────────────────────
{
    const out = insertComponentIntoXml(pouXml, null, false, 'Park', 'Method', 'Methods\\');
    assert(out.includes('<Method Name="Park" Id="{') && /FolderPath="Methods\\\\"/.test(out.replace(/\\/g, '\\\\')),
        'FOLDERPATH: the attribute survives the new insertion path');
    assert(out.indexOf('FolderPath="Methods\\"') < out.indexOf('<LineIds'),
        'FOLDERPATH: a foldered member still lands before the LineIds group');
}

// ── 7. The .TcIO fallback: no LineIds anywhere ───────────────────────────────────────────────────
{
    const out = insertComponentIntoXml(itfXml, null, true, 'Reset', 'Method', '');

    assert(elementOrder(out) === 'Declaration,Method,Method',
        `ITF: the new Method joins the member run (got ${elementOrder(out)})`);
    assert(out.includes(`${CRLF}    <Method Name="Reset"`), 'ITF: 4-space indent on the opening tag');
    assert(out.includes(`${CRLF}  </Itf>${CRLF}`), 'ITF: </Itf> keeps its 2-space indent');
    assert(!/(?<!\r)\n/.test(out), 'ITF: no bare LF introduced');

    const region = spliceRegion(out, '    <Method Name="Reset"', '  </Itf>');
    if (region) {
        assert(out.slice(0, region.start) + out.slice(region.end) === itfXml,
            'ITF: cutting the inserted region back out reproduces the original exactly');
    }
}

// ── 8. The paste path shares the placement ───────────────────────────────────────────────────────
{
    const block = [
        '<Method Name="Home" Id="{cccccccc-0000-0000-0000-000000000001}">',
        '      <Declaration><![CDATA[METHOD Home : BOOL]]></Declaration>',
        '    </Method>',
    ].join(CRLF);
    const out = insertComponentBlockIntoXml(pouXml, block, {
        oldName: 'Home', newName: 'HomeCopy', newFolderPath: '', isItf: false,
    });

    assert(elementOrder(out) === 'Declaration,Implementation,Folder,Method,Property,Method,LineIds,LineIds',
        `PASTE: a pasted member lands in the member run, before the LineIds group (got ${elementOrder(out)})`);
    assert(out.includes(`${CRLF}    <Method Name="HomeCopy"`), 'PASTE: 4-space indent on the opening tag');
    assert(out.includes(`${CRLF}  </POU>${CRLF}`), 'PASTE: </POU> keeps its 2-space indent');
    assert(!/(?<!\r)\n/.test(out), 'PASTE: no bare LF introduced');

    // A copy can cross files with unlike endings: an LF block into a CRLF document must not
    // leave the target mixed.
    const lfBlock = block.replace(/\r\n/g, '\n');
    const mixed = insertComponentBlockIntoXml(pouXml, lfBlock, {
        oldName: 'Home', newName: 'HomeCopy', newFolderPath: '', isItf: false,
    });
    assert(!/(?<!\r)\n/.test(mixed),
        'PASTE: an LF-ending block pasted into a CRLF document is normalised to CRLF');
}

// ── 9. Repeated insertion accumulates in order ───────────────────────────────────────────────────
{
    let out = pouXml;
    for (const name of ['One', 'Two', 'Three']) {
        out = insertComponentIntoXml(out, null, false, name, 'Method', '');
    }
    assert(elementOrder(out) === 'Declaration,Implementation,Folder,Method,Property,Method,Method,Method,LineIds,LineIds',
        `REPEAT: three insertions stack in call order, all before the LineIds group (got ${elementOrder(out)})`);
    assert(out.indexOf('"One"') < out.indexOf('"Two"') && out.indexOf('"Two"') < out.indexOf('"Three"'),
        'REPEAT: each new member goes after the previous one');
    assert(!/(?<!\r)\n/.test(out), 'REPEAT: still no bare LF after three insertions');
}

// ── 10. A `<LineIds` literal inside CDATA is code, not the anchor ────────────────────────────────
{
    // ST source is free to mention the tag in a comment. Anchoring on it would splice the member
    // into the middle of the implementation — corrupting the file rather than misplacing a tag.
    const decoy = pouXml.replace('<ST><![CDATA[nValue := 1;]]></ST>',
        '<ST><![CDATA[(* emits <LineIds Name="x"> on save *)\nnValue := 1;]]></ST>');
    const out = insertComponentIntoXml(decoy, null, false, 'Park', 'Method', '');

    assert(out.indexOf('<Method Name="Park"') > out.indexOf('</Implementation>'),
        'CDATA DECOY: the member lands after the implementation, not inside its CDATA');
    assert(elementOrder(out) === 'Declaration,Implementation,Folder,Method,Property,Method,LineIds,LineIds',
        `CDATA DECOY: canonical order is unaffected by the decoy (got ${elementOrder(out)})`);
    assert(out.includes('(* emits <LineIds Name="x"> on save *)'),
        'CDATA DECOY: the ST comment itself is left untouched');
}

// ── 11. Degenerate input is a no-op, never a corrupt write ───────────────────────────────────────
{
    const noRoot = '<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1" />\r\n';
    assert(insertComponentIntoXml(noRoot, null, false, 'Park', 'Method', '') === noRoot,
        'NO-OP: XML with no root close tag is returned byte-identical');
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll member-insertion order assertions passed.');
