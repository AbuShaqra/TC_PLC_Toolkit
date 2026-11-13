/**
 * @file test_xae_build_commands.js
 * @description The VS Code half of Build through XAE (roadmap R14) — src/commands/xaeBuildCommands.js
 * and its hooks in src/customEditorProvider.js — under a stubbed `vscode` module and the fake driver
 * (test/_fakeXaeDriver.js). No PowerShell, no XAE.
 *
 * Pinned: the headless switch reaches the driver (setting false → no -ShowWindow, true → -ShowWindow,
 * and the dropdown's checkbox changes the next spawn); the channel states the requested mode and then
 * the mode that ran; Problems go to `twincat-xae` only (Compile Project's collections untouched, both
 * sources' pane markers shown together); activation lists targets, asks a modal every time, spawns
 * nothing when it is dismissed and passes exactly the confirmed NetId; cancel goes through the cancel
 * file (exit 4, nothing killed), then the force stop kills PowerShell's tree and only a shell the run
 * started (and only while it is an XAE Shell); no cancel during target/activation, also when activation
 * begins inside the grace period; the timeout, and its extension when it falls in activation; the
 * stall offer re-runs with the window shown, but not after a run that finished or refused the stop;
 * a run that stopped before a build result (or an unconfirmed exit 1) keeps the previous Problems;
 * a Problems entry links back to its component; the non-Windows refusal; one run at a time; a
 * configuration the solution does not declare; the project's XAE Shell missing (sample 2, a
 * `.tspproj`): one question per build, before the run or after the driver's fatal, then exactly
 * `-TcVersion <ProgId> -AllowVersionMismatch`; never for activation.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createFakeXaeSpawn, readFixture } = require('./_fakeXaeDriver');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const REPO = path.join(__dirname, '..');
const SLN = path.join(REPO, 'sample', 'TcToolkitSample', 'TcToolkitSample.sln');
const FB = path.join(REPO, 'sample', 'TcToolkitSample', 'TcToolkitSample_PLC', 'POUs', 'Machine', 'FB_Station.TcPOU');
if (!fs.existsSync(SLN) || !fs.existsSync(FB)) {
    console.log('SKIP: sample/TcToolkitSample is missing.');
    process.exit(0);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_xae_commands_'));

// ── A recording `vscode` stub ───────────────────────────────────────────────────────────────────
const calls = { executed: [], errors: [], infos: [], warnings: [], modals: [], progress: [], updates: [], picks: [] };
const handlers = new Map();
const answers = { quickPick: [], message: [], stall: undefined };
const settings = {
    'tcToolkit.xaeShell.path4026': __filename,
    'tcToolkit.xaeBuild.timeoutMinutes': 240
};
const workspaceSettings = {};
const listeners = { config: [] };
const fireConfig = (full) => listeners.config.slice().forEach(fn => fn({ affectsConfiguration: (sec) => full === sec || full.startsWith(sec + '.') }));
const uri = (p) => ({ fsPath: p, scheme: 'file', path: p, query: '', toString: () => 'file://' + p.split(path.sep).join('/') });
class Range { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
const collections = [];
const uriHandlers = [];
/** The progress token of the run in progress; `cancel()` fires its cancellation. */
let currentToken = null;
const message = (bucket) => async (m, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : null;
    if (/no progress/.test(m)) { calls.warnings.push({ m, buttons: rest, stall: true }); return answers.stall; }
    (opts && opts.modal ? calls.modals : calls[bucket]).push({ m, buttons: rest, opts });
    return answers.message.shift();
};
const channels = [];
const vscodeStub = {
    Uri: {
        file: uri,
        parse: (s) => { const u = new URL(s); return { scheme: u.protocol.slice(0, -1), authority: u.host, path: u.pathname, query: u.search.slice(1), fsPath: s, toString: () => s }; }
    },
    Range, Diagnostic,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    StatusBarAlignment: { Left: 1 },
    ProgressLocation: { Notification: 15 },
    env: { uriScheme: 'vscode' },
    languages: {
        createDiagnosticCollection: (name) => {
            const map = new Map();
            const c = { name, map, set: (u, d) => map.set(u.toString(), d), delete: (u) => map.delete(u.toString()), clear: () => map.clear(), dispose() {} };
            collections.push(c);
            return c;
        }
    },
    workspace: {
        textDocuments: [],
        getConfiguration: (section) => ({
            get: (key, fallback) => {
                const full = `${section}.${key}`;
                if (Object.prototype.hasOwnProperty.call(workspaceSettings, full)) return workspaceSettings[full];
                return Object.prototype.hasOwnProperty.call(settings, full) ? settings[full] : fallback;
            },
            inspect: (key) => ({ globalValue: settings[`${section}.${key}`], workspaceValue: workspaceSettings[`${section}.${key}`] }),
            update: async (key, value, target) => {
                const full = `${section}.${key}`;
                const bucket = target === 2 ? workspaceSettings : settings;
                if (value === undefined) delete bucket[full]; else bucket[full] = value;
                calls.updates.push({ key: full, value, target });
                fireConfig(full);
            }
        }),
        onDidChangeConfiguration: (fn) => { listeners.config.push(fn); return { dispose() {} }; },
        onDidChangeTextDocument: () => ({ dispose() {} })
    },
    window: {
        createStatusBarItem: () => ({ text: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }),
        showQuickPick: async (items, opts) => {
            calls.picks.push({ items, opts });
            const want = answers.quickPick.shift();
            return want === undefined ? undefined : (typeof want === 'function' ? items.find(want) : items.find(i => i.label === want || i.netId === want || i.key === want));
        },
        showErrorMessage: message('errors'),
        showInformationMessage: message('infos'),
        showWarningMessage: message('warnings'),
        withProgress: async (opts, task) => {
            calls.progress.push(opts);
            const cancelListeners = [];
            const reports = [];
            const token = {
                isCancellationRequested: false,
                onCancellationRequested: (fn) => { cancelListeners.push(fn); return { dispose() {} }; },
                cancel() { this.isCancellationRequested = true; cancelListeners.forEach(fn => fn()); },
                reports
            };
            currentToken = token;
            return task({ report: (v) => reports.push(v) }, token);
        },
        registerUriHandler: (h) => { uriHandlers.push(h); return { dispose() {} }; },
        createOutputChannel: (name) => {
            const ch = { name, lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} };
            channels.push(ch);
            return ch;
        }
    },
    commands: {
        registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() {} }; },
        executeCommand: async (id, ...args) => {
            calls.executed.push({ id, args });
            return handlers.has(id) ? handlers.get(id)(...args) : undefined;
        }
    }
};
const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.apply(this, arguments);
};

const { registerXaeBuildCommands, OUTPUT_CHANNEL_NAME, DIAGNOSTIC_SOURCE, LAST_TARGET_KEY, CANCEL_REFUSED_TEXT, LAUNCH_STOP_TEXT, PLATFORM_TEXT, STALL_RERUN, projectTcBuild } =
    require('../src/commands/xaeBuildCommands');
const { registerCompileCommands } = require('../src/commands/compileCommands');
const { TwinCatCustomEditorProvider } = require('../src/customEditorProvider');

// ── Provider, maps, the fake driver ─────────────────────────────────────────────────────────────
const memento = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { m.set(k, v); return Promise.resolve(); } }; };
const context = {
    subscriptions: [], extensionPath: REPO, extensionUri: uri(REPO), extension: { id: 'pub.twincat-plc-toolkit' },
    globalState: memento(), workspaceState: memento()
};
const project = { key: 'a', name: 'TcToolkitSample_PLC', dir: path.dirname(FB), objectFiles: new Map([[FB.toLowerCase(), FB]]) };
const projectMap = () => ({
    projects: new Map([['a', project]]), keys: () => ['a'], get: () => project, displayName: () => project.name,
    ownersOf: (p) => (p === FB ? ['a'] : [])
});
/** The solution the project resolves to (sample 2 for the shell-offer tests). */
let slnPath = SLN;
const solutionMap = () => ({ solutionForProject: (k) => (k === 'a' ? { slnPath } : null) });
const SLN2 = path.join(REPO, 'sample', 'TcToolkitSample2', 'TcToolkitSample2.sln');
/** What the pre-run shell check's registry detection finds (id → hit). */
let detected = {};
const provider = new TwinCatCustomEditorProvider(context, { getProjectMap: projectMap });
const fbUri = uri(FB);
const panelPosts = [];
provider.activePanels.set(fbUri.toString(), { webview: { postMessage: (m) => { panelPosts.push(m); return Promise.resolve(true); } } });

/** What the next driver spawn does: (call) => behaviour (see _fakeXaeDriver.js). */
let driver = () => ({ fixture: 'build-ok-headless' });
const fake = createFakeXaeSpawn((call) => (call.args.includes('-ListTargets') ? { fixture: 'list-targets' } : driver(call)));
const compileFake = { spawn: () => { throw new Error('the compiler is not run here'); } };

registerCompileCommands(context, { provider, getProjectMap: projectMap, spawn: compileFake.spawn });
const api = registerXaeBuildCommands(context, {
    provider, getProjectMap: projectMap, getSolutionMap: solutionMap, spawn: fake.spawn, execFile: fake.execFile,
    platform: 'win32', minuteMs: 10, graceMs: 40, stallCheckMs: 5, tmpDir: TMP, detectShells: async () => detected
});
const xaeCollection = collections.find(c => c.name === 'twincat-xae');
const compileCollection = collections.find(c => c.name === 'twincat-compile');
const gppCollection = collections.find(c => c.name === 'twincat-gpp');
const run = (id, args) => vscodeStub.commands.executeCommand(id, args);
const channel = () => channels.find(c => c.name === OUTPUT_CHANNEL_NAME);
const lastSpawn = () => fake.calls[fake.calls.length - 1];
const builds = () => fake.calls.filter(c => !c.args.includes('-ListTargets'));
const waitFor = async (cond, ms = 2000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 2)); return cond(); };
const rows = (name) => readFixture(name).lines;

(async () => {
    // ── The headless switch reaches the driver ──────────────────────────────────────────────────
    assert(projectTcBuild(SLN, fs) === '4026', 'the project build number is read from the .tsproj the .sln references');
    let r = await run('twincat.xaeBuild', {});
    let argv = lastSpawn().args;
    assert(lastSpawn().command === 'powershell.exe' && argv.includes('-STA') && argv[argv.indexOf('-File') + 1].endsWith(path.join('resources', 'xae', 'build-plc-project.ps1')),
        'the driver is resources/xae/build-plc-project.ps1 under powershell.exe -STA');
    assert(!argv.includes('-ShowWindow'), 'setting false (default) → the argv has NO -ShowWindow');
    assert(argv[argv.indexOf('-SlnPath') + 1] === SLN && !argv.includes('-ActivateConfiguration') && argv.includes('-CancelFile'), 'the solution of the project, no activation, a cancel file');
    assert(r.ok && r.exitCode === 0 && /^XAE window during the build: hidden \(SuppressUI=True, MainWindow\.Visible=False\) - headless\./.test(r.uiMode), 'a clean headless build');
    const lines = channel().lines;
    assert(lines.some(l => /Requested: headless \(XAE window hidden, UI suppressed\)/.test(l)), 'the channel header states the requested mode');
    assert(lines.some(l => /XAE window during the build: hidden \(SuppressUI=True, MainWindow\.Visible=False\) - headless\./.test(l)), 'the channel prints the mode that ran');
    assert(lines.includes('BUILD SUCCEEDED.') && !lines.some(l => l.startsWith('@@TCTK')), 'the driver\'s human lines are shown, its event lines are not');
    assert(calls.infos.some(i => /succeeded/.test(i.m)), 'an information notification');

    settings['tcToolkit.xaeBuild.showWindow'] = true;
    driver = () => ({ fixture: 'build-ok-visible' });
    r = await run('twincat.xaeBuild', {});
    argv = lastSpawn().args;
    assert(argv.filter(a => a === '-ShowWindow').length === 1, 'setting true → the argv has -ShowWindow (once)');
    assert(/visible \(requested\)/.test(r.uiMode) && channel().lines.some(l => /Requested: XAE window shown for the whole run/.test(l)), 'the channel says visible was requested and ran');

    // The dropdown's checkbox, through the editor provider: the next spawn follows it.
    await provider.xaeSource.set('showWindow', false);
    assert(settings['tcToolkit.xaeBuild.showWindow'] === false && calls.updates.some(u => u.key === 'tcToolkit.xaeBuild.showWindow' && u.value === false && u.target === 1),
        'setXaeOption writes tcToolkit.xaeBuild.showWindow (user scope)');
    assert(panelPosts.some(m => m.type === 'xaeOptions' && m.options.available === true && m.options.showWindow === false), 'open editors get the new xaeOptions');
    driver = () => ({ fixture: 'build-ok-headless' });
    await run('twincat.xaeBuild', {});
    assert(!lastSpawn().args.includes('-ShowWindow'), 'after unticking, the next spawn is headless');
    await api.setXaeOption('showWindow', true);
    await run('twincat.xaeBuild', {});
    assert(lastSpawn().args.includes('-ShowWindow'), 'after ticking, the next spawn has -ShowWindow');
    assert(await api.setXaeOption('other', true) === false, 'any other key is refused');
    workspaceSettings['tcToolkit.xaeBuild.showWindow'] = true;
    await api.setXaeOption('showWindow', false);
    assert(workspaceSettings['tcToolkit.xaeBuild.showWindow'] === false, 'a workspace value is written in the workspace scope');
    delete workspaceSettings['tcToolkit.xaeBuild.showWindow'];
    settings['tcToolkit.xaeBuild.showWindow'] = false;

    // ── Problems: twincat-xae only, pane markers alongside Compile Project's ───────────────────
    compileCollection.map.set('file:///compile-marker', ['kept']);
    gppCollection.map.set('file:///gpp-marker', ['kept']);
    driver = () => ({ lines: rows('errors-errorlist').map(l => (l.t === 'errorItem' && l.file ? { ...l, file: 'TcToolkitSample_PLC\\POUs\\Machine\\FB_Station.TcPOU' } : l)), exit: 1 });
    r = await run('twincat.xaeBuild', {});
    const diags = xaeCollection.map.get(fbUri.toString()) || [];
    assert(!r.ok && r.exitCode === 1 && r.total === 3 && r.placed === 2, 'exit 1: 3 errors, 2 placed');
    assert(diags.length === 2 && diags.every(d => d.source === DIAGNOSTIC_SOURCE) && /\[implementation line 3\]$/.test(diags[0].message) && /location approximate/.test(diags[1].message),
        'the placed errors are in twincat-xae with source "TC Toolkit XAE build" and the pane location');
    assert(compileCollection.map.get('file:///compile-marker')[0] === 'kept' && gppCollection.map.get('file:///gpp-marker')[0] === 'kept',
        'Compile Project\'s twincat-compile and twincat-gpp collections are untouched');
    assert(api.problems().length === 2 && provider.compileSource.paneDiagnostics(fbUri.toString()).length === 2, 'the XAE problems reach the editor panes');
    assert(channel().lines.some(l => /error \(not placed\): Build aborted/.test(l)), 'an unplaced error is listed in the channel');
    assert(calls.errors.some(e => /3 errors \(2 placed in Problems\)/.test(e.m) && e.buttons.includes('Go to Problem…')), 'the summary counts placed errors and offers Go to Problem');
    // The entry's code links back into the extension: the URI handler opens the component and pane.
    const link = diags[0].code && diags[0].code.target;
    assert(link && link.path === '/xaeProblem' && /^id=\d+$/.test(link.query) && link.authority === 'pub.twincat-plc-toolkit',
        'an XAE Problems entry links to /xaeProblem?id=');
    const opensBefore = calls.executed.filter(e => e.id === 'twincat.openComponent').length;
    for (const h of uriHandlers) await h.handleUri(link);
    const open = calls.executed.filter(e => e.id === 'twincat.openComponent');
    assert(open.length === opensBefore + 1 && open[open.length - 1].args[0].fsPath === FB && open[open.length - 1].args[1] === 'root'
        && open[open.length - 1].args[2].pane === 'impl' && open[open.length - 1].args[2].localLine === 2,
        'clicking it opens the component on its pane and line (through the one URI handler)');
    const target = provider.compileSource.openTarget(fbUri.toString());
    assert(target && target.componentId === 'root' && target.range.pane === 'impl' && provider.compileSource.openTarget(fbUri.toString()) === null,
        'a freshly opened editor goes to the first XAE problem, once per run');
    // Both sources merge: Compile Project's markers stay with the XAE ones, and edits reach both.
    {
        const realCompile = provider.compileSources.get('compile');
        const xaeSource = provider.compileSources.get('xae');
        const edited = [];
        provider.setCompileSource({
            paneDiagnostics: () => [{ componentId: 'root', pane: 'decl', severity: 1, message: 'compile marker', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 } }],
            onComponentEdited: (u, c) => edited.push(c),
            openTarget: () => null
        }, 'compile');
        const both = provider.compileSource.paneDiagnostics(fbUri.toString());
        assert(both.length === 3 && both.some(m => m.message === 'compile marker'), 'Compile Project\'s pane markers and the XAE ones are shown together');
        provider.setCompileSource(null, 'xae');
        const onlyCompile = provider.compileSource.paneDiagnostics(fbUri.toString());
        assert(onlyCompile.length === 1 && onlyCompile[0].message === 'compile marker', 'removing the XAE source leaves Compile Project\'s markers');
        provider.setCompileSource(xaeSource, 'xae');
        provider.compileSource.onComponentEdited(fbUri.toString(), 'root');
        assert(edited.includes('root'), 'an edit reaches Compile Project\'s source too');
        provider.setCompileSource(realCompile, 'compile');
    }
    assert(api.problems().length === 0 && !xaeCollection.map.has(fbUri.toString()), 'editing the component drops its XAE problems');
    driver = () => ({ fixture: 'errors-panes-only' });
    await run('twincat.xaeBuild', {});
    assert(calls.errors.some(e => /XAE reported no error list; see 'TC Toolkit XAE Build'/.test(e.m)), 'exit 1 with no error list points at the channel');
    driver = () => ({ fixture: 'version-mismatch' });
    await run('twincat.xaeBuild', {});
    assert(calls.errors.some(e => /could not run: no XAE Shell mapping/.test(e.m)), 'exit 2 names the fatal');

    // ── Activation: list, pick, modal; nothing spawned before the confirmation ──────────────────
    let before = builds().length;
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push(undefined); // the modal is dismissed
    r = await run('twincat.xaeBuildAndActivate', {});
    assert(r.reason === 'cancelled' && builds().length === before, 'a dismissed modal spawns no build at all');
    assert(fake.calls.some(c => c.args.includes('-ListTargets')), 'the targets were listed (-ListTargets)');
    const modal = calls.modals[calls.modals.length - 1];
    assert(modal && modal.opts.modal === true && modal.buttons[0] === 'Activate on UmRT_Default (198.51.100.4.1.1)' && /running PLC on that target stops/.test(modal.m),
        'the modal names the target on its confirm button');
    const pick = calls.picks[calls.picks.length - 1];
    assert(pick.items[0].netId === '198.51.100.1.1.1' && /\(project\)/.test(pick.items[1].description), 'the pick lists this machine\'s runtimes, the project NetId marked');
    assert(!fake.calls.some(c => c.args.includes('-ActivateConfiguration')), 'no -ActivateConfiguration run so far');
    assert(fake.calls.filter(c => !c.args.includes('-ListTargets')).every(c => !c.args.includes('-ActivateConfiguration')), 'twincat.xaeBuild never passed -ActivateConfiguration');

    driver = () => ({ fixture: 'activation-run' });
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push('Activate on UmRT_Default (198.51.100.4.1.1)');
    r = await run('twincat.xaeBuildAndActivate', {});
    argv = lastSpawn().args;
    assert(argv.includes('-ActivateConfiguration') && argv[argv.indexOf('-TargetNetId') + 1] === '198.51.100.4.1.1', 'the confirmed NetId reaches the argv');
    assert(r.ok && r.targetNetId === '198.51.100.4.1.1' && /in RUN/.test(r.title), 'an activation that reached RUN');
    assert(context.workspaceState.get(LAST_TARGET_KEY) === '198.51.100.4.1.1' && !Object.keys(settings).some(k => /target/i.test(k)), 'the pick is remembered in workspaceState, not a setting');
    answers.quickPick.push(() => true);
    answers.message.push(undefined);
    await run('twincat.xaeBuildAndActivate', {});
    assert(calls.picks[calls.picks.length - 1].items[0].netId === '198.51.100.4.1.1' && calls.picks[calls.picks.length - 1].items[0].picked, 'the last pick is preselected next time');
    // A driver that reports a different target than the one confirmed.
    driver = () => ({ fixture: 'activation-run' });
    answers.quickPick.push('198.51.100.1.1.1');
    answers.message.push('Activate on Real-time runtime (198.51.100.1.1.1)');
    r = await run('twincat.xaeBuildAndActivate', {});
    assert(!r.ok && r.targetMismatch && calls.errors.some(e => /not the confirmed 198\.51\.100\.1\.1\.1/.test(e.m)), 'a target readback that differs from the pick is an error');

    // Problems that a stopped run must not clear.
    const errorRun = () => ({ lines: rows('errors-errorlist').map(l => (l.t === 'errorItem' && l.file ? { ...l, file: 'TcToolkitSample_PLC\\POUs\\Machine\\FB_Station.TcPOU' } : l)), exit: 1 });
    driver = errorRun;
    await run('twincat.xaeBuild', {});
    const keptProblems = api.problems().length;
    assert(keptProblems === 2 && xaeCollection.map.has(fbUri.toString()), 'an exit-1 run published 2 problems');

    // ── Cancel: the cancel file first ───────────────────────────────────────────────────────────
    const hangRows = [{ v: 1, t: 'hello', mode: 'build', showWindow: false }, { v: 1, t: 'shell', pid: 4242, ours: true, preexisting: [] }, { v: 1, t: 'phase', name: 'open' }];
    driver = () => ({ lines: hangRows, onCancelFile: { lines: rows('cancelled').slice(-2), exit: 4 } });
    let p = run('twincat.xaeBuild', {});
    await waitFor(() => lastSpawn().args.includes('-CancelFile') && currentToken);
    await new Promise(res => setTimeout(res, 10));
    currentToken.cancel();
    r = await p;
    let call = lastSpawn();
    assert(call.cancelFileSeen && r.exitCode === 4 && !call.killed && fake.killedPids.length === 0, 'cancel writes the cancel file; the driver exits 4; nothing is killed');
    assert(!fs.existsSync(call.args[call.args.indexOf('-CancelFile') + 1]), 'the cancel file is removed after the run');
    assert(calls.warnings.some(w => /cancelled/.test(w.m)), 'a cancelled run is a warning');

    // ── The force stop: PowerShell's tree, and only a shell this run started ────────────────────
    driver = () => ({ lines: hangRows, onCancelFile: { ignore: true } });
    p = run('twincat.xaeBuild', {});
    await waitFor(() => builds().length > 0 && lastSpawn().args.includes('-CancelFile') && currentToken);
    await new Promise(res => setTimeout(res, 10));
    currentToken.cancel();
    r = await p;
    call = lastSpawn();
    assert(r.outcome === 'killed' && fake.killedPids.includes(call.pid) && fake.killedPids.includes(4242), 'after the grace period: taskkill on PowerShell\'s tree and on our shell PID');
    const notOurs = [{ v: 1, t: 'hello', mode: 'build', showWindow: false }, { v: 1, t: 'shell', pid: null, ours: false, preexisting: [77] }, { v: 1, t: 'phase', name: 'open' }];
    fake.killedPids.length = 0;
    driver = () => ({ lines: notOurs, onCancelFile: { ignore: true } });
    p = run('twincat.xaeBuild', {});
    await waitFor(() => lastSpawn().args.includes('-CancelFile') && lastSpawn() !== call);
    await new Promise(res => setTimeout(res, 10));
    currentToken.cancel();
    await p;
    assert(fake.killedPids.length === 1 && fake.killedPids[0] === lastSpawn().pid && !fake.killedPids.includes(77),
        'a shell this run did not start is never killed (only PowerShell is)');
    assert(channel().lines.some(l => /left running/.test(l)), 'the channel says the shell was left running');
    const shellKill = fake.taskkills.find(a => a.includes('4242'));
    assert(shellKill && shellKill[shellKill.indexOf('/FI') + 1] === 'IMAGENAME eq TcXaeShell*',
        'the shell is killed only while its PID is still an XAE Shell (image filter)');
    assert(api.problems().length === keptProblems && (xaeCollection.map.get(fbUri.toString()) || []).length === keptProblems,
        'a cancelled or force-stopped run keeps the previous Problems');

    // A force stop during launch: the shell may exist but is not identified yet.
    driver = () => ({ lines: [{ v: 1, t: 'hello', mode: 'build', showWindow: false }, { v: 1, t: 'phase', name: 'launch' }], onCancelFile: { ignore: true } });
    p = run('twincat.xaeBuild', {});
    await waitFor(() => lastSpawn().args.includes('-CancelFile') && lastSpawn() !== call && currentToken);
    await new Promise(res => setTimeout(res, 10));
    currentToken.cancel();
    await p;
    assert(channel().lines.some(l => l.endsWith(LAUNCH_STOP_TEXT)), 'a force stop during launch says an XAE Shell may have been left running');

    // Exit 1 that the driver did not confirm (script never ran, killed from outside): not a build result.
    {
        // A UTF-8 character and a line split across stderr chunks stay whole.
        const text = Buffer.from('WARNUNG: Ger\u00e4t nicht gefunden\r\nFile x.ps1 cannot be loaded because running scripts is disabled.\r\n', 'utf8');
        const cut = text.indexOf(Buffer.from('\u00e4', 'utf8')) + 1;
        driver = () => ({ lines: [{ log: '#< CLIXML' }], exit: 1, stderrChunks: [text.subarray(0, cut), text.subarray(cut, cut + 30), text.subarray(cut + 30)] });
    }
    r = await run('twincat.xaeBuild', {});
    assert(!r.ok && /interrupted before it finished \(exit code 1\)/.test(r.title) && calls.errors.some(e => /interrupted before it finished/.test(e.m)),
        'an unconfirmed exit 1 is reported as interrupted, not as compile errors');
    assert(channel().lines.includes('WARNUNG: Ger\u00e4t nicht gefunden') && channel().lines.includes('File x.ps1 cannot be loaded because running scripts is disabled.'),
        'stderr is decoded and split across chunks');
    assert(api.problems().length === keptProblems, 'and it keeps the previous Problems');

    // ── No cancel during activation ─────────────────────────────────────────────────────────────
    fake.killedPids.length = 0;
    const activating = [{ v: 1, t: 'hello', mode: 'activate', showWindow: false }, { v: 1, t: 'shell', pid: 4242, ours: true, preexisting: [] }, { v: 1, t: 'phase', name: 'activate' }];
    driver = () => ({ lines: activating, hang: true });
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push('Activate on UmRT_Default (198.51.100.4.1.1)');
    p = run('twincat.xaeBuildAndActivate', {});
    await waitFor(() => lastSpawn().args.includes('-ActivateConfiguration'));
    await new Promise(res => setTimeout(res, 20));
    currentToken.cancel();
    await new Promise(res => setTimeout(res, 80));
    call = lastSpawn();
    const cancelFile = call.args[call.args.indexOf('-CancelFile') + 1];
    assert(!call.killed && fake.killedPids.length === 0 && !fs.existsSync(cancelFile), 'during activation a cancel writes no cancel file and kills nothing');
    assert(calls.warnings.some(w => w.m === CANCEL_REFUSED_TEXT), 'the user is told why');
    call.child.emit('close', 0);
    await p;

    // Activation begins inside the grace period: the re-check refuses the force stop.
    fake.killedPids.length = 0;
    driver = () => ({ lines: hangRows, onCancelFile: { lines: [{ v: 1, t: 'phase', name: 'target' }, { v: 1, t: 'phase', name: 'activate' }], stay: true } });
    p = run('twincat.xaeBuild', {});
    await waitFor(() => lastSpawn() !== call && lastSpawn().args.includes('-CancelFile') && currentToken);
    call = lastSpawn();
    await new Promise(res => setTimeout(res, 10));
    const warnsBefore = calls.warnings.length;
    currentToken.cancel();
    await new Promise(res => setTimeout(res, 120)); // > graceMs (40)
    assert(call.cancelFileSeen && fake.killedPids.length === 0 && !call.killed, 'activation began during the grace period: nothing is killed');
    assert(channel().lines.some(l => l.endsWith(CANCEL_REFUSED_TEXT)) && calls.warnings.slice(warnsBefore).some(w => w.m === CANCEL_REFUSED_TEXT),
        'and the user is told the run will finish on its own');
    call.child.emit('close', 0);
    await p;

    // ── One run at a time ───────────────────────────────────────────────────────────────────────
    driver = () => ({ lines: hangRows, onCancelFile: { lines: rows('cancelled').slice(-2), exit: 4 } });
    p = run('twincat.xaeBuild', {});
    await waitFor(() => api.isRunning() && currentToken && builds().length > 0);
    const second = await run('twincat.xaeBuild', {});
    assert(second.reason === 'running' && calls.infos.some(i => /already running/.test(i.m)), 'a second run while one is going is refused');
    assert(calls.executed.some(e => e.id === 'setContext' && e.args[0] === 'twincat.xaeRunning' && e.args[1] === true), 'the twincat.xaeRunning context key is set');
    currentToken.cancel();
    await p;
    assert(!api.isRunning() && calls.executed.filter(e => e.id === 'setContext' && e.args[0] === 'twincat.xaeRunning').pop().args[1] === false, 'and cleared after the run');

    // ── Timeout: the same graceful sequence ─────────────────────────────────────────────────────
    settings['tcToolkit.xaeBuild.timeoutMinutes'] = 5; // 5 × minuteMs (10 ms)
    driver = () => ({ lines: hangRows, onCancelFile: { lines: rows('cancelled').slice(-2), exit: 4 } });
    r = await run('twincat.xaeBuild', {});
    assert(r.outcome === 'timeout' && lastSpawn().cancelFileSeen && /timed out/.test(r.title), 'a timeout writes the cancel file and is reported as a timeout');
    // The timeout falls during activation: no stop, 5 more minutes, then only a warning.
    fake.killedPids.length = 0;
    driver = () => ({ lines: activating, hang: true });
    p = run('twincat.xaeBuild', {});
    await waitFor(() => channel().lines.some(l => /Timed out during activation; check the target/.test(l)), 1500);
    call = lastSpawn();
    assert(channel().lines.some(l => /timeout fell during activation; waiting 5 more minutes/.test(l)) && fake.killedPids.length === 0 && !call.cancelFileSeen,
        'a timeout during activation waits 5 more minutes and stops nothing');
    call.child.emit('close', 0);
    r = await p;
    assert(/^Timed out during activation; check the target\./.test(r.title), 'then the result says to check the target');
    // The timeout's stop is refused (activation began in the grace period): still watched, not a timeout.
    driver = () => ({ lines: hangRows, onCancelFile: { lines: [{ v: 1, t: 'phase', name: 'target' }], stay: true } });
    const linesBefore = channel().lines.length;
    p = run('twincat.xaeBuild', {});
    await waitFor(() => channel().lines.slice(linesBefore).some(l => /Timed out during activation; check the target/.test(l)), 1500);
    call = lastSpawn();
    assert(call.cancelFileSeen && fake.killedPids.length === 0 && channel().lines.slice(linesBefore).some(l => /waiting 5 more minutes/.test(l)),
        'a refused timeout stop is re-armed: 5 more minutes, then the warning, nothing killed');
    call.child.emit('close', 0);
    r = await p;
    assert(r.outcome === 'exit' && /^Timed out during activation/.test(r.title), 'and the run is not reported as stopped by the timeout');
    settings['tcToolkit.xaeBuild.timeoutMinutes'] = 240;
    // The timeout's runs kept the Problems of the last build that reached a result.
    driver = errorRun;
    await run('twincat.xaeBuild', {});
    settings['tcToolkit.xaeBuild.timeoutMinutes'] = 5;
    driver = () => ({ lines: hangRows, onCancelFile: { lines: rows('cancelled').slice(-2), exit: 4 } });
    r = await run('twincat.xaeBuild', {});
    settings['tcToolkit.xaeBuild.timeoutMinutes'] = 240;
    assert(r.outcome === 'timeout' && api.problems().length === 2 && xaeCollection.map.has(fbUri.toString()), 'a timed-out run keeps the previous Problems');

    // ── Stall: headless only; the offer re-runs with the window shown ───────────────────────────
    const stallRows = [{ v: 1, t: 'hello', mode: 'build', showWindow: false }, { v: 1, t: 'phase', name: 'open' }];
    let n = 0;
    let stallSpawns = 0;
    driver = () => (n++ === 0 ? { lines: stallRows, onCancelFile: { lines: rows('cancelled').slice(-2), exit: 4 } } : { fixture: 'build-ok-visible' });
    answers.stall = STALL_RERUN;
    const spawnsBefore = builds().length;
    r = await run('twincat.xaeBuild', {});
    answers.stall = undefined;
    const rerun = builds().slice(spawnsBefore);
    assert(rerun.length === 2 && !rerun[0].args.includes('-ShowWindow') && rerun[1].args.includes('-ShowWindow') && r.ok,
        'a stalled headless run, cancelled from the offer, re-runs once with -ShowWindow');
    assert(settings['tcToolkit.xaeBuild.showWindow'] === false, 'the re-run does not change the setting');

    // The stopped run reports one channel line, no notification; the shell check is not asked twice,
    // and a confirmed shell substitution is kept for the re-run.
    slnPath = SLN2;
    n = 0;
    driver = () => (n++ === 0 ? { lines: stallRows, onCancelFile: { lines: rows('cancelled').slice(-2), exit: 4 } } : { fixture: 'build-ok-visible' });
    answers.stall = STALL_RERUN;
    answers.message.push('Build with XAE Shell 64');
    const warnCount = calls.warnings.length;
    const modalCount = calls.modals.length;
    stallSpawns = builds().length;
    r = await run('twincat.xaeBuild', {});
    answers.stall = undefined;
    slnPath = SLN;
    const newWarnings = calls.warnings.slice(warnCount);
    const stallReruns = builds().slice(stallSpawns);
    assert(r.ok && calls.modals.length === modalCount + 1 && !newWarnings.some(w => /XAE Shell/.test(w.m)), 'the re-run does not ask the shell check again');
    assert(stallReruns.length === 2 && stallReruns.every(c => c.args[c.args.indexOf('-TcVersion') + 1] === 'TcXaeShell.DTE.17.0'), 'the re-run keeps the confirmed shell');
    assert(!newWarnings.some(w => /cancelled|stopped/.test(w.m)) && channel().lines.some(l => /Stopped; re-running with the XAE window shown\./.test(l)),
        'the stopped run shows no cancelled notification, one channel line');

    // The run finished on its own while the offer was answered: no re-run.
    n = 0;
    driver = () => (n++ === 0 ? { lines: stallRows, onCancelFile: { lines: rows('build-ok-headless').slice(-1), exit: 0 } } : { fixture: 'build-ok-visible' });
    answers.stall = STALL_RERUN;
    stallSpawns = builds().length;
    r = await run('twincat.xaeBuild', {});
    answers.stall = undefined;
    assert(builds().length === stallSpawns + 1 && r.ok && r.exitCode === 0, 'a run that exits 0 after the cancel file is not re-run');

    // The stop is refused (activation began meanwhile): no re-run.
    n = 0;
    driver = () => (n++ === 0 ? { lines: stallRows, onCancelFile: { lines: [{ v: 1, t: 'phase', name: 'activate' }], stay: true } } : { fixture: 'build-ok-visible' });
    answers.stall = STALL_RERUN;
    stallSpawns = builds().length;
    p = run('twincat.xaeBuild', {});
    await waitFor(() => builds().length === stallSpawns + 1 && lastSpawn().cancelFileSeen);
    await new Promise(res => setTimeout(res, 120));
    answers.stall = undefined;
    lastSpawn().child.emit('close', 0);
    r = await p;
    assert(builds().length === stallSpawns + 1 && r.exitCode === 0, 'a refused stop is not followed by a re-run');

    // ── A configuration the solution does not declare ───────────────────────────────────────────
    n = 0;
    driver = () => (n++ === 0 ? { fixture: 'config-not-declared' } : { fixture: 'build-ok-headless' });
    answers.quickPick.push('Release|TwinCAT OS (x64)', 'Run once');
    await run('twincat.xaeBuild', {});
    argv = lastSpawn().args;
    assert(argv[argv.indexOf('-Configuration') + 1] === 'Release' && argv[argv.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)', 'the picked pair is used for the re-run');
    assert(!workspaceSettings['tcToolkit.xaeBuild.platform'], '"Run once" writes no setting');

    // ── The shell check, Show Activation Targets ────────────────────────────────────────────────
    settings['tcToolkit.xaeShell.path4026'] = '';
    before = fake.calls.length;
    answers.message.push(undefined);
    r = await run('twincat.xaeBuildAndActivate', {});
    assert(r.reason === 'cancelled' && fake.calls.length === before && calls.warnings.some(w => /No XAE Shell for TwinCAT 3\.1\.4026/.test(w.m) && w.buttons.includes('Run anyway')),
        'activation, no XAE Shell for the project\'s version: a warning with Run anyway, nothing spawned when dismissed');
    detected = { 4026: { path: 'C:\\x\\TcXaeShell.exe', source: 'registry' } };
    const warnBefore = calls.warnings.length;
    driver = () => ({ fixture: 'build-ok-headless' });
    r = await run('twincat.xaeBuild', {});
    assert(r.ok && calls.warnings.length === warnBefore && !lastSpawn().args.includes('-TcVersion'), 'a shell found in the registry (setting empty) passes the check without a question');
    detected = {};
    {
        // Nothing found anywhere: the check cannot tell, so it asks nothing and the driver decides.
        const w0 = calls.warnings.length;
        const m0 = calls.modals.length;
        r = await run('twincat.xaeBuild', {});
        assert(r.ok && calls.warnings.length === w0 && calls.modals.length === m0, 'build, nothing detected: no pre-run question, the driver runs');
    }
    settings['tcToolkit.xaeShell.path4026'] = __filename;

    // ── The project's XAE Shell is missing, another is installed (sample 2: 4024, a .tspproj) ───
    assert(projectTcBuild(SLN2, fs) === '4024', 'projectTcBuild reads the .tspproj the .sln references');
    {
        const fatalRows = (installed) => [
            { v: 1, t: 'hello', mode: 'build', showWindow: false },
            { log: "FATAL: DTE ProgId 'TcXaeShell.DTE.15.0' is not registered - the matching XAE Shell is not installed." },
            { v: 1, t: 'fatal', code: 'progid-not-registered', text: "DTE ProgId 'TcXaeShell.DTE.15.0' is not registered - the matching XAE Shell is not installed.",
                data: { progId: 'TcXaeShell.DTE.15.0', build: '4024', projectVersion: '3.1.4024.62', installed } },
            { v: 1, t: 'done', exitCode: 2, ui: null }
        ];
        const QUESTION = 'TcToolkitSample2 was saved with TwinCAT 3.1.4024 and its XAE Shell (4024) is not installed. Build with XAE Shell 64 (4026) instead? XAE may upgrade the project files.';
        const prompts = () => calls.modals.length + calls.warnings.length;
        const overrideOk = (args) => { const i = args.indexOf('-TcVersion'); return i > 0 && args[i + 1] === 'TcXaeShell.DTE.17.0' && args[i + 2] === '-AllowVersionMismatch'
            && args.filter(x => x === '-TcVersion').length === 1 && args.filter(x => x === '-AllowVersionMismatch').length === 1; };
        slnPath = SLN2;

        // 1. The pre-check can tell (XAE Shell 64 is configured, 4024 is nowhere): ONE modal, then one run on 4026.
        driver = () => ({ fixture: 'build-ok-headless' });
        let p0 = prompts();
        let b0 = builds().length;
        answers.message.push('Build with XAE Shell 64');
        r = await run('twincat.xaeBuild', {});
        const offer = calls.modals[calls.modals.length - 1];
        assert(prompts() === p0 + 1 && offer.m === QUESTION && offer.opts.modal === true && offer.buttons.length === 1 && offer.buttons[0] === 'Build with XAE Shell 64',
            'pre-check: exactly one prompt, the modal naming both shells');
        assert(builds().length === b0 + 1 && overrideOk(lastSpawn().args) && r.ok && r.shellOverride === 'TcXaeShell.DTE.17.0',
            'pre-check yes: one run, from the start with exactly -TcVersion TcXaeShell.DTE.17.0 -AllowVersionMismatch');
        assert(channel().lines.some(l => /The user chose to build with XAE Shell 64 \(4026\) \(TcXaeShell\.DTE\.17\.0\) instead of the project's XAE Shell \(4024\)/.test(l)),
            'the channel logs that the user chose the other shell');
        p0 = prompts();
        b0 = builds().length;
        answers.message.push(undefined);
        r = await run('twincat.xaeBuild', {});
        assert(r.reason === 'cancelled' && builds().length === b0 && prompts() === p0 + 1, 'pre-check Cancel: nothing spawned');

        // 2. The pre-check cannot tell (nothing configured, nothing detected): the driver's fatal is the fallback.
        settings['tcToolkit.xaeShell.path4026'] = '';
        let k = 0;
        driver = () => (k++ === 0 ? { lines: fatalRows(['TcXaeShell.DTE.17.0']), exit: 2 } : { fixture: 'build-ok-headless' });
        p0 = prompts();
        b0 = builds().length;
        const errBefore = calls.errors.length;
        answers.message.push('Build with XAE Shell 64');
        r = await run('twincat.xaeBuild', {});
        const two = builds().slice(b0);
        assert(prompts() === p0 + 1 && calls.modals[calls.modals.length - 1].m === QUESTION, 'driver fallback: exactly one prompt, the same modal');
        assert(two.length === 2 && !two[0].args.includes('-TcVersion') && !two[0].args.includes('-AllowVersionMismatch') && overrideOk(two[1].args) && r.ok,
            'driver fallback yes: re-run once with exactly -TcVersion <ProgId> -AllowVersionMismatch');
        assert(!calls.errors.slice(errBefore).some(e => /could not run/.test(e.m)), 'the first run\'s error is not shown when the user takes the offer');

        // Cancel: the original error stays.
        k = 0;
        p0 = prompts();
        b0 = builds().length;
        let e0 = calls.errors.length;
        answers.message.push(undefined);
        r = await run('twincat.xaeBuild', {});
        assert(builds().length === b0 + 1 && !r.ok && r.exitCode === 2 && prompts() === p0 + 1, 'driver fallback Cancel: no re-run');
        assert(calls.errors.length === e0 + 1 && /^The XAE build could not run: TcToolkitSample2 was saved with TwinCAT 3\.1\.4024 and its XAE Shell \(4024\) is not installed\. Install XAE Shell \(4024\)/.test(calls.errors[e0].m),
            'driver fallback Cancel: the original error, saying which shell to install');

        // No installed alternative: no prompt, the error says which shell to install.
        driver = () => ({ lines: fatalRows([]), exit: 2 });
        p0 = prompts();
        e0 = calls.errors.length;
        r = await run('twincat.xaeBuild', {});
        assert(!r.ok && prompts() === p0 && /Install XAE Shell \(4024\) \(TcXaeShell\.DTE\.15\.0\) to build it on this machine\./.test(calls.errors[e0].m),
            'no installed alternative: no prompt, the error names the shell to install');
        settings['tcToolkit.xaeShell.path4026'] = __filename;

        // 3. Activation is never offered another shell: the pre-check warns (Run anyway), the driver's fatal asks nothing.
        driver = () => ({ lines: fatalRows(['TcXaeShell.DTE.17.0']).map(l => (l.t === 'hello' ? { ...l, mode: 'activate' } : l)), exit: 2 });
        p0 = prompts();
        const m0 = calls.modals.length;
        e0 = calls.errors.length;
        answers.message.push('Run anyway');
        answers.quickPick.push('198.51.100.4.1.1');
        answers.message.push('Activate on UmRT_Default (198.51.100.4.1.1)');
        r = await run('twincat.xaeBuildAndActivate', {});
        const shellModals = calls.modals.slice(m0).filter(mm => /XAE Shell/.test(mm.m));
        assert(shellModals.length === 0 && calls.warnings.some(w => /No XAE Shell for TwinCAT 3\.1\.4024/.test(w.m) && w.buttons.includes('Run anyway')),
            'activation: the pre-check warns with Run anyway, never the shell offer');
        assert(!lastSpawn().args.includes('-TcVersion') && !lastSpawn().args.includes('-AllowVersionMismatch') && !r.ok
            && /Activation needs the project's own XAE Shell/.test(calls.errors[e0].m), 'activation: no override, the fatal refuses with a clear message');
        assert(prompts() === p0 + 2, 'activation: the shell warning and the target confirmation, nothing more');
        slnPath = SLN;
        driver = () => ({ fixture: 'build-ok-headless' });
    }
    r = await run('twincat.xaeShowTargets', {});
    assert(r.ok && r.targets.length === 2 && channel().lines.some(l => /198\.51\.100\.4\.1\.1\s+user-mode\s+UmRT_Default.*\(project\)/.test(l)), 'Show Activation Targets prints the table');

    // ── Not Windows ─────────────────────────────────────────────────────────────────────────────
    {
        const ctx2 = { ...context, subscriptions: [] };
        const spawned = [];
        const linuxFake = createFakeXaeSpawn((c) => { spawned.push(c); return { fixture: 'build-ok-headless' }; });
        handlers.clear();
        const api2 = registerXaeBuildCommands(ctx2, { getProjectMap: projectMap, getSolutionMap: solutionMap, spawn: linuxFake.spawn, platform: 'linux', tmpDir: TMP });
        const errs = calls.errors.length;
        const r2 = await run('twincat.xaeBuild', {});
        const r3 = await run('twincat.xaeBuildAndActivate', {});
        assert(r2.reason === 'platform' && r3.reason === 'platform' && linuxFake.calls.length === 0 && calls.errors.slice(errs).every(e => e.m === PLATFORM_TEXT),
            'off Windows both commands refuse with "needs Windows with TwinCAT XAE installed", nothing spawned');
        assert(api2.xaeOptions().available === false, 'and the dropdown entries are hidden (available: false)');
    }

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(errors === 0 ? '\nAll XAE build command tests passed.' : `\n${errors} XAE build command test(s) FAILED.`);
    process.exit(errors === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
