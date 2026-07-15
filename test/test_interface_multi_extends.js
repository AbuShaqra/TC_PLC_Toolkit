/**
 * @file test_interface_multi_extends.js
 * @description Guards multiple interface inheritance (`INTERFACE I_C EXTENDS I_A, I_B`), a valid ST/OOP
 * construct (per the CODESYS / Stefan Henneken IEC 61131-3 material on interface segregation). The
 * parser used to capture only the FIRST parent, so a member inherited from the SECOND parent resolved
 * to nothing: completion missed it, go-to-definition failed, and — because a project interface is not
 * "uncertain" — member-access diagnostics flagged it as "not a member" (a false positive). This checks
 * the parser captures every parent and the resolver walks the whole inheritance graph.
 */

const {
    parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex,
} = require('../src/lsp/parser');
const {
    typeFromNode, lookupMember, resolvePath, findMethodOwnerInChain,
    isRelatedAssignable, parentNames,
} = require('../src/lsp/types');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// Three interfaces: I_C extends BOTH I_A and I_B. An FB uses members inherited from each side.
const CODE = `
INTERFACE I_A
METHOD MethodA : BOOL
END_METHOD
PROPERTY PropA : INT
END_PROPERTY
END_INTERFACE

INTERFACE I_B
METHOD MethodB : INT
END_METHOD
PROPERTY PropB : INT
END_PROPERTY
END_INTERFACE

INTERFACE I_C EXTENDS I_A, I_B
METHOD MethodC : BOOL
END_METHOD
END_INTERFACE

FUNCTION_BLOCK FB_Consumer
VAR
    ifc : I_C;
    nX : INT;
END_VAR
ifc.MethodA();
ifc.MethodB();
ifc.MethodC();
nX := ifc.PropA;
nX := ifc.PropB;
END_FUNCTION_BLOCK
`;

const uri = 'file:///synthetic/multi_extends.st';
clearWorkspaceIndex();
const index = getWorkspaceSymbolIndex();
parseAndIndexDocument(CODE, uri);

console.log('\n--- Parser captures every EXTENDS parent ---');
const iC = index['I_C'];
assert(!!iC, 'I_C is indexed');
assert(iC && Array.isArray(iC.extendsAll) && iC.extendsAll.join(',') === 'I_A,I_B',
    `I_C.extendsAll === [I_A, I_B] (got ${iC && JSON.stringify(iC.extendsAll)})`);
assert(iC && iC.extends === 'I_A', "the single-parent `extends` field stays the first parent (I_A)");
assert(parentNames(iC).join(',') === 'I_A,I_B', 'parentNames(I_C) lists both parents');

console.log('\n--- Resolver walks the whole graph ---');
const tC = typeFromNode(iC);
const mA = lookupMember(tC, 'MethodA', index);
const mB = lookupMember(tC, 'MethodB', index);
const mC = lookupMember(tC, 'MethodC', index);
assert(mA && mA.kind !== 'unknown', 'MethodA (first parent) resolves as a member of I_C');
assert(mB && mB.kind !== 'unknown', 'MethodB (SECOND parent) resolves as a member of I_C — the fix');
assert(mC && mC.kind !== 'unknown', "MethodC (I_C's own) resolves as a member of I_C");

const ownB = findMethodOwnerInChain(iC, 'MethodB', index);
assert(ownB && ownB.owner && ownB.owner.name === 'I_B',
    'findMethodOwnerInChain routes MethodB to its declaring interface I_B (for go-to-definition)');
const ownMissing = findMethodOwnerInChain(iC, 'NoSuchMethod', index);
assert(ownMissing === null,
    'a genuinely absent method returns null (definitely absent), not undefined — the graph is fully resolved');

console.log('\n--- Assignability across the interface graph ---');
assert(isRelatedAssignable(typeFromNode(index['I_A']), tC, index),
    'I_C is assignable to I_A (an extended parent)');
assert(isRelatedAssignable(typeFromNode(index['I_B']), tC, index),
    'I_C is assignable to I_B (the second extended parent)');

console.log('\n--- Member-access resolution: no false positive, real errors still caught ---');
// resolvePath is exactly what the member-access diagnostic calls: failedAt === -1 means resolved (or
// undeterminable), failedAt === i (>=1) means the i-th segment is DEFINITELY absent → a diagnostic.
// `ifc.PropB` reads a PROPERTY inherited from the SECOND parent — the exact case the fix repairs.
const scope = { pou: index['FB_Consumer'], method: null };

const rPropB = resolvePath(['ifc', 'PropB'], scope, index);
assert(rPropB.failedAt === -1 && rPropB.type && rPropB.type.kind !== 'unknown',
    'ifc.PropB (second parent) RESOLVES — no false "not a member", and to a concrete type');

const rPropA = resolvePath(['ifc', 'PropA'], scope, index);
assert(rPropA.failedAt === -1 && rPropA.type && rPropA.type.kind !== 'unknown',
    'ifc.PropA (first parent) resolves too');

// A genuinely absent member MUST still be reported absent — proves the graph resolves fully rather
// than going silent (which would hide real errors).
const rMissing = resolvePath(['ifc', 'NoSuchProp'], scope, index);
assert(rMissing.failedAt === 1,
    `ifc.NoSuchProp is reported DEFINITELY absent (failedAt=1, got ${rMissing.failedAt})`);

console.log(`\n--- INTERFACE MULTI-EXTENDS TESTS COMPLETE with ${errors} error(s) ---`);
if (errors > 0) process.exit(1);
