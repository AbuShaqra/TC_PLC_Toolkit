/**
 * @file test_library_types.js
 * @description Structured library types from the project's `.tmc` — and the conservatism that must
 * survive them.
 *
 * What changed, and why it is dangerous. Library symbols used to be a flat set of *names*: an
 * external node had no kind and no members, `typeFromNode()` mapped it to the anonymous `unknown`,
 * and an unknown type is never member-checked. That anonymity is why the sample sits at zero
 * diagnostics. The `.tmc` (TwinCAT's type-system export, plain XML) actually carries real structure
 * for the types the project uses, so those types can now complete with their real fields.
 *
 * The trap: give a library node real members and let it resolve to a concrete `struct`/`fb`/`enum`,
 * and `checkMemberAccess` starts flagging every member it cannot find — but the `.tmc` only covers
 * what the project uses, holds `<DataType>` blocks only (no constants, no functions), and its member
 * lists are not guaranteed exhaustive. A concrete library kind would therefore manufacture a fresh
 * crop of false positives on correct code, undoing the entire point of the exercise.
 *
 * So the contract this harness enforces is: **enrich completion, keep diagnostics silent.**
 *   - `membersComplete: false` on every library node; `lookupMember()` answers `undefined`
 *     ("cannot be sure") and never `null` ("definitely absent") for one — §4;
 *   - a member type derived from a library type is tagged `external`, so `isAssignable` returns 'ok'
 *     on sight and no type-mismatch can be invented from a `.tmc` description we got slightly wrong;
 *   - the same must NOT over-suppress: an absent member of a *project* struct is still flagged — §4;
 *   - the sample stays at exactly 0 diagnostics, under the default config AND with the two opt-in
 *     checks (`declarationTypes`, `typeCompatibility`) forced on — §5. That is the hard gate.
 *
 * WHICH TYPES IT ASSERTS ON, AND WHY THE PROJECT'S OWN ARE A VALID FIXTURE. It was originally written
 * against a customer project whose `.tmc` described Beckhoff's Tc2_MC2 (MC_Power, ST_AxisStatus,
 * TIMESTRUCT, …). That project is gone; the committed synthetic sample's `.tmc` is what TwinCAT XAE
 * exports for *it*, and — measured 2026-07-20 — it holds **28 `<DataType>` blocks: 10 struct, 5 fb,
 * 3 enum, 10 opaque**, of which the only ones carrying a `Namespace="…"` attribute belong to the
 * committed MIT library TcDynCollections. Everything else is the sample's own types plus TwinCAT's
 * base types (PlcAppSystemInfo, PlcTaskSystemInfo, ST_LibVersion).
 *
 * That is *not* a weaker fixture than a vendor library, because of how the harness builds its
 * workspace: buildWorkspace() indexes only two synthetic documents (MAIN and ST_Local) in a temp
 * directory, so `FB_Cylinder`, `ST_StationStatus`, `E_StationState` and friends are present in the
 * index **solely** as `.tmc`-derived external nodes — the very code path under test. What is asserted
 * is the type system's *shape* (struct fields with real types, enum members, FB methods with return
 * types and parameters, `<ArrayInfo>` and `ReferenceTo` round-trips, the `<ExtendsType>` chain), which
 * is exactly what the old customer assertions checked.
 *
 * One shape did NOT survive the move and cannot be faked: the sample's `.tmc` contains **zero
 * `ItemType` attributes**, because no FB in it declares a top-level `VAR_INPUT`/`VAR_OUTPUT` for XAE
 * to mark. The old "an FB's call parameters keep their direction" assertion is therefore gone; the
 * surviving half of that rule — an unmarked *method parameter* is an input — is asserted in §1.
 *
 * Fixtures: the sample project, its `.tmc` and the MIT archive are all committed, so this harness
 * runs identically on a developer machine and on CI. Nothing here is gated on the git-ignored
 * Beckhoff archives.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideCompletions, provideDiagnostics, setDiagnosticsConfig } = require('../src/lsp/features');
const { resolveSymbolType, lookupMember, typeFromNode, parseTypeString, isAssignable } = require('../src/lsp/types');
const { getLibraryType, getTypeSystemNamespaceTypes, getNamespaceSymbols } = require('../src/lsp/libsymbols');
const {
    SAMPLE_DIR,
    MIT_NAMESPACE,
    indexSampleLibraries,
    printBaselineMode,
    syncDocument,
    walkTwinCatFiles
} = require('./_baseline');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ---------------------------------------------------------------------------------------------
// Skip cleanly without the sample project or its `.tmc`. Both are committed, so neither absence is
// a normal state — it means the working copy was pruned by hand — but there is nothing to assert
// without a type system, and a fatal crash would say less than a named skip.
// ---------------------------------------------------------------------------------------------

/** True when a `.tmc` exists anywhere under the sample project. */
function hasTmc(dir, depth = 0) {
    if (depth > 4 || !fs.existsSync(dir)) return false;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (e.name.toLowerCase() === '_libraries') continue;
            if (hasTmc(path.join(dir, e.name), depth + 1)) return true;
        } else if (/\.tmc$/i.test(e.name)) {
            return true;
        }
    }
    return false;
}

if (!fs.existsSync(SAMPLE_DIR) || !hasTmc(SAMPLE_DIR)) {
    console.log('\n=== LIBRARY TYPES ===');
    console.log('  skip  sample/ or its .tmc is not present — no type system to harvest.');
    console.log('\n--- LIBRARY TYPE TESTS SKIPPED ---');
    process.exit(0);
}

const modeInfo = indexSampleLibraries(SAMPLE_DIR);
printBaselineMode(modeInfo);

// ---------------------------------------------------------------------------------------------
// A synthetic document that uses the library types, in the workspace of the real library index.
// ---------------------------------------------------------------------------------------------

let uid = 0;
const guid = () => `{00000000-0000-0000-0000-${String(++uid).padStart(12, '0')}}`;

const tcpou = (name, decl, impl) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="${name}" Id="${guid()}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${impl || ''}]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;

const tcdut = (name, decl) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <DUT Name="${name}" Id="${guid()}">
    <Declaration><![CDATA[${decl}]]></Declaration>
  </DUT>
</TcPlcObject>`;

// A project struct, so the "still flags a real absence" assertion has something honest to flag.
const ST_LOCAL_XML = tcdut('ST_Local', 'TYPE ST_Local :\nSTRUCT\n\tnSpeed : INT;\n\tbReady : BOOL;\nEND_STRUCT\nEND_TYPE');

// Every caret under test lives in this one POU. Two declarations are deliberate:
//   `fbMap : TcDynCollections.FB_Hash_Map` — a name the committed MIT archive's string table has but
//     the `.tmc` describes with no <DataType> block at all: the "known name, unknown shape" case;
//   `hIdent : T_Ident` — a name the `.tmc` DOES carry, as an `opaque` block (it is an alias). Same
//     empty answer, reached down a different branch.
// The rest are the sample's own `.tmc` types; in this workspace they exist only as external nodes
// (buildWorkspace indexes no sample file), so every caret below exercises the library path.
const MAIN_DECL = [
    'PROGRAM MAIN',
    'VAR',
    '\tstErr : TcDynCollections.ST_ERROR;',    // qualified — how TwinCAT code names a library type
    '\tfbCyl : FB_Cylinder;',                  // bare
    '\tstStation : ST_StationStatus;',
    '\tstRecipe : ST_Recipe;',
    '\tfbMap : TcDynCollections.FB_Hash_Map;', // in the archive, NOT in the .tmc
    '\thIdent : T_Ident;',                     // in the .tmc, but opaque
    '\tstLocal : ST_Local;',                   // a project struct
    '\tstApp : PlcAppSystemInfo;',
    '\teState : E_StationState;',
    '\tnCount : INT;',
    'END_VAR'
].join('\n');

const MAIN_IMPL = [
    'nCount := stStation.NoSuchField;',    // absent on a LIBRARY type  -> must stay silent
    'nCount := stLocal.NoSuchField;',      // absent on a PROJECT type  -> must still be flagged
    'nCount := stStation.eState;',         // present on a library type -> silent
    'fbCyl(NoSuchParam := 1);',            // named arg on a library FB -> never flagged
    'stStation.',
    'fbCyl.',
    'stRecipe.',
    'stErr.',
    'fbMap.',
    'hIdent.',
    'FB_Cylinder.',
    'FB_Station.',
    'FB_StationDerived.',
    'I_Station.',
    'ST_StationStatus.',
    'ST_Status.',
    'ST_Recipe.',
    'U_Word.',
    'E_StationState.',
    'PlcAppSystemInfo.',
    'stLocal.'
].join('\n');

const MAIN_XML = tcpou('MAIN', MAIN_DECL, MAIN_IMPL);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml_libtypes_'));
const uriOf = (f) => 'file:///' + path.join(dir, f).replace(/\\/g, '/').replace(/^\//, '');
const MAIN_URI = uriOf('MAIN.TcPOU');

/** Builds the workspace index the way server.js does, and returns the active unit's ST. */
function buildWorkspace() {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    indexXmlObject(index, ST_LOCAL_XML, uriOf('ST_Local.TcDUT'));
    indexXmlObject(index, MAIN_XML, MAIN_URI);
    const { stText } = convertXmlToSt(parseTwinCatXml(MAIN_XML), { raw: true });
    syncDocument(index, stText, MAIN_URI);   // parseAndIndexDocument + registerLibrarySymbolNodes
    return { index, stText };
}

/** Completions with the caret immediately behind the first occurrence of `marker`. */
function completionsAt(marker) {
    const { index, stText } = buildWorkspace();
    const lines = stText.split('\n');
    const line = lines.findIndex(l => l.trim() === marker || l.includes(marker));
    if (line === -1) throw new Error(`test bug: no ST line contains "${marker}"`);
    const character = lines[line].indexOf(marker) + marker.length;
    return provideCompletions(stText, { line, character }, index, MAIN_URI) || [];
}

const labels = (items) => items.map(i => i.label);
const has = (items, label) => labels(items).some(l => l.toLowerCase() === String(label).toLowerCase());
const detailOf = (items, label) => (items.find(i => i.label.toLowerCase() === label.toLowerCase()) || {}).detail;

const counts = {};
const record = (name, items) => { counts[name] = items.length; return items; };

try {
    // ---- 1. The .tmc harvest carries real structure ---------------------------------------------
    console.log('=== 1. `.tmc` type structure ===');

    const info = getLibraryType('PlcAppSystemInfo');
    assert(!!info && info.kind === 'struct',
        `PlcAppSystemInfo is harvested as a struct (${info ? info.kind : 'MISSING'})`);
    // The brief's verified example — names AND types, not just names.
    const first5 = (info ? info.members.slice(0, 5) : []).map(m => `${m.name} : ${m.type}`);
    assert(first5.join(', ') === 'ObjId : OTCID, TaskCnt : UDINT, OnlineChangeCnt : UDINT, ' +
        'Flags : DWORD, AdsPort : UINT',
        `its members carry real field names and field types (${first5.join(', ')})`);

    // The namespace attribution: the one `Namespace="…"` spelling this `.tmc` uses is the committed
    // MIT library's, and it must land on the type it tags and on nothing else.
    const err = getLibraryType('ST_ERROR');
    assert(!!err && err.kind === 'struct' && err.namespace === MIT_NAMESPACE,
        `ST_ERROR is a struct of ${MIT_NAMESPACE} (${err ? err.kind + '/' + err.namespace : 'MISSING'})`);
    assert(err.members.map(m => `${m.name} : ${m.type}`).join(', ') ===
        'nCODE : DINT, bSTATUS : BOOL, sSOURCE : STRING(80)',
        `…with its real fields (${err.members.map(m => `${m.name} : ${m.type}`).join(', ')})`);
    const cyl = getLibraryType('FB_Cylinder');
    assert(!!cyl && cyl.kind === 'fb' && cyl.namespace === '',
        `FB_Cylinder is an FB, and carries no namespace — the .tmc tags only library types ` +
        `(${cyl ? cyl.kind + '/"' + cyl.namespace + '"' : 'MISSING'})`);

    // Methods, with their return types. These are what the archives cannot give at all.
    const cylMethods = cyl.methods.map(m => `${m.name} : ${m.returnType || 'VOID'}`);
    assert(cylMethods.includes('Extend : BOOL') && cylMethods.includes('Retract : BOOL') &&
        cylMethods.includes('Cyclic : VOID'),
        `an FB's <Method> blocks are harvested with their return types (${cylMethods.join(', ')})`);
    // A property is exported as its accessor methods (`__get<Name>` / `__set<Name>`); FB_init is not
    // exported at all. Both are the type system's shape, not ours — assert what it really says.
    assert(cylMethods.some(m => /^__getbIsExtended\b/.test(m)) &&
        cylMethods.some(m => /^__getbIsRetracted\b/.test(m)) &&
        !cyl.methods.some(m => m.name === 'FB_init'),
        'a property arrives as its __get/__set accessors, and FB_init is not exported');

    // The half of the ItemType rule that survives this sample: a method parameter carries no
    // ItemType here (the file has none at all), and an unmarked *parameter* is an input — unlike an
    // unmarked SubItem, which is a plain field with no scope.
    const setState = getLibraryType('FB_Station').methods.find(m => m.name === '__setState');
    assert(!!setState && setState.params.length === 1 &&
        setState.params[0].name === 'State' && setState.params[0].type === 'E_StationState' &&
        setState.params[0].scope === 'VAR_INPUT',
        `an unmarked method parameter is an INPUT (${setState ? JSON.stringify(setState.params) : 'MISSING'})`);
    assert(getLibraryType('ST_Status').members.every(m => !m.scope),
        'while an unmarked struct field stays scope-less');

    // Interfaces resolve to a concrete kind through their methods alone (no fields to go on).
    const itf = getLibraryType('I_Station');
    assert(!!itf && itf.kind === 'fb' && itf.methods.map(m => m.name).includes('Execute'),
        `an interface resolves through its methods rather than staying anonymous ` +
        `(${itf ? itf.kind + ', ' + itf.methods.length + ' methods' : 'MISSING'})`);

    const state = getLibraryType('E_StationState');
    assert(!!state && state.kind === 'enum' && state.members.every(m => m.scope === 'ENUM') &&
        state.members.map(m => m.name).join(',') === 'Idle,Running,Error,Done',
        `E_StationState is an enum of exactly its four values ` +
        `(${state ? state.members.map(m => m.name).join(',') : 'MISSING'})`);

    // `<ArrayInfo>` -> a real ARRAY declaration type, with the declared lower bound preserved.
    const steps = getLibraryType('ST_Recipe').members.find(m => m.name === 'aSteps');
    assert(!!steps && steps.type === 'ARRAY [1..8] OF INT',
        `<ArrayInfo> becomes a real ARRAY type (aSteps : ${steps ? steps.type : 'MISSING'})`);
    const bytes = getLibraryType('U_Word').members.find(m => m.name === 'aBytes');
    assert(!!bytes && bytes.type === 'ARRAY [0..1] OF BYTE',
        `…and a 0-based bound is not normalised away (aBytes : ${bytes ? bytes.type : 'MISSING'})`);

    // `ReferenceTo="true"` -> the ST wrapper, which is what the old MC_Power `Axis : REFERENCE TO
    // AXIS_REF` assertion covered.
    const refCyl = getLibraryType('FB_Station').members.find(m => m.name === 'refCylinder');
    assert(!!refCyl && refCyl.type === 'REFERENCE TO FB_Cylinder',
        `ReferenceTo="true" becomes the ST wrapper (refCylinder : ${refCyl ? refCyl.type : 'MISSING'})`);

    // `<ExtendsType>` — the chain types.js and features.js walk. Note I_Resettable's base is
    // `<ExtendsType GUID="…">PVOID</ExtendsType>`, an implementation detail rather than a real base,
    // and it is correctly not carried through.
    assert(getLibraryType('ST_StationStatus').extendsType === 'ST_Status' &&
        getLibraryType('FB_StationDerived').extendsType === 'FB_Station' &&
        getLibraryType('I_Station').extendsType === 'I_Resettable',
        '<ExtendsType> is carried for structs, FBs and interfaces alike');

    // A library symbol the .tmc says nothing about keeps its old, shapeless self…
    assert(getLibraryType('FB_Hash_Map') === undefined,
        'FB_Hash_Map is in the MIT archive but not the .tmc — no structure is invented for it');
    // …and so does one the .tmc mentions without describing (an alias has no members to offer).
    const ident = getLibraryType('T_Ident');
    assert(!!ident && ident.kind === 'opaque' && ident.members.length === 0,
        `an alias is 'opaque' — named, but with nothing to offer (${ident ? ident.kind : 'MISSING'})`);

    // ---- 2. Member completion on library types --------------------------------------------------
    console.log('\n=== 2. member completion ===');

    const cCyl = record('FB_Cylinder.', completionsAt('FB_Cylinder.'));
    assert(has(cCyl, 'Extend') && has(cCyl, 'Retract') && has(cCyl, 'Cyclic') &&
        has(cCyl, 'refExtendOut') && has(cCyl, '_bExtended'),
        `FB_Cylinder.▮ completes with its methods AND its fields (${cCyl.length} items)`);
    assert(/Method\s*:\s*BOOL/.test(detailOf(cCyl, 'Extend') || '') &&
        /REFERENCE TO BOOL/.test(detailOf(cCyl, 'refExtendOut') || ''),
        `…each labelled with what it is (Extend -> "${detailOf(cCyl, 'Extend')}", ` +
        `refExtendOut -> "${detailOf(cCyl, 'refExtendOut')}")`);

    const cStatus = record('ST_Status.', completionsAt('ST_Status.'));
    assert(cStatus.length === 4 && has(cStatus, 'bBusy') && has(cStatus, 'bDone') &&
        has(cStatus, 'bError') && has(cStatus, 'nErrorId'),
        `ST_Status.▮ completes with its real fields (${cStatus.length} items)`);

    const cApp = record('PlcAppSystemInfo.', completionsAt('PlcAppSystemInfo.'));
    assert(cApp.length === 19 && has(cApp, 'ProjectName') && has(cApp, 'TaskCnt'),
        `PlcAppSystemInfo.▮ completes with its 19 fields (${cApp.length} items)`);

    const cRecipe = record('ST_Recipe.', completionsAt('ST_Recipe.'));
    assert(/ARRAY \[1\.\.8\] OF INT/.test(detailOf(cRecipe, 'aSteps') || ''),
        `an ARRAY field reaches the caret as its declaration type (aSteps -> "${detailOf(cRecipe, 'aSteps')}")`);

    const cEnum = record('E_StationState.', completionsAt('E_StationState.'));
    assert(cEnum.length === 4 && has(cEnum, 'Idle') && has(cEnum, 'Running') &&
        has(cEnum, 'Error') && has(cEnum, 'Done'),
        `E_StationState.▮ completes with its enum members (${cEnum.length} items)`);
    assert(cEnum.every(i => i.kind === 20),
        'every one of them is an EnumMember item, not a field');

    // The <ExtendsType> walk, through completion: a derived FB offers its base's methods, attributed
    // to the type that declares them. It only reaches the base because this document names
    // `FB_Station` too — an inherited type is registered on demand like any other library symbol.
    const cDerived = record('FB_StationDerived.', completionsAt('FB_StationDerived.'));
    assert(has(cDerived, '_nCycles') && has(cDerived, 'Execute') && has(cDerived, 'Reset'),
        `FB_StationDerived.▮ offers FB_Station's inherited methods (${cDerived.length} items)`);
    assert(/of FB_Station\b/.test(detailOf(cDerived, 'Execute') || ''),
        `…credited to the type that declares them (Execute -> "${detailOf(cDerived, 'Execute')}")`);

    // An interface completes with its methods, which is the only thing it has.
    const cItf = record('I_Station.', completionsAt('I_Station.'));
    assert(has(cItf, 'Execute') && cItf.every(i => i.kind === 2),
        `I_Station.▮ offers its methods and nothing else (${cItf.length} items)`);

    // A struct's *inherited* fields are deliberately NOT merged into the completion list — the
    // ExtendsType walk in libraryTypeMembers covers methods only. The type model does follow the
    // chain (see §4, where lookupMember resolves ST_Status's `bBusy` through ST_StationStatus), so
    // this is a completion gap, not a broken chain. Asserted as it behaves, so a future fix moves it.
    const cStation = record('ST_StationStatus.', completionsAt('ST_StationStatus.'));
    assert(has(cStation, 'eState') && has(cStation, 'sName') && !has(cStation, 'bBusy'),
        `ST_StationStatus.▮ offers its own fields; inherited ones are not merged (${cStation.length} items)`);

    // Through an *instance*, and through a namespace-qualified declaration — how real code writes it.
    const cInst = record('stErr. (instance)', completionsAt('stErr.'));
    assert(has(cInst, 'nCODE') && has(cInst, 'sSOURCE'),
        `an instance of a qualified library type completes too (stErr : ${MIT_NAMESPACE}.ST_ERROR, ` +
        `${cInst.length} items)`);
    const cInstFb = record('fbCyl. (instance)', completionsAt('fbCyl.'));
    assert(has(cInstFb, 'Extend') && has(cInstFb, 'refRetractOut'),
        `…and an instance of a library FB (${cInstFb.length} items)`);
    const cInstStruct = record('stStation. (instance)', completionsAt('stStation.'));
    assert(has(cInstStruct, 'eState'), `…and of a bare library struct (${cInstStruct.length} items)`);

    // The unknown-shape case, twice: a name we know with no .tmc block at all, and a name the .tmc
    // carries as opaque. Nothing, and no crash, down both branches.
    let survived = true;
    let cMap = [];
    let cIdent = [];
    try {
        cMap = record('fbMap. (no .tmc block)', completionsAt('fbMap.'));
        cIdent = record('hIdent. (opaque)', completionsAt('hIdent.'));
    } catch (e) {
        survived = false;
        console.error('   threw: ' + e.stack);
    }
    assert(survived && cMap.length === 0,
        `FB_Hash_Map has no .tmc entry: fbMap.▮ offers nothing and does not crash (${cMap.length} items)`);
    assert(survived && cIdent.length === 0,
        `T_Ident is opaque: hIdent.▮ offers nothing rather than guessing (${cIdent.length} items)`);

    // The project's own types are untouched by all of this.
    const cLocal = record('stLocal. (project)', completionsAt('stLocal.'));
    assert(cLocal.length === 2 && has(cLocal, 'nSpeed') && has(cLocal, 'bReady'),
        `a project struct still completes from its own node (${cLocal.length} items)`);

    // ---- 3. Namespace-qualified caret: the .tmc's real types rank first --------------------------
    console.log(`\n=== 3. \`${MIT_NAMESPACE}.▮\` ranking ===`);

    const nsSymbols = getNamespaceSymbols(MIT_NAMESPACE);
    const nsTypes = getTypeSystemNamespaceTypes(MIT_NAMESPACE);
    // Only a type with a *shape* can be ranked: an `opaque` block (alias, GVL) has no kind to show,
    // so it stays an ordinary "Library Symbol" item. Measured 2026-07-20: this namespace's 4 .tmc
    // types are ST_ERROR (struct) plus three opaque ones (T_Error, GVL_Constants, GVL_Errors), so 1
    // is rankable. Deriving the expected number rather than hard-coding 1 keeps the assertion honest
    // if the MIT library's exported shape ever changes.
    const rankable = nsTypes.filter(t => t.kind !== 'opaque');
    const cNs = record(`${MIT_NAMESPACE}.`, completionsAt(`stErr : ${MIT_NAMESPACE}.`));
    const ranked = cNs.filter(i => i.sortText);
    console.log(`    ${MIT_NAMESPACE}.▮ -> ${cNs.length} items (${ranked.length} of them structured ` +
        `.tmc types, ranked first; ${nsTypes.length} .tmc types in all, ${nsSymbols.length} raw names)`);
    assert(ranked.length === rankable.length && ranked.length > 0,
        `every structured .tmc type of the namespace is ranked first (${ranked.length})`);
    assert(has(cNs, 'ST_ERROR') && /Struct/.test(detailOf(cNs, 'ST_ERROR') || ''),
        `and carries its true kind (ST_ERROR -> "${detailOf(cNs, 'ST_ERROR')}")`);
    // Ranking, not filtering: the .tmc only exports what the project already uses, so dropping the
    // rest would hide every library type the project has not adopted yet — here, all but one of them.
    assert(cNs.length > ranked.length && has(cNs, 'FB_Hash_Map'),
        `the string-table names are kept, not filtered away (${cNs.length - ranked.length} of them)`);

    // ---- 4. Conservatism: rich completion, silent diagnostics ------------------------------------
    console.log('\n=== 4. member checking stays conservative ===');

    const { index, stText } = buildWorkspace();

    // The type model itself: a library type is now concrete (so completion can use it) but every
    // answer about it is hedged.
    const libNode = index['ST_StationStatus'];
    assert(!!libNode && libNode.external === true && libNode.membersComplete === false,
        'a .tmc-structured node is external AND declares its member list incomplete');
    const libType = typeFromNode(libNode);
    assert(libType.kind === 'struct' && libType.external === true,
        `typeFromNode gives it a concrete kind, tagged external (${libType.kind}/${libType.external})`);
    assert(lookupMember(libType, 'eState', index).kind === 'enum',
        'a member it knows resolves to that member\'s type');
    // The <ExtendsType> chain, in the type model: `bBusy` is declared on ST_Status, not here.
    assert(lookupMember(libType, 'bBusy', index).kind === 'elementary',
        '…and so does one it inherits through <ExtendsType>');
    assert(lookupMember(libType, 'NoSuchField', index) === undefined,
        'a member it does NOT know is "uncertain" (undefined) — never "absent" (null)');
    assert(lookupMember(typeFromNode(index['FB_Cylinder']), 'NoSuchParam', index) === undefined,
        '…the same for a library FB');
    assert(lookupMember(typeFromNode(index['E_StationState']), 'NO_SUCH_STATE', index) === undefined,
        '…and for a library enum');
    // A member type derived from a library type is tagged too, so a `.tmc` description we got wrong
    // can never become a type-mismatch diagnostic.
    assert(isAssignable(parseTypeString('ST_Local', index), libType) === 'ok',
        'isAssignable never flags a library type, whatever it is compared against');

    // The guard against over-suppression: a project struct must still say "definitely absent".
    const projType = resolveSymbolType('stLocal', { pou: index['MAIN'] }, index);
    assert(projType.kind === 'struct' && !projType.external,
        `a project struct is still a plain struct (${projType.kind})`);
    assert(lookupMember(projType, 'NoSuchField', index) === null,
        'and an absent member on it is still "definitely absent" (null) — no over-suppression');

    // End to end, through provideDiagnostics.
    setDiagnosticsConfig({ memberAccess: true, callArguments: true, declarationTypes: true, typeCompatibility: true });
    const diags = provideDiagnostics(stText, index, MAIN_URI);
    setDiagnosticsConfig({ memberAccess: true, callArguments: true, declarationTypes: false, typeCompatibility: true });

    const messages = diags.map(d => d.message);
    assert(!messages.some(m => /not a member of type "ST_StationStatus"/.test(m)),
        '`stStation.NoSuchField` produces NO diagnostic — the library type is uncertain, not absent');
    assert(!messages.some(m => /NoSuchParam/.test(m)),
        '`fbCyl(NoSuchParam := 1)` produces NO diagnostic — a library FB\'s parameters are partial');
    assert(messages.some(m => /"NoSuchField" is not a member of type "ST_Local"/.test(m)),
        '`stLocal.NoSuchField` IS still flagged — the project type is fully known');
    assert(diags.length === 1,
        `exactly one diagnostic on the probe, and it is the honest one (${diags.length}: ` +
        `${messages.join(' | ') || 'none'})`);

    // ---- 5. THE GATE: the sample stays at 0, in all three configs --------------------------------
    console.log('\n=== 5. sample project: 0 diagnostics in every config ===');

    const CONFIGS = [
        ['default', {}],
        ['declarationTypes:true', { declarationTypes: true }],
        ['typeCompatibility:true', { typeCompatibility: true }]
    ];
    const BASE = { memberAccess: true, callArguments: true, declarationTypes: false, typeCompatibility: true };

    const files = walkTwinCatFiles(SAMPLE_DIR);
    clearWorkspaceIndex();
    const sampleIndex = getWorkspaceSymbolIndex();
    const converted = [];
    for (const file of files) {
        const xml = fs.readFileSync(file, 'utf8');
        const parsed = parseTwinCatXml(xml);
        if (!parsed) continue;
        const fileUri = 'file:///' + file.replace(/\\/g, '/').replace(/^\//, '');
        converted.push({ file, fileUri, stText: convertXmlToSt(parsed, { raw: true }).stText });
        indexXmlObject(sampleIndex, xml, fileUri);
    }

    for (const [label, cfg] of CONFIGS) {
        setDiagnosticsConfig(Object.assign({}, BASE, cfg));
        let total = 0;
        const worst = [];
        for (const c of converted) {
            syncDocument(sampleIndex, c.stText, c.fileUri);
            const d = provideDiagnostics(c.stText, sampleIndex, c.fileUri);
            if (d.length) {
                total += d.length;
                worst.push(`${path.relative(SAMPLE_DIR, c.file)}: ${d.map(x => x.message).join(' | ')}`);
            }
        }
        assert(total === modeInfo.baseline,
            `${label.padEnd(23)} -> ${total} diagnostics across ${converted.length} files ` +
            `(baseline ${modeInfo.baseline}, mode ${modeInfo.mode})`);
        worst.slice(0, 5).forEach(w => console.error(`        ${w}`));
    }
    setDiagnosticsConfig(BASE);

    // ---- 6. Cost -------------------------------------------------------------------------------
    console.log('\n=== 6. cost ===');
    console.log(`    indexing: ${modeInfo.ms} ms (archives + .tmc structure), ` +
        `${modeInfo.symbols} symbols, ${modeInfo.tmcFiles} .tmc file(s)`);

    // Only provideCompletions is timed — that is what runs per keystroke. The .tmc structure is
    // parsed once, at index time; a member caret must be a node lookup and a list build, no more.
    const ws = buildWorkspace();
    const wsLines = ws.stText.split('\n');
    const MEMBER_CARET = 'stStation.';
    const memberLine = wsLines.findIndex(l => l.trim() === MEMBER_CARET);
    const N = 50;
    const started = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
        provideCompletions(ws.stText, { line: memberLine, character: MEMBER_CARET.length }, ws.index, MAIN_URI);
    }
    const perCall = Number(process.hrtime.bigint() - started) / 1e6 / N;
    console.log(`    completion: ${perCall.toFixed(2)} ms/call at a member caret ` +
        `(${MEMBER_CARET}▮, ${cInstStruct.length} items)`);
    assert(perCall < 25, `a member caret stays well inside a keystroke's budget (${perCall.toFixed(2)} ms)`);

    console.log('\n=== suggestion counts per caret ===');
    Object.keys(counts).forEach(k => console.log(`    ${k.padEnd(24)} ${counts[k]}`));

} catch (e) {
    console.error(`[FATAL] ${e.stack}`);
    errors++;
} finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir: ignore */ }
}

console.log(`\n--- LIBRARY TYPE TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
