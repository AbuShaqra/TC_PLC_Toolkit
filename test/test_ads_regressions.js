/**
 * @file test_ads_regressions.js
 * @description Online monitoring (R15): one regression per confirmed review finding (2026-11-13), so
 * none comes back unseen. Each block is labelled with the finding's index (#0-#19) and was run
 * against the code before its fix, where it failed. The fixes are described where they live; this
 * file only pins the behaviour:
 *
 *   Write safety (user decision D5): a write is bound to the online session (connection and target)
 *   the user enabled and confirmed (#0); only editors of the project the PLC runs may write (#1); a
 *   superseded code check never leaves a stale "match" (#2); unsaved edits are detected correctly,
 *   Manual Sync stashes of closed editors included (#3, #4); a workspace cannot turn writes on (#19);
 *   a PLC STRING cannot forge lines in the modal or the log (#17).
 *   Lifecycle: reconnects and downloads leak no notification (#5); one poll loop per editor (#6); a
 *   stale status poll never touches a new session (#7); watch slots are not leaked (#8) and freed
 *   slots are retried (#9); Cancel/Go Offline hold in every connect phase (#10); the user-mode hint
 *   covers the other router rejections (#11); no orphan client reconnects after Go Offline (#12).
 *   Paths: no fallback to a same-named GVL variable when the scope is uncertain (#13), and never to a
 *   `qualified_only` GVL or over an enumerator (#14).
 *   Inline values: they come back after an edit with unchanged PLC values (#16); truncation keeps
 *   surrogate pairs whole (#18). The webview half (#15, #16) is test/browser/run_online.js.
 *
 *   Review round 2 (blocks R2#0-R2#6, each failing on e6a3842): a download of another project or a
 *   type change while the dialogs are open refuses the write, and a click while connecting is refused
 *   (R2#0); a Manual Sync stash survives the BOM and the guard's read (R2#1); no symbol cache crosses a
 *   Cancel (R2#2); no watch slot overwrites a live handle (R2#3); no poll after Go Offline (R2#4); a
 *   GVL's declaration pane maps each name to itself (R2#5) and `qualifiedOnly` follows the editor (R2#6).
 *
 * Runs against the in-memory PLC of test/_fakeAds.js, the real ads-client 2.2.0 `Client` with its
 * ADS commands answered in memory (#5), and a local TCP listener standing in for a router (#12).
 */

'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
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
const ROUTER = { mode: 'router', targetAmsNetId: 'localhost', targetAdsPort: 851 };

const REPO = path.join(__dirname, '..');
const SAMPLE = path.join(REPO, 'sample', 'TcToolkitSample', 'TcToolkitSample_PLC');
const MAIN = path.join(SAMPLE, 'POUs', 'MAIN.TcPOU');

// ── A recording `vscode` stub (the command-level findings) ──────────────────────────────────────────
const calls = { infos: [], warnings: [], errors: [], modals: [], inputs: [], contexts: {} };
const answers = { message: [], input: [] };
/** User-scope and workspace-scope values, so a test can tell the two apart (#19). */
const settings = { user: {}, workspace: {} };
const handlers = new Map();
const channels = [];
const configListeners = [];
const message = (bucket) => async (m, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : null;
    (opts && opts.modal ? calls.modals : calls[bucket]).push({ m, buttons: rest, opts });
    const a = answers.message.shift();
    return typeof a === 'function' ? a(m, opts) : a;
};
class EventEmitter { constructor() { this.fns = []; this.event = (fn) => { this.fns.push(fn); return { dispose() {} }; }; } fire(v) { this.fns.forEach(f => f(v)); } }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
const trees = new Map();
const statusItems = [];
const lookup = (section, key) => {
    const k = `${section}.${key}`;
    const has = (o) => Object.prototype.hasOwnProperty.call(o, k);
    return { k, has, globalValue: has(settings.user) ? settings.user[k] : undefined, workspaceValue: has(settings.workspace) ? settings.workspace[k] : undefined };
};
const vscodeStub = {
    EventEmitter, TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    Uri: { parse: (s) => ({ fsPath: decodeURIComponent(String(s).replace(/^file:\/\/\/?/, '/')).replace(/^\/([A-Za-z]:)/, '$1'), toString: () => s }) },
    env: { clipboard: { writeText: async () => {} } },
    workspace: {
        textDocuments: [],
        // get(): the merged value, workspace over user, as VS Code merges a window-scope setting.
        getConfiguration: (section) => ({
            get: (key, fallback) => {
                const l = lookup(section, key);
                if (l.workspaceValue !== undefined) return l.workspaceValue;
                if (l.globalValue !== undefined) return l.globalValue;
                return fallback;
            },
            inspect: (key) => { const l = lookup(section, key); return { key: l.k, globalValue: l.globalValue, workspaceValue: l.workspaceValue }; }
        }),
        onDidChangeConfiguration: (fn) => { configListeners.push(fn); return { dispose() {} }; }
    },
    window: {
        createOutputChannel: (name) => { const ch = { name, lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }; channels.push(ch); return ch; },
        createStatusBarItem: () => { const s = { text: '', tooltip: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; statusItems.push(s); return s; },
        registerTreeDataProvider: (id, p) => { trees.set(id, p); return { dispose() {} }; },
        showInformationMessage: message('infos'),
        showWarningMessage: message('warnings'),
        showErrorMessage: message('errors'),
        showInputBox: async (o) => { calls.inputs.push(o); const a = answers.input.shift(); return typeof a === 'function' ? a(o) : a; },
        showQuickPick: async () => undefined,
        setStatusBarMessage: () => ({ dispose() {} }),
        withProgress: async (opts, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
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

const { createOnlineSession } = require('../src/online/session');
const { createAdsClient } = require('../src/online/adsClient');
const { describeConnectError, USER_MODE_HINT } = require('../src/online/connectErrors');
const { createInlineMonitor } = require('../src/online/inlineMonitor');
const { createWatchList } = require('../src/online/watchList');
const { performWrite, ENABLE_BUTTON, WRITE_BUTTON } = require('../src/online/writeGuard');
const { inlineText, formatValue } = require('../src/online/values');

/** The write-guard dependencies of the guard-level tests; `world` steers them. */
function guardDeps(session, world) {
    const sessionWrites = { enabled: false };
    const log = [];
    const dialogs = [];
    return {
        log, dialogs, sessionWrites,
        deps: {
            session, sessionWrites,
            allowWrites: () => true,
            projectState: () => 'match',
            hasUnsavedEdits: () => false,
            input: async (o) => (world.input ? world.input(o) : world.typed),
            confirm: async (o) => { dialogs.push(o); return world.confirm ? world.confirm(o) : true; },
            log: (l) => log.push(l)
        }
    };
}

/** A fake PLC client whose calls can be slowed down per method. */
function slowable(plc, delays) {
    return (o) => {
        const c = plc.createClient(o);
        for (const name of ['readValue', 'readRawMulti', 'subscribeRaw', 'getSymbols', 'readPlcState', 'getSymbol']) {
            const real = c[name];
            c[name] = async function (...a) { if (delays[name]) await tick(delays[name]); return real.apply(this, a); };
        }
        return c;
    };
}

async function guardLevel() {
    // ── #0: a write is bound to the session that was enabled and confirmed ────────────────────────
    {
        const plcA = createFakePlc({ symbols: { 'MAIN.nCount': { type: 'INT', value: 1 } } });
        const plcB = createFakePlc({ symbols: { 'MAIN.nCount': { type: 'INT', value: 2 } } });
        let which = plcA;
        const session = createOnlineSession({ createClient: (o) => which.createClient(o), statusIntervalMs: 100000 });
        await session.connect({ mode: 'router', targetAmsNetId: '1.1.1.1.1.1', targetAdsPort: 851, label: 'Machine A' });
        const world = {
            // While the "New value" box is open, Go Online runs against another PLC (a keybinding with args).
            input: async () => {
                which = plcB;
                await session.connect({ mode: 'router', targetAmsNetId: '2.2.2.2.1.1', targetAdsPort: 851, label: 'Machine B' });
                return '99';
            }
        };
        const g = guardDeps(session, world);
        const r = await performWrite({ path: 'MAIN.nCount', localType: 'INT', source: 'watch' }, g.deps);
        assert(r.status === 'refused' && plcB.writes.length === 0 && plcA.writes.length === 0,
            `#0 a reconnect to another PLC while the value box is open refuses the write (${r.status}: ${r.message})`);
        assert(!g.dialogs.some(d => d.button === WRITE_BUTTON && /Machine A/.test(d.message)),
            '#0 and no Write modal names the PLC that would not have been written');

        // Writes enabled for A do not carry over to B, even if the command layer forgot to reset them.
        const g2 = guardDeps(session, { typed: '5', confirm: (o) => o.button !== ENABLE_BUTTON });
        g2.sessionWrites.enabled = true;
        g2.sessionWrites.identity = { connectionId: -1, netId: '1.1.1.1.1.1', port: 851, label: 'Machine A' };
        const r2 = await performWrite({ path: 'MAIN.nCount', localType: 'INT', source: 'watch' }, g2.deps);
        assert(r2.status === 'cancelled' && g2.dialogs[0] && g2.dialogs[0].button === ENABLE_BUTTON && plcB.writes.length === 0,
            `#0 writes enabled for another connection ask again for this one (${r2.status})`);

        // A write enabled and confirmed for B names B with its AMS address, and is written to B.
        const g3 = guardDeps(session, { typed: '6' });
        const r3 = await performWrite({ path: 'MAIN.nCount', localType: 'INT', source: 'watch' }, g3.deps);
        const modal = g3.dialogs.find(d => d.button === WRITE_BUTTON);
        assert(r3.status === 'written' && plcB.get('MAIN.nCount') === 6 && modal && /Machine B \(2\.2\.2\.2\.1\.1:851\)/.test(modal.message)
            && g3.log.some(l => /Written: MAIN\.nCount = 6 on Machine B \(2\.2\.2\.2\.1\.1:851\)/.test(l)),
            `#0 the modal and the log name the target actually written, with its AMS address (${modal && modal.message})`);

        // Writes turned off for the session while the modal is open (Go Offline, then Online): refused.
        const g4 = guardDeps(session, { typed: '7', confirm: (o) => { if (o.button === WRITE_BUTTON) g4.sessionWrites.enabled = false; return true; } });
        g4.sessionWrites.enabled = true;
        g4.sessionWrites.identity = session.identity;
        const r4 = await performWrite({ path: 'MAIN.nCount', localType: 'INT', source: 'watch' }, g4.deps);
        assert(r4.status === 'refused' && plcB.get('MAIN.nCount') === 6, `#0 sessionWrites.enabled is re-checked right before the write (${r4.status})`);
        await session.disconnect();
    }

    // ── #17: a PLC STRING cannot add lines to the modal or the log ───────────────────────────────
    {
        const forged = "a'\nNew value: 'SAFE'\nPLC state: Stop\n\n";
        const plc = createFakePlc({ symbols: { 'MAIN.s': { type: 'STRING(80)', value: forged, dataType: dataType('STRING(80)', { size: 81 }) } } });
        const session = createOnlineSession({ createClient: plc.createClient, statusIntervalMs: 100000 });
        await session.connect(ROUTER);
        const g = guardDeps(session, { typed: 'x', confirm: (o) => o.button === ENABLE_BUTTON });
        await performWrite({ path: 'MAIN.s', localType: 'STRING(80)', source: 'watch' }, g.deps);
        const modal = g.dialogs.find(d => d.button === WRITE_BUTTON);
        assert(modal && modal.detail.split('\n').filter(l => /^New value:/.test(l)).length === 1
            && modal.detail.split('\n').filter(l => /^PLC state:/.test(l)).length === 1,
            `#17 a STRING with newlines does not forge a "New value"/"PLC state" line in the modal (${modal && JSON.stringify(modal.detail)})`);
        assert(g.log.every(l => ![...l].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)), '#17 every log entry stays on one line, free of control characters');
        assert(/\$N/.test(formatValue('a\nb', { name: 'STRING(80)' })) && formatValue('a\tb\u0001', { name: 'STRING' }) === "'a$Tb$01'",
            `#17 control characters show as ST escapes (${formatValue('a\tb\u0001', { name: 'STRING' })})`);
        plc.set('MAIN.s', 'y'.repeat(5000));
        const g2 = guardDeps(session, { typed: 'x', confirm: () => true });
        g2.sessionWrites.enabled = true;
        g2.sessionWrites.identity = session.identity;
        await performWrite({ path: 'MAIN.s', localType: 'STRING(80)', source: 'watch' }, { ...g2.deps, confirm: async (o) => { g2.dialogs.push(o); return false; } });
        const m2 = g2.dialogs.find(d => d.button === WRITE_BUTTON);
        assert(m2 && m2.detail.length < 1000 && g2.log.every(l => l.length < 1000), `#17 a long STRING is bounded in the modal and the log (${m2 && m2.detail.length})`);
        await session.disconnect();
    }

    // ── #18: inline truncation never splits a surrogate pair ─────────────────────────────────────
    {
        const s = inlineText('a' + '\u{1F600}'.repeat(50), { name: 'WSTRING(80)' });
        assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s) && s.endsWith('…'),
            `#18 a WSTRING of astral characters is shortened on a code-point boundary (${JSON.stringify(s.slice(-3))})`);
    }

    // ── #7: a status poll in flight across Go Offline/Online never touches the new session ───────
    {
        const plc = createFakePlc({ symbols: { 'MAIN.a': { type: 'INT', value: 1 } } });
        const delays = {};
        const session = createOnlineSession({ createClient: slowable(plc, delays), statusIntervalMs: 100000 });
        await session.connect(ROUTER);
        delays.readValue = 50;
        const old = session.refreshStatus();
        await tick(5);
        await session.disconnect();
        delays.readValue = 0;
        await session.connect(ROUTER);
        const after = session.info.projectName;
        await old;
        assert(after === 'TcToolkitSample_PLC' && session.info.projectName === 'TcToolkitSample_PLC' && session.info.plcState === 'Run',
            `#7 the new session reads its own status, and the old poll does not blank it (${after} / ${session.info.projectName} / ${session.info.plcState})`);
        await session.disconnect();
    }

    // ── #10: Cancel and Go Offline are honoured during the status phase of Go Online ─────────────
    {
        const plc = createFakePlc({});
        const session = createOnlineSession({ createClient: slowable(plc, { readValue: 30 }), statusIntervalMs: 100000 });
        let fire = () => {};
        const tok = { isCancellationRequested: false, onCancellationRequested: (f) => { fire = f; return { dispose() {} }; } };
        const p = session.connect(ROUTER, tok);
        await tick(10);
        tok.isCancellationRequested = true;
        fire();
        let err = null;
        try { await p; } catch (e) { err = e; }
        await tick(5);
        assert(err && err.cancelled && session.state === 'offline' && plc.openConnections === 0,
            `#10 Cancel during the status reads stops Go Online and closes the client (${err ? 'rejected' : 'resolved'}, ${session.state}, open ${plc.openConnections})`);
        const p2 = session.connect(ROUTER);
        await tick(10);
        await session.disconnect();
        let err2 = null;
        try { await p2; } catch (e) { err2 = e; }
        assert(err2 && err2.cancelled && session.state === 'offline', `#10 Go Offline during the status reads makes Go Online report cancelled, not online (${err2 ? err2.message : 'resolved'})`);
    }

    // ── #6: one poll loop per editor across a fast Go Offline/Online ─────────────────────────────
    {
        const plc = createFakePlc({ symbols: { 'MAIN.a': { type: 'INT', value: 1 } } });
        const delays = {};
        const session = createOnlineSession({ createClient: slowable(plc, delays), statusIntervalMs: 100000 });
        const m = createInlineMonitor({ session, post: () => {}, intervalMs: () => 50 });
        const occ = [{ componentId: 'c', pane: 'impl', line: 1, startColumn: 1, endColumn: 2, eol: false, adsPath: 'MAIN.a', localType: 'INT' }];
        await session.connect(ROUTER);
        await m.setOccurrences(occ);
        m.start();
        delays.readRawMulti = 40;
        await tick(60); // a scheduled tick is now in flight
        await session.disconnect();
        m.stop();
        delays.readRawMulti = 0;
        await session.connect(ROUTER);
        await m.setOccurrences(occ);
        m.start();
        await tick(100);
        const before = plc.sumReads;
        await tick(1000);
        const n = plc.sumReads - before;
        assert(n <= 24, `#6 a 50 ms poll reads about 20 times a second after a fast reconnect, not twice that (${n})`);
        m.dispose();
        await session.disconnect();
    }

    // ── #16: values come back after an edit when the PLC values have not changed ────────────────
    {
        const plc = createFakePlc({ symbols: { 'MAIN.a': { type: 'INT', value: 1 } } });
        const session = createOnlineSession({ createClient: plc.createClient, statusIntervalMs: 100000 });
        const posts = [];
        const m = createInlineMonitor({ session, post: (msg) => posts.push(msg), intervalMs: () => 100000 });
        const occ = [{ componentId: 'c', pane: 'impl', line: 1, startColumn: 1, endColumn: 2, eol: false, adsPath: 'MAIN.a', localType: 'INT' }];
        await session.connect(ROUTER);
        await m.setOccurrences(occ);
        await m.setOccurrences(occ); // the webview cleared its values after an edit and asked again
        assert(posts.filter(p => p.type === 'online/values' && p.items.length === 1).length === 2,
            `#16 every request from the webview is answered, even with the same values (${posts.length} posts)`);
        m.dispose();
        await session.disconnect();
    }

    // ── #8 / #9: the watch list's notification slots ─────────────────────────────────────────────
    {
        const plc = createFakePlc({ symbols: { 'MAIN.a': { type: 'INT', value: 1 } } });
        const session = createOnlineSession({ createClient: slowable(plc, { subscribeRaw: 20 }), statusIntervalMs: 100000 });
        const w = createWatchList({ session, load: () => [], save: () => {} });
        await session.connect(ROUTER);
        const a1 = w.add('MAIN.a');
        await tick(5);
        await w.remove('MAIN.a');
        const a2 = w.add('MAIN.a');
        await a1; await a2;
        await tick(30);
        assert(w.size === 1 && session.subscriptionCount === 1 && plc.notifications.size === 1,
            `#8 remove and re-add while a subscribe is in flight keeps one notification (${session.subscriptionCount}, ${plc.notifications.size})`);
        await w.remove('MAIN.a');
        await tick(10);
        assert(session.subscriptionCount === 0 && plc.notifications.size === 0, `#8 and removing it frees it (${session.subscriptionCount}, ${plc.notifications.size})`);
        await w.dispose();
        await session.disconnect();
    }
    {
        const plc = createFakePlc({ symbols: { 'MAIN.a': { type: 'INT', value: 1 }, 'MAIN.b': { type: 'INT', value: 2 }, 'MAIN.c': { type: 'INT', value: 3 } } });
        let max = 1;
        const session = createOnlineSession({ createClient: plc.createClient, maxNotifications: () => max, statusIntervalMs: 100000 });
        const w = createWatchList({ session, load: () => [{ path: 'MAIN.a' }, { path: 'MAIN.b' }, { path: 'MAIN.c' }], save: () => {} });
        await session.connect(ROUTER);
        await waitFor(() => w.list().every(r => r.state !== 'pending'));
        await w.remove('MAIN.a');
        await waitFor(() => w.list()[0].state === 'ok', 500);
        assert(w.list()[0].state === 'ok' && w.list()[1].state === 'capped' && session.subscriptionCount === 1,
            `#9 a freed slot goes to the first capped entry (${w.list().map(r => r.path + ':' + r.state)})`);
        max = 5;
        if (typeof w.retryCapped === 'function') await w.retryCapped();
        await waitFor(() => w.list()[1].state === 'ok', 500);
        assert(w.list()[1].state === 'ok' && session.subscriptionCount === 2, `#9 a raised limit subscribes the capped entries (${w.list().map(r => r.path + ':' + r.state)})`);
        await w.dispose();
        await session.disconnect();
    }

    // ── #11: the user-mode-runtime hint covers every router rejection on the connect step ────────
    {
        const o = { mode: 'router', routerAddress: '127.0.0.1', targetAmsNetId: 'localhost', targetAdsPort: 851 };
        for (const raw of ['connectToTarget(): Connecting to 127.0.0.1:48898 failed - socket ended by remote (is the ADS port "0" already in use?)',
            'connectToTarget(): Connecting to 127.0.0.1:48898 failed - socket ended by remote',
            'connectToTarget(): Connecting to 127.0.0.1:48898 failed - socket closed by remote (hadError: false)',
            'connectToTarget(): Connecting to 127.0.0.1:48898 failed - No response from target in 2000 ms (timeout)']) {
            const f = describeConnectError(Object.assign(new Error(raw), { trace: [raw] }), o);
            assert(f.hint && f.hint.includes(USER_MODE_HINT) && !/route exists on BOTH sides/.test(f.hint),
                `#11 "${raw.replace(/^.*failed - /, '')}" carries the user-mode-runtime hint (${f.kind})`);
        }
    }
}

// ── #5: ads-client restores subscriptions itself; the adapter must not leak them ─────────────────────
async function adapterRestore() {
    const ADS = require('ads-client/dist/ads-commons.js');
    const { Client } = require('ads-client');
    const plcHandles = new Set();
    let next = 1;
    let deleteFailures = 0;
    class FakeClient extends Client {
        constructor(s) { super(s); FakeClient.last = this; this.connection.connected = true; this.metaData.plcSymbolVersion = 1; }
        async sendAdsCommand(cmd) {
            const addr = { amsNetId: '1.1.1.1.1.1', adsPort: 851 };
            if (cmd.adsCommand === ADS.ADS_COMMAND.AddNotification) { const h = next++; plcHandles.add(h); return { ams: { sourceAmsAddress: addr }, ads: { payload: { notificationHandle: h } } }; }
            if (cmd.adsCommand === ADS.ADS_COMMAND.DeleteNotification) {
                const h = cmd.payload.readUInt32LE(0);
                if (!plcHandles.delete(h)) { deleteFailures++; throw new Error('bad handle ' + h); }
                return { ads: {} };
            }
            throw new Error('unexpected ADS command ' + cmd.adsCommand);
        }
        async readPlcUploadInfo() {}
    }
    const port = createAdsClient({ ...ROUTER, targetAmsNetId: '1.1.1.1.1.1' }, { Client: FakeClient });
    const raw = FakeClient.last;
    const N = 20;
    let handles = [];
    const subscribeAll = async () => {
        handles = [];
        for (let i = 0; i < N; i++) handles.push(await port.subscribeRaw({ indexGroup: 0x4040, indexOffset: i, size: 2 }, 200, () => {}));
    };
    const active = () => Object.values(raw.activeSubscriptions).reduce((a, o) => a + Object.values(o).filter(s => !s.internal).length, 0);
    /** What the session and the watch list do on 'symbols': drop every handle, subscribe again. */
    const resubscribe = async () => { await Promise.all(handles.map(h => h.unsubscribe().catch(() => {}))); await subscribeAll(); };
    await subscribeAll();
    for (let round = 0; round < 3; round++) {
        const seen = new Promise(r => port.on('symbolVersion', r));
        await raw.onPlcSymbolVersionChanged({ value: Buffer.from([round + 2]) });
        await seen;
        await tick(5);
        await resubscribe();
    }
    assert(plcHandles.size === N && active() === N, `#5 three downloads leave ${N} notifications on the PLC, not more (${plcHandles.size} on the PLC, ${active()} active)`);
    // An auto-reconnect: the library backs up, reconnects (the PLC dropped the old notifications) and restores.
    const seen = new Promise(r => port.on('reconnect', r));
    await raw.backupSubscriptions(false);
    plcHandles.clear();
    raw.activeSubscriptions = {};
    await raw.restoreSubscriptions();
    raw.emit('reconnect', true, []);
    await seen;
    await tick(5);
    const stale = deleteFailures;
    await resubscribe();
    assert(plcHandles.size === N && active() === N, `#5 a reconnect leaves ${N} notifications, not more (${plcHandles.size})`);
    assert(deleteFailures === stale, `#5 a stale handle never sends a DeleteNotification (which could hit a reused handle) (${deleteFailures - stale})`);
}

// ── #12: Go Offline during an in-flight auto-reconnect leaves no client that reconnects ──────────────
async function orphanReconnect() {
    const { Client } = require('ads-client');
    const sockets = [];
    const server = net.createServer(s => { sockets.push(s); s.on('error', () => {}); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const portNum = /** @type {any} */ (server.address()).port;
    let raw = null;
    class C extends Client { constructor(st) { super({ ...st, rawClient: true, reconnectInterval: 100 }); raw = this; } }
    const port = createAdsClient({ mode: 'direct', routerAddress: '127.0.0.1', routerTcpPort: portNum, localAmsNetId: '1.2.3.4.1.1',
        localAdsPort: 30000, targetAmsNetId: '5.6.7.8.1.1', targetAdsPort: 851 }, { Client: C });
    await port.connect();
    const orig = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...a) { setTimeout(() => orig.apply(this, a), 400); return this; };
    try {
        sockets[0].destroy();           // the link is lost; a reconnect attempt starts after 100 ms
        await tick(200);                // ...and is in flight
        await port.disconnect();        // Go Offline
        await tick(1000);
        const alive = sockets.filter(s => !s.destroyed && !s.readableEnded).length;
        assert(!(raw.connection && raw.connection.connected) && alive === 0,
            `#12 after Go Offline, a reconnect that lands is closed again (connected ${raw.connection && raw.connection.connected}, sockets ${alive})`);
    } finally {
        net.Socket.prototype.connect = orig;
        try { await raw.disconnect(true); } catch (e) { /* already closed */ }
        for (const s of sockets) s.destroy();
        server.close();
    }
}

// ── #13 / #14: unqualified names never fall back to a same-named GVL variable on uncertainty ─────────
function paths() {
    const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
    const { indexXmlObject } = require('../src/lsp/xmlIndexer');
    const { provideOnlinePaths } = require('../src/lsp/features');
    const syn = (kind, name, decl) => indexXmlObject(getWorkspaceSymbolIndex(),
        `<?xml version="1.0" encoding="utf-8"?>\n<TcPlcObject Version="1.1.0.1">\n<${kind} Name="${name}" Id="{00000000-0000-0000-0000-000000000000}">` +
        `<Declaration><![CDATA[${decl}]]></Declaration></${kind}>\n</TcPlcObject>`, `file:///syn/${name}.Tc${kind}`);
    const run = (code, uri) => {
        parseAndIndexDocument(code, uri);
        const lines = code.split('\n').length;
        return provideOnlinePaths(code, [{ pane: 'impl', start: 0, end: lines }], getWorkspaceSymbolIndex(), uri).occurrences;
    };

    clearWorkspaceIndex();
    syn('GVL', 'GVL_Open', 'VAR_GLOBAL\n\tbBusy : BOOL;\n\tAuto : BOOL;\n\tnFree : INT;\nEND_VAR\n');
    const fbUnknown = run('FUNCTION_BLOCK FB_Lib EXTENDS FB_LibraryBase\nVAR\n\tx : INT;\nEND_VAR\nIF bBusy THEN\n\tx := 2;\nEND_IF\nEND_FUNCTION_BLOCK', 'file:///syn/FB_Lib.TcPOU');
    const o1 = fbUnknown.find(o => o.text === 'bBusy');
    assert(!o1 || !o1.path, `#13 a name in an FB whose base is unknown is not mapped to a GVL variable (${o1 && o1.path})`);
    getWorkspaceSymbolIndex().FB_ExtBase = { name: 'FB_ExtBase', type: 'FUNCTION_BLOCK', external: true, variables: [{ name: 'bBusy', type: 'BOOL' }], methods: [], properties: [], actions: [], extendsAll: [] };
    const fbExt = run('FUNCTION_BLOCK FB_Lib2 EXTENDS FB_ExtBase\nVAR\n\tx : INT;\nEND_VAR\nIF bBusy THEN\n\tx := 2;\nEND_IF\nEND_FUNCTION_BLOCK', 'file:///syn/FB_Lib2.TcPOU');
    const o2 = fbExt.find(o => o.text === 'bBusy');
    assert(!o2 || !o2.path, `#13 nor in an FB that extends a library FB (${o2 && o2.path})`);
    const fbCond = run('FUNCTION_BLOCK FB_C {IF defined(X)} EXTENDS FB_Somewhere {END_IF}\nVAR\n\tx : INT;\nEND_VAR\nIF bBusy THEN\n\tx := 2;\nEND_IF\nEND_FUNCTION_BLOCK', 'file:///syn/FB_C.TcPOU');
    const o3 = fbCond.find(o => o.text === 'bBusy');
    assert(!o3 || !o3.path, `#13 nor when EXTENDS depends on a define (${o3 && o3.path})`);
    const prg = run('PROGRAM P_Ok\nVAR\n\tb : BOOL;\nEND_VAR\nb := nFree > 0;\nEND_PROGRAM', 'file:///syn/P_Ok.TcPOU');
    const o4 = prg.find(o => o.text === 'nFree');
    assert(o4 && o4.path === 'GVL_Open.nFree', `#13 a fully resolved scope still maps a unique global of a non-qualified GVL (${o4 && o4.path})`);

    clearWorkspaceIndex();
    syn('GVL', 'GVL_Io', "{attribute 'qualified_only'}\nVAR_GLOBAL\n\tAuto : BOOL;\n\tbStart : BOOL;\nEND_VAR\n");
    syn('DUT', 'E_Mode', 'TYPE E_Mode :\n(\n\tManual := 0,\n\tAuto := 1\n);\nEND_TYPE\n');
    const p = run('PROGRAM P\nVAR\n\teMode : E_Mode;\n\tb : BOOL;\nEND_VAR\nb := eMode = Auto;\nb := bStart;\nb := GVL_Io.bStart;\nEND_PROGRAM', 'file:///syn/P.TcPOU');
    const auto = p.find(o => o.text === 'Auto');
    const start = p.find(o => o.text === 'bStart');
    const qual = p.find(o => o.text === 'GVL_Io.bStart');
    assert(!auto || !auto.path, `#14 an enum value is never mapped to a qualified_only GVL's variable (${auto && auto.path})`);
    assert(!start || !start.path, `#14 an unqualified name never maps into a qualified_only GVL (${start && start.path})`);
    assert(qual && qual.path === 'GVL_Io.bStart', '#14 the qualified form still maps');
    clearWorkspaceIndex();
    syn('GVL', 'GVL_Open2', 'VAR_GLOBAL\n\tAuto : BOOL;\nEND_VAR\n');
    syn('DUT', 'E_Mode', 'TYPE E_Mode :\n(\n\tManual := 0,\n\tAuto := 1\n);\nEND_TYPE\n');
    const p2 = run('PROGRAM P2\nVAR\n\teMode : E_Mode;\n\tb : BOOL;\nEND_VAR\nb := eMode = Auto;\nEND_PROGRAM', 'file:///syn/P2.TcPOU');
    const auto2 = p2.find(o => o.text === 'Auto');
    assert(!auto2 || !auto2.path, `#14 a name that is also an enumerator is not mapped to a global (${auto2 && auto2.path})`);
    clearWorkspaceIndex();
}

// ── Review round 2 (2026-11-13), session and watch level: R2#2, R2#3 ────────────────────────────────
async function round2Lifecycle() {
    // ── R2#2: a Cancel during Go Online's status phase leaves nothing a later connection reads ─────
    {
        // PLC A: MAIN.x at offset 16. PLC B: MAIN.pad at 16 (999), MAIN.x at 32 (222).
        const A = createFakePlc({ symbols: { 'MAIN.x': { type: 'INT', value: 111 } } });
        const B = createFakePlc({ symbols: { 'MAIN.pad': { type: 'INT', value: 999 }, 'MAIN.x': { type: 'INT', value: 222 } } });
        let which = A;
        const session = createOnlineSession({ createClient: (o) => (which === A ? slowable(A, { readValue: 50, readPlcState: 50 }) : B.createClient)(o), statusIntervalMs: 100000 });
        const w = createWatchList({ session, load: () => [], save: () => {} });
        let fire = () => {};
        const tok = { isCancellationRequested: false, onCancellationRequested: (f) => { fire = f; return { dispose() {} }; } };
        const p = session.connect({ ...ROUTER, targetAmsNetId: '1.1.1.1.1.1' }, tok).catch(e => e);
        await tick(10);
        await w.add('MAIN.x', 'INT');           // PLC Watch "Add" while "Going online" is still reading the status
        await session.resolve('MAIN.x');
        tok.isCancellationRequested = true;
        fire();
        await p;
        which = B;
        await session.connect({ ...ROUTER, targetAmsNetId: '2.2.2.2.1.1' });
        const r = await session.resolve('MAIN.x');
        const v = (await session.readMany([r])).get('MAIN.x');
        assert(r.ok && r.symbol.indexOffset === B.symbols.get('main.x').indexOffset && v && v.value === 222,
            `R2#2 after a Cancel in the status phase, the next PLC's MAIN.x is resolved on that PLC (offset ${r.symbol && r.symbol.indexOffset}, value ${v && v.value})`);
        await w.dispose();
        await session.disconnect();
    }
    {
        // A resolve still in flight on the cancelled client must not land in the next connection's cache.
        const A = createFakePlc({ symbols: { 'MAIN.x': { type: 'INT', value: 111 } } });
        const B = createFakePlc({ symbols: { 'MAIN.pad': { type: 'INT', value: 999 }, 'MAIN.x': { type: 'INT', value: 222 } } });
        let which = A;
        const session = createOnlineSession({ createClient: (o) => (which === A ? slowable(A, { readValue: 50, readPlcState: 50, getSymbol: 30 }) : B.createClient)(o), statusIntervalMs: 100000 });
        let fire = () => {};
        const tok = { isCancellationRequested: false, onCancellationRequested: (f) => { fire = f; return { dispose() {} }; } };
        const p = session.connect({ ...ROUTER, targetAmsNetId: '1.1.1.1.1.1' }, tok).catch(e => e);
        await tick(10);
        const late = session.resolve('MAIN.x');
        tok.isCancellationRequested = true;
        fire();
        await p;
        which = B;
        await session.connect({ ...ROUTER, targetAmsNetId: '2.2.2.2.1.1' });
        await late;
        const r = await session.resolve('MAIN.x');
        assert(r.ok && r.symbol.indexOffset === B.symbols.get('main.x').indexOffset,
            `R2#2 a resolve that finishes on the cancelled client is not served to the next one (offset ${r.symbol && r.symbol.indexOffset})`);
        await session.disconnect();
    }

    // ── R2#3: watch attach() never overwrites a slot that holds a live handle ─────────────────────
    {
        // (1) "Add" during the status phase, then the 'state' event attaches every entry again.
        const A = createFakePlc({ symbols: { 'MAIN.x': { type: 'INT', value: 1 }, 'MAIN.y': { type: 'INT', value: 2 } } });
        const session = createOnlineSession({ createClient: slowable(A, { readValue: 30 }), statusIntervalMs: 100000, maxNotifications: () => 2 });
        const w = createWatchList({ session, load: () => [{ path: 'MAIN.y', localType: 'INT' }], save: () => {} });
        const p = session.connect(ROUTER);
        await tick(5);
        await w.add('MAIN.x', 'INT');
        await p;
        await waitFor(() => w.list().every(r => r.state !== 'pending'), 500);
        await tick(50);
        assert(w.list().every(r => r.state === 'ok') && session.subscriptionCount === 2 && A.notifications.size === 2,
            `R2#3 an Add during the status phase leaves one notification per entry (${w.list().map(r => r.path + ':' + r.state)}, subs ${session.subscriptionCount}, plc ${A.notifications.size})`);
        await w.remove('MAIN.x'); await w.remove('MAIN.y'); await tick(20);
        assert(session.subscriptionCount === 0 && A.notifications.size === 0, `R2#3 and removing every entry frees every notification (${session.subscriptionCount}, ${A.notifications.size})`);
        await w.dispose();
        await session.disconnect();
    }
    {
        // (2) Remove and re-add an entry while attachAll still waits on an earlier one.
        const A = createFakePlc({ symbols: { 'MAIN.a': { type: 'INT', value: 1 }, 'MAIN.x': { type: 'INT', value: 2 } } });
        const mk = (o) => { const c = A.createClient(o); const gs = c.getSymbol; c.getSymbol = async (pth) => { if (/main\.a/i.test(pth)) await tick(80); return gs(pth); }; return c; };
        const session = createOnlineSession({ createClient: mk, statusIntervalMs: 100000 });
        const w = createWatchList({ session, load: () => [{ path: 'MAIN.a', localType: 'INT' }, { path: 'MAIN.x', localType: 'INT' }], save: () => {} });
        await session.connect(ROUTER);
        await tick(5);
        await w.remove('MAIN.x');
        await w.add('MAIN.x', 'INT');
        await tick(300);
        assert(w.size === 2 && session.subscriptionCount === 2 && A.notifications.size === 2,
            `R2#3 re-adding during attachAll keeps one notification per entry (subs ${session.subscriptionCount}, plc ${A.notifications.size})`);
        await w.remove('MAIN.a'); await w.remove('MAIN.x'); await tick(50);
        assert(session.subscriptionCount === 0 && A.notifications.size === 0, `R2#3 and removing both frees both (${session.subscriptionCount}, ${A.notifications.size})`);
        await w.dispose();
        await session.disconnect();
    }
    {
        // (3) Two 'symbols' events while the first detach waits on slow DeleteNotifications.
        const A = createFakePlc({ symbols: { 'MAIN.a': { type: 'INT', value: 1 }, 'MAIN.b': { type: 'INT', value: 2 } } });
        let cl;
        const mk = (o) => { const c = A.createClient(o); cl = c; const sr = c.subscribeRaw;
            c.subscribeRaw = async (...a) => { const s = await sr(...a); return { unsubscribe: async () => { await tick(100); return s.unsubscribe(); } }; }; return c; };
        const session = createOnlineSession({ createClient: mk, statusIntervalMs: 100000 });
        const w = createWatchList({ session, load: () => [{ path: 'MAIN.a', localType: 'INT' }, { path: 'MAIN.b', localType: 'INT' }], save: () => {} });
        await session.connect(ROUTER);
        await tick(50);
        A.appInfo.OnlineChangeCnt++;
        session.refreshStatus();
        await tick(20);
        cl.fire('symbolVersion');
        await tick(600);
        assert(w.size === 2 && session.subscriptionCount === 2 && A.notifications.size === 2,
            `R2#3 two quick symbol drops leave one notification per entry (subs ${session.subscriptionCount}, plc ${A.notifications.size})`);
        await w.remove('MAIN.a'); await w.remove('MAIN.b'); await tick(300);
        assert(session.subscriptionCount === 0 && A.notifications.size === 0, `R2#3 and removing both frees both (${session.subscriptionCount}, ${A.notifications.size})`);
        await w.dispose();
        await session.disconnect();
    }

    // ── R2#1 (store level): a BOM does not change the fingerprint; a guard read never deletes ─────
    {
        const { createPendingEditsStore, fingerprintOf } = require('../src/pendingEditsStore');
        const m = new Map();
        const store = createPendingEditsStore({ get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); return Promise.resolve(); } });
        const disk = '\uFEFF<?xml version="1.0"?>\n<TcPlcObject/>\n';
        assert(fingerprintOf(disk) === fingerprintOf(disk.slice(1)), 'R2#1 a leading BOM does not change the fingerprint (the disk text and VS Code\'s document text agree)');
        await store.set('file:///a.TcPOU', { root_impl: { content: 'x := 1;' } }, disk.slice(1));
        const seen = typeof store.peek === 'function' ? store.peek('file:///a.TcPOU', 'something else') : null;
        await tick(5);
        assert(seen && seen.stale === true && store.uris().includes('file:///a.TcPOU'),
            `R2#1 a non-destructive read reports a stale stash and keeps it (${JSON.stringify(seen)}, ${store.uris()})`);
    }
}

// ── R2#5 / R2#6: a GVL's declaration pane maps every name to its own variable ─────────────────────────
function round2Paths() {
    const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
    const { indexXmlObject } = require('../src/lsp/xmlIndexer');
    const { provideOnlinePaths } = require('../src/lsp/features');
    const { parseTwinCatXml } = require('../src/xmlParser');
    const { convertXmlToSt } = require('../src/stConverter');
    const xml = (name, decl) => `<?xml version="1.0" encoding="utf-8"?>\n<TcPlcObject Version="1.1.0.1">\n<GVL Name="${name}" Id="{00000000-0000-0000-0000-000000000001}">\n` +
        `<Declaration><![CDATA[${decl}]]></Declaration>\n</GVL>\n</TcPlcObject>`;
    const declOccurrences = (x, uri) => {
        const { stText, lineMap } = convertXmlToSt(parseTwinCatXml(x), { raw: true });
        const ranges = [];
        for (const id of Object.keys(lineMap)) { const lm = lineMap[id]; if (lm.decl) ranges.push({ pane: 'decl', start: lm.decl.start - 1, end: lm.decl.end - 1 }); }
        parseAndIndexDocument(stText, uri);
        return { stText, occ: provideOnlinePaths(stText, ranges, getWorkspaceSymbolIndex(), uri).occurrences };
    };
    clearWorkspaceIndex();
    const vars = Array.from({ length: 10 }, (_, i) => `v${String(i + 1).padStart(2, '0')}`);
    const decl = "{attribute 'qualified_only'}\nVAR_GLOBAL\n" + vars.map(v => `\t${v} : INT;\n`).join('') + 'END_VAR\n';
    const uri = 'file:///syn/GVL_Ten.TcGVL';
    const x = xml('GVL_Ten', decl);
    indexXmlObject(getWorkspaceSymbolIndex(), x, uri);
    declOccurrences(x, uri);                       // the editor syncs on open...
    declOccurrences(x, uri);                       // ...and on every request after it
    const { stText, occ } = declOccurrences(x, uri);
    const lines = stText.split('\n');
    const wrong = occ.filter(o => lines[o.line].slice(o.start, o.end).toLowerCase() !== String(o.path).split('.').pop().toLowerCase());
    const keys = occ.map(o => `${o.line}:${o.start}`);
    assert(occ.length === 10 && wrong.length === 0 && new Set(keys).size === keys.length,
        `R2#5 every declaration-pane occurrence of a long GVL sits on its own name, once (${occ.length} occurrences, ${wrong.length} misplaced: ${wrong.slice(0, 3).map(o => `${JSON.stringify(lines[o.line].trim())}->${o.path}`)})`);
    const vcount = getWorkspaceSymbolIndex().GVL_Ten.variables.length;
    assert(vcount === 10, `R2#5 re-syncing the GVL does not grow its variable list (${vcount})`);

    // R2#6: qualifiedOnly follows the editor's text (an unsaved pragma edit), not only the file on disk.
    clearWorkspaceIndex();
    const qDisk = xml('GVL_Q', "{attribute 'qualified_only'}\nVAR_GLOBAL\n\tnQ : INT;\nEND_VAR\n");
    indexXmlObject(getWorkspaceSymbolIndex(), qDisk, 'file:///syn/GVL_Q.TcGVL');
    declOccurrences(xml('GVL_Q', 'VAR_GLOBAL\n\tnQ : INT;\nEND_VAR\n'), 'file:///syn/GVL_Q.TcGVL');
    const afterRemove = getWorkspaceSymbolIndex().GVL_Q.qualifiedOnly;
    const oDisk = xml('GVL_O', 'VAR_GLOBAL\n\tnO : INT;\nEND_VAR\n');
    indexXmlObject(getWorkspaceSymbolIndex(), oDisk, 'file:///syn/GVL_O.TcGVL');
    declOccurrences(xml('GVL_O', "{attribute 'qualified_only'}\nVAR_GLOBAL\n\tnO : INT;\nEND_VAR\n"), 'file:///syn/GVL_O.TcGVL');
    const afterAdd = getWorkspaceSymbolIndex().GVL_O.qualifiedOnly;
    assert(afterRemove === false && afterAdd === true, `R2#6 qualifiedOnly follows an unsaved pragma edit (removed: ${afterRemove}, added: ${afterAdd})`);
    clearWorkspaceIndex();
}

// ── R3#1: a symbol rebuilt under the same type name and size, but another base type ──────────────
async function round3Guard() {
    /** Runs one write while `rebuild` replaces MAIN.v during the value box; returns the result and the PLC. */
    const writeAcross = async (before, after, typed) => {
        const plc = createFakePlc({ symbols: { 'MAIN.v': { type: before.name, value: 0, dataType: before } } });
        const session = createOnlineSession({ createClient: plc.createClient, statusIntervalMs: 100000 });
        await session.connect(ROUTER);
        const cl = plc.clients[plc.clients.length - 1];
        const g = guardDeps(session, { input: async () => {
            plc.removeSymbol('MAIN.v');
            plc.addSymbol('MAIN.v', { type: after.name, value: 0, dataType: after });
            cl.fire('symbolVersion');
            return typed;
        } });
        g.sessionWrites.enabled = true;
        g.sessionWrites.identity = session.identity;
        const r = await performWrite({ path: 'MAIN.v', localType: before.name, source: 'watch', stillValid: () => null }, g.deps);
        await session.disconnect();
        return { r, plc, log: g.log };
    };
    // An alias of REAL rebuilt as an alias of DINT: same name, same 4 bytes, so the layout check passes.
    let x = await writeAcross(dataType('T_Ratio', { type: 'REAL', size: 4 }), dataType('T_Ratio', { type: 'DINT', size: 4 }), '1.5');
    assert(x.r.status === 'refused' && x.plc.writes.length === 0,
        `R3#1 a value parsed for REAL is not written once the same-named alias is DINT (${x.r.status}: ${x.r.message}; writes ${JSON.stringify(x.plc.writes)})`);
    assert(x.log.some(l => /Write refused/.test(l)), 'R3#1 and the refusal is logged');
    // Same name, same size, an enum whose members changed: 'Running' no longer means what was typed.
    x = await writeAcross(dataType('E_Mode', { size: 2, enumInfos: [{ name: 'Idle', value: 0 }, { name: 'Running', value: 1 }] }),
        dataType('E_Mode', { size: 2, enumInfos: [{ name: 'Idle', value: 0 }, { name: 'Running', value: 2 }] }), 'Running');
    assert(x.r.status === 'refused' && x.plc.writes.length === 0,
        `R3#1 an enum value is not written once the same-named enum's members changed (${x.r.status}: ${x.r.message})`);
    // Nothing changed but a download happened: the write still goes through.
    x = await writeAcross(dataType('T_Ratio', { type: 'REAL', size: 4 }), dataType('T_Ratio', { type: 'REAL', size: 4 }), '1.5');
    assert(x.r.status === 'written' && x.plc.writes.length === 1 && x.plc.get('MAIN.v') === 1.5,
        `R3#1 an unchanged symbol is still written after a download (${x.r.status}: ${x.r.message})`);
}

// ── The command layer: #1, #2, #3, #4, #19 ─────────────────────────────────────────────────────────
async function commandLevel() {
    if (!fs.existsSync(MAIN)) { console.log('SKIP: sample/ is missing: the command-level regressions did not run.'); return false; }
    const { indexXmlObject } = require('../src/lsp/xmlIndexer');
    const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
    const { provideOnlinePaths } = require('../src/lsp/features');
    const { createPendingEditsStore } = require('../src/pendingEditsStore');
    const { parseTmcSymbols } = require('../src/online/codeIdentity');
    clearWorkspaceIndex();
    const fileUri = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
    const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '_Libraries') walk(f, o); } else if (/\.Tc(POU|GVL|DUT)$/.test(e.name)) o.push(f); } return o; };
    const sampleFiles = walk(SAMPLE);
    for (const f of sampleFiles) indexXmlObject(getWorkspaceSymbolIndex(), fs.readFileSync(f, 'utf8'), fileUri(f));
    handlers.set('twincat.lsp.queryOnlinePaths', async (p) => {
        parseAndIndexDocument(p.code, p.fileUri);
        return provideOnlinePaths(p.code, p.ranges, getWorkspaceSymbolIndex(), p.fileUri);
    });
    const TMC = path.join(SAMPLE, 'TcToolkitSample_PLC.tmc');
    const symbols = {};
    for (const s of parseTmcSymbols(fs.readFileSync(TMC, 'utf8')).values()) {
        symbols[s.name] = { type: s.array ? `ARRAY OF ${s.baseType}` : s.baseType, size: s.bytes, value: s.name === 'GVL_Hmi.nSpeed' ? 50 : 0 };
    }
    const plc = createFakePlc({ symbols });
    const BUILD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_online_regr_'));
    fs.copyFileSync(TMC, path.join(BUILD_DIR, 'TcToolkitSample_PLC.tmc'));
    fs.copyFileSync(TMC, path.join(BUILD_DIR, 'OtherProject_PLC.tmc'));   // a second project, same layout (R2#0)
    const memento = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); return Promise.resolve(); } }; };
    const context = { subscriptions: [], workspaceState: memento(), globalState: memento(), extensionUri: { fsPath: REPO } };
    const project = { name: 'TcToolkitSample_PLC', dir: BUILD_DIR, objectFiles: new Map(sampleFiles.map(f => [f.toLowerCase(), f])) };
    const other = { name: 'OtherProject_PLC', dir: BUILD_DIR, objectFiles: new Map() };
    let mainOwners = ['a'];
    const projectMap = { projects: new Map([['a', project], ['b', other]]), ownersOf: (p) => (p === MAIN ? mainOwners : (sampleFiles.includes(p) ? ['a'] : [])) };
    const posts = new Map();
    const store = createPendingEditsStore(memento());
    const provider = { activePanels: new Map(), pendingEditsStore: store, broadcastOnlineState() {} };
    const doc = (file) => {
        const uri = { fsPath: file, toString: () => fileUri(file) };
        posts.set(uri.toString(), []);
        provider.activePanels.set(uri.toString(), { webview: { postMessage: (m) => { posts.get(uri.toString()).push(m); return Promise.resolve(true); } } });
        return { uri, isDirty: false, getText: () => fs.readFileSync(file, 'utf8') };
    };
    const lastState = (d) => { const list = posts.get(d.uri.toString()).filter(m => m.type === 'online/state'); return list[list.length - 1]; };
    const delays = {};
    const { registerOnlineCommands } = require('../src/commands/onlineCommands');
    // The inline monitors' timers, counted (R2#4).
    const monitorTimers = { fired: 0, setTimeout: (fn, ms) => setTimeout(() => { monitorTimers.fired++; fn(); }, ms), clearTimeout };
    const api = registerOnlineCommands(context, { provider, getProjectMap: () => projectMap, createClient: slowable(plc, delays), timers: monitorTimers });
    const run = (id, ...a) => vscodeStub.commands.executeCommand(id, ...a);

    // ── #19: a workspace's settings cannot turn writes on ─────────────────────────────────────────
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const sec = [].concat(pkg.contributes.configuration).find(s => s.id === 'tcToolkit.online');
    const scope = sec && sec.properties['tcToolkit.online.allowWrites'].scope;
    assert(scope === 'application' || scope === 'machine', `#19 tcToolkit.online.allowWrites is a user-only setting (scope ${scope})`);

    let r = await run('twincat.goOnline', { netId: 'localhost', label: 'Local runtime' });
    await api.refreshCodeCheck();
    assert(r.status === 'online' && api.codeCheck() && api.codeCheck().state === 'match', `online, code check passed (${api.codeCheck() && api.codeCheck().reason})`);
    await run('twincat.watch.add', { path: 'GVL_Hmi.nSpeed' });
    await waitFor(() => api.watch.list()[0].state === 'ok');
    const watchRow = () => trees.get('twincatWatch').getChildren()[0];

    settings.workspace['tcToolkit.online.allowWrites'] = true;
    answers.message.push(undefined);
    r = await run('twincat.watch.write', watchRow());
    assert(r.status === 'refused' && /allowWrites/.test(r.message) && plc.writes.length === 0,
        `#19 allowWrites set by the workspace's .vscode/settings.json alone is ignored (${r.status})`);
    delete settings.workspace['tcToolkit.online.allowWrites'];
    settings.user['tcToolkit.online.allowWrites'] = true;

    // ── #3: an editor that reported while online does not count as unsaved ──────────────────────
    const mainDoc = doc(MAIN);
    const mainMsg = { componentId: 'root', fileUri: mainDoc.uri.toString(), visible: { decl: [{ start: 1, end: 20 }], impl: [{ start: 1, end: 30 }] } };
    await provider.onlineSource.visible(mainDoc.uri.toString(), mainDoc, mainMsg);
    answers.message.push('Enable writes', 'Write');
    answers.input.push('51');
    r = await run('twincat.watch.write', watchRow());
    assert(r.status === 'written' && plc.get('GVL_Hmi.nSpeed') === 51, `#3 an open editor with nothing unsaved does not block writes (${r.status}: ${r.message})`);

    // ── #1: writes only from editors of the project the PLC runs ─────────────────────────────────
    assert(lastState(mainDoc) && lastState(mainDoc).writable === true, `#1 an editor of the bound project is told it may write (${JSON.stringify(lastState(mainDoc))})`);
    mainOwners = ['b'];
    await provider.onlineSource.visible(mainDoc.uri.toString(), mainDoc, mainMsg);
    assert(lastState(mainDoc) && lastState(mainDoc).writable === false, '#1 an editor of another project is told it may not (the Write action is not offered)');
    const writesBefore = plc.writes.length;
    const modalsBefore = calls.modals.length;
    answers.message.push(undefined, 'Write', 'Write');
    answers.input.push('77');
    r = await provider.onlineSource.write(mainDoc.uri.toString(), mainDoc, { componentId: 'root', pane: 'impl', position: { lineNumber: 10, column: 3 }, fileUri: mainDoc.uri.toString() });
    assert(plc.writes.length === writesBefore && calls.modals.length === modalsBefore && (!r || r.status === 'refused'),
        `#1 a write from an editor of another project is refused before any dialog (${r && r.status})`);
    answers.message.length = 0; answers.input.length = 0;
    mainOwners = ['a'];

    // ── #4: Manual Sync edits stashed for a closed editor block writes ───────────────────────────
    provider.onlineSource.panelClosed(mainDoc.uri.toString());
    await store.set(mainDoc.uri.toString(), { root_impl: { content: 'x := 1;' } }, mainDoc.getText());
    answers.message.push(undefined, 'Write');
    answers.input.push('52');
    r = await run('twincat.watch.write', watchRow());
    assert(r.status === 'refused' && /unsaved edits/.test(r.message) && plc.get('GVL_Hmi.nSpeed') === 51,
        `#4 a Manual Sync stash of a closed editor blocks writes (${r.status}: ${r.message})`);
    answers.message.length = 0; answers.input.length = 0;
    await store.delete(mainDoc.uri.toString());

    // ── #2: a superseded code check never leaves a stale 'match' ─────────────────────────────────
    const cl = plc.clients[plc.clients.length - 1];
    delays.getSymbols = 50;
    answers.message.push(async (m, opts) => {
        if (!opts || !opts.modal || !/^Write /.test(m)) return undefined;
        plc.addSymbol('MAIN.nAddedByDownload', { type: 'INT', value: 1 });
        cl.fire('symbolVersion');                              // a download: a check starts
        setTimeout(() => cl.fire('symbolVersion'), 5);         // and a newer one shortly after
        return 'Write';
    });
    answers.input.push('53');
    r = await run('twincat.watch.write', watchRow());
    assert(r.status === 'refused' && plc.get('GVL_Hmi.nSpeed') === 51,
        `#2 a write confirmed while newer code checks run waits for the newest one (${r.status}: ${r.message})`);
    await tick(150);
    delays.getSymbols = 0;
    plc.removeSymbol('MAIN.nAddedByDownload');

    // ── Review round 2 (2026-11-13), command level: R2#1, R2#0, R2#4 ─────────────────────────────
    const lines = () => channels[0].lines;
    const settle = async () => { await api.session.refreshStatus(); await tick(30); await api.refreshCodeCheck(); };
    plc.clients[plc.clients.length - 1].fire('symbolVersion');   // the #2 block's download, undone: symbols re-read
    await settle();
    assert(api.codeCheck() && api.codeCheck().state === 'match', `R2 (setup) the code check passes again (${api.codeCheck() && api.codeCheck().reason})`);

    // R2#1: a Manual Sync stash of a closed editor, fingerprinted against VS Code's text (no BOM),
    // still blocks against the file on disk (with its BOM), and the guard's read does not delete it.
    assert(fs.readFileSync(MAIN, 'utf8').charCodeAt(0) === 0xFEFF, 'R2#1 (premise) the sample MAIN.TcPOU starts with a BOM');
    const mainUri = mainDoc.uri.toString();
    await store.set(mainUri, { root_impl: { content: 'x := 1;' } }, fs.readFileSync(MAIN, 'utf8').replace(/^\uFEFF/, ''));
    answers.message.push('Write'); answers.input.push('54');
    r = await run('twincat.watch.write', watchRow());
    await tick(5);
    assert(r.status === 'refused' && /unsaved edits/.test(r.message) && plc.get('GVL_Hmi.nSpeed') === 51 && store.uris().includes(mainUri),
        `R2#1 a stash of a closed editor blocks across the BOM, and survives the check (${r.status}: ${r.message}; kept ${store.uris().includes(mainUri)})`);
    answers.message.length = 0; answers.input.length = 0;
    await store.set(mainUri, { root_impl: { content: 'x := 1;' } }, 'text the file no longer has');
    answers.message.push('Write'); answers.input.push('54');
    r = await run('twincat.watch.write', watchRow());
    await tick(5);
    assert(r.status === 'refused' && /unsaved edits/.test(r.message) && store.uris().includes(mainUri),
        `R2#1 a stash that no longer matches the file blocks (fail closed) and is not deleted by the check (${r.status})`);
    // R3#2: the refusal says which file holds the stash and how to clear it.
    assert(/MAIN\.TcPOU/.test(r.message) && /open it to restore or discard the stashed edits/.test(r.message),
        `R3#2 the refusal for a stale stash names the file and the way out (${r.message})`);
    answers.message.length = 0; answers.input.length = 0;
    await store.delete(mainUri);

    // R3#2: a stash whose file is gone (renamed or deleted while its editor was closed) can never be
    // opened again: it is dropped, logged, and blocks nothing.
    const goneUri = fileUri(path.join(SAMPLE, 'POUs', 'P_Renamed_Away.TcPOU'));
    await store.set(goneUri, { root_impl: { content: 'x := 1;' } }, 'text of a file that no longer exists');
    const linesBeforeGone = lines().length;
    answers.message.push('Write'); answers.input.push('51');
    r = await run('twincat.watch.write', watchRow());
    await tick(5);
    assert(r.status === 'written' && !store.uris().includes(goneUri),
        `R3#2 a stash whose file no longer exists is dropped and does not block (${r.status}: ${r.message}; kept ${store.uris().includes(goneUri)})`);
    assert(lines().slice(linesBeforeGone).some(l => /P_Renamed_Away\.TcPOU/.test(l) && /no longer exists/.test(l)),
        `R3#2 and the drop is logged with the file (${lines().slice(linesBeforeGone).join(' | ')})`);
    answers.message.length = 0; answers.input.length = 0;

    // R2#0: XAE downloads another workspace project to the same runtime while the value box is open.
    const mainMsg2 = { componentId: 'root', fileUri: mainUri, visible: { decl: [{ start: 1, end: 20 }], impl: [{ start: 1, end: 30 }] } };
    await provider.onlineSource.visible(mainUri, mainDoc, mainMsg2);
    const clickAt = { componentId: 'root', pane: 'impl', position: { lineNumber: 1, column: 3 }, fileUri: mainUri };
    const writesR2 = plc.writes.length;
    const checkLines = lines().filter(l => /Code check/.test(l)).length;
    answers.message.push('Write', 'Write');
    answers.input.push(async () => {
        plc.appInfo.ProjectName = 'OtherProject_PLC';
        plc.clients[plc.clients.length - 1].fire('symbolVersion');
        await settle();
        return '77';
    });
    r = await provider.onlineSource.write(mainUri, mainDoc, clickAt);
    assert(api.codeCheck() && api.codeCheck().project && api.codeCheck().project.name === 'OtherProject_PLC',
        `R2#0 (premise) the code check is now bound to the other project (${api.codeCheck() && api.codeCheck().project && api.codeCheck().project.name})`);
    assert(r && r.status === 'refused' && plc.writes.length === writesR2,
        `R2#0 a write from an editor of the old project is refused once the PLC runs another one (${r && r.status}: ${r && r.message})`);
    await tick(20);
    assert(lines().filter(l => /Code check/.test(l)).length > checkLines && lastState(mainDoc) && lastState(mainDoc).writable === false,
        `R2#0 the switch of the bound project is logged and the editor is told it may no longer write (${JSON.stringify(lastState(mainDoc))})`);
    answers.message.length = 0; answers.input.length = 0;
    plc.appInfo.ProjectName = 'TcToolkitSample_PLC';
    plc.clients[plc.clients.length - 1].fire('symbolVersion');
    await settle();

    // R2#0: a download that changes the symbol's type (same size, so the layout still matches) while the
    // value box is open: the value was parsed for the old type, so the write is refused.
    answers.message.push('Write');
    answers.input.push(async () => {
        plc.removeSymbol('GVL_Hmi.nSpeed');
        plc.addSymbol('GVL_Hmi.nSpeed', { type: 'UINT', value: 51 });
        plc.clients[plc.clients.length - 1].fire('symbolVersion');
        await settle();
        return '55';
    });
    r = await run('twincat.watch.write', watchRow());
    assert(r.status === 'refused' && plc.get('GVL_Hmi.nSpeed') === 51,
        `R2#0 a symbol whose type changed while the dialogs were open is not written (${r.status}: ${r.message})`);
    answers.message.length = 0; answers.input.length = 0;
    plc.removeSymbol('GVL_Hmi.nSpeed');
    plc.addSymbol('GVL_Hmi.nSpeed', { type: 'INT', value: 51 });
    plc.clients[plc.clients.length - 1].fire('symbolVersion');
    await settle();

    // R2#0: a click delivered while a Go Online is still connecting is refused, with no dialog.
    await run('twincat.goOffline');
    plc.connectBehavior.delayMs = 60;
    const going = run('twincat.goOnline', { netId: 'localhost', label: 'Local runtime' });
    await waitFor(() => api.session.state === 'connecting', 500);
    const modalsR2 = calls.modals.length;
    const inputsR2 = calls.inputs.length;
    answers.message.push('Enable writes', 'Write'); answers.input.push('78');
    r = await provider.onlineSource.write(mainUri, mainDoc, clickAt);
    await going;
    plc.connectBehavior.delayMs = 0;
    assert(r && r.status === 'refused' && calls.modals.length === modalsR2 && calls.inputs.length === inputsR2 && plc.writes.length === writesR2,
        `R2#0 a Write Value… click delivered while connecting is refused before any dialog (${r && r.status})`);
    answers.message.length = 0; answers.input.length = 0;
    await api.refreshCodeCheck();

    // R2#4: Go Offline while an editor's refresh waits on the PLC leaves no poll loop running.
    await provider.onlineSource.visible(mainUri, mainDoc, mainMsg2);
    delays.getSymbol = 40;
    plc.clients[plc.clients.length - 1].fire('symbolVersion');
    await tick(5);
    const refreshing = provider.onlineSource.visible(mainUri, mainDoc, mainMsg2);
    await tick(15);
    await run('twincat.goOffline');
    await refreshing;
    delays.getSymbol = 0;
    await tick(20);
    monitorTimers.fired = 0;
    await tick(600);
    assert(monitorTimers.fired === 0, `R2#4 no inline poll timer fires after Go Offline (${monitorTimers.fired} in 600 ms)`);

    await api.dispose();
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    return true;
}

(async () => {
    await guardLevel();
    await adapterRestore();
    await orphanReconnect();
    paths();
    await round2Lifecycle();
    round2Paths();
    await round3Guard();
    const full = await commandLevel();
    reportCoverage('ads-regressions', full ? 'ran' : 'skipped', full ? undefined : 'sample/ not present');
    if (errors) { console.error(`\n${errors} R15 regression assertion(s) failed`); process.exit(1); }
    console.log('\nAll R15 review regressions passed.');
    process.exit(0);
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
