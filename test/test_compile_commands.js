/**
 * @file test_compile_commands.js
 * @description The VS Code half of Compile Project — src/commands/compileCommands.js and its hooks in
 * src/customEditorProvider.js — under a stubbed `vscode` module and a fake child process (the pattern
 * of test_start_commands.js). No compiler runs here.
 *
 * Pinned: the project pick (one project runs at once, several ask), the setup refusal with its
 * "Open Settings" offer, a clean run, a run with errors (the Problems entries: file, pane range,
 * message with component/pane/line, source, link; the pane markers; the status text; the summary),
 * unsaved edits reaching the compiler, "Go to Problem…" and the entry links navigating through
 * `twincat.openComponent` with the exact pane and line, a component edit dropping its results, the
 * next run replacing everything, a failed run keeping the previous results, cancellation, and a
 * file opened fresh starting on its first problem.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createFakeSpawn } = require('./_fakeChild');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const REPO = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_compile_commands_'));

// ── Project fixture on disk ─────────────────────────────────────────────────────────────────────
const CRLF = '\r\n';
const cdata = (text) => `<![CDATA[${text}]]>`;
const fbXml = (body) => [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1">',
    '  <POU Name="FB_A" Id="{a}" SpecialFunc="None">',
    `    <Declaration>${cdata(`FUNCTION_BLOCK FB_A${CRLF}VAR${CRLF}\tn : INT;${CRLF}END_VAR`)}</Declaration>`,
    `    <Implementation><ST>${cdata('n := n + 1;')}</ST></Implementation>`,
    '    <Method Name="Run" Id="{b}">',
    `      <Declaration>${cdata('METHOD Run : BOOL')}</Declaration>`,
    `      <Implementation><ST>${cdata(body)}</ST></Implementation>`,
    '    </Method>',
    '  </POU>',
    '</TcPlcObject>'
].join(CRLF);
const gvlXml = `<TcPlcObject><GVL Name="GVL_Io" Id="{g}"><Declaration>${cdata(`VAR_GLOBAL${CRLF}\tb : BOOL;${CRLF}END_VAR`)}</Declaration></GVL></TcPlcObject>`;
const fbPath = path.join(ROOT, 'PLC', 'POUs', 'FB_A.TcPOU');
const gvlPath = path.join(ROOT, 'PLC', 'GVLs', 'GVL_Io.TcGVL');
fs.mkdirSync(path.dirname(fbPath), { recursive: true });
fs.mkdirSync(path.dirname(gvlPath), { recursive: true });
fs.writeFileSync(fbPath, fbXml(`n := 0;${CRLF}nNope := 5;`));
fs.writeFileSync(gvlPath, gvlXml);
const bundlePath = path.join(ROOT, 'bundle.cjs');
fs.writeFileSync(bundlePath, '// stand-in');

// ── A recording `vscode` stub ───────────────────────────────────────────────────────────────────
const calls = { executed: [], errors: [], infos: [], warnings: [], progress: [], status: null };
const handlers = new Map();
const answers = { quickPick: [], message: [] };
const settings = {};
const listeners = { config: [], docChange: [] };
const uri = (p) => ({ fsPath: p, scheme: 'file', path: p, query: '', toString: () => 'file://' + p.split(path.sep).join('/') });
class Range { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
const collections = [];
let uriHandler = null;
let cancelNextRun = false;
const message = (bucket) => async (m, ...buttons) => { calls[bucket].push({ m, buttons }); return answers.message.shift(); };
const vscodeStub = {
    Uri: {
        file: uri,
        joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
        parse: (s) => { const m = /^([a-z-]+):\/\/([^/]*)([^?]*)\??(.*)$/.exec(s) || []; return { scheme: m[1], authority: m[2], path: m[3], query: m[4] || '', fsPath: s, toString: () => s }; }
    },
    Range, Diagnostic,
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
            get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, `${section}.${key}`) ? settings[`${section}.${key}`] : fallback)
        }),
        onDidChangeConfiguration: (fn) => { listeners.config.push(fn); return { dispose() {} }; },
        onDidChangeTextDocument: (fn) => { listeners.docChange.push(fn); return { dispose() {} }; }
    },
    window: {
        createStatusBarItem: () => { calls.status = { text: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; return calls.status; },
        showQuickPick: async (items, opts) => {
            calls.lastPick = { items, opts };
            const want = answers.quickPick.shift();
            return want === undefined ? undefined : (typeof want === 'function' ? items.find(want) : items.find(i => i.label === want || i.key === want));
        },
        showErrorMessage: message('errors'),
        showInformationMessage: message('infos'),
        showWarningMessage: message('warnings'),
        withProgress: async (opts, task) => {
            calls.progress.push(opts);
            const cancelListeners = [];
            const token = { isCancellationRequested: false, onCancellationRequested: (fn) => { cancelListeners.push(fn); return { dispose() {} }; } };
            if (cancelNextRun) {
                cancelNextRun = false;
                setTimeout(() => { token.isCancellationRequested = true; cancelListeners.forEach(fn => fn()); }, 20);
            }
            return task({ report() {} }, token);
        },
        registerUriHandler: (h) => { uriHandler = h; return { dispose() {} }; },
        createOutputChannel: (name) => {
            const ch = { name, lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} };
            calls.outputs = (calls.outputs || []).concat([ch]);
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

const { registerCompileCommands, DIAGNOSTIC_SOURCE, GO_TO_PROBLEM_COMMAND, OUTPUT_CHANNEL_NAME } = require('../src/commands/compileCommands');
const { TwinCatCustomEditorProvider } = require('../src/customEditorProvider');
const { buildCheckUnit } = require('../src/checkUnit');
const { parseTwinCatXml } = require('../src/xmlParser');

// ── The real provider (for its compile hooks), a project map, and the fake compiler ─────────────
const memento = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { m.set(k, v); return Promise.resolve(); } }; };
const context = {
    subscriptions: [], extensionPath: REPO, extensionUri: uri(REPO), extension: { id: 'pub.twincat-plc-toolkit' },
    globalState: memento(), workspaceState: memento()
};
const project = (key, name, files) => ({ key, name, dir: path.join(ROOT, 'PLC'), objectFiles: new Map(files.map(f => [f.toLowerCase(), f])) });
let projectList = [project('a', 'PLC', [fbPath, gvlPath])];
const projectMap = () => ({
    projects: new Map(projectList.map(p => [p.key, p])),
    keys: () => projectList.map(p => p.key),
    get: (k) => projectList.find(p => p.key === k),
    displayName: (k) => projectList.find(p => p.key === k).name,
    ownersOf: (p) => projectList.filter(pr => [...pr.objectFiles.values()].includes(p)).map(pr => pr.key)
});
const provider = new TwinCatCustomEditorProvider(context, { getProjectMap: projectMap });
// An open editor of FB_A, as the provider tracks it.
const fbUri = uri(fbPath);
const panelPosts = [];
provider.activePanels.set(fbUri.toString(), { webview: { postMessage: (m) => { panelPosts.push(m); return Promise.resolve(true); } } });

/** What the fake compiler answers; `seenUnits` records the unit texts it was given. */
let compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [], summary: {} }), code: 0 });
let nodeVersion = 'v22.5.0';
const seenUnits = [];
const fake = createFakeSpawn((call) => {
    if (call.args[0] === '--version') return { stdout: nodeVersion + '\n', code: 0 };
    const units = {};
    for (const f of fs.readdirSync(call.options.cwd)) units[f] = fs.readFileSync(path.join(call.options.cwd, f), 'utf8');
    seenUnits.push(units);
    return compilerAnswer(call, units);
});
let settingsChanged = 0;
const compile = registerCompileCommands(context, { provider, getProjectMap: projectMap, onSettingsChanged: () => { settingsChanged++; }, spawn: fake.spawn,
    // Only `node` on PATH (the fake): the editor's own runtime would otherwise rescue a too-old Node.
    nodeDiscovery: { platform: 'linux', env: {}, runtime: null } });
const run = (id, ...args) => vscodeStub.commands.executeCommand(id, ...args);
const problems = collections[0];
const unitLineOf = (xml, text) => buildCheckUnit(parseTwinCatXml(xml)).lines.indexOf(text) + 1;
const errorReport = (line) => ({
    stdout: JSON.stringify({ dialect: 'twincat3', files: ['1.st', '2.st'], summary: {}, diagnostics: [
        { file: '1.st', line, column: 1, severity: 'error', message: "Undeclared variable 'NNOPE'" },
        { file: '1.st', line: 3, column: 2, severity: 'warning', message: 'Unused variable' },
        { file: '2.st', line: 1, column: 1, severity: 'warning', message: "Pragma ignored: {attribute 'qualified_only'}" }
    ] }), code: 1
});
const settle = () => new Promise(r => setTimeout(r, 10));

(async () => {
    assert(handlers.has('twincat.compileProject') && handlers.has(GO_TO_PROBLEM_COMMAND) && !!uriHandler && problems.name === 'twincat-compile',
        'REGISTER: the command, the problem picker, the link handler and one diagnostic collection');

    // ── The bundled compiler, and the setting as an override ───────────────────────────────────
    const BUNDLED = path.join(REPO, 'resources', 'compiler', 'compiler.cjs');
    assert(compile.isAvailable() === true, 'TILE: with the setting empty the bundled compiler is available');
    let result = await run('twincat.compileProject');
    await settle();
    const bundledCall = fake.calls[fake.calls.length - 1];
    assert(result.ok === true && bundledCall.args[0] === BUNDLED && bundledCall.args.includes('--check'),
        `BUNDLED: with nothing configured the command runs the bundled compiler (${bundledCall.args[0]})`);
    for (const k of ['executed', 'errors', 'infos', 'warnings', 'progress']) calls[k].length = 0;

    settings['tcToolkit.compiler.path'] = path.join(ROOT, 'gone.cjs');
    assert(compile.isAvailable() === false, 'TILE: an override path that does not exist makes the compiler unavailable');
    answers.message.push('Open Settings');
    const probesFrom = fake.calls.length;
    result = await run('twincat.compileProject');
    await settle();
    assert(result.ok === false && result.reason === 'setup' && calls.errors.length === 1 &&
        /Compile Project cannot run\. The compiler file ".*gone\.cjs" \(setting "tcToolkit\.compiler\.path"\) does not exist/.test(calls.errors[0].m) &&
        calls.errors[0].buttons.join() === 'Open Settings',
        `SETUP: a missing override compiler is explained and the settings are offered (${calls.errors[0] && calls.errors[0].m})`);
    assert(calls.executed.some(c => c.id === 'twincat.openSettings' && c.args[0] === 'tcToolkit.compiler'),
        'SETUP: "Open Settings" opens the compiler settings');
    assert(fake.calls.slice(probesFrom).every(c => c.args[0] === '--version') && problems.map.size === 0, 'SETUP: the compiler was not started');

    settings['tcToolkit.compiler.path'] = bundlePath;
    assert(compile.isAvailable() === true, 'TILE: an override path that exists counts as available');

    nodeVersion = 'v18.19.0';
    calls.errors.length = 0;
    result = await run('twincat.compileProject');
    assert(result.reason === 'setup' && /Node\.js 18\.19\.0 was found/.test(calls.errors[0].m) && /Node\.js 22 or newer/.test(calls.errors[0].m),
        'SETUP: a Node that is too old is named with its version');
    nodeVersion = 'v22.5.0';
    settings['tcToolkit.compiler.nodePath'] = path.join(ROOT, 'no-node');
    calls.errors.length = 0;
    result = await run('twincat.compileProject');
    assert(result.reason === 'setup' && /does not exist/.test(calls.errors[0].m) && /tcToolkit\.compiler\.nodePath/.test(calls.errors[0].m),
        'SETUP: a Node path that does not exist is named');
    delete settings['tcToolkit.compiler.nodePath'];

    // ── A clean run ─────────────────────────────────────────────────────────────────────────────
    calls.errors.length = 0;
    result = await run('twincat.compileProject');
    await settle();
    assert(result.ok && result.errors === 0 && result.warnings === 0 && calls.infos.length === 1 && calls.infos[0].m === 'Compile Project — PLC: no errors.' &&
        calls.infos[0].buttons.length === 0, `CLEAN: "no errors" (${calls.infos[0] && calls.infos[0].m})`);
    assert(calls.status.shown && /no errors/.test(calls.status.text) && problems.map.size === 0, 'CLEAN: the status bar says so; the Problems panel is empty');
    assert(calls.progress.length === 1 && calls.progress[0].cancellable === true && /Compiling PLC/.test(calls.progress[0].title), 'RUN: progress is shown and can be cancelled');
    assert(calls.lastPick === undefined, 'PICK: one project runs without asking');
    const compilerCall = fake.calls[fake.calls.length - 1];
    assert(compilerCall.command === 'node' && compilerCall.args[0] === bundlePath && compilerCall.args.includes('--check') && compilerCall.args.includes('--json') &&
        compilerCall.args[compilerCall.args.indexOf('--dialect-file') + 1] === path.join(REPO, 'resources', 'dialects', 'twincat3.json') &&
        compilerCall.args.join(' ').includes('--global-list 2.st=GVL_Io'),
        'RUN: the compiler is started as a child process with the vendored dialect profile and the GVL name');
    assert(!fs.existsSync(compilerCall.options.cwd), 'RUN: the temporary directory is gone after the run');
    assert(!fs.existsSync(path.join(ROOT, 'PLC', 'ST_Files')) && fs.readdirSync(path.join(ROOT, 'PLC', 'POUs')).join() === 'FB_A.TcPOU', 'RUN: nothing is written into the project');

    // ── A run with an error and a warning ───────────────────────────────────────────────────────
    const onDiskXml = fs.readFileSync(fbPath, 'utf8');
    compilerAnswer = () => errorReport(unitLineOf(onDiskXml, 'nNope := 5;'));
    panelPosts.length = 0;
    answers.message.push(undefined);
    result = await run('twincat.compileProject');
    await settle();
    assert(result.ok && result.errors === 1 && result.warnings === 1 && result.filteredPragmaWarnings === 1 &&
        calls.errors.length === 1 && calls.errors[0].m === 'Compile Project — PLC: 1 error, 1 warning.' &&
        calls.errors[0].buttons.join() === 'Go to Problem…,Open Problems',
        `ERRORS: the summary counts errors and warnings, without the filtered pragma warning (${calls.errors[0] && calls.errors[0].m})`);
    assert(calls.status.text === '$(error) 1 $(warning) 1 Compile', `ERRORS: the status bar shows the counts (${calls.status.text})`);
    const entries = problems.map.get(fbUri.toString()) || [];
    assert(problems.map.size === 1 && entries.length === 2, 'PROBLEMS: both diagnostics are published on the object\'s file; the GVL has none');
    const err = entries.find(d => d.severity === 0);
    assert(!!err && err.source === DIAGNOSTIC_SOURCE && err.source === 'TC Toolkit compile' &&
        err.message === "Undeclared variable 'NNOPE' [Run, implementation line 2]",
        `PROBLEMS: the entry names the component, pane and pane line (${err && err.message})`);
    assert(!!err && err.range.start.line === 1 && err.range.start.character === 0 && err.range.end.line === 1 && err.range.end.character === 11,
        `PROBLEMS: its range is the pane's line and column, so Ln/Col match what the pane shows (${err && JSON.stringify(err.range)})`);
    assert(!!err && err.code.value === 'Run, implementation line 2' && /^vscode:\/\/pub\.twincat-plc-toolkit\/compileProblem\?id=\d+$/.test(err.code.target.toString()),
        `PROBLEMS: its code is a link back into the extension (${err && err.code.target.toString()})`);
    const warn = entries.find(d => d.severity === 1);
    assert(!!warn && warn.message === 'Unused variable [declaration line 3]', 'PROBLEMS: a compiler warning is a warning');

    const posted = panelPosts.filter(m => m.type === 'compileDiagnostics');
    assert(posted.length === 1 && posted[0].diagnostics.length === 2 &&
        JSON.stringify(posted[0].diagnostics[0]) === JSON.stringify({ componentId: 'method_Run', pane: 'impl', severity: 1, message: "Undeclared variable 'NNOPE'",
            range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 12 } }),
        'PANES: the open editor receives the markers in pane coordinates');
    assert(posted[0].diagnostics[1].componentId === 'root' && posted[0].diagnostics[1].pane === 'decl' && posted[0].diagnostics[1].severity === 2, 'PANES: the warning goes to the declaration pane');

    // ── Navigation ──────────────────────────────────────────────────────────────────────────────
    const openCalls = () => calls.executed.filter(c => c.id === 'twincat.openComponent');
    await uriHandler.handleUri(err.code.target);
    let nav = openCalls().pop();
    assert(!!nav && nav.args[0].fsPath === fbPath && nav.args[1] === 'method_Run' &&
        JSON.stringify(nav.args[2]) === JSON.stringify({ pane: 'impl', localLine: 1, start: { character: 0 }, end: { character: 11 } }),
        'LINK: a Problems entry\'s link opens the file at the component, pane and line (twincat.openComponent)');
    const before = openCalls().length;
    await uriHandler.handleUri(vscodeStub.Uri.parse('vscode://pub.twincat-plc-toolkit/compileProblem?id=99999'));
    await uriHandler.handleUri(vscodeStub.Uri.parse('vscode://pub.twincat-plc-toolkit/somethingElse?id=1'));
    assert(openCalls().length === before, 'LINK: an unknown id or another path opens nothing');

    answers.quickPick.push((i) => /Unused/.test(i.label));
    await run(GO_TO_PROBLEM_COMMAND);
    nav = openCalls().pop();
    assert(calls.lastPick.items.length === 2 && /\$\(error\)/.test(calls.lastPick.items[0].label) && calls.lastPick.items[0].detail === 'Run, implementation line 2' &&
        nav.args[1] === 'root' && nav.args[2].pane === 'decl' && nav.args[2].localLine === 2,
        'GOTO: "Go to Problem…" lists every problem, errors first, and opens the picked one');

    // A file opened fresh starts on its first problem — once.
    const first = provider.compileSource.openTarget(fbUri.toString());
    assert(!!first && first.componentId === 'method_Run' && first.range.pane === 'impl' && first.range.localLine === 1 &&
        provider.compileSource.openTarget(fbUri.toString()) === null && provider.compileSource.openTarget(uri(gvlPath).toString()) === null,
        'OPEN: a fresh editor of a file with problems starts on its first error, once per run; a clean file is left alone');

    // ── An edit to a component drops that component's results ───────────────────────────────────
    provider.compileSource.onComponentEdited(fbUri.toString(), 'method_Run');
    let left = problems.map.get(fbUri.toString()) || [];
    assert(left.length === 1 && left[0].severity === 1 && provider.compileSource.paneDiagnostics(fbUri.toString()).length === 1 &&
        calls.status.text === '$(error) 0 $(warning) 1 Compile', 'EDIT: editing the method removes its problem everywhere; the other component keeps its own');
    provider.compileSource.onComponentEdited(fbUri.toString(), 'root');
    assert(problems.map.size === 0 && /no errors/.test(calls.status.text), 'EDIT: the last problem gone, the file leaves the Problems panel');

    // ── Unsaved edits reach the compiler ────────────────────────────────────────────────────────
    // (a) an open document with unsaved text; (b) Manual Sync's pending edit on top of it.
    const openDoc = { uri: fbUri, getText: () => fbXml('n := 111;') };
    vscodeStub.workspace.textDocuments = [openDoc];
    compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [], summary: {} }), code: 0 });
    await run('twincat.compileProject');
    assert(seenUnits[seenUnits.length - 1]['1.st'].includes('n := 111;') && !seenUnits[seenUnits.length - 1]['1.st'].includes('nNope'),
        'UNSAVED: an open document\'s unsaved text is what gets compiled, not the file on disk');
    const runCtx = parseTwinCatXml(openDoc.getText()).components.find(c => c.id === 'method_Run').xmlContext;
    await provider.pendingEditsStore.set(fbUri.toString(), { method_Run_ST: { context: runCtx, blockType: 'ST', content: 'n := 222;' } }, openDoc.getText());
    await run('twincat.compileProject');
    assert(seenUnits[seenUnits.length - 1]['1.st'].includes('n := 222;') && !seenUnits[seenUnits.length - 1]['1.st'].includes('n := 111;'),
        'UNSAVED: a Manual Sync pending edit is folded in, so the check sees what the pane shows');
    await provider.pendingEditsStore.delete(fbUri.toString());

    // A run with problems, for the failed run below to keep.
    compilerAnswer = (call, units) => errorReport(units['1.st'].split('\n').indexOf('nNope := 5;') + 1);
    openDoc.getText = () => fbXml(`n := 0;${CRLF}nNope := 5;`);
    await run('twincat.compileProject');
    vscodeStub.workspace.textDocuments = [];

    // ── A failed run keeps the previous results; the next good run replaces them ────────────────
    compilerAnswer = () => ({ stdout: 'not json', stderr: 'TypeError: boom', code: 1 });
    calls.errors.length = 0;
    result = await run('twincat.compileProject');
    assert(result.ok === false && result.reason === 'failed' && /Compile Project did not finish\. The compiler's output could not be read/.test(calls.errors[0].m) &&
        (problems.map.get(fbUri.toString()) || []).length === 2, 'FAILED: malformed compiler output is reported; it is not "no errors", and the earlier results stay');
    compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: null, files: [], diagnostics: [{ file: null, line: 0, column: 0, severity: 'error', message: 'dialect file x: ENOENT' }], summary: {} }), code: 2 });
    calls.errors.length = 0;
    result = await run('twincat.compileProject');
    assert(result.reason === 'failed' && /could not run the check: dialect file x: ENOENT/.test(calls.errors[0].m), 'FAILED: exit code 2 shows the compiler\'s reason');
    compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [], summary: {} }), code: 0 });
    panelPosts.length = 0;
    result = await run('twincat.compileProject');
    assert(result.ok && problems.map.size === 0 && panelPosts.some(m => m.type === 'compileDiagnostics' && m.diagnostics.length === 0),
        'NEXT RUN: a finished run replaces everything — Problems and pane markers are cleared');

    // ── Cancellation ────────────────────────────────────────────────────────────────────────────
    compilerAnswer = () => ({ hang: true });
    cancelNextRun = true;
    calls.errors.length = 0;
    result = await run('twincat.compileProject');
    assert(result.ok === false && result.reason === 'cancelled' && fake.calls[fake.calls.length - 1].killed && calls.errors.length === 0 &&
        !fs.existsSync(fake.calls[fake.calls.length - 1].options.cwd), 'CANCEL: cancelling stops the compiler, cleans up and reports nothing');
    compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [], summary: {} }), code: 0 });

    // ── Messages that name no object, and several projects ──────────────────────────────────────
    compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], summary: {}, diagnostics: [{ file: null, line: 0, column: 0, severity: 'error', message: 'Library X failed to load' }] }), code: 1 });
    calls.errors.length = 0;
    result = await run('twincat.compileProject');
    await settle();
    assert(result.ok && result.errors === 1 && /1 error, 0 warnings\. 1 message\(s\) not tied to an object: Library X failed to load/.test(calls.errors[0].m),
        'GENERAL: an error that names no object is counted and shown in the summary, never dropped');
    compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [], summary: {} }), code: 0 });

    projectList = [project('b', 'Zeta', [gvlPath]), project('a', 'Alpha', [fbPath, gvlPath])];
    calls.lastPick = undefined;
    answers.quickPick.push('Zeta');
    const unitsBefore = seenUnits.length;
    result = await run('twincat.compileProject');
    assert(result.ok && result.projectKey === 'b' && calls.lastPick.items.map(i => i.label).join() === 'Alpha,Zeta' && !calls.lastPick.opts.canPickMany &&
        Object.keys(seenUnits[seenUnits.length - 1]).join() === '1.st', 'PICK: several projects ask for ONE; only that project\'s objects are compiled');
    result = await run('twincat.compileProject');
    assert(result.ok === false && result.reason === 'cancelled' && seenUnits.length === unitsBefore + 1, 'PICK: dismissing the pick compiles nothing');
    result = await run('twincat.compileProject', { projectKey: 'a' });
    assert(result.ok && result.projectKey === 'a' && Object.keys(seenUnits[seenUnits.length - 1]).length === 2, 'PICK: a caller can name the project');

    projectList = [];
    calls.warnings.length = 0;
    result = await run('twincat.compileProject');
    assert(result.reason === 'no-project' && /needs a TwinCAT PLC project/.test(calls.warnings[0].m), 'NO PROJECT: without a .plcproj the command says so');

    // ── Settings changes reach the start page ───────────────────────────────────────────────────
    listeners.config.forEach(fn => fn({ affectsConfiguration: (s) => s === 'tcToolkit.compiler' }));
    listeners.config.forEach(fn => fn({ affectsConfiguration: () => false }));
    assert(settingsChanged === 1, 'SETTINGS: a change to tcToolkit.compiler.* is passed on (the start page re-reads the tile state)');

    // ── The editor toolbar's Compile button, host side ──────────────────────────────────────────
    // The real resolveCustomTextEditor with a fake panel: `compile-project` from the webview runs the
    // command for the project that owns the editor's file, and every editor's button follows the run.
    {
        const toPanel = [];
        let onMessage = null;
        const panel = {
            active: true,
            onDidChangeViewState: () => ({ dispose() {} }),
            onDidDispose: () => ({ dispose() {} }),
            webview: {
                options: {}, html: '', cspSource: 'vscode-webview://x',
                asWebviewUri: (u) => u,
                postMessage: (m) => { toPanel.push(m); return Promise.resolve(true); },
                onDidReceiveMessage: (fn) => { onMessage = fn; return { dispose() {} }; }
            }
        };
        const gvlDoc = { uri: uri(gvlPath), fileName: gvlPath, getText: () => fs.readFileSync(gvlPath, 'utf8'), isDirty: false };
        provider.resolveCustomTextEditor(gvlDoc, panel, { isCancellationRequested: false });
        assert(typeof onMessage === 'function' && /id="compile-btn"/.test(panel.webview.html), 'TOOLBAR: the editor page has the Compile button and a message handler');

        // Two projects, the GVL owned by the second only: the button compiles THAT project, no pick.
        projectList = [project('a', 'PLC', [fbPath]), project('b', 'PLC_Two', [gvlPath])];
        for (const k of ['executed', 'errors', 'infos', 'warnings', 'progress']) calls[k].length = 0;
        toPanel.length = 0;
        const pickBefore = calls.lastPick;
        await onMessage({ type: 'compile-project' });
        await settle();
        const ran = calls.executed.filter(c => c.id === 'twincat.compileProject');
        assert(ran.length === 1 && ran[0].args[0] && ran[0].args[0].projectKey === 'b' && calls.lastPick === pickBefore,
            `TOOLBAR: compile-project runs Compile Project for the project that owns the file, without asking (${JSON.stringify(ran.map(r => r.args))})`);
        assert(calls.infos.some(i => /PLC_Two: no errors/.test(i.m)), `TOOLBAR: the run's summary names that project (${JSON.stringify(calls.infos.map(i => i.m))})`);
        const running = toPanel.filter(m => m.type === 'compileRunning').map(m => m.running);
        assert(JSON.stringify(running) === '[true,false]', `TOOLBAR: every open editor is told the run started and ended (${JSON.stringify(running)})`);

        // A file no project owns (one several own takes the same branch): the command asks, as from the palette.
        projectList = [project('a', 'PLC', [fbPath]), project('b', 'PLC_Two', [fbPath])];
        answers.quickPick.push(undefined);
        await onMessage({ type: 'compile-project' });
        const asked = calls.executed.filter(c => c.id === 'twincat.compileProject').pop();
        assert(asked && asked.args[0] && asked.args[0].projectKey === undefined && calls.lastPick !== pickBefore,
            'TOOLBAR: a file no single project owns leaves the choice to the command\'s project pick');

        // Setup problems reach the user exactly as from the command.
        projectList = [project('a', 'PLC', [fbPath, gvlPath])];
        settings['tcToolkit.compiler.path'] = path.join(ROOT, 'gone.cjs');
        for (const k of ['executed', 'errors', 'infos', 'warnings', 'progress']) calls[k].length = 0;
        answers.message.push(undefined);
        await onMessage({ type: 'compile-project' });
        await settle();
        assert(calls.errors.length === 1 && /^Compile Project cannot run\. The compiler file/.test(calls.errors[0].m),
            `TOOLBAR: with the compiler missing the button gives the command's own message (${calls.errors[0] && calls.errors[0].m})`);
        settings['tcToolkit.compiler.path'] = bundlePath;
        nodeVersion = 'v18.19.0';
        calls.errors.length = 0;
        answers.message.push(undefined);
        await onMessage({ type: 'compile-project' });
        await settle();
        assert(calls.errors.length === 1 && /Node\.js 18\.19\.0 was found/.test(calls.errors[0].m),
            'TOOLBAR: with no usable Node the button gives the command\'s own message');
        nodeVersion = 'v22.5.0';

        // An editor opened while a run is in progress starts with its button disabled.
        provider.setCompileRunning(true);
        toPanel.length = 0;
        await onMessage({ type: 'ready' });
        const init = toPanel.find(m => m.type === 'init');
        assert(!!init && init.compileRunning === true, 'TOOLBAR: init tells a new editor a run is in progress');
        provider.setCompileRunning(false);
        provider.activePanels.delete(gvlDoc.uri.toString());
    }

    // ── Library symbols (R3.4): the filter's count and the one-time "no dump" hint ───────────────
    {
        projectList = [project('a', 'PLC', [fbPath, gvlPath])];
        const plcproj = path.join(ROOT, 'PLC', 'PLC.plcproj');
        fs.writeFileSync(plcproj, '<Project><ItemGroup><PlaceholderReference Include="Synthetic Lib"><Namespace>SynLib</Namespace></PlaceholderReference></ItemGroup></Project>');
        compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], summary: {}, diagnostics: [
            { file: '1.st', line: 1, column: 1, severity: 'error', message: "Undeclared variable 'SYNLIB'" },
            { file: '1.st', line: 1, column: 1, severity: 'error', message: "Undeclared variable 'NNOPE'" }
        ] }), code: 1 });
        for (const k of ['errors', 'infos', 'warnings']) calls[k].length = 0;
        answers.message.push(undefined);
        result = await run('twincat.compileProject');
        await settle();
        const summaryText = (calls.errors[0] || { m: '' }).m;
        assert(result.ok === true && result.errors === 1 && result.filteredLibraryDiagnostics === 1,
            `LIBRARY: an error on a library name is filtered and counted, the user's own error stays (${result.errors}/${result.filteredLibraryDiagnostics})`);
        assert(/1 error\(s\) on library symbols with no declaration available were not shown/.test(summaryText) &&
            /Run "TC Toolkit: Update Library Definitions" to check calls into libraries too\./.test(summaryText),
            `LIBRARY: the summary shows the count, and — with no signatures dump — the hint (${summaryText})`);
        calls.errors.length = 0;
        answers.message.push(undefined);
        await run('twincat.compileProject');
        await settle();
        assert(!/Update Library Definitions/.test((calls.errors[0] || { m: '' }).m), 'LIBRARY: the hint is given once per session');
        fs.rmSync(plcproj);
    }

    // ── Compiler defines (the project's "Compiler defines" field) reach the compiler as -D ────────
    {
        const plcproj = path.join(ROOT, 'PLC', 'PLC.plcproj');
        assert(!calls.outputs, 'DEFINES: a project without compiler defines opens no output channel');
        fs.writeFileSync(plcproj, ['<Project>', '  <PropertyGroup>', '    <Name>PLC</Name>',
            "    <CompilerDefines>SIM, Mode := 'fast', Axes := '4', 2bad, Plain:=x</CompilerDefines>",
            '  </PropertyGroup>', '  <ItemGroup>', '    <Compile Include="POUs\\FB_A.TcPOU">',
            '      <CompilerDefines>PER_OBJECT</CompilerDefines>', '    </Compile>', '  </ItemGroup>', '</Project>'].join(CRLF));
        projectList = [{ ...project('a', 'PLC', [fbPath, gvlPath]), plcprojPath: plcproj }];
        compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [], summary: {} }), code: 0 });
        for (const k of ['errors', 'infos', 'warnings']) calls[k].length = 0;
        answers.message.push(undefined);
        result = await run('twincat.compileProject');
        await settle();
        const call = fake.calls[fake.calls.length - 1];
        const afterDialect = call.args.slice(call.args.indexOf('--dialect-file') + 2, call.args.indexOf('--dialect-file') + 8);
        assert(JSON.stringify(afterDialect) === JSON.stringify(['-D', 'SIM', '-D', 'Mode=fast', '-D', 'Axes']),
            `DEFINES: the compiler gets -D SIM -D Mode=fast -D Axes, case kept, right after the profile (${afterDialect.join(' ')})`);
        assert(!call.args.includes('PER_OBJECT') && !call.args.some(a => /2bad|Plain/.test(a)),
            'DEFINES: a per-object define and the malformed entries are not passed');
        assert(result.ok === true && result.defineArgs.join(' ') === '-D SIM -D Mode=fast -D Axes' && result.defineNotes.length === 4,
            `DEFINES: the command reports the arguments and four notes (${result.defineNotes.join(' | ')})`);
        const channel = (calls.outputs || []).find(c => c.name === OUTPUT_CHANNEL_NAME);
        assert(OUTPUT_CHANNEL_NAME === 'TC Toolkit Compile' && !!channel && channel.lines.some(l => /PLC: compiler defines -D SIM -D Mode=fast -D Axes$/.test(l)) &&
            channel.lines.some(l => /"2bad" skipped/.test(l)) && channel.lines.some(l => /"Plain:=x" skipped/.test(l)) &&
            channel.lines.some(l => /"Axes := '4'" passed as "Axes" only/.test(l)) &&
            channel.lines.some(l => /per-object compiler defines on POUs\\FB_A\.TcPOU \(PER_OBJECT\) are not passed/.test(l)),
            `DEFINES: the output channel lists the arguments, each skipped entry, the integer-value note and the per-object note (${channel ? channel.lines.join(' | ') : 'no channel'})`);
        const summaryText = (calls.warnings[0] || { m: '' }).m;
        assert(/4 note\(s\) on the project's compiler defines: see the "TC Toolkit Compile" output\./.test(summaryText),
            `DEFINES: the summary points to the output channel (${summaryText})`);

        fs.writeFileSync(plcproj, '<Project><PropertyGroup><CompilerDefines /></PropertyGroup></Project>');
        answers.message.push(undefined);
        result = await run('twincat.compileProject');
        await settle();
        const emptyCall = fake.calls[fake.calls.length - 1];
        assert(result.ok === true && !emptyCall.args.includes('-D') && result.defineArgs.length === 0, 'DEFINES: an empty <CompilerDefines /> passes no -D');
        fs.rmSync(plcproj);
        answers.message.push(undefined);
        result = await run('twincat.compileProject');
        await settle();
        assert(result.ok === true && !fake.calls[fake.calls.length - 1].args.includes('-D') && result.defineNotes.length === 1 &&
            /compiler defines not read/.test(result.defineNotes[0]),
            `DEFINES: a .plcproj that cannot be read passes no -D and says so, without failing the run (${result.defineNotes[0]})`);
        projectList = [project('a', 'PLC', [fbPath, gvlPath])];
    }

    // ── The product name of the compiler stays out of the UI strings ────────────────────────────
    const uiText = JSON.stringify([calls.errors, calls.infos, calls.warnings, calls.progress]);
    assert(!/STruC/i.test(uiText), 'UI: no message names the compiler product');

    fs.rmSync(ROOT, { recursive: true, force: true });
    if (errors > 0) {
        console.error(`\n${errors} compile-command assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll compile-command assertions passed.');
})().catch((err) => { console.error(err); process.exit(1); });
