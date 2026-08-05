/**
 * @file test_library_methods.js
 * @description Library function-block METHODS, harvested from the project's `.tmc`.
 *
 * This project spent a long time concluding these were unobtainable — not in the archives, not in
 * the signatures dump, not through the Automation Interface. They were in the `.tmc` all along, in
 * `<Method>` blocks that parseTmcDataType simply never read. What is asserted here:
 *
 *   1. the signature really is complete — parameter names, types, directions, and the return type;
 *   2. `<ExtendsType>` is followed, so a method declared on a library FB's *base* is still found;
 *   3. and the whole thing stays out of the diagnostics. The method list is complete per type, but
 *      the `.tmc` exports only the types the project uses and carries no ACTIONs at all — so a
 *      member it does not know must stay "uncertain", never "absent". Relaxing that guard once cost
 *      79 false positives on correct code.
 */

const fs = require('fs');
const path = require('path');
const { parseTmcDataType } = require('../src/lsp/libsymbols');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideCompletions, provideDiagnostics } = require('../src/lsp/features');
const { lookupMember, parseTypeString } = require('../src/lsp/types');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ----------------------------------------------------------------------------------------------
// 1. The parser, against the real `.tmc` shape
// ----------------------------------------------------------------------------------------------
console.log('--- parsing <Method> out of a <DataType> ---');

// A real FB block, trimmed: an input SubItem, an inherited base, and two methods — one with an
// output parameter (marked by ItemType, exactly as TwinCAT writes it) and one with none.
const FB_BLOCK = `<DataType>
<Name Namespace="Tc2_MC2">FB_Mover</Name>
<ExtendsType>FB_MoverBase</ExtendsType>
<SubItem><Name>bEnable</Name><Type>BOOL</Type><BitSize>8</BitSize>
  <Properties><Property><Name>ItemType</Name><Value>Input</Value></Property></Properties></SubItem>
<Method><Name>Halt</Name><ReturnType>BOOL</ReturnType><ReturnBitSize>8</ReturnBitSize>
  <Parameter><Name>fDeceleration</Name><Type>LREAL</Type><BitSize>64</BitSize></Parameter>
  <Parameter><Name>eBufferMode</Name><Type Namespace="Tc2_MC2">MC_BufferMode</Type><BitSize>16</BitSize></Parameter>
  <Parameter><Name>bDone</Name><Type>BOOL</Type><BitSize>8</BitSize>
    <Properties><Property><Name>ItemType</Name><Value>Output</Value></Property></Properties></Parameter>
</Method>
<Method><Name>Reset</Name></Method>
</DataType>`;

const fb = parseTmcDataType(FB_BLOCK);
assert(fb && fb.name === 'FB_Mover', `type name parsed (got ${fb && fb.name})`);
assert(fb.kind === 'fb', `a type with call parameters is an fb (got ${fb.kind})`);
assert(fb.extendsType === 'FB_MoverBase', `<ExtendsType> captured (got ${fb.extendsType})`);
assert(fb.methods.length === 2, `both methods parsed (got ${fb.methods.length})`);

const halt = fb.methods.find(m => m.name === 'Halt');
assert(halt && halt.returnType === 'BOOL', `method return type (got ${halt && halt.returnType})`);
assert(halt && halt.params.length === 3, `all parameters parsed (got ${halt && halt.params.length})`);
assert(halt && halt.params[0].name === 'fDeceleration' && halt.params[0].type === 'LREAL',
    `parameter name and type`);
assert(halt && halt.params[0].scope === 'VAR_INPUT',
    `an unmarked parameter is an INPUT (got ${halt && halt.params[0].scope})`);
assert(halt && halt.params[2].scope === 'VAR_OUTPUT',
    `an ItemType=Output parameter is an OUTPUT (got ${halt && halt.params[2].scope})`);

const reset = fb.methods.find(m => m.name === 'Reset');
assert(reset && reset.returnType === '' && reset.params.length === 0,
    `a method with no return and no parameters parses cleanly`);

// An INTERFACE: methods, no fields. It must still land on a concrete kind, or its members are
// unreachable (an 'opaque' node resolves to the anonymous unknown and offers nothing).
const ITF_BLOCK = `<DataType>
<Name Namespace="Tc3_JsonXml">I_List</Name>
<Method><Name>Add</Name><ReturnType>BOOL</ReturnType>
  <Parameter><Name>item</Name><Type>DWORD</Type></Parameter>
</Method>
</DataType>`;
const itf = parseTmcDataType(ITF_BLOCK);
assert(itf.kind === 'fb', `an interface (methods, no fields) gets a concrete kind (got ${itf.kind})`);
assert(itf.methods.length === 1, `its method is parsed`);

// A plain struct must be unaffected: no methods, still 'struct'.
const STRUCT_BLOCK = `<DataType><Name>ST_Point</Name>
<SubItem><Name>x</Name><Type>LREAL</Type><BitSize>64</BitSize></SubItem>
<SubItem><Name>y</Name><Type>LREAL</Type><BitSize>64</BitSize></SubItem>
</DataType>`;
const st = parseTmcDataType(STRUCT_BLOCK);
assert(st.kind === 'struct' && st.methods.length === 0 && st.extendsType === '',
    `a plain struct is untouched (kind=${st.kind}, methods=${st.methods.length})`);

// ----------------------------------------------------------------------------------------------
// 2. End to end: completion offers them, diagnostics still cannot flag them
// ----------------------------------------------------------------------------------------------
console.log('\n--- through the symbol index ---');

// Stand in for what libsymbols registers, so this harness needs no sample/ and no archives.
function libraryNode(info) {
    return {
        name: info.name, type: 'LIBRARY', external: true, membersComplete: false,
        libKind: info.kind, libNamespace: info.namespace,
        uri: '', range: null, nameRange: null,
        extends: info.extendsType || null,
        implements: [],
        variables: info.members,
        methods: info.methods.map(m => ({ name: m.name, returnType: m.returnType, variables: m.params })),
        properties: [], actions: []
    };
}

const BASE_BLOCK = `<DataType><Name>FB_MoverBase</Name>
<Method><Name>Stop</Name><ReturnType>BOOL</ReturnType></Method>
</DataType>`;

clearWorkspaceIndex();
const index = getWorkspaceSymbolIndex();
index['FB_Mover'] = libraryNode(fb);
index['FB_MoverBase'] = libraryNode(parseTmcDataType(BASE_BLOCK));

const code = `FUNCTION_BLOCK FB_User
VAR
    mover : FB_Mover;
END_VAR
mover.
`;
const uri = 'file:///x/FB_User.st';
parseAndIndexDocument(code, uri);

const items = provideCompletions(code, { line: 4, character: 6 }, getWorkspaceSymbolIndex(), uri);
const labels = items.map(i => i.label);
assert(labels.includes('Halt'), `mover.<caret> offers the library FB's own method (got ${labels.join(', ')})`);
assert(labels.includes('Stop'), `...and the one it INHERITS from FB_MoverBase`);
assert(labels.includes('bEnable'), `...and still offers its inputs`);
assert(items.find(i => i.label === 'Halt').detail.includes('BOOL'),
    `the method's return type reaches the completion detail`);

// The guard. A member the `.tmc` does not know must remain *uncertain* — the type list is partial
// (only types the project uses) and `.tmc` carries no ACTIONs, so "not found" cannot mean "absent".
const moverType = parseTypeString('FB_Mover', getWorkspaceSymbolIndex());
assert(lookupMember(moverType, 'Halt', getWorkspaceSymbolIndex()) !== undefined,
    `a known method resolves`);
assert(lookupMember(moverType, 'ReadStatus', getWorkspaceSymbolIndex()) === undefined,
    `an unknown member is UNCERTAIN (undefined), never absent (null) — this is what keeps ACTIONs safe`);

const diags = provideDiagnostics(`FUNCTION_BLOCK FB_User
VAR
    mover : FB_Mover;
END_VAR
mover.Halt(fDeceleration := 1.0);
mover.ReadStatus();
mover.NoSuchThingAtAll();
`, getWorkspaceSymbolIndex(), uri);
assert(diags.length === 0,
    `no diagnostic on a library FB's methods, known or not (got ${diags.length}: ${diags.map(d => d.message).join(' | ')})`);

// ----------------------------------------------------------------------------------------------
// 4. Chained member access on a library type — `fbAxisRef.NcToPlc.▮`
// ----------------------------------------------------------------------------------------------
// Completion used to stop after ONE hop. A library type is registered into the workspace index only
// when the document text NAMES it, and code that writes `fbAxisRef.NcToPlc.ActPos` never spells the
// type of NcToPlc — so the second dot resolved to nothing. Registering transitively is not the fix:
// putting all ~32k library symbols in took the diagnostics pass from 1.5 s to 78 s, because
// Object.keys() on the index runs per identifier. So the chain is RESOLVED lazily instead, reading
// each member's declared type straight from the `.tmc`, and the index never grows — which is the
// assertion at the end of this section.
//
// Measured against a real 32k-symbol project before and after: `fbAxisRef.NcToPlc.▮` 0 -> 42 items,
// `fbAxisRef.Status.▮` 0 -> 52, index size unchanged at 7.
console.log('\n--- chained member access on library types ---');
{
    const os = require('os');
    const { indexTypeSystem, clearLibrarySymbols, getLibraryTypeNode } = require('../src/lsp/libsymbols');

    // A synthetic `.tmc`: the committed sample has only four namespaced types and no two-hop chain
    // at all, so the fixture has to supply one. Shape copied from the real file.
    const tmc = `<?xml version="1.0" encoding="utf-8"?>
<TcModuleClass><DataTypes>
<DataType><Name Namespace="Lib_Chain">ST_Outer</Name>
  <SubItem><Name>Inner</Name><Type Namespace="Lib_Chain">ST_Inner</Type><BitSize>64</BitSize></SubItem>
  <SubItem><Name>nFlat</Name><Type>INT</Type><BitSize>16</BitSize></SubItem>
</DataType>
<DataType><Name Namespace="Lib_Chain">ST_Inner</Name>
  <SubItem><Name>Deep</Name><Type Namespace="Lib_Chain">ST_Deep</Type><BitSize>32</BitSize></SubItem>
  <SubItem><Name>fValue</Name><Type>LREAL</Type><BitSize>64</BitSize></SubItem>
</DataType>
<DataType><Name Namespace="Lib_Chain">ST_Deep</Name>
  <SubItem><Name>nLeaf</Name><Type>INT</Type><BitSize>16</BitSize></SubItem>
</DataType>
<DataType><Name Namespace="Lib_Chain">ST_Arrayed</Name>
  <SubItem><Name>Items</Name><Type Namespace="Lib_Chain">ARRAY [0..3] OF ST_Deep</Type><BitSize>64</BitSize></SubItem>
</DataType>
</DataTypes></TcModuleClass>`;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-chain-'));
    fs.writeFileSync(path.join(dir, 'Chain.tmc'), tmc, 'utf8');
    clearLibrarySymbols();
    const stats = indexTypeSystem(dir);
    assert(stats.types >= 4, `the fixture .tmc indexes its types (got ${stats.types})`);

    const lines = [
        'FUNCTION_BLOCK FB_Chain',
        'VAR',
        '\tstOuter : ST_Outer;',
        '\tstArr : ST_Arrayed;',
        'END_VAR',
        'stOuter.',
        'stOuter.Inner.',
        'stOuter.Inner.Deep.',
        'stOuter.Inner.fValue.',
        'stOuter.NoSuchMember.',
        'stArr.Items.',
        'END_FUNCTION_BLOCK',
        ''
    ];
    const code = lines.join('\n');
    clearWorkspaceIndex();
    parseAndIndexDocument(code, '/chain.st');
    const index = getWorkspaceSymbolIndex();

    // The head type is in the index because the document names it — exactly what
    // registerLibrarySymbolNodes would have done for a symbol the archives know.
    index['ST_Outer'] = getLibraryTypeNode('ST_Outer');
    index['ST_Arrayed'] = getLibraryTypeNode('ST_Arrayed');
    assert(!!index['ST_Outer'] && index['ST_Outer'].external === true,
        'getLibraryTypeNode builds an external node straight from the .tmc');

    const sizeBefore = Object.keys(index).length;
    const labelsAt = n => (provideCompletions(code, { line: n, character: lines[n].length }, index, '/chain.st') || [])
        .map(i => i.label);

    const hop1 = labelsAt(lines.indexOf('stOuter.'));
    assert(hop1.includes('Inner') && hop1.includes('nFlat'), `hop 1 still lists the type's own members (got ${JSON.stringify(hop1)})`);

    const hop2 = labelsAt(lines.indexOf('stOuter.Inner.'));
    assert(hop2.includes('Deep') && hop2.includes('fValue'),
        `hop 2 follows the member's declared type into the .tmc (got ${JSON.stringify(hop2)})`);

    const hop3 = labelsAt(lines.indexOf('stOuter.Inner.Deep.'));
    assert(hop3.includes('nLeaf'), `hop 3 keeps going — the walk is not capped at two (got ${JSON.stringify(hop3)})`);

    // Honesty at the edges: a scalar has no members, and an invented one resolves to nothing rather
    // than to the enclosing type's list.
    assert(labelsAt(lines.indexOf('stOuter.Inner.fValue.')).length === 0,
        'a scalar member ends the chain — no members are invented for LREAL');
    assert(labelsAt(lines.indexOf('stOuter.NoSuchMember.')).length === 0,
        'an unknown member ends the chain rather than falling back to its parent');

    // An ARRAY OF <struct> is still that struct: `stArr.Items.▮` is how TwinCAT code reads one.
    const arrayed = labelsAt(lines.indexOf('stArr.Items.'));
    assert(arrayed.includes('nLeaf'), `ARRAY [..] OF a struct resolves to the element type (got ${JSON.stringify(arrayed)})`);

    // THE point: none of that put anything in the index. This is what separates resolving the chain
    // from registering it, and registering it is the 78 s cliff.
    assert(Object.keys(index).length === sizeBefore,
        `walking the chain registers nothing (index ${sizeBefore} -> ${Object.keys(index).length})`);

    // And it stays out of diagnostics: a library member is "uncertain", never "absent".
    const diags = provideDiagnostics(code, index, '/chain.st');
    assert(diags.length === 0,
        `chained library access yields no diagnostics (got ${diags.length}: ${diags.map(d => d.message).join(' | ')})`);

    fs.rmSync(dir, { recursive: true, force: true });
    clearLibrarySymbols();
}

console.log(`\n--- LIBRARY METHOD TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
