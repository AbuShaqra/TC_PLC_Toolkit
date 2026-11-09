/**
 * @file test_program_methods.js
 * @description METHODs under a PROGRAM (ROADMAP R5): the converter must keep a PROGRAM a PROGRAM —
 * TwinCAT calls a program's method without an instance (`MAIN.Init()`), which a FUNCTION_BLOCK
 * cannot do — and the language server must scope those methods correctly: the method sees the
 * program's variables, and another POU's `MAIN.Init()` resolves (definition, references,
 * completion) without a false-positive diagnostic.
 *
 * Synthetic .TcPOU fixtures, written to a temp directory because find-references reads every other
 * indexed document from disk; drives the production live path (`src/livePath.js`) and the LSP
 * providers exactly as the extension host does. No vscode, no sample/ needed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideCompletions, provideDefinition, provideDiagnostics, provideReferences } = require('../src/lsp/features');
const { assembleSt, localToAbsolute, mapDiagnosticsToLocal } = require('../src/livePath');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/**
 * Wraps declaration/implementation text in a minimal TwinCAT POU document.
 * @param {string} name POU name.
 * @param {string} decl Root declaration.
 * @param {string} impl Root implementation.
 * @param {string} [methods] Raw `<Method>` XML to append.
 * @returns {string} The .TcPOU text.
 */
function pouXml(name, decl, impl, methods = '') {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="${name}" Id="{00000000-0000-0000-0000-00000000000${name.length % 10}}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl}]]></ST>
    </Implementation>${methods}
  </POU>
</TcPlcObject>
`;
}

const MAIN_XML = pouXml('MAIN',
    `PROGRAM MAIN
VAR
	nCounter	: INT;
	bReady		: BOOL;
END_VAR
`,
    `nCounter := nCounter + 1;
Init();
`,
    `
    <Method Name="Init" Id="{11111111-1111-1111-1111-111111111111}">
      <Declaration><![CDATA[METHOD Init : BOOL
VAR
	nLocal	: INT;
END_VAR
]]></Declaration>
      <Implementation>
        <ST><![CDATA[nLocal := nCounter;
bReady := TRUE;
Init := bReady;
]]></ST>
      </Implementation>
    </Method>`);

const CALLER_XML = pouXml('P_Caller',
    `PROGRAM P_Caller
VAR
	bOk	: BOOL;
END_VAR
`,
    `bOk := MAIN.Init();
`);

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-program-methods-'));
process.on('exit', () => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

/**
 * Writes a fixture to the temp project and returns its file URI (as the server's scan builds it).
 * @param {string} fileName File name.
 * @param {string} xml File content.
 * @returns {string} file:// URI.
 */
function writeFixture(fileName, xml) {
    const full = path.join(TMP_DIR, fileName);
    fs.writeFileSync(full, xml, 'utf8');
    return 'file:///' + full.replace(/\\/g, '/').replace(/^\//, '');
}

const MAIN_URI = writeFixture('MAIN.TcPOU', MAIN_XML);
const CALLER_URI = writeFixture('P_Caller.TcPOU', CALLER_XML);

/** Rebuilds the workspace index from both fixtures, as the server's XML scan does. */
function reindex() {
    clearWorkspaceIndex();
    const idx = getWorkspaceSymbolIndex();
    indexXmlObject(idx, MAIN_XML, MAIN_URI);
    indexXmlObject(idx, CALLER_XML, CALLER_URI);
    return idx;
}

// ---------------------------------------------------------------------------------------------
// 1. Converter output keeps the PROGRAM kind on every path
// ---------------------------------------------------------------------------------------------
for (const raw of [true, false]) {
    const { stText } = convertXmlToSt(parseTwinCatXml(MAIN_XML), { raw });
    const mode = raw ? 'raw' : 'export';
    assert(/^PROGRAM MAIN\b/m.test(stText), `${mode}: unit declares PROGRAM MAIN`);
    assert(!/\bFUNCTION_BLOCK\b/.test(stText), `${mode}: unit contains no FUNCTION_BLOCK`);
    assert(/^END_PROGRAM\s*$/m.test(stText), `${mode}: unit closes with END_PROGRAM`);
    assert(!/END_FUNCTION_BLOCK/.test(stText), `${mode}: unit has no END_FUNCTION_BLOCK`);
}

// A comment naming another POU kind must not decide the closing keyword.
{
    const commented = pouXml('P_Commented',
        `(* replaces the old FUNCTION_BLOCK FB_Legacy *)
{attribute 'qualified_only'}
PROGRAM P_Commented
VAR
END_VAR
`, ``);
    const { stText } = convertXmlToSt(parseTwinCatXml(commented), { raw: true });
    assert(/^END_PROGRAM\s*$/m.test(stText) && !/END_FUNCTION_BLOCK/.test(stText),
        'a PROGRAM whose leading comment mentions FUNCTION_BLOCK still closes with END_PROGRAM');
}

// ---------------------------------------------------------------------------------------------
// 2. Inside the method, PROGRAM-level vars resolve (no diagnostics on MAIN's own unit)
// ---------------------------------------------------------------------------------------------
{
    const index = reindex();
    const { stText, lineMap } = assembleSt(MAIN_XML, null);
    parseAndIndexDocument(stText, MAIN_URI);
    const diags = provideDiagnostics(stText, index, MAIN_URI);
    assert(diags.length === 0, `MAIN unit has no diagnostics (got ${JSON.stringify(diags.map(d => d.message))})`);
    const mapped = mapDiagnosticsToLocal(diags, lineMap);
    assert(mapped.filter(m => m.componentId === 'method_Init').length === 0, 'method Init has no diagnostics');

    // go-to-definition of nCounter from inside Init's body lands on the PROGRAM's var block
    const abs = localToAbsolute(lineMap, 'method_Init', 'impl', 1, 'nLocal := '.length + 3);
    const def = provideDefinition(stText, abs, index, MAIN_URI);
    assert(def && def.targetWord === 'nCounter' && def.componentId === 'root',
        `nCounter in Init resolves to MAIN's root var block (got ${JSON.stringify(def)})`);

    // The method itself is indexed as a method of MAIN, and MAIN stays a PROGRAM
    const node = index['MAIN'];
    assert(node && node.type === 'PROGRAM', `MAIN is indexed as PROGRAM (got ${node && node.type})`);
    assert(node && (node.methods || []).some(m => m.name === 'Init'), 'MAIN carries method Init');
}

// ---------------------------------------------------------------------------------------------
// 3. From another POU: MAIN.Init() — diagnostics, definition, references, completion
// ---------------------------------------------------------------------------------------------
{
    const index = reindex();
    const { stText, lineMap } = assembleSt(CALLER_XML, null);
    parseAndIndexDocument(stText, CALLER_URI);

    const diags = provideDiagnostics(stText, index, CALLER_URI);
    assert(diags.length === 0, `P_Caller (MAIN.Init()) has no diagnostics (got ${JSON.stringify(diags.map(d => d.message))})`);

    const implLine = 'bOk := MAIN.Init();';
    const initCol0 = implLine.indexOf('Init') + 1;
    const abs = localToAbsolute(lineMap, 'root', 'impl', 1, initCol0 + 1);
    const def = provideDefinition(stText, abs, index, CALLER_URI);
    assert(def && /MAIN\.TcPOU$/i.test(def.uri || ''), `MAIN.Init() definition lands in MAIN.TcPOU (got ${JSON.stringify(def)})`);
    assert(def && def.componentId === 'method_Init', `MAIN.Init() definition targets method_Init (got ${def && def.componentId})`);

    const refs = provideReferences(stText, abs, index, CALLER_URI) || [];
    assert(refs.some(r => /P_Caller\.TcPOU$/i.test(r.uri || '')),
        `find-references on MAIN.Init() includes the call in P_Caller (got ${JSON.stringify(refs.map(r => r.uri))})`);
    assert(refs.some(r => /MAIN\.TcPOU$/i.test(r.uri || '')),
        `find-references on MAIN.Init() includes the declaration in MAIN (got ${JSON.stringify(refs.map(r => r.uri))})`);

    // completion after "MAIN."
    const dotCol0 = implLine.indexOf('MAIN.') + 'MAIN.'.length;
    const partial = stText.split('\n').map((l, i) => i === abs.line ? l.substring(0, dotCol0) : l).join('\n');
    parseAndIndexDocument(partial, CALLER_URI);
    const comps = provideCompletions(partial, { line: abs.line, character: dotCol0 }, index, CALLER_URI) || [];
    const labels = comps.map(c => c.label);
    assert(labels.includes('Init'), `completion after "MAIN." offers Init (got ${labels.join(', ')})`);
}

// ---------------------------------------------------------------------------------------------
// 4. The caller's references survive the active MAIN unit being re-parsed (live path on MAIN)
// ---------------------------------------------------------------------------------------------
{
    const index = reindex();
    const { stText, lineMap } = assembleSt(MAIN_XML, null);
    parseAndIndexDocument(stText, MAIN_URI);
    // cursor on the method name in Init's declaration pane: `METHOD Init : BOOL`
    const abs = localToAbsolute(lineMap, 'method_Init', 'decl', 1, 'METHOD '.length + 2);
    const refs = provideReferences(stText, abs, index, MAIN_URI) || [];
    assert(refs.some(r => /P_Caller\.TcPOU$/i.test(r.uri || '')),
        `references from Init's declaration include MAIN.Init() in P_Caller (got ${JSON.stringify(refs.map(r => r.uri))})`);
}

if (errors > 0) {
    console.error(`\n${errors} assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll PROGRAM-method assertions passed.');
