/**
 * @file test_ads_watch.js
 * @description Online monitoring (R15), end to end inside the extension host: the commands of
 * src/commands/onlineCommands.js under a recording `vscode` stub, the custom editor provider's online
 * hooks, the real live path and the real LSP `provideOnlinePaths` over the sample project, and the
 * in-memory PLC of test/_fakeAds.js in place of a router.
 *
 * Covers: the contributions (commands, view, settings: writes off by default, nothing called
 * "Force"); Go Online by command and its status bar; inline values for a PROGRAM and for an FB
 * through an instance found in the PLC's symbols; the code-mismatch guard (another project on the
 * PLC: no values, writes blocked, "Differs" in the status bar); Write value… from the editor (off by
 * default, the per-session enable, the modal, the log); the PLC Watch view (add from the editor,
 * values by notification, struct members, remove, the notification cap and its message, persistence);
 * a connect error with the user-mode-runtime explanation; Go Offline and deactivation leaving nothing
 * open.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { createFakePlc, dataType } = require('./_fakeAds');
const { reportCoverage } = require('./_coverage');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms = 2000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await tick(5); return cond(); };

const REPO = path.join(__dirname, '..');
const SAMPLE = path.join(REPO, 'sample', 'TcToolkitSample', 'TcToolkitSample_PLC');
const MAIN = path.join(SAMPLE, 'POUs', 'MAIN.TcPOU');
const STATION = path.join(SAMPLE, 'POUs', 'Machine', 'FB_Station.TcPOU');
if (!fs.existsSync(MAIN) || !fs.existsSync(STATION)) {
    console.log('SKIP: sample/TcToolkitSample is missing.');
    reportCoverage('ads-watch', 'skipped', 'sample/ not present');
    process.exit(0);
}

// ── A recording `vscode` stub ───────────────────────────────────────────────────────────────────
const calls = { infos: [], warnings: [], errors: [], modals: [], inputs: [], picks: [], contexts: {}, statusMessages: [], clipboard: '' };
const answers = { message: [], input: [], quickPick: [] };
const settings = {};
const handlers = new Map();
const channels = [];
let currentToken = null;
const message = (bucket) => async (m, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : null;
    (opts && opts.modal ? calls.modals : calls[bucket]).push({ m, buttons: rest, opts });
    return answers.message.shift();
};
class EventEmitter { constructor() { this.fns = []; this.event = (fn) => { this.fns.push(fn); return { dispose() {} }; }; } fire(v) { this.fns.forEach(f => f(v)); } }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
const trees = new Map();
const statusItems = [];
const vscodeStub = {
    EventEmitter, TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    env: { clipboard: { writeText: async (t) => { calls.clipboard = t; } } },
    workspace: {
        textDocuments: [],
        getConfiguration: (section) => ({ get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, `${section}.${key}`) ? settings[`${section}.${key}`] : fallback) }),
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
        createOutputChannel: (name) => { const ch = { name, lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }; channels.push(ch); return ch; },
        createStatusBarItem: () => { const s = { text: '', tooltip: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; statusItems.push(s); return s; },
        registerTreeDataProvider: (id, p) => { trees.set(id, p); return { dispose() {} }; },
        showInformationMessage: message('infos'),
        showWarningMessage: message('warnings'),
        showErrorMessage: message('errors'),
        showInputBox: async (o) => { calls.inputs.push(o); return answers.input.shift(); },
        showQuickPick: async (items, o) => { calls.picks.push({ items, o }); const w = answers.quickPick.shift(); return w === undefined ? undefined : items.find(i => i.label === w); },
        setStatusBarMessage: (m) => { calls.statusMessages.push(m); return { dispose() {} }; },
        withProgress: async (opts, task) => {
            const fns = [];
            currentToken = { isCancellationRequested: false, onCancellationRequested: (fn) => { fns.push(fn); return { dispose() {} }; },
                cancel() { this.isCancellationRequested = true; fns.forEach(f => f()); } };
            return task({ report() {} }, currentToken);
        }
    },
    commands: {
        registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() {} }; },
        executeCommand: async (id, ...args) => {
            if (id === 'setContext') { calls.contexts[args[0]] = args[1]; return undefined; }
            return handlers.has(id) ? handlers.get(id)(...args) : undefined;
        }
    }
};
const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.apply(this, arguments);
};

// ── The LSP side, in process: the real index over the sample and the real provideOnlinePaths ─────
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideOnlinePaths } = require('../src/lsp/features');
clearWorkspaceIndex();
const fileUri = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, o); else if (/\.Tc(POU|GVL|DUT)$/.test(e.name)) o.push(f); } return o; };
const sampleFiles = walk(SAMPLE);
for (const f of sampleFiles) indexXmlObject(getWorkspaceSymbolIndex(), fs.readFileSync(f, 'utf8'), fileUri(f));
handlers.set('twincat.lsp.queryOnlinePaths', async (p) => {
    parseAndIndexDocument(p.code, p.fileUri);
    return provideOnlinePaths(p.code, p.ranges, getWorkspaceSymbolIndex(), p.fileUri);
});

// ── The PLC: its top-level symbols are the sample's last build (the committed .tmc), so the code
// check's variable-layout comparison passes; values are the test's. ─────────────────────────────────
const { parseTmcSymbols } = require('../src/online/codeIdentity');
const os = require('os');
const TMC = path.join(SAMPLE, 'TcToolkitSample_PLC.tmc');
const built = parseTmcSymbols(fs.readFileSync(TMC, 'utf8'));
const stationType = dataType('FB_Station', { subItems: [{ name: '_eState', type: 'E_StationState', subItems: [] }, { name: '_stStatus', type: 'ST_StationStatus', subItems: [{ name: 'bError', type: 'BOOL' }] }] });
const values = {
    'MAIN.nCycleCount': 41, 'MAIN.nIdx': 3, 'MAIN.fScaled': 0.5, 'GVL_Hmi.bEnable': true, 'GVL_Hmi.nSpeed': 50,
    'GVL_System.fbStation': { _eState: { name: 'Idle', value: 0 }, _stStatus: { bError: false } }
};
const symbols = {};
for (const s of built.values()) {
    symbols[s.name] = { type: s.array ? `ARRAY OF ${s.baseType}` : s.baseType, size: s.bytes, value: values[s.name] !== undefined ? values[s.name] : 0,
        dataType: s.name === 'GVL_System.fbStation' ? stationType : undefined };
}
Object.assign(symbols, {
    'GVL_System.fbStation._stStatus.bError': { type: 'BOOL', value: false },
    'GVL_System.fbStation._eState': { type: 'E_StationState', value: { name: 'Idle', value: 0 },
        dataType: dataType('E_StationState', { size: 2, enumInfos: [{ name: 'Idle', value: 0 }, { name: 'Running', value: 1 }] }) },
    'GVL_System.fbStation._nErrorId': { type: 'UDINT', value: 0 }
});
const plc = createFakePlc({ symbols });
// The project folder the code check reads: a copy of the .tmc, written now, so every sample source
// is older than "the last build" whatever order the checkout wrote them in.
const BUILD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_online_build_'));
fs.copyFileSync(TMC, path.join(BUILD_DIR, 'TcToolkitSample_PLC.tmc'));

// ── Provider, project map, the commands ──────────────────────────────────────────────────────────
const memento = () => { const m = new Map(); return { m, get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { m.set(k, v); return Promise.resolve(); } }; };
const context = { subscriptions: [], workspaceState: memento(), globalState: memento(), extensionUri: { fsPath: REPO } };
const project = { name: 'TcToolkitSample_PLC', dir: BUILD_DIR, objectFiles: new Map(sampleFiles.map(f => [f.toLowerCase(), f])) };
const projectMap = { projects: new Map([['a', project]]), ownersOf: (p) => (sampleFiles.includes(p) ? ['a'] : []) };
const posts = new Map();
const provider = { activePanels: new Map(), pendingEditsStore: { get: () => null }, broadcasts: [], broadcastOnlineState(o) { this.broadcasts.push(o); } };
const doc = (file) => {
    const uri = { fsPath: file, toString: () => fileUri(file) };
    posts.set(uri.toString(), []);
    provider.activePanels.set(uri.toString(), { webview: { postMessage: (m) => { posts.get(uri.toString()).push(m); return Promise.resolve(true); } } });
    return { uri, isDirty: false, getText: () => fs.readFileSync(file, 'utf8') };
};
const lastValues = (d) => { const list = posts.get(d.uri.toString()).filter(m => m.type === 'online/values'); return list.length ? list[list.length - 1].items : null; };
const lastState = (d) => { const list = posts.get(d.uri.toString()).filter(m => m.type === 'online/state'); return list[list.length - 1]; };

const { registerOnlineCommands, OUTPUT_CHANNEL_NAME, WATCH_KEY, parseTarget } = require('../src/commands/onlineCommands');
let createClient = plc.createClient;
const api = registerOnlineCommands(context, { provider, getProjectMap: () => projectMap, createClient: (o) => createClient(o) });
const run = (id, ...a) => vscodeStub.commands.executeCommand(id, ...a);
const channel = () => channels.find(c => c.name === OUTPUT_CHANNEL_NAME);
const status = statusItems[0];
const watchTree = trees.get('twincatWatch');

(async () => {
    // ── contributions ─────────────────────────────────────────────────────────────────────────────
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const c = pkg.contributes;
    const ids = ['twincat.goOnline', 'twincat.goOffline', 'twincat.online.enableWrites', 'twincat.online.selectInstance', 'twincat.online.showLog',
        'twincat.online.statusMenu', 'twincat.watch.add', 'twincat.watch.remove', 'twincat.watch.clear', 'twincat.watch.copyPath', 'twincat.watch.write'];
    for (const id of ids) {
        const cmd = c.commands.find(x => x.command === id);
        assert(cmd && cmd.category === 'TC Toolkit' && handlers.has(id) && pkg.activationEvents.includes(`onCommand:${id}`),
            `${id} is contributed under TC Toolkit, registered and activating`);
    }
    const sec = [].concat(c.configuration).find(s => s.id === 'tcToolkit.online');
    assert(sec && sec.properties['tcToolkit.online.allowWrites'].default === false, 'tcToolkit.online.allowWrites is off by default');
    assert(sec && sec.properties['tcToolkit.online.connectionMode'].default === 'router', 'the connection mode defaults to the local router');
    assert(sec && sec.properties['tcToolkit.online.inlinePollInterval'].default === 500 && sec.properties['tcToolkit.online.watchCycleTime'].default === 200
        && sec.properties['tcToolkit.online.maxNotifications'].default === 100 && sec.properties['tcToolkit.online.maxNotifications'].maximum <= 400,
        'D8: 500 ms inline, 200 ms watch, notifications capped well below 550');
    assert(/untested/i.test(sec.properties['tcToolkit.online.routerAddress'].markdownDescription), 'the router-address setting is marked untested (D9)');
    const uiText = JSON.stringify([c.commands.filter(x => /online|watch|Online/.test(x.command)).map(x => x.title), sec, c.views.twincat]);
    assert(!/\bforce\b(?!s active)/i.test(uiText.replace(/it is not a force/gi, '')), 'no command, view or setting offers a "Force" (D2)');
    assert(c.views.twincat.some(v => v.id === 'twincatWatch' && v.name === 'PLC Watch') && pkg.activationEvents.includes('onView:twincatWatch'),
        'the PLC Watch view is contributed and activates the extension');
    assert(parseTarget('5.1.2.3.1.1:852', 851).port === 852 && parseTarget('5.1.2.3.1.1', 851).port === 851 && !parseTarget('5.1.2.3', 851),
        'a typed target is an AMS Net ID with an optional port');

    // ── a connect error, router mode, no fallback ─────────────────────────────────────────────────
    plc.connectBehavior = { error: Object.assign(new Error('x'), { trace: ['connectToTarget(): Registering ADS port failed', 'registerAdsPort(): Timeout'] }) };
    answers.message.push(undefined);
    let r = await run('twincat.goOnline', { netId: 'localhost', label: 'Local runtime' });
    assert(r.status === 'failed' && calls.errors.some(e => /user-mode runtime/.test(e.m) && /kernel-mode/.test(e.m)),
        'a port-registration failure shows the user-mode-runtime explanation with its workarounds (D4)');
    assert(plc.clients.every(cl => cl.options.mode === 'router'), 'and nothing was retried in direct mode (D3)');
    assert(channel().lines.some(l => /Go Online failed \(port-registration\)/.test(l)), 'the raw failure is in the output channel');
    plc.connectBehavior = {};

    // ── cancel ────────────────────────────────────────────────────────────────────────────────────
    plc.connectBehavior = { delayMs: 40 };
    const pending = run('twincat.goOnline', { netId: 'localhost', label: 'Local runtime' });
    await tick(5);
    currentToken.cancel();
    r = await pending;
    assert(r.status === 'cancelled' && api.session.state === 'offline', 'the progress notification\'s Cancel stops Go Online');
    await tick(60);
    assert(plc.openConnections === 0, 'and leaves no connection open');
    plc.connectBehavior = {};

    // ── Go Online ─────────────────────────────────────────────────────────────────────────────────
    r = await run('twincat.goOnline', { netId: 'localhost', label: 'Local runtime' });
    assert(r.status === 'online' && api.session.state === 'online' && calls.contexts['twincat.online'] === true, 'Go Online connects and sets the context key');
    assert(status.shown && /Online: Local runtime · Run/.test(status.text) && /Forces: none/.test(status.tooltip),
        `the status bar says online, the PLC state and the forces (${status.text})`);
    assert(provider.broadcasts[provider.broadcasts.length - 1] === true, 'open editors are told to show their online actions');
    const recent = context.workspaceState.get('twincat.online.recentTargets', []);
    assert(recent.length === 1 && recent[0].netId === 'localhost', 'the target is remembered as recent (no credential is stored)');

    // ── inline values: a PROGRAM ──────────────────────────────────────────────────────────────────
    const mainDoc = doc(MAIN);
    const mainMsg = { componentId: 'root', fileUri: mainDoc.uri.toString(), visible: { decl: [{ start: 1, end: 20 }], impl: [{ start: 1, end: 30 }] } };
    await provider.onlineSource.visible(mainDoc.uri.toString(), mainDoc, mainMsg);
    let items = lastValues(mainDoc);
    const declCount = items && items.find(i => i.pane === 'decl' && i.path === 'MAIN.nCycleCount');
    const implSpeed = items && items.find(i => i.pane === 'impl' && i.path === 'GVL_Hmi.nSpeed');
    assert(declCount && declCount.text === '41' && declCount.eol && declCount.line === 3,
        `a PROGRAM's declaration line shows its value at the end of line 3 (${JSON.stringify(declCount)})`);
    assert(implSpeed && implSpeed.text === '50' && implSpeed.line === 10, `a qualified global in the implementation shows its value (${JSON.stringify(implSpeed)})`);
    assert(!items.some(i => /State$/.test(i.path)), 'a property (not on the PLC) shows nothing');
    plc.set('MAIN.nCycleCount', 42);
    await waitFor(() => { const v = lastValues(mainDoc); return v && v.some(i => i.path === 'MAIN.nCycleCount' && i.text === '42'); }, 1500);
    assert(lastValues(mainDoc).some(i => i.path === 'MAIN.nCycleCount' && i.text === '42'), 'the poll picks up a changed value');

    // ── inline values: an FB, through an instance on the PLC ──────────────────────────────────────
    const stationDoc = doc(STATION);
    const cyclicMsg = { componentId: 'method_Cyclic', fileUri: stationDoc.uri.toString(), visible: { decl: [{ start: 1, end: 10 }], impl: [{ start: 1, end: 40 }] } };
    await provider.onlineSource.visible(stationDoc.uri.toString(), stationDoc, cyclicMsg);
    items = lastValues(stationDoc);
    const bError = items && items.find(i => i.path === 'GVL_System.fbStation._stStatus.bError');
    assert(bError && bError.text === 'FALSE', `an FB member in a method body is read through the instance found on the PLC (${bError && bError.path})`);
    assert(/Instance: GVL_System\.fbStation/.test(lastState(stationDoc).note), 'the editor is told which instance it shows');
    assert(!items.some(i => /bExtended/.test(i.path)), 'a method local shows nothing');

    // ── write from the editor ─────────────────────────────────────────────────────────────────────
    const writeMsg = (line, column) => ({ componentId: 'root', pane: 'impl', position: { lineNumber: line, column }, fileUri: mainDoc.uri.toString() });
    answers.message.push(undefined);
    r = await provider.onlineSource.write(mainDoc.uri.toString(), mainDoc, writeMsg(10, 3));
    assert(r.status === 'refused' && calls.warnings.some(w => /allowWrites/.test(w.m) && w.buttons.includes('Open Setting')),
        'Write value… is refused while writes are off, with a way to the setting');
    assert(plc.writes.length === 0, 'and nothing is written');
    settings['tcToolkit.online.allowWrites'] = true;
    answers.message.push('Enable writes', 'Write');
    answers.input.push('77');
    r = await provider.onlineSource.write(mainDoc.uri.toString(), mainDoc, writeMsg(10, 3));
    const modals = calls.modals.slice(-2);
    assert(r.status === 'written' && plc.get('GVL_Hmi.nSpeed') === 77, 'with the setting on, the session enabled and the modal confirmed, the value is written');
    assert(modals[0].buttons[0] === 'Enable writes' && modals[1].buttons[0] === 'Write' && /Write 77 to GVL_Hmi\.nSpeed on Local runtime\?/.test(modals[1].m)
        && /Current value: 50/.test(modals[1].opts.detail), 'both dialogs are modal; the write one names target, path and values');
    assert(channel().lines.some(l => /Written: GVL_Hmi\.nSpeed = 77 on Local runtime \(was 50\)/.test(l)), 'the write is logged');
    mainDoc.isDirty = true;
    vscodeStub.workspace.textDocuments = [mainDoc];
    answers.message.push(undefined);
    r = await provider.onlineSource.write(mainDoc.uri.toString(), mainDoc, writeMsg(10, 3));
    assert(r.status === 'refused' && /unsaved edits/.test(r.message), 'blocked while the editor has unsaved edits');
    mainDoc.isDirty = false;
    vscodeStub.workspace.textDocuments = [];
    answers.message.push(undefined);
    r = await provider.onlineSource.write(stationDoc.uri.toString(), stationDoc, { componentId: 'method_Cyclic', pane: 'decl', position: { lineNumber: 3, column: 3 }, fileUri: stationDoc.uri.toString() });
    assert(r.status === 'refused' && /Method locals/.test(r.message), 'a method local cannot be written, and says why');

    // ── PLC Watch ─────────────────────────────────────────────────────────────────────────────────
    const added = await provider.onlineSource.addWatch(mainDoc.uri.toString(), mainDoc, writeMsg(1, 3));
    assert(added === true && api.watch.size === 1, 'Add to PLC Watch from the editor adds the variable under the caret');
    await waitFor(() => api.watch.list()[0].state === 'ok');
    let rows = watchTree.getChildren();
    assert(rows[0].path === 'MAIN.nCycleCount' && rows[0].text === '42', `the Watch view shows it with its value (${JSON.stringify(rows[0] && rows[0].text)})`);
    assert(plc.notifications.size === 1 && [...plc.notifications][0].cycleMs === 200, 'one on-change notification at 200 ms');
    plc.set('MAIN.nCycleCount', 43);
    await waitFor(() => watchTree.getChildren()[0].text === '43');
    assert(watchTree.getChildren()[0].text === '43', 'a notification updates the view');
    assert(watchTree.getTreeItem(watchTree.getChildren()[0]).contextValue === 'watchEntry scalar', 'a scalar entry offers Write value… and Remove');
    await run('twincat.watch.add', { path: 'GVL_System.fbStation' });
    await waitFor(() => api.watch.list()[1] && api.watch.list()[1].state === 'ok');
    rows = watchTree.getChildren();
    const fbRow = rows[1];
    assert(fbRow.expandable && watchTree.getTreeItem(fbRow).contextValue === 'watchEntry', 'an FB instance is expandable and not writable as a whole');
    const members = watchTree.getChildren(fbRow);
    assert(members.some(m => m.label === '_eState' && m.text === 'Idle (0)') && members.some(m => m.label === '_stStatus' && m.expandable),
        `its members come from the one notification's value (${members.map(m => m.label + '=' + m.text)})`);
    const nested = watchTree.getChildren(members.find(m => m.label === '_stStatus'));
    assert(nested[0].path === 'GVL_System.fbStation._stStatus.bError' && nested[0].text === 'FALSE', 'nested members have their full ADS path');
    assert(plc.notifications.size === 2, 'expanding costs no notification');
    settings['tcToolkit.online.maxNotifications'] = 2;
    await run('twincat.watch.add', { path: 'GVL_Hmi.bEnable' });
    await waitFor(() => api.watch.list()[2] && api.watch.list()[2].state === 'capped');
    assert(api.watch.list()[2].state === 'capped' && plc.notifications.size === 2, 'past tcToolkit.online.maxNotifications an entry is not subscribed');
    assert(calls.warnings.some(w => /notification limit \(2/.test(w.m) && /550/.test(w.m)), 'and the user is told once, with Beckhoff\'s 550 limit');
    assert(JSON.stringify(context.workspaceState.get(WATCH_KEY).map(e => e.path)) === JSON.stringify(['MAIN.nCycleCount', 'GVL_System.fbStation', 'GVL_Hmi.bEnable']),
        'the watch list is kept in the workspace state');
    await run('twincat.watch.copyPath', rows[0]);
    assert(calls.clipboard === 'MAIN.nCycleCount', 'Copy ADS Path');
    await run('twincat.watch.remove', rows[1]);
    assert(api.watch.size === 2 && plc.notifications.size === 1, 'Remove drops the entry and its notification');
    answers.message.push('Write');
    answers.input.push('5');
    r = await run('twincat.watch.write', watchTree.getChildren()[0]);
    assert(r.status === 'written' && plc.get('MAIN.nCycleCount') === 5, 'Write value… from the Watch view (session already enabled: one modal)');

    // ── the code-mismatch guard ───────────────────────────────────────────────────────────────────
    plc.appInfo.ProjectName = 'OtherProject';
    await api.session.refreshStatus();
    await waitFor(() => { const v = lastValues(mainDoc); return v && v.length === 0; });
    assert(lastValues(mainDoc).length === 0 && /The PLC runs OtherProject/.test(lastState(mainDoc).note),
        'another project on the PLC: the editors show no values and say why');
    assert(/Code differs/.test(status.text) && status.backgroundColor, `the status bar says the code differs (${status.text})`);
    assert(/a change to code bodies alone is not detected/.test(status.tooltip), 'and its tooltip says what the code check does NOT cover');
    answers.message.push(undefined);
    r = await run('twincat.watch.write', watchTree.getChildren()[0]);
    assert(r.status === 'refused' && /not a PLC project of this workspace/.test(r.message) && /Writes are blocked/.test(r.message), 'and writes are blocked');
    plc.appInfo.ProjectName = 'TcToolkitSample_PLC';
    // The same name, but a variable the last build does not have: the layout check fails.
    plc.addSymbol('MAIN.nAddedOnline', { type: 'INT', value: 1 });
    plc.appInfo.OnlineChangeCnt = 5; // what adding a variable takes: an online change (or a download)
    await api.session.refreshStatus();
    await api.refreshCodeCheck();
    assert(api.codeCheck().state === 'differs' && api.codeCheck().layout === 'differs' && api.codeCheck().showValues,
        'same project name, different variables: the code differs, values stay (they are read by name), writes are blocked');
    assert(channel().lines.some(l => /MAIN\.nAddedOnline is on the PLC but not in the last build/.test(l)), 'the difference is logged by name');
    answers.message.push(undefined);
    r = await run('twincat.watch.write', watchTree.getChildren()[0]);
    assert(r.status === 'refused' && /variables on the PLC differ from the last build/.test(r.message), 'a write is refused with that reason');
    plc.removeSymbol('MAIN.nAddedOnline');
    // A source file edited after the last build: the code on screen is not the code that was built.
    const edited = path.join(BUILD_DIR, 'MAIN_edited.TcPOU');
    fs.writeFileSync(edited, '<edited/>');
    fs.utimesSync(edited, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    project.objectFiles.set(edited.toLowerCase(), edited);
    plc.appInfo.OnlineChangeCnt = 6;
    await api.session.refreshStatus();
    await api.refreshCodeCheck();
    assert(api.codeCheck().state === 'differs' && api.codeCheck().edits === 'edited' && /edited since its last build \(MAIN_edited\.TcPOU\)/.test(api.codeCheck().reason),
        `a source edited after the .tmc was written makes the code differ (${api.codeCheck().reason})`);
    project.objectFiles.delete(edited.toLowerCase());
    await api.refreshCodeCheck();
    assert(api.codeCheck().state === 'match', `with the layout equal and no edits since the build, the check passes (${api.codeCheck().reason})`);
    plc.appInfo.forces = { plc: false, io: true };
    await api.session.refreshStatus();
    await waitFor(() => { const v = lastValues(mainDoc); return v && v.length > 0; });
    assert(lastValues(mainDoc).length > 0, 'the values come back when the project matches again');
    assert(/Forces active/.test(status.text) && /I\/O/.test(status.tooltip), `forces set from XAE show in the status bar (${status.text})`);

    // ── Go Offline, then deactivation ─────────────────────────────────────────────────────────────
    await run('twincat.goOffline');
    assert(api.session.state === 'offline' && plc.openConnections === 0 && plc.notifications.size === 0, 'Go Offline closes the connection and every notification');
    assert(!status.shown && calls.contexts['twincat.online'] === false, 'the status bar item goes away');
    assert(lastState(mainDoc).online === false, 'the editors are told');
    const sumsAfterOffline = plc.sumReads;
    await tick(700);
    assert(plc.sumReads === sumsAfterOffline, 'no poll runs while offline');
    assert(watchTree.getChildren().every(row => row.state === 'offline'), 'watched entries show offline');
    await run('twincat.goOnline', { netId: 'localhost', label: 'Local runtime' });
    answers.message.push(undefined);
    r = await run('twincat.watch.write', watchTree.getChildren()[0]);
    assert(r.status === 'cancelled' && calls.modals[calls.modals.length - 1].buttons[0] === 'Enable writes',
        'writes are enabled per online session: after going online again, the enable is asked again');
    await provider.onlineSource.visible(mainDoc.uri.toString(), mainDoc, mainMsg);
    await waitFor(() => plc.notifications.size === 1);
    await api.dispose();
    assert(plc.openConnections === 0 && plc.notifications.size === 0 && api.session.state === 'offline',
        'deactivation (dispose) leaves no connection, no notification');
    const sums = plc.sumReads;
    await tick(700);
    assert(plc.sumReads === sums, 'and no poll');

    reportCoverage('ads-watch', 'ran');
    if (errors) { console.error(`\n${errors} online command assertion(s) failed`); process.exit(1); }
    console.log('\nAll online command and PLC Watch assertions passed.');
    process.exit(0);
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
