/**
 * @file test_lsp_types_sync.js
 * @description Defensive regression test: completions and go-to-definition must still resolve
 * correctly through a symbol-index node that carries only a stubbed range (no real declaration
 * position), not just through nodes `xmlIndexer.js` parses with real ranges from source. No
 * current indexer builds stub-ranged nodes any more — the mechanism that used to (a workspace
 * crawl feeding `server.js`'s `custom/updateTypesMap` handler) was removed as unscoped and
 * redundant (see `docs/superpowers/plans/2026-08-06-project-scoped-index.md`, Task 5) — so this
 * harness constructs stub nodes directly and asserts the resolution path still tolerates them.
 */

const { clearWorkspaceIndex, parseAndIndexDocument, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideCompletions, provideDefinition } = require('../src/lsp/features');

console.log("--- STARTING LSP XML TYPES SYNCHRONIZATION TESTS ---");

// Hand-built symbol data, standing in for what an XML-derived index entry looks like — deliberately
// NOT run through xmlIndexer.js, so every range below stays a stub rather than a real declaration
// position.
const mockStubTypeData = {
    'FB_Power': {
        uri: 'file:///c:/mock_project/FB_Power.TcPOU',
        type: 'FUNCTION_BLOCK',
        variables: [
            { name: 'bEnable', type: 'BOOL' },
            { name: 'bActive', type: 'BOOL' }
        ],
        properties: ['P_State'],
        methods: ['M_Reset'],
        actions: []
    },
    'GVL_Global': {
        uri: 'file:///c:/mock_project/GVL_Global.TcGVL',
        type: 'GVL',
        variables: [
            { name: 'g_bRunning', type: 'BOOL' },
            { name: 'g_nCounter', type: 'INT' }
        ],
        properties: [],
        methods: [],
        actions: []
    }
};

// 1. Register the mock data directly into the symbol index, each entry stub-ranged exactly as the
// now-removed custom/updateTypesMap handler used to build them — the shape this test still guards.
function registerStubRangedSymbols(typeData) {
    const index = getWorkspaceSymbolIndex();
    for (const [name, typeInfo] of Object.entries(typeData)) {
        index[name] = {
            name: name,
            type: typeInfo.type,
            uri: typeInfo.uri || '',
            range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
            extends: null,
            implements: [],
            variables: (typeInfo.variables || []).map(v => ({
                name: v.name,
                type: v.type,
                scope: 'VAR',
                range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 }
            })),
            methods: (typeInfo.methods || []).map(mName => ({
                name: mName,
                variables: [],
                returnType: 'BOOL',
                declRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                implRange: null
            })),
            properties: (typeInfo.properties || []).map(pName => ({
                name: pName,
                type: 'BOOL',
                declRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                getAccessor: null,
                setAccessor: null
            })),
            actions: (typeInfo.actions || []).map(aName => ({
                name: aName,
                nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                implRange: null
            }))
        };
    }
}

clearWorkspaceIndex();
registerStubRangedSymbols(mockStubTypeData);

const index = getWorkspaceSymbolIndex();
console.log("Stub-ranged symbols registered:", Object.keys(index));

// 2. Parse a mock ST document containing an instance of the XML FB
const testCode = `FUNCTION_BLOCK FB_Automatic
VAR
    bStart : BOOL;
    fbPowerInst : FB_Power;
END_VAR

IF bStart THEN
    fbPowerInst.bEnable := TRUE;
    g_bRunning := TRUE;
END_IF
`;

const fileUri = 'file:///c:/mock_project/FB_Automatic.st';
parseAndIndexDocument(testCode, fileUri);

let errors = 0;
function assert(condition, message) {
    if (condition) {
        console.log(`[PASS] ${message}`);
    } else {
        console.error(`[FAIL] ${message}`);
        errors++;
    }
}

// 3. Test dot completion of fbPowerInst
const completionsDot = provideCompletions(testCode, { line: 7, character: 16 }, index, fileUri); // position after "fbPowerInst."
const labelsDot = completionsDot.map(c => c.label);
console.log("Completions for fbPowerInst.:", labelsDot);
assert(labelsDot.includes('bEnable') && labelsDot.includes('bActive'), "Completions should suggest member variables bEnable and bActive from XML definition");
assert(labelsDot.includes('P_State'), "Completions should suggest XML property P_State");
assert(labelsDot.includes('M_Reset'), "Completions should suggest XML method M_Reset");

// 4. Test Go to Definition of fbPowerInst.bEnable
const defMember = provideDefinition(testCode, { line: 7, character: 18 }, index, fileUri); // position on "bEnable"
console.log("Definition of bEnable:", defMember);
assert(defMember !== null && defMember.uri === 'file:///c:/mock_project/FB_Power.TcPOU', "Definition of bEnable should point to the original XML file of FB_Power");

// 5. Test Go to Definition of g_bRunning
const defGlobal = provideDefinition(testCode, { line: 8, character: 5 }, index, fileUri); // position on "g_bRunning"
console.log("Definition of g_bRunning:", defGlobal);
assert(defGlobal !== null && defGlobal.uri === 'file:///c:/mock_project/GVL_Global.TcGVL', "Definition of g_bRunning should point to GVL_Global.TcGVL");

console.log(`\n--- LSP XML TYPES SYNCHRONIZATION TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
