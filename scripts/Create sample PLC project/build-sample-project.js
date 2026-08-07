/**
 * @file build-sample-project.js
 * @description Fills the XAE-authored TwinCAT sample project with the synthetic objects used as
 * GROUND TRUTH by the sample-based harnesses (test/test_sample_diagnostics.js, test/test_typecheck.js, …).
 *
 * **This script no longer creates a project — it populates one.** It used to emit the 19 objects plus a
 * hand-written `.plcproj`, and XAE Shell refused to open the result: a TwinCAT PLC project is not a
 * standalone `.plcproj`. It needs a solution (`.sln`), a system project (`.tsproj`), the `_Config`
 * XTI/XTV instance files and the identity GUIDs (`Application`, `TypeSystem`, `Implicit_*`,
 * `LibraryReferences`) that tie them together — none of which can be synthesized convincingly.
 *
 * So the skeleton is generated ONCE, by XAE itself, via `scripts/build-sample-solution.ps1`, and is
 * committed. This script writes only what is genuinely ours — the objects and their project
 * registration — into `TcSample/TcSample_PLC/`. Everything XAE owns
 * (`.sln`, `.tsproj`, `_Config/`, `PlcTask.TcTTO`, `_Libraries/`, and the whole of the `.plcproj`
 * except the two ItemGroups below) is left strictly alone: regenerating any of it is what broke this
 * before.
 *
 * The objects it writes are *correct* TwinCAT code, so every diagnostic the extension reports on them
 * is a bug — that is the whole premise of the ratchet. They are generated rather than hand-maintained
 * for three reasons:
 *
 *   1. **Determinism.** Running this twice produces byte-identical output, so a regenerated sample
 *      never shows up as a spurious diff. Every `Id="{…}"` GUID is *derived* (SHA-1 of a stable key)
 *      rather than randomly generated — `crypto.randomUUID()` would churn every id on every run.
 *   2. **Canonical shape.** TwinCAT's XML loader is ORDER-SENSITIVE inside `<POU>`/`<Itf>`:
 *      Declaration → Implementation → Folder(s) → members → LineIds. A misplaced `<Folder>` once made
 *      XAE drop an FB's members from compile entirely (C0004 per member). The emitter below enforces
 *      that order structurally, so a fixture cannot drift out of it. `test/test_xml_folderpath.js`
 *      asserts the same invariant on the edit path.
 *   3. **Provenance.** The sample it replaces was a real customer project. Nothing here is derived
 *      from one: it is a neutral sorting-station demo.
 *
 * Fidelity details that harnesses depend on, and that are therefore not negotiable:
 *   - OBJECT files are UTF-8 **with a BOM** and use **CRLF** line endings, exactly as TwinCAT writes
 *     them. The `.plcproj` is NOT written that way — XAE wrote it without a BOM and without a
 *     trailing newline, and it is round-tripped verbatim rather than re-emitted (see injectItems);
 *   - every generated object appears in the `.plcproj` as `<Compile Include="relative\path">`
 *     (`src/lsp/xmlIndexer.js collectPlcProjObjectPaths` gates indexing on it, and
 *     `test/test_plcproj_scope.js` asserts every on-disk object is `<Compile>`d);
 *   - `<LineIds>` blocks are emitted for every block that carries an `<Implementation>` — the POU
 *     root, methods, actions, transitions, and a property's Get/Set accessors. That is where real
 *     TwinCAT writes them: a DUT, a GVL and an interface method have no implementation and so carry
 *     none.
 *
 * Usage:
 *   node Scripts/build-sample-project.js                   # clone TcSample -> TcSample_N, fill the clone
 *   node Scripts/build-sample-project.js <plcProjectRoot>  # fill that project IN PLACE (destructive)
 *
 * With no argument nothing that already exists is touched: the committed skeleton is cloned into the
 * next free sibling directory under the repo root (`TcSample`, then `TcSample_1`, `TcSample_2`, …) and
 * the COPY is filled. Pass a `<plcProjectRoot>` — the directory holding a `.plcproj` — to regenerate
 * that project's objects in place instead. That is the destructive path, and it stays opt-in.
 *
 * Filling is idempotent either way: object GUIDs are derived, so re-running over the same project
 * leaves the tree byte-identical, and the `.plcproj` injection adds nothing on a second pass.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Namespace for the derived GUIDs. Changing it re-ids the whole project — don't, casually. */
const GUID_NAMESPACE = 'TcToolkitSample';

/** TwinCAT file-format stamps, copied from the objects the extension itself writes. */
const TCPLCOBJECT_VERSION = '1.1.0.1';
const PRODUCT_VERSION = '3.1.4024.12';

/**
 * Derives a stable GUID from a key. Deterministic by construction: the same key always yields the
 * same GUID, so re-running the generator cannot churn ids. The RFC 4122 version/variant nibbles are
 * forced so the value has the shape TwinCAT (and `regenerateObjectIdsInXml`'s
 * `Id="{8-4-4-4-12}"` regex) expects.
 * @param {string} key Stable identity of the element, e.g. 'FB_Station/Method/Cyclic'.
 * @returns {string} A brace-wrapped GUID, e.g. '{2f9a…-…-…-…-…}'.
 */
function guid(key) {
    const hex = crypto.createHash('sha1').update(`${GUID_NAMESPACE}|${key}`).digest('hex').slice(0, 32);
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const v = hex.slice(0, 12) + '4' + hex.slice(13, 16) + variant + hex.slice(17, 32);
    return `{${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}}`;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// The project spec
//
// A neutral sorting-station demo: cylinders as actuators, a station that drives one, a derived
// station that overrides its cycle, two programs, a scaling function, three GVLs and seven DUTs.
// Bodies are real code that uses the declared variables — the parser and the type checker need
// something to chew on, and an empty stub would prove nothing.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} MemberSpec
 * @property {'Method'|'Property'|'Action'|'Transition'} kind
 * @property {string} name
 * @property {string} [folderPath] Virtual folder path with a trailing backslash, e.g. 'Actions\\'.
 * @property {string} [declaration] Declaration CDATA (Method/Property).
 * @property {string} [implementation] Implementation CDATA (Method/Action/Transition).
 * @property {{declaration?: string, implementation?: string}} [get] Property Get accessor.
 * @property {{declaration?: string, implementation?: string}} [set] Property Set accessor.
 */

/**
 * @typedef {Object} ObjectSpec
 * @property {string} dir Directory relative to the project root, using forward slashes.
 * @property {string} file File name including extension.
 * @property {'POU'|'GVL'|'DUT'|'Itf'} root Root XML element.
 * @property {string} name Object name.
 * @property {string} declaration Root declaration CDATA.
 * @property {string} [implementation] Root implementation CDATA (POU only).
 * @property {string[]} [folders] Root-level virtual folder names.
 * @property {MemberSpec[]} [members]
 */

/** @type {ObjectSpec[]} */
const OBJECTS = [
    // ── DUTs ─────────────────────────────────────────────────────────────────────────────────────
    {
        dir: 'DUTs', file: 'E_StationState.TcDUT', root: 'DUT', name: 'E_StationState',
        declaration: [
            'TYPE E_StationState :',
            '(',
            '\tIdle := 0,',
            '\tRunning := 1,',
            '\tError := 2,',
            '\tDone := 3',
            ') DINT;',
            'END_TYPE',
            ''
        ].join('\n')
    },
    {
        dir: 'DUTs', file: 'E_Command.TcDUT', root: 'DUT', name: 'E_Command',
        declaration: [
            'TYPE E_Command :',
            '(',
            '\tNone,',
            '\tStart,',
            '\tStop,',
            '\tReset',
            ');',
            'END_TYPE',
            ''
        ].join('\n')
    },
    {
        dir: 'DUTs', file: 'ST_Status.TcDUT', root: 'DUT', name: 'ST_Status',
        declaration: [
            'TYPE ST_Status :',
            'STRUCT',
            '\tbBusy, bDone, bError\t: BOOL;',
            '\tnErrorId\t\t\t: UDINT;',
            'END_STRUCT',
            'END_TYPE',
            ''
        ].join('\n')
    },
    {
        dir: 'DUTs', file: 'ST_StationStatus.TcDUT', root: 'DUT', name: 'ST_StationStatus',
        declaration: [
            'TYPE ST_StationStatus EXTENDS ST_Status :',
            'STRUCT',
            '\teState\t: E_StationState;',
            '\tsName\t: STRING(31);',
            'END_STRUCT',
            'END_TYPE',
            ''
        ].join('\n')
    },
    {
        dir: 'DUTs', file: 'ST_Recipe.TcDUT', root: 'DUT', name: 'ST_Recipe',
        declaration: [
            'TYPE ST_Recipe :',
            'STRUCT',
            '\taSteps\t: ARRAY[1..8] OF INT;',
            '\tfSpeed\t: LREAL;',
            '\tsId\t\t: STRING(15);',
            'END_STRUCT',
            'END_TYPE',
            ''
        ].join('\n')
    },
    {
        dir: 'DUTs', file: 'U_Word.TcDUT', root: 'DUT', name: 'U_Word',
        declaration: [
            'TYPE U_Word :',
            'UNION',
            '\tnWord\t: WORD;',
            '\taBytes\t: ARRAY[0..1] OF BYTE;',
            'END_UNION',
            'END_TYPE',
            ''
        ].join('\n')
    },
    {
        dir: 'DUTs', file: 'T_Ident.TcDUT', root: 'DUT', name: 'T_Ident',
        declaration: [
            'TYPE T_Ident : STRING(31);',
            'END_TYPE',
            ''
        ].join('\n')
    },

    // ── GVLs ─────────────────────────────────────────────────────────────────────────────────────
    {
        dir: 'GVLs', file: 'GVL_Io.TcGVL', root: 'GVL', name: 'GVL_Io',
        declaration: [
            "{attribute 'qualified_only'}",
            'VAR_GLOBAL',
            '\tbExtendOut, bRetractOut, bSensorExtended, bSensorRetracted : BOOL;',
            'END_VAR',
            ''
        ].join('\n')
    },
    {
        // The declaration-site initialization list is deliberate: it is the shape that exercises
        // classifyCallSite's 'declInitList' kind and getInitParams (FB_init's VAR_INPUT), and the one
        // a NON-raw conversion silently strips — which is why the diagnostics recipe insists on raw.
        dir: 'GVLs', file: 'GVL_System.TcGVL', root: 'GVL', name: 'GVL_System',
        declaration: [
            "{attribute 'qualified_only'}",
            'VAR_GLOBAL',
            '\tfbCylinder\t: FB_Cylinder(refExtendOut := GVL_Io.bExtendOut, refRetractOut := GVL_Io.bRetractOut);',
            '\tfbStation\t: FB_Station;',
            '\tfbDerived\t: FB_StationDerived;',
            'END_VAR',
            ''
        ].join('\n')
    },
    {
        dir: 'GVLs', file: 'GVL_Hmi.TcGVL', root: 'GVL', name: 'GVL_Hmi',
        declaration: [
            "{attribute 'qualified_only'}",
            'VAR_GLOBAL',
            '\tnSpeed\t\t: INT;',
            '\tbEnable\t\t: BOOL;',
            '\tarValues\t: ARRAY[0..9] OF INT;',
            'END_VAR',
            ''
        ].join('\n')
    },

    // ── Interfaces ───────────────────────────────────────────────────────────────────────────────
    {
        dir: 'POUs/Interfaces', file: 'I_Resettable.TcIO', root: 'Itf', name: 'I_Resettable',
        declaration: 'INTERFACE I_Resettable\n',
        members: [
            { kind: 'Method', name: 'Reset', declaration: 'METHOD Reset : BOOL\n' }
        ]
    },
    {
        dir: 'POUs/Interfaces', file: 'I_Diagnosable.TcIO', root: 'Itf', name: 'I_Diagnosable',
        declaration: 'INTERFACE I_Diagnosable\n',
        members: [
            {
                kind: 'Property', name: 'ErrorId',
                declaration: 'PROPERTY ErrorId : UDINT\n',
                get: { declaration: '' }
            }
        ]
    },
    {
        // Multiple EXTENDS — the shape test_interface_multi_extends guards (nodes carry extendsAll,
        // and every EXTENDS walker traverses the DAG rather than only the first parent).
        dir: 'POUs/Interfaces', file: 'I_Station.TcIO', root: 'Itf', name: 'I_Station',
        declaration: 'INTERFACE I_Station EXTENDS I_Resettable, I_Diagnosable\n',
        members: [
            { kind: 'Method', name: 'Execute', declaration: 'METHOD Execute : BOOL\n' },
            {
                kind: 'Property', name: 'State',
                declaration: 'PROPERTY State : E_StationState\n',
                get: { declaration: '' }
            }
        ]
    },

    // ── Actuators ────────────────────────────────────────────────────────────────────────────────
    {
        dir: 'POUs/Actuators', file: 'FB_Cylinder.TcPOU', root: 'POU', name: 'FB_Cylinder',
        declaration: [
            'FUNCTION_BLOCK FB_Cylinder',
            'VAR',
            '\t_bExtended, _bRetracted\t: BOOL;',
            '\trefExtendOut\t\t\t: REFERENCE TO BOOL;',
            '\trefRetractOut\t\t\t: REFERENCE TO BOOL;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: [
            '// The cylinder is edge-free: the sensor image is refreshed every cycle and the outputs',
            '// are held by whichever of Extend()/Retract() was called last.',
            'Cyclic();'
        ].join('\n'),
        members: [
            {
                // The parameter names deliberately repeat the FB's OWN member names. That makes a
                // wrong go-to-definition answer *possible* (the live-path harness checks which of the
                // two a position resolves to), and it is also what real FB_init code looks like.
                kind: 'Method', name: 'FB_init',
                declaration: [
                    'METHOD FB_init : BOOL',
                    'VAR_INPUT',
                    '\tbInitRetains\t: BOOL;',
                    '\tbInCopyCode\t\t: BOOL;',
                    '\trefExtendOut\t: REFERENCE TO BOOL;',
                    '\trefRetractOut\t: REFERENCE TO BOOL;',
                    'END_VAR',
                    ''
                ].join('\n'),
                implementation: [
                    'THIS^.refExtendOut REF= refExtendOut;',
                    'THIS^.refRetractOut REF= refRetractOut;',
                    'FB_init := TRUE;'
                ].join('\n')
            },
            {
                kind: 'Method', name: 'Extend',
                declaration: 'METHOD Extend : BOOL\nVAR\nEND_VAR\n',
                implementation: [
                    'refExtendOut := TRUE;',
                    'refRetractOut := FALSE;',
                    'Extend := TRUE;'
                ].join('\n')
            },
            {
                kind: 'Method', name: 'Retract',
                declaration: 'METHOD Retract : BOOL\nVAR\nEND_VAR\n',
                implementation: [
                    'refExtendOut := FALSE;',
                    'refRetractOut := TRUE;',
                    'Retract := TRUE;'
                ].join('\n')
            },
            {
                kind: 'Method', name: 'Cyclic',
                declaration: 'METHOD Cyclic\nVAR\nEND_VAR\n',
                implementation: [
                    '_bExtended := GVL_Io.bSensorExtended;',
                    '_bRetracted := GVL_Io.bSensorRetracted;'
                ].join('\n')
            },
            {
                kind: 'Property', name: 'bIsExtended',
                declaration: 'PROPERTY bIsExtended : BOOL\n',
                get: { declaration: 'VAR\nEND_VAR\n', implementation: 'bIsExtended := _bExtended;' }
            },
            {
                kind: 'Property', name: 'bIsRetracted',
                declaration: 'PROPERTY bIsRetracted : BOOL\n',
                get: { declaration: 'VAR\nEND_VAR\n', implementation: 'bIsRetracted := _bRetracted;' }
            }
        ]
    },

    // ── Machine ──────────────────────────────────────────────────────────────────────────────────
    {
        dir: 'POUs/Machine', file: 'FB_Station.TcPOU', root: 'POU', name: 'FB_Station',
        declaration: [
            'FUNCTION_BLOCK FB_Station IMPLEMENTS I_Station',
            'VAR',
            '\trefCylinder\t: REFERENCE TO FB_Cylinder;',
            '\t_eState\t\t: E_StationState;',
            '\t_eCommand\t: E_Command;',
            '\t_stStatus\t: ST_StationStatus;',
            '\t_stRecipe\t: ST_Recipe;',
            '\t_uWord\t\t: U_Word;',
            '\t_sIdent\t\t: T_Ident;',
            '\t_nErrorId\t: UDINT;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: 'Cyclic();',
        folders: ['Actions'],
        members: [
            {
                kind: 'Method', name: 'Cyclic',
                declaration: 'METHOD Cyclic\nVAR\n\tbExtended\t: BOOL;\nEND_VAR\n',
                implementation: [
                    'bExtended := refCylinder.bIsExtended;',
                    '',
                    'CASE _eState OF',
                    '\tE_StationState.Idle:',
                    '\t\tIF _eCommand = E_Command.Start THEN',
                    '\t\t\t_eState := E_StationState.Running;',
                    '\t\tEND_IF',
                    '',
                    '\tE_StationState.Running:',
                    '\t\tIF bExtended THEN',
                    '\t\t\trefCylinder.Retract();',
                    '\t\tELSE',
                    '\t\t\trefCylinder.Extend();',
                    '\t\tEND_IF',
                    '\t\tIF _nErrorId <> 0 THEN',
                    '\t\t\t_eState := E_StationState.Error;',
                    '\t\tEND_IF',
                    '',
                    '\tE_StationState.Error:',
                    '\t\t_stStatus.bError := TRUE;',
                    '',
                    '\tE_StationState.Done:',
                    '\t\t_stStatus.bDone := TRUE;',
                    'END_CASE',
                    '',
                    '_stStatus.eState := _eState;',
                    '_stStatus.nErrorId := _nErrorId;',
                    '_uWord.nWord := _stRecipe.aSteps[1];'
                ].join('\n')
            },
            {
                kind: 'Method', name: 'Execute',
                declaration: 'METHOD Execute : BOOL\nVAR\nEND_VAR\n',
                implementation: [
                    'IF _eState = E_StationState.Idle THEN',
                    '\t_eCommand := E_Command.Start;',
                    '\t_stStatus.bBusy := TRUE;',
                    '\tExecute := TRUE;',
                    'ELSE',
                    '\tExecute := FALSE;',
                    'END_IF'
                ].join('\n')
            },
            {
                kind: 'Method', name: 'Reset',
                declaration: 'METHOD Reset : BOOL\nVAR\nEND_VAR\n',
                implementation: [
                    '_eState := E_StationState.Idle;',
                    '_eCommand := E_Command.None;',
                    '_nErrorId := 0;',
                    '_stStatus.bBusy := FALSE;',
                    '_stStatus.bDone := FALSE;',
                    '_stStatus.bError := FALSE;',
                    '_stStatus.nErrorId := 0;',
                    'Reset := TRUE;'
                ].join('\n')
            },
            {
                kind: 'Property', name: 'State',
                declaration: 'PROPERTY State : E_StationState\n',
                get: { declaration: 'VAR\nEND_VAR\n', implementation: 'State := _eState;' },
                set: { declaration: 'VAR\nEND_VAR\n', implementation: '_eState := State;' }
            },
            {
                kind: 'Property', name: 'ErrorId',
                declaration: 'PROPERTY ErrorId : UDINT\n',
                get: { declaration: 'VAR\nEND_VAR\n', implementation: 'ErrorId := _nErrorId;' }
            },
            {
                // The only object in the sample with a virtual folder — FolderPath on the member plus
                // the matching root <Folder> tag in its canonical slot (after the root
                // </Implementation>, before the first member).
                kind: 'Action', name: 'Act_Home', folderPath: 'Actions\\',
                implementation: [
                    'refCylinder REF= GVL_System.fbCylinder;',
                    'refCylinder.Retract();',
                    '_eState := E_StationState.Idle;',
                    '_sIdent := \'STATION-01\';'
                ].join('\n')
            }
            // No Transition object here on purpose. XAE only permits transitions on SFC POUs, and this
            // FB is ST-implemented — a transition would be valid XML that the XAE UI would not
            // round-trip, undermining the point of validating the sample by building it. The toolkit's
            // transition handling is covered by synthetic fixtures instead (test_xml_rename.js).
        ]
    },
    {
        dir: 'POUs/Machine', file: 'FB_StationDerived.TcPOU', root: 'POU', name: 'FB_StationDerived',
        declaration: [
            'FUNCTION_BLOCK FB_StationDerived EXTENDS FB_Station',
            'VAR',
            '\t_nCycles\t: UDINT;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: 'Cyclic();',
        members: [
            {
                // An override — the shape the references / pousRelated relaxation paths need.
                kind: 'Method', name: 'Cyclic',
                declaration: 'METHOD Cyclic\nVAR\nEND_VAR\n',
                implementation: [
                    'SUPER^.Cyclic();',
                    '_nCycles := _nCycles + 1;'
                ].join('\n')
            }
        ]
    },

    // ── Programs and functions ───────────────────────────────────────────────────────────────────
    {
        dir: 'POUs', file: 'MAIN.TcPOU', root: 'POU', name: 'MAIN',
        declaration: [
            'PROGRAM MAIN',
            'VAR',
            '\tnCycleCount\t: UDINT;',
            '\tnIdx\t\t: INT;',
            '\tfScaled\t\t: LREAL;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: [
            'nCycleCount := nCycleCount + 1;',
            '',
            'GVL_System.fbCylinder.Cyclic();',
            'GVL_System.fbStation.Cyclic();',
            'GVL_System.fbDerived.Cyclic();',
            '',
            'GVL_Hmi.bEnable := (GVL_System.fbStation.State = E_StationState.Running);',
            '',
            'fScaled := F_Scale(fValue := 5.0, fMin := 0.0, fMax := 10.0);',
            'GVL_Hmi.nSpeed := LREAL_TO_INT(fScaled * 100.0);',
            '',
            'FOR nIdx := 0 TO 9 DO',
            '\tGVL_Hmi.arValues[nIdx] := GVL_Hmi.nSpeed;',
            'END_FOR'
        ].join('\n')
    },
    {
        dir: 'POUs', file: 'P_Startup.TcPOU', root: 'POU', name: 'P_Startup',
        declaration: [
            'PROGRAM P_Startup',
            'VAR',
            '\tbDone\t: BOOL;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: [
            'IF NOT bDone THEN',
            '\tGVL_System.fbStation.Reset();',
            '\tGVL_System.fbDerived.Reset();',
            '\tGVL_Hmi.nSpeed := 50;',
            '\tbDone := TRUE;',
            'END_IF'
        ].join('\n')
    },
    {
        dir: 'POUs', file: 'F_Scale.TcPOU', root: 'POU', name: 'F_Scale',
        declaration: [
            'FUNCTION F_Scale : LREAL',
            'VAR_INPUT',
            '\tfValue, fMin, fMax\t: LREAL;',
            'END_VAR',
            'VAR',
            '\tfSpan\t: LREAL;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: [
            'fSpan := fMax - fMin;',
            '',
            'IF fSpan = 0 THEN',
            '\tF_Scale := 0;',
            'ELSE',
            '\tF_Scale := (fValue - fMin) / fSpan;',
            'END_IF'
        ].join('\n')
    }
];

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Emitters
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Wraps text in a CDATA section. Nothing in the spec may contain the CDATA terminator; a fixture
 * that did would corrupt every downstream parse, so it fails loudly rather than silently.
 * @param {string} text
 * @returns {string}
 */
function cdata(text) {
    const body = text === undefined || text === null ? '' : text;
    if (body.includes(']]>')) {
        throw new Error('spec text contains the CDATA terminator "]]>"');
    }
    return `<![CDATA[${body}]]>`;
}

/**
 * Emits an `<Implementation><ST>…</ST></Implementation>` block at a given indent.
 * @param {string} indent Leading whitespace of the `<Implementation>` line.
 * @param {string} impl Implementation text (may be empty).
 * @returns {string[]} Lines.
 */
function implementationBlock(indent, impl) {
    return [
        `${indent}<Implementation>`,
        `${indent}  <ST>${cdata(impl || '')}</ST>`,
        `${indent}</Implementation>`
    ];
}

/**
 * A LineIds counter for one file. Real TwinCAT ids are unique within the object and assigned as
 * lines are created; sequential numbering reproduces the shape without pretending to reproduce the
 * history.
 */
function createLineIdCounter() {
    let next = 1;
    return {
        /**
         * @param {string} name LineIds `Name` attribute ('Root', 'Root.Member', 'Root.Member.Get').
         * @param {string} impl The implementation text the ids stand for.
         * @returns {string[]} The `<LineIds>` block's lines, indented for a root-level child.
         */
        block(name, impl) {
            const count = Math.max(1, String(impl || '').split('\n').length);
            const lines = [`    <LineIds Name="${name}">`];
            for (let i = 0; i < count; i++) {
                lines.push(`      <LineId Id="${next++}" Count="0" />`);
            }
            lines.push('    </LineIds>');
            return lines;
        }
    };
}

/**
 * Renders one TwinCAT object to XML, in TwinCAT's canonical element order:
 * `Declaration` → `Implementation` → `Folder`(s) → members → `LineIds`.
 *
 * That order is load-bearing, not cosmetic. TwinCAT's loader is order-sensitive inside `<POU>`/
 * `<Itf>`: a root `<Folder>` placed after the members makes XAE drop every member from compile
 * (C0004 apiece) — an incident that reached a real project. Building the document section by section
 * here is what makes the order structural rather than a convention a fixture can drift out of.
 * @param {ObjectSpec} spec
 * @returns {string} XML text with LF line endings (converted to CRLF on write).
 */
function renderObject(spec) {
    const isPou = spec.root === 'POU';
    const isItf = spec.root === 'Itf';
    const lineIds = createLineIdCounter();

    const rootAttrs = [`Name="${spec.name}"`, `Id="${guid(spec.name)}"`];
    if (isPou) rootAttrs.push('SpecialFunc="None"');

    const out = [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<TcPlcObject Version="${TCPLCOBJECT_VERSION}" ProductVersion="${PRODUCT_VERSION}">`,
        `  <${spec.root} ${rootAttrs.join(' ')}>`
    ];

    // 1. Declaration.
    out.push(`    <Declaration>${cdata(spec.declaration)}</Declaration>`);

    // 2. Implementation (POUs only — a GVL, a DUT and an interface have none).
    if (isPou) {
        out.push(...implementationBlock('    ', spec.implementation));
    }

    // 3. Root virtual folders, as a contiguous group directly after the root block.
    for (const folder of spec.folders || []) {
        out.push(`    <Folder Name="${folder}" Id="${guid(`${spec.name}/Folder/${folder}`)}" />`);
    }

    // 4. Members, in spec order.
    const lineIdBlocks = [];
    if (isPou) lineIdBlocks.push(lineIds.block(spec.name, spec.implementation));

    for (const member of spec.members || []) {
        const attrs = [`Name="${member.name}"`, `Id="${guid(`${spec.name}/${member.kind}/${member.name}`)}"`];
        if (member.folderPath) attrs.push(`FolderPath="${member.folderPath}"`);
        const open = `    <${member.kind} ${attrs.join(' ')}>`;

        if (member.kind === 'Property') {
            out.push(open);
            out.push(`      <Declaration>${cdata(member.declaration)}</Declaration>`);
            for (const accessor of ['Get', 'Set']) {
                const acc = member[accessor.toLowerCase()];
                if (!acc) continue;
                const accId = guid(`${spec.name}/${member.kind}/${member.name}/${accessor}`);
                out.push(`      <${accessor} Name="${accessor}" Id="${accId}">`);
                out.push(`        <Declaration>${cdata(acc.declaration)}</Declaration>`);
                // An interface's accessors are signatures only: no implementation, no LineIds.
                if (!isItf) {
                    out.push(...implementationBlock('        ', acc.implementation));
                    lineIdBlocks.push(lineIds.block(`${spec.name}.${member.name}.${accessor}`, acc.implementation));
                }
                out.push(`      </${accessor}>`);
            }
            out.push(`    </${member.kind}>`);
            continue;
        }

        out.push(open);
        if (member.declaration !== undefined) {
            out.push(`      <Declaration>${cdata(member.declaration)}</Declaration>`);
        }
        // Interface methods are signatures only.
        if (!isItf) {
            out.push(...implementationBlock('      ', member.implementation));
            lineIdBlocks.push(lineIds.block(`${spec.name}.${member.name}`, member.implementation));
        }
        out.push(`    </${member.kind}>`);
    }

    // 5. LineIds, last — the canonical slot, and the one TwinCAT regenerates.
    for (const block of lineIdBlocks) out.push(...block);

    out.push(`  </${spec.root}>`);
    out.push('</TcPlcObject>');
    out.push('');
    return out.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// .plcproj registration
//
// The `.plcproj` is XAE's, not ours. It carries the identity GUIDs that bind the PLC project to the
// system project and its `_Config` instance files (`Application`, `TypeSystem`, `Implicit_Task_Info`,
// `Implicit_KindOfTask`, `Implicit_Jitter_Distribution`, `LibraryReferences`), the
// `<PlaceholderReference>`s that pull in Tc2_Standard / Tc2_System / Tc3_Module, and a
// `<ProjectExtensions>` options archive. Rewriting any of that is exactly what made XAE Shell refuse
// to open the old sample, so this code only ever ADDS the two kinds of item that describe OUR
// objects, and leaves every other byte untouched.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Project-relative `<Compile Include="…">` paths for every object in the spec, in spec order and
 * with TwinCAT's backslash separators.
 * @returns {string[]}
 */
function compileIncludes() {
    return OBJECTS.map(spec => `${spec.dir.replace(/\//g, '\\')}\\${spec.file}`);
}

/**
 * Project-relative `<Folder Include="…" />` paths implied by the spec — every directory the objects
 * live in, plus each of its ancestors, first-seen order.
 * @returns {string[]}
 */
function folderIncludes() {
    const folders = [];
    for (const spec of OBJECTS) {
        const parts = spec.dir.split('/');
        for (let i = 0; i < parts.length; i++) {
            const p = parts.slice(0, i + 1).join('\\');
            if (!folders.includes(p)) folders.push(p);
        }
    }
    return folders;
}

/**
 * Collects the `Include` attribute of every element with a given tag name, lower-cased. Used to make
 * the injection idempotent: MSBuild include paths are Windows paths, so they are compared
 * case-insensitively — a second run must add nothing and produce a byte-identical file.
 * @param {string} text The `.plcproj` text.
 * @param {string} tag Element name, e.g. 'Compile'.
 * @returns {Set<string>} Lower-cased include paths already present.
 */
function existingIncludes(text, tag) {
    const found = new Set();
    const re = new RegExp(`<${tag}\\s+Include="([^"]*)"`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) found.add(m[1].toLowerCase());
    return found;
}

/**
 * Inserts item elements into the `<ItemGroup>` that already holds items of that kind, immediately
 * before its closing tag.
 *
 * Slice-based, like `registerInPlcProj` in src/plcProjHelper.js — the file is reassembled from two
 * substrings and the new text, never rewritten through a computed `String.replace`, so everything
 * outside the splice point is preserved byte-for-byte. It differs from that function in one detail
 * that matters here: the splice lands at the START of the `</ItemGroup>` line rather than at the tag
 * itself, so the closing tag keeps its own indentation and the inserted lines get theirs from the
 * anchor. (Splicing at the tag leaves that line's leading whitespace in the prefix, which shifts the
 * first inserted line and strips the indent from `</ItemGroup>`.)
 *
 * @param {string} text The `.plcproj` text.
 * @param {string} tag Element name to anchor on and to insert, e.g. 'Compile'.
 * @param {string[]} includes Project-relative paths to add (already filtered for what is missing).
 * @param {(indent: string, include: string, eol: string) => string} render Emits one element.
 * @returns {string} The updated text (unchanged when `includes` is empty).
 */
function injectItems(text, tag, includes, render) {
    if (includes.length === 0) return text;

    // Anchor on an existing item of the same kind: that is what identifies the right ItemGroup (the
    // file has several) and what supplies XAE's own indentation.
    const anchor = new RegExp(`^([ \\t]*)<${tag}\\s+Include="`, 'm').exec(text);
    if (!anchor) {
        throw new Error(
            `the .plcproj has no <${tag} Include="…"> to anchor on — it does not look like the ` +
            `XAE-authored skeleton this script expects`);
    }
    const indent = anchor[1];
    const closeIdx = text.indexOf('</ItemGroup>', anchor.index);
    if (closeIdx === -1) {
        throw new Error(`the .plcproj has no </ItemGroup> closing the <${tag}> group`);
    }

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lineStart = text.lastIndexOf('\n', closeIdx) + 1;
    const addition = includes.map(inc => render(indent, inc, eol)).join('');
    return text.slice(0, lineStart) + addition + text.slice(lineStart);
}

/**
 * Registers the generated objects in the XAE-authored `.plcproj`: a `<Compile>` for every object it
 * does not already list, and a `<Folder>` for every directory it does not already declare.
 *
 * Every generated object MUST end up as a `<Compile>` item: the workspace index is scoped to the
 * project rather than to the filesystem (`collectPlcProjObjectPaths` in src/lsp/xmlIndexer.js), so an
 * object missing from here would be invisible to the language server — and `test/test_plcproj_scope.js`
 * asserts the sample has no such object.
 *
 * Idempotent by construction: entries already present are filtered out, so a second run adds nothing
 * and the file comes back byte-identical.
 * @param {string} text The current `.plcproj` text.
 * @returns {{text: string, compiles: number, folders: number}} Updated text and what was added.
 */
function registerObjectsInPlcProj(text) {
    const haveCompiles = existingIncludes(text, 'Compile');
    const haveFolders = existingIncludes(text, 'Folder');

    // MAIN.TcPOU is XAE's own default object; the skeleton already lists it. Filtering here is what
    // keeps it from being duplicated even though the spec regenerates its contents.
    const newCompiles = compileIncludes().filter(inc => !haveCompiles.has(inc.toLowerCase()));
    const newFolders = folderIncludes().filter(inc => !haveFolders.has(inc.toLowerCase()));

    let out = injectItems(text, 'Compile', newCompiles, (indent, inc, eol) =>
        `${indent}<Compile Include="${inc}">${eol}` +
        `${indent}  <SubType>Code</SubType>${eol}` +
        `${indent}</Compile>${eol}`);
    out = injectItems(out, 'Folder', newFolders, (indent, inc, eol) =>
        `${indent}<Folder Include="${inc}" />${eol}`);

    return { text: out, compiles: newCompiles.length, folders: newFolders.length };
}

/**
 * Writes text as TwinCAT writes it: UTF-8 **with a BOM**, **CRLF** line endings. Several harnesses
 * (and the LSP's own offset handling) depend on both, so this is the single place either is decided.
 * @param {string} filePath Absolute destination path.
 * @param {string} text Text with LF line endings.
 */
function writeTwinCatFile(filePath, text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const crlf = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    fs.writeFileSync(filePath, '﻿' + crlf, 'utf8');
}

/**
 * Locates the XAE-authored `.plcproj` inside the PLC project root.
 *
 * The skeleton is deliberately NOT synthesized when it is absent. A convincing one cannot be written
 * by hand — that is the whole reason this script stopped emitting its own `.plcproj` — so a missing
 * skeleton is a setup step the user has to run, not a gap to paper over.
 * @param {string} root PLC project root (the directory holding the `.plcproj`).
 * @returns {string} Absolute path to the `.plcproj`.
 */
function findPlcProj(root) {
    const entries = fs.existsSync(root)
        ? fs.readdirSync(root).filter(f => f.toLowerCase().endsWith('.plcproj')).sort()
        : [];
    if (entries.length === 0) {
        throw new Error(
            `no .plcproj found in ${root}\n\n` +
            `This script FILLS an XAE-created PLC project; it does not create one. Generate the\n` +
            `skeleton first (once — it is committed):\n\n` +
            `    powershell -NoProfile -STA -File Scripts\\build-sample-solution.ps1\n`);
    }
    if (entries.length > 1) {
        throw new Error(`expected exactly one .plcproj in ${root}, found ${entries.length}: ${entries.join(', ')}`);
    }
    return path.join(root, entries[0]);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Sandbox cloning
//
// Filling a project OVERWRITES the objects already in it, so running this script with no arguments
// used to mean "destroy whatever is in the default project". The no-argument path therefore does not
// touch anything that exists: it clones the committed skeleton into the next free sibling directory
// (`TcSample` -> `TcSample_1` -> `TcSample_2` …) and fills the copy.
//
// The clone is a byte-for-byte copy with a project rename applied — it SYNTHESIZES NOTHING. The
// `.sln`/`.tsproj` pair, the `_Config` instance files and the identity GUIDs still come from XAE
// exactly as build-sample-solution.ps1 left them, which is the whole reason this script stopped
// emitting its own `.plcproj` (see the file header).
//
// GUIDs are deliberately NOT re-issued. They are cross-referenced across four files — the `.sln`
// carries both the `.tsproj`'s and the `.plcproj`'s, and `_Config\PLC\<plc>.xti` repeats the latter —
// so re-issuing means re-issuing them consistently everywhere or producing a project XAE refuses to
// open. Two sibling solutions sharing GUIDs is harmless: they are never loaded into one solution.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** Directory name of the skeleton to clone, and the stem every sandbox is named after. */
const SOLUTION_DIR_NAME = 'TcSample';

/**
 * The enclosing git repository's root, found by walking UP from a starting directory.
 *
 * Not `path.resolve(__dirname, '..')`: this script has already been moved once
 * (`Scripts/` -> `Scripts/Create sample project/`), and a fixed depth silently resolves to the wrong
 * directory when that happens — it would look for `TcSample` inside `Scripts/` and clone into it.
 * Anchoring on `.git` keeps the same file correct wherever it is nested.
 * @param {string} from Directory to start from.
 * @returns {string} The repo root, or `from`'s parent when there is no git repo above it.
 */
function findRepoRoot(from) {
    let dir = from;
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return path.resolve(from, '..');
        dir = parent;
    }
}

/**
 * Extensions whose CONTENT names the project and therefore has to be rewritten. Everything else is
 * copied byte-for-byte: the `_Libraries/` archives, the `.tmc`, and the objects themselves (which the
 * fill step overwrites anyway).
 */
const TEXT_PROJECT_FILES = new Set(['.sln', '.tsproj', '.xti', '.xtv', '.plcproj']);

/**
 * Directory names never copied into a sandbox. `_Boot` and `_CompileInfo*` are build output — a build
 * regenerates them, and they are the bulk of the tree — and `.vs` is the developer's own window
 * layout, which still points at the machine the skeleton was authored on.
 */
const SKIP_DIRS = new Set(['_boot', '_compileinfo', '_compileinfo_upload', '.vs']);

const BOM = '﻿';

/** @param {string} s @returns {string} `s` with every regex metacharacter escaped. */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads a text file, reporting whether it carried a UTF-8 BOM.
 *
 * Whether a BOM is present varies FILE BY FILE here — the `.sln` has one; the `.tsproj`, `.plcproj`
 * and the `_Config` XTIs do not — and writing a file back with the wrong answer makes every one of its
 * lines show as changed. So it is measured per file rather than assumed.
 * @param {string} filePath
 * @returns {{text: string, bom: boolean}} Text with any BOM stripped, and whether there was one.
 */
function readTextWithBom(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

/**
 * Writes text back with the BOM it came with.
 *
 * Line endings are not normalised in either direction: the rewrite below is a pure token substitution,
 * so whatever CRLF the source had survives, and the `.plcproj`'s missing trailing newline survives too.
 * @param {string} filePath
 * @param {string} text Text WITHOUT a BOM.
 * @param {boolean} bom Whether to write one.
 */
function writeTextWithBom(filePath, text, bom) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, (bom ? BOM : '') + text, 'utf8');
}

/**
 * Applies a name map in a SINGLE pass, preferring the longest key at each position.
 *
 * Single-pass is load-bearing. Applying the entries one after another re-scans text that an earlier
 * entry already rewrote: with `{TcSample_PLC: 'TcSample_1_PLC', TcSample: 'TcSample_1'}`, the second
 * pass turns the first pass's output into `TcSample_1_1_PLC`. One alternation, longest branch first,
 * cannot do that — a replaced span is never reconsidered.
 * @param {string} text
 * @param {Record<string, string>} nameMap
 * @returns {string}
 */
function applyNameMap(text, nameMap) {
    const keys = Object.keys(nameMap).sort((a, b) => b.length - a.length);
    if (keys.length === 0) return text;
    return text.replace(new RegExp(keys.map(escapeRegExp).join('|'), 'g'), m => nameMap[m]);
}

/**
 * The first free `<baseName>`, `<baseName>_1`, `<baseName>_2`, … directory under a root.
 * @param {string} root
 * @param {string} baseName
 * @returns {string} Absolute path to a directory that does NOT exist.
 */
function nextFreeSolutionDir(root, baseName) {
    for (let n = 0; n < 1000; n++) {
        const candidate = path.join(root, n === 0 ? baseName : `${baseName}_${n}`);
        if (!fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`no free sandbox name under ${root} (tried ${baseName} and ${baseName}_1 … _999)`);
}

/**
 * Clones a TwinCAT solution directory to a new name.
 *
 * The source is identified by what is ON DISK rather than by convention: the single `.sln` names the
 * solution, and the single `.plcproj` names the PLC project and the directory holding it. Only the
 * SOLUTION name is a rename token — the PLC project's new name falls out of applying it, so a PLC
 * project named after something else keeps its name (it needs no rename; it is in a new directory).
 *
 * The token is substring-matched, exactly as a project rename is. Give a sandbox a distinctive stem:
 * a solution named `Tc2` would rewrite the `Tc2_Standard` library references in the `.plcproj`.
 * @param {string} srcDir Solution directory to clone (the one holding the `.sln`).
 * @param {string} dstDir Destination directory. Must not exist.
 * @returns {{solutionDir: string, slnPath: string, plcProjectRoot: string, from: string,
 *            filesCopied: number, filesSkipped: number}}
 */
function cloneSolution(srcDir, dstDir) {
    if (!fs.existsSync(srcDir)) {
        throw new Error(
            `no skeleton to clone at ${srcDir}\n\n` +
            `This script FILLS an XAE-created PLC project; it does not create one. Generate the\n` +
            `skeleton first (once — it is committed):\n\n` +
            `    powershell -NoProfile -STA -File Scripts\\build-sample-solution.ps1\n`);
    }
    if (path.resolve(srcDir) === path.resolve(dstDir)) {
        throw new Error(`refusing to clone ${srcDir} onto itself`);
    }
    if (fs.existsSync(dstDir)) {
        throw new Error(`${dstDir} already exists — refusing to clone into it`);
    }

    const slnFiles = fs.readdirSync(srcDir).filter(f => f.toLowerCase().endsWith('.sln'));
    if (slnFiles.length !== 1) {
        throw new Error(`expected exactly one .sln in ${srcDir}, found ${slnFiles.length}`);
    }
    const srcSlnName = path.basename(slnFiles[0], path.extname(slnFiles[0]));

    // The PLC project lives one level down. `_Config` holds the system project's instance files, not
    // a `.plcproj`, so it is not a candidate.
    let srcPlcDir = null;
    let srcPlcName = null;
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === '_Config' || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        const hit = fs.readdirSync(path.join(srcDir, entry.name))
            .find(f => f.toLowerCase().endsWith('.plcproj'));
        if (hit) {
            srcPlcDir = entry.name;
            srcPlcName = path.basename(hit, path.extname(hit));
            break;
        }
    }
    if (!srcPlcDir) throw new Error(`no <dir>/<dir>.plcproj found under ${srcDir}`);

    const nameMap = { [srcSlnName]: path.basename(dstDir) };
    const dstPlcDir = applyNameMap(srcPlcDir, nameMap);
    const dstPlcName = applyNameMap(srcPlcName, nameMap);

    const stats = { copied: 0, skipped: 0 };

    /** Recursive copy, renaming path segments and rewriting the project files as it goes. */
    const copyTree = (relDir) => {
        for (const entry of fs.readdirSync(path.join(srcDir, relDir), { withFileTypes: true })) {
            const rel = path.join(relDir, entry.name);
            const srcPath = path.join(srcDir, rel);
            const dstPath = path.join(dstDir, applyNameMap(rel, nameMap));

            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name.toLowerCase())) { stats.skipped++; continue; }
                fs.mkdirSync(dstPath, { recursive: true });
                copyTree(rel);
                continue;
            }

            const lower = entry.name.toLowerCase();
            // `.bak` files are the IDE's own backups of a rename that already happened; a `.tmc`
            // belonging to some OTHER project name is residue from the same rename. Neither describes
            // this project, and carrying them forward propagates the mess into every sandbox.
            if (lower.endsWith('.bak')) { stats.skipped++; continue; }
            // Documentation belongs to the repo, not to a disposable sandbox — one copy per clone is
            // just N copies drifting out of date.
            if (lower.endsWith('.md')) { stats.skipped++; continue; }
            if (lower.endsWith('.tmc') && path.basename(entry.name, path.extname(entry.name)) !== srcPlcName) {
                stats.skipped++;
                continue;
            }

            if (TEXT_PROJECT_FILES.has(path.extname(lower))) {
                const { text, bom } = readTextWithBom(srcPath);
                writeTextWithBom(dstPath, applyNameMap(text, nameMap), bom);
            } else {
                fs.mkdirSync(path.dirname(dstPath), { recursive: true });
                fs.copyFileSync(srcPath, dstPath);
            }
            stats.copied++;
        }
    };
    copyTree('');

    // The instance XTI's TmcPath/XtvPath are canonical by construction — `<plcDir>\<plcName>.<ext>` —
    // so they are COMPUTED rather than renamed. A token rename can only rewrite names it was given, so
    // a skeleton whose XTI still points at some earlier project name would seed that stale path into
    // every clone. (The committed skeleton did exactly that until TwinCAT rewrote the XTI during a
    // build.) Computing the paths makes the clone correct regardless of what the source carries.
    const configDir = path.join(dstDir, '_Config');
    if (fs.existsSync(configDir)) {
        for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            for (const file of fs.readdirSync(path.join(configDir, entry.name))) {
                if (!file.toLowerCase().endsWith(' instance.xti')) continue;
                const xtiPath = path.join(configDir, entry.name, file);
                const { text, bom } = readTextWithBom(xtiPath);
                const repaired = text
                    .replace(/TmcPath="[^"]*"/, `TmcPath="${dstPlcDir}\\${dstPlcName}.tmc"`)
                    .replace(/XtvPath="[^"]*"/, `XtvPath="${entry.name}\\${dstPlcName} Instance.xtv"`);
                if (repaired !== text) writeTextWithBom(xtiPath, repaired, bom);
            }
        }
    }

    // The copy above declines to bring stale `.tmc` FILES across; this drops the `<None>` items that
    // referenced them, so the clone does not ship a project entry pointing at a file that is not
    // there. Only `.tmc` items are touched — every other byte of the `.plcproj` is XAE's.
    const clonedPlcProj = path.join(dstDir, dstPlcDir, `${dstPlcName}.plcproj`);
    if (fs.existsSync(clonedPlcProj)) {
        const { text, bom } = readTextWithBom(clonedPlcProj);
        const pruned = text
            .replace(/[ \t]*<None Include="([^"]*\.tmc)">[\s\S]*?<\/None>\r?\n?/g,
                (whole, include) =>
                    path.basename(include, path.extname(include)) === dstPlcName ? whole : '')
            // An ItemGroup that held nothing but the pruned item would otherwise be left empty.
            .replace(/[ \t]*<ItemGroup>\s*<\/ItemGroup>\r?\n?/g, '');
        if (pruned !== text) writeTextWithBom(clonedPlcProj, pruned, bom);
    }

    // Verify on disk rather than trusting the copy — the same discipline build-sample-solution.ps1
    // applies to the skeleton it creates.
    const slnPath = path.join(dstDir, `${path.basename(dstDir)}.sln`);
    const plcProjectRoot = path.join(dstDir, dstPlcDir);
    const checks = [
        ['solution', slnPath],
        ['system project', path.join(dstDir, `${path.basename(dstDir)}.tsproj`)],
        ['PLC project', path.join(plcProjectRoot, `${dstPlcName}.plcproj`)]
    ];
    for (const [what, p] of checks) {
        if (!fs.existsSync(p)) throw new Error(`clone incomplete: no ${what} at ${p}`);
    }

    return {
        solutionDir: dstDir,
        slnPath,
        plcProjectRoot,
        from: srcDir,
        filesCopied: stats.copied,
        filesSkipped: stats.skipped
    };
}

/**
 * Writes the objects into the XAE-created PLC project and registers them in its `.plcproj`.
 *
 * `MAIN.TcPOU` deliberately OVERWRITES the empty PROGRAM that XAE creates by default: it sits at the
 * same path, so the skeleton already lists it and the spec's version simply replaces its contents.
 * @param {string} root PLC project root — the directory holding the XAE-authored `.plcproj`.
 * @returns {{objects: number, root: string, plcProj: string, compiles: number, folders: number}}
 * What was written, and what the `.plcproj` injection had to add.
 */
function build(root) {
    const plcProjPath = findPlcProj(root);

    for (const spec of OBJECTS) {
        const dest = path.join(root, ...spec.dir.split('/'), spec.file);
        writeTwinCatFile(dest, renderObject(spec));
    }

    // Round-tripped as raw text, NOT through writeTwinCatFile(): XAE wrote this file without a BOM
    // and without a trailing newline, and both must survive.
    const before = fs.readFileSync(plcProjPath, 'utf8');
    const { text, compiles, folders } = registerObjectsInPlcProj(before);
    if (text !== before) fs.writeFileSync(plcProjPath, text, 'utf8');

    return { objects: OBJECTS.length, root, plcProj: plcProjPath, compiles, folders };
}

if (require.main === module) {
    let cloned = null;
    let result;
    try {
        let target;
        if (process.argv[2]) {
            // Explicit root: fill that project IN PLACE. This is the destructive path — it is how the
            // committed project's objects get regenerated — so it stays opt-in.
            target = path.resolve(process.argv[2]);
        } else {
            // No argument: clone, then fill the clone. Nothing that already exists is written to.
            const repoRoot = findRepoRoot(__dirname);
            cloned = cloneSolution(
                path.join(repoRoot, SOLUTION_DIR_NAME),
                nextFreeSolutionDir(repoRoot, SOLUTION_DIR_NAME));
            target = cloned.plcProjectRoot;
        }
        result = build(target);
    } catch (err) {
        console.error(`\n[build-sample-project] ${err.message}`);
        // A clone that was created before the failure is left on disk deliberately — deleting a
        // directory tree on an error path is how you delete the wrong one. Name it so it can be
        // inspected or removed by hand.
        if (cloned) console.error(`[build-sample-project] partial sandbox left at ${cloned.solutionDir}`);
        process.exit(1);
    }
    if (cloned) {
        console.log(`Cloned ${cloned.from}`);
        console.log(`    -> ${cloned.solutionDir} ` +
            `(${cloned.filesCopied} files copied, ${cloned.filesSkipped} skipped: build output, IDE state, .bak, stale .tmc)`);
        console.log(`Solution: ${cloned.slnPath}`);
    }
    console.log(`Wrote ${result.objects} TwinCAT objects to ${result.root}`);
    console.log(`Registered in ${path.basename(result.plcProj)}: ` +
        `+${result.compiles} <Compile>, +${result.folders} <Folder> ` +
        `(0/0 on a re-run — the injection is idempotent)`);
}

module.exports = {
    build, renderObject, registerObjectsInPlcProj, guid, OBJECTS,
    cloneSolution, nextFreeSolutionDir, applyNameMap
};
