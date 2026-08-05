/**
 * @file test_parser_constructs.js
 * @description Lexer/parser coverage for the ST constructs the sample project actually uses.
 * Self-contained: every assertion runs on inline sources, so it needs no sample/ project.
 *
 * Guards four fixes and an audit:
 *   1. UNION is indexed exactly like STRUCT (XML path and ST path), so its members are
 *      declarations, not usages, and member access on a union type resolves.
 *   2. `REF=` lexes as ONE operator token (it used to lex as identifier `REF` + operator `=`,
 *      i.e. `x REF = y`; the bug was masked only because `REF` is a whitelisted builtin).
 *   3. ExST `S=` / `R=` lex as single operators — while ordinary comparisons (`nPos = 5`)
 *      must keep lexing as a plain `=`.
 *   4. An alias / subrange DUT is classified as such (`node.dutKind`) and resolves to the
 *      anonymous `unknown` type — never to a member-less struct, which used to make both a
 *      numeric use and any member access on it a false positive.
 *   5. The remaining constructs used by the sample (ARRAY/REFERENCE TO/POINTER TO, THIS^/SUPER^,
 *      AT %I*, VAR_INST/VAR_TEMP/VAR CONSTANT/PERSISTENT, pragmas, AND_THEN/OR_ELSE, alias and
 *      subrange DUTs, ...) still tokenize and parse as expected.
 *   6. A declaration-site pragma is metadata, not part of the type: `{attribute 'x'} INT` used to
 *      BE the declared type, a string resolving to nothing. The initializer, by contrast, must
 *      stay in the type string — decl-site init lists are load-bearing.
 *   7. An inline (anonymous) enum `e : (idle, running)` resolves as an enum carrying its own
 *      values, not as a named unknown: it has no DUT node, so a CASE on it could not find its
 *      labels and fell back to the entire value list.
 *
 * (6) and (7) are both checked with the opt-in `declarationTypes` diagnostic ON, which is where
 * both defects would have surfaced as false "Unknown type" reports.
 */

const {
    tokenize, TokenType, parseAndIndexDocument, parseVariablesBlock,
    getWorkspaceSymbolIndex, clearWorkspaceIndex
} = require('../src/lsp/parser');
const { indexXmlObject, buildNodeFromXml, dutKindFromDecl } = require('../src/lsp/xmlIndexer');
const { typeFromNode, parseTypeString, lookupMember } = require('../src/lsp/types');
const { provideDiagnostics, provideCompletions, setDiagnosticsConfig } = require('../src/lsp/features');
const { isBuiltin } = require('../src/lsp/builtins');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Meaningful (non-whitespace/comment/pragma) tokens of a snippet. */
function lex(code) {
    return tokenize(code).filter(t => t.type !== TokenType.Whitespace && t.type !== TokenType.Comment);
}

/** Compact "type(value)" rendering of a token list, for failure messages. */
function render(tokens) {
    return tokens.map(t => `${t.type}(${t.value})`).join(' ');
}

/** Wraps a declaration in the minimal TwinCAT XML envelope for the given object kind. */
function xmlObject(kind, name, declaration) {
    return `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <${kind} Name="${name}" Id="{00000000-0000-0000-0000-000000000000}">
    <Declaration><![CDATA[${declaration}]]></Declaration>
  </${kind}>
</TcPlcObject>`;
}

// ---------------------------------------------------------------------------
// 1. UNION — XML path (src/lsp/xmlIndexer.js)
// ---------------------------------------------------------------------------
console.log('\n--- UNION: XML path ---');

const UNION_DECL = `TYPE U_CANState :
UNION
\tnCANState\tAT %I*\t: UINT;
\tstCANState\t\t\t: ST_CANStates;
END_UNION
END_TYPE
`;
const STRUCT_DECL = `TYPE ST_CANStates :
STRUCT
\tbError\t: BOOL;
\tnCode\t: UINT;
END_STRUCT
END_TYPE
`;

const unionUri = 'file:///c:/fake/U_CANState.TcDUT';
const structUri = 'file:///c:/fake/ST_CANStates.TcDUT';

clearWorkspaceIndex();
const index = getWorkspaceSymbolIndex();
indexXmlObject(index, xmlObject('DUT', 'U_CANState', UNION_DECL), unionUri);
indexXmlObject(index, xmlObject('DUT', 'ST_CANStates', STRUCT_DECL), structUri);

const unionNode = index['U_CANState'];
assert(!!unionNode, 'U_CANState is indexed');
const unionMembers = (unionNode ? unionNode.variables : []).map(v => v.name);
assert(unionMembers.length === 2 && unionMembers.includes('nCANState') && unionMembers.includes('stCANState'),
    `UNION members are indexed as declarations: [${unionMembers.join(', ')}]`);

const nCanVar = (unionNode ? unionNode.variables : []).find(v => v.name === 'nCANState');
assert(nCanVar && nCanVar.type === 'UINT',
    `union member type survives the "AT %I*" direct address: ${nCanVar && nCanVar.type}`);
assert(nCanVar && nCanVar.range.startLine === 3,
    `union member range points at its own declaration line (3), got ${nCanVar && nCanVar.range.startLine}`);

// A union must behave like a struct for member lookup (never like an enum).
const unionType = typeFromNode(unionNode);
assert(unionType.kind === 'struct', `a UNION node resolves as kind 'struct', got '${unionType.kind}'`);
assert(!!lookupMember(unionType, 'nCANState', index), 'lookupMember resolves nCANState on U_CANState');
assert(!!lookupMember(unionType, 'stCANState', index), 'lookupMember resolves stCANState on U_CANState');
assert(lookupMember(unionType, 'nNotThere', index) === null,
    'lookupMember still rejects a member the union does not declare');

// The nested struct member must stay reachable through the union (uCAN.stCANState.bError).
const nestedType = lookupMember(unionType, 'stCANState', index);
assert(nestedType && parseTypeString(nestedType.name, index).kind === 'struct',
    'the union member typed as a struct DUT resolves to that struct');

// `AT%I*` written without a space (as in the real U_CANState.TcDUT) must parse identically.
const tightNode = buildNodeFromXml(
    xmlObject('DUT', 'U_Tight', 'TYPE U_Tight :\nUNION\n\tnState\tAT%I*\t: UINT;\nEND_UNION\nEND_TYPE\n'),
    'file:///c:/fake/U_Tight.TcDUT');
assert(tightNode && tightNode.variables.length === 1 && tightNode.variables[0].name === 'nState',
    'AT%I* (no space) does not break the member declaration');

// Regression guard: an enum DUT must NOT be dragged into the struct path.
const enumNode = buildNodeFromXml(
    xmlObject('DUT', 'E_Mode', 'TYPE E_Mode :\n(\n\tIdle := 0,\n\tRun\n);\nEND_TYPE\n'),
    'file:///c:/fake/E_Mode.TcDUT');
assert(enumNode && typeFromNode(enumNode).kind === 'enum', 'an enum DUT still resolves as kind \'enum\'');

// ---------------------------------------------------------------------------
// 2. UNION — member access must produce no diagnostics (this was 6 false positives)
// ---------------------------------------------------------------------------
console.log('\n--- UNION: member access diagnostics ---');

const fbUri = 'file:///c:/fake/FB_DUT.TcPOU';
const fbCode = [
    'FUNCTION_BLOCK FB_DUT',
    'VAR',
    '\tuCAN : U_CANState;',
    '\tnRaw : UINT;',
    '\tbErr : BOOL;',
    'END_VAR',
    'nRaw := uCAN.nCANState;',
    'bErr := uCAN.stCANState.bError;',
    'uCAN.nCANState := 0;',
    'END_FUNCTION_BLOCK',
    ''
].join('\n');

parseAndIndexDocument(fbCode, fbUri);
const fbDiags = provideDiagnostics(fbCode, index, fbUri);
assert(fbDiags.length === 0,
    `reading union members yields no diagnostics, got ${fbDiags.length}: ${fbDiags.map(d => d.message).join(' | ')}`);

// A genuinely wrong member must still be flagged — the fix must not blind the check.
const badUri = 'file:///c:/fake/FB_Bad.TcPOU';
const badCode = [
    'FUNCTION_BLOCK FB_Bad',
    'VAR',
    '\tuCAN : U_CANState;',
    '\tnRaw : UINT;',
    'END_VAR',
    'nRaw := uCAN.nNotAMember;',
    'END_FUNCTION_BLOCK',
    ''
].join('\n');
parseAndIndexDocument(badCode, badUri);
const badDiags = provideDiagnostics(badCode, index, badUri);
assert(badDiags.some(d => /"nNotAMember" is not a member of type "U_CANState"/.test(d.message)),
    'an undeclared union member is still reported');

// ---------------------------------------------------------------------------
// 3. UNION — ST path (src/lsp/parser.js): members declared in the live (unsaved) text
// ---------------------------------------------------------------------------
console.log('\n--- UNION: ST path ---');

// Simulates the live editor: the XML on disk is indexed first (node exists, no members yet),
// then the assembled ST unit — carrying the user's unsaved edits — is parsed on top of it.
const liveUri = 'file:///c:/fake/U_Live.TcDUT';
index['U_Live'] = {
    name: 'U_Live', type: 'DUT', uri: liveUri,
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    nameRange: { startLine: 1, startCol: 6, endLine: 1, endCol: 12 },
    extends: null, implements: [], variables: [], methods: [], properties: [], actions: []
};
const liveSt = 'TYPE U_Live :\nUNION\n\tnWord\tAT %I*\t: UINT;\n\tstAll\t: ST_CANStates;\nEND_UNION\nEND_TYPE\n';
parseAndIndexDocument(liveSt, liveUri);
const liveNames = index['U_Live'].variables.map(v => v.name);
assert(liveNames.length === 2 && liveNames.includes('nWord') && liveNames.includes('stAll'),
    `the ST path indexes UNION members: [${liveNames.join(', ')}]`);

// Re-parsing (every keystroke does) must not duplicate the members.
parseAndIndexDocument(liveSt, liveUri);
assert(index['U_Live'].variables.length === 2,
    `re-parsing does not duplicate union members, got ${index['U_Live'].variables.length}`);

// Same for a STRUCT body in the ST path.
const liveStructUri = 'file:///c:/fake/ST_Live.TcDUT';
index['ST_Live'] = {
    name: 'ST_Live', type: 'DUT', uri: liveStructUri,
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    nameRange: { startLine: 1, startCol: 6, endLine: 1, endCol: 13 },
    extends: null, implements: [], variables: [], methods: [], properties: [], actions: []
};
parseAndIndexDocument('TYPE ST_Live :\nSTRUCT\n\tbFlag\t: BOOL;\nEND_STRUCT\nEND_TYPE\n', liveStructUri);
assert(index['ST_Live'].variables.map(v => v.name).join(',') === 'bFlag',
    'the ST path indexes STRUCT members the same way');

// ---------------------------------------------------------------------------
// 4. REF= / S= / R= — one operator token each; comparisons stay a plain '='
// ---------------------------------------------------------------------------
console.log('\n--- ExST assignment operators ---');

const refToks = lex('THIS^.refSensor REF= refSensor;');
const refOps = refToks.filter(t => t.type === TokenType.Operator).map(t => t.value);
assert(refOps.includes('REF='), `REF= lexes as ONE operator token: ${render(refToks)}`);
assert(!refToks.some(t => t.type === TokenType.Identifier && t.value.toUpperCase() === 'REF'),
    'REF is no longer emitted as a bare identifier');
assert(!refOps.includes('='), 'REF= does not leave a stray "=" operator behind');

const refTok = refToks.find(t => t.value === 'REF=');
assert(refTok && refTok.end - refTok.start === 4 && refTok.col === 17,
    `REF= keeps a correct span (col 17, length 4), got col ${refTok && refTok.col}, length ${refTok && (refTok.end - refTok.start)}`);

// REF= is also used on plain (non-THIS) targets and against ADR/expressions.
assert(lex('refAxis REF= fbAxis;').some(t => t.type === TokenType.Operator && t.value === 'REF='),
    'REF= lexes on a plain reference target');

// ExST set/reset assignments.
const setToks = lex('bOutput S= TRUE;');
assert(setToks.filter(t => t.type === TokenType.Operator).map(t => t.value).join(',') === 'S=',
    `S= lexes as one operator: ${render(setToks)}`);
const resetToks = lex('bOutput R= TRUE;');
assert(resetToks.filter(t => t.type === TokenType.Operator).map(t => t.value).join(',') === 'R=',
    `R= lexes as one operator: ${render(resetToks)}`);

// ...and must NOT mis-fire on ordinary comparisons — a false positive here would corrupt real code.
for (const [expr, id] of [['nPos = 5', 'nPos'], ['bStatus = TRUE', 'bStatus'], ['nPOS = 5', 'nPOS'],
                          ['xR = y', 'xR'], ['S = 5', 'S'], ['R = 5', 'R']]) {
    const toks = lex(expr);
    const ops = toks.filter(t => t.type === TokenType.Operator).map(t => t.value);
    assert(ops.join(',') === '=' && toks[0].value === id,
        `"${expr}" still lexes as a comparison: ${render(toks)}`);
}
// The identifier must never be split: R_TRIG / S_Value are single identifiers.
assert(lex('fbTrig : R_TRIG;')[2].value === 'R_TRIG', 'R_TRIG is not split by the R= rule');
assert(lex('nPos := 5;').filter(t => t.type === TokenType.Operator).map(t => t.value).join(',') === ':=',
    ':= is unaffected');
assert(lex('IF a <> b AND c >= d THEN').filter(t => t.type === TokenType.Operator).map(t => t.value).join(',') === '<>,>=',
    '<> and >= are unaffected');
assert(lex('fb(bIn := TRUE, bOut => bDone);').filter(t => t.type === TokenType.Operator).map(t => t.value).join(',') === ':=,=>',
    '=> (output assignment) is unaffected');

// ---------------------------------------------------------------------------
// 5. Audit — constructs used by the sample project
// ---------------------------------------------------------------------------
console.log('\n--- Construct audit ---');

// Short-circuit boolean operators are single keywords.
const shortCircuit = lex('IF a AND_THEN b OR_ELSE c THEN');
assert(shortCircuit.filter(t => t.type === TokenType.Keyword).map(t => t.value).join(',') === 'IF,AND_THEN,OR_ELSE,THEN',
    `AND_THEN / OR_ELSE are keywords: ${render(shortCircuit)}`);

// Builtin operators/functions used across the sample must be recognised as builtins,
// otherwise every call site is flagged as undeclared.
for (const name of ['__ISVALIDREF', 'SIZEOF', 'ADR', 'TO_STRING', 'REF', 'CONTINUE', 'EXIT',
                    'THIS', 'SUPER', 'PERSISTENT', 'CONSTANT', 'UNION', 'END_UNION']) {
    assert(isBuiltin(name), `${name} is a known builtin/keyword`);
}

// THIS^ / SUPER^ — keyword followed by the dereference operator.
const thisToks = lex('THIS^.nCount := SUPER^.nCount;');
assert(thisToks[0].type === TokenType.Keyword && thisToks[1].value === '^' && thisToks[1].type === TokenType.Operator,
    `THIS^ lexes as keyword + '^': ${render(thisToks)}`);
assert(thisToks.some(t => t.type === TokenType.Keyword && t.value === 'SUPER'), 'SUPER^ lexes as a keyword');

// Pragmas / attributes / regions are single skippable tokens and never reach the parser.
const pragmaToks = tokenize("{attribute 'hide'}\n{region Init}\nnA := 1;\n{endregion}");
assert(pragmaToks.filter(t => t.type === TokenType.Pragma).length === 3,
    'attributes and regions lex as Pragma tokens');
assert(!pragmaToks.some(t => t.type === TokenType.Identifier && (t.value === 'attribute' || t.value === 'region')),
    'pragma contents are never emitted as identifiers');

// Declaration blocks: scopes, qualifiers, pragmas, direct addresses, composite types.
const declCode = [
    'FUNCTION_BLOCK FB_Constructs',
    'VAR_INPUT',
    '\trefIn : REFERENCE TO ST_CANStates;',
    'END_VAR',
    'VAR_INST',
    '\tnInst : INT;',
    'END_VAR',
    'VAR_TEMP',
    '\tnTmp : INT;',
    'END_VAR',
    'VAR CONSTANT',
    '\tcMax : INT := 10;',
    'END_VAR',
    'VAR PERSISTENT',
    '\tnKeep : DINT;',
    'END_VAR',
    'VAR',
    "\t{attribute 'instance-path'}",
    '\taData : ARRAY [1..10] OF UINT;',
    '\tpData : POINTER TO BYTE;',
    '\tnIn AT %I* : UINT;',
    '\tnOut AT %Q* : UINT;',
    'END_VAR',
    'END_FUNCTION_BLOCK',
    ''
].join('\n');

const constructsUri = 'file:///c:/fake/FB_Constructs.TcPOU';
parseAndIndexDocument(declCode, constructsUri);
const cNode = index['FB_Constructs'];
const byName = {};
(cNode ? cNode.variables : []).forEach(v => { byName[v.name] = v; });

const expectedVars = [
    ['refIn', 'REFERENCE TO ST_CANStates', 'VAR_INPUT'],
    ['nInst', 'INT', 'VAR_INST'],
    ['nTmp', 'INT', 'VAR_TEMP'],
    ['cMax', 'INT := 10', 'VAR'],
    ['nKeep', 'DINT', 'VAR'],
    ['aData', 'ARRAY [1..10] OF UINT', 'VAR'],
    ['pData', 'POINTER TO BYTE', 'VAR'],
    ['nIn', 'UINT', 'VAR'],
    ['nOut', 'UINT', 'VAR']
];
for (const [name, type, scope] of expectedVars) {
    const v = byName[name];
    const gotType = v ? v.type.replace(/\s+/g, ' ').trim() : '(missing)';
    assert(v && gotType === type && v.scope === scope,
        `${scope} ${name} : ${type} — got ${v ? v.scope : '(missing)'} ${gotType}`);
}

// Composite types must resolve to the right kind (this is what member/assignment checks use).
assert(parseTypeString('REFERENCE TO ST_CANStates', index).kind === 'reference', 'REFERENCE TO resolves as a reference');
assert(parseTypeString('POINTER TO BYTE', index).kind === 'pointer', 'POINTER TO resolves as a pointer');
assert(parseTypeString('ARRAY [1..10] OF UINT', index).kind === 'array', 'ARRAY [..] OF resolves as an array');

// Control-flow keywords used in the sample's loops.
const loopToks = lex('FOR i := 1 TO 10 DO IF a THEN CONTINUE; END_IF EXIT; END_FOR');
const loopKw = loopToks.filter(t => t.type === TokenType.Keyword).map(t => t.value);
assert(loopKw.includes('CONTINUE') && loopKw.includes('EXIT'), 'CONTINUE / EXIT are keywords');

// Alias and subrange DUTs: they declare no members, and must not fabricate any.
const aliasNode = buildNodeFromXml(xmlObject('DUT', 'T_Alias', 'TYPE T_Alias : INT;\nEND_TYPE\n'),
    'file:///c:/fake/T_Alias.TcDUT');
assert(aliasNode && aliasNode.variables.length === 0, 'an alias DUT yields no bogus members');
const subrangeNode = buildNodeFromXml(xmlObject('DUT', 'T_Sub', 'TYPE T_Sub : INT (0..100);\nEND_TYPE\n'),
    'file:///c:/fake/T_Sub.TcDUT');
assert(subrangeNode && subrangeNode.variables.length === 0, 'a subrange DUT yields no bogus members');
const subToks = lex('TYPE T_Sub : INT (0..100); END_TYPE');
assert(subToks.some(t => t.type === TokenType.Number && t.value === '100'),
    `a subrange bound lexes cleanly: ${render(subToks)}`);

// The block parser terminates on END_STRUCT / END_UNION as well as END_VAR.
const structBody = tokenize('STRUCT\n\tbA : BOOL;\nEND_STRUCT\nEND_TYPE\n');
const structStart = structBody.findIndex(t => t.type === TokenType.Keyword && t.value === 'STRUCT');
const parsed = parseVariablesBlock(structBody, structStart + 1, 'STRUCT');
assert(parsed.vars.length === 1 && parsed.vars[0].name === 'bA',
    'parseVariablesBlock reads a STRUCT body and stops at END_STRUCT');

// ---------------------------------------------------------------------------
// 6. Alias / subrange DUTs — classified, then left alone
//
// A DUT that is neither struct/union nor enum declares NO members. It used to be
// indistinguishable from an empty struct (isEnumNode is false when there are no variables), so
// typeFromNode resolved it to `kind: 'struct'` — which produced two false positives on valid ST:
// a numeric use was a type mismatch, and any member access was checked against an empty field set.
// `node.dutKind` records the real shape, and an alias/subrange now resolves to the anonymous
// `unknown` type: never member-checked, never mismatched.
// ---------------------------------------------------------------------------
console.log('\n--- Alias / subrange DUTs ---');

// 6a. The classifier. Enum vs subrange turns on what precedes the '(' — an enum's member list
// follows the colon directly (an optional base type comes AFTER it), a subrange's parens follow a
// base type name and hold a `low..high` range.
const kindCases = [
    ['TYPE T_Handle : DWORD; END_TYPE', 'alias'],
    ['TYPE T_Percent : INT(0..100); END_TYPE', 'alias'],
    ['TYPE T_Percent : INT (0..100); END_TYPE', 'alias'],           // space before the range
    ['TYPE T_Name : STRING(80); END_TYPE', 'alias'],                // sized-string alias
    ['TYPE T_Buf : ARRAY[0..9] OF BYTE; END_TYPE', 'alias'],        // array alias (no parens at all)
    ['TYPE T_Ref : ST_CANStates; END_TYPE', 'alias'],               // alias of another DUT
    ['TYPE E_Mode :\n(\n\tIdle := 0,\n\tRun\n);\nEND_TYPE', 'enum'],
    ['TYPE E_Based : (A := 1, B := 2) DINT; END_TYPE', 'enum'],     // base type AFTER the list
    ["{attribute 'qualified_only'}\nTYPE E_Attr : (A, B); END_TYPE", 'enum'],
    ["{attribute 'ns' := 'X'}\nTYPE E_Pragma : (A, B); END_TYPE", 'enum'], // ':=' in the pragma
    ['TYPE E_Cmt : (* the mode *) (A, B); END_TYPE', 'enum'],       // comment between ':' and '('
    ['TYPE ST_Pt :\nSTRUCT\n\tnX : INT;\nEND_STRUCT\nEND_TYPE', 'struct'],
    ['TYPE U_Val :\nUNION\n\tnAll : DWORD;\nEND_UNION\nEND_TYPE', 'union']
];
for (const [decl, kind] of kindCases) {
    const got = dutKindFromDecl(decl);
    assert(got === kind, `dutKind '${kind}' for ${JSON.stringify(decl.slice(0, 44))} — got '${got}'`);
}

// 6b. Indexed nodes carry the kind, and only the composite kinds carry members.
const aliasUri = 'file:///c:/fake/T_Handle.TcDUT';
const subUri = 'file:///c:/fake/T_Percent.TcDUT';
const eKindUri = 'file:///c:/fake/E_Kind.TcDUT';
const pointUri = 'file:///c:/fake/ST_Point.TcDUT';
const uWordUri = 'file:///c:/fake/U_Word.TcDUT';

// DUTs must be indexed through the XML path: parseAndIndexDocument does NOT create DUT nodes
// from raw ST (it only attaches members to a node the XML indexer already built).
indexXmlObject(index, xmlObject('DUT', 'T_Handle', 'TYPE T_Handle : DWORD;\nEND_TYPE\n'), aliasUri);
indexXmlObject(index, xmlObject('DUT', 'T_Percent', 'TYPE T_Percent : INT(0..100);\nEND_TYPE\n'), subUri);
indexXmlObject(index, xmlObject('DUT', 'E_Kind', 'TYPE E_Kind :\n(\n\tIdle := 0,\n\tRun,\n\tDone\n);\nEND_TYPE\n'), eKindUri);
indexXmlObject(index, xmlObject('DUT', 'ST_Point', 'TYPE ST_Point :\nSTRUCT\n\tnX : INT;\n\tnY : INT;\nEND_STRUCT\nEND_TYPE\n'), pointUri);
indexXmlObject(index, xmlObject('DUT', 'U_Word', 'TYPE U_Word :\nUNION\n\tnAll : DWORD;\n\tnLow : WORD;\nEND_UNION\nEND_TYPE\n'), uWordUri);

for (const [name, kind, members] of [['T_Handle', 'alias', 0], ['T_Percent', 'alias', 0],
                                     ['E_Kind', 'enum', 3], ['ST_Point', 'struct', 2], ['U_Word', 'union', 2]]) {
    const n = index[name];
    assert(n && n.dutKind === kind && n.variables.length === members,
        `${name}: dutKind '${kind}' with ${members} member(s) — got '${n && n.dutKind}' with ${n && n.variables.length}`);
}

// The alias resolves to the ANONYMOUS unknown. The empty name matters: checkDeclarationTypes
// reports an unknown leaf type unless its name is empty, so a *named* unknown would newly flag
// `hHandle : T_Handle;` as "Unknown type" — gaining a diagnostic, which the conservative rule forbids.
const aliasType = typeFromNode(index['T_Handle']);
assert(aliasType.kind === 'unknown' && aliasType.name === '',
    `an alias DUT resolves to the anonymous unknown, got kind '${aliasType.kind}' name '${aliasType.name}'`);
const subType = parseTypeString('T_Percent', index);
assert(subType.kind === 'unknown' && subType.name === '',
    `a subrange DUT resolves to the anonymous unknown, got kind '${subType.kind}' name '${subType.name}'`);
assert(lookupMember(aliasType, 'foo', index) === undefined,
    'lookupMember on an alias type returns undefined ("cannot tell"), never null ("definitely absent")');

// The real composite kinds are untouched — the UNION fix in particular must stay green.
assert(typeFromNode(index['E_Kind']).kind === 'enum', 'an enum DUT still resolves as kind \'enum\'');
assert(typeFromNode(index['ST_Point']).kind === 'struct', 'a struct DUT still resolves as kind \'struct\'');
assert(typeFromNode(index['U_Word']).kind === 'struct', 'a UNION DUT still resolves as kind \'struct\'');
assert(!!lookupMember(typeFromNode(index['ST_Point']), 'nY', index), 'struct members still resolve');
assert(!!lookupMember(typeFromNode(index['U_Word']), 'nLow', index), 'union members still resolve');
assert(lookupMember(typeFromNode(index['ST_Point']), 'nZ', index) === null,
    'a member the struct does not declare is still definitely absent');

// 6c. Diagnostics: using an alias/subrange numerically, or reaching into it, must stay silent.
const aliasPouUri = 'file:///c:/fake/FB_Alias.TcPOU';
const aliasCode = [
    'FUNCTION_BLOCK FB_Alias',
    'VAR',
    '\thHandle : T_Handle;',
    '\tnPct : T_Percent;',
    '\tnSeed : T_Percent := 50;',
    '\tnCount : INT;',
    '\tnRaw : DWORD;',
    'END_VAR',
    'nCount := nPct;',        // subrange -> INT
    'nPct := nCount;',        // INT -> subrange
    'nRaw := hHandle;',       // alias -> DWORD
    'hHandle := nRaw;',       // DWORD -> alias
    'nCount := nSeed;',
    'nCount := hHandle.foo;', // member access on an alias: unresolvable, so never flagged
    'END_FUNCTION_BLOCK',
    ''
].join('\n');
parseAndIndexDocument(aliasCode, aliasPouUri);
const aliasDiags = provideDiagnostics(aliasCode, index, aliasPouUri);
assert(aliasDiags.length === 0,
    `alias/subrange DUTs used numerically and member-accessed yield no diagnostics, got ${aliasDiags.length}: ${aliasDiags.map(d => d.message).join(' | ')}`);

// The same holds with the opt-in declarationTypes check on: the alias must not become "Unknown type".
setDiagnosticsConfig({ declarationTypes: true });
const aliasDiagsStrict = provideDiagnostics(aliasCode, index, aliasPouUri);
setDiagnosticsConfig({ declarationTypes: false }); // restore the default
assert(aliasDiagsStrict.length === 0,
    `alias/subrange DUTs stay silent with declarationTypes on, got ${aliasDiagsStrict.length}: ${aliasDiagsStrict.map(d => d.message).join(' | ')}`);

// 6d. The enum path must not have been dragged into the alias branch: members still complete,
// and a CASE on an enum selector still ranks that enum's labels first.
const enumUseUri = 'file:///c:/fake/FB_EnumUse.TcPOU';
const enumUseLines = [
    'FUNCTION_BLOCK FB_EnumUse',
    'VAR',
    '\teKind : E_Kind;',
    '\tnOut : INT;',
    'END_VAR',
    'eKind := E_Kind.Run;',
    'CASE eKind OF',
    '',
    'END_CASE',
    'END_FUNCTION_BLOCK',
    ''
];
const enumUseCode = enumUseLines.join('\n');
parseAndIndexDocument(enumUseCode, enumUseUri);
assert(provideDiagnostics(enumUseCode, index, enumUseUri).length === 0,
    'qualified enum member access + CASE on an enum yields no diagnostics');

// `E_Kind.` — caret just after the dot on line 5.
const dotLine = 5;
const dotCol = enumUseLines[dotLine].indexOf('.') + 1;
const dotItems = provideCompletions(enumUseCode, { line: dotLine, character: dotCol }, index, enumUseUri) || [];
const dotLabels = dotItems.map(i => i.label);
assert(['Idle', 'Run', 'Done'].every(m => dotLabels.includes(m)),
    `E_Kind. completes its members: [${dotLabels.join(', ')}]`);

// CASE label position: the enum's members must be offered, ranked first ('00_' sortText).
const caseItems = provideCompletions(enumUseCode, { line: 7, character: 0 }, index, enumUseUri) || [];
const caseMembers = caseItems.filter(i => ['Idle', 'Run', 'Done'].includes(i.label));
assert(caseMembers.length === 3, `CASE offers all 3 E_Kind labels, got ${caseMembers.length}`);
assert(caseMembers.every(i => (i.sortText || '').startsWith('00_')),
    'CASE ranks the selector enum\'s labels first (sortText "00_")');

// ----------------------------------------------------------------------------------------------
// 6. Access / inheritance modifiers between a keyword and the name it introduces.
//
// `FUNCTION_BLOCK ABSTRACT FB_Axis` used to find no name at all, so the POU node was never created.
// parseAndIndexDocument then *appended* the declarations to whatever xmlIndexer had already indexed:
// the real FB_Axis carried 151 variables where it has 67, every one duplicated. Silent, because
// duplicate declarations flag nothing — which is exactly why it survived so long.
// ----------------------------------------------------------------------------------------------
clearWorkspaceIndex();
parseAndIndexDocument(`FUNCTION_BLOCK ABSTRACT FB_Base IMPLEMENTS I_Thing
VAR
    nCount : INT;
END_VAR

METHOD PUBLIC Cyclic : BOOL
VAR
    i : INT;
END_VAR
END_METHOD

PROPERTY PUBLIC bReady : BOOL
END_PROPERTY
`, 'file:///x/FB_Base.st');

const abs = getWorkspaceSymbolIndex()['FB_Base'];
assert(!!abs, 'FUNCTION_BLOCK ABSTRACT <name> is indexed at all');
assert(abs && abs.implements.includes('I_Thing'),
    `...and IMPLEMENTS is still read past the modifier (got ${abs && JSON.stringify(abs.implements)})`);
assert(abs && abs.variables.length === 1 && abs.variables[0].name === 'nCount',
    `...with its declarations recorded once, not duplicated (got ${abs && abs.variables.map(v => v.name).join(',')})`);
assert(abs && abs.methods.some(m => m.name === 'Cyclic'), 'METHOD PUBLIC <name> is indexed');
assert(abs && abs.properties.some(p => p.name === 'bReady'), 'PROPERTY PUBLIC <name> is indexed');

// Re-parsing the same document must *replace* the node, never append to it — the actual mechanism
// behind the 151-variable FB_Axis.
parseAndIndexDocument(`FUNCTION_BLOCK ABSTRACT FB_Base
VAR
    nCount : INT;
END_VAR
`, 'file:///x/FB_Base.st');
assert(getWorkspaceSymbolIndex()['FB_Base'].variables.length === 1,
    `re-indexing replaces the declarations (got ${getWorkspaceSymbolIndex()['FB_Base'].variables.length})`);

// An unmodified POU must be entirely unaffected by the modifier skip.
clearWorkspaceIndex();
parseAndIndexDocument(`FUNCTION_BLOCK FB_Plain
VAR
    x : INT;
END_VAR
`, 'file:///x/FB_Plain.st');
const plain = getWorkspaceSymbolIndex()['FB_Plain'];
assert(plain && plain.variables.length === 1 && plain.variables[0].name === 'x',
    'a POU with no modifier is unchanged');

// ---------------------------------------------------------------------------------------------
// A call to a method named Get or Set must not be read as a PROPERTY ACCESSOR.
//
// GET and SET are only accessors at the head of a declaration inside a PROPERTY. TwinCAT code calls
// methods named Get and Set routinely — `fbQueue.Get(Item := n)` on a Tc3 FB_Queue. Read as an
// accessor, the parser scanned forward for an END_GET that never comes and swallowed the rest of the
// method — its END_METHOD included — and every method after it. In one real FB this ate 24 of its 44
// methods: every variable inside them became invisible, so completion, diagnostics, Go to Definition
// and Find References were all silently broken there. Find References in particular then listed every
// same-named variable in the project, because it keeps what it cannot resolve.
// ---------------------------------------------------------------------------------------------
clearWorkspaceIndex();
parseAndIndexDocument(`FUNCTION_BLOCK FB_Queue_User
VAR
    fbQueue : FB_Queue;
END_VAR

METHOD DoWork : BOOL
VAR_OUTPUT
    bDone : BOOL;
END_VAR
fbQueue.Get(Item := nStep);
fbQueue.Set(Item := 3);
bDone := TRUE;
END_METHOD

METHOD AfterTheCall : BOOL
VAR_OUTPUT
    bDone : BOOL;
END_VAR
bDone := TRUE;
END_METHOD

PROPERTY Value : INT
GET
Value := 42;
END_GET
SET
END_SET
END_PROPERTY
`, 'file:///getset.st');

const gs = Object.values(getWorkspaceSymbolIndex()).find(n => n.name === 'FB_Queue_User');
const gsMethods = (gs.methods || []).map(m => m.name);
assert(gsMethods.includes('DoWork'), 'the method containing fbQueue.Get(...) is parsed');
assert(gsMethods.includes('AfterTheCall'),
    'the method AFTER a fbQueue.Get(...) call survives — an accessor misread here swallowed everything following it');

const doWork = (gs.methods || []).find(m => m.name === 'DoWork');
assert(doWork && doWork.declRange.endLine > doWork.declRange.startLine,
    'the method containing the Get call has a real line range, not a degenerate one');
assert(doWork && (doWork.variables || []).some(v => v.name === 'bDone'),
    "...and its variables are still indexed (they vanished with the method before)");

// The real accessors must still work.
assert((gs.properties || []).some(p => p.name === 'Value'), 'a genuine PROPERTY is still parsed');

// ---------------------------------------------------------------------------
// 8. Declaration-site pragmas are metadata, not part of the type
// ---------------------------------------------------------------------------
// A pragma between the ':' and the ';' used to be concatenated into the type string, so
// `{attribute 'x'} INT` was the declared type — a string that resolves to nothing. Invisible only
// because declarationTypes is off by default; a false "Unknown type" the day it is switched on.
console.log('\n--- pragmas in declarations ---');
{
    const uri = 'file:///c:/fake/FB_Pragma.TcPOU';
    const code = [
        'FUNCTION_BLOCK FB_Pragma',
        'VAR',
        "\t{attribute 'TcEncoding' := 'UTF-8'}",
        '\tsOwnLine : STRING;',                 // pragma on its own line, before the name
        "\tnLeading : {attribute 'x'} INT;",    // pragma between ':' and the type
        "\tnTrailing : INT {attribute 'y'};",   // pragma between the type and ';'
        '\tnInit : INT := 7;',                  // initializer must SURVIVE
        '\tnPlain : INT;',
        'END_VAR',
        'nPlain := nLeading + nTrailing + nInit;',
        'END_FUNCTION_BLOCK',
        ''
    ].join('\n');
    parseAndIndexDocument(code, uri);
    const node = Object.values(getWorkspaceSymbolIndex()).find(n => n.name === 'FB_Pragma');
    const typeOf = name => (node.variables.find(v => v.name === name) || {}).type;

    assert(typeOf('sOwnLine') === 'STRING', `a pragma on its own line leaves the next type alone (got ${JSON.stringify(typeOf('sOwnLine'))})`);
    assert(typeOf('nLeading') === 'INT', `a pragma before the type is not folded into it (got ${JSON.stringify(typeOf('nLeading'))})`);
    assert(typeOf('nTrailing') === 'INT', `a pragma after the type is not folded into it (got ${JSON.stringify(typeOf('nTrailing'))})`);
    assert(typeOf('nInit') === 'INT := 7',
        `the initializer is NOT stripped — decl-site init lists are load-bearing (got ${JSON.stringify(typeOf('nInit'))})`);

    // The point of the fix: with the opt-in check on, none of these may read as an unknown type.
    setDiagnosticsConfig({ declarationTypes: true });
    const strict = provideDiagnostics(code, index, uri);
    setDiagnosticsConfig({ declarationTypes: false });
    assert(strict.length === 0,
        `pragma-bearing declarations stay silent with declarationTypes on, got ${strict.length}: ${strict.map(d => d.message).join(' | ')}`);
}

// ---------------------------------------------------------------------------
// 9. Inline (anonymous) enums: `eState : (idle, running)`
// ---------------------------------------------------------------------------
// There is no DUT node to point at, so the type used to fall through to a NAMED unknown
// ('(idle, running)') — the shape declarationTypes flags, and one no CASE selector could resolve,
// which left a CASE body falling back to the whole value list instead of the enum's own labels.
console.log('\n--- inline (anonymous) enums ---');
{
    const t = parseTypeString('(idle, running, faulted)', index);
    assert(t.kind === 'enum' && t.anonymous === true,
        `an inline enum parses as an anonymous enum, not an unknown (got ${JSON.stringify(t.kind)})`);
    assert(JSON.stringify(t.values) === JSON.stringify(['idle', 'running', 'faulted']),
        `...carrying its value names in declaration order (got ${JSON.stringify(t.values)})`);

    const withInit = parseTypeString('(idle := 0, running := 10)', index);
    assert(JSON.stringify(withInit.values) === JSON.stringify(['idle', 'running']),
        `explicitly numbered values keep their names only (got ${JSON.stringify(withInit.values)})`);

    // A parenthesised type that names nothing must NOT be claimed as an enum.
    assert(parseTypeString('()', index).kind !== 'enum', 'an empty parenthesis is not an enum');

    const uri = 'file:///c:/fake/FB_Inline.TcPOU';
    const lines = [
        'FUNCTION_BLOCK FB_Inline',
        'VAR',
        '\teState : (idle, running, faulted);',
        '\tnCount : INT;',
        'END_VAR',
        'CASE eState OF',
        '\t',                                  // the CASE-label caret sits here
        'END_CASE',
        'eState := ;',
        'nCount := 1;',
        'END_FUNCTION_BLOCK',
        ''
    ];
    const code = lines.join('\n');
    parseAndIndexDocument(code, uri);

    // Derived, never hardcoded: editing the fixture silently shifted these once already, and a
    // caret that lands on the wrong line can PASS for the wrong reason.
    const caseBodyLine = lines.indexOf('\t');
    const assignLine = lines.findIndex(l => l.startsWith('eState :='));

    const VALUES = ['idle', 'running', 'faulted'];
    const labelCaret = provideCompletions(code, { line: caseBodyLine, character: 1 }, index, uri) || [];
    const offered = labelCaret.filter(i => VALUES.includes(i.label)).map(i => i.label);
    assert(JSON.stringify(offered) === JSON.stringify(VALUES),
        `a CASE on an inline enum offers exactly its own values (got ${JSON.stringify(offered)})`);
    assert(!labelCaret.some(i => String(i.label).startsWith('(')),
        'the enum\'s "name" — its own value list — is never offered as a writable label');

    // Ranked into place at an assignment, and NOT duplicated: the parser already registers inline
    // values as scope variables, so pushing them again would list every one of them twice.
    const valueCaret = provideCompletions(code, { line: assignLine, character: 'eState := '.length }, index, uri) || [];
    const hits = valueCaret.filter(i => VALUES.includes(i.label));
    assert(hits.length === VALUES.length,
        `an assignment caret offers each inline value exactly once (got ${hits.length} for ${VALUES.length} values)`);
    assert(hits.every(i => !!i.sortText), 'the selector\'s own values are ranked to the top');

    // Conservatism: an inline enum has no nominal identity, so nothing may be flagged against it.
    const diags = provideDiagnostics(code, index, uri);
    assert(diags.length === 0,
        `using an inline enum yields no diagnostics, got ${diags.length}: ${diags.map(d => d.message).join(' | ')}`);

    setDiagnosticsConfig({ declarationTypes: true });
    const strict = provideDiagnostics(code, index, uri);
    setDiagnosticsConfig({ declarationTypes: false });
    assert(strict.length === 0,
        `an inline enum is not an "Unknown type" with declarationTypes on, got ${strict.length}: ${strict.map(d => d.message).join(' | ')}`);
}

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll parser-construct assertions passed.');
