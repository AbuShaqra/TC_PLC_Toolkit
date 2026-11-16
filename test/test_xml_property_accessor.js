/**
 * @file test_xml_property_accessor.js
 * @description Re-adding a missing Get or Set accessor to an existing property (issue #25) —
 * insertPropertyAccessorIntoXml.
 *
 * A user deletes a property's Get or Set (in XAE or here) and later wants it back. The inserted block
 * must have exactly the shape insertComponentIntoXml writes for a NEW property's accessor (interface:
 * declaration only; function block: `VAR/END_VAR` declaration + empty ST implementation), carry a
 * fresh Id, sit where TwinCAT puts it (Get before Set, both after the property's own Declaration),
 * follow the file's indentation and line endings, and leave every other byte of the file untouched.
 *
 * Byte fidelity is asserted the strongest way: the expected output is the ORIGINAL fixture with the
 * expected block spliced in at the expected offset, compared as whole strings, with the random Id
 * normalised to a fixed placeholder first.
 */

const { insertPropertyAccessorIntoXml, insertComponentIntoXml, parseTwinCatXml } = require('../src/xmlParser');
const { accessorIdsFor } = require('../src/componentId');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const UUID_RE = /\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}/g;
const ID = '{ID}';

/** Replaces every Id the fixture did not already contain with the placeholder. */
function normaliseNewIds(original, out) {
    const known = new Set(original.match(UUID_RE) || []);
    return out.replace(UUID_RE, id => (known.has(id) ? id : ID));
}

/** Splices `block` into `text` at the offset of `anchor` (+ `delta`), asserting the anchor exists. */
function spliceAt(text, anchor, block, delta = 0) {
    const at = text.indexOf(anchor);
    if (at === -1) throw new Error(`fixture anchor missing: ${anchor}`);
    return text.slice(0, at + delta) + block + text.slice(at + delta);
}

const CRLF = '\r\n';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
// A function block with three properties: one with only a Set, one with only a Get, one with
// neither (just its Declaration) — and one that has both, for the already-present case. The
// LineIds group is the XAE shape (`FB.Prop.Get`). `Data` sits in a folder whose path holds `&amp;`.
const pouLines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">',
    '  <POU Name="FB_Acc" Id="{aaaaaaaa-0000-0000-0000-000000000001}" SpecialFunc="None">',
    '    <Declaration><![CDATA[FUNCTION_BLOCK FB_Acc',
    'VAR',
    '\t_n : INT;',
    'END_VAR]]></Declaration>',
    '    <Implementation>',
    '      <ST><![CDATA[]]></ST>',
    '    </Implementation>',
    '    <Folder Name="A &amp; B" Id="{aaaaaaaa-0000-0000-0000-000000000002}" />',
    '    <Property Name="OnlySet" Id="{aaaaaaaa-0000-0000-0000-000000000003}">',
    '      <Declaration><![CDATA[PROPERTY OnlySet : INT',
    ']]></Declaration>',
    '      <Set Name="Set" Id="{aaaaaaaa-0000-0000-0000-000000000004}">',
    '        <Declaration><![CDATA[VAR',
    'END_VAR',
    ']]></Declaration>',
    '        <Implementation>',
    '          <ST><![CDATA[_n := OnlySet;]]></ST>',
    '        </Implementation>',
    '      </Set>',
    '    </Property>',
    '    <Property Name="OnlyGet" Id="{aaaaaaaa-0000-0000-0000-000000000005}">',
    '      <Declaration><![CDATA[PROPERTY OnlyGet : INT',
    ']]></Declaration>',
    '      <Get Name="Get" Id="{aaaaaaaa-0000-0000-0000-000000000006}">',
    '        <Declaration><![CDATA[VAR',
    'END_VAR',
    ']]></Declaration>',
    '        <Implementation>',
    '          <ST><![CDATA[OnlyGet := _n;]]></ST>',
    '        </Implementation>',
    '      </Get>',
    '    </Property>',
    '    <Property Name="Data" Id="{aaaaaaaa-0000-0000-0000-000000000007}" FolderPath="A &amp; B\\">',
    '      <Declaration><![CDATA[PROPERTY Data : INT',
    ']]></Declaration>',
    '    </Property>',
    '    <Property Name="Both" Id="{aaaaaaaa-0000-0000-0000-000000000008}">',
    '      <Declaration><![CDATA[PROPERTY Both : INT]]></Declaration>',
    '      <Get Name="Get" Id="{aaaaaaaa-0000-0000-0000-000000000009}">',
    '        <Declaration><![CDATA[]]></Declaration>',
    '        <Implementation>',
    '          <ST><![CDATA[]]></ST>',
    '        </Implementation>',
    '      </Get>',
    '      <Set Name="Set" Id="{aaaaaaaa-0000-0000-0000-00000000000a}">',
    '        <Declaration><![CDATA[]]></Declaration>',
    '        <Implementation>',
    '          <ST><![CDATA[]]></ST>',
    '        </Implementation>',
    '      </Set>',
    '    </Property>',
    '    <LineIds Name="FB_Acc">',
    '      <LineId Id="1" Count="0" />',
    '    </LineIds>',
    '    <LineIds Name="FB_Acc.OnlySet.Set">',
    '      <LineId Id="2" Count="0" />',
    '    </LineIds>',
    '    <LineIds Name="FB_Acc.OnlyGet.Get">',
    '      <LineId Id="2" Count="0" />',
    '    </LineIds>',
    '  </POU>',
    '</TcPlcObject>',
    '',
];
const pouXml = pouLines.join(CRLF);

const itfXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">',
    '  <Itf Name="I_Acc" Id="{bbbbbbbb-0000-0000-0000-000000000001}">',
    '    <Declaration><![CDATA[INTERFACE I_Acc',
    ']]></Declaration>',
    '    <Property Name="OnlySet" Id="{bbbbbbbb-0000-0000-0000-000000000002}">',
    '      <Declaration><![CDATA[PROPERTY OnlySet : INT',
    ']]></Declaration>',
    '      <Set Name="Set" Id="{bbbbbbbb-0000-0000-0000-000000000003}">',
    '        <Declaration><![CDATA[]]></Declaration>',
    '      </Set>',
    '    </Property>',
    '    <Property Name="OnlyGet" Id="{bbbbbbbb-0000-0000-0000-000000000004}">',
    '      <Declaration><![CDATA[PROPERTY OnlyGet : INT',
    ']]></Declaration>',
    '      <Get Name="Get" Id="{bbbbbbbb-0000-0000-0000-000000000005}">',
    '        <Declaration><![CDATA[]]></Declaration>',
    '      </Get>',
    '    </Property>',
    '    <Property Name="Neither" Id="{bbbbbbbb-0000-0000-0000-000000000006}">',
    '      <Declaration><![CDATA[PROPERTY Neither : INT',
    ']]></Declaration>',
    '    </Property>',
    '  </Itf>',
    '</TcPlcObject>',
    '',
].join(CRLF);

/** The POU accessor block exactly as insertComponentIntoXml writes it (6-space indent, given EOL). */
const pouBlock = (type, eol) => [
    `      <${type} Name="${type}" Id="${ID}">`,
    '        <Declaration><![CDATA[VAR',
    'END_VAR',
    ']]></Declaration>',
    '        <Implementation>',
    '          <ST><![CDATA[]]></ST>',
    '        </Implementation>',
    `      </${type}>`,
].join(eol);
const itfBlock = (type, eol) => [
    `      <${type} Name="${type}" Id="${ID}">`,
    '        <Declaration><![CDATA[]]></Declaration>',
    `      </${type}>`,
].join(eol);

/** Ids of the accessors the parser reports for property `name`. */
function accessorsOf(xml, name) {
    const parsed = parseTwinCatXml(xml);
    const ids = accessorIdsFor(`prop_${name}`);
    const has = id => !!(parsed && parsed.components.find(c => c.id === id));
    return { get: has(ids.get), set: has(ids.set) };
}

// ── 0. The shape matches what a NEW property's accessors look like ───────────────────────────────
// Guards the claim "exactly the shape insertComponentIntoXml writes": take a freshly created
// property's Get/Set blocks from insertComponentIntoXml and compare them with ours.
for (const isItf of [false, true]) {
    const fresh = normaliseNewIds('', insertComponentIntoXml(isItf ? itfXml : pouXml, null, isItf, 'Fresh', 'Property', ''));
    const kind = isItf ? 'ITF' : 'POU';
    for (const type of ['Get', 'Set']) {
        const expected = (isItf ? itfBlock : pouBlock)(type, CRLF);
        assert(fresh.includes(expected), `${kind} SHAPE: a new property's ${type} block equals the re-add block`);
    }
}

// ── 1. POU: add Get where only Set exists — Get lands immediately before Set ─────────────────────
{
    const out = insertPropertyAccessorIntoXml(pouXml, 'OnlySet', 'Get', false);
    const setLine = '      <Set Name="Set" Id="{aaaaaaaa-0000-0000-0000-000000000004}">';
    const expected = spliceAt(pouXml, setLine, pouBlock('Get', CRLF) + CRLF);
    assert(normaliseNewIds(pouXml, out) === expected, 'POU Get-before-Set: whole file = original + Get block before <Set>');
    assert(out.indexOf('<Get Name="Get"') < out.indexOf(setLine), 'POU Get-before-Set: Get precedes Set');
    const acc = accessorsOf(out, 'OnlySet');
    assert(acc.get && acc.set, 'POU Get-before-Set: re-parse reports both accessors');
    const newIds = (out.match(UUID_RE) || []).filter(id => !pouXml.includes(id));
    assert(newIds.length === 1, `POU: exactly one fresh Id is minted (got ${newIds.length})`);
}

// ── 2. POU: add Set where only Get exists — after </Get> ─────────────────────────────────────────
{
    const out = insertPropertyAccessorIntoXml(pouXml, 'OnlyGet', 'Set', false);
    const anchor = '      </Get>\r\n    </Property>\r\n    <Property Name="Data"';
    const expected = spliceAt(pouXml, anchor, CRLF + pouBlock('Set', CRLF), '      </Get>'.length);
    assert(normaliseNewIds(pouXml, out) === expected, 'POU Set-after-Get: whole file = original + Set block after </Get>');
    const acc = accessorsOf(out, 'OnlyGet');
    assert(acc.get && acc.set, 'POU Set-after-Get: re-parse reports both accessors');
}

// ── 3. POU: neither accessor; FolderPath carries &amp; — both orders give Get then Set ───────────
{
    const declEnd = '    <Property Name="Data" Id="{aaaaaaaa-0000-0000-0000-000000000007}" FolderPath="A &amp; B\\">\r\n      <Declaration><![CDATA[PROPERTY Data : INT\r\n]]></Declaration>';
    const outGet = insertPropertyAccessorIntoXml(pouXml, 'Data', 'Get', false);
    assert(normaliseNewIds(pouXml, outGet) === spliceAt(pouXml, declEnd, CRLF + pouBlock('Get', CRLF), declEnd.length),
        'POU neither + Get: Get lands right after the property Declaration (FolderPath with &amp;)');
    const accGet = accessorsOf(outGet, 'Data');
    assert(accGet.get && !accGet.set, 'POU neither + Get: re-parse reports Get only');
    const parsedGet = parseTwinCatXml(outGet);
    const getComp = parsedGet && parsedGet.components.find(c => c.id === 'prop_Data_get');
    assert(!!getComp && getComp.folderPath === 'A & B\\', 'POU neither + Get: the accessor inherits the decoded folder path');
    assert(!!getComp && getComp.implementation === '' && getComp.implementationLanguage === 'ST',
        'POU neither + Get: the accessor has an empty ST implementation');

    const outSet = insertPropertyAccessorIntoXml(pouXml, 'Data', 'Set', false);
    assert(normaliseNewIds(pouXml, outSet) === spliceAt(pouXml, declEnd, CRLF + pouBlock('Set', CRLF), declEnd.length),
        'POU neither + Set: Set lands right after the property Declaration');

    // Then add the other one: the canonical order is restored whichever came first.
    const both1 = insertPropertyAccessorIntoXml(outGet, 'Data', 'Set', false);
    const both2 = insertPropertyAccessorIntoXml(outSet, 'Data', 'Get', false);
    const block = normaliseNewIds(pouXml, both1);
    assert(block === normaliseNewIds(pouXml, both2), 'POU neither: Get→Set and Set→Get produce the same file');
    assert(block === spliceAt(pouXml, declEnd, CRLF + pouBlock('Get', CRLF) + CRLF + pouBlock('Set', CRLF), declEnd.length),
        'POU neither: both added = Declaration, Get, Set');
}

// ── 4. Already present → unchanged; unknown property / bad type → unchanged ──────────────────────
{
    assert(insertPropertyAccessorIntoXml(pouXml, 'Both', 'Get', false) === pouXml, 'present Get: text returned unchanged');
    assert(insertPropertyAccessorIntoXml(pouXml, 'Both', 'Set', false) === pouXml, 'present Set: text returned unchanged');
    assert(insertPropertyAccessorIntoXml(pouXml, 'OnlyGet', 'Get', false) === pouXml, 'OnlyGet + Get: unchanged');
    assert(insertPropertyAccessorIntoXml(pouXml, 'NoSuchProp', 'Get', false) === pouXml, 'unknown property: unchanged');
    assert(insertPropertyAccessorIntoXml(pouXml, 'OnlySet', /** @type {any} */ ('Foo'), false) === pouXml, 'unknown accessor type: unchanged');
    // `Both` would match a sloppy substring/regex lookup for `Bot`; the decoded-Name lookup must not.
    assert(insertPropertyAccessorIntoXml(pouXml, 'Bot', 'Get', false) === pouXml, 'name prefix of another property: unchanged');
}

// ── 5. Interface: declaration-only shape, same placement rules ───────────────────────────────────
{
    const setLine = '      <Set Name="Set" Id="{bbbbbbbb-0000-0000-0000-000000000003}">';
    const outGet = insertPropertyAccessorIntoXml(itfXml, 'OnlySet', 'Get', true);
    assert(normaliseNewIds(itfXml, outGet) === spliceAt(itfXml, setLine, itfBlock('Get', CRLF) + CRLF),
        'ITF Get-before-Set: declaration-only Get block before <Set>');
    assert(!/<Get[^]*?<Implementation>[^]*?<\/Get>/.test(outGet), 'ITF: the new accessor has no Implementation');

    const getEnd = '      </Get>\r\n    </Property>\r\n    <Property Name="Neither"';
    const outSet = insertPropertyAccessorIntoXml(itfXml, 'OnlyGet', 'Set', true);
    assert(normaliseNewIds(itfXml, outSet) === spliceAt(itfXml, getEnd, CRLF + itfBlock('Set', CRLF), '      </Get>'.length),
        'ITF Set-after-Get: declaration-only Set block after </Get>');

    const outNeither = insertPropertyAccessorIntoXml(itfXml, 'Neither', 'Get', true);
    const acc = accessorsOf(outNeither, 'Neither');
    assert(acc.get && !acc.set, 'ITF neither + Get: re-parse reports Get only');
}

// ── 6. LF documents stay LF ──────────────────────────────────────────────────────────────────────
{
    const lfXml = pouXml.replace(/\r\n/g, '\n');
    const out = insertPropertyAccessorIntoXml(lfXml, 'OnlySet', 'Get', false);
    assert(!out.includes('\r'), 'EOL: an LF document gets no CR');
    const setLine = '      <Set Name="Set" Id="{aaaaaaaa-0000-0000-0000-000000000004}">';
    assert(normaliseNewIds(lfXml, out) === spliceAt(lfXml, setLine, pouBlock('Get', '\n') + '\n'),
        'EOL: LF document — whole file = original + LF Get block');

    const crlfOut = insertPropertyAccessorIntoXml(pouXml, 'OnlyGet', 'Set', false);
    assert(!/(?<!\r)\n/.test(crlfOut), 'EOL: a CRLF document gets no bare LF');
}

// ── 7. Indentation follows the file (tabs, here) ─────────────────────────────────────────────────
{
    const tabXml = pouXml.replace(/^( +)/gm, sp => '\t'.repeat(sp.length / 2));
    const out = insertPropertyAccessorIntoXml(tabXml, 'OnlySet', 'Get', false);
    const setLine = '\t\t\t<Set Name="Set" Id="{aaaaaaaa-0000-0000-0000-000000000004}">';
    const tabBlock = pouBlock('Get', CRLF).replace(/^( +)/gm, sp => '\t'.repeat(sp.length / 2));
    assert(normaliseNewIds(tabXml, out) === spliceAt(tabXml, setLine, tabBlock + CRLF),
        'INDENT: a tab-indented file gets a tab-indented accessor');
}

// ── 8. No LineIds are added (a new property's accessors get none either; XAE writes them) ────────
{
    const out = insertPropertyAccessorIntoXml(pouXml, 'OnlySet', 'Get', false);
    const count = s => (s.match(/<LineIds\b/g) || []).length;
    assert(count(out) === count(pouXml), 'LINEIDS: re-adding an accessor writes no LineIds entry');
}

if (errors) {
    console.error(`\n${errors} property-accessor assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll property-accessor insert assertions passed.');
