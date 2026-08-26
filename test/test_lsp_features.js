/**
 * @file test_lsp_features.js
 * @description Automated test script for testing LSP feature provider implementations: completions, definitions, references, diagnostics.
 */

const fs = require('fs');
const path = require('path');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideCompletions, provideDefinition, provideReferences, provideDiagnostics } = require('../src/lsp/features');

const TEST_DIR = path.join(__dirname, 'test_project');
if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
}

// 1. Define files and contents
const files = {
    'GVL_Global.st': `GVL GVL_Global
VAR_GLOBAL
    g_bRunning : BOOL;
    g_nCounter : INT;
END_VAR
`,
    'FB_Power.st': `FUNCTION_BLOCK FB_Power
VAR_INPUT
    bEnable : BOOL;
END_VAR
VAR_OUTPUT
    bActive : BOOL;
END_VAR
`,
    'FB_Automatic.st': `FUNCTION_BLOCK FB_Automatic
VAR
    bStart : BOOL;
    nState : INT := 0;
    fbMyPower : FB_Power;
END_VAR

IF bStart THEN
    nState := 10;
    g_bRunning := TRUE;
    fbMyPower.bEnable := TRUE;
    fbMyPower(bEnable := TRUE, bActive => bStart);
END_IF

METHOD M_Reset : BOOL
VAR_INPUT
    bForce : BOOL;
END_VAR
VAR
    eQRScanState : (NONE, RESET_ERROR_0, INIT, READY) := INIT;
END_VAR
nState := 0;
eQRScanState := READY;
END_METHOD
`
};

// Write files to disk and index them
clearWorkspaceIndex();
console.log("Writing temporary test files to disk:");
for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(TEST_DIR, name);
    fs.writeFileSync(filePath, content, 'utf8');
    const fileUri = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\//, '');
    console.log(`  Writing & Indexing: ${name} -> ${fileUri}`);
    parseAndIndexDocument(content, fileUri);
}

const index = getWorkspaceSymbolIndex();
console.log("Workspace symbols indexed:", Object.keys(index));

let errors = 0;
function assert(condition, message) {
    if (condition) {
        console.log(`[PASS] ${message}`);
    } else {
        console.error(`[FAIL] ${message}`);
        errors++;
    }
}

// ----------------------------------------------------
// TEST 1: diagnostics
// ----------------------------------------------------
console.log("\n--- TEST 1: Diagnostics ---");
const automaticPath = path.join(TEST_DIR, 'FB_Automatic.st');
const automaticUri = 'file:///' + automaticPath.replace(/\\/g, '/').replace(/^\//, '');
const automaticContent = files['FB_Automatic.st'];

// Test diagnostics on valid content
const diagsValid = provideDiagnostics(automaticContent, index, automaticUri);
assert(diagsValid.length === 0, `Valid file should have 0 diagnostics errors. Found: ${JSON.stringify(diagsValid)}`);

// Test diagnostics on unmatched block (IF without END_IF)
const invalidIfContent = `FUNCTION_BLOCK FB_Automatic
VAR
    bStart : BOOL;
END_VAR
IF bStart THEN
    bStart := FALSE;
`;
const diagsInvalidIf = provideDiagnostics(invalidIfContent, index, automaticUri);
assert(diagsInvalidIf.length > 0, "Should detect unmatched IF block");
assert(diagsInvalidIf.some(d => d.message.includes('Unterminated block')), "Diagnostic should report 'Unterminated block'");

// Test diagnostics on undeclared variable
const undeclaredContent = `FUNCTION_BLOCK FB_Automatic
VAR
    bStart : BOOL;
END_VAR
bStart := bStartVarX;
`;
const diagsUndeclared = provideDiagnostics(undeclaredContent, index, automaticUri);
assert(diagsUndeclared.length > 0, "Should detect undeclared variable 'bStartVarX'");
assert(diagsUndeclared.some(d => d.message.includes('bStartVarX') && d.message.includes('not declared')), "Diagnostic should report 'bStartVarX' not declared");


// ----------------------------------------------------
// TEST 2: Completions
// ----------------------------------------------------
console.log("\n--- TEST 2: Auto-Completions ---");

// Test dot completions: typing "fbMyPower." in the IF block inside FB_Automatic
// Line 10 index is: "    fbMyPower.bEnable := TRUE;"
// Position of dot is line: 10, char: 14 ("    fbMyPower.")
const completionsDot = provideCompletions(automaticContent, { line: 10, character: 14 }, index, automaticUri);
const labelsDot = completionsDot.map(c => c.label);
console.log("Completions for 'fbMyPower.':", labelsDot);
assert(labelsDot.includes('bEnable') && labelsDot.includes('bActive'), "Dot completions on fbMyPower should return bEnable and bActive");

// Test standard completions
const completionsStd = provideCompletions(automaticContent, { line: 12, character: 0 }, index, automaticUri);
const labelsStd = completionsStd.map(c => c.label);
assert(labelsStd.includes('bStart') && labelsStd.includes('nState'), "Standard completions should suggest local variables");
assert(labelsStd.includes('g_bRunning'), "Standard completions should suggest global variables");
assert(labelsStd.includes('FB_Power'), "Standard completions should suggest types like FB_Power");
assert(labelsStd.includes('IF') && labelsStd.includes('VAR_INPUT'), "Standard completions should suggest keywords");


// ----------------------------------------------------
// TEST 3: Definition
// ----------------------------------------------------
console.log("\n--- TEST 3: Go to Definition ---");

// Definition of 'fbMyPower' on line 10 (char 5)
const defMyPower = provideDefinition(automaticContent, { line: 10, character: 5 }, index, automaticUri);
console.log("Definition result for 'fbMyPower':", defMyPower);
assert(defMyPower !== null, "Should find definition for 'fbMyPower'");
assert(defMyPower && defMyPower.uri === automaticUri, "Definition should point to active file URI");

// Definition of 'bEnable' in 'fbMyPower.bEnable' on line 10 (char 15)
const defEnable = provideDefinition(automaticContent, { line: 10, character: 15 }, index, automaticUri);
console.log("Definition result for 'bEnable':", defEnable);
const powerUri = 'file:///' + path.join(TEST_DIR, 'FB_Power.st').replace(/\\/g, '/').replace(/^\//, '');
assert(defEnable !== null, "Should find definition for member 'bEnable'");
assert(defEnable && defEnable.uri === powerUri, "Definition should point to FB_Power.st");

// Definition of 'g_bRunning' on line 9 (char 5)
const defGlobal = provideDefinition(automaticContent, { line: 9, character: 5 }, index, automaticUri);
console.log("Definition result for 'g_bRunning':", defGlobal);
const globalUri = 'file:///' + path.join(TEST_DIR, 'GVL_Global.st').replace(/\\/g, '/').replace(/^\//, '');
assert(defGlobal !== null, "Should find definition for global 'g_bRunning'");
assert(defGlobal && defGlobal.uri === globalUri, "Definition should point to GVL_Global.st");
assert(defGlobal && defGlobal.componentId === 'root', "Definition of GVL variable should have componentId 'root'");
assert(defGlobal && defGlobal.targetWord === 'g_bRunning', "Definition of GVL variable should match targetWord");

// Definition of 'bEnable' in 'fbMyPower(bEnable := TRUE, ...)' on line 11 (char 14)
const defCallEnable = provideDefinition(automaticContent, { line: 11, character: 14 }, index, automaticUri);
console.log("Definition result for 'fbMyPower(bEnable...':", defCallEnable);
assert(defCallEnable !== null, "Should find definition for call parameter 'bEnable'");
assert(defCallEnable && defCallEnable.uri === powerUri, "Call parameter definition should point to FB_Power.st");
assert(defCallEnable && defCallEnable.componentId === 'root', "Call parameter definition should have componentId 'root'");
assert(defCallEnable && defCallEnable.targetWord === 'bEnable', "Call parameter definition targetWord should be 'bEnable'");

// Definition of 'bActive' in 'fbMyPower(..., bActive => ...)' on line 11 (char 31)
const defCallActive = provideDefinition(automaticContent, { line: 11, character: 31 }, index, automaticUri);
console.log("Definition result for 'fbMyPower(...bActive...':", defCallActive);
assert(defCallActive !== null, "Should find definition for call parameter 'bActive'");
assert(defCallActive && defCallActive.uri === powerUri, "Call parameter definition should point to FB_Power.st");
assert(defCallActive && defCallActive.componentId === 'root', "Call parameter definition should have componentId 'root'");
assert(defCallActive && defCallActive.targetWord === 'bActive', "Call parameter definition targetWord should be 'bActive'");


// ----------------------------------------------------
// TEST 4: Find References
// ----------------------------------------------------
console.log("\n--- TEST 4: Find References ---");

// Find references of 'bEnable' inside FB_Automatic
const refs = provideReferences(automaticContent, { line: 10, character: 15 }, index, automaticUri);
console.log("References found for 'bEnable':", refs.length);
assert(refs.length >= 2, "Should find at least 2 references of bEnable (declaration and assignment)");
assert(refs.some(r => r.uri.endsWith('FB_Power.st')), "Should find reference in FB_Power.st");
assert(refs.some(r => r.uri.endsWith('FB_Automatic.st')), "Should find reference in FB_Automatic.st");


// Clean up files
console.log("\nCleaning up temporary files...");
for (const name of Object.keys(files)) {
    try {
        fs.unlinkSync(path.join(TEST_DIR, name));
    } catch { /* best-effort cleanup: a file the run never created is fine to miss */ }
}
try {
    fs.rmdirSync(TEST_DIR);
} catch { /* best-effort cleanup: leaving a temp dir behind must not fail the suite */ }

console.log(`\n--- LSP FEATURES TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
