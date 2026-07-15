/**
 * @file test_lsp_parser.js
 * @description Automated test script for testing Lexer, AST Parser, and Symbol Indexer in src/lsp/parser.js.
 */

const { tokenize, TokenType, parseAndIndexDocument, getWorkspaceSymbolIndex, clearWorkspaceIndex } = require('../src/lsp/parser');

const testCode = `
FUNCTION_BLOCK FB_Automatic EXTENDS FB_Base IMPLEMENTS I_Auto
VAR
    bStart : BOOL;
    nState : INT := 0;
END_VAR

IF bStart THEN
    nState := 10;
END_IF

METHOD M_Reset : BOOL
VAR_INPUT
    bForce : BOOL;
END_VAR
nState := 0;
END_METHOD

PROPERTY P_Enabled : BOOL
GET
P_Enabled := TRUE;
END_GET
END_PROPERTY
`;

console.log("--- STARTING LSP PARSER TESTS ---");

// Test 1: Lexer Tokenization
console.log("\n--- TEST 1: Tokenization ---");
const tokens = tokenize(testCode);
console.log(`Tokenized code. Total tokens: ${tokens.length}`);

const keywords = tokens.filter(t => t.type === TokenType.Keyword);
console.log(`Keywords found: ${keywords.map(t => t.value).slice(0, 10).join(', ')}...`);

if (keywords.some(t => t.value.toUpperCase() === 'FUNCTION_BLOCK') && 
    keywords.some(t => t.value.toUpperCase() === 'IF') &&
    keywords.some(t => t.value.toUpperCase() === 'END_METHOD')) {
    console.log("[PASS] Keywords correctly identified.");
} else {
    console.error("[FAIL] Missing identified keywords!");
}

// Test 2: AST Symbol Parsing
console.log("\n--- TEST 2: AST Parsing and Symbol Indexing ---");
clearWorkspaceIndex();
const fileUri = 'file:///c:/mock_project/FB_Automatic.st';
parseAndIndexDocument(testCode, fileUri);

const index = getWorkspaceSymbolIndex();
console.log("Workspace symbol keys:", Object.keys(index));

const pou = index['FB_Automatic'];
if (pou) {
    console.log("[PASS] FB_Automatic successfully registered in Symbol Index.");
    console.log(`  Type: ${pou.type}`);
    console.log(`  Extends: ${pou.extends}`);
    console.log(`  Implements: ${pou.implements.join(', ')}`);
    console.log(`  Variables parsed: ${pou.variables.length}`);
    console.log(`  Methods parsed: ${pou.methods.length}`);
    console.log(`  Properties parsed: ${pou.properties.length}`);

    // Assert Extends/Implements
    if (pou.extends === 'FB_Base' && pou.implements.includes('I_Auto')) {
        console.log("[PASS] Extends/Implements parsed correctly.");
    } else {
        console.error("[FAIL] Extends/Implements mismatch!");
    }

    // Assert Variables
    const bStartVar = pou.variables.find(v => v.name === 'bStart');
    if (bStartVar && bStartVar.type === 'BOOL' && bStartVar.scope === 'VAR') {
        console.log("[PASS] Variable bStart parsed correctly with type and range.");
        console.log(`  Range: startLine=${bStartVar.range.startLine}, startCol=${bStartVar.range.startCol}`);
    } else {
        console.error("[FAIL] Variable bStart parsing failed!");
    }

    // Assert Nested Method
    const mReset = pou.methods.find(m => m.name === 'M_Reset');
    if (mReset && mReset.returnType === 'BOOL' && mReset.variables.length === 1) {
        console.log("[PASS] Method M_Reset and returnType parsed correctly.");
        const forceVar = mReset.variables[0];
        if (forceVar.name === 'bForce' && forceVar.type === 'BOOL' && forceVar.scope === 'VAR_INPUT') {
            console.log("[PASS] Method input variable bForce parsed correctly.");
        } else {
            console.error("[FAIL] Method variable parsing failed!");
        }
    } else {
        console.error("[FAIL] Method M_Reset parsing failed!");
    }

    // Assert Property
    const pEnabled = pou.properties.find(p => p.name === 'P_Enabled');
    if (pEnabled && pEnabled.getAccessor) {
        console.log("[PASS] Property P_Enabled and its GET accessor parsed correctly.");
        console.log(`  GET Accessor range: startLine=${pEnabled.getAccessor.implRange.startLine}, endLine=${pEnabled.getAccessor.implRange.endLine}`);
    } else {
        console.error("[FAIL] Property P_Enabled parsing failed!");
    }

} else {
    console.error("[FAIL] FB_Automatic not found in symbol table index!");
}

console.log("\n--- LSP PARSER TESTS COMPLETE ---");
