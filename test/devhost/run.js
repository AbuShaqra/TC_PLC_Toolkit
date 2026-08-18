/**
 * @file test/devhost/run.js
 * @description The automated dev-host pass — launches the INSTALLED VS Code as a separate instance
 * (fresh user-data/extensions dirs, so a running VS Code is untouched), loads this repo as a
 * development extension, and drives ./testRunner.js inside its extension host against two temp
 * copies of the committed sample project. This reaches the links nothing headless can:
 * vscode.openWith() uri identity (tab reuse vs duplicate) and the live vscode-languageclient
 * transport.
 *
 * NOT part of `npm test`: it needs an installed VS Code and opens a real (visible) window for
 * ~30 s, which closes itself. Run it by hand whenever navigation identity, the custom-editor
 * resolve chain, or the LSP bridge wiring changes:
 *
 *     node test/devhost/run.js
 *
 * Exit codes: 0 pass, 1 an assertion failed or the run never completed, 2 cannot run (no VS Code).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SAMPLE = path.join(REPO, 'sample', 'TcToolkitSample');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// The CLI shim (bin/code.cmd on Windows, `code` elsewhere) forwards args correctly; the Electron
// binary itself rejects them when invoked directly.
function findCodeCli() {
    const candidates = process.platform === 'win32'
        ? [
            path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft VS Code', 'bin', 'code.cmd'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd')
        ]
        : ['/usr/local/bin/code', '/usr/bin/code'];
    return candidates.find(c => c && fs.existsSync(c)) || null;
}

(async () => {
    if (!fs.existsSync(SAMPLE)) {
        console.error('[SKIP] sample/TcToolkitSample is missing — nothing to open.');
        process.exit(2);
    }
    const cli = findCodeCli();
    if (!cli) {
        console.error('[SKIP] no installed VS Code CLI found — this harness needs a real VS Code.');
        process.exit(2);
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_devhost_'));
    const ws = path.join(work, 'ws');
    const primary = path.join(ws, 'LineA');
    const results = path.join(work, 'results.json');
    fs.cpSync(SAMPLE, primary, { recursive: true });
    fs.cpSync(SAMPLE, path.join(ws, 'LineB'), { recursive: true });

    // LineA contains TWO PLC projects under one real solution. This catches the hierarchy shape a
    // pair of one-project solutions cannot: Solution → [primary PLC, auxiliary PLC]. The auxiliary
    // project is a complete copied fixture so the LSP also has to keep all three compilation units
    // isolated while the Objects provider groups two of them together.
    const primaryProjectDir = path.join(primary, 'TcToolkitSample_PLC');
    const auxiliaryProjectDir = path.join(primary, 'TcToolkitSample_Aux');
    fs.cpSync(primaryProjectDir, auxiliaryProjectDir, { recursive: true });
    fs.renameSync(
        path.join(auxiliaryProjectDir, 'TcToolkitSample_PLC.plcproj'),
        path.join(auxiliaryProjectDir, 'TcToolkitSample_Aux.plcproj')
    );
    const primaryTsproj = path.join(primary, 'TcToolkitSample.tsproj');
    const tsprojText = fs.readFileSync(primaryTsproj, 'utf8');
    fs.writeFileSync(primaryTsproj, tsprojText.replace(
        '</Plc>',
        '\t\t\t<Project File="TcToolkitSample_Aux.xti"/>\r\n\t\t</Plc>'
    ), 'utf8');
    fs.writeFileSync(
        path.join(primary, '_Config', 'PLC', 'TcToolkitSample_Aux.xti'),
        '<?xml version="1.0"?>\r\n<TcSmItem>\r\n' +
        '\t<Project Name="TcToolkitSample_Aux" ' +
        'PrjFilePath="..\\..\\TcToolkitSample_Aux\\TcToolkitSample_Aux.plcproj"/>\r\n' +
        '</TcSmItem>\r\n',
        'utf8'
    );

    // Reproduce a real TwinCAT case-only folder rename: the `.plcproj` kept `machine`, while the
    // directory on disk is `Machine`. Windows resolves the include, but VS Code URI identity is
    // case-sensitive, so the index must canonicalize it to the explorer/custom-editor spelling.
    // POSIX cannot represent this as an existing include and therefore leaves the fixture alone.
    if (process.platform === 'win32') {
        const primaryPlcproj = path.join(primary, 'TcToolkitSample_PLC', 'TcToolkitSample_PLC.plcproj');
        const text = fs.readFileSync(primaryPlcproj, 'utf8');
        const changed = text.replace(
            'Include="POUs\\Machine\\FB_Station.TcPOU"',
            'Include="POUs\\machine\\FB_Station.TcPOU"'
        );
        assert(changed !== text, 'the dev-host fixture contains the FB_Station project include');
        fs.writeFileSync(primaryPlcproj, changed, 'utf8');
    }

    const args = [
        '--new-window',
        '--user-data-dir', path.join(work, 'udd'),
        '--extensions-dir', path.join(work, 'ext'),
        '--extensionDevelopmentPath', REPO,
        '--extensionTestsPath', path.join(__dirname, 'testRunner.js'),
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        ws
    ];
    // One explicitly quoted command line: the CLI is a .cmd on Windows (needs a shell), and
    // shell:true with an args ARRAY concatenates without quoting — a path with spaces
    // ("Program Files") then splits mid-argument.
    const quote = (s) => /[\s&()^]/.test(s) ? `"${s}"` : s;
    const launched = spawnSync([cli, ...args].map(quote).join(' '), {
        env: { ...process.env, TCDEV_WS: ws, TCDEV_SAMPLE: primary, TCDEV_RESULTS: results },
        encoding: 'utf8',
        shell: true
    });
    if (launched.error) {
        console.error('[FAIL] could not launch VS Code:', launched.error.message);
        process.exit(1);
    }

    // The CLI returns immediately; poll for the in-host module's progressive results.
    const deadline = Date.now() + 180000;
    let data = null;
    while (Date.now() < deadline) {
        if (fs.existsSync(results)) {
            try { data = JSON.parse(fs.readFileSync(results, 'utf8')); } catch (e) { /* mid-write */ }
            if (data && data.steps.some(s => s.step === 'done' || s.step === 'CRASH' || s.step === 'no-extension')) break;
        }
        await new Promise(r => setTimeout(r, 5000));
    }

    if (!data) {
        console.error('[FAIL] the dev host never wrote results — did the window fail to start?');
        process.exit(1);
    }
    const step = (name) => data.steps.find(s => s.step === name);

    assert(!step('CRASH'), 'the in-host run completed without crashing' + (step('CRASH') ? ': ' + step('CRASH').error : ''));
    assert(!!step('done'), 'the in-host run reached the end');

    const multi = step('multi-project-ui');
    const expectedSolutions = ['TcToolkitSample — LineA', 'TcToolkitSample — LineB'];
    assert(!!multi && expectedSolutions.every(label => multi.solutionLabels.includes(label)),
        `the real Objects provider renders both solution roots (got ${multi ? JSON.stringify(multi.solutionLabels) : 'no result'})`);
    const lineAProjects = multi && multi.solutionProjects['TcToolkitSample — LineA'];
    const lineBProjects = multi && multi.solutionProjects['TcToolkitSample — LineB'];
    assert(!!lineAProjects && lineAProjects.join(',') === 'TcToolkitSample_Aux,TcToolkitSample_PLC',
        `one solution renders both PLC projects (got ${JSON.stringify(lineAProjects)})`);
    assert(!!lineBProjects && lineBProjects.join(',') === 'TcToolkitSample_PLC',
        `the second solution renders its PLC project (got ${JSON.stringify(lineBProjects)})`);
    const expectedStatusLabels = ['TcToolkitSample_PLC — LineA', 'TcToolkitSample_PLC — LineB'];
    assert(!!multi && expectedStatusLabels.every(label => multi.statusLabels.includes(label)),
        `the real status-bar formatter uses the same project labels (got ${multi ? JSON.stringify(multi.statusLabels) : 'no result'})`);
    if (process.platform === 'win32') {
        const expectedStation = path.join(primary, 'TcToolkitSample_PLC', 'POUs', 'Machine', 'FB_Station.TcPOU');
        assert(!!multi && multi.indexedStationPath === expectedStation,
            `stale .plcproj casing canonicalizes to the real editor path ` +
            `(got ${multi ? JSON.stringify(multi.indexedStationPath) : 'no result'})`);
    }

    // The Objects-tree insert commands reach the webview's caret. Their module is vscode-bound, so
    // the pure template logic (test_object_insert.js) is all a Node harness can cover — this proves
    // the other half: tree node → XML parse → template → posted into the active pane.
    const ins = step('object-insert');
    const inserted = (ins && ins.inserted) || [];
    assert(inserted.length === 2,
        `both insert commands posted text to the webview (got ${inserted.length}: ${JSON.stringify(inserted)})`);
    assert(inserted[0] === 'FB_Cylinder',
        `Insert at Cursor posted the object's bare name (got ${JSON.stringify(inserted[0])})`);
    assert(typeof inserted[1] === 'string' && /^FB_init\(/.test(inserted[1]) && inserted[1].includes(':='),
        `Insert Definition at Cursor posted a filled call template (got ${JSON.stringify(inserted[1])})`);

    // The custom editor chain: resolve ran, the webview said ready, the host sent init (a break
    // anywhere here is a permanently blank viewer).
    const panel = (data.panels || [])[0];
    assert(!!panel && panel.textLen > 0, 'resolveCustomTextEditor ran with a non-empty document');
    assert(!!panel && panel.fromWebview.includes('ready') && panel.toWebview.includes('init'),
        `the resolve → ready → init chain completed (${panel ? JSON.stringify({ from: panel.fromWebview, to: panel.toWebview }) : 'no panel'})`);

    // The live LSP bridge, and the uri-casing contract navigation identity depends on.
    const lsp = step('lsp');
    assert(!!lsp && !!lsp.definition, 'the live LSP client resolves a cross-file definition');
    assert(!!lsp && !!lsp.definition && lsp.definition.uri.includes('GVLs/GVL_System.TcGVL'),
        `the definition uri keeps the on-disk spelling (got ${lsp && lsp.definition && lsp.definition.uri})`);
    assert(!!lsp && lsp.refCount > 0, `references flow through the live client (got ${lsp && lsp.refCount})`);
    if (process.platform === 'win32') {
        const expectedStation = path.join(primary, 'TcToolkitSample_PLC', 'POUs', 'Machine', 'FB_Station.TcPOU');
        // URI conversion conventionally lowercases the drive letter; every descendant character is
        // still identity-significant to VS Code and must match the editor path exactly.
        const hasStation = !!lsp && lsp.referenceFsPaths.some(p =>
            p.length === expectedStation.length &&
            p[0].toLowerCase() === expectedStation[0].toLowerCase() &&
            p.slice(1) === expectedStation.slice(1));
        assert(hasStation,
            `references use the real-cased FB_Station editor URI ` +
            `(got ${lsp ? JSON.stringify(lsp.referenceFsPaths) : 'no result'})`);
    }

    // Navigating with that uri must REUSE the open tab — the 2026-08-10 regression opened
    // "gvl_system.tcgvl" as a second tab here.
    const nav = step('after-def-nav');
    const gvlTabs = nav ? nav.tabs.filter(t => /gvl_system\.tcgvl/i.test(t)) : [];
    assert(gvlTabs.length === 1 && gvlTabs[0] === 'GVL_System.TcGVL',
        `definition navigation reuses the open tab with its real-cased title (tabs: ${nav ? JSON.stringify(nav.tabs) : 'none'})`);

    // The final Objects-tree reveal follows the component the webview loaded, not the earlier
    // active-file root reveal. These are the real TreeView.reveal calls and `ok` means VS Code
    // accepted the provider's complete parent chain.
    const componentReveal = step('component-tree-reveal');
    const revealRows = (componentReveal && componentReveal.reveals) || [];
    for (const componentId of (componentReveal && componentReveal.requested) || []) {
        const hit = revealRows.find(r => r.componentId === componentId && r.ok);
        assert(!!hit, `Objects tree reveals exact ${componentId} target in the real host`);
    }
    const getterReveal = revealRows.find(r => r.componentId === 'prop_State_get' && r.ok);
    const setterReveal = revealRows.find(r => r.componentId === 'prop_State_set' && r.ok);
    assert(!!getterReveal && getterReveal.parents[0] === 'prop_State',
        `Get reveal expands through its property (${getterReveal ? JSON.stringify(getterReveal.parents) : 'missing'})`);
    assert(!!setterReveal && setterReveal.parents[0] === 'prop_State',
        `Set reveal expands through its property (${setterReveal ? JSON.stringify(setterReveal.parents) : 'missing'})`);
    const actionReveal = revealRows.find(r => r.componentId === 'action_Act_Home' && r.ok);
    assert(!!actionReveal && actionReveal.parents.includes('Actions\\'),
        `virtual-folder action reveal expands through Actions\\ (${actionReveal ? JSON.stringify(actionReveal.parents) : 'missing'})`);
    assert(!!actionReveal && actionReveal.parents.includes('TcToolkitSample_PLC') &&
        actionReveal.parents.includes('TcToolkitSample — LineA'),
        `exact component reveal expands through its PLC project and solution ` +
        `(${actionReveal ? JSON.stringify(actionReveal.parents) : 'missing'})`);

    const retainedReveal = step('retained-component-tree-reveal');
    const retainedRows = (retainedReveal && retainedReveal.reveals) || [];
    const retainedLast = retainedRows[retainedRows.length - 1];
    assert(!!retainedLast && retainedLast.ok && retainedLast.componentId === 'method_Cyclic',
        `tab-away/tab-back keeps the retained webview's exact component ` +
        `(got ${retainedLast ? retainedLast.componentId : 'no reveal'})`);

    // The window is still shutting down when the poll returns, so its user-data dir can hold a
    // lock for a few more seconds. Best-effort with retries; a leftover temp dir is harmless.
    try {
        fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 2000 });
    } catch (e) {
        console.log(`(cleanup skipped: ${e.code} on ${work} — the OS temp cleaner will get it)`);
    }
    console.log(errors === 0 ? '\nAll dev-host assertions passed.' : `\n${errors} dev-host assertion(s) FAILED.`);
    process.exit(errors ? 1 : 0);
})();
