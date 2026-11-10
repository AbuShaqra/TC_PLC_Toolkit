/**
 * @file test_two_samples.js
 * @description The committed `sample/` as a MULTI-PROJECT workspace: two separate solutions,
 * `TcToolkitSample/` (3.1.4026 layout) and `TcToolkitSample2/` (3.1.4024 layout, created from the
 * extension's own template by `scripts/Create sample PLC project/build-sample-project2.js`). Unlike
 * `test_multi_project_scope.js`, whose two projects are copies of one sample, these two differ: the
 * same names (`MAIN`, `FB_Cylinder`) carry different code, so a lookup that is not scoped per project
 * gives a wrong answer rather than an identical one.
 *
 * Pinned:
 *   - the second sample is reproducible: a fresh build of the generator matches the committed tree
 *     byte for byte, and it is the 3.1.4024 layout (`.tspproj`, ProgramVersion 3.1.4024);
 *   - the partition: two projects, each object in exactly one, each project's MAIN and FB_Cylinder in
 *     its own index with its own members;
 *   - Go to Definition on `FB_Cylinder` lands in that project's own FB_Cylinder;
 *   - Find References on `FB_Cylinder` stays inside the project it was asked in;
 *   - Generate ST (the real `generateAllStFiles`, under a `vscode` stub, on a temp copy) writes each
 *     project's objects into that project's own `ST_Files/`, one `.st` per object, nothing at the top.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { reportCoverage } = require('./_coverage');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { createProjectMap } = require('../src/lsp/projectMap');
const { scanWorkspace } = require('../src/lsp/workspaceScan');
const { parseAndIndexDocument } = require('../src/lsp/parser');
const { buildNodeFromXml } = require('../src/lsp/xmlIndexer');
const { provideDefinition, provideReferences, provideDiagnostics } = require('../src/lsp/features');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample');
const FIRST = path.join(SAMPLE_DIR, 'TcToolkitSample');
const SECOND = path.join(SAMPLE_DIR, 'TcToolkitSample2');
const GATE = 'two-samples';

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

if (!fs.existsSync(FIRST) || !fs.existsSync(SECOND)) {
    console.log('[SKIP] sample/TcToolkitSample or sample/TcToolkitSample2 is absent.');
    reportCoverage(GATE, 'skipped', 'a sample solution is absent');
    process.exit(0);
}

const toUri = (file) => 'file:///' + file.replace(/\\/g, '/').replace(/^\//, '');
/** Is `file` inside `dir`? (Exact directory boundary: TcToolkitSample is a prefix of TcToolkitSample2.) */
const inside = (file, dir) => file.toLowerCase().startsWith((dir + path.sep).toLowerCase());
const uriInside = (uri, dir) => decodeURIComponent(uri).toLowerCase().replace(/\\/g, '/')
    .includes('/' + path.relative(SAMPLE_DIR, dir).replace(/\\/g, '/').toLowerCase() + '/');

(async () => {
    // ── 1. The second sample is the generator's output, in the 3.1.4024 layout ─────────────────────
    console.log('\n=== 1. reproducible, 3.1.4024 layout ===');
    const gen = require('../scripts/Create sample PLC project/build-sample-project2.js');
    const cmp = gen.compareWithFresh(SECOND);
    cmp.cleanup();
    assert(cmp.missing.length === 0 && cmp.extra.length === 0 && cmp.changed.length === 0,
        `sample/TcToolkitSample2 matches a fresh build of build-sample-project2.js ` +
        `(missing ${JSON.stringify(cmp.missing)}, not generated ${JSON.stringify(cmp.extra)}, differs ${JSON.stringify(cmp.changed)})`);
    const tspproj = path.join(SECOND, 'TcToolkitSample2', 'TcToolkitSample2.tspproj');
    const plcproj2 = path.join(SECOND, 'TcToolkitSample2', 'TcToolkitSample2_PLC', 'TcToolkitSample2_PLC.plcproj');
    assert(fs.existsSync(path.join(SECOND, 'TcToolkitSample2.sln')) && fs.existsSync(tspproj) &&
        /<ProgramVersion>3\.1\.4024\.0<\/ProgramVersion>/.test(fs.readFileSync(plcproj2, 'utf8')),
        'the second sample is a 3.1.4024 solution (.sln + .tspproj, ProgramVersion 3.1.4024)');
    assert(fs.existsSync(path.join(FIRST, 'TcToolkitSample.tsproj')), 'the first sample keeps the 3.1.4026 layout (.tsproj)');

    // ── 2. The partition ────────────────────────────────────────────────────────────────────────
    console.log('\n=== 2. one index per project ===');
    const ws = scanWorkspace([SAMPLE_DIR], { indexLibraries: () => {} });
    const map = ws.projectMap;
    const keys = map.keys();
    assert(keys.length === 2, `sample/ holds two PLC projects (${keys.map(k => map.displayName(k)).join(', ')})`);
    const keyOf = (dir) => keys.find(k => inside(map.get(k).dir, dir) || map.get(k).dir === dir);
    const k1 = keyOf(FIRST);
    const k2 = keyOf(SECOND);
    assert(!!k1 && !!k2 && k1 !== k2, 'each sample solution owns one of them');
    const p1 = map.get(k1);
    const p2 = map.get(k2);
    const src = (p) => [...p.objectFiles.values()].filter(f => /\.(TcPOU|TcGVL|TcDUT|TcIO)$/i.test(f));
    assert(src(p1).length === 19 && src(p2).length === 7,
        `the first project has 19 source objects, the second 7 (${src(p1).length}, ${src(p2).length})`);
    assert(src(p1).every(f => inside(f, FIRST)) && src(p2).every(f => inside(f, SECOND)),
        'every object belongs to the project of its own solution');
    const i1 = ws.indexForKey(k1);
    const i2 = ws.indexForKey(k2);
    const node1 = i1['FB_Cylinder'];
    const node2 = i2['FB_Cylinder'];
    assert(!!node1 && !!node2 && uriInside(node1.uri, FIRST) && uriInside(node2.uri, SECOND),
        `each index holds its own project's FB_Cylinder (${node1 && node1.uri} | ${node2 && node2.uri})`);
    assert(!!i1['FB_Station'] && !i2['FB_Station'] && !!i2['FB_Valve'] && !i1['FB_Valve'],
        'objects of one project are absent from the other index (FB_Station / FB_Valve)');

    // ── 3. Definition and references stay in their project ──────────────────────────────────────
    console.log('\n=== 3. Go to Definition and Find References ===');
    /**
     * The raw unit of one object, synced into its project's index the way the server does.
     * @param {string} file
     * @param {Object} index
     */
    const open = (file, index) => {
        const { stText } = convertXmlToSt(parseTwinCatXml(fs.readFileSync(file, 'utf8')), { raw: true });
        const uri = toUri(file);
        parseAndIndexDocument(stText, uri, index);
        return { stText, uri };
    };
    /** Position of `word` on the first line that matches `lineRe`. */
    const at = (stText, lineRe, word) => {
        const lines = stText.split('\n');
        const line = lines.findIndex(l => lineRe.test(l));
        return { line, character: line < 0 ? -1 : lines[line].indexOf(word) + 2 };
    };

    const main2 = src(p2).find(f => /[\\/]MAIN\.TcPOU$/i.test(f));
    const m2 = open(main2, i2);
    const def2 = provideDefinition(m2.stText, at(m2.stText, /fbCylinder\s*:\s*FB_Cylinder/, 'FB_Cylinder'), i2, m2.uri);
    assert(!!def2 && uriInside(def2.uri, SECOND) && /POUs\/FB_Cylinder\.TcPOU$/i.test(decodeURIComponent(def2.uri)),
        `FB_Cylinder from the second sample's MAIN resolves to the second sample's FB_Cylinder (${def2 && def2.uri})`);

    const gvl1 = src(p1).find(f => /[\\/]GVL_System\.TcGVL$/i.test(f));
    const g1 = open(gvl1, i1);
    const def1 = provideDefinition(g1.stText, at(g1.stText, /fbCylinder\s*:\s*FB_Cylinder/, 'FB_Cylinder'), i1, g1.uri);
    assert(!!def1 && uriInside(def1.uri, FIRST) && /Actuators\/FB_Cylinder\.TcPOU$/i.test(decodeURIComponent(def1.uri)),
        `FB_Cylinder from the first sample's GVL_System resolves to the first sample's FB_Cylinder (${def1 && def1.uri})`);

    const stroke = provideDefinition(m2.stText, at(m2.stText, /fbCylinder\.Stroke\(\)/, 'Stroke'), i2, m2.uri);
    assert(!!stroke && uriInside(stroke.uri, SECOND),
        `a member only the second FB_Cylinder has (Stroke) resolves there (${stroke && stroke.uri})`);

    const refs2 = provideReferences(m2.stText, at(m2.stText, /fbCylinder\s*:\s*FB_Cylinder/, 'FB_Cylinder'), i2, m2.uri) || [];
    assert(refs2.length >= 1 && refs2.every(r => uriInside(r.uri, SECOND)),
        `references to FB_Cylinder asked in the second sample stay there (${refs2.length}; leaked: ` +
        `${JSON.stringify(refs2.filter(r => !uriInside(r.uri, SECOND)).map(r => r.uri))})`);
    const refs1 = provideReferences(g1.stText, at(g1.stText, /fbCylinder\s*:\s*FB_Cylinder/, 'FB_Cylinder'), i1, g1.uri) || [];
    assert(refs1.length >= 2 && refs1.every(r => uriInside(r.uri, FIRST)),
        `references to FB_Cylinder asked in the first sample stay there (${refs1.length}; leaked: ` +
        `${JSON.stringify(refs1.filter(r => !uriInside(r.uri, FIRST)).map(r => r.uri))})`);
    // MAIN is opened FIRST here: FB_Valve is known only from the scan (xmlIndexer), never from its own
    // unit. The scan used to read `IMPLEMENTS I_Valve` on a multi-line head as "I_Valve\r\nVAR_INPUT…",
    // so `ipValve := fbValve;` was a false type mismatch until FB_Valve had been opened.
    const itfHead = '<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n' +
        '  <POU Name="FB_X" Id="{00000000-0000-4000-8000-000000000001}" SpecialFunc="None">\r\n' +
        '    <Declaration><![CDATA[FUNCTION_BLOCK FB_X EXTENDS FB_Base IMPLEMENTS I_A, Lib.I_B\r\nVAR_INPUT\r\n\tbIn : BOOL;\r\nEND_VAR\r\n]]></Declaration>\r\n' +
        '    <Implementation><ST><![CDATA[]]></ST></Implementation>\r\n  </POU>\r\n</TcPlcObject>\r\n';
    const xNode = buildNodeFromXml(itfHead, 'file:///x/FB_X.TcPOU');
    assert(!!xNode && JSON.stringify(xNode.implements) === '["I_A","Lib.I_B"]' && xNode.extends === 'FB_Base',
        `the scan reads IMPLEMENTS on a CRLF multi-line head as the interface list only (${xNode && JSON.stringify(xNode.implements)})`);
    const d2 = provideDiagnostics(m2.stText, i2, m2.uri);
    assert(d2.length === 0, `the second sample's MAIN, diagnosed in its own index, scores 0 (${d2.map(d => d.message).join(' | ')})`);

    // ── 4. Generate ST writes each project into its own ST_Files ────────────────────────────────
    console.log('\n=== 4. Generate ST, per project ===');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_two_samples_'));
    try {
        for (const dir of [FIRST, SECOND]) fs.cpSync(dir, path.join(tmp, path.basename(dir)), { recursive: true });
        const shown = [];
        const vscodeStub = {
            Uri: { file: (p) => ({ fsPath: p, toString: () => toUri(p) }), joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p) }) },
            workspace: { workspaceFolders: [{ uri: { fsPath: tmp } }] },
            window: {
                showInformationMessage: (m) => { shown.push(m); },
                showWarningMessage: (m) => { shown.push(m); },
                showErrorMessage: (m) => { shown.push(m); }
            }
        };
        const realLoad = Module._load;
        Module._load = function (request) {
            if (request === 'vscode') return vscodeStub;
            return realLoad.apply(this, arguments);
        };
        const { TwinCatCustomEditorProvider } = require('../src/customEditorProvider');
        Module._load = realLoad;
        const tmpMap = createProjectMap([tmp]);
        let refreshed = 0;
        const provider = new TwinCatCustomEditorProvider(
            { workspaceState: { get: (k, d) => d, update: () => Promise.resolve() } },
            { getProjectMap: () => tmpMap, onStFilesWritten: () => { refreshed++; } });
        const counts = await provider.generateAllStFiles();
        const countSt = (dir) => !fs.existsSync(dir) ? 0 : fs.readdirSync(dir, { withFileTypes: true })
            .reduce((n, e) => n + (e.isDirectory() ? countSt(path.join(dir, e.name)) : (/\.st$/i.test(e.name) ? 1 : 0)), 0);
        const st1 = path.join(tmp, 'TcToolkitSample', 'TcToolkitSample_PLC', 'ST_Files');
        const st2 = path.join(tmp, 'TcToolkitSample2', 'TcToolkitSample2', 'TcToolkitSample2_PLC', 'ST_Files');
        const objects = (k) => tmpMap.get(k).objectFiles.size;
        const tk1 = tmpMap.keys().find(k => /tctoolkitsample_plc\.plcproj$/i.test(k));
        const tk2 = tmpMap.keys().find(k => /tctoolkitsample2_plc\.plcproj$/i.test(k));
        assert(!!counts && counts.failCount === 0 && counts.successCount === objects(tk1) + objects(tk2),
            `every object of both projects is exported, none failed (${JSON.stringify(counts)}; ${objects(tk1)} + ${objects(tk2)} objects)`);
        assert(countSt(st1) === objects(tk1) && countSt(st2) === objects(tk2),
            `each project's ST_Files holds one .st per object of that project (${countSt(st1)}/${objects(tk1)}, ${countSt(st2)}/${objects(tk2)})`);
        const main1St = path.join(st1, 'POUs', 'MAIN.st');
        const main2St = path.join(st2, 'POUs', 'MAIN.st');
        assert(fs.existsSync(main1St) && fs.existsSync(main2St) &&
            !/fbValve/.test(fs.readFileSync(main1St, 'utf8')) && /fbValve/.test(fs.readFileSync(main2St, 'utf8')),
            'the same in-project path (POUs/MAIN.st) is written once per project, each with its own code');
        assert(fs.existsSync(path.join(st1, 'POUs', 'Actuators', 'FB_Cylinder.st')) && fs.existsSync(path.join(st2, 'POUs', 'FB_Cylinder.st')),
            "each FB_Cylinder lands at its own project's path");
        assert(!fs.existsSync(path.join(tmp, 'ST_Files')), 'nothing is written into the workspace top-level ST_Files');
        assert(refreshed === 1, `the run ends with exactly one onStFilesWritten (one Objects-tree refresh) (${refreshed})`);
        assert(shown.length === 1 && /each project's ST_Files folder/.test(shown[0]), `one summary names each project's folder (${JSON.stringify(shown)})`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    reportCoverage(GATE, 'ran');
    if (errors) {
        console.error(`\n${errors} two-sample assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll two-sample assertions passed.');
})().catch((err) => { console.error(err); process.exit(1); });
