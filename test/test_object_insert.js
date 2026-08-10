/**
 * @file test_object_insert.js
 * @description "Insert at Cursor" / "Insert Definition at Cursor" for the **TwinCAT Objects** tree
 * (the project's own objects), plus the refactor that made it possible.
 *
 * The call-template formatter used to live inside `src/libraryTreeProvider.js`, which requires
 * `vscode` at module scope and therefore cannot be loaded by a standalone harness at all. It now
 * lives in `src/insertTemplates.js` (vscode-free), so both the Libraries view and the Objects tree
 * format a call the same way — and so this file can test it. The first assertion below is the guard
 * on that move: a byte-exact golden captured from the pre-move implementation.
 *
 * Everything else runs the REAL `buildNodeFromXml` over REAL objects in the committed `sample/`
 * project rather than hand-written node literals, because the parameter list comes out of the XML
 * and a literal would test nothing about that path.
 *
 * **One fixture is synthetic and deliberately so:** no function block in `sample/` declares a single
 * VAR_INPUT / VAR_IN_OUT / VAR_OUTPUT at its root (FB_Cylinder, FB_Station and FB_StationDerived all
 * carry plain VAR only — verified by sweeping every object), so the sample cannot express the case
 * this feature exists for: an FB whose call template mixes `:=` and `=>` and must order the three
 * scopes. That one case is driven from a synthetic .TcPOU **XML string** — still parsed by the real
 * `parseTwinCatXml` + `buildNodeFromXml`, so only the input is invented, not the node.
 */

const fs = require('fs');
const path = require('path');
const { buildNodeFromXml } = require('../src/lsp/xmlIndexer');
const {
    PARAM_SCOPES,
    callTemplate,
    orderedParams,
    instanceNameForFb,
    objectInsertText,
    objectDefinitionText
} = require('../src/insertTemplates');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
function assertEq(actual, expected, msg) {
    if (actual === expected) console.log(`[PASS] ${msg}`);
    else {
        console.error(`[FAIL] ${msg}`);
        console.error(`         expected: ${JSON.stringify(expected)}`);
        console.error(`         actual:   ${JSON.stringify(actual)}`);
        errors++;
    }
}

// ------------------------------------------------------------ the refactor guard
// Captured by running the pre-move `callTemplate` from src/libraryTreeProvider.js (rev cc25de1) on
// this exact parameter list. The Libraries view's shipped output must not shift by one byte just
// because the function moved house — including its quirks: the comma lands directly after the
// assignment operator and before the `// TYPE` comment, and a parameter with no type leaves a
// trailing space.
const GOLDEN_PARAMS = [
    { name: 'bExecute', scope: 'VAR_INPUT', type: 'BOOL' },
    { name: 'nId', scope: 'VAR_INPUT', type: 'UDINT' },
    { name: 'refBuf', scope: 'VAR_IN_OUT', type: 'ARRAY[1..8] OF BYTE' },
    { name: 'bDone', scope: 'VAR_OUTPUT', type: 'BOOL' },
    { name: 'nErr', scope: 'VAR_OUTPUT', type: '' }
];
assertEq(
    callTemplate('fbClamping', GOLDEN_PARAMS),
    'fbClamping(\n'
    + '    bExecute := ,  // BOOL\n'
    + '    nId      := ,  // UDINT\n'
    + '    refBuf   := ,  // ARRAY[1..8] OF BYTE\n'
    + '    bDone    => ,  // BOOL\n'
    + '    nErr     => \n'
    + ');',
    'callTemplate is byte-identical to the pre-move libraryTreeProvider implementation'
);

assert(PARAM_SCOPES.VAR_INPUT === 0 && PARAM_SCOPES.VAR_IN_OUT === 1 && PARAM_SCOPES.VAR_OUTPUT === 2,
    'PARAM_SCOPES keeps the call-site write order (inputs, in-outs, outputs)');

// `orderedParams` both filters and sorts: a plain VAR is an internal field, never a call argument.
const mixed = [
    { name: 'bDone', scope: 'VAR_OUTPUT' },
    { name: '_nInternal', scope: 'VAR' },
    { name: 'stData', scope: 'VAR_IN_OUT' },
    { name: 'bExecute', scope: 'VAR_INPUT' }
];
assertEq(orderedParams(mixed).map(p => p.name).join(','), 'bExecute,stData,bDone',
    'orderedParams drops plain VAR and sorts VAR_INPUT -> VAR_IN_OUT -> VAR_OUTPUT');
assertEq(orderedParams(undefined).length, 0, 'orderedParams tolerates a node with no variables');

// ------------------------------------------------------ FB instance-name derivation
// ST calls an *instance*, never the type, so an FB's call template needs a name the user is expected
// to replace with their real instance — the same "the prefix is yours to fix" contract the Libraries
// view already documents for methods.
assertEq(instanceNameForFb('FB_Clamping'), 'fbClamping', 'FB_Clamping -> fbClamping');
assertEq(instanceNameForFb('fb_clamping'), 'fbClamping', 'a lower-case fb_ prefix is stripped too');
assertEq(instanceNameForFb('Clamping'), 'fbClamping', 'a name with no FB_ prefix just gains fb');
assertEq(instanceNameForFb('MotorAxis'), 'fbMotorAxis', 'the remainder keeps its own casing');

// ------------------------------------------ an FB with inputs, in-outs and outputs (synthetic XML)
// See the file header: the committed sample has no such FB. The XML is real enough to go through the
// real parser; only the declaration is invented.
const SYNTHETIC_FB = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="FB_Clamping" Id="{00000000-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Clamping
VAR_OUTPUT
    bDone   : BOOL;
    bError  : BOOL;
END_VAR
VAR_INPUT
    bExecute : BOOL;
    nTimeout : UDINT;
END_VAR
VAR_IN_OUT
    stData : ST_Recipe;
END_VAR
VAR
    _nState : INT;
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;

const fbClamping = buildNodeFromXml(SYNTHETIC_FB, 'file:///c:/synthetic/FB_Clamping.TcPOU');
assert(fbClamping && fbClamping.type === 'FUNCTION_BLOCK', 'the synthetic FB parses as a FUNCTION_BLOCK');
assertEq(
    objectDefinitionText(fbClamping, null),
    'fbClamping(\n'
    + '    bExecute := ,  // BOOL\n'
    + '    nTimeout := ,  // UDINT\n'
    + '    stData   := ,  // ST_Recipe\n'
    + '    bDone    => ,  // BOOL\n'
    + '    bError   =>   // BOOL\n'
    + ');',
    'an FB inserts an instance-name call template: := for inputs/in-outs, => for outputs, '
    + 'VAR_INPUT -> VAR_IN_OUT -> VAR_OUTPUT even though the XML declares outputs first'
);
assertEq(objectInsertText(fbClamping, null), 'FB_Clamping',
    'Insert at Cursor on the same FB yields the bare TYPE name, not the instance name');

// ---------------------------------------------------------------- the real project
const SAMPLE = path.join(__dirname, '..', 'sample', 'TcToolkitSample', 'TcToolkitSample_PLC');
if (!fs.existsSync(SAMPLE)) {
    console.log('\n[SKIP] sample/ not present — skipping the real-object cases');
} else {
    /**
     * Builds a symbol node from a real sample object, through the same code path the command uses.
     * @param {string} rel Path relative to the sample PLC project root.
     * @returns {Object} The symbol node.
     */
    const load = (rel) => {
        const p = path.join(SAMPLE, rel);
        return buildNodeFromXml(fs.readFileSync(p, 'utf8'), 'file:///' + p.replace(/\\/g, '/'));
    };

    const fScale = load('POUs/F_Scale.TcPOU');
    const main = load('POUs/MAIN.TcPOU');
    const pStartup = load('POUs/P_Startup.TcPOU');
    const fbCylinder = load('POUs/Actuators/FB_Cylinder.TcPOU');
    const fbStation = load('POUs/Machine/FB_Station.TcPOU');
    const gvlSystem = load('GVLs/GVL_System.TcGVL');
    const iStation = load('POUs/Interfaces/I_Station.TcIO');
    const stRecipe = load('DUTs/ST_Recipe.TcDUT');

    // --- a FUNCTION is called by its own name (there is no instance to call it on)
    assertEq(
        objectDefinitionText(fScale, null),
        'F_Scale(\n'
        + '    fValue := ,  // LREAL\n'
        + '    fMin   := ,  // LREAL\n'
        + '    fMax   :=   // LREAL\n'
        + ');',
        'a FUNCTION is called by its own name, with its VAR_INPUTs laid out'
    );

    // --- a PROGRAM is called by its name; neither sample program has call parameters
    assertEq(objectDefinitionText(main, null), 'MAIN();', 'a parameterless PROGRAM falls back to Name();');
    assertEq(objectDefinitionText(pStartup, null), 'P_Startup();', 'P_Startup();');

    // --- an FB whose root declares no call parameters still inserts a call, not a bare word:
    // the bare name here would be the derived *instance*, which is neither the type nor a statement.
    assertEq(objectDefinitionText(fbCylinder, null), 'fbCylinder();',
        'a parameterless FB inserts fbName(); — Insert at Cursor is the command that gives a bare name');

    // --- a method component inserts bare (the instance prefix is whatever the user already typed)
    assertEq(
        objectDefinitionText(fbCylinder, 'FB_init'),
        'FB_init(\n'
        + '    bInitRetains  := ,  // BOOL\n'
        + '    bInCopyCode   := ,  // BOOL\n'
        + '    refExtendOut  := ,  // REFERENCE TO BOOL\n'
        + '    refRetractOut :=   // REFERENCE TO BOOL\n'
        + ');',
        'a method inserts its bare name with its own parameters'
    );
    assertEq(objectDefinitionText(fbStation, 'Execute'), 'Execute();', 'a parameterless method -> Name();');
    assertEq(objectDefinitionText(fbStation, 'Act_Home'), 'Act_Home();', 'an ACTION -> Name();');

    // A method's plain VAR is a local, not a parameter — FB_Station.Cyclic declares `bExtended : BOOL`
    // in a bare VAR block and it must not be offered as an argument.
    assertEq(objectDefinitionText(fbStation, 'Cyclic'), 'Cyclic();',
        "a method whose only variable is a plain VAR has no arguments (FB_Station.Cyclic's bExtended is a local)");

    // --- Insert at Cursor: the bare name, for every kind the menu offers it on
    assertEq(objectInsertText(fbCylinder, null), 'FB_Cylinder', 'bare name: function block');
    assertEq(objectInsertText(main, null), 'MAIN', 'bare name: program');
    assertEq(objectInsertText(fScale, null), 'F_Scale', 'bare name: function');
    assertEq(objectInsertText(gvlSystem, null), 'GVL_System', 'bare name: GVL');
    assertEq(objectInsertText(iStation, null), 'I_Station', 'bare name: interface');
    assertEq(objectInsertText(stRecipe, null), 'ST_Recipe', 'bare name: DUT');
    assertEq(objectInsertText(fbStation, 'Cyclic'), 'Cyclic', 'bare name: method component');
    assertEq(objectInsertText(fbStation, 'State'), 'State', 'bare name: property component');
    assertEq(objectInsertText(fbStation, 'Act_Home'), 'Act_Home', 'bare name: action component');

    // --- an object with no call site at all: the definition command is not offered on these
    // (see the `when` clause below), but if it is ever invoked it must degrade to the bare name
    // rather than invent `GVL_System()`.
    assertEq(objectDefinitionText(gvlSystem, null), 'GVL_System', 'a GVL has no call site -> bare name');
    assertEq(objectDefinitionText(iStation, null), 'I_Station', 'an INTERFACE has no call site -> bare name');
    assertEq(objectDefinitionText(stRecipe, null), 'ST_Recipe', 'a DUT has no call site -> bare name');

    console.log('\n--- snippets the feature produces for real sample objects ---');
    for (const [label, text] of [
        ['FB_Cylinder (FB)', objectDefinitionText(fbCylinder, null)],
        ['FB_Cylinder.FB_init (method)', objectDefinitionText(fbCylinder, 'FB_init')],
        ['F_Scale (function)', objectDefinitionText(fScale, null)],
        ['MAIN (program)', objectDefinitionText(main, null)]
    ]) {
        console.log(`\n[${label}]\n${text}`);
    }
}

// ------------------------------------------------- the menu `when` clauses name real contextValues
// The two new menu items are gated on contextValue strings that only src/treeDataProvider.js
// produces. Nothing links the two files, so a rename there would silently orphan the menu entries —
// the commands would simply stop appearing, with no error anywhere. Read the vocabulary out of the
// provider instead of hard-coding it, so this assertion tracks the rename.
const providerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'treeDataProvider.js'), 'utf8');
const vocabulary = new Set();
for (const line of providerSrc.split('\n')) {
    // Every contextValue in the provider is assigned or compared on a line naming the variable that
    // carries it (`contextValue`, or `folderContext` for the virtual-folder branch).
    if (!/contextValue|folderContext/.test(line)) continue;
    for (const m of line.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) vocabulary.add(m[1]);
}
assert(vocabulary.has('pouFile') && vocabulary.has('component') && vocabulary.size > 8,
    `the contextValue vocabulary was extracted from treeDataProvider.js (${vocabulary.size} values)`);

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const menuItems = pkg.contributes.menus['view/item/context'];
for (const command of ['twincat.insertObjectAtCursor', 'twincat.insertObjectDefinitionAtCursor']) {
    const entry = menuItems.find(m => m.command === command);
    assert(!!entry, `${command} has a view/item/context entry`);
    if (!entry) continue;
    assert(/view == twincatExplorer/.test(entry.when), `${command} is gated to the Objects tree`);
    const used = [...entry.when.matchAll(/viewItem == '([^']+)'/g)].map(m => m[1]);
    assert(used.length > 0, `${command} names at least one contextValue`);
    const unknown = used.filter(v => !vocabulary.has(v));
    assert(unknown.length === 0,
        `every contextValue in ${command}'s when clause exists in treeDataProvider.js`
        + `${unknown.length ? ` — unknown: ${unknown.join(', ')}` : ` (${used.join(', ')})`}`);
    assert(pkg.contributes.commands.some(c => c.command === command), `${command} is a declared command`);
}

// Directories and virtual folders are not symbols — inserting their name would insert a folder label.
const insertWhen = (menuItems.find(m => m.command === 'twincat.insertObjectAtCursor') || {}).when || '';
assert(!/viewItem == 'directory'/.test(insertWhen) && !/viewItem == 'pouVirtualFolder/.test(insertWhen),
    'Insert at Cursor is not offered on directories or virtual folders');
const defWhen = (menuItems.find(m => m.command === 'twincat.insertObjectDefinitionAtCursor') || {}).when || '';
assert(!/viewItem == 'gvlFile'/.test(defWhen) && !/viewItem == 'dutFile'/.test(defWhen)
    && !/viewItem == 'itfFile'/.test(defWhen),
    'Insert Definition at Cursor is offered only on callable objects (no GVL / DUT / interface)');

console.log(errors === 0 ? '\nAll object-insert tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
