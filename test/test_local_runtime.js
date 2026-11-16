/**
 * @file test_local_runtime.js
 * @description Online monitoring, R15 phase 3a: "Local runtime" on a user-mode PC targets the
 * runtime's own trusted AmsNetId (src/online/localRuntime.js, wired in src/commands/onlineCommands.js).
 * No PowerShell runs here: the driver's `-ListTargets` is replayed by test/_fakeXaeDriver.js, `tasklist`
 * by an execFile stub, and the PLC is test/_fakeAds.js.
 *
 * Pinned: the discovery's command line (no -SlnPath, no COM switches) and its failures (spawn error,
 * timeout, no `targets` event); the resolution table (0 / 1 / several trusted user-mode runtimes,
 * untrusted and status-less entries never used, a real-time record asks unless the kernel service is
 * known absent); the kernel-service check's parsing; the pick items (separator rows, preselect); the
 * texts; and end to end through Go Online: the resolved NetId reaches the client, the log names it,
 * the recent entry stores the concrete NetId, every Go Online resolves again, a pick, a cancel, the
 * failure hint names why the runtime's NetId is unknown, and Linux / direct mode / a remote router /
 * a typed NetId never run the discovery.
 */

'use strict';

const Module = require('module');
const path = require('path');
const { createFakeXaeSpawn } = require('./_fakeXaeDriver');
const { createFakePlc } = require('./_fakeAds');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ── A recording `vscode` stub ──────────────────────────────────────────────────────────────────────
const calls = { errors: [], warnings: [], picks: [], progress: [] };
const answers = { pick: [], cancelProgress: false };
const settings = {};
const handlers = new Map();
const channels = [];
class EventEmitter { constructor() { this.fns = []; this.event = (fn) => { this.fns.push(fn); return { dispose() {} }; }; } fire(v) { this.fns.forEach(f => f(v)); } }
const vscodeStub = {
    EventEmitter,
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    Uri: { parse: (s) => ({ fsPath: s, toString: () => s }) },
    env: { clipboard: { writeText: async () => {} } },
    workspace: {
        textDocuments: [],
        getConfiguration: (section) => ({
            get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, `${section}.${key}`) ? settings[`${section}.${key}`] : fallback),
            inspect: () => ({})
        }),
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
        createOutputChannel: (name) => { const ch = { name, lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }; channels.push(ch); return ch; },
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        registerTreeDataProvider: () => ({ dispose() {} }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async (m) => { calls.warnings.push(m); return undefined; },
        showErrorMessage: async (m) => { calls.errors.push(m); return undefined; },
        showInputBox: async () => undefined,
        showQuickPick: async (items, opts) => {
            calls.picks.push({ items, opts });
            const a = answers.pick.shift();
            return typeof a === 'function' ? a(items) : a;
        },
        setStatusBarMessage: () => ({ dispose() {} }),
        withProgress: async (opts, task) => {
            calls.progress.push(opts.title);
            /** @type {Function[]} */
            const fns = [];
            const token = { isCancellationRequested: false, onCancellationRequested: (fn) => { fns.push(fn); return { dispose() {} }; } };
            if (answers.cancelProgress && /finding the local runtime/.test(opts.title)) {
                answers.cancelProgress = false;
                setTimeout(() => { token.isCancellationRequested = true; fns.forEach(f => f()); }, 5);
            }
            return task({ report() {} }, token);
        }
    },
    commands: {
        registerCommand: (id, fn) => { handlers.set(id, fn); return { dispose() {} }; },
        executeCommand: async (id, ...args) => (id === 'setContext' ? undefined : (handlers.has(id) ? handlers.get(id)(...args) : undefined))
    }
};
const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.apply(this, arguments);
};

const {
    discoverRuntimes, checkKernelService, resolveLocalTarget, localPickItems, unresolvedHintText, resolutionLogText, resolvedLogText, KERNEL_SERVICE_IMAGE
} = require('../src/online/localRuntime');
const { RUNTIME_NETID_HINT } = require('../src/online/connectErrors');
const { QUICK_PICK_SEPARATOR } = require('../src/xaeBuild');

// Example NetIds only.
const UM = { netId: '10.0.0.4.1.1', name: 'UmRT_Default', kind: 'user-mode', platform: 'TwinCAT OS (x64)', provenance: 'read', netIdStatus: 'trusted', reason: null, fileNetId: null };
const UM2 = { ...UM, netId: '10.0.0.5.1.1', name: 'UmRT_Second' };
const RT = { netId: '10.0.0.1.1.1', name: 'Real-time runtime', kind: 'real-time', platform: 'TwinCAT RT (x64)', provenance: 'kind-inferred', netIdStatus: 'trusted', reason: null, fileNetId: null };
const STALE = { netId: null, name: 'UmRT_Default', kind: 'user-mode', platform: null, provenance: null, netIdStatus: 'rewritten',
    reason: 'the configuration file changed after this runtime started; its AmsNetId could not be confirmed over ADS: no runtime answered at 10.0.0.6.1.1 (ADS error 0x7)', fileNetId: '10.0.0.6.1.1' };
const NOT_RUNNING = { netId: null, name: 'UmRT_Default', kind: 'user-mode', platform: null, provenance: null, netIdStatus: 'not-running',
    reason: 'this runtime is not running', fileNetId: '10.0.0.7.1.1' };
const ok = (entries, extra = {}) => ({ ok: true, entries, ms: 42, ...extra });
const targetsLines = (local) => [{ v: 1, t: 'hello', mode: 'listTargets', showWindow: false }, { log: 'Runtime: ...' },
    { v: 1, t: 'targets', local, projectNetId: null }, { v: 1, t: 'done', exitCode: 0, ui: null }];

async function units() {
    // ── discovery: command line and failures ──────────────────────────────────────────────────
    {
        const fake = createFakeXaeSpawn(() => ({ lines: targetsLines([UM, RT]) }));
        const d = await discoverRuntimes({ spawn: fake.spawn, scriptPath: 'C:\\ext\\resources\\xae\\build-plc-project.ps1' });
        const a = fake.calls[0].args;
        assert(fake.calls[0].command === 'powershell.exe' && a.includes('-ListTargets') && a.includes('-Json') && !a.includes('-SlnPath')
            && !a.includes('-ActivateConfiguration') && !a.includes('-CancelFile') && a[a.indexOf('-File') + 1].endsWith('build-plc-project.ps1'),
        `discovery runs the driver's -ListTargets without a solution (${a.join(' ')})`);
        assert(d.ok && d.entries.length === 2 && d.entries[0].netId === UM.netId && typeof d.ms === 'number', 'discovery returns the targets event\'s list');
    }
    {
        const fake = createFakeXaeSpawn(() => ({ lines: [{ v: 1, t: 'targets', local: UM, projectNetId: null }] }));
        const d = await discoverRuntimes({ spawn: fake.spawn, scriptPath: 'x.ps1' });
        assert(d.ok && d.entries.length === 1, 'a one-element list handed over as a bare object (PS 5.1) is a list of one');
    }
    {
        const fake = createFakeXaeSpawn(() => ({ error: 'spawn powershell.exe ENOENT' }));
        const d = await discoverRuntimes({ spawn: fake.spawn, scriptPath: 'x.ps1' });
        assert(!d.ok && /PowerShell could not start/.test(d.error || ''), `a spawn error is a failed discovery (${d.error})`);
    }
    {
        const fake = createFakeXaeSpawn(() => ({ hang: true }));
        const d = await discoverRuntimes({ spawn: fake.spawn, scriptPath: 'x.ps1', timeoutMs: 30 });
        assert(!d.ok && /longer than/.test(d.error || '') && fake.calls[0].killed, `a hanging discovery times out and is killed (${d.error})`);
    }
    {
        const fake = createFakeXaeSpawn(() => ({ lines: [{ log: 'garbage' }], exit: 2, stderr: 'boom\r\n' }));
        const d = await discoverRuntimes({ spawn: fake.spawn, scriptPath: 'x.ps1' });
        assert(!d.ok && /not reported \(exit code 2\): boom/.test(d.error || ''), `no targets event is a failed discovery (${d.error})`);
    }

    // ── resolution table ──────────────────────────────────────────────────────────────────────
    let r = resolveLocalTarget(ok([UM]));
    assert(r.kind === 'runtime' && r.runtime && r.runtime.netId === UM.netId, 'one trusted user-mode runtime, no real-time record: that runtime');
    r = resolveLocalTarget(ok([UM, RT]), { kernelService: false });
    assert(r.kind === 'runtime' && r.realTime === null, 'a real-time record with the kernel service known absent: still that runtime');
    r = resolveLocalTarget(ok([UM, RT]), { kernelService: true });
    assert(r.kind === 'pick' && r.realTime && r.realTime.netId === RT.netId, 'a real-time record with the kernel service running: ask');
    r = resolveLocalTarget(ok([UM, RT]), { kernelService: null });
    assert(r.kind === 'pick', 'a real-time record and the kernel-service check failed: ask (fail safe)');
    r = resolveLocalTarget(ok([UM, RT]));
    assert(r.kind === 'pick', 'a real-time record and no kernel-service answer: ask');
    r = resolveLocalTarget(ok([UM, UM2]));
    assert(r.kind === 'pick' && r.runtimes.length === 2, 'two trusted user-mode runtimes: ask');
    r = resolveLocalTarget(ok([UM, { ...UM }]));
    assert(r.kind === 'runtime', 'the same NetId twice counts once');
    r = resolveLocalTarget(ok([STALE, RT]), { kernelService: true });
    assert(r.kind === 'router' && r.unknown.length === 1 && r.unknown[0].status === 'rewritten', 'only an untrusted runtime: the router, the runtime named as unknown');
    r = resolveLocalTarget(ok([{ ...STALE, netId: '10.0.0.6.1.1' }]));
    assert(r.kind === 'router', 'an untrusted status never uses its NetId, even when one is present');
    r = resolveLocalTarget(ok([{ netId: UM.netId, name: 'UmRT_Default', kind: 'user-mode' }]));
    assert(r.kind === 'router', 'an entry without netIdStatus is never used (only an explicit trusted counts)');
    r = resolveLocalTarget(ok([RT]));
    assert(r.kind === 'router' && r.unknown.length === 0, 'kernel mode only (no user-mode runtime): the router, as before');
    r = resolveLocalTarget(ok([]));
    assert(r.kind === 'router', 'no runtime at all: the router');
    r = resolveLocalTarget({ ok: false, entries: [], error: 'PowerShell could not start (x)', ms: 3 });
    assert(r.kind === 'router' && r.discoveryError === 'PowerShell could not start (x)', 'a failed discovery: the router, with the reason');

    // ── kernel-service check ──────────────────────────────────────────────────────────────────
    const exec = (out, err) => (file, args, opts, cb) => { exec.last = { file, args }; setImmediate(() => cb(err || null, out, '')); };
    assert(await checkKernelService(exec(`"${KERNEL_SERVICE_IMAGE}","2344","Services","0","12.345 K"\r\n`)) === true, 'tasklist naming TcSysSrv.exe: running');
    assert(exec.last.file === 'tasklist' && exec.last.args.join(' ') === `/FI IMAGENAME eq ${KERNEL_SERVICE_IMAGE} /FO CSV /NH`, 'tasklist filters on the image name, CSV, no header');
    assert(await checkKernelService(exec('INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgefuehrt.\r\n')) === false, 'a (localized) no-match line: not running');
    assert(await checkKernelService(exec('', null)) === null, 'empty output: unknown');
    assert(await checkKernelService(exec('', new Error('ENOENT'))) === null, 'tasklist failed: unknown');
    assert(await checkKernelService(() => { throw new Error('nope'); }) === null, 'execFile throwing: unknown');

    // ── pick items and texts ──────────────────────────────────────────────────────────────────
    const res = resolveLocalTarget(ok([UM, UM2, RT, { ...NOT_RUNNING, name: 'UmRT_Third' }]), { kernelService: true });
    let items = localPickItems(res, 851);
    assert(items.length === 4 && items[0].netId === UM.netId && items[0].description === '10.0.0.4.1.1:851' && items[2].netId === 'localhost'
        && /router runtime \(kernel mode\)/.test(items[2].label), 'pick: the user-mode runtimes, then the router runtime');
    assert(items[3].kind === QUICK_PICK_SEPARATOR && !items[3].netId && /UmRT_Third: AMS Net ID unknown, not offered \(this runtime is not running\)/.test(items[3].label),
        'pick: an unknown runtime is a separator row that cannot be picked');
    items = localPickItems(res, 851, UM2.netId);
    assert(items[0].netId === UM2.netId, 'pick: the last choice comes first');
    items = localPickItems(res, 851, 'localhost');
    assert(items[0].netId === 'localhost', 'pick: the router as last choice comes first');

    assert(resolvedLogText({ name: 'UmRT_Default', netId: '10.0.0.4.1.1', kind: 'user-mode' })
        === 'Local runtime: user-mode runtime UmRT_Default at 10.0.0.4.1.1 (read from its configuration, instance running).', 'the resolved log line');
    // A NetId the driver confirmed over ADS (its configuration changed after the instance started,
    // e.g. on activation, and the runtime answered there): resolved like any trusted one, said so.
    {
        const viaAds = resolveLocalTarget(ok([{ ...UM, netIdSource: 'ads', reason: 'the configuration file changed after this runtime started; its AmsNetId was confirmed over ADS (the runtime answered at 10.0.0.4.1.1, state RUN)' }]));
        assert(viaAds.kind === 'runtime' && viaAds.runtime && viaAds.runtime.netId === '10.0.0.4.1.1' && viaAds.runtime.netIdSource === 'ads', 'a NetId confirmed over ADS is used');
        assert(resolvedLogText(viaAds.runtime) === 'Local runtime: user-mode runtime UmRT_Default at 10.0.0.4.1.1 (confirmed over ADS: the runtime answered there).',
            'the log line says the NetId was confirmed over ADS');
        const both = resolveLocalTarget(ok([{ ...UM, netIdSource: 'ads' }, { ...UM2, netIdSource: 'file-time' }]));
        const it = localPickItems(both, 851);
        assert(it[0].detail === 'User-mode runtime on this PC (its AMS Net ID confirmed over ADS: the runtime answered there)'
            && it[1].detail === 'User-mode runtime on this PC (its AMS Net ID read from its configuration, instance running)', 'the pick detail says how each NetId was established');
    }
    assert(/user-mode runtime UmRT_Default at 10\.0\.0\.4\.1\.1 .*\(discovery 42 ms\)$/.test(resolutionLogText(resolveLocalTarget(ok([UM])), 42)), 'the log line carries the discovery time');
    const staleHint = unresolvedHintText(resolveLocalTarget(ok([STALE])));
    assert(/AMS Net ID is unknown, so the router's own was used\. UmRT_Default: the configuration file changed after this runtime started; its AmsNetId could not be confirmed over ADS: .*names 10\.0\.0\.6\.1\.1/.test(staleHint),
        `the hint names why the runtime's NetId is unknown (${staleHint})`);
    assert(/failed: it took longer than 30 s\.$/.test(unresolvedHintText(resolveLocalTarget({ ok: false, entries: [], error: 'it took longer than 30 s', ms: 0 }))), 'the hint names a failed discovery');
    assert(/No user-mode runtime with a known AMS Net ID/.test(unresolvedHintText(resolveLocalTarget(ok([RT])))), 'the hint when there is no user-mode runtime');
    assert(unresolvedHintText(resolveLocalTarget(ok([UM]))) === '' && unresolvedHintText(null) === '', 'no hint once a runtime was resolved');
}

// ── End to end through Go Online ─────────────────────────────────────────────────────────────────
async function endToEnd() {
    const memento = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { m.set(k, v); return Promise.resolve(); } }; };
    const plc = createFakePlc({ symbols: { 'MAIN.nCount': { type: 'INT', value: 1 } } });
    /** @type {any[]} */
    const connects = [];
    let failNext = null;
    const createClient = (o) => {
        connects.push(o);
        const c = plc.createClient(o);
        if (failNext) {
            const err = failNext;
            failNext = null;
            c.connect = async () => { throw err; };
        }
        return c;
    };
    let discovery = ok([UM]);
    let discoveries = 0;
    let platform = 'win32';
    const build = () => {
        handlers.clear();
        const context = { subscriptions: [], workspaceState: memento(), globalState: memento(), extensionPath: path.join(__dirname, '..') };
        const provider = { activePanels: new Map(), broadcastOnlineState() {}, pendingEditsStore: { uris: () => [] } };
        const { registerOnlineCommands } = require('../src/commands/onlineCommands');
        const api = registerOnlineCommands(/** @type {any} */ (context), {
            provider, getProjectMap: () => null, createClient, platform,
            discoverRuntimes: async () => { discoveries++; return typeof discovery === 'function' ? discovery() : discovery; }
        });
        return { api, context };
    };
    const run = (id, ...a) => vscodeStub.commands.executeCommand(id, ...a);
    const log = () => channels[channels.length - 1].lines.join('\n');
    const pickLocal = (items) => items.find(i => i.label === 'Local runtime');

    let { context } = build();
    // One trusted runtime: Go Online > Local runtime targets it.
    answers.pick.push(pickLocal);
    let r = await run('twincat.goOnline');
    let last = connects[connects.length - 1];
    assert(r.status === 'online' && last.targetAmsNetId === UM.netId && last.targetAdsPort === 851 && last.label === 'Local runtime (UmRT_Default)',
        `Local runtime goes to UmRT_Default's NetId (${last.targetAmsNetId}, ${last.label})`);
    assert(/Local runtime: user-mode runtime UmRT_Default at 10\.0\.0\.4\.1\.1 \(read from its configuration, instance running\)\. \(discovery 42 ms\)/.test(log()),
        'the channel names the runtime, its NetId and why');
    assert(calls.progress.includes('Going online: finding the local runtime'), 'the discovery is awaited under a progress notification');
    assert(/The PLC runtime on this PC \(a user-mode runtime's AMS Net ID is found automatically\)/.test(calls.picks[0].items[0].detail), 'the pick says how Local runtime is reached on Windows');
    const recent = context.workspaceState.get('twincat.online.recentTargets', []);
    assert(recent[0] && recent[0].netId === UM.netId && recent[0].label === 'Local runtime (UmRT_Default)', 'the recent entry stores the concrete NetId');
    await run('twincat.goOffline');

    // A restart changed the NetId: the next Local runtime resolves again.
    discovery = ok([UM2]);
    const before = discoveries;
    answers.pick.push(pickLocal);
    r = await run('twincat.goOnline');
    last = connects[connects.length - 1];
    assert(r.status === 'online' && last.targetAmsNetId === UM2.netId && discoveries === before + 1, 'Local runtime is resolved again on every Go Online (new NetId used)');
    assert(calls.picks[calls.picks.length - 1].items.some(i => i.description === '10.0.0.4.1.1:851' && i.detail === 'Used before'), 'the old concrete NetId is offered as Used before');
    await run('twincat.goOffline');

    // Several: a pick, the last choice remembered.
    discovery = ok([UM, UM2]);
    answers.pick.push(pickLocal, (items) => items.find(i => i.netId === UM2.netId));
    r = await run('twincat.goOnline');
    last = connects[connects.length - 1];
    const lp = calls.picks[calls.picks.length - 1];
    assert(r.status === 'online' && last.targetAmsNetId === UM2.netId && lp.opts.title === 'Go Online: Local runtime', 'several runtimes: a pick, and the picked one is used');
    await run('twincat.goOffline');
    answers.pick.push(pickLocal, (items) => { assert(items[0].netId === UM2.netId, 'the last pick comes first next time'); return undefined; });
    const nConnects = connects.length;
    r = await run('twincat.goOnline');
    assert(r.status === 'cancelled' && connects.length === nConnects, 'dismissing the runtime pick cancels Go Online');

    // Kernel mode possible: the router runtime row targets localhost as before.
    discovery = ok([UM, RT], { kernelService: true });
    answers.pick.push(pickLocal, (items) => items.find(i => i.netId === 'localhost'));
    r = await run('twincat.goOnline');
    last = connects[connects.length - 1];
    assert(r.status === 'online' && last.targetAmsNetId === 'localhost' && last.label === 'Local runtime', 'the router runtime row goes to localhost, as before');
    await run('twincat.goOffline');
    discovery = ok([UM, RT], { kernelService: false });
    answers.pick.push(pickLocal);
    const nPicks = calls.picks.length;
    r = await run('twincat.goOnline');
    last = connects[connects.length - 1];
    assert(r.status === 'online' && last.targetAmsNetId === UM.netId && calls.picks.length === nPicks + 1, 'a real-time record without the kernel service: no second pick');
    await run('twincat.goOffline');

    // No trusted runtime: localhost as before; a 0x6 through the fallback names why.
    discovery = ok([STALE]);
    failNext = Object.assign(new Error('target port not found'), { fallback: { routerError: 'socket error -4077' }, helper: { adsError: 6 } });
    answers.pick.push(pickLocal);
    r = await run('twincat.goOnline');
    last = connects[connects.length - 1];
    const err = calls.errors[calls.errors.length - 1];
    assert(r.status === 'failed' && last.targetAmsNetId === 'localhost', 'an untrusted runtime: Local runtime stays on the router');
    assert(err.includes(RUNTIME_NETID_HINT) && /AMS Net ID is unknown, so the router's own was used\. UmRT_Default: the configuration file changed after this runtime started/.test(err),
        `the "Enter AMS Net ID" hint also names why the runtime's NetId is unknown (${err})`);
    assert(/Local runtime: the router's own AMS Net ID \(localhost\)\. The user-mode runtime's AMS Net ID is unknown/.test(log()), 'the channel says the router was used and why');

    // A failed discovery: the router, the reason in the hint.
    discovery = { ok: false, entries: [], error: 'PowerShell could not start (spawn powershell.exe ENOENT)', ms: 5 };
    failNext = Object.assign(new Error('target machine not found'), { fallback: { routerError: 'socket error -4077' }, helper: { adsError: 7 } });
    answers.pick.push(pickLocal);
    r = await run('twincat.goOnline');
    assert(r.status === 'failed' && /Finding the user-mode runtime's AMS Net ID failed: PowerShell could not start/.test(calls.errors[calls.errors.length - 1]),
        'a failed discovery is named in the hint');
    // A throwing discovery is a failed one, not an unhandled rejection.
    discovery = () => { throw new Error('kaboom'); };
    answers.pick.push(pickLocal);
    r = await run('twincat.goOnline');
    assert(r.status === 'online' && connects[connects.length - 1].targetAmsNetId === 'localhost', 'a throwing discovery falls back to the router');
    await run('twincat.goOffline');

    // Cancel while the discovery still runs.
    discovery = () => new Promise(() => {});
    answers.cancelProgress = true;
    answers.pick.push(pickLocal);
    const n2 = connects.length;
    r = await run('twincat.goOnline');
    assert(r.status === 'cancelled' && connects.length === n2, 'Cancel while finding the local runtime cancels Go Online');

    // Unchanged: a typed / recent NetId, args, direct mode, a remote router, Linux.
    discovery = ok([UM]);
    let d0 = discoveries;
    r = await run('twincat.goOnline', { netId: '10.0.0.9.1.1', port: 851 });
    assert(r.status === 'online' && connects[connects.length - 1].targetAmsNetId === '10.0.0.9.1.1' && discoveries === d0, 'a concrete NetId never runs the discovery');
    await run('twincat.goOffline');
    r = await run('twincat.goOnline', { netId: 'localhost', label: 'Local runtime' });
    assert(r.status === 'online' && connects[connects.length - 1].targetAmsNetId === UM.netId, 'goOnline({netId: localhost}) is resolved like the pick');
    await run('twincat.goOffline');
    settings['tcToolkit.online.routerAddress'] = '192.0.2.10';
    d0 = discoveries;
    await run('twincat.goOnline', { netId: 'localhost', label: 'Local runtime' });
    assert(connects[connects.length - 1].targetAmsNetId === 'localhost' && discoveries === d0, 'a remote router: no discovery, localhost as before');
    await run('twincat.goOffline');
    delete settings['tcToolkit.online.routerAddress'];
    settings['tcToolkit.online.connectionMode'] = 'direct';
    d0 = discoveries;
    answers.pick.push((items) => { assert(!items.some(i => /^The PLC runtime on this PC/.test(i.detail || '')), 'direct mode offers no Local runtime entry'); return undefined; });
    await run('twincat.goOnline');
    assert(discoveries === d0, 'direct mode: no discovery while the pick is open');
    delete settings['tcToolkit.online.connectionMode'];

    platform = 'linux';
    build();
    d0 = discoveries;
    answers.pick.push(pickLocal);
    r = await run('twincat.goOnline');
    assert(r.status === 'online' && connects[connects.length - 1].targetAmsNetId === 'localhost' && discoveries === d0
        && /through the local router/.test(calls.picks[calls.picks.length - 1].items[0].detail), 'Linux: no discovery, localhost as before');
    await run('twincat.goOffline');
}

(async () => {
    await units();
    await endToEnd();
    console.log(errors === 0 ? '\nAll local-runtime tests passed.' : `\n${errors} local-runtime test(s) FAILED.`);
    process.exit(errors === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
