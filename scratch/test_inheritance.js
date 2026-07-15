/**
 * @file test_inheritance.js
 * @description Regression harness for inherited-member resolution across EXTENDS chains.
 *
 * Covers bare (no fb. prefix) usage of members inherited from a base FB:
 *  (a) bare inherited variable — no diagnostic, definition resolves to the base file;
 *  (b) two-level EXTENDS chain;
 *  (c) inherited method / property used bare;
 *  (d) base FB absent from index — conservative case: NO undeclared-identifier diagnostics
 *      at all (and no flag on the EXTENDS type name);
 *  (e) genuinely-undeclared identifier in a derived FB WITH a fully-resolved base is still flagged;
 *  (f) a cycle (A extends B, B extends A) does not hang.
 */

const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideCompletions, provideDefinition, provideDiagnostics } = require('../src/lsp/features');

let errors = 0;
function assert(condition, message) {
    if (condition) {
        console.log(`[PASS] ${message}`);
    } else {
        console.error(`[FAIL] ${message}`);
        errors++;
    }
}

// Finds the (line, character) of a needle inside code, 0-indexed.
function locate(code, needle, occurrence = 0) {
    const lines = code.split('\n');
    let seen = 0;
    for (let i = 0; i < lines.length; i++) {
        let from = 0;
        let idx;
        while ((idx = lines[i].indexOf(needle, from)) !== -1) {
            if (seen === occurrence) return { line: i, character: idx };
            seen++;
            from = idx + 1;
        }
    }
    throw new Error(`needle not found: ${needle}`);
}

// ----------------------------------------------------------------------------
// (a) bare inherited variable — no diagnostic, definition resolves to base file
// (c) inherited method / property used bare
// ----------------------------------------------------------------------------
console.log('\n--- (a)/(c): single-level inheritance, bare variable/method/property ---');
clearWorkspaceIndex();

const baseUri = 'file:///c:/fake/FB_Base.TcPOU';
const baseCode = `FUNCTION_BLOCK FB_Base
VAR
	bBaseFlag : BOOL;
	nBaseCount : INT;
END_VAR

METHOD M_BaseReset : BOOL
END_METHOD

PROPERTY BaseProp : INT
END_PROPERTY
`;

const derivedUri = 'file:///c:/fake/FB_Derived.TcPOU';
const derivedCode = `FUNCTION_BLOCK FB_Derived EXTENDS FB_Base
VAR
	bLocal : BOOL;
END_VAR

bBaseFlag := TRUE;
nBaseCount := nBaseCount + 1;
bLocal := bBaseFlag;
M_BaseReset();
nBaseCount := BaseProp;
`;

parseAndIndexDocument(baseCode, baseUri);
parseAndIndexDocument(derivedCode, derivedUri);
let index = getWorkspaceSymbolIndex();

const diagsA = provideDiagnostics(derivedCode, index, derivedUri);
assert(diagsA.length === 0, `No diagnostics on FB_Derived with resolved base. Found: ${JSON.stringify(diagsA.map(d => d.message))}`);

const posVar = locate(derivedCode, 'bBaseFlag', 0);
const defVar = provideDefinition(derivedCode, { line: posVar.line, character: posVar.character + 2 }, index, derivedUri);
assert(defVar && defVar.uri.toLowerCase() === baseUri.toLowerCase(), `Bare inherited variable resolves to base file. Got: ${defVar && defVar.uri}`);
assert(defVar && defVar.componentId === 'root', `Inherited variable definition has componentId 'root'. Got: ${defVar && defVar.componentId}`);

const posMethod = locate(derivedCode, 'M_BaseReset', 0);
const defMethod = provideDefinition(derivedCode, { line: posMethod.line, character: posMethod.character + 2 }, index, derivedUri);
assert(defMethod && defMethod.uri.toLowerCase() === baseUri.toLowerCase(), `Bare inherited method resolves to base file. Got: ${defMethod && defMethod.uri}`);
assert(defMethod && defMethod.componentId === 'method_M_BaseReset', `Inherited method definition has method componentId. Got: ${defMethod && defMethod.componentId}`);

const posProp = locate(derivedCode, 'BaseProp', 0);
const defProp = provideDefinition(derivedCode, { line: posProp.line, character: posProp.character + 2 }, index, derivedUri);
assert(defProp && defProp.uri.toLowerCase() === baseUri.toLowerCase(), `Bare inherited property resolves to base file. Got: ${defProp && defProp.uri}`);
assert(defProp && defProp.componentId === 'prop_BaseProp', `Inherited property definition has prop componentId. Got: ${defProp && defProp.componentId}`);

// Completions should surface inherited members labelled as inherited.
const compPos = locate(derivedCode, 'bLocal := bBaseFlag;', 0);
const comps = provideCompletions(derivedCode, { line: compPos.line, character: 0 }, index, derivedUri);
const compByLabel = Object.fromEntries(comps.map(c => [c.label, c]));
assert(compByLabel['bBaseFlag'] && /Inherited Variable/.test(compByLabel['bBaseFlag'].detail), 'Completions include inherited variable, labelled inherited');
assert(compByLabel['M_BaseReset'] && /Inherited Method/.test(compByLabel['M_BaseReset'].detail), 'Completions include inherited method, labelled inherited');
assert(compByLabel['BaseProp'] && /Inherited Property/.test(compByLabel['BaseProp'].detail), 'Completions include inherited property, labelled inherited');

// ----------------------------------------------------------------------------
// (b) two-level EXTENDS chain
// ----------------------------------------------------------------------------
console.log('\n--- (b): two-level EXTENDS chain ---');
clearWorkspaceIndex();

const grandUri = 'file:///c:/fake/FB_Grand.TcPOU';
const grandCode = `FUNCTION_BLOCK FB_Grand
VAR
	nGrandValue : INT;
END_VAR
`;
const midUri = 'file:///c:/fake/FB_Mid.TcPOU';
const midCode = `FUNCTION_BLOCK FB_Mid EXTENDS FB_Grand
VAR
	nMidValue : INT;
END_VAR
`;
const leafUri = 'file:///c:/fake/FB_Leaf.TcPOU';
const leafCode = `FUNCTION_BLOCK FB_Leaf EXTENDS FB_Mid
VAR
	nLeafValue : INT;
END_VAR

nLeafValue := nMidValue + nGrandValue;
`;

parseAndIndexDocument(grandCode, grandUri);
parseAndIndexDocument(midCode, midUri);
parseAndIndexDocument(leafCode, leafUri);
index = getWorkspaceSymbolIndex();

const diagsB = provideDiagnostics(leafCode, index, leafUri);
assert(diagsB.length === 0, `No diagnostics across a two-level chain. Found: ${JSON.stringify(diagsB.map(d => d.message))}`);

const posGrand = locate(leafCode, 'nGrandValue', 0);
const defGrand = provideDefinition(leafCode, { line: posGrand.line, character: posGrand.character + 2 }, index, leafUri);
assert(defGrand && defGrand.uri.toLowerCase() === grandUri.toLowerCase(), `Two-level inherited variable resolves to grandparent file. Got: ${defGrand && defGrand.uri}`);

// ----------------------------------------------------------------------------
// (d) base absent from index — conservative: NO undeclared diagnostics, no EXTENDS-name flag
// ----------------------------------------------------------------------------
console.log('\n--- (d): unresolved (external) base — conservative suppression ---');
clearWorkspaceIndex();

const extUri = 'file:///c:/fake/FB_Ext.TcPOU';
const extCode = `FUNCTION_BLOCK FB_Ext EXTENDS FB_LibraryBase
VAR
	bLocal : BOOL;
END_VAR

bSomeInheritedThing := TRUE;
bLocal := FALSE;
totallyRandomName := 5;
`;
parseAndIndexDocument(extCode, extUri);
index = getWorkspaceSymbolIndex();

const diagsD = provideDiagnostics(extCode, index, extUri);
const undeclaredD = diagsD.filter(d => /not declared/.test(d.message));
assert(undeclaredD.length === 0, `No undeclared-identifier diagnostics when base is external. Found: ${JSON.stringify(undeclaredD.map(d => d.message))}`);
assert(!diagsD.some(d => /FB_LibraryBase/.test(d.message)), 'EXTENDS type name is not flagged when base is external');

// ----------------------------------------------------------------------------
// (e) genuinely-undeclared identifier WITH a fully-resolved base is still flagged
// ----------------------------------------------------------------------------
console.log('\n--- (e): fully-resolved base still flags genuine undeclared identifiers ---');
clearWorkspaceIndex();

const base2Uri = 'file:///c:/fake/FB_Base2.TcPOU';
const base2Code = `FUNCTION_BLOCK FB_Base2
VAR
	bBaseFlag : BOOL;
END_VAR
`;
const derived2Uri = 'file:///c:/fake/FB_Derived2.TcPOU';
const derived2Code = `FUNCTION_BLOCK FB_Derived2 EXTENDS FB_Base2
VAR
	bLocal : BOOL;
END_VAR

bBaseFlag := TRUE;
bLocal := xUndeclaredGarbage;
`;
parseAndIndexDocument(base2Code, base2Uri);
parseAndIndexDocument(derived2Code, derived2Uri);
index = getWorkspaceSymbolIndex();

const diagsE = provideDiagnostics(derived2Code, index, derived2Uri);
assert(diagsE.some(d => /xUndeclaredGarbage/.test(d.message) && /not declared/.test(d.message)),
    'Genuine undeclared identifier is still flagged when base is fully resolved');
assert(!diagsE.some(d => /bBaseFlag/.test(d.message)), 'Inherited member is NOT flagged in the same POU');

// ----------------------------------------------------------------------------
// (f) cycle A extends B, B extends A does not hang
// ----------------------------------------------------------------------------
console.log('\n--- (f): cyclic EXTENDS does not hang ---');
clearWorkspaceIndex();

const cycAUri = 'file:///c:/fake/FB_CycA.TcPOU';
const cycACode = `FUNCTION_BLOCK FB_CycA EXTENDS FB_CycB
VAR
	nA : INT;
END_VAR

nA := 1;
`;
const cycBUri = 'file:///c:/fake/FB_CycB.TcPOU';
const cycBCode = `FUNCTION_BLOCK FB_CycB EXTENDS FB_CycA
VAR
	nB : INT;
END_VAR
`;
parseAndIndexDocument(cycACode, cycAUri);
parseAndIndexDocument(cycBCode, cycBUri);
index = getWorkspaceSymbolIndex();

const started = Date.now();
const diagsF = provideDiagnostics(cycACode, index, cycAUri);
const defCyc = provideDefinition(cycACode, locate(cycACode, 'nA := 1', 0), index, cycAUri);
const compCyc = provideCompletions(cycACode, { line: 5, character: 0 }, index, cycAUri);
const elapsed = Date.now() - started;
assert(elapsed < 2000, `Cyclic EXTENDS resolves quickly (no hang). Took ${elapsed}ms`);
assert(Array.isArray(diagsF) && defCyc !== undefined && Array.isArray(compCyc), 'Cyclic EXTENDS returns normally from all providers');

console.log(`\n--- INHERITANCE TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
