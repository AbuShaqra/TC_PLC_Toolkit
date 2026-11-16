/**
 * @file test_start_commands.js
 * @description The VS Code half of R2 — src/commands/startCommands.js and src/startPage.js — driven
 * under a stubbed `vscode` module: Create New Project with and without prompts (files written, recents
 * and last location recorded, refusal reported inline for the start page and as a notification from
 * the palette, the chosen open mode honoured), opening a recent solution that is gone, Generate ST's
 * project pick, and the start page's message handling (singleton panel, state — including the
 * recent-list length, the XAE Shell paths and the g++ path from the settings — the command allow-list, help links,
 * the filtered Settings view, a settings change refreshing an open page, and whether the compiler file
 * is there for the Compile project tile).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const REPO = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_start_commands_'));

// ── A recording `vscode` stub ───────────────────────────────────────────────────────────────────
const calls = { executed: [], errors: [], infos: [], warnings: [], external: [], panels: [], workspaceAdds: [] };
const handlers = new Map();
/** Answers queued for the next prompts, consumed in order. */
const answers = { quickPick: [], inputBox: [], openDialog: [] };
/** Settings the stubbed `workspace.getConfiguration` answers from; absent = the caller's fallback. */
const settings = {};
const configListeners = [];
/** Fires a configuration change for the given section. */
const changeConfig = (section) => configListeners.forEach(fn => fn({ affectsConfiguration: (s) => section === s || section.startsWith(s + '.') }));
const uri = (p) => ({ fsPath: p, toString: () => 'file://' + p, scheme: 'file' });
const vscodeStub = {
    Uri: {
        file: uri,
        parse: (s) => ({ toString: () => s, fsPath: s }),
        joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts))
    },
    ViewColumn: { Active: -1 },
    env: { openExternal: async (u) => { calls.external.push(u.toString()); return true; } },
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: (section) => ({
            get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, `${section}.${key}`) ? settings[`${section}.${key}`] : fallback)
        }),
        onDidChangeConfiguration: (fn) => { configListeners.push(fn); return { dispose() {} }; },
        updateWorkspaceFolders: (start, del, ...folders) => { calls.workspaceAdds.push(...folders.map(f => f.uri.fsPath)); return true; }
    },
    window: {
        createTreeView: (id) => ({ id, dispose() {} }),
        registerWebviewPanelSerializer: () => ({ dispose() {} }),
        showQuickPick: async (items) => {
            const want = answers.quickPick.shift();
            const list = await items;
            return want === undefined ? undefined : list.find(i => i.id === want || i.label === want);
        },
        showInputBox: async (opts) => {
            const v = answers.inputBox.shift();
            if (v !== undefined && opts.validateInput) calls.lastValidation = opts.validateInput(v);
            return v;
        },
        showOpenDialog: async () => { const v = answers.openDialog.shift(); return v ? [uri(v)] : undefined; },
        showErrorMessage: async (m) => { calls.errors.push(m); },
        showInformationMessage: async (m) => { calls.infos.push(m); },
        showWarningMessage: async (m) => { calls.warnings.push(m); return answers.warning; },
        createWebviewPanel: (viewType, title) => {
            const listeners = [];
            const panel = {
                viewType, title, visible: true, revealed: 0, posted: [],
                webview: {
                    html: '', options: {}, cspSource: 'vscode-webview://test',
                    asWebviewUri: (u) => ({ toString: () => 'vscode-webview://test' + u.fsPath }),
                    postMessage: (m) => { panel.posted.push(m); return Promise.resolve(true); },
                    onDidReceiveMessage: (fn) => { listeners.push(fn); return { dispose() {} }; }
                },
                send: (m) => Promise.all(listeners.map(fn => fn(m))),
                reveal: () => { panel.revealed++; },
                onDidChangeViewState: () => ({ dispose() {} }),
                onDidDispose: (fn) => { panel.dispose = fn; return { dispose() {} }; }
            };
            calls.panels.push(panel);
            return panel;
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
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.apply(this, arguments);
};

const { registerStartCommands, LINKS } = require('../src/commands/startCommands');

const state = new Map();
const context = {
    subscriptions: [],
    extensionPath: REPO,
    extensionUri: uri(REPO),
    extension: { id: 'a-abushaqra.twincat-plc-toolkit' },
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: (k, v) => { state.set(k, v); return Promise.resolve(); } }
};
let projects = [];
const generated = [];
const provider = { listProjects: () => projects, generateAllStFiles: async (keys) => { generated.push(keys); } };
/** What the stubbed Compile Project answers to "is the compiler file there?" (the bundled one: yes). */
let compilerAvailable = true;
/** The Compile dropdown's switches as the stubbed Compile Project has them, and what the page wrote. */
let compileOpts = { generateCpp: false, buildWithGpp: false };
const optionWrites = [];
/** The machine the start page checks and detects g++ on: one g++ on a fake PATH (R13). */
// POSIX literals: the faked machine is linux and never touches the disk, on any host.
const GPP_DIR = '/opt/gcc/bin';
const GPP_EXE = path.posix.join(GPP_DIR, 'g++');
let gppMachine = { platform: 'linux', env: { PATH: GPP_DIR }, exists: (p) => p === GPP_EXE, isDir: (p) => p === GPP_DIR };
const { startPage } = registerStartCommands(context, {
    provider,
    getProjectMap: () => ({ projects: new Map() }),
    getSolutionMap: () => ({ solutions: [] }),
    isCompilerAvailable: () => compilerAvailable,
    compileOptions: () => compileOpts,
    gppMachine: () => gppMachine,
    setCompileOption: async (key, value) => {
        optionWrites.push([key, value]);
        compileOpts = key === 'buildWithGpp' ? { generateCpp: compileOpts.generateCpp || value, buildWithGpp: value } : { generateCpp: value, buildWithGpp: value && compileOpts.buildWithGpp };
        return true;
    }
});
const run = (id, ...args) => vscodeStub.commands.executeCommand(id, ...args);
const executedIds = () => calls.executed.map(c => c.id);
const recents = () => (state.get('twincat.recentSolutions') || []).map(e => e.slnPath);

(async () => {
    for (const id of ['twincat.openStartPage', 'twincat.createProject', 'twincat.openProject', 'twincat.generateSt',
        'twincat.openSettings', 'twincat.openGettingStarted', 'twincat.openRoadmap', 'twincat.openReleaseNotes', 'twincat.reportIssue']) {
        assert(handlers.has(id), `${id} is registered`);
    }

    // ── Create from the start page (all answers given, no prompts) ──────────────────────────────
    const loc = path.join(ROOT, 'projects');
    fs.mkdirSync(loc);
    let r = await run('twincat.createProject', { version: '3.1.4026', name: 'Cell_1', location: loc, open: 'none', fromStartPage: true });
    const sln = path.join(loc, 'Cell_1', 'Cell_1.sln');
    assert(r && r.ok && r.slnPath === sln && fs.existsSync(sln), 'create with every answer given writes the solution');
    assert(recents()[0] === sln, 'the new solution heads the recent list');
    assert(state.get('twincat.lastProjectLocation') === loc, 'the location is remembered for next time');
    assert(calls.infos.some(m => m.includes(sln)), 'with open "none" the user is told where it went');

    r = await run('twincat.createProject', { version: '3.1.4026', name: 'Cell_1', location: loc, open: 'none', fromStartPage: true });
    assert(r && !r.ok && /already contains a TwinCAT solution/.test(r.error), `a second create into the same folder is refused (${r && r.error})`);
    assert(calls.errors.length === 0, 'a start-page refusal is reported inline, not as a notification');
    r = await run('twincat.createProject', { version: '3.1.4026', name: 'Cell_1', location: loc, open: 'none' });
    assert(r && !r.ok && calls.errors.length === 1, 'from the palette the refusal is a notification');
    r = await run('twincat.createProject', { version: '9.9', name: 'X', location: loc, fromStartPage: true });
    assert(r && !r.ok && /Unknown TwinCAT version/.test(r.error), 'an unknown version is refused');
    r = await run('twincat.createProject', { version: '3.1.4024', name: 'bad name', location: loc, fromStartPage: true });
    assert(r && !r.ok && /letters, digits and underscores/.test(r.error), 'an invalid name is refused');

    // ── Create from the palette: three prompts, then the open choice ────────────────────────────
    answers.quickPick.push('3.1.4024', 'new');
    answers.inputBox.push('Cell_2');
    answers.openDialog.push(loc);
    calls.executed.length = 0;
    r = await run('twincat.createProject');
    assert(r && r.ok && fs.existsSync(path.join(loc, 'Cell_2', 'Cell_2', 'Cell_2.tspproj')), 'the prompted create writes a 3.1.4024 (.tspproj) solution');
    const openCall = calls.executed.find(c => c.id === 'vscode.openFolder');
    assert(!!openCall && openCall.args[0].fsPath === path.join(loc, 'Cell_2') && openCall.args[1] === true, '"Open in a New Window" opens the solution folder in a new window');
    assert(calls.lastValidation === null, 'the name prompt validates with the shared rules');
    answers.quickPick.push(undefined);
    r = await run('twincat.createProject');
    assert(r && !r.ok && !r.error, 'cancelling the version prompt creates nothing and reports nothing');

    r = await run('twincat.createProject', { version: '3.1.4026', name: 'Cell_3', location: loc, open: 'add', fromStartPage: true });
    assert(r && r.ok && calls.workspaceAdds.includes(path.join(loc, 'Cell_3')), '"Add to Workspace" adds the solution folder');

    // ── Open a recent solution that has been deleted ────────────────────────────────────────────
    const gone = path.join(ROOT, 'Gone', 'Gone.sln');
    state.set('twincat.recentSolutions', [{ slnPath: gone, name: 'Gone', at: 1 }, ...state.get('twincat.recentSolutions')]);
    await run('twincat.openProject', { slnPath: gone });
    assert(!recents().includes(gone) && calls.warnings.some(m => m.includes(gone)), 'opening a deleted recent solution removes it and says so');
    calls.executed.length = 0;
    await run('twincat.openProject', { slnPath: sln, open: 'here' });
    const here = calls.executed.find(c => c.id === 'vscode.openFolder');
    assert(!!here && here.args[0].fsPath === path.join(loc, 'Cell_1') && here.args[1] === false, 'opening a recent solution opens its folder in this window');
    assert(recents()[0] === sln, 'and moves it to the top of the list');

    // ── Generate ST ─────────────────────────────────────────────────────────────────────────────
    projects = [];
    await run('twincat.generateSt');
    assert(generated.length === 1 && generated[0] === undefined, 'with one project Generate ST exports everything without asking');
    projects = [{ key: 'a', label: 'A_PLC' }, { key: 'b', label: 'B_PLC' }];
    const realPick = vscodeStub.window.showQuickPick;
    vscodeStub.window.showQuickPick = async (items, opts) => { calls.lastPickMany = opts.canPickMany; return items.filter(i => i.key === 'b'); };
    await run('twincat.generateSt');
    vscodeStub.window.showQuickPick = realPick;
    assert(calls.lastPickMany === true && JSON.stringify(generated[1]) === JSON.stringify(['b']), 'with several projects the user picks which to export');

    // ── Links and settings ──────────────────────────────────────────────────────────────────────
    await run('twincat.openRoadmap');
    await run('twincat.openReleaseNotes');
    await run('twincat.reportIssue');
    assert(JSON.stringify(calls.external) === JSON.stringify([LINKS.roadmap, LINKS.releaseNotes, LINKS.reportIssue]), 'help links open externally');
    calls.executed.length = 0;
    await run('twincat.openSettings');
    assert(calls.executed.some(c => c.id === 'workbench.action.openSettings' && c.args[0] === '@ext:a-abushaqra.twincat-plc-toolkit'), 'Settings opens the extension’s settings');
    calls.executed.length = 0;
    await run('twincat.openSettings', 'tcToolkit.xaeShell');
    await run('twincat.openSettings', '@ext:someone.else');
    await run('twincat.openSettings', { not: 'a string' });
    assert(JSON.stringify(calls.executed.filter(c => c.id === 'workbench.action.openSettings').map(c => c.args[0]))
        === JSON.stringify(['tcToolkit.xaeShell', '@ext:a-abushaqra.twincat-plc-toolkit', '@ext:a-abushaqra.twincat-plc-toolkit']),
        'Open Settings takes a twincat.* section as its query and ignores anything else');

    // ── The start page ──────────────────────────────────────────────────────────────────────────
    await run('twincat.openStartPage');
    await run('twincat.openStartPage');
    assert(calls.panels.length === 1 && calls.panels[0].revealed === 1, 'the start page is a singleton (second open reveals it)');
    const panel = calls.panels[0];
    assert(/Create new project/.test(panel.webview.html) && /nonce-/.test(panel.webview.html), 'the panel shows the start page');
    await panel.send({ type: 'ready' });
    const st = panel.posted.find(m => m.type === 'state');
    assert(!!st && st.location === loc && st.recents[0].slnPath === sln && st.hasProject === false && st.sep === path.sep,
        'ready → state: last location, recent solutions, no project open');
    assert(st.recentsShown === 2, 'state carries the recent-list length, 2 by default');
    assert(Array.isArray(st.xaeShells) && st.xaeShells.length === 2 && st.xaeShells[0].version === '3.1.4024' && st.xaeShells[1].version === '3.1.4026'
        && st.xaeShells.every(x => x.path === '' && x.exists === false), 'state carries the two XAE Shell paths (unset: not found)');
    assert(st.compilerReady === true, 'state says the compiler is ready by default (it ships with the extension)');
    compilerAvailable = false;
    startPage.postState();
    assert(panel.posted.filter(m => m.type === 'state').pop().compilerReady === false, 'state says the compiler is not ready when its file is missing');
    compilerAvailable = true;
    startPage.postState();

    // R13: the Compile dropdown. The state carries the two switches; a checkbox writes through Compile Project.
    assert(JSON.stringify(st.compileOptions) === '{"generateCpp":false,"buildWithGpp":false}', 'R13: state carries the Compile dropdown\'s two switches (off by default)');
    await panel.send({ type: 'setCompileOption', key: 'buildWithGpp', value: true });
    let lastState = panel.posted.filter(m => m.type === 'state').pop();
    assert(JSON.stringify(optionWrites) === '[["buildWithGpp",true]]' && lastState.compileOptions.generateCpp === true && lastState.compileOptions.buildWithGpp === true,
        'R13: a checkbox is written through Build Project, and the page gets the result (the build turned generation on)');
    await panel.send({ type: 'setCompileOption', key: 'tcToolkit.compiler.path', value: true });
    await panel.send({ type: 'setCompileOption', key: 'generateCpp', value: 'yes' });
    assert(optionWrites.length === 1, 'R13: anything but the two switches with a boolean is ignored');
    await panel.send({ type: 'setCompileOption', key: 'generateCpp', value: false });
    lastState = panel.posted.filter(m => m.type === 'state').pop();
    assert(lastState.compileOptions.generateCpp === false && lastState.compileOptions.buildWithGpp === false, 'R13: unticking Generate C++ is shown with the build off too');
    assert(/id="compile-options-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="compile-options"/.test(panel.webview.html)
        && /id="opt-generate-cpp"/.test(panel.webview.html) && /id="opt-build-gpp"/.test(panel.webview.html) && />Generate C\+\+</.test(panel.webview.html)
        && />Build with g\+\+</.test(panel.webview.html), 'R13: the page has the dropdown toggle and its two labelled checkboxes');

    // A settings change reaches the open page; unrelated settings do not.
    const statesBefore = panel.posted.filter(m => m.type === 'state').length;
    changeConfig('tcToolkit.diagnostics.memberAccess');
    assert(panel.posted.filter(m => m.type === 'state').length === statesBefore, 'an unrelated setting does not refresh the page');
    settings['tcToolkit.startPage.recentProjectsShown'] = 3;
    changeConfig('tcToolkit.startPage.recentProjectsShown');
    assert(panel.posted.filter(m => m.type === 'state').pop().recentsShown === 3 && panel.posted.filter(m => m.type === 'state').length === statesBefore + 1,
        'changing tcToolkit.startPage.recentProjectsShown updates the open page');
    for (const [raw, want] of [[0, 1], [99, 10], [3.9, 3], ['7', 2], [null, 2]]) {
        settings['tcToolkit.startPage.recentProjectsShown'] = raw;
        changeConfig('tcToolkit.startPage');
        const got = panel.posted.filter(m => m.type === 'state').pop().recentsShown;
        assert(got === want, `a hand-edited value ${JSON.stringify(raw)} is shown as ${want} (${got})`);
    }
    delete settings['tcToolkit.startPage.recentProjectsShown'];
    settings['tcToolkit.xaeShell.path4024'] = sln; // any file that exists
    settings['tcToolkit.xaeShell.path4026'] = path.join(ROOT, 'nowhere', 'TcXaeShell.exe');
    changeConfig('tcToolkit.xaeShell.path4026');
    const shells = panel.posted.filter(m => m.type === 'state').pop().xaeShells;
    assert(shells[0].path === sln && shells[0].exists === true && shells[1].path.endsWith('TcXaeShell.exe') && shells[1].exists === false,
        'changing tcToolkit.xaeShell.* updates the open page: an existing path, and one that is not on disk');

    // R13: the g++ path, shown like the XAE Shell paths. Detection is only read: nothing is written.
    const gppNow = () => panel.posted.filter(m => m.type === 'state').pop().gpp;
    assert(JSON.stringify(st.gpp) === JSON.stringify({ state: 'detected', configured: '', path: GPP_EXE, source: 'path' }),
        `state carries the g++ path: empty setting → the g++ detection would use (${JSON.stringify(st.gpp)})`);
    const before = panel.posted.filter(m => m.type === 'state').length;
    settings['tcToolkit.compiler.gppPath'] = path.join(ROOT, 'nowhere', 'g++');
    changeConfig('tcToolkit.compiler.gppPath');
    assert(panel.posted.filter(m => m.type === 'state').length === before + 1 && gppNow().state === 'invalid' && gppNow().problem === 'missing'
        && gppNow().configured === path.join(ROOT, 'nowhere', 'g++'), 'changing tcToolkit.compiler.gppPath updates the open page: a set path that is not there is invalid');
    settings['tcToolkit.compiler.gppPath'] = GPP_DIR;
    changeConfig('tcToolkit.compiler.gppPath');
    assert(gppNow().state === 'set' && gppNow().configured === GPP_DIR && gppNow().path === GPP_EXE, 'a folder holding g++ is shown as set, with the g++ it runs');
    settings['tcToolkit.compiler.gppPath'] = '';
    gppMachine = { platform: 'linux', env: { PATH: '' }, exists: () => false, isDir: () => false };
    changeConfig('tcToolkit.compiler.gppPath');
    assert(gppNow().state === 'notFound', 'empty, and no g++ anywhere: not found');
    gppMachine = { platform: 'linux', env: {}, exists: () => { throw new Error('EACCES'); }, isDir: () => false };
    startPage.postState();
    assert(gppNow().state === 'notFound', 'a failing file check reads as not found and breaks nothing');
    delete settings['tcToolkit.compiler.gppPath'];
    assert(!calls.executed.some(c => c.id === 'twincat.detectGpp'), 'showing the g++ path runs no detection command (nothing is written)');
    calls.executed.length = 0;
    await panel.send({ type: 'openSettings', section: 'gpp' });
    assert(calls.executed.some(c => c.id === 'workbench.action.openGlobalSettings' && JSON.stringify(c.args) === '[{"query":"tcToolkit.compiler.gppPath"}]')
        && !calls.executed.some(c => c.id === 'workbench.action.openSettings'), 'g++ Change… opens the User settings (machine scope) filtered to tcToolkit.compiler.gppPath');
    calls.executed.length = 0;
    handlers.set('twincat.detectGpp', async () => { calls.gppDetected = (calls.gppDetected || 0) + 1; });
    await panel.send({ type: 'command', command: 'twincat.detectGpp' });
    assert(calls.gppDetected === 1, 'g++ Detect again runs twincat.detectGpp (allow-listed)');
    await run('twincat.openSettings', '@ext:someone.else', { target: 'user' });
    assert(calls.executed.some(c => c.id === 'workbench.action.openGlobalSettings' && c.args[0].query === '@ext:a-abushaqra.twincat-plc-toolkit'),
        'openSettings with {target: user} still accepts only the extension\'s own sections');

    calls.executed.length = 0;
    await panel.send({ type: 'openSettings', section: 'xaeShell' });
    await panel.send({ type: 'openSettings', section: 'constructor' });
    await panel.send({ type: 'openSettings', section: '@ext:someone.else' });
    const settingsOpens = calls.executed.filter(c => c.id === 'workbench.action.openSettings');
    assert(settingsOpens.length === 1 && settingsOpens[0].args[0] === 'tcToolkit.xaeShell', 'Change… opens the Settings UI filtered to tcToolkit.xaeShell; unknown sections do nothing');
    calls.executed.length = 0;
    handlers.set('twincat.detectXaeShell', async () => { calls.detected = (calls.detected || 0) + 1; });
    await panel.send({ type: 'command', command: 'twincat.detectXaeShell' });
    assert(calls.detected === 1, 'Detect again runs twincat.detectXaeShell (allow-listed)');

    calls.executed.length = 0;
    await panel.send({ type: 'command', command: 'workbench.action.terminal.new' });
    await panel.send({ type: 'command', command: 'twincat.generateSt' });
    await panel.send({ type: 'command', command: 'twincat.compileProject' });
    await panel.send({ type: 'link', id: 'constructor' });
    await panel.send({ type: 'link', id: 'reportIssue' });
    assert(!executedIds().includes('workbench.action.terminal.new'), 'a command outside the allow-list is ignored');
    assert(executedIds().includes('twincat.compileProject'), 'the Build project tile’s command is allow-listed');
    assert(executedIds().includes('twincat.generateSt') && executedIds().includes('twincat.reportIssue') && executedIds().length === 3,
        'allowed actions and known links run their command; unknown ids do nothing');
    await panel.send({ type: 'create', version: '3.1.4026', name: 'Cell_1', location: loc });
    const res = panel.posted.filter(m => m.type === 'createResult').pop();
    assert(!!res && res.ok === false && /already contains/.test(res.error), 'a refused create comes back to the page as createResult');
    answers.quickPick.push(undefined); // the open choice: dismissed
    await panel.send({ type: 'create', version: '3.1.4024', name: 'Cell_4', location: loc });
    const res2 = panel.posted.filter(m => m.type === 'createResult').pop();
    assert(!!res2 && res2.ok === true && fs.existsSync(path.join(loc, 'Cell_4', 'Cell_4.sln')), 'a create from the page writes the project and reports ok');
    await panel.send({ type: 'removeRecent', slnPath: path.join(loc, 'Cell_4', 'Cell_4.sln') });
    const st2 = panel.posted.filter(m => m.type === 'state').pop();
    assert(!st2.recents.some(e => e.slnPath.endsWith('Cell_4.sln')), 'removeRecent drops the entry and refreshes the page');
    answers.openDialog.push('/picked/folder');
    await panel.send({ type: 'browseLocation' });
    assert(panel.posted.some(m => m.type === 'location' && m.location === '/picked/folder'), 'Browse… returns the picked folder to the page');
    panel.dispose();
    assert(startPage.panel === null, 'closing the panel clears the singleton');

    fs.rmSync(ROOT, { recursive: true, force: true });
    if (errors) {
        console.error(`\n${errors} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll start-command tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
