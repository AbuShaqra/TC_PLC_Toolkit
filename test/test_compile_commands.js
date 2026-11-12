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
 * R13: C++ generation and the g++ build — off by default; the dropdown's checkboxes and changes made
 * elsewhere keep the two switches coupled per scope; a clean check is followed by the compile mode,
 * whose files land in CPP_Files (and only there, never over a file the toolkit did not write); a
 * check with errors generates nothing; g++ runs with the vendored headers and its messages reach the
 * Problems panel on the generated files; a missing g++ is explained with a button to its setting.
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
const calls = { executed: [], errors: [], infos: [], warnings: [], progress: [], status: null, updates: [] };
const handlers = new Map();
const answers = { quickPick: [], message: [] };
const settings = {};
const workspaceSettings = {};
/** Tells every configuration listener that `full` changed. */
const fireConfig = (full) => listeners.config.slice().forEach(fn => fn({ affectsConfiguration: (sec) => full === sec || full.startsWith(sec + '.') }));
const listeners = { config: [], docChange: [] };
const uri = (p) => ({ fsPath: p, scheme: 'file', path: p, query: '', toString: () => 'file://' + p.split(path.sep).join('/') });
class Range { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class Location { constructor(at, range) { this.uri = at; this.range = range; } }
class DiagnosticRelatedInformation { constructor(location, message) { this.location = location; this.message = message; } }
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
    Range, Diagnostic, Location, DiagnosticRelatedInformation,
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
        // `settings` is the user (global) scope; `workspaceSettings` the workspace scope, which wins.
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
let gppFills = 0;
const compile = registerCompileCommands(context, { provider, getProjectMap: projectMap, onSettingsChanged: () => { settingsChanged++; }, spawn: fake.spawn,
    fillGppPath: () => { gppFills++; return Promise.resolve(null); },
    // g++ is looked for only where the test says (the R13 block sets the path setting).
    gppDiscovery: { platform: 'linux', env: { PATH: path.join(ROOT, 'no-gpp-here') }, exists: (p) => fs.existsSync(p) },
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

    // ── Compiler defines: project defines as --pragma-define, per-object ones as --file-define ─────
    {
        const plcproj = path.join(ROOT, 'PLC', 'PLC.plcproj');
        assert(!calls.outputs, 'DEFINES: a project without compiler defines opens no output channel');
        fs.writeFileSync(plcproj, ['<Project>', '  <PropertyGroup>', '    <Name>PLC</Name>',
            "    <CompilerDefines>SIM, Mode := 'fast', Axes := '4', 2bad, Plain:=x</CompilerDefines>",
            '  </PropertyGroup>', '  <ItemGroup>', '    <Compile Include="POUs\\FB_A.TcPOU">',
            "      <CompilerDefines>PER_OBJECT, Lvl := '3'</CompilerDefines>", '    </Compile>',
            '    <Compile Include="POUs\\Missing.TcPOU">', '      <CompilerDefines>GONE</CompilerDefines>', '    </Compile>',
            '  </ItemGroup>', '</Project>'].join(CRLF));
        projectList = [{ ...project('a', 'PLC', [fbPath, gvlPath]), plcprojPath: plcproj }];
        compilerAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [], summary: {} }), code: 0 });
        for (const k of ['errors', 'infos', 'warnings']) calls[k].length = 0;
        answers.message.push(undefined);
        result = await run('twincat.compileProject');
        await settle();
        const call = fake.calls[fake.calls.length - 1];
        const expected = ['--pragma-define', 'SIM', '--pragma-define', 'Mode=fast', '--pragma-define', 'Axes=4',
            '--file-define', '1.st=PER_OBJECT', '--file-define', '1.st=Lvl=3'];
        const afterDialect = call.args.slice(call.args.indexOf('--dialect-file') + 2, call.args.indexOf('--dialect-file') + 2 + expected.length);
        assert(JSON.stringify(afterDialect) === JSON.stringify(expected) && call.args[call.args.indexOf('--dialect-file') + 2 + expected.length] === '1.st',
            `DEFINES: project defines as --pragma-define (case kept, the numeric value exact), FB_A's own as --file-define on its unit 1.st, right after the profile (${afterDialect.join(' ')})`);
        assert(!call.args.includes('-D') && !call.args.some(a => /2bad|Plain|GONE/.test(a)),
            'DEFINES: no -D, and the malformed entries and the define of an object with no unit are not passed');
        assert(result.ok === true && result.defineArgs.join(' ') === expected.join(' ') && result.defineNotes.length === 3,
            `DEFINES: the command reports the arguments and three notes (${result.defineNotes.join(' | ')})`);
        const channel = (calls.outputs || []).find(c => c.name === OUTPUT_CHANNEL_NAME);
        assert(OUTPUT_CHANNEL_NAME === 'TC Toolkit Compile' && !!channel && channel.lines.some(l => l.endsWith(`PLC: compiler defines ${expected.join(' ')}`)) &&
            channel.lines.some(l => /"2bad" skipped/.test(l)) && channel.lines.some(l => /"Plain:=x" skipped/.test(l)) &&
            !channel.lines.some(l => /passed as ".*" only/.test(l)) &&
            channel.lines.some(l => /per-object compiler defines on POUs\\Missing\.TcPOU \(GONE\) were not passed: the check compiles no Structured Text unit/.test(l)),
            `DEFINES: the output channel lists the arguments, each skipped entry and the object with no unit (${channel ? channel.lines.join(' | ') : 'no channel'})`);
        const summaryText = (calls.warnings[0] || { m: '' }).m;
        assert(/3 note\(s\) on the project's compiler defines: see the "TC Toolkit Compile" output\./.test(summaryText),
            `DEFINES: the summary points to the output channel (${summaryText})`);

        fs.writeFileSync(plcproj, '<Project><PropertyGroup><CompilerDefines /></PropertyGroup></Project>');
        answers.message.push(undefined);
        result = await run('twincat.compileProject');
        await settle();
        const emptyCall = fake.calls[fake.calls.length - 1];
        assert(result.ok === true && !emptyCall.args.some(a => /^--(pragma|file)-define$/.test(a)) && result.defineArgs.length === 0, 'DEFINES: an empty <CompilerDefines /> passes no define');

        fs.writeFileSync(plcproj, ['<Project>', '  <PropertyGroup>', '    <CompilerDefines>BASE</CompilerDefines>', '  </PropertyGroup>',
            "  <PropertyGroup Condition=\" '$(Configuration)|$(Platform)' == 'Debug|TwinCAT RT (x64)' \">",
            '    <CompilerDefines>$(CompilerDefines), DBG</CompilerDefines>', '  </PropertyGroup>',
            "  <PropertyGroup Condition=\" '$(Configuration)' == 'Release' \">", '    <CompilerDefines>REL</CompilerDefines>', '  </PropertyGroup>',
            '</Project>'].join(CRLF));
        const outputsBefore = (calls.outputs || []).reduce((n, c) => n + c.lines.length, 0);
        for (const k of ['errors', 'infos', 'warnings']) calls[k].length = 0;
        answers.message.push(undefined);
        result = await run('twincat.compileProject');
        await settle();
        const condCall = fake.calls[fake.calls.length - 1];
        assert(result.ok === true && result.defineArgs.join(' ') === '--pragma-define BASE --pragma-define DBG' && condCall.args.includes('DBG') && !condCall.args.includes('REL') &&
            result.defineNotes.length === 0 && !calls.warnings.some(w => /note\(s\) on the project's compiler defines/.test(w.m)),
            `DEFINES: a Debug-conditioned group is applied, a Release one skipped, and neither gives a note (${result.defineArgs.join(' ')}; ${result.defineNotes.join(' | ')})`);
        const newLines = (calls.outputs || []).flatMap(c => c.lines).slice(outputsBefore);
        assert(!newLines.some(l => /Condition|not used/.test(l)), `DEFINES: the output channel says nothing about the conditions (${newLines.join(' | ')})`);
        fs.rmSync(plcproj);
        answers.message.push(undefined);
        result = await run('twincat.compileProject');
        await settle();
        assert(result.ok === true && !fake.calls[fake.calls.length - 1].args.includes('--pragma-define') && result.defineNotes.length === 1 &&
            /compiler defines not read/.test(result.defineNotes[0]),
            `DEFINES: a .plcproj that cannot be read passes no define and says so, without failing the run (${result.defineNotes[0]})`);
        projectList = [project('a', 'PLC', [fbPath, gvlPath])];
    }

    // ── R13: C++ generation and the optional g++ build ──────────────────────────────────────────
    {
        const gppCollection = collections.find(c => c.name === 'twincat-gpp');
        const cppDir = path.join(ROOT, 'PLC', 'CPP_Files');
        const cppFile = path.join(cppDir, 'PLC.cpp');
        const hppFile = path.join(cppDir, 'PLC.hpp');
        const objFile = path.join(cppDir, 'PLC.o');
        const gppExe = path.join(ROOT, 'bin', 'g++');
        fs.mkdirSync(path.dirname(gppExe), { recursive: true });
        fs.writeFileSync(gppExe, '');
        const cleanCheck = { stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [], summary: {} }), code: 0 };
        let checkAnswer = () => cleanCheck;
        let gppAnswer = () => ({ code: 0 });
        let generationFails = false;
        compilerAnswer = (call) => {
            if (call.command === gppExe) {
                const r = gppAnswer(call);
                if (!r.code) fs.writeFileSync(call.args[call.args.indexOf('-o') + 1], 'object code');
                return r;
            }
            if (call.args.includes('-o')) {
                if (generationFails) return { stderr: "1.st:1:6: error: Undeclared function 'F_SYNLONG'", code: 1 };
                const out = call.args[call.args.indexOf('-o') + 1];
                fs.writeFileSync(path.join(call.options.cwd, out), '#include "PLC.hpp"\n// generated\n');
                fs.writeFileSync(path.join(call.options.cwd, out.replace(/\.cpp$/, '.hpp')), '#pragma once\n');
                return { stdout: 'Compilation successful!\n', code: 0 };
            }
            return checkAnswer(call);
        };
        const reset = () => { for (const k of ['errors', 'infos', 'warnings']) calls[k].length = 0; panelPosts.length = 0; };
        const generationCalls = () => fake.calls.filter(c => c.args.includes('-o') && c.command !== gppExe);
        const gppCalls = () => fake.calls.filter(c => c.command === gppExe);
        const lastNote = () => [...calls.errors, ...calls.warnings, ...calls.infos].map(m => m.m).find(m => /^Compile Project/.test(m)) || '';

        // Off by default: a clean run generates nothing.
        reset();
        answers.message.push(undefined);
        let r13Result = await run('twincat.compileProject');
        await settle();
        assert(r13Result.ok === true && r13Result.cpp === null && generationCalls().length === 0 && !fs.existsSync(cppDir),
            'R13 OFF: with both switches off (the default) nothing is generated and no CPP_Files folder appears');
        assert(JSON.stringify(compile.compileOptions()) === '{"generateCpp":false,"buildWithGpp":false}' && JSON.stringify(provider.compileOptions) === '{"generateCpp":false,"buildWithGpp":false}',
            'R13 OFF: the editors are told both switches are off');

        // The dropdown ticks "Generate C++": the setting is written, every editor and the start page follow.
        const changedBefore = settingsChanged;
        await provider.compileOptionsSource.set('generateCpp', true);
        assert(settings['tcToolkit.compiler.generateCpp'] === true && !('tcToolkit.compiler.buildWithGpp' in settings),
            'R13 BOX: ticking Generate C++ writes tcToolkit.compiler.generateCpp to the user settings, nothing else');
        assert(panelPosts.some(m => m.type === 'compileOptions' && m.options.generateCpp === true && m.options.buildWithGpp === false) && settingsChanged > changedBefore,
            'R13 BOX: open editors get the new checkboxes, and the start page is refreshed');

        reset();
        answers.message.push(undefined);
        r13Result = await run('twincat.compileProject');
        await settle();
        const genCall = generationCalls()[0];
        const checkCall = fake.calls[fake.calls.indexOf(genCall) - 1];
        assert(!!genCall && genCall.args.slice(-2).join(' ') === '-o PLC.cpp' && !genCall.args.includes('--check')
            && JSON.stringify(genCall.args.slice(0, -2).filter(a => a !== '--check' && a !== '--json')) === JSON.stringify(checkCall.args.filter(a => a !== '--check' && a !== '--json')),
        'R13 GEN: after a clean check the compiler runs once more in compile mode, with the same inputs and defines, writing PLC.cpp');
        assert(r13Result.cpp && r13Result.cpp.status === 'done' && r13Result.cpp.written.join('|') === [cppFile, hppFile].join('|')
            && fs.readFileSync(cppFile, 'utf8').startsWith('#include "PLC.hpp"') && fs.existsSync(path.join(cppDir, '.tc-toolkit-generated.json')),
        'R13 GEN: <project dir>/CPP_Files/PLC.cpp and PLC.hpp are written, with the ownership record');
        assert(/C\+\+ written to PLC\/CPP_Files: PLC\.cpp, PLC\.hpp\./.test(lastNote()) && calls.status.text.includes('· C++ written')
            && calls.infos.some(m => m.buttons.includes('Open C++')), `R13 GEN: the notification and status bar say what was written (${lastNote()} / ${calls.status.text})`);
        assert(gppCalls().length === 0 && (r13Result.cpp.gpp === undefined || r13Result.cpp.gpp === null), 'R13 GEN: no g++ while the build is off');

        // A check with errors: nothing is generated; the earlier files stay.
        checkAnswer = () => errorReport(unitLineOf(fs.readFileSync(fbPath, 'utf8'), 'nNope := 5;'));
        const genBefore = generationCalls().length;
        reset();
        answers.message.push(undefined);
        r13Result = await run('twincat.compileProject');
        await settle();
        assert(r13Result.cpp.status === 'skipped' && generationCalls().length === genBefore && fs.existsSync(cppFile)
            && /C\+\+ was not generated: the project has errors\./.test(lastNote()), 'R13 GEN: a check with errors generates nothing and says so; earlier output is left');
        checkAnswer = () => cleanCheck;

        // Only a stripped namespace prefix (user decision 2026-11-12): `SynLib.TON` is the compiler's own TON,
        // the check is clean, the C++ is generated, and the summary names the library whose block it stands in for.
        {
            const plcproj = path.join(ROOT, 'PLC', 'PLC.plcproj');
            const fbBeforeNs = fs.readFileSync(fbPath, 'utf8');
            fs.writeFileSync(plcproj, '<Project><ItemGroup><PlaceholderReference Include="Synthetic Lib"><Namespace>SynLib</Namespace></PlaceholderReference></ItemGroup></Project>');
            fs.writeFileSync(fbPath, fbXml(`tTimer(IN := TRUE, PT := T#1S);`)
                .replace('METHOD Run : BOOL', `METHOD Run : BOOL${CRLF}VAR${CRLF}\ttTimer : SynLib.TON;${CRLF}END_VAR`));
            checkAnswer = () => cleanCheck;
            const genBeforeLib = generationCalls().length;
            reset();
            answers.message.push(undefined);
            r13Result = await run('twincat.compileProject');
            await settle();
            const libLog = (calls.outputs || []).find(c => c.name === OUTPUT_CHANNEL_NAME);
            const entry = r13Result.cpp.libraries[0] || {};
            assert(r13Result.errors === 0 && r13Result.filteredLibraryDiagnostics === 0 && r13Result.cpp.status === 'done'
                && generationCalls().length === genBeforeLib + 1
                && r13Result.cpp.libraries.length === 1 && entry.library === 'Synthetic Lib' && entry.substitutes.join() === 'TON'
                && entry.blocks.length === 0 && entry.undeclared.length === 0
                && /The generated C\+\+ does not cover the library code of Synthetic Lib: the compiler's own implementation of their blocks is used instead\. The library blocks used are listed in the "TC Toolkit Compile" output\./.test(lastNote())
                && !!libLog && libLog.lines.some(l => /PLC: library code the generated C\+\+ does not cover$/.test(l))
                && libLog.lines.some(l => /^ {4}the compiler's own implementation used instead of the library's: TON$/.test(l)),
            `R13 LIB: a project whose only library use is a stripped prefix on a compiler-provided block is generated; the summary and the output channel name the library (${r13Result.cpp.status}; ${lastNote()})`);
            fs.rmSync(plcproj);
            fs.writeFileSync(fbPath, fbBeforeNs);
        }

        // The build turned on elsewhere (workspace settings.json): generation follows IN THAT SCOPE; the g++ path is filled.
        delete settings['tcToolkit.compiler.generateCpp'];
        fireConfig('tcToolkit.compiler.generateCpp');
        calls.updates.length = 0;
        const fillsBefore = gppFills;
        workspaceSettings['tcToolkit.compiler.buildWithGpp'] = true;
        fireConfig('tcToolkit.compiler.buildWithGpp');
        await settle();
        assert(calls.updates.length === 1 && calls.updates[0].key === 'tcToolkit.compiler.generateCpp' && calls.updates[0].value === true && calls.updates[0].target === 2,
            `R13 COUPLE: the build turned on in the workspace turns generation on in the workspace (${JSON.stringify(calls.updates)})`);
        assert(gppFills === fillsBefore + 1, 'R13 COUPLE: turning the build on fills an empty g++ path setting');
        // Generation turned off there: the build follows.
        calls.updates.length = 0;
        workspaceSettings['tcToolkit.compiler.generateCpp'] = false;
        fireConfig('tcToolkit.compiler.generateCpp');
        await settle();
        assert(calls.updates.length === 1 && calls.updates[0].key === 'tcToolkit.compiler.buildWithGpp' && calls.updates[0].value === false && calls.updates[0].target === 2
            && JSON.stringify(compile.compileOptions()) === '{"generateCpp":false,"buildWithGpp":false}',
        `R13 COUPLE: generation turned off in the workspace turns the build off there (${JSON.stringify(calls.updates)})`);
        delete workspaceSettings['tcToolkit.compiler.generateCpp'];
        delete workspaceSettings['tcToolkit.compiler.buildWithGpp'];
        fireConfig('tcToolkit.compiler.buildWithGpp');

        // The dropdown ticks "Build with g++": both settings on; g++ missing → C++ still written, a clear message with the setting.
        await compile.setCompileOption('buildWithGpp', true);
        assert(settings['tcToolkit.compiler.buildWithGpp'] === true && settings['tcToolkit.compiler.generateCpp'] === true,
            'R13 BOX: ticking Build with g++ turns both settings on');
        settings['tcToolkit.compiler.gppPath'] = path.join(ROOT, 'bin', 'missing-g++');
        reset();
        answers.message.push(undefined, undefined);
        r13Result = await run('twincat.compileProject');
        await settle();
        const missing = calls.warnings.find(m => /Not built with g\+\+: the g\+\+ path setting does not work \(.*missing-g\+\+: that file does not exist\)/.test(m.m));
        assert(r13Result.cpp.status === 'done' && r13Result.cpp.gpp.status === 'missing' && gppCalls().length === 0 && fs.existsSync(cppFile)
            && !!missing && missing.buttons.join('|') === 'Open C++|Open Setting' && calls.status.text.includes('g++ not found'),
        `R13 GPP: a missing g++ still writes the C++, and says so with a button to the g++ path setting — not to detection, which never replaces a set value (${missing && missing.buttons.join('|')})`);
        assert([...calls.warnings, ...calls.errors, ...calls.infos].length === 1,
            `R13 GPP: one notification for a missing g++, not two (${[...calls.warnings, ...calls.errors, ...calls.infos].map(m => m.m).join(' || ')})`);
        // Empty setting and nothing detected: detection is offered too.
        delete settings['tcToolkit.compiler.gppPath'];
        reset();
        answers.message.length = 0;
        answers.message.push(undefined);
        r13Result = await run('twincat.compileProject');
        await settle();
        const notFound = calls.warnings.find(m => /Not built with g\+\+: g\+\+ was not found on PATH or in the usual install folders/.test(m.m));
        assert(r13Result.cpp.gpp.status === 'missing' && !!notFound && notFound.buttons.join('|') === 'Open C++|Open Setting|Detect g++' && calls.warnings.length === 1,
            `R13 GPP: an empty setting and no g++ found: one warning, with Open Setting and Detect g++ (${notFound && notFound.buttons.join('|')})`);
        settings['tcToolkit.compiler.gppPath'] = path.join(ROOT, 'bin', 'missing-g++');
        const executedBefore = calls.executed.length;
        answers.message.length = 0;
        answers.message.push('Open Setting');
        await run('twincat.compileProject');
        await settle();
        assert(calls.executed.slice(executedBefore).some(e => e.id === 'twincat.openSettings' && e.args[0] === 'tcToolkit.compiler.gppPath'),
            'R13 GPP: "Open Setting" opens tcToolkit.compiler.gppPath');

        // g++ found (the path setting): its errors go to the Problems panel on the generated .cpp.
        settings['tcToolkit.compiler.gppPath'] = gppExe;
        gppAnswer = () => ({ code: 1, stderr: [
            `In file included from ${cppFile}:1:`,
            `${hppFile}:3:2: warning: odd thing`,
            `${cppFile}: In member function 'void f()':`,
            `${cppFile}:2:5: error: 'class X' has no member named 'Y'`,
            `${hppFile}:1:1: note: declared here`,
            `${path.join(REPO, 'resources', 'compiler', 'include', 'iec_var.hpp')}:40:3: error: deep inside`
        ].join('\n') });
        reset();
        answers.message.push(undefined);
        r13Result = await run('twincat.compileProject');
        await settle();
        const gcall = gppCalls()[gppCalls().length - 1];
        assert(!!gcall && gcall.args.join(' ') === `-std=c++14 -fno-strict-aliasing -Wno-c++17-extensions -fdiagnostics-color=never -fmessage-length=0 -c ${cppFile} -I ${path.join(REPO, 'resources', 'compiler', 'include')} -I ${cppDir} -o ${objFile}`
            && gcall.options.cwd === cppDir, `R13 GPP: g++ -std=c++14 -c PLC.cpp against the vendored runtime headers, -o CPP_Files/PLC.o (${gcall && gcall.args.join(' ')})`);
        const onCpp = gppCollection.map.get(vscodeStub.Uri.file(cppFile).toString()) || [];
        const onHpp = gppCollection.map.get(vscodeStub.Uri.file(hppFile).toString()) || [];
        assert(onCpp.length === 2 && onHpp.length === 1 && onCpp.every(d => d.source === 'TC Toolkit g++'), `R13 GPP: two problems on the .cpp, one on the .hpp, source "TC Toolkit g++" (${onCpp.length}/${onHpp.length})`);
        const memberErr = onCpp.find(d => /no member named/.test(d.message));
        assert(!!memberErr && memberErr.range.start.line === 1 && memberErr.range.start.character === 4 && memberErr.severity === 0
            && memberErr.relatedInformation && memberErr.relatedInformation[0].message === 'declared here', 'R13 GPP: an error at its line and column, with its note as related information');
        const deep = onCpp.find(d => /deep inside/.test(d.message));
        assert(!!deep && deep.range.start.line === 0 && /\(in iec_var\.hpp:40\)$/.test(deep.message), 'R13 GPP: an error in a runtime header goes on the .cpp\'s first line and names the header');
        assert(onHpp[0].severity === 1 && r13Result.cpp.gpp.errors === 2 && r13Result.cpp.gpp.warnings === 1 && calls.errors.some(m => /g\+\+: 2 errors, 1 warning\./.test(m.m))
            && calls.status.text.endsWith('· g++ $(error) 2') && !fs.existsSync(objFile), `R13 GPP: the summary, the status bar and no object file after a failed build (${calls.status.text})`);
        const gppLog = (calls.outputs || []).find(c => c.name === OUTPUT_CHANNEL_NAME);
        assert(!!gppLog && gppLog.lines.some(l => /deep inside/.test(l)), "R13 GPP: g++'s output goes to the output channel");

        // A clean build: the object file is written and recorded; the g++ problems are gone.
        gppAnswer = () => ({ code: 0 });
        reset();
        answers.message.push(undefined);
        r13Result = await run('twincat.compileProject');
        await settle();
        const rec = JSON.parse(fs.readFileSync(path.join(cppDir, '.tc-toolkit-generated.json'), 'utf8'));
        assert(r13Result.cpp.gpp.status === 'done' && r13Result.cpp.gpp.exitCode === 0 && fs.existsSync(objFile) && !!rec.files['PLC.o'] && gppCollection.map.size === 0
            && /g\+\+ compiled it without errors\./.test(lastNote()) && calls.status.text.endsWith('· g++ $(check)'),
        'R13 GPP: a clean build writes PLC.o (recorded as the toolkit\'s), clears the g++ problems and says so');
        assert(!/library code/.test(lastNote()) && !fs.readFileSync(cppFile, 'utf8').startsWith('// TC Toolkit'),
            'R13 LIB: a project that uses no library symbol gets no library note and no header comment');

        // A project that calls library blocks: the compile mode gets the check's library declarations,
        // the C++ is written with the uncovered blocks named on top, g++ runs, the summary names the library.
        {
            const plcproj = path.join(ROOT, 'PLC', 'PLC.plcproj');
            const dump = path.join(ROOT, 'PLC', 'library-signatures.xml');
            const fbBefore = fs.readFileSync(fbPath, 'utf8');
            fs.writeFileSync(plcproj, '<Project><ItemGroup><PlaceholderReference Include="Synthetic Lib"><DefaultResolution>Synthetic Lib, * (Synthetic Co)</DefaultResolution><Namespace>SynLib</Namespace></PlaceholderReference></ItemGroup></Project>');
            fs.writeFileSync(dump, ['<?xml version="1.0"?>', '<LibrarySignatures><Library><LibraryName>Synthetic Lib</LibraryName><Version>1.0.0.0</Version><TypeSignatures>',
                '<TypeSignature type="Function"><Name>F_SynCalc</Name><Inputs><Input><Name>nIn</Name><DataType>INT</DataType></Input></Inputs><Outputs><Output><Name>F_SynCalc</Name><DataType>INT</DataType></Output></Outputs></TypeSignature>',
                '<TypeSignature type="Function"><Name>F_SynLong</Name><Inputs><Input><Name>tSpan</Name><DataType>LTIME</DataType></Input></Inputs><Outputs><Output><Name>F_SynLong</Name><DataType>BOOL</DataType></Output></Outputs></TypeSignature>',
                '<TypeSignature type="FunctionBlock"><Name>FB_SynThing</Name><Inputs><Input><Name>bGo</Name><DataType>BOOL</DataType></Input></Inputs><Outputs><Output><Name>bDone</Name><DataType>BOOL</DataType></Output></Outputs></TypeSignature>',
                '</TypeSignatures></Library></LibrarySignatures>'].join('\n'));
            fs.writeFileSync(fbPath, fbXml(`fbThing(bGo := TRUE);${CRLF}n := F_SynCalc(nIn := n);${CRLF}tTimer(IN := fbThing.bDone, PT := T#1S);`)
                .replace('METHOD Run : BOOL', `METHOD Run : BOOL${CRLF}VAR${CRLF}\tfbThing : FB_SynThing;${CRLF}\ttTimer : SynLib.TON;${CRLF}END_VAR`));
            const genBeforeDecl = generationCalls().length;
            const gppBeforeDecl = gppCalls().length;
            reset();
            answers.message.push(undefined);
            r13Result = await run('twincat.compileProject');
            await settle();
            const declGen = generationCalls()[generationCalls().length - 1];
            const declCheck = fake.calls[fake.calls.indexOf(declGen) - 1];
            const libFiles = declCheck.args.filter(a => /^lib-\d+\.st$/.test(a));
            const genUnits = seenUnits[fake.calls.slice(0, fake.calls.indexOf(declGen)).filter(c => c.args[0] !== '--version').length] || {};
            assert(generationCalls().length === genBeforeDecl + 1 && libFiles.length === 2
                && JSON.stringify(declGen.args.slice(0, -2)) === JSON.stringify(declCheck.args.filter(a => a !== '--check' && a !== '--json'))
                && Object.values(genUnits).some(t => /^FUNCTION_BLOCK FB_SynThing/m.test(t)) && Object.values(genUnits).some(t => /^FUNCTION F_SynCalc : INT/m.test(t)),
            `R13 LIB: the compile mode gets the same library declarations as the check (${libFiles.join(', ')})`);
            const cppText = fs.readFileSync(cppFile, 'utf8');
            const lib = (r13Result.cpp.libraries || [])[0] || {};
            assert(r13Result.cpp.status === 'done' && lib.library === 'Synthetic Lib' && lib.blocks.join() === 'F_SynCalc,FB_SynThing' && lib.substitutes.join() === 'TON'
                && cppText.startsWith('// TC Toolkit: this C++ does not contain the code of the library blocks below.')
                && cppText.includes('//   Synthetic Lib: F_SynCalc, FB_SynThing\n') && cppText.includes("//   Synthetic Lib (the compiler's own implementation is used): TON\n")
                && cppText.endsWith('#include "PLC.hpp"\n// generated\n') && fs.readFileSync(hppFile, 'utf8').startsWith('// TC Toolkit: this C++'),
            `R13 LIB: the .cpp and .hpp name the library blocks with empty bodies at the top (${JSON.stringify(lib)})`);
            const { readManifest, ownership } = require('../src/cppGenerate');
            const record = readManifest(cppDir);
            assert(record.ok && ownership(cppDir, record.manifest, 'PLC.cpp') === 'owned' && ownership(cppDir, record.manifest, 'PLC.hpp') === 'owned',
                'R13 LIB: the files with the header are recorded as the toolkit\'s own (the hash covers the header)');
            const declLog = (calls.outputs || []).find(c => c.name === OUTPUT_CHANNEL_NAME);
            assert(gppCalls().length === gppBeforeDecl + 1 && r13Result.cpp.gpp.status === 'done' && r13Result.cpp.gpp.exitCode === 0
                && /The generated C\+\+ and the g\+\+ check do not cover the library code of Synthetic Lib: their code is not available, so their function blocks and functions are declarations with empty bodies there\./.test(lastNote())
                && calls.warnings.some(m => /^Compile Project/.test(m.m))
                && !!declLog && declLog.lines.some(l => /PLC: library code the generated C\+\+ and the g\+\+ check do not cover$/.test(l))
                && declLog.lines.some(l => l === '  Synthetic Lib:')
                && declLog.lines.some(l => /^ {4}declarations with empty bodies .*: F_SynCalc, FB_SynThing$/.test(l))
                && declLog.lines.some(l => /^ {4}the compiler's own implementation .*: TON$/.test(l)),
            `R13 LIB: g++ still runs; the summary (a warning) says the C++ and the g++ check do not cover the library, the output channel lists the blocks (${lastNote()})`);

            // A library symbol with no usable declaration (an LTIME parameter): the compile mode cannot compile it.
            fs.writeFileSync(fbPath, fbXml('n := 0;').replace('METHOD Run : BOOL', `METHOD Run : BOOL${CRLF}VAR${CRLF}\tb : BOOL;${CRLF}END_VAR`).replace('n := 0;', 'b := F_SynLong(tSpan := LTIME#1S);'));
            checkAnswer = () => ({ stdout: JSON.stringify({ dialect: 'twincat3', files: [], summary: {}, diagnostics: [
                { file: '1.st', line: 1, column: 1, severity: 'error', message: "Undeclared function 'F_SYNLONG'" }] }), code: 1 });
            generationFails = true;
            const gppBeforeMissing = gppCalls().length;
            const cppKept = fs.readFileSync(cppFile, 'utf8');
            const logBefore = ((calls.outputs || []).find(c => c.name === OUTPUT_CHANNEL_NAME) || { lines: [] }).lines.length;
            reset();
            answers.message.push(undefined);
            r13Result = await run('twincat.compileProject');
            await settle();
            const missLog = { lines: ((calls.outputs || []).find(c => c.name === OUTPUT_CHANNEL_NAME) || { lines: [] }).lines.slice(logBefore) };
            assert(r13Result.errors === 0 && r13Result.cpp.status === 'failed' && gppCalls().length === gppBeforeMissing && fs.readFileSync(cppFile, 'utf8') === cppKept
                && r13Result.cpp.libraries[0].undeclared.join() === 'F_SynLong'
                && calls.errors.some(m => /C\+\+ could not be generated: there is no declaration the compiler can use for the library symbol F_SynLong \(Synthetic Lib\)/.test(m.m)),
            `R13 LIB: a library symbol with no usable declaration: no C++, no g++, and the summary names the symbol and its library (${lastNote()})`);
            assert(!!missLog && !missLog.lines.some(l => /does not cover|do not cover|declarations with empty bodies/.test(l))
                && missLog.lines.some(l => /PLC: C\+\+ could not be generated: no declaration the compiler can use for these library symbols$/.test(l))
                && missLog.lines.some(l => l === '  Synthetic Lib: F_SynLong'),
            `R13 LIB: with no C++ generated, the output channel lists only the symbols that stopped it, under a heading that says so (${missLog ? missLog.lines.slice(-4).join(' | ') : 'no channel'})`);
            generationFails = false;
            checkAnswer = () => cleanCheck;
            fs.writeFileSync(fbPath, fbBefore);
            fs.rmSync(plcproj);
            fs.rmSync(dump);
        }

        // A file the toolkit did not write is never overwritten, and g++ is then not run.
        fs.writeFileSync(hppFile, '// my own header');
        const gppBefore = gppCalls().length;
        reset();
        answers.message.push(undefined);
        r13Result = await run('twincat.compileProject');
        await settle();
        assert(fs.readFileSync(hppFile, 'utf8') === '// my own header' && r13Result.cpp.refused.length === 1 && r13Result.cpp.refused[0].reason === 'changed'
            && gppCalls().length === gppBefore && r13Result.cpp.gpp.status === 'skipped' && /Left alone in PLC\/CPP_Files .*PLC\.hpp/.test(lastNote()),
        `R13 OWN: an edited generated file is left alone and reported, and g++ is not run on a half-written pair (${lastNote()})`);
        fs.rmSync(cppDir, { recursive: true, force: true });

        // Switches off again (the dropdown): nothing more is written.
        await compile.setCompileOption('generateCpp', false);
        assert(settings['tcToolkit.compiler.generateCpp'] === false && settings['tcToolkit.compiler.buildWithGpp'] === false,
            'R13 BOX: unticking Generate C++ turns the build off too');
        reset();
        answers.message.push(undefined);
        r13Result = await run('twincat.compileProject');
        await settle();
        assert(r13Result.cpp === null && !fs.existsSync(cppDir), 'R13 OFF: switched off, nothing is generated');
        const uiR13 = JSON.stringify([calls.errors, calls.infos, calls.warnings]);
        assert(!/STruC/i.test(uiR13), 'R13 UI: no message names the compiler product');
        delete settings['tcToolkit.compiler.gppPath'];
        compilerAnswer = () => cleanCheck;
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
