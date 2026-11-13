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
        for (const name of ['readValue', 'readRawMulti', 'subscribeRaw', 'getSymbols', 'readPlcState']) {
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
    const api = registerOnlineCommands(context, { provider, getProjectMap: () => projectMap, createClient: slowable(plc, delays) });
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

    await api.dispose();
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    return true;
}

(async () => {
    await guardLevel();
    await adapterRestore();
    await orphanReconnect();
    paths();
    const full = await commandLevel();
    reportCoverage('ads-regressions', full ? 'ran' : 'skipped', full ? undefined : 'sample/ not present');
    if (errors) { console.error(`\n${errors} R15 regression assertion(s) failed`); process.exit(1); }
    console.log('\nAll R15 review regressions passed.');
    process.exit(0);
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
