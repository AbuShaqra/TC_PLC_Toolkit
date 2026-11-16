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
const calls = { infos: [], warnings: [], errors: [], modals: [], inputs: [], picks: [], contexts: {}, statusMessages: [], clipboard: '', executed: [] };
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
        getConfiguration: (section) => ({
            get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, `${section}.${key}`) ? settings[`${section}.${key}`] : fallback),
            // The settings here are the user's own (globalValue); allowWrites is read from them only.
            inspect: (key) => ({ key: `${section}.${key}`, globalValue: settings[`${section}.${key}`] })
        }),
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
            calls.executed.push(id);
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
const provider = { activePanels: new Map(), pendingEditsStore: { get: () => null, peek: () => ({ edits: {}, stale: false }) }, broadcasts: [], broadcastOnlineState(o) { this.broadcasts.push(o); } };
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
        'twincat.online.startPlc', 'twincat.online.stopPlc',
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
    const uiText = JSON.stringify([c.commands.filter(x => /online|watch|Online/.test(x.command)).map(x => x.title), sec, c.views.twincat, c.views['twincat-watch-panel']]);
    assert(!/\bforce\b(?!s active)/i.test(uiText.replace(/it is not a force/gi, '')), 'no command, view or setting offers a "Force" (D2)');
    assert((c.views['twincat-watch-panel'] || []).some(v => v.id === 'twincatWatch' && v.name === 'PLC Watch') && pkg.activationEvents.includes('onView:twincatWatch'),
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

    // ── the fallback's DLL was not found: the hint names the setting, with Open Setting ─────────────
    plc.connectBehavior = { error: Object.assign(new Error('x'), { trace: ['connectToTarget(): Starting the ADS helper failed: TwinCAT.Ads.dll was not found'],
        fallback: { routerError: 'socket error -4077' }, helper: { kind: 'dll-not-found', message: 'TwinCAT.Ads.dll was not found',
            detail: { dllName: 'TwinCAT.Ads.dll', configured: false } } }) };
    answers.message.push('Open Setting');
    const e0 = calls.errors.length;
    const x0 = calls.executed.length;
    r = await run('twincat.goOnline', { netId: '10.0.0.4.1.1', label: '10.0.0.4.1.1' });
    await tick(0);
    assert(r.status === 'failed' && r.failure.setting === 'tcToolkit.adsDll.dotNetLibrary' && calls.errors[e0]
        && /set tcToolkit\.adsDll\.dotNetLibrary to its TwinCAT\.Ads\.dll/.test(calls.errors[e0].m)
        && JSON.stringify(calls.errors[e0].buttons) === JSON.stringify(['Open Setting', 'Show Log']),
        'TwinCAT.Ads.dll not found: the message names tcToolkit.adsDll.dotNetLibrary and offers Open Setting');
    assert(calls.executed.slice(x0).includes('twincat.openSettings'), 'Open Setting opens the settings');
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

    // ── Start / Stop PLC (user request 2026-11-16) ────────────────────────────────────────────────
    const plcPosts = (d) => posts.get(d.uri.toString()).filter(m => m.type === 'online/plc');
    const lastPlc = (d) => { const l = plcPosts(d); return l[l.length - 1]; };
    await waitFor(() => calls.contexts['twincat.plcRunning'] === true);
    assert(calls.contexts['twincat.plcRunning'] === true && calls.contexts['twincat.plcStopped'] === false && calls.contexts['twincat.plcControlBusy'] === false,
        'online and running: the context keys offer Stop (PLC Watch title bar, palette)');
    assert(provider.onlineSource.plcState().action === 'stop' && provider.onlineSource.plcState().plcState === 'Run',
        'an editor that opens now is told the toggle offers Stop');
    settings['tcToolkit.online.allowWrites'] = false;
    const modalCount = calls.modals.length;
    answers.message.push(undefined);
    r = await run('twincat.online.stopPlc');
    assert(r.status === 'cancelled' && plc.controls.length === 0 && calls.modals.length === modalCount + 1
        && calls.modals[modalCount].m === 'Stop the PLC on Local runtime (localhost:851)?' && calls.modals[modalCount].buttons.join() === 'Stop PLC',
        `Stop PLC asks with a modal naming the target, one confirm button; cancelled sends nothing (${calls.modals[modalCount] && calls.modals[modalCount].m})`);
    answers.message.push('Stop PLC');
    r = await provider.onlineSource.plcControl('stop');
    assert(r.status === 'done' && plc.controls.join() === 'stop' && api.session.info.plcState === 'Stop',
        'confirmed from the editor toolbar: the PLC stops, with writes off (Start/Stop is not gated by allowWrites)');
    assert(lastPlc(mainDoc) && lastPlc(mainDoc).action === 'start' && lastPlc(mainDoc).plcState === 'Stop' && lastPlc(mainDoc).online === true,
        `every open editor's toggle follows at once: it offers Start now (${JSON.stringify(lastPlc(mainDoc))})`);
    assert(plcPosts(mainDoc).some(m => m.busy === true && m.action === null), 'while the request ran, the toggle was disabled (busy)');
    assert(calls.contexts['twincat.plcRunning'] === false && calls.contexts['twincat.plcStopped'] === true, 'the context keys swap to Start');
    assert(/Online: Local runtime · Stop/.test(status.text), `the status bar follows (${status.text})`);
    assert(channel().lines.some(l => /PLC stop on Local runtime \(localhost:851\): done \(PLC state now Stop\)\./.test(l))
        && channel().lines.some(l => /PLC stop on Local runtime \(localhost:851\): cancelled\./.test(l)), 'both attempts are logged in TC Toolkit Online');
    r = await run('twincat.online.stopPlc');
    assert(r.status === 'refused' && calls.warnings.some(w => /The PLC is in Stop/.test(w.m)) && plc.controls.length === 1,
        'Stop while stopped is refused with a message, before any modal');
    plc.controlError = Object.assign(new Error('startPlc(): failed'), { adsError: { errorCode: 0x712, errorStr: 'Server is in invalid state' } });
    answers.message.push('Start PLC', undefined);
    r = await run('twincat.online.startPlc');
    assert(r.status === 'failed' && calls.errors.some(e => e.m === 'Starting the PLC failed: ADS error 0x712 (Server is in invalid state)' && e.buttons.includes('Show Log')),
        'a failed start shows the ADS error briefly, with Show Log');
    answers.message.push('Start PLC');
    r = await provider.onlineSource.plcControl('start');
    assert(r.status === 'done' && api.session.info.plcState === 'Run' && lastPlc(mainDoc).action === 'stop', 'Start PLC: running again, the toggle offers Stop');
    const before = plc.controls.length;
    r = await provider.onlineSource.plcControl('reboot');
    assert(r.status === 'refused' && plc.controls.length === before, 'an unknown action from a webview is refused');
    settings['tcToolkit.online.allowWrites'] = undefined;
    delete settings['tcToolkit.online.allowWrites'];

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
    assert(modals[0].buttons[0] === 'Enable writes' && modals[1].buttons[0] === 'Write' && /Write 77 to GVL_Hmi\.nSpeed on Local runtime \(localhost:851\)\?/.test(modals[1].m)
        && /Current value: 50/.test(modals[1].opts.detail), 'both dialogs are modal; the write one names target, path and values');
    assert(channel().lines.some(l => /Written: GVL_Hmi\.nSpeed = 77 on Local runtime \(localhost:851\) \(was 50\)/.test(l)), 'the write is logged');
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
    assert(trees.get('twincatWatch') === watchTree && trees.get('twincatWatchSidebar') === watchTree,
        'one watch list backs both PLC Watch places (bottom panel, sidebar)');
    assert(calls.executed.includes('twincatWatch.focus') && !calls.executed.includes('twincatWatchSidebar.focus'),
        'adding brings the bottom-panel PLC Watch to the front by default');
    // tcToolkit.online.watchLocation = sidebar (user, 2026-11-16): the sidebar view is the one focused.
    await api.watch.remove('MAIN.nCycleCount');
    settings['tcToolkit.online.watchLocation'] = 'sidebar';
    calls.executed.length = 0;
    assert(await provider.onlineSource.addWatch(mainDoc.uri.toString(), mainDoc, writeMsg(1, 3)) === true
        && calls.executed.includes('twincatWatchSidebar.focus') && !calls.executed.includes('twincatWatch.focus'),
        'with watchLocation = sidebar, adding brings the sidebar PLC Watch to the front');
    delete settings['tcToolkit.online.watchLocation'];
    await waitFor(() => api.watch.list()[0].state === 'ok');
    let rows = watchTree.getChildren();
    assert(rows[0].path === 'MAIN.nCycleCount' && rows[0].text === '42', `the Watch view shows it with its value (${JSON.stringify(rows[0] && rows[0].text)})`);
    assert(plc.notifications.size === 1 && [...plc.notifications][0].cycleMs === 200, 'one on-change notification at 200 ms');
    // Let any redraw still batched from adding the entry go out first (redraws are batched, see below).
    await new Promise(res => setTimeout(res, require('../src/online/watchTree').REDRAW_MS + 50));
    const fired = [];
    watchTree.onDidChangeTreeData((e) => fired.push(e));
    const rowBefore = watchTree.getChildren()[0];
    plc.set('MAIN.nCycleCount', 43);
    await waitFor(() => fired.length > 0);
    // User, 2026-11-16: a full redraw on every value made VS Code's progress bar flash in the view.
    assert(fired.length > 0 && fired.every(e => Array.isArray(e) && e.length === 1 && e[0] === rowBefore) && rowBefore.text === '43',
        `a new value redraws only its own row, the same object getChildren returned (${fired.map(e => (Array.isArray(e) ? e.map(x => x.path).join("+") : "ALL")).join(",")})`);
    const reloaded = watchTree.getChildren()[0];
    assert(reloaded.text === '43' && reloaded !== rowBefore,
        'a reload hands VS Code new row objects (it loses objects seen in an earlier reload; the value then froze)');
    fired.length = 0;
    plc.set('MAIN.nCycleCount', 44);
    await waitFor(() => fired.length > 0);
    assert(fired.every(e => Array.isArray(e) && e[0] === reloaded) && reloaded.text === '44', 'a later value redraws the row object of the latest reload');
    {
        // User, 2026-11-16: VS Code waits for a 200 ms pause in a tree's events; several entries changing
        // every 200 ms never left one. Redraws are batched: at most one per REDRAW_MS, carrying every changed row.
        const { REDRAW_MS } = require('../src/online/watchTree');
        const times = [];
        const batch = [];
        watchTree.onDidChangeTreeData((e) => { times.push(Date.now()); batch.push(e); });
        for (let i = 0; i < 6; i++) { watchTree.refresh('MAIN.nCycleCount'); await new Promise(res => setTimeout(res, 60)); }
        await new Promise(res => setTimeout(res, REDRAW_MS + 50));
        const gaps = times.slice(1).map((t, i) => t - times[i]);
        assert(REDRAW_MS > 200 && times.length >= 1 && times.length <= 3 && gaps.every(g => g >= REDRAW_MS - 20) && batch.every(e => Array.isArray(e) && e.length === 1),
            `six changes in 360 ms are sent as ${times.length} batched redraw(s), at least ${REDRAW_MS} ms apart (gaps ${gaps.join(',')})`);
    }
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
    await waitFor(() => api.watch.list()[1] && api.watch.list()[1].state === 'ok');
    assert(api.watch.size === 2 && plc.notifications.size === 2 && ![...plc.notifications].some(n => n.path === 'gvl_system.fbstation'),
        'Remove drops the entry and its notification');
    assert(api.watch.list()[1].path === 'GVL_Hmi.bEnable' && api.watch.list()[1].state === 'ok', 'and the freed slot goes to the entry the limit had refused');
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
    assert(calls.contexts['twincat.plcRunning'] === false && calls.contexts['twincat.plcStopped'] === false
        && posts.get(mainDoc.uri.toString()).filter(m => m.type === 'online/plc').pop().online === false,
        'Start/Stop goes away offline (context keys off, the editors\' toggle told)');
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
