/**
 * Test case for method-only diagnostics in the XML viewer context.
 */
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideDiagnostics } = require('../src/lsp/features');

clearWorkspaceIndex();

const fileUri = 'file:///c:/mock_project/FB_Automatic.TcPOU';

// 1. Initially, the POU is indexed
console.log("Indexing main POU...");
const mainPouCode = `FUNCTION_BLOCK FB_Automatic
VAR
    nState : INT := 0;
END_VAR
`;
parseAndIndexDocument(mainPouCode, fileUri);

// 2. Now simulate the user editing the method M_Reset in the webview
console.log("\nParsing and checking diagnostics for M_Reset method code block...");
// indent bForce further to avoid line/col collision with nState
const methodCode = `METHOD M_Reset : BOOL
VAR_INPUT
        bForce : BOOL;
END_VAR
nState := 0; // nState is declared in parent POU, bForce is local
bForce := FALSE;
`;

// Parse the method code block
parseAndIndexDocument(methodCode, fileUri);

const index = getWorkspaceSymbolIndex();
console.log("Symbol Index keys:", Object.keys(index));
if (index['FB_Automatic']) {
    console.log("FB_Automatic methods:", index['FB_Automatic'].methods.map(m => ({
        name: m.name,
        variables: m.variables.map(v => v.name),
        declRange: m.declRange
    })));
}

const diags = provideDiagnostics(methodCode, index, fileUri);
console.log("\nDiagnostics returned for method:", diags);
if (diags.length > 0) {
    console.error("FAIL: Diagnostics errors found in valid method code!");
    process.exit(1);
} else {
    console.log("PASS: No diagnostics errors in valid method code.");
    process.exit(0);
}
