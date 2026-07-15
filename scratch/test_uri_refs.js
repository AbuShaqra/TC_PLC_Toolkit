/**
 * @file test_uri_refs.js
 * @description Regression: cross-file references must not skip files that were opened (and
 * therefore live-indexed with a VS Code percent-encoded URI) earlier in the session. The
 * disk scan stores unencoded URIs; the live editor re-indexes the active file with an encoded
 * URI. features.js must resolve both to the same fsPath (decodeURIComponent) and treat them as
 * the same file for dedup, so no occurrences are silently dropped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { indexTwinCatDirectory } = require('../src/lsp/xmlIndexer');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideReferences } = require('../src/lsp/features');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_uritest_'));

function tcpou(name, decl, impl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="{00000000-0000-0000-0000-0000000000${name.length}0}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation><ST><![CDATA[${impl}]]></ST></Implementation>
  </POU>
</TcPlcObject>`;
}
const gvlXml = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <GVL Name="GVL_App"><Declaration><![CDATA[VAR_GLOBAL
\tg_Shared : INT;
END_VAR]]></Declaration></GVL>
</TcPlcObject>`;

const files = {
    'GVL_App.TcGVL': gvlXml,
    'FB_A.TcPOU': tcpou('FB_A', 'FUNCTION_BLOCK FB_A\nVAR\nEND_VAR', 'g_Shared := 1;'),
    'FB_B.TcPOU': tcpou('FB_B', 'FUNCTION_BLOCK FB_B\nVAR\nEND_VAR', 'g_Shared := 2;'),
};
for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c, 'utf8');

try {
    // 1. Server startup: index workspace from disk (unencoded URIs).
    clearWorkspaceIndex();
    indexTwinCatDirectory(getWorkspaceSymbolIndex(), dir);

    // Percent-encode the drive colon, mimicking VS Code's Uri.toString().
    const encUri = (name) => 'file:///' + path.join(dir, name).replace(/\\/g, '/').replace(/:/, '%3A');

    // 2. Simulate opening FB_A during the session -> live re-index with an ENCODED uri.
    const aCtx = convertXmlToSt(parseTwinCatXml(files['FB_A.TcPOU']), { raw: true });
    parseAndIndexDocument(aCtx.stText, encUri('FB_A.TcPOU'));

    // 3. Search for g_Shared from FB_B (the active file), also encoded uri.
    const bCtx = convertXmlToSt(parseTwinCatXml(files['FB_B.TcPOU']), { raw: true });
    const bUri = encUri('FB_B.TcPOU');
    parseAndIndexDocument(bCtx.stText, bUri);

    const absLine = bCtx.lineMap.root.impl.start - 1; // 'g_Shared := 2;'
    const ch = bCtx.stText.split('\n')[absLine].indexOf('g_Shared') + 1;
    const refs = provideReferences(bCtx.stText, { line: absLine, character: ch }, getWorkspaceSymbolIndex(), bUri);

    const filesHit = new Set(refs.map(r => path.basename(decodeURIComponent(r.uri)).toLowerCase()));

    // FB_A was opened earlier (encoded URI) but must still appear in the cross-file scan.
    assert([...filesHit].some(f => /fb_a/.test(f)),
        'FB_A (opened earlier -> encoded URI) is included in the cross-file reference scan');
    assert([...filesHit].some(f => /fb_b/.test(f)), 'FB_B (active file) is included');
    assert([...filesHit].some(f => /gvl_app/.test(f)), 'GVL_App (the definition) is included');

    // No double-listing: the active file FB_B must not be scanned twice via its unencoded index URI.
    const bHits = refs.filter(r => /fb_b/i.test(path.basename(decodeURIComponent(r.uri))));
    assert(bHits.length === 1, `active file FB_B listed exactly once (got ${bHits.length})`);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll URI cross-file reference assertions passed.');
