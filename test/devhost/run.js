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

    // The `.tctleo` watcher family (HANDOFF "probable bug"): a `.TcTLEO` declares a real ST enum
    // and the startup scan indexes it — but an EXTERNAL on-disk edit must ALSO reach the live
    // index through the change watcher, the path TWINCAT_WATCH_EXTS gates. Inject one into the
    // primary project so the in-host half can query it, edit it on disk, and query again.
    const tleoPath = path.join(primary, 'TcToolkitSample_PLC', 'DUTs', 'E_TleoState.TcTLEO');
    fs.writeFileSync(tleoPath,
        '<?xml version="1.0" encoding="utf-8"?>\r\n' +
        '<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">\r\n' +
        '  <EnumerationTextList Name="E_TleoState" Id="{4f21c9a7-90d5-4e0b-8a54-3f6f1b2f9c01}">\r\n' +
        '    <Declaration><![CDATA[TYPE E_TleoState :\r\n(\r\n\tIdle := 0,\r\n\tRunning := 1\r\n);\r\nEND_TYPE\r\n]]></Declaration>\r\n' +
        '  </EnumerationTextList>\r\n' +
        '</TcPlcObject>\r\n', 'utf8');
    const tleoPlcproj = path.join(primary, 'TcToolkitSample_PLC', 'TcToolkitSample_PLC.plcproj');
    const tleoProjText = fs.readFileSync(tleoPlcproj, 'utf8');
    const tleoProjChanged = tleoProjText.replace(
        '<Compile Include="POUs\\MAIN.TcPOU">',
        '<Compile Include="DUTs\\E_TleoState.TcTLEO">\r\n' +
        '      <SubType>Code</SubType>\r\n' +
        '    </Compile>\r\n' +
        '    <Compile Include="POUs\\MAIN.TcPOU">'
    );
    assert(tleoProjChanged !== tleoProjText, 'the dev-host fixture injects the .TcTLEO project include');
    fs.writeFileSync(tleoPlcproj, tleoProjChanged, 'utf8');

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
        // TCDEV_TEST is what makes the provider emit `media/devHostTestHook.js` into the webview
        // HTML. Nothing else sets it, so the hook is absent from every other run of the extension.
        env: { ...process.env, TCDEV_WS: ws, TCDEV_SAMPLE: primary, TCDEV_RESULTS: results, TCDEV_TEST: '1' },
        encoding: 'utf8',
        shell: true
    });
    if (launched.error) {
        console.error('[FAIL] could not launch VS Code:', launched.error.message);
        process.exit(1);
    }

    // The CLI returns immediately; poll for the in-host module's progressive results. The P8
    // webview phases add real wall time — debounces, LSP round trips and a close/reopen cycle.
    const deadline = Date.now() + 300000;
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

    // ------------------------------------------------------------------------------------------
    // The P8 / G4 webview checklist, item by item. Everything below was a manual walk in front of
    // an Extension Development Host until media/devHostTestHook.js made it drivable: the numbers
    // come off the real status indicator, the real Monaco markers and the real file bytes.
    // ------------------------------------------------------------------------------------------

    // Checklist 3 (accounting half) + 2: Manual Sync counts edits per component+pane, and the
    // record shape survives a real process boundary — the tab is CLOSED, so only the host's
    // pendingEditsStore carries the edits back into the rebuilt webview.
    const manual = step('p8-manual');
    assert(!!manual, 'the Manual Sync phase ran');
    assert(!!manual && manual.syncText === 'Manual Sync',
        `the sync toggle actually switched to Manual (got ${manual && manual.syncText})`);
    assert(!!manual && manual.statusAfterDecl === 'Unsaved Changes (1)',
        `a declaration edit counts one pending edit (got ${manual && manual.statusAfterDecl})`);
    assert(!!manual && manual.statusAfterImpl === 'Unsaved Changes (2)',
        `an implementation edit counts a second one (got ${manual && manual.statusAfterImpl})`);
    assert(!!manual && manual.statusAfterReEdit === 'Unsaved Changes (2)',
        `re-editing the same pane overwrites its record rather than adding one ` +
        `(got ${manual && manual.statusAfterReEdit})`);
    assert(!!manual && manual.statusAfterGetEdit === 'Unsaved Changes (3)',
        `an edit in the property Get accessor counts separately (got ${manual && manual.statusAfterGetEdit})`);
    assert(!!manual && manual.reopened, 'closing the tab disposed the webview and reopening resolved a new one');
    assert(!!manual && manual.statusAfterReopen === 'Unsaved Changes (3)',
        `pending edits survive close/reopen through the host's cache (got ${manual && manual.statusAfterReopen})`);
    assert(!!manual && manual.rootDeclRestored && manual.rootImplRestored,
        `both root panes are restored from the cached edits ` +
        `(decl ${manual && manual.rootDeclRestored}, impl ${manual && manual.rootImplRestored})`);
    assert(!!manual && manual.getRestored,
        'the Get accessor edit is restored into the Get accessor');
    assert(!!manual && !manual.setContaminated,
        'the Get accessor edit does NOT leak into the same-named Set (the xmlContext triple match)');

    // Reload survival. Closing the tab keeps the extension host alive, so the assertions above pass
    // even against a purely in-memory cache; a Ctrl+R does not. What makes the edits survive one is
    // that they are PERSISTED, so assert the workspaceState entry itself — read through the real
    // ExtensionContext, captured from the provider instance in testRunner.js.
    assert(!!manual && manual.workspaceStateReachable,
        'the harness reached the real ExtensionContext workspaceState');
    assert(!!manual && manual.persistedEditCount === 3,
        `all three pending edits are persisted in workspaceState, not just held in memory ` +
        `(got ${manual && manual.persistedEditCount})`);
    assert(!!manual && manual.persistedFingerprinted,
        'the persisted entry carries a document fingerprint (so a changed file discards it)');

    // Checklist 3 (save half): the strongest form of "everything outside the two edited CDATA
    // blocks is byte-identical" — the whole file must equal foldEdits over the posted records.
    const sync = step('p8-sync');
    assert(!!sync, 'the Manual Sync flush phase ran');
    assert(!!sync && sync.status === 'Synced' && !sync.documentDirty,
        `flushing leaves the status Synced and the document clean ` +
        `(status ${sync && sync.status}, dirty ${sync && sync.documentDirty})`);
    assert(!!sync && sync.persistedAfterFlush === false,
        `the flush clears the persisted pending-edit entry ` +
        `(still present: ${sync && sync.persistedAfterFlush})`);
    assert(!!sync && sync.byteIdentical,
        `the flushed file is byte-identical to foldEdits over the webview's own records ` +
        `(firstDiffIndex ${sync && sync.firstDiffIndex}, len ${sync && sync.afterLen} vs ` +
        `${sync && sync.expectedLen}; on disk ${sync && sync.afterExcerpt}; ` +
        `expected ${sync && sync.expectedExcerpt})`);

    // Checklist 4: the flush-vs-save asymmetry. takeAll() is symmetric — only the call sites keep
    // an empty manual save posting 'save' and running the native save.
    const flush = step('p8-flush');
    assert(!!flush, 'the flush-vs-save asymmetry phase ran');
    assert(!!flush && flush.savePostedAfterSync,
        'a manual save with zero pending edits still posts "save" to the host');
    assert(!!flush && flush.saveEditCount === 0,
        `that save carries an EMPTY edit list (got ${flush && flush.saveEditCount})`);
    assert(!!flush && !flush.documentDirty && flush.bytesUnchanged,
        `the empty fold is a no-op: document clean, bytes untouched ` +
        `(dirty ${flush && flush.documentDirty}, unchanged ${flush && flush.bytesUnchanged})`);

    // Checklist 7: Auto Sync is untouched — a keystroke still round-trips an 'edit' message and
    // the file the host writes from it matches replaceComponentCdata over that same record.
    const auto = step('p8-auto');
    assert(!!auto, 'the Auto Sync phase ran');
    assert(!!auto && auto.saved, 'an Auto-mode edit reaches disk without any explicit save');
    assert(!!auto && auto.byteIdentical,
        `the auto-saved file is byte-identical to replaceComponentCdata over the posted edit ` +
        `(firstDiffIndex ${auto && auto.firstDiffIndex}; on disk ${auto && auto.diskExcerpt}; ` +
        `expected ${auto && auto.expectedExcerpt})`);

    // Checklist 6: real markers with REAL monaco.MarkerSeverity values (the browser harness feeds
    // sentinels), in the right pane, including the Action case where the declaration pane is
    // hidden and editor.js's `display !== 'none'` guards are the only thing preventing a throw.
    const diag = step('p8-diag');
    assert(!!diag, 'the diagnostics phase ran');
    const errorSeverity = diag && diag.markerSeverityError;
    const implErrors = (rows) => (rows || []).filter(m => m.pane === 'impl' && m.severity === errorSeverity);
    assert(typeof errorSeverity === 'number',
        `the page reported a real monaco.MarkerSeverity.Error value (got ${errorSeverity})`);
    assert(!!diag && implErrors(diag.rootMarkers).length >= 1,
        `an undeclared variable marks the implementation pane with a real Error severity ` +
        `(got ${diag ? JSON.stringify(diag.rootMarkers) : 'no result'})`);
    assert(!!diag && diag.actionDeclVisible === false,
        `the Action component collapses its declaration pane (got ${diag && diag.actionDeclVisible})`);
    assert(!!diag && implErrors(diag.actionMarkers).length >= 1,
        `the collapsed-declaration component still marks its implementation pane ` +
        `(got ${diag ? JSON.stringify(diag.actionMarkers) : 'no result'})`);
    assert(!!diag && (diag.errors || []).length === 0,
        `no webview error was thrown while marking a component with a hidden pane ` +
        `(got ${diag ? JSON.stringify(diag.errors) : 'no result'})`);

    // Checklist 5a: cross-file Go to Definition selects the EXACT word in the other file — the
    // 0.6.3 bug landed on the first same-named occurrence (a header comment) instead.
    const goto = step('p8-goto');
    assert(!!goto && !!goto.member, `the phase found a GVL_System member to navigate from (got ${goto && goto.member})`);
    assert(!!goto && !!goto.selectionText && !!goto.member &&
        goto.selectionText.toLowerCase() === goto.member.toLowerCase(),
        `Go to Definition selects exactly "${goto && goto.member}" in the target file ` +
        `(got ${goto ? JSON.stringify(goto.selection) : 'no result'})`);
    assert(!!goto && goto.selectionApplied,
        'the target webview acked the selection with selectionApplied');

    // Checklist 5b: a peek entry from another file drives the host, and the origin webview's peek
    // must dismiss — Monaco cannot do it itself when the navigation leaves through the host.
    const peek = step('p8-peek');
    assert(!!peek && peek.peekOpened, 'Find All References opens the peek widget in the real webview');
    assert(!!peek && !peek.errorPosted,
        'opening the peek posts no webview `error` to the host (the ResizeObserver loop notice must not blank the editor)');
    assert(!!peek && peek.fileGroupExpanded,
        `the other file's group is present in the peek and could be expanded ` +
        `(got ${peek ? JSON.stringify(peek.expandedRowText) : 'no result'})`);
    assert(!!peek && peek.rowFound,
        `a cross-file peek row was found to double-click (got ${peek ? JSON.stringify(peek.rowText) : 'no result'})`);
    assert(!!peek && peek.openFilePosted,
        `double-clicking that row posts openFile to the extension host ` +
        `(clicked ${peek ? JSON.stringify(peek.rowText) : 'nothing'}; rows ` +
        `${peek ? JSON.stringify(peek.rows) : 'none'})`);
    assert(!!peek && peek.peekDismissed,
        'the peek widget is dismissed after navigating out of it (the deferred closeReferencePeek)');

    // The .tctleo watcher family: the baseline proves scan-time indexing already covers the
    // extension; the renamed probe proves the change watcher pushes an external .TcTLEO edit to
    // the live index (the HANDOFF probable bug — TWINCAT_WATCH_EXTS omitting .tctleo fails this).
    const tleo = step('tctleo-watch');
    assert(!!tleo && !!tleo.baselineUri && /E_TleoState\.TcTLEO$/i.test(tleo.baselineUri),
        `the startup scan indexes the injected .TcTLEO (definition uri: ${tleo && tleo.baselineUri})`);
    assert(!!tleo && !!tleo.renamedUri && /E_TleoState\.TcTLEO$/i.test(tleo.renamedUri),
        `an external .TcTLEO edit reaches the live index via the change watcher ` +
        `(definition uri: ${tleo && tleo.renamedUri})`);

    // Project-aware Generate ST: the picker lists all three projects, a full export writes each
    // project's objects under its own ST_Files subtree (LineA/LineB MAINs never collide), and a
    // subset export writes only the chosen project.
    const gen = step('generate-st');
    assert(!!gen && !gen.error, 'the project-aware Generate ST phase ran without throwing' + (gen && gen.error ? ': ' + gen.error : ''));
    assert(!!gen && Array.isArray(gen.pickerLabels) && gen.pickerLabels.length === 3,
        `listProjects() offers all three projects to the picker (got ${gen ? JSON.stringify(gen.pickerLabels) : 'no result'})`);
    assert(!!gen && gen.lineAMain && gen.lineBMain && gen.auxMain,
        `each project's MAIN is written under its own folder — identical paths do NOT collide ` +
        `(A=${gen && gen.lineAMain}, B=${gen && gen.lineBMain}, Aux=${gen && gen.auxMain})`);
    assert(!!gen && gen.stationNested,
        `a nested object keeps its in-project path (LineA/.../POUs/Machine/FB_Station.st: ${gen && gen.stationNested})`);
    assert(!!gen && gen.subset && gen.subset.auxWritten && gen.subset.plcSkipped,
        `a subset export writes only the chosen project (aux=${gen && gen.subset && gen.subset.auxWritten}, ` +
        `plc-skipped=${gen && gen.subset && gen.subset.plcSkipped})`);

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
