/**
 * @file test_symbol_node.js
 * @description Conformance test for the shared symbol-node factory (src/lsp/symbolNode.js). A symbol
 * node is built two ways — parser.js (`parseAndIndexDocument`, active document) and xmlIndexer.js
 * (`buildNodeFromXml`, every other document). They used to drift (parser had returnType/bodyRange, the
 * XML indexer did not). This asserts BOTH now emit the identical canonical core shape, so a field added
 * to one can never be silently missing from the other. Source-specific extras (e.g. DUT `dutKind`) are
 * allowed on top of — but never instead of — the core shape.
 */

const { SYMBOL_NODE_KEYS, createSymbolNode } = require('../src/lsp/symbolNode');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { buildNodeFromXml } = require('../src/lsp/xmlIndexer');

let errors = 0;
function check(desc, cond) {
    if (cond) console.log(`[PASS] ${desc}`);
    else { console.error(`[FAIL] ${desc}`); errors++; }
}

let guidN = 0;
const guid = () => `{00000000-0000-0000-0000-${String(++guidN).padStart(12, '0')}}`;
function tcpou(name, decl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="${guid()}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation><ST><![CDATA[]]></ST></Implementation>
  </POU>
</TcPlcObject>`;
}
function tcdut(name, decl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <DUT Name="${name}" Id="${guid()}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </DUT>
</TcPlcObject>`;
}

const core = [...SYMBOL_NODE_KEYS].sort();

console.log('\n--- The factory defines one stable core shape ---');
check(`createSymbolNode() yields a fixed core key set (${core.length} keys)`, core.length === 14);
check('an empty createSymbolNode() already carries every core key',
    JSON.stringify(Object.keys(createSymbolNode()).sort()) === JSON.stringify(core));
check('the required collections default to arrays and returnType/bodyRange to null', (() => {
    const n = createSymbolNode();
    return Array.isArray(n.variables) && Array.isArray(n.methods) && Array.isArray(n.properties)
        && Array.isArray(n.actions) && Array.isArray(n.extendsAll)
        && n.returnType === null && n.bodyRange === null && n.extends === null;
})());

console.log('\n--- Both indexers emit the identical core shape (anti-drift) ---');
const DECL = 'FUNCTION_BLOCK FB_Test\nVAR\n\tbX : BOOL;\nEND_VAR';

clearWorkspaceIndex();
const idx = getWorkspaceSymbolIndex();
parseAndIndexDocument(DECL + '\nEND_FUNCTION_BLOCK', 'file:///t.st');
const parserNode = idx['FB_Test'];
const parserKeys = Object.keys(parserNode).sort();

const xmlNode = buildNodeFromXml(tcpou('FB_Test', DECL), 'file:///t.TcPOU');
const xmlKeys = Object.keys(xmlNode).sort();

check('parser produced an FB_Test node', !!parserNode);
check('xmlIndexer produced an FB_Test node', !!xmlNode);
check('parser node carries every core key', core.every(k => parserKeys.includes(k)));
check('xmlIndexer node carries every core key', core.every(k => xmlKeys.includes(k)));
check('an FB node from either indexer has EXACTLY the core keys — no drift',
    JSON.stringify(parserKeys) === JSON.stringify(core) && JSON.stringify(xmlKeys) === JSON.stringify(core));

console.log('\n--- Source-specific fields sit ON TOP of the core, never replace it ---');
const dutNode = buildNodeFromXml(tcdut('ST_Data', 'TYPE ST_Data :\nSTRUCT\n\tnA : INT;\nEND_STRUCT\nEND_TYPE'), 'file:///d.TcDUT');
const dutKeys = Object.keys(dutNode).sort();
check('a DUT node still carries every core key', core.every(k => dutKeys.includes(k)));
check("a DUT node adds 'dutKind' as an extra, without dropping any core key",
    dutKeys.includes('dutKind') && core.every(k => dutKeys.includes(k)));

console.log(`\n--- SYMBOL NODE CONFORMANCE TESTS COMPLETE with ${errors} error(s) ---`);
if (errors > 0) process.exit(1);
