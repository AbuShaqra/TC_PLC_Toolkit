/**
 * @file test_references_scope.js
 * @description Find References must respect SCOPE, and the index it consults must be in the same
 * coordinate space as the text it searches.
 *
 * The bug this guards (reported by the user: "references of bDone inside FB_Axis.Initialize lists every
 * bDone in the project"): the workspace index holds two kinds of node. The ACTIVE document is parsed
 * from its ST unit, so its method ranges are ST-unit line numbers. Every OTHER document comes from
 * xmlIndexer, whose ranges are *per component* — correct for jumping to a definition, meaningless as
 * ST-unit lines. So `findActiveScope` found no enclosing method for any line in any other file, every
 * method variable there failed to resolve, and `sameSymbol` keeps whatever it cannot resolve. Measured
 * on the sample: 1,885 of 1,893 wrongly-kept occurrences came from exactly this, and HALF of all
 * reported references were bogus (2,974 -> 1,455 on a 251-target sweep).
 *
 * The other half of the rule, which the user also had to correct: a method's `VAR_INPUT` /
 * `VAR_OUTPUT` / `VAR_IN_OUT` are its PARAMETERS. They are named from outside at call sites
 * (`fbAxis.MoveAbsolute(fVelocity := 5)`), so they must NOT be confined to the method body — only a
 * plain `VAR` is private. Confining them would hide real references, which is worse than listing
 * doubtful ones.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideReferences, clearStFileCache } = require('../src/lsp/features');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const DIR = path.join(os.tmpdir(), 'tc_ref_scope');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const uriOf = (n) => 'file:///' + path.join(DIR, n).replace(/\\/g, '/');

const files = {
    // bDone is PRIVATE to Initialize. fVelocity is a PARAMETER of MoveAbsolute, so MAIN can name it.
    'FB_Axis.st': `FUNCTION_BLOCK FB_Axis
VAR
    nId : INT;
END_VAR

METHOD Initialize : BOOL
VAR
    bDone : BOOL;
END_VAR
bDone := FALSE;
Initialize := bDone;
END_METHOD

METHOD MoveAbsolute : BOOL
VAR_INPUT
    fVelocity : LREAL;
END_VAR
MoveAbsolute := fVelocity > 0;
END_METHOD

METHOD Cyclic : BOOL
VAR
    bDone : BOOL;
END_VAR
bDone := TRUE;
END_METHOD
`,
    // An unrelated FB with its own bDone, and a call naming the PARAMETER fVelocity.
    'FB_Gripper.st': `FUNCTION_BLOCK FB_Gripper
VAR
    fbAxis : FB_Axis;
    bDone : BOOL;
END_VAR
bDone := TRUE;
fbAxis.MoveAbsolute(fVelocity := 25.0);
`
};
for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(DIR, n), t, 'utf8');

clearWorkspaceIndex();
clearStFileCache();
for (const n of Object.keys(files)) parseAndIndexDocument(files[n], uriOf(n));
const index = getWorkspaceSymbolIndex();

const refsFor = (file, needle, occurrence = 0) => {
    const lines = files[file].split('\n');
    let seen = -1, li = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(needle) && ++seen === occurrence) { li = i; break; }
    }
    const ch = lines[li].indexOf(needle.trim().split(/\s/)[0]) + 1;
    return provideReferences(files[file], { line: li, character: ch }, index, uriOf(file));
};
const inFile = (refs, name) => refs.filter(r => String(r.uri).includes(name)).length;

// ---- a method's private VAR is confined to that method
const bDone = refsFor('FB_Axis.st', 'bDone : BOOL;', 0);          // Initialize's bDone
assert(bDone.length === 3, `Initialize's private bDone finds only its own 3 occurrences (got ${bDone.length})`);
assert(inFile(bDone, 'FB_Gripper') === 0, `...and none of FB_Gripper's unrelated bDone (got ${inFile(bDone, 'FB_Gripper')})`);
assert(bDone.every(r => r.range.start.line >= 6 && r.range.start.line <= 11),
    'all of them lie inside Initialize — the search never leaves the method');

// The other method's same-named private bDone must be a DIFFERENT symbol.
const cyclicDone = refsFor('FB_Axis.st', 'bDone : BOOL;', 1);     // Cyclic's bDone
assert(cyclicDone.length === 2, `Cyclic's own bDone is a separate symbol (got ${cyclicDone.length} occurrences)`);
assert(cyclicDone.every(r => r.range.start.line >= 20),
    'Cyclic\'s bDone does not reach back into Initialize');

// ---- a method PARAMETER is NOT confined: call sites name it, in other files
const fVel = refsFor('FB_Axis.st', 'fVelocity : LREAL;', 0);
assert(inFile(fVel, 'FB_Gripper') === 1,
    `a VAR_INPUT parameter is still found at the call site that names it (fbAxis.MoveAbsolute(fVelocity := …)) — got ${inFile(fVel, 'FB_Gripper')}`);
assert(fVel.length === 3, `...along with its declaration and its use inside the method (got ${fVel.length})`);

fs.rmSync(DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------
// A parameter belongs to ITS METHOD, and a named argument belongs to the CALLEE.
//
// This is the shape the user actually hit. Real FBs declare the same `bDone` VAR_OUTPUT in method
// after method (FB_Axis: Halt, Stop, Reset, SoEReset, …), and their bodies call each other with named
// outputs — `Reset(bDone => bStepDone)`. Both were reported as references to whichever `bDone` had
// been asked about: the first because the identity of a parameter did not include its method, the
// second because a named argument names the CALLEE's parameter and definitionAt declines on library
// callees, so the occurrence came back unresolved and the fallback kept it. 36 references across 6
// files for a symbol that has 4.
// ---------------------------------------------------------------------------------------------
const DIR2 = path.join(os.tmpdir(), 'tc_ref_scope2');
fs.rmSync(DIR2, { recursive: true, force: true });
fs.mkdirSync(DIR2, { recursive: true });
const uriOf2 = (n) => 'file:///' + path.join(DIR2, n).replace(/\\/g, '/');

const files2 = {
    'FB_Drive.st': `FUNCTION_BLOCK FB_Drive
VAR
    bStepDone : BOOL;
END_VAR

METHOD Halt : BOOL
VAR_OUTPUT
    bDone : BOOL;
END_VAR
Reset(bDone => bStepDone);
bDone := bStepDone;
END_METHOD

METHOD Reset : BOOL
VAR_OUTPUT
    bDone : BOOL;
END_VAR
bDone := TRUE;
END_METHOD
`,
    'MAIN.st': `PROGRAM MAIN
VAR
    fbDrive : FB_Drive;
    bOk : BOOL;
END_VAR
fbDrive.Halt(bDone => bOk);
fbDrive.Reset(bDone => bOk);
`
};
for (const [n, t] of Object.entries(files2)) fs.writeFileSync(path.join(DIR2, n), t, 'utf8');

clearWorkspaceIndex();
clearStFileCache();
for (const n of Object.keys(files2)) parseAndIndexDocument(files2[n], uriOf2(n));
const index2 = getWorkspaceSymbolIndex();

const lines2 = files2['FB_Drive.st'].split('\n');
const haltDecl = lines2.findIndex((l, i) => l.includes('bDone : BOOL;') && i > 5);   // Halt's VAR_OUTPUT
const haltRefs = provideReferences(files2['FB_Drive.st'],
    { line: haltDecl, character: lines2[haltDecl].indexOf('bDone') + 1 }, index2, uriOf2('FB_Drive.st'));

const at = (refs, file, line) => refs.some(r => String(r.uri).includes(file) && r.range.start.line === line);
const resetDecl = lines2.findIndex((l, i) => l.includes('bDone : BOOL;') && i > haltDecl);
const resetCall = lines2.findIndex(l => l.includes('Reset(bDone => bStepDone)'));

assert(!at(haltRefs, 'FB_Drive', resetDecl),
    `Halt's bDone does NOT include Reset's own bDone VAR_OUTPUT — a parameter belongs to its method`);
assert(!at(haltRefs, 'FB_Drive', resetCall),
    `Halt's bDone does NOT include the named argument in Reset(bDone => …) — that names RESET's parameter`);
assert(at(haltRefs, 'MAIN', 5),
    `Halt's bDone DOES include fbDrive.Halt(bDone => bOk) — a call to its own method names it`);
assert(!at(haltRefs, 'MAIN', 6),
    `...but not fbDrive.Reset(bDone => bOk), which names Reset's parameter`);
assert(haltRefs.length === 3,
    `Halt's bDone has exactly 3 references: its declaration, its use, and the call site (got ${haltRefs.length})`);

fs.rmSync(DIR2, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------
// A DECLARATION-SITE FB_init argument is a reference to that FB_init's VAR_INPUT.
//
// `inst : FB_Type(p := v)` passes v to FB_Type's FB_init parameter p — so an occurrence of `p` there
// is a reference to FB_init's VAR_INPUT `p`. It used to be dropped: the named-argument filter compared
// the callee written in the source (`FB_Type`, the type) against the target's method name (`FB_init`)
// and, never matching, skipped it. classifyCallSite tags this site 'declInitList'; references now uses
// that tag to match by the FB TYPE (owner, or a subtype since FB_init may be inherited) instead.
// Reported by the user: "references of FB_init input vars written as part of the FB declaration are
// never listed."
// ---------------------------------------------------------------------------------------------
const DIR3 = path.join(os.tmpdir(), 'tc_ref_scope3');
fs.rmSync(DIR3, { recursive: true, force: true });
fs.mkdirSync(DIR3, { recursive: true });
const uriOf3 = (n) => 'file:///' + path.join(DIR3, n).replace(/\\/g, '/');

const files3 = {
    'FB_Motor.st': `FUNCTION_BLOCK FB_Motor
VAR
    nSpeed : INT;
END_VAR
nSpeed := nSpeed;

METHOD FB_init : BOOL
VAR_INPUT
    nMaxSpeed : INT;
END_VAR
nSpeed := nMaxSpeed;
END_METHOD
`,
    // Constructs FB_Motor at its declaration site (declInitList) AND a different FB whose FB_init has a
    // same-named param, to prove the type — not just the name — is what gates the match.
    'FB_Other.st': `FUNCTION_BLOCK FB_Other
VAR
END_VAR

METHOD FB_init : BOOL
VAR_INPUT
    nMaxSpeed : INT;
END_VAR
END_METHOD
`,
    'MAIN.st': `PROGRAM MAIN
VAR
    fbMotor : FB_Motor(nMaxSpeed := 3000);
    fbOther : FB_Other(nMaxSpeed := 10);
END_VAR
fbMotor();
`
};
for (const [n, t] of Object.entries(files3)) fs.writeFileSync(path.join(DIR3, n), t, 'utf8');

clearWorkspaceIndex();
clearStFileCache();
for (const n of Object.keys(files3)) parseAndIndexDocument(files3[n], uriOf3(n));
const index3 = getWorkspaceSymbolIndex();

const motorLines = files3['FB_Motor.st'].split('\n');
const nMaxDecl = motorLines.findIndex(l => l.includes('nMaxSpeed : INT;'));
const motorRefs = provideReferences(files3['FB_Motor.st'],
    { line: nMaxDecl, character: motorLines[nMaxDecl].indexOf('nMaxSpeed') + 1 }, index3, uriOf3('FB_Motor.st'));

const at3 = (refs, file, line) => refs.some(r => String(r.uri).includes(file) && r.range.start.line === line);
assert(at3(motorRefs, 'MAIN', 2),
    `FB_Motor.FB_init's nMaxSpeed DOES include the declaration-site arg fbMotor : FB_Motor(nMaxSpeed := …)`);
assert(!at3(motorRefs, 'MAIN', 3),
    `...but NOT fbOther : FB_Other(nMaxSpeed := …) — a same-named FB_init param on a different FB is a different symbol`);
assert(motorRefs.length === 3,
    `FB_Motor.FB_init's nMaxSpeed has exactly 3 references: its declaration, its use, and the FB_Motor decl-site arg (got ${motorRefs.length})`);

fs.rmSync(DIR3, { recursive: true, force: true });
console.log(`\n--- REFERENCE SCOPE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
