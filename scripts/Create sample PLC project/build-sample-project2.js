/**
 * @file build-sample-project2.js
 * @description Generates the SECOND synthetic sample solution, `sample/TcToolkitSample2/` (PLC project
 * `TcToolkitSample2_PLC`), so the harnesses can exercise a multi-project workspace on committed,
 * correct code.
 *
 * The two samples deliberately differ in what a multi-project workspace has to keep apart:
 *   - **Layout.** The first sample is XAE 3.1.4026's layout (`.sln` + `.tsproj` + `_Config/`); this one is
 *     created from the extension's own **3.1.4024** template (`.sln` + a single-file `.tspproj`, the PLC
 *     project nested under the system project's folder). Together they cover both shipped templates.
 *   - **Names.** It has a `MAIN` (same name and same in-project path as the first sample's) and an
 *     `FB_Cylinder` whose body and members differ from the first sample's — the shapes that leak if any
 *     name-keyed structure is workspace-flat instead of per project.
 *
 * How it is made, in two steps, both deterministic:
 *   1. **Skeleton** — `createProject` from `src/projectTemplate.js` (the code behind *TwinCAT: Create New
 *      Project…*) over `resources/templates/tc3.1.4024/`, with an injected GUID source that DERIVES each
 *      identity GUID from a counter (SHA-1), so a rebuild is byte-identical instead of re-minting them.
 *   2. **Objects** — rendered by `build-sample-project.js`'s `renderObject` (canonical element order,
 *      UTF-8 with BOM, CRLF, LineIds) under this sample's own GUID namespace, and registered in the
 *      `.plcproj` by its `registerObjectsInPlcProj` (`<Compile>` + `<SubType>Code</SubType>` and
 *      `<Folder Include>`, the element shapes the Objects-tree commands write via src/plcProjHelper.js,
 *      spliced so every other byte of XAE's file survives). `MAIN.TcPOU` and `GVL_Main.TcGVL` replace the
 *      template's empty ones at the same paths, so the template already lists them.
 *
 * The code is CORRECT TwinCAT code with no library symbol, so every diagnostic the extension reports on
 * it is a bug (the same ground-truth rule as the first sample), and the external compiler's check must
 * report zero errors on it (test/test_compile_real.js).
 *
 * Usage:
 *   node "scripts/Create sample PLC project/build-sample-project2.js"           # write sample/TcToolkitSample2 (refuses if it exists)
 *   node "scripts/Create sample PLC project/build-sample-project2.js" --write   # rewrite every generated file in place
 *   node "scripts/Create sample PLC project/build-sample-project2.js" --check   # compare the committed tree with a fresh build; exit 1 on drift
 *
 * Every mode builds into a temporary directory first; `--write` then copies file by file (it never deletes
 * a directory tree), and `--check` writes nothing.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const { createProject, templateDirFor } = require(path.join(REPO, 'src', 'projectTemplate.js'));
const { renderObject, registerObjectsInPlcProj, writeTwinCatFile } = require('./build-sample-project.js');

/** Solution name; the PLC project is `<name>_PLC`. */
const SOLUTION_NAME = 'TcToolkitSample2';
/** The template it is created from. */
const TEMPLATE_VERSION = '3.1.4024';
/** Namespace of every derived GUID (template identities and object ids). Changing it re-ids the project. */
const GUID_NAMESPACE = 'TcToolkitSample2';
/** Where the solution lands. */
const SAMPLE_ROOT = path.join(REPO, 'sample');

/**
 * A deterministic stand-in for `crypto.randomUUID()`: the n-th call returns a GUID derived from n.
 * `planProject` asks for one GUID per template identity GUID in sorted order, so the mapping is stable.
 * @returns {() => string} Lower-case GUIDs without braces.
 */
function derivedGuidSource() {
    let n = 0;
    return () => {
        const hex = crypto.createHash('sha1').update(`${GUID_NAMESPACE}|template|${n++}`).digest('hex').slice(0, 32);
        const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
        const v = hex.slice(0, 12) + '4' + hex.slice(13, 16) + variant + hex.slice(17, 32);
        return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
    };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// The project spec — a neutral tank-filling demo. Same ObjectSpec shape as build-sample-project.js.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** @type {Array<Object>} ObjectSpec entries, as in build-sample-project.js. */
const OBJECTS = [
    // ── DUTs ─────────────────────────────────────────────────────────────────────────────────────
    {
        dir: 'DUTs', file: 'E_ValveState.TcDUT', root: 'DUT', name: 'E_ValveState',
        declaration: [
            'TYPE E_ValveState :',
            '(',
            '\tClosed := 0,',
            '\tOpening := 1,',
            '\tOpen := 2,',
            '\tClosing := 3',
            ');',
            'END_TYPE',
            ''
        ].join('\n')
    },
    {
        dir: 'DUTs', file: 'ST_TankData.TcDUT', root: 'DUT', name: 'ST_TankData',
        declaration: [
            'TYPE ST_TankData :',
            'STRUCT',
            '\tfLevel\t\t: LREAL;',
            '\tfSetpoint\t: LREAL := 50.0;',
            '\teInlet\t\t: E_ValveState;',
            '\tbAlarm\t\t: BOOL;',
            'END_STRUCT',
            'END_TYPE',
            ''
        ].join('\n')
    },

    // ── GVL (the template's GVL_Main, filled) ────────────────────────────────────────────────────
    {
        dir: 'GVLs', file: 'GVL_Main.TcGVL', root: 'GVL', name: 'GVL_Main',
        declaration: [
            "{attribute 'qualified_only'}",
            'VAR_GLOBAL',
            '\tstTank\t\t: ST_TankData;',
            '\tnCycles\t\t: UDINT;',
            '\tbFillRequest\t: BOOL;',
            'END_VAR',
            ''
        ].join('\n')
    },

    // ── Interface ────────────────────────────────────────────────────────────────────────────────
    {
        dir: 'POUs/Interfaces', file: 'I_Valve.TcIO', root: 'Itf', name: 'I_Valve',
        declaration: 'INTERFACE I_Valve\n',
        members: [
            { kind: 'Method', name: 'Open', declaration: 'METHOD Open : BOOL\n' },
            {
                kind: 'Property', name: 'State',
                declaration: 'PROPERTY State : E_ValveState\n',
                get: { declaration: '' },
                set: { declaration: '' }
            }
        ]
    },

    // ── Function blocks ──────────────────────────────────────────────────────────────────────────
    {
        // Implements I_Valve: a method, a property with GET and SET, and an action (in a virtual folder).
        dir: 'POUs', file: 'FB_Valve.TcPOU', root: 'POU', name: 'FB_Valve',
        declaration: [
            'FUNCTION_BLOCK FB_Valve IMPLEMENTS I_Valve',
            'VAR_INPUT',
            '\tbClose\t: BOOL;',
            'END_VAR',
            'VAR_OUTPUT',
            '\tbIsOpen\t: BOOL;',
            'END_VAR',
            'VAR',
            '\t_eState\t: E_ValveState;',
            '\t_nTicks\t: UINT;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: [
            'IF bClose THEN',
            '\tAct_Close();',
            'END_IF',
            'IF _eState = E_ValveState.Opening THEN',
            '\t_nTicks := _nTicks + 1;',
            '\tIF _nTicks >= 10 THEN',
            '\t\t_eState := E_ValveState.Open;',
            '\tEND_IF',
            'END_IF',
            'bIsOpen := _eState = E_ValveState.Open;'
        ].join('\n'),
        folders: ['Actions'],
        members: [
            {
                kind: 'Method', name: 'Open',
                declaration: 'METHOD Open : BOOL\nVAR\nEND_VAR\n',
                implementation: [
                    'IF _eState = E_ValveState.Closed THEN',
                    '\t_eState := E_ValveState.Opening;',
                    '\t_nTicks := 0;',
                    'END_IF',
                    'Open := _eState <> E_ValveState.Closed;'
                ].join('\n')
            },
            {
                kind: 'Property', name: 'State',
                declaration: 'PROPERTY State : E_ValveState\n',
                get: { declaration: 'VAR\nEND_VAR\n', implementation: 'State := _eState;' },
                set: { declaration: 'VAR\nEND_VAR\n', implementation: '_eState := State;' }
            },
            {
                kind: 'Action', name: 'Act_Close', folderPath: 'Actions\\',
                implementation: [
                    '_eState := E_ValveState.Closed;',
                    '_nTicks := 0;'
                ].join('\n')
            }
        ]
    },
    {
        // Same NAME as the first sample's FB_Cylinder (POUs/Actuators/FB_Cylinder.TcPOU there), but a
        // different body and different members — so a name-keyed lookup that is not scoped per project
        // answers with the wrong one.
        dir: 'POUs', file: 'FB_Cylinder.TcPOU', root: 'POU', name: 'FB_Cylinder',
        declaration: [
            'FUNCTION_BLOCK FB_Cylinder',
            'VAR_INPUT',
            '\tbExtend\t\t: BOOL;',
            '\tnStrokeTicks\t: UINT := 5;',
            'END_VAR',
            'VAR_OUTPUT',
            '\tbExtended\t: BOOL;',
            'END_VAR',
            'VAR',
            '\t_nTicks\t: UINT;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: [
            'IF bExtend THEN',
            '\tIF _nTicks < nStrokeTicks THEN',
            '\t\t_nTicks := _nTicks + 1;',
            '\tEND_IF',
            'ELSE',
            '\t_nTicks := 0;',
            'END_IF',
            'bExtended := bExtend AND _nTicks >= nStrokeTicks;'
        ].join('\n'),
        members: [
            {
                kind: 'Method', name: 'Stroke',
                declaration: 'METHOD Stroke : UINT\nVAR\nEND_VAR\n',
                implementation: 'Stroke := _nTicks;'
            }
        ]
    },

    // ── Program ──────────────────────────────────────────────────────────────────────────────────
    {
        dir: 'POUs', file: 'MAIN.TcPOU', root: 'POU', name: 'MAIN',
        declaration: [
            'PROGRAM MAIN',
            'VAR',
            '\tfbValve\t\t: FB_Valve;',
            '\tipValve\t\t: I_Valve;',
            '\tfbCylinder\t: FB_Cylinder;',
            '\tnStroke\t\t: UINT;',
            'END_VAR',
            ''
        ].join('\n'),
        implementation: [
            'GVL_Main.nCycles := GVL_Main.nCycles + 1;',
            'ipValve := fbValve;',
            'IF GVL_Main.bFillRequest AND GVL_Main.stTank.fLevel < GVL_Main.stTank.fSetpoint THEN',
            '\tipValve.Open();',
            'END_IF',
            'fbValve(bClose := GVL_Main.stTank.fLevel >= GVL_Main.stTank.fSetpoint);',
            'GVL_Main.stTank.eInlet := fbValve.State;',
            'GVL_Main.stTank.bAlarm := GVL_Main.stTank.eInlet = E_ValveState.Open AND NOT fbValve.bIsOpen;',
            'fbCylinder(bExtend := fbValve.bIsOpen);',
            'nStroke := fbCylinder.Stroke();'
        ].join('\n')
    }
];

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Build
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Builds the whole solution into `<location>/TcToolkitSample2/`: the 3.1.4024 skeleton, the objects, and
 * their `.plcproj` registration.
 * @param {string} location A directory with no `TcToolkitSample2/` in it.
 * @returns {{solutionDir: string, plcProjectRoot: string, objects: number, compiles: number, folders: number}}
 */
function buildInto(location) {
    const created = createProject({
        templateDir: templateDirFor(path.join(REPO, 'resources', 'templates'), TEMPLATE_VERSION),
        location,
        name: SOLUTION_NAME,
        newGuid: derivedGuidSource()
    });
    const plcProjectRoot = path.dirname(created.plcprojPath);
    for (const spec of OBJECTS) {
        writeTwinCatFile(path.join(plcProjectRoot, ...spec.dir.split('/'), spec.file), renderObject(spec, GUID_NAMESPACE));
    }
    // Raw text round trip: the template's .plcproj has no BOM and no trailing newline; both survive.
    const before = fs.readFileSync(created.plcprojPath, 'utf8');
    const { text, compiles, folders } = registerObjectsInPlcProj(before, OBJECTS);
    if (text !== before) fs.writeFileSync(created.plcprojPath, text, 'utf8');
    return { solutionDir: created.targetDir, plcProjectRoot, objects: OBJECTS.length, compiles, folders };
}

/**
 * Every file under a directory, relative with `/` separators, sorted.
 * @param {string} root
 * @returns {string[]}
 */
function listFiles(root) {
    /** @type {string[]} */
    const out = [];
    const walk = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(dir, e.name), r);
            else out.push(r);
        }
    };
    if (fs.existsSync(root)) walk(root, '');
    return out.sort();
}

/**
 * Builds a fresh copy in a temporary directory and compares it with `targetDir`.
 * @param {string} [targetDir] Defaults to `sample/TcToolkitSample2`.
 * @returns {{fresh: string, missing: string[], extra: string[], changed: string[], cleanup: () => void}}
 *   `extra` ignores the git-ignored build/IDE output TwinCAT and the extension create (`ST_Files/`, `_CompileInfo/`, …).
 */
function compareWithFresh(targetDir = path.join(SAMPLE_ROOT, SOLUTION_NAME)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_sample2_'));
    const built = buildInto(tmp);
    const freshFiles = listFiles(built.solutionDir);
    const ignored = /(^|\/)(ST_Files|_CompileInfo|_CompileInfo_Upload|_Boot|_Libraries|\.vs|\.trust-lsp)\/|\.bak$|\.~u$|\.tmc$/i;
    const haveFiles = listFiles(targetDir).filter(f => !ignored.test(f));
    const missing = freshFiles.filter(f => !haveFiles.includes(f));
    const extra = haveFiles.filter(f => !freshFiles.includes(f));
    const changed = freshFiles.filter(f => haveFiles.includes(f) &&
        !fs.readFileSync(path.join(built.solutionDir, f)).equals(fs.readFileSync(path.join(targetDir, f))));
    return { fresh: built.solutionDir, missing, extra, changed, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

if (require.main === module) {
    const mode = process.argv[2] || '';
    const target = path.join(SAMPLE_ROOT, SOLUTION_NAME);
    try {
        if (mode === '--check') {
            const cmp = compareWithFresh(target);
            cmp.cleanup();
            const drift = [...cmp.missing.map(f => `missing: ${f}`), ...cmp.extra.map(f => `not generated: ${f}`), ...cmp.changed.map(f => `differs: ${f}`)];
            if (drift.length) {
                console.error(`sample/${SOLUTION_NAME} differs from a fresh build:\n  ${drift.join('\n  ')}`);
                process.exit(1);
            }
            console.log(`sample/${SOLUTION_NAME} matches a fresh build.`);
        } else if (mode === '--write') {
            const cmp = compareWithFresh(target);
            for (const f of [...cmp.missing, ...cmp.changed]) {
                const dest = path.join(target, ...f.split('/'));
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(path.join(cmp.fresh, ...f.split('/')), dest);
            }
            cmp.cleanup();
            console.log(`Rewrote ${cmp.missing.length + cmp.changed.length} file(s) in sample/${SOLUTION_NAME}` +
                (cmp.extra.length ? `; left ${cmp.extra.length} file(s) the generator does not write: ${cmp.extra.join(', ')}` : '.'));
        } else if (mode === '') {
            const built = buildInto(SAMPLE_ROOT);
            console.log(`Created ${built.solutionDir} from the ${TEMPLATE_VERSION} template`);
            console.log(`Wrote ${built.objects} TwinCAT objects to ${built.plcProjectRoot}; ` +
                `registered +${built.compiles} <Compile>, +${built.folders} <Folder>`);
        } else {
            console.error('usage: build-sample-project2.js [--write | --check]');
            process.exit(2);
        }
    } catch (err) {
        console.error(`\n[build-sample-project2] ${err.message}`);
        process.exit(1);
    }
}

module.exports = { OBJECTS, SOLUTION_NAME, TEMPLATE_VERSION, buildInto, compareWithFresh };
