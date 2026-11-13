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
const folderSettings = {};
// The scopes package.json really contributes: VS Code applies a workspace-folder value, and accepts a
// folder write, only for a resource-like scope and only when a resource is given. Everything else
// (no `scope` = window) has no folder value and a folder write is refused.
const PACKAGE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const scopeOf = (full) => {
    for (const c of [].concat(PACKAGE.contributes.configuration)) {
        if (c.properties && c.properties[full]) return c.properties[full].scope || 'window';
    }
    return 'window';
};
const folderScoped = (full) => ['resource', 'language-overridable', 'machine-overridable'].includes(scopeOf(full));
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
        getConfiguration: (section, resource) => ({
            get: (key, fallback) => {
                const full = `${section}.${key}`;
                if (resource && folderScoped(full) && Object.prototype.hasOwnProperty.call(folderSettings, full)) return folderSettings[full];
                if (Object.prototype.hasOwnProperty.call(workspaceSettings, full)) return workspaceSettings[full];
                return Object.prototype.hasOwnProperty.call(settings, full) ? settings[full] : fallback;
            },
            inspect: (key) => {
                const full = `${section}.${key}`;
                return {
                    globalValue: settings[full], workspaceValue: workspaceSettings[full],
                    workspaceFolderValue: resource && folderScoped(full) ? folderSettings[full] : undefined
                };
            },
            update: async (key, value, target) => {
                const full = `${section}.${key}`;
                if (target === 3 && (!resource || !folderScoped(full))) {
                    throw new Error(`Unable to write to Folder Settings because ${full} does not support the folder resource scope.`);
                }
                const bucket = target === 3 ? folderSettings : (target === 2 ? workspaceSettings : settings);
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
// TC Toolkit's own check, as the XAE fallback calls it: recorded, answered by the test (the real
// command is covered by test_compile_commands.js, its fromXae/append arguments included).
/** @type {Array<any>} */
const compileCalls = [];
let compileAnswer = (/** @type {any} */ a) => ({ ok: true, projectKey: a.projectKey, errors: 2, warnings: 0 });
handlers.set('twincat.compileProject', async (a) => { compileCalls.push(a); return compileAnswer(a); });
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
        'Build Project\'s twincat-compile and twincat-gpp collections are untouched');
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
        assert(both.length === 3 && both.some(m => m.message === 'compile marker'), 'Build Project\'s pane markers and the XAE ones are shown together');
        provider.setCompileSource(null, 'xae');
        const onlyCompile = provider.compileSource.paneDiagnostics(fbUri.toString());
        assert(onlyCompile.length === 1 && onlyCompile[0].message === 'compile marker', 'removing the XAE source leaves Build Project\'s markers');
        provider.setCompileSource(xaeSource, 'xae');
        provider.compileSource.onComponentEdited(fbUri.toString(), 'root');
        assert(edited.includes('root'), 'an edit reaches Build Project\'s source too');
        provider.setCompileSource(realCompile, 'compile');
    }
    assert(api.problems().length === 0 && !xaeCollection.map.has(fbUri.toString()), 'editing the component drops its XAE problems');
    driver = () => ({ fixture: 'errors-panes-only' });
    await run('twincat.xaeBuild', {});
    assert(calls.errors.some(e => /XAE named no error with a file and line; see 'TC Toolkit XAE Build'/.test(e.m)), 'exit 1 with nothing located points at the channel');
    // ── C: a failed headless build with no error details (user run 2026-11-13, 4026) ───────────
    {
        const showWindowWrites = () => calls.updates.filter(u => u.key === 'tcToolkit.xaeBuild.showWindow').length;
        const w0 = showWindowWrites();
        const n0 = builds().length;
        driver = (c) => ({ fixture: c.args.includes('-ShowWindow') ? 'errors-errorlist' : 'errors-no-details-headless' });
        answers.message.push('Build again with the window shown');
        const e0 = calls.errors.length;
        const c0 = compileCalls.length;
        r = await run('twincat.xaeBuild', {});
        const note = calls.errors[e0];
        assert(!r.ok && r.exitCode === 1 && r.noErrorDetails && note
            && /^Build through XAE failed\. XAE returned no error details: typed error list: the error list is empty; the error list is empty; typed Output 'Build' pane: the Output window has no pane named 'Build'; the Output window is not available \(XAE window hidden\)\. See 'TC Toolkit XAE Build'\. /.test(note.m),
            'the failure says no error details came back by any route, and why (typed and late-bound reasons)');
        // C (user decision 2026-11-13): TC Toolkit's own check stands in, exactly once, said as such.
        assert(compileCalls.length === c0 + 1 && compileCalls[c0].projectKey === 'a' && compileCalls[c0].fromXae === true && compileCalls[c0].append === false,
            'route none: TC Toolkit\'s own check runs once on the solution\'s project (fromXae, not appending)');
        assert(/TC Toolkit's own compile check \(not XAE's; it can differ from XAE's\): TcToolkitSample_PLC: 2 errors\. Its problems are in Problems as 'TC Toolkit compile'\.$/.test(note.m)
            && r.errorRoute === 'none' && r.compileFallback && r.compileFallback.ran === 1,
            'the failure message says the errors are TC Toolkit\'s check, not XAE\'s, and can differ');
        assert(channel().lines.some(l => /Running TC Toolkit's own compile check instead: its errors come from TC Toolkit's check, not from XAE, and can differ from XAE's\./.test(l))
            && channel().lines.some(l => /Error details read: by no route\./.test(l)), 'the channel says so, and names the route');
        assert(note.buttons[0] === 'Build again with the window shown' && note.buttons.includes('Open Problems') && note.buttons.includes('Show Output'),
            'it still offers "Build again with the window shown" (headless), and Open Problems');
        assert(!/will show|shows the errors/i.test(note.m), 'it does not claim the visible run will show the errors');
        await waitFor(() => builds().length === n0 + 2);
        await waitFor(() => !api.isRunning());
        const again = builds()[n0 + 1];
        // Everything but -ShowWindow and the per-run cancel file is the same: configuration, platform, shell.
        const same = (args) => args.filter((x, i, all) => x !== '-ShowWindow' && x !== '-CancelFile' && all[i - 1] !== '-CancelFile');
        assert(again && again.args.includes('-ShowWindow') && !builds()[n0].args.includes('-ShowWindow')
            && JSON.stringify(same(again.args)) === JSON.stringify(same(builds()[n0].args))
            && again.args[again.args.indexOf('-Configuration') + 1] === 'Release' && !again.args.includes('-TcVersion'),
            'the button re-runs once, with -ShowWindow and the same configuration, platform and shell (every other argument equal)');
        assert(showWindowWrites() === w0 && settings['tcToolkit.xaeBuild.showWindow'] === false, 'the re-run never changes tcToolkit.xaeBuild.showWindow');
        assert(channel().lines.some(l => /Building again with the XAE window shown \(this run only; the setting is unchanged\)/.test(l)), 'the channel says so');
        assert(compileCalls.length === c0 + 1, 'the re-run brought error details back: no second fallback');
        // Not offered when the window was already shown; the reason names the real mode (B).
        settings['tcToolkit.xaeBuild.showWindow'] = true;
        driver = () => ({ fixture: 'errors-no-details-visible' });
        const e1 = calls.errors.length;
        compileAnswer = () => ({ ok: false, reason: 'setup', message: 'The compiler file "C:\\gone.cjs" (setting "tcToolkit.compiler.path") does not exist.' });
        r = await run('twincat.xaeBuild', {});
        assert(calls.errors[e1] && /XAE returned no error details: .*the Output window is not available \(XAE window shown\)\./.test(calls.errors[e1].m)
            && !/XAE window hidden/.test(calls.errors[e1].m) && !calls.errors[e1].buttons.includes('Build again with the window shown'),
            'a visible build with no details: the reason says the window was shown, and no re-run is offered');
        assert(/TC Toolkit's own compile check was skipped: no compiler is configured for it \(The compiler file .*gone\.cjs.*does not exist\.\)\.$/.test(calls.errors[e1].m)
            && r.compileFallback && r.compileFallback.skipped && r.compileFallback.ran === 0 && !calls.errors[e1].buttons.includes('Open Problems'),
            'no compiler configured: the fallback says so and is skipped');
        compileAnswer = (a) => ({ ok: true, projectKey: a.projectKey, errors: 2, warnings: 0 });
        settings['tcToolkit.xaeBuild.showWindow'] = false;
        // The typed route (Beckhoff's documented reader): errors reach Problems, nothing falls back.
        const c1 = compileCalls.length;
        driver = () => ({ fixture: 'errors-typed' });
        r = await run('twincat.xaeBuild', {});
        assert(!r.ok && r.exitCode === 1 && !r.noErrorDetails && r.errorRoute === 'typed' && r.placed === 1
            && (xaeCollection.map.get(fbUri.toString()) || []).some(d => ((d.code && d.code.value) || d.code) === 'C0046' && !/^C0046/.test(d.message) && d.severity === 0),
            'route typed: the error-list item reaches Problems as an error');
        assert(compileCalls.length === c1 && channel().lines.some(l => /Error details read: through the typed EnvDTE reader\./.test(l)),
            'route typed: no fallback, and the channel names the route');
        // A successful build: the typed list is read too, so its warnings are listed.
        driver = () => ({ fixture: 'build-ok-typed-warnings' });
        r = await run('twincat.xaeBuild', {});
        assert(r.ok && r.exitCode === 0 && r.total === 1 && (xaeCollection.map.get(fbUri.toString()) || []).some(d => ((d.code && d.code.value) || d.code) === 'C0373' && !/^C0373/.test(d.message) && d.severity === 1)
            && compileCalls.length === c1, 'a successful build with a compiler warning: listed in Problems as a warning, no fallback');
        // No fallback after a cancel (exit 4) or a harness error (exit 2).
        driver = () => ({ fixture: 'cancelled' });
        await run('twincat.xaeBuild', {});
        driver = () => ({ fixture: 'version-mismatch' });
        await run('twincat.xaeBuild', {});
        assert(compileCalls.length === c1, 'no fallback when the run was cancelled or the harness failed (exit 2)');
        // The user's runs (4026.28): headless, the list items are empty and the Build pane names the
        // errors; it places them, so nothing falls back, and no blank "not placed" line is printed.
        // A copy of sample 1 with `h;` planted at MAIN's implementation line 14, as in the user's runs.
        const plantedDir = path.join(TMP, 'Planted');
        fs.cpSync(path.dirname(SLN), plantedDir, { recursive: true });
        const plantedMain = path.join(plantedDir, 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
        fs.writeFileSync(plantedMain, fs.readFileSync(plantedMain, 'utf8').replace(/END_FOR\]\]>/, 'h;\r\nEND_FOR]]>'));
        const mainUri = uri(fs.realpathSync.native(plantedMain));
        slnPath = path.join(plantedDir, path.basename(SLN));
        for (const name of ['errors-pane-planted-headless', 'errors-pane-planted-visible']) {
            const c2 = compileCalls.length;
            const e2 = calls.errors.length;
            const l2 = channel().lines.length;
            driver = () => ({ fixture: name });
            r = await run('twincat.xaeBuild', {});
            const runLines = channel().lines.slice(l2);
            const mainDiags = xaeCollection.map.get(mainUri.toString()) || [];
            assert(!r.ok && r.exitCode === 1 && r.placed === 2 && r.total === 2 && compileCalls.length === c2,
                `${name}: both messages placed, no fallback`);
            assert(mainDiags.length === 2 && mainDiags.some(d => d.code && d.code.value === 'C0189' && d.severity === 0)
                && mainDiags.some(d => d.code && d.code.value === 'C0139' && d.severity === 1), `${name}: the compiler code is the Problems code`);
            assert(calls.errors[e2] && /^Build through XAE failed: 1 error\. 1 error, 1 warning \(2 placed in Problems\)\./.test(calls.errors[e2].m),
                `${name}: the counts come from the de-duplicated messages (${calls.errors[e2] && calls.errors[e2].m})`);
            assert(!runLines.some(l => /\(not placed\):\s*$/.test(l)) && runLines.filter(l => /^ {2}XAE: .*build for platform 'TwinCAT OS \(x64\)' failed\.$/.test(l)).length === 1,
                `${name}: no blank "not placed" line; the project-failed item is one summary line`);
        }
        // Details came back but none could be placed: TC Toolkit's own check stands in all the same.
        {
            const c3 = compileCalls.length;
            driver = () => ({ lines: rows('errors-pane-planted-headless').map(l => (l.t === 'outputPane' ? { ...l, text: l.text.replace(/MAIN\.TcPOU/g, 'Gone.TcPOU') } : l)), exit: 1 });
            r = await run('twincat.xaeBuild', {});
            assert(r.placed === 0 && r.total === 2 && !r.noErrorDetails && compileCalls.length === c3 + 1 && r.compileFallback && r.compileFallback.ran === 1,
                'a failed build with details but 0 placed runs the fallback once');
            assert(channel().lines.some(l => /^ {2}error \(not placed\): C0189: /.test(l)) && channel().lines.some(l => /^ {2}warning \(not placed\): C0139: /.test(l)),
                'an unplaced message is listed with its own severity');
        }
        slnPath = SLN;
        settings['tcToolkit.xaeBuild.showWindow'] = false;
        driver = () => ({ fixture: 'build-ok-headless' });
    }
    driver = () => ({ fixture: 'version-mismatch' });
    await run('twincat.xaeBuild', {});
    assert(calls.errors.some(e => /could not run: no XAE Shell mapping/.test(e.m)), 'exit 2 names the fatal');

    // ── Activation: list, pick, modal; nothing spawned before the confirmation ──────────────────
    let before = builds().length;
    answers.quickPick.push('198.51.100.1.1.1');
    answers.message.push(undefined); // the modal is dismissed
    r = await run('twincat.xaeBuildAndActivate', {});
    assert(r.reason === 'cancelled' && builds().length === before, 'a dismissed modal spawns no build at all');
    assert(fake.calls.some(c => c.args.includes('-ListTargets')), 'the targets were listed (-ListTargets)');
    const modal = calls.modals[calls.modals.length - 1];
    assert(modal && modal.opts.modal === true && modal.buttons.length === 1 && modal.buttons[0] === 'Activate on Real-time runtime (198.51.100.1.1.1)'
        && /running PLC on that target stops/.test(modal.m) && !/Switch/.test(modal.m),
        'the modal names the target on its confirm button (the target runs the configured platform: no switch asked)');
    const pick = calls.picks[calls.picks.length - 1];
    assert(pick.items[0].netId === '198.51.100.1.1.1' && /\(project\)/.test(pick.items[1].description), 'the pick lists this machine\'s runtimes, the project NetId marked');
    assert(!fake.calls.some(c => c.args.includes('-ActivateConfiguration')), 'no -ActivateConfiguration run so far');
    assert(fake.calls.filter(c => !c.args.includes('-ListTargets')).every(c => !c.args.includes('-ActivateConfiguration')), 'twincat.xaeBuild never passed -ActivateConfiguration');

    // ── B: the target runs another platform (user run 2026-11-13: RT (x64) set, UmRT_Default runs OS (x64)) ──
    // XAE asks on download whether to switch to the target's platform; so does the one modal here.
    const platformWrites = () => calls.updates.filter(u => u.key === 'tcToolkit.xaeBuild.platform');
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push(undefined); // Cancel
    const sw0 = calls.modals.length;
    r = await run('twincat.xaeBuildAndActivate', {});
    const sm = calls.modals.slice(sw0);
    assert(sm.length === 1 && /^UmRT_Default \(198\.51\.100\.4\.1\.1\) runs TwinCAT OS \(x64\), but TwinCAT RT \(x64\) is set\. Switch to TwinCAT OS \(x64\)\?/.test(sm[0].m)
        && JSON.stringify(sm[0].buttons) === JSON.stringify(['Switch for this run', 'Switch and remember']) && /running PLC on that target stops/.test(sm[0].m),
        'one modal asks to switch, names the target, and offers Switch for this run / Switch and remember');
    assert(r.reason === 'cancelled' && builds().length === before && platformWrites().length === 0, 'Cancel: nothing spawned, nothing written');

    driver = () => ({ fixture: 'activation-run' });
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push('Switch for this run');
    r = await run('twincat.xaeBuildAndActivate', {});
    argv = lastSpawn().args;
    assert(argv.includes('-ActivateConfiguration') && argv[argv.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)' && argv[argv.indexOf('-Configuration') + 1] === 'Release',
        'Switch for this run: the run builds Release|TwinCAT OS (x64)');
    assert(r.ok && r.platform === 'TwinCAT OS (x64)' && r.platformSwitchedFrom === 'TwinCAT RT (x64)', 'and reports the switch');
    assert(platformWrites().length === 0 && settings['tcToolkit.xaeBuild.platform'] === undefined && workspaceSettings['tcToolkit.xaeBuild.platform'] === undefined,
        'Switch for this run never writes the setting');
    assert(channel().lines.some(l => /Platform: TwinCAT OS \(x64\), the platform of the activation target \(confirmed in place of TwinCAT RT \(x64\)\)/.test(l)),
        'the channel says the platform was switched for the target');
    // The next build (no activation) is back on the setting.
    driver = () => ({ fixture: 'build-ok-headless' });
    await run('twincat.xaeBuild', {});
    assert(lastSpawn().args[lastSpawn().args.indexOf('-Platform') + 1] === 'TwinCAT RT (x64)', 'the next plain build uses the setting again');

    // Switch and remember: written once, at the scope the value comes from.
    driver = () => ({ fixture: 'activation-run' });
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push('Switch and remember');
    let pw0 = platformWrites().length;
    r = await run('twincat.xaeBuildAndActivate', {});
    assert(lastSpawn().args[lastSpawn().args.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)' && r.ok, 'Switch and remember: the run builds TwinCAT OS (x64)');
    assert(platformWrites().length === pw0 + 1 && platformWrites()[pw0].value === 'TwinCAT OS (x64)' && platformWrites()[pw0].target === 1,
        'Switch and remember writes tcToolkit.xaeBuild.platform once, in the user settings when nothing narrower sets it');
    delete settings['tcToolkit.xaeBuild.platform'];
    workspaceSettings['tcToolkit.xaeBuild.platform'] = 'TwinCAT RT (x64)';
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push('Switch and remember');
    pw0 = platformWrites().length;
    await run('twincat.xaeBuildAndActivate', {});
    assert(platformWrites().length === pw0 + 1 && platformWrites()[pw0].target === 2 && workspaceSettings['tcToolkit.xaeBuild.platform'] === 'TwinCAT OS (x64)'
        && settings['tcToolkit.xaeBuild.platform'] === undefined, 'a workspace value is replaced in the workspace');
    // The setting is contributed without a scope (window): VS Code keeps no workspace-folder value for
    // it and refuses a folder write, so a value in a folder's settings file is neither read nor written.
    assert(scopeOf('tcToolkit.xaeBuild.platform') === 'window', 'tcToolkit.xaeBuild.platform is window-scoped as contributed');
    {
        let refused = false;
        try { await vscodeStub.workspace.getConfiguration('tcToolkit.xaeBuild', uri(SLN)).update('platform', 'x', 3); } catch (e) { refused = true; }
        assert(refused && folderSettings['tcToolkit.xaeBuild.platform'] === undefined, 'the stub refuses a folder write for it, as VS Code does');
    }
    workspaceSettings['tcToolkit.xaeBuild.platform'] = 'TwinCAT RT (x64)';
    folderSettings['tcToolkit.xaeBuild.platform'] = 'TwinCAT RT (x64)';
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push('Switch and remember');
    pw0 = platformWrites().length;
    const er0 = calls.errors.length;
    await run('twincat.xaeBuildAndActivate', {});
    assert(platformWrites().length === pw0 + 1 && platformWrites()[pw0].target === 2 && workspaceSettings['tcToolkit.xaeBuild.platform'] === 'TwinCAT OS (x64)'
        && folderSettings['tcToolkit.xaeBuild.platform'] === 'TwinCAT RT (x64)' && !calls.errors.slice(er0).some(e => /Could not change the setting/.test(e.m)),
        'a folder-file value is ignored (the setting has no folder scope): the workspace value is replaced, no folder write is tried');
    delete folderSettings['tcToolkit.xaeBuild.platform'];
    delete workspaceSettings['tcToolkit.xaeBuild.platform'];
    // Once the setting is the target's platform, the modal is the plain one again.
    settings['tcToolkit.xaeBuild.platform'] = 'TwinCAT OS (x64)';
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push(undefined);
    await run('twincat.xaeBuildAndActivate', {});
    assert(calls.modals[calls.modals.length - 1].buttons[0] === 'Activate on UmRT_Default (198.51.100.4.1.1)', 'platforms that match: the plain confirmation');
    delete settings['tcToolkit.xaeBuild.platform'];

    // A platform the solution does not declare: refused before XAE starts, naming what to add.
    slnPath = SLN2;
    before = builds().length;
    const errs0 = calls.errors.length;
    const mm0 = calls.modals.length;
    answers.message.push('Run anyway'); // sample 2's shell pre-check (only XAE Shell 64 here)
    answers.quickPick.push('198.51.100.4.1.1');
    r = await run('twincat.xaeBuildAndActivate', {});
    assert(r.reason === 'platform-not-declared' && r.targetPlatform === 'TwinCAT OS (x64)' && builds().length === before
        && calls.modals.slice(mm0).length === 0, 'not declared: refused before anything is spawned, no confirmation asked');
    assert(calls.errors.slice(errs0).some(e => /UmRT_Default \(198\.51\.100\.4\.1\.1\) runs TwinCAT OS \(x64\), but TcToolkitSample2 does not declare 'Release\|TwinCAT OS \(x64\)'/.test(e.m)
        && /Add the solution platform 'TwinCAT OS \(x64\)' in XAE's Configuration Manager/.test(e.m)), 'the refusal names the platform to add in XAE\'s Configuration Manager');
    slnPath = SLN;
    // The configured pair itself is not declared (the target runs that platform): refused before the
    // modal; the driver would stop with config-not-declared after it.
    {
        settings['tcToolkit.xaeBuild.configuration'] = 'Custom';
        const b0 = builds().length;
        const m0 = calls.modals.length;
        const pe0 = calls.errors.length;
        answers.quickPick.push('198.51.100.1.1.1');
        r = await run('twincat.xaeBuildAndActivate', {});
        const refusal = calls.errors.slice(pe0).map(e => e.m).find(m => /does not declare 'Custom\|TwinCAT RT \(x64\)'/.test(m)) || '';
        assert(r.reason === 'pair-not-declared' && builds().length === b0 && calls.modals.length === m0,
            'an undeclared configuration|platform: refused before the confirmation modal, nothing spawned');
        assert(/It declares 'Debug\|TwinCAT OS \(ARMV7-A\)'/.test(refusal) && /tcToolkit\.xaeBuild\.configuration/.test(refusal) && !/TwinCAT XAE|TwinCAT Toolkit/.test(refusal),
            'the refusal lists the declared pairs and the settings to change');
        delete settings['tcToolkit.xaeBuild.configuration'];
    }
    // Gate 4's own refusal when the extension could not decide: the .sln is unreadable, so its pairs
    // are unknown and nothing is switched (kind 'unknown'); the plain modal, then the driver refuses
    // for the target confirmed. Its summary is one clean line, written once.
    {
        slnPath = path.join(TMP, 'Unreadable', 'Missing.sln');
        driver = () => ({ fixture: 'target-refused-platform' });
        answers.quickPick.push('198.51.100.4.1.1');
        answers.message.push('Activate on UmRT_Default (198.51.100.4.1.1)');
        const e1 = calls.errors.length;
        const m0 = calls.modals.length;
        const l0 = channel().lines.length;
        await run('twincat.xaeBuildAndActivate', {});
        slnPath = SLN;
        const gm = calls.modals.slice(m0);
        argv = lastSpawn().args;
        assert(gm.length === 1 && JSON.stringify(gm[0].buttons) === JSON.stringify(['Activate on UmRT_Default (198.51.100.4.1.1)']) && !/Switch/.test(gm[0].m),
            'an unreadable .sln: nothing is switched, the plain modal is asked');
        assert(argv[argv.indexOf('-TargetNetId') + 1] === '198.51.100.4.1.1' && argv[argv.indexOf('-Platform') + 1] === 'TwinCAT RT (x64)',
            'the confirmed target and the configured platform reach the driver');
        const g4 = calls.errors.slice(e1).map(e => e.m).find(m => /activation target/.test(m)) || '';
        assert(g4 && !/,\./.test(g4) && /198\.51\.100\.4\.1\.1, which runs 'TwinCAT OS \(x64\)'/.test(g4), `the driver's gate-4 refusal reads as one line (${g4.slice(0, 90)}…)`);
        const told = channel().lines.slice(l0).filter(l => /which runs 'TwinCAT OS \(x64\)'/.test(l));
        // The driver's own human log line is one; the summary is the other. The fatal text is not repeated as a detail.
        assert(told.length === 2 && told.filter(l => /could not run/.test(l)).length === 1 && !channel().lines.slice(l0).some(l => /^\s+'Release\|TwinCAT OS \(x64\)' to build and activate here\.$/.test(l)),
            'the refusal is written to the channel once (the summary), not again as a multi-line detail');
    }


    driver = () => ({ fixture: 'activation-run' });
    answers.quickPick.push('198.51.100.4.1.1');
    answers.message.push('Switch for this run');
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

    // ── An activation's re-runs keep its confirmation: no second list, pick or modal ─────────────
    const listings = () => fake.calls.filter(c => c.args.includes('-ListTargets')).length;
    {
        // Build again with the window shown, after a switched platform.
        const lt0 = listings(), m0 = calls.modals.length, pk0 = calls.picks.length, n0 = builds().length;
        driver = (c) => ({ fixture: c.args.includes('-ShowWindow') ? 'activation-run' : 'errors-no-details-headless' });
        answers.quickPick.push('198.51.100.4.1.1');
        answers.message.push('Switch for this run', 'Build again with the window shown');
        await run('twincat.xaeBuildAndActivate', {});
        await waitFor(() => builds().length === n0 + 2);
        await waitFor(() => !api.isRunning());
        const [first, again] = builds().slice(n0);
        assert(again && again.args.includes('-ShowWindow') && again.args.includes('-ActivateConfiguration')
            && again.args[again.args.indexOf('-TargetNetId') + 1] === '198.51.100.4.1.1' && again.args[again.args.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)'
            && first.args[first.args.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)',
            'Build again with the window shown (activation): the confirmed target and the switched platform');
        assert(listings() === lt0 + 1 && calls.modals.length === m0 + 1 && calls.picks.length === pk0 + 1,
            'one target list, one pick and ONE modal for the activation and its re-run');
        assert(channel().lines.some(l => /Re-run of the activation confirmed above/.test(l))
            && channel().lines.filter(l => /confirmed in place of TwinCAT RT \(x64\)/.test(l)).length >= 2, 'the re-run says so and still names the switch');
    }
    {
        // The stall offer during an activation.
        const actStall = [{ v: 1, t: 'hello', mode: 'activate', showWindow: false }, { v: 1, t: 'phase', name: 'open' }];
        let k = 0;
        driver = () => (k++ === 0 ? { lines: actStall, onCancelFile: { lines: rows('cancelled').slice(-2), exit: 4 } } : { fixture: 'activation-run' });
        const lt0 = listings(), m0 = calls.modals.length, n0 = builds().length;
        answers.quickPick.push('198.51.100.4.1.1');
        answers.message.push('Switch for this run');
        answers.stall = STALL_RERUN;
        r = await run('twincat.xaeBuildAndActivate', {});
        answers.stall = undefined;
        const two = builds().slice(n0);
        assert(r.ok && two.length === 2 && two[1].args.includes('-ShowWindow')
            && two.every(c => c.args[c.args.indexOf('-TargetNetId') + 1] === '198.51.100.4.1.1' && c.args[c.args.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)'),
            'the stall re-run of an activation keeps the confirmed target and platform');
        assert(listings() === lt0 + 1 && calls.modals.length === m0 + 1, 'and asks no second list or modal');
    }
    {
        // A confirmation cannot be passed in from outside: the command's own arguments never skip the modal.
        const m0 = calls.modals.length, pk0 = calls.picks.length, n0 = builds().length;
        r = await run('twincat.xaeBuildAndActivate', {
            confirmedActivation: { slnPath: SLN, configuration: 'Release', platform: 'TwinCAT RT (x64)', switchedFrom: '', target: { netId: '198.51.100.1.1.1', name: 'x' } }
        });
        assert(r.reason === 'cancelled' && calls.picks.length === pk0 + 1 && calls.modals.length === m0 && builds().length === n0,
            'a forged confirmedActivation argument is ignored: the target is asked again');
    }

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
    answers.quickPick.push('198.51.100.1.1.1');
    answers.message.push('Activate on Real-time runtime (198.51.100.1.1.1)');
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

    // The user's Cancel wins over the stall re-run, in either order.
    {
        // Re-run chosen, then Cancel during the grace period: no re-run.
        n = 0;
        driver = () => (n++ === 0 ? { lines: stallRows, onCancelFile: { lines: [], stay: true } } : { fixture: 'build-ok-visible' });
        answers.stall = STALL_RERUN;
        stallSpawns = builds().length;
        p = run('twincat.xaeBuild', {});
        await waitFor(() => builds().length === stallSpawns + 1 && lastSpawn().cancelFileSeen);
        answers.stall = undefined;
        currentToken.cancel();
        lastSpawn().child.emit('close', 4);
        r = await p;
        await new Promise(res => setTimeout(res, 30));
        assert(builds().length === stallSpawns + 1 && !r.ok, 'Cancel after choosing the stall re-run: the run stops and nothing is re-run');
        // The offer stays on screen, the user presses Cancel, then answers the offer with re-run: no re-run.
        n = 0;
        driver = () => (n++ === 0 ? { lines: stallRows, onCancelFile: { lines: [], stay: true } } : { fixture: 'build-ok-visible' });
        let answerStall = () => {};
        answers.stall = new Promise(res => { answerStall = () => res(STALL_RERUN); });
        const w0 = calls.warnings.filter(w => w.stall).length;
        stallSpawns = builds().length;
        p = run('twincat.xaeBuild', {});
        await waitFor(() => calls.warnings.filter(w => w.stall).length === w0 + 1);
        currentToken.cancel();
        await waitFor(() => lastSpawn().cancelFileSeen);
        answerStall();
        await new Promise(res => setTimeout(res, 5));
        lastSpawn().child.emit('close', 4);
        r = await p;
        answers.stall = undefined;
        await new Promise(res => setTimeout(res, 30));
        assert(builds().length === stallSpawns + 1 && !r.ok, 'the stall offer answered after Cancel: nothing is re-run');
    }

    // ── A configuration the solution does not declare ───────────────────────────────────────────
    n = 0;
    driver = () => (n++ === 0 ? { fixture: 'config-not-declared' } : { fixture: 'build-ok-headless' });
    answers.quickPick.push('Release|TwinCAT OS (x64)', 'Run once');
    await run('twincat.xaeBuild', {});
    argv = lastSpawn().args;
    assert(argv[argv.indexOf('-Configuration') + 1] === 'Release' && argv[argv.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)', 'the picked pair is used for the re-run');
    assert(!workspaceSettings['tcToolkit.xaeBuild.platform'], '"Run once" writes no setting');
    {
        // The configuration re-run keeps a confirmed shell substitution (sample 2, 4024, only 4026 here).
        slnPath = SLN2;
        n = 0;
        driver = () => (n++ === 0 ? { fixture: 'config-not-declared' } : { fixture: 'build-ok-headless' });
        answers.message.push('Build with XAE Shell 64');
        answers.quickPick.push('Release|TwinCAT OS (x64)', 'Run once');
        const m0 = calls.modals.length, n0 = builds().length;
        await run('twincat.xaeBuild', {});
        slnPath = SLN;
        const both = builds().slice(n0);
        assert(both.length === 2 && both.every(c => c.args[c.args.indexOf('-TcVersion') + 1] === 'TcXaeShell.DTE.17.0' && c.args.includes('-AllowVersionMismatch'))
            && both[1].args[both[1].args.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)' && calls.modals.length === m0 + 1,
            'the configuration re-run keeps the confirmed shell, and the shell is asked once');
    }

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

        // The other direction: a 4026 project (sample 1) where only the OLDER 4024 shell is installed.
        // Never offered, neither by the pre-check nor after the driver's fatal; the error names the shell.
        {
            slnPath = SLN;
            settings['tcToolkit.xaeShell.path4026'] = '';
            detected = { 4024: { path: 'C:\\x\\TcXaeShell.exe', source: 'registry' } };
            const olderRows = fatalRows(['TcXaeShell.DTE.15.0']).map(l => (l.t === 'fatal'
                ? { ...l, text: "DTE ProgId 'TcXaeShell.DTE.17.0' is not registered.", data: { progId: 'TcXaeShell.DTE.17.0', build: '4026', projectVersion: '3.1.4026.28', installed: ['TcXaeShell.DTE.15.0'] } }
                : l));
            driver = () => ({ lines: olderRows, exit: 2 });
            p0 = prompts();
            b0 = builds().length;
            e0 = calls.errors.length;
            r = await run('twincat.xaeBuild', {});
            assert(!r.ok && prompts() === p0 && builds().length === b0 + 1 && !lastSpawn().args.includes('-TcVersion'),
                'only an older shell installed: no offer before or after the run, one run without -TcVersion');
            assert(/saved with TwinCAT 3\.1\.4026 and its XAE Shell 64 \(4026\) is not installed\. XAE Shell \(4024\) is installed, but an older XAE Shell cannot open a project saved with a newer TwinCAT\. Install XAE Shell 64 \(4026\)/.test(calls.errors[e0].m),
                'and the error names the shell to install and why the older one is not used');
            detected = {};
            settings['tcToolkit.xaeShell.path4026'] = __filename;
            slnPath = SLN2;
        }
        // The confirmed substitute is itself not registered (its exe is on disk, COM does not know it).
        {
            const subRows = fatalRows([]).map(l => (l.t === 'fatal'
                ? { ...l, text: "DTE ProgId 'TcXaeShell.DTE.17.0' is not registered.", data: { progId: 'TcXaeShell.DTE.17.0', build: '4026', projectVersion: '3.1.4024.62', installed: [] } }
                : l));
            driver = () => ({ lines: subRows, exit: 2 });
            answers.message.push('Build with XAE Shell 64');
            p0 = prompts();
            e0 = calls.errors.length;
            r = await run('twincat.xaeBuild', {});
            assert(!r.ok && prompts() === p0 + 1 && overrideOk(lastSpawn().args)
                && /TcToolkitSample2 was saved with TwinCAT 3\.1\.4024, and XAE Shell 64 \(4026\) \(TcXaeShell\.DTE\.17\.0\), chosen in place of its XAE Shell \(4024\), is not registered with COM either/.test(calls.errors[e0].m),
                'the substitute unregistered: one prompt only, and the error names the project\'s version and the substitution');
        }

        // 3. Activation is never offered another shell: the pre-check warns (Run anyway), the driver's fatal asks nothing.
        driver = () => ({ lines: fatalRows(['TcXaeShell.DTE.17.0']).map(l => (l.t === 'hello' ? { ...l, mode: 'activate' } : l)), exit: 2 });
        p0 = prompts();
        const m0 = calls.modals.length;
        e0 = calls.errors.length;
        answers.message.push('Run anyway');
        answers.quickPick.push('198.51.100.1.1.1');
        answers.message.push('Activate on Real-time runtime (198.51.100.1.1.1)');
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
