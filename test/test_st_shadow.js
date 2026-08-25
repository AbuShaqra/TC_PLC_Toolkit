/**
 * @file test_st_shadow.js
 * @description Regression: a plain .st source must never steal a symbol already backed by a
 * TwinCAT XML object. On a real project, a STALE exported mirror `P_Automatic.st` sat NEXT to
 * `P_Automatic.TcPOU` (outside the ST_Files/ folder that indexStDirectory skips), and because
 * `custom/reindex` runs indexTwinCatDirectory THEN indexStDirectory, parsing the mirror
 * overwrote the P_Automatic index node — hijacking its uri to the .st file. Find References for
 * FB_Feeder.Home() then walked node uris, read the stale mirror (which lacked the call), and
 * the real .TcPOU was never scanned: the call site was invisible until the user opened the file
 * (syncDocument re-registered the node with the .TcPOU uri, masking the bug).
 *
 * The invariant under test: XML is the source of truth — parseAndIndexDocument parses a .st
 * whose name collides with an XML-backed node into a DETACHED node and leaves the index entry
 * alone, while genuine standalone .st sources still index normally.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { indexTwinCatDirectory } = require('../src/lsp/xmlIndexer');
const { parseAndIndexDocument, indexStDirectory, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideReferences, clearStFileCache } = require('../src/lsp/features');
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

/** Builds a .TcTLEO document — an <EnumerationTextList> root whose Declaration is an ordinary enum. */
function tctleo(name, decl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <EnumerationTextList Name="${name}" Id="${guid()}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </EnumerationTextList>
</TcPlcObject>`;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_shadow_'));

const files = {
    'FB_Widget.TcPOU': tcpou('FB_Widget', 'FUNCTION_BLOCK FB_Widget\nVAR\nEND_VAR', '',
        [{ name: 'Home', decl: 'METHOD Home : BOOL', impl: 'Home := TRUE;' }]),
    'GVL_X.TcGVL': tcgvl('GVL_X', 'VAR_GLOBAL\n\tfbWidget : FB_Widget;\nEND_VAR'),
    // The real program: calls the method. This is the file the references scan MUST reach.
    'P_Main.TcPOU': tcpou('P_Main', 'PROGRAM P_Main\nVAR\nEND_VAR', 'GVL_X.fbWidget.Home();'),
    // The STALE mirror: same POU name, same directory (NOT under ST_Files/, so the folder-name
    // skip cannot catch it), and — being stale — WITHOUT the Home() call.
    'P_Main.st': 'PROGRAM P_Main\nVAR\n\tnOld : INT;\nEND_VAR\n\nnOld := nOld + 1;\n',
    // A genuine standalone .st source with no XML counterpart: must still be indexed.
    'FB_Solo.st': 'FUNCTION_BLOCK FB_Solo\nVAR\n\tbActive : BOOL;\nEND_VAR\n\nbActive := TRUE;\n',
    // A .TcTLEO is XML-backed too (EnumerationTextList — a DUT in every way that matters), so a
    // same-named .st must be just as powerless. The shadow-guard regex once omitted .tctleo. Note
    // the mirror is POU-shaped ON PURPOSE: parseAndIndexDocument indexes no TYPE…END_TYPE at all
    // (DUTs come exclusively from the XML indexer), so a TYPE-shaped mirror is inert by
    // construction and only a POU-shaped one can actually steal the node.
    'E_Mode.TcTLEO': tctleo('E_Mode', 'TYPE E_Mode :\n(\n\tIdle := 0,\n\tRunning := 1\n);\nEND_TYPE'),
    'E_Mode.st': 'PROGRAM E_Mode\nVAR\n\tnStale : INT;\nEND_VAR\n',
};
for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c, 'utf8');

/** The unencoded disk-scan uri, as xmlIndexer/indexStDirectory build it. */
const diskUri = (name) => 'file:///' + path.join(dir, name).replace(/\\/g, '/').replace(/^\//, '');

try {
    // ── 1. The server's startup/reindex order: XML objects first, then stray .st files. ──────────
    // This is the exact sequence that hijacked P_Automatic's node: the .st mirror parsed LAST and
    // overwrote the XML-backed node's uri.
    const idx1 = {};
    indexTwinCatDirectory(idx1, dir);
    indexStDirectory(dir, idx1);
    assert(idx1['P_Main'] && /\.tcpou$/i.test(idx1['P_Main'].uri),
        `P_Main stays backed by the .TcPOU after the stale sibling .st is scanned (uri: ${idx1['P_Main'] && idx1['P_Main'].uri})`);
    assert(idx1['FB_Solo'] && /\.st$/i.test(idx1['FB_Solo'].uri),
        'FB_Solo (a standalone .st with no XML counterpart) is still indexed with its .st uri');
    assert(idx1['FB_Widget'] && idx1['GVL_X'], 'FB_Widget and GVL_X are indexed (fixture sanity)');
    assert(idx1['E_Mode'] && /\.tctleo$/i.test(idx1['E_Mode'].uri),
        `E_Mode stays backed by the .TcTLEO after the stale sibling .st is scanned (uri: ${idx1['E_Mode'] && idx1['E_Mode'].uri})`);

    // ── 2. Reverse order: XML must win no matter which side is scanned first. ────────────────────
    // The .st registers first here; indexXmlObject then overwrites it — that direction is the
    // desired one (XML is the source of truth), so no guard may block it.
    const idx2 = {};
    indexStDirectory(dir, idx2);
    indexTwinCatDirectory(idx2, dir);
    assert(idx2['P_Main'] && /\.tcpou$/i.test(idx2['P_Main'].uri),
        'P_Main is backed by the .TcPOU when the .st was indexed FIRST (XML overwrite direction intact)');

    // ── 3. End-to-end: the user's exact scenario. ─────────────────────────────────────────────────
    // Find References on METHOD Home in the open FB_Widget editor must reach the call site in
    // P_Main.TcPOU — a file that was never opened and has a stale .st mirror beside it. Before the
    // fix, the scan followed the hijacked uri to the mirror and returned no P_Main hit.
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    indexTwinCatDirectory(index, dir);
    indexStDirectory(dir, index);
    clearStFileCache();

    // Assemble FB_Widget the way the editor does, and sync it like custom/references does.
    const fbUri = diskUri('FB_Widget.TcPOU');
    const fbCtx = convertXmlToSt(parseTwinCatXml(files['FB_Widget.TcPOU']), { raw: true });
    parseAndIndexDocument(fbCtx.stText, fbUri, index);

    const stLines = fbCtx.stText.split('\n');
    const declLine = stLines.findIndex(l => /^\s*METHOD\s+Home\b/i.test(l));
    assert(declLine !== -1, 'the assembled FB_Widget unit contains the METHOD Home declaration');

    const ch = stLines[declLine].indexOf('Home') + 1;
    const refs = provideReferences(fbCtx.stText, { line: declLine, character: ch }, index, fbUri);
    const hitFiles = refs.map(r => path.basename(decodeURIComponent(r.uri)));

    assert(hitFiles.some(f => /^p_main\.tcpou$/i.test(f)),
        `the call site in the unopened P_Main.TcPOU is found despite the stale sibling mirror (hits: ${hitFiles.join(', ') || 'none'})`);
    assert(hitFiles.some(f => /^fb_widget\.tcpou$/i.test(f)),
        'the METHOD Home declaration itself is reported (sanity)');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll .st shadow-guard assertions passed.');
