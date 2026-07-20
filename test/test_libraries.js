/**
 * @file test_libraries.js
 * @description Library-namespace registry (src/lsp/libraries.js): namespaces are harvested from the
 * .plcproj's <PlaceholderReference> blocks, matched case-insensitively (ST is case-insensitive), and
 * used by the undeclared-identifier check to stay silent on library namespace heads.
 *
 * The over-suppression guard matters as much as the fix: a genuinely undeclared identifier must
 * still be flagged, and only the namespace *head* may be exempt — nothing else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    extractNamespaces,
    indexLibraryNamespaces,
    isLibraryNamespace,
    getLibraryNamespaces,
    clearLibraryNamespaces
} = require('../src/lsp/libraries');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideDiagnostics } = require('../src/lsp/features');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const PLCPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <PlaceholderReference Include="System_VisuElems">
      <DefaultResolution>VisuElems, 4.8.0.0 (System)</DefaultResolution>
      <Namespace>VisuElems</Namespace>
      <SystemLibrary>true</SystemLibrary>
    </PlaceholderReference>
    <PlaceholderReference Include="Tc2_Standard">
      <DefaultResolution>Tc2_Standard, * (Beckhoff Automation GmbH)</DefaultResolution>
      <Namespace>Tc2_Standard</Namespace>
    </PlaceholderReference>
    <PlaceholderReference Include="Balluff BVS Sensor">
      <DefaultResolution>Balluff Sesnor Library TC3, * (Balluff GmbH)</DefaultResolution>
      <Namespace>Balluff_BVS_Sensor</Namespace>
    </PlaceholderReference>
  </ItemGroup>
  <ItemGroup>
    <!-- Pinned direct references carry a <Namespace> too, and must be harvested as well. -->
    <LibraryReference Include="Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH">
      <Namespace>Tc2_EtherCAT</Namespace>
    </LibraryReference>
  </ItemGroup>
  <ItemGroup>
    <!-- A <Namespace> outside a reference element must NOT be harvested. -->
    <Compile Include="POUs\\MAIN.TcPOU">
      <Namespace>NotALibrary</Namespace>
      <SubType>Code</SubType>
    </Compile>
  </ItemGroup>
</Project>`;

function tcpou(name, decl, impl) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="{00000000-0000-0000-0000-00000000000${name.length}}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation><ST><![CDATA[${impl}]]></ST></Implementation>
  </POU>
</TcPlcObject>`;
}

// A POU that roots a member chain at a library namespace, and separately uses an identifier that
// is declared nowhere at all.
const FB_LIB = tcpou('FB_Lib',
    'FUNCTION_BLOCK FB_Lib\nVAR\n\tpClient : POINTER TO BYTE;\n\tbOk : BOOL;\nEND_VAR',
    'VisuElems.VisuElemBase.Visu_Globals.g_ClientManager.BeginIteration();\n' +
    'pClient := VisuElems.VisuElemBase.Visu_Globals.g_ClientManager.GetNextClient();\n' +
    'bOk := Tc2_Standard.SEL(TRUE, FALSE, TRUE);\n');

const FB_BAD = tcpou('FB_Bad',
    'FUNCTION_BLOCK FB_Bad\nVAR\n\tbOk : BOOL;\nEND_VAR',
    'bOk := TRUE;\nnSomethingNeverDeclared := 42;\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_libtest_'));

/**
 * Indexes a synthetic TwinCAT object and returns its diagnostics.
 * @param {string} fileName File name (used for the URI).
 * @param {string} xml TwinCAT XML text.
 * @returns {Object[]} LSP diagnostics.
 */
function diagnose(fileName, xml) {
    const fileUri = 'file:///' + path.join(dir, fileName).replace(/\\/g, '/');
    const index = getWorkspaceSymbolIndex();
    indexXmlObject(index, xml, fileUri);
    const { stText } = convertXmlToSt(parseTwinCatXml(xml));
    parseAndIndexDocument(stText, fileUri);
    return provideDiagnostics(stText, index, fileUri);
}

try {
    // ---- 1. Namespace extraction from a synthetic .plcproj -------------------------------------
    const direct = extractNamespaces(PLCPROJ);
    assert(direct.length === 4, `extractNamespaces finds 4 namespaces (got ${direct.length})`);
    assert(direct.includes('VisuElems') && direct.includes('Tc2_Standard') && direct.includes('Balluff_BVS_Sensor'),
        'extractNamespaces returns the <PlaceholderReference> namespaces');
    assert(direct.includes('Tc2_EtherCAT'),
        'extractNamespaces returns the <LibraryReference> namespaces too');
    assert(!direct.includes('NotALibrary'),
        '<Namespace> outside a reference element is not harvested');

    // ---- 2. Directory scan --------------------------------------------------------------------
    fs.writeFileSync(path.join(dir, 'Test.plcproj'), PLCPROJ, 'utf8');
    // A library archive folder must be skipped, not scanned.
    fs.mkdirSync(path.join(dir, '_Libraries'));
    fs.writeFileSync(path.join(dir, '_Libraries', 'Vendor.plcproj'),
        '<Project><ItemGroup><PlaceholderReference Include="X"><Namespace>ShouldBeSkipped</Namespace></PlaceholderReference></ItemGroup></Project>', 'utf8');

    clearLibraryNamespaces();
    assert(getLibraryNamespaces().length === 0, 'clearLibraryNamespaces empties the registry');
    assert(isLibraryNamespace('VisuElems') === false, 'nothing matches before indexing');

    indexLibraryNamespaces(dir);
    assert(getLibraryNamespaces().length === 4, `registry holds 4 namespaces after scan (got ${getLibraryNamespaces().length})`);
    assert(!isLibraryNamespace('ShouldBeSkipped'), '_Libraries/ is skipped by the .plcproj scan');

    // ---- 3. Case-insensitive matching (ST is case-insensitive) ---------------------------------
    assert(isLibraryNamespace('VisuElems'), 'exact case matches');
    assert(isLibraryNamespace('visuelems'), 'lower case matches');
    assert(isLibraryNamespace('VISUELEMS'), 'upper case matches');
    assert(isLibraryNamespace('vIsUeLeMs'), 'mixed case matches');
    assert(!isLibraryNamespace('VisuElemsX'), 'a non-namespace does not match');
    assert(!isLibraryNamespace(''), 'empty string does not match');
    assert(!isLibraryNamespace(undefined), 'undefined does not match');

    // ---- 4. A namespace-rooted chain produces zero diagnostics ---------------------------------
    // This also verifies the standing claim that checkMemberAccess never flags members hanging off
    // an unresolvable (library) head: only the head was ever flagged, by the undeclared check.
    clearWorkspaceIndex();
    const libDiags = diagnose('FB_Lib.TcPOU', FB_LIB);
    libDiags.forEach(d => console.log(`       (FB_Lib) L${d.range.start.line + 1}: ${d.message}`));
    assert(libDiags.length === 0,
        `namespace-rooted chains yield zero diagnostics (got ${libDiags.length})`);

    // ---- 5. Over-suppression guard: real undeclared identifiers are STILL flagged --------------
    clearWorkspaceIndex();
    const badDiags = diagnose('FB_Bad.TcPOU', FB_BAD);
    const undeclared = badDiags.filter(d => /is not declared in the current scope/.test(d.message));
    assert(undeclared.length === 1,
        `a genuinely undeclared identifier is still flagged (got ${undeclared.length} undeclared diagnostics)`);
    assert(undeclared.length === 1 && /nSomethingNeverDeclared/.test(undeclared[0].message),
        'the flagged identifier is nSomethingNeverDeclared');

    // Root cause (b) must remain flagged: bare library types/functions are a separate pipeline item
    // and must NOT be silenced by this change.
    clearWorkspaceIndex();
    const bareDiags = diagnose('FB_Bare.TcPOU', tcpou('FB_Bare',
        'FUNCTION_BLOCK FB_Bare\nVAR\n\tbOk : BOOL;\nEND_VAR',
        'bOk := FB_FormatString(sFormat := \'x\');\n'));
    assert(bareDiags.some(d => /FB_FormatString/.test(d.message)),
        'bare library symbols (root cause (b)) are still flagged — no blanket suppression');

    // ---- 6. The real sample's .plcproj (skips cleanly if sample/ is absent) --------------------
    // Gate on the fixture this actually needs — library references in the sample's .plcproj — not on
    // sample/ merely existing. The synthetic sample declares none until the library fixtures land.
    const SAMPLE_DIR = path.join(__dirname, '..', 'sample');
    clearLibraryNamespaces();
    const found = fs.existsSync(SAMPLE_DIR) ? indexLibraryNamespaces(SAMPLE_DIR) : [];
    if (found.length === 0) {
        console.log('[skip] the sample declares no library references — skipping the real-.plcproj assertions.');
    } else {
        assert(found.length === 28, `the real sample .plcproj yields 28 namespaces (got ${found.length})`);
        assert(isLibraryNamespace('VisuElems') && isLibraryNamespace('Tc2_System') && isLibraryNamespace('Recipe_Management'),
            'sample namespaces VisuElems / Tc2_System / Recipe_Management are registered');
    }
} finally {
    clearLibraryNamespaces();
    fs.rmSync(dir, { recursive: true, force: true });
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll library-namespace assertions passed.');
