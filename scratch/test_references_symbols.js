/**
 * @file test_references_symbols.js
 * @description Find References must match the *symbol*, not the word.
 *
 * Two unrelated FBs that each declare a `Cyclic` method share nothing but the spelling, so asking
 * for references of one must never list the other. The guard against over-matching pulls the other
 * way too, and that is the harder half: an override, an interface implementation and a named call
 * argument are all the same symbol written differently, and dropping any of them would trade one
 * bug for a worse one. Both directions are asserted here.
 */

const fs = require('fs');
const path = require('path');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideReferences, provideDefinition } = require('../src/lsp/features');

const TEST_DIR = path.join(__dirname, 'test_refs_project');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const files = {
    // An interface whose NAME is spelled in a different case than the declarations that use it
    // (`ipRun : I_Runner` vs `INTERFACE I_RUNNER`), and whose Cyclic is INHERITED from a base
    // interface. ST is case-insensitive and members are inherited; a resolver that misses either
    // silently answers "unresolved", and Find References then falls back to keeping everything.
    'I_RunnerBase.st': `INTERFACE I_RunnerBase

METHOD Cyclic : BOOL
END_METHOD
`,
    'I_RUNNER.st': `INTERFACE I_RUNNER EXTENDS I_RunnerBase

METHOD Halt : BOOL
END_METHOD
`,
    'FB_Caller.st': `FUNCTION_BLOCK FB_Caller
VAR
    ipRun : I_Runner;
END_VAR

ipRun.Cyclic();
`,
    // Two unrelated FBs, each with a Cyclic() method and a local `i`. The reported bug.
    'FB_Motor.st': `FUNCTION_BLOCK FB_Motor
VAR
    bEnable : BOOL;
END_VAR

METHOD Cyclic : BOOL
VAR
    i : INT;
END_VAR
i := 1;
Cyclic := bEnable;
END_METHOD
`,
    'FB_Valve.st': `FUNCTION_BLOCK FB_Valve
VAR
    bEnable : BOOL;
END_VAR

METHOD Cyclic : BOOL
VAR
    i : INT;
END_VAR
i := 2;
Cyclic := bEnable;
END_METHOD
`,
    // An interface, a base and a derived FB — three declarations of Cyclic that ARE one symbol.
    'I_Runnable.st': `INTERFACE I_Runnable

METHOD Cyclic : BOOL
END_METHOD
`,
    'FB_Base.st': `FUNCTION_BLOCK FB_Base IMPLEMENTS I_Runnable
VAR
    nCount : INT;
END_VAR

METHOD Cyclic : BOOL
nCount := nCount + 1;
END_METHOD
`,
    'FB_Derived.st': `FUNCTION_BLOCK FB_Derived EXTENDS FB_Base

METHOD Cyclic : BOOL
Cyclic := TRUE;
END_METHOD
`,
    'MAIN.st': `PROGRAM MAIN
VAR
    fbMotor : FB_Motor;
    fbValve : FB_Valve;
    fbDerived : FB_Derived;
END_VAR

fbMotor.Cyclic();
fbValve.Cyclic();
fbDerived.Cyclic();
fbMotor(bEnable := TRUE);
`
};

clearWorkspaceIndex();
const uris = {};
for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(TEST_DIR, name);
    fs.writeFileSync(filePath, content, 'utf8');
    uris[name] = 'file:///' + filePath.replace(/\\/g, '/');
    parseAndIndexDocument(content, uris[name]);
}
const index = getWorkspaceSymbolIndex();

/** Cursor position at `snippet` + `offset` characters into it. */
function posOf(text, snippet, offset = 0) {
    const idx = text.indexOf(snippet);
    if (idx === -1) throw new Error(`snippet not found: ${snippet}`);
    const abs = idx + offset;
    const before = text.slice(0, abs);
    return { line: before.split('\n').length - 1, character: abs - (before.lastIndexOf('\n') + 1) };
}

const inFile = (refs, name) => refs.filter(r => r.uri.endsWith('/' + name)).length;

// ----------------------------------------------------------------------------------------------
// The bug: Cyclic() on two unrelated FBs
// ----------------------------------------------------------------------------------------------
console.log('\n--- Same method name, unrelated FBs ---');
const main = files['MAIN.st'];
const motorCyclic = provideReferences(main, posOf(main, 'fbMotor.Cyclic', 'fbMotor.'.length), index, uris['MAIN.st']);

assert(inFile(motorCyclic, 'FB_Valve.st') === 0,
    `FB_Motor.Cyclic must not list FB_Valve's Cyclic (got ${inFile(motorCyclic, 'FB_Valve.st')})`);
assert(inFile(motorCyclic, 'FB_Motor.st') >= 1,
    `FB_Motor.Cyclic finds its own declaration (got ${inFile(motorCyclic, 'FB_Motor.st')})`);
assert(inFile(motorCyclic, 'MAIN.st') === 1,
    `FB_Motor.Cyclic finds the fbMotor call site only, not fbValve's (got ${inFile(motorCyclic, 'MAIN.st')})`);
assert(inFile(motorCyclic, 'FB_Derived.st') === 0,
    `FB_Motor.Cyclic must not list the unrelated FB_Derived.Cyclic (got ${inFile(motorCyclic, 'FB_Derived.st')})`);

// Same word, method-local variables: `i` in FB_Motor.Cyclic is not `i` in FB_Valve.Cyclic.
const motor = files['FB_Motor.st'];
const localI = provideReferences(motor, posOf(motor, 'i := 1'), index, uris['FB_Motor.st']);
assert(inFile(localI, 'FB_Valve.st') === 0,
    `a method-local i does not reach the other FB's i (got ${inFile(localI, 'FB_Valve.st')})`);
assert(inFile(localI, 'FB_Motor.st') === 2,
    `a method-local i finds its declaration and its use (got ${inFile(localI, 'FB_Motor.st')})`);

// ----------------------------------------------------------------------------------------------
// The other direction: what must still be found
// ----------------------------------------------------------------------------------------------
console.log('\n--- Overrides, interfaces, named arguments ---');
const base = files['FB_Base.st'];
const baseCyclic = provideReferences(base, posOf(base, 'METHOD Cyclic', 'METHOD '.length), index, uris['FB_Base.st']);

assert(inFile(baseCyclic, 'FB_Derived.st') >= 1,
    `FB_Base.Cyclic lists FB_Derived's override (got ${inFile(baseCyclic, 'FB_Derived.st')})`);
assert(inFile(baseCyclic, 'I_Runnable.st') >= 1,
    `FB_Base.Cyclic lists the I_Runnable method it implements (got ${inFile(baseCyclic, 'I_Runnable.st')})`);
assert(inFile(baseCyclic, 'MAIN.st') === 1,
    `FB_Base.Cyclic lists the fbDerived call site (got ${inFile(baseCyclic, 'MAIN.st')})`);
assert(inFile(baseCyclic, 'FB_Motor.st') === 0,
    `FB_Base.Cyclic still excludes the unrelated FB_Motor.Cyclic (got ${inFile(baseCyclic, 'FB_Motor.st')})`);

// A named call argument is a reference to the parameter's declaration: `fbMotor(bEnable := TRUE)`
// must be found from FB_Motor's `bEnable`, and FB_Valve's identically-named input must not be.
const enableRefs = provideReferences(motor, posOf(motor, 'bEnable : BOOL'), index, uris['FB_Motor.st']);
assert(inFile(enableRefs, 'MAIN.st') === 1,
    `FB_Motor.bEnable finds the named argument in MAIN (got ${inFile(enableRefs, 'MAIN.st')})`);
assert(inFile(enableRefs, 'FB_Valve.st') === 0,
    `FB_Motor.bEnable must not list FB_Valve's bEnable (got ${inFile(enableRefs, 'FB_Valve.st')})`);
assert(inFile(enableRefs, 'FB_Motor.st') === 2,
    `FB_Motor.bEnable finds its declaration and its use (got ${inFile(enableRefs, 'FB_Motor.st')})`);

// A type name is a single global symbol: every mention of FB_Motor is the same one.
const typeRefs = provideReferences(main, posOf(main, 'fbMotor : FB_Motor', 'fbMotor : '.length), index, uris['MAIN.st']);
assert(inFile(typeRefs, 'FB_Motor.st') >= 1 && inFile(typeRefs, 'MAIN.st') >= 1,
    `the type name FB_Motor is found in both its own file and MAIN`);

// ----------------------------------------------------------------------------------------------
// The resolver underneath: a member reached through a case-differing, inheriting interface
// ----------------------------------------------------------------------------------------------
console.log('\n--- Case-insensitive types, inherited interface members ---');
const caller = files['FB_Caller.st'];
const ipRunCyclic = posOf(caller, 'ipRun.Cyclic', 'ipRun.'.length);

// `ipRun : I_Runner` must reach `INTERFACE I_RUNNER`, and Cyclic must be found on the I_RunnerBase
// it EXTENDS. Both hops were broken: an exact-key index lookup, and no chain walk on dotted paths.
const def = provideDefinition(caller, ipRunCyclic, index, uris['FB_Caller.st']);
assert(def !== null, 'ipRun.Cyclic resolves at all (case-insensitive type name)');
assert(def && def.uri.endsWith('/I_RunnerBase.st'),
    `ipRun.Cyclic resolves to the base interface that declares it (got ${def && def.uri.split('/').pop()})`);
assert(def && def.componentId === 'method_Cyclic',
    `...and to the method component (got ${def && def.componentId})`);

// Which is what lets Find References tell it apart from the two unrelated Cyclic methods.
const ifaceRefs = provideReferences(caller, ipRunCyclic, index, uris['FB_Caller.st']);
assert(inFile(ifaceRefs, 'FB_Motor.st') === 0 && inFile(ifaceRefs, 'FB_Valve.st') === 0,
    `an interface's Cyclic does not drag in the unrelated FBs' Cyclic`);
assert(inFile(ifaceRefs, 'I_RunnerBase.st') >= 1,
    `an interface's Cyclic finds its declaration (got ${inFile(ifaceRefs, 'I_RunnerBase.st')})`);

for (const name of Object.keys(files)) {
    try { fs.unlinkSync(path.join(TEST_DIR, name)); } catch (e) { /* best effort */ }
}
try { fs.rmdirSync(TEST_DIR); } catch (e) { /* best effort */ }

console.log(`\n--- REFERENCE SYMBOL TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
