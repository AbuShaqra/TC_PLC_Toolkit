/**
 * @file test_ads_helper.js
 * @description Online monitoring, R15 phase 2: the user-mode fallback through TwinCAT's own ADS DLL.
 * No PowerShell runs here: `spawn` is replaced by test/_fakeAdsHelper.js, a "powershell.exe" that
 * speaks the helper's JSON-lines protocol over a raw-ADS PLC in memory, and the local router is a TCP
 * server that resets every connection (what the 4026 user-mode router does to ads-client).
 *
 * Pinned: the ads-client internals helperClient.js overrides or calls exist in the pinned version;
 * the helper script carries every protocol command and the DLL search; PowerShell's command line;
 * the helper process (ready line, DLL not found, request ids, ADS errors, the hang guard kills,
 * stdin end closes, an exit fails what is pending); exactly which failures switch to the helper
 * (`isRouterRefusal`); end to end through the online session — the switch is logged, symbols resolve,
 * a sum read decodes, a notification arrives on change, a write lands, `_AppInfo` reads, a download
 * (symbol version) re-reads symbols, Start/Stop PLC go through as WriteControl (and a refused one keeps
 * its ADS error), Go Offline ends the helper; a helper that dies while online is
 * reconnected with a new one; and the messages when the fallback fails too (DLL missing, the local
 * runtime at the router's own NetId, a runtime that is not running), on Linux (no fallback: "reset",
 * never "No ADS router answered") and in direct mode (no fallback).
 */

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { Client } = require('ads-client');
const { createAdsClient, isRouterRefusal } = require('../src/online/adsClient');
const { startAdsHelper, helperArgs, HELPER_SCRIPT } = require('../src/online/adsHelperProcess');
const { createOnlineSession } = require('../src/online/session');
const { describeConnectError, USER_MODE_HINT, RUNTIME_NETID_HINT } = require('../src/online/connectErrors');
const { createRawPlc, createFakeHelperSpawn } = require('./_fakeAdsHelper');
const { failureText } = require('../src/online/plcControl');
const { SETTING_ADS_DOTNET_LIBRARY, SETTING_ADS_NATIVE_DLL_FOLDER, readAdsDllSettings, adsDllHint } = require('../src/adsDllSettings');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await tick(10); }
    return fn();
}

/** A "router" that resets every TCP connection, as the 4026 user-mode router does. */
async function resettingRouter() {
    const server = net.createServer(s => s.resetAndDestroy());
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, port: /** @type {any} */ (server.address()).port };
}

/**
 * A session whose clients fall back to the fake helper.
 * @param {any} fake createFakeHelperSpawn's result
 * @param {string[]} lines
 * @param {Object} [o]
 */
function helperSession(fake, lines, o = {}) {
    const deps = { platform: 'win32', startHelper: (/** @type {any} */ x) => startAdsHelper({ ...x, spawn: fake.spawn, platform: 'win32', ...o }) };
    return createOnlineSession({ createClient: (opts) => createAdsClient(opts, deps), log: (l) => lines.push(l), statusIntervalMs: 50 });
}

// ── 1. the ads-client internals the helper transport relies on ───────────────────────────────────
function contract() {
    for (const m of ['connectToTarget', 'disconnectFromTarget', 'unregisterAdsPort', 'sendAdsCommand', 'parseAdsResponse',
        'onAdsCommandReceived', 'setupPlcConnection', 'onConnectionLost', 'readRawMulti', 'clearTimer']) {
        assert(typeof Client.prototype[m] === 'function', `ads-client Client has ${m}() (helperClient.js depends on it)`);
    }
    const pkg = require('../package.json');
    assert(pkg.dependencies['ads-client'] === '2.2.0', 'ads-client stays pinned to exactly 2.2.0 (the internals above are version-bound)');
}

// ── 2. the helper script, as text (no PowerShell here) ────────────────────────────────────────────
function scriptContract() {
    assert(HELPER_SCRIPT === path.join(__dirname, '..', 'resources', 'online', 'ads-helper.ps1') && fs.existsSync(HELPER_SCRIPT),
        'the helper script ships at resources/online/ads-helper.ps1');
    const ps = fs.readFileSync(HELPER_SCRIPT, 'utf8');
    assert(![...ps].some(ch => ch.charCodeAt(0) > 0x7F), 'the script is ASCII (Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page)');
    for (const cmd of ['open', 'read', 'write', 'readwrite', 'state', 'deviceinfo', 'writecontrol', 'close']) {
        assert(new RegExp(`^\\s*'${cmd}' \\{`, 'm').test(ps), `the script answers "${cmd}"`);
    }
    assert(/event = 'ready'; ok = \$true/.test(ps) && /kind = 'dll-not-found'/.test(ps) && /kind = 'dll-load'/.test(ps),
        'the script reports ready, dll-not-found and dll-load');
    assert(/\[Console\]::In\.ReadLine\(\)/.test(ps) && /if \(\$null -eq \$line\) \{ break \}/.test(ps), 'it exits when stdin closes');
    assert(/3\.1\\Components\\Base/.test(ps) && /TwinCAT\.Ads\.dll/.test(ps) && /Sort-Object .*-Descending/.test(ps),
        'it searches Components\\Base\\v* for TwinCAT.Ads.dll, newest first');
    assert(/Common64/.test(ps) && /Common32/.test(ps) && /Is64BitProcess/.test(ps) && /\$env:Path = \$common \+ ';'/.test(ps),
        'it prepends Common64 or Common32 (by process bitness) to PATH, where TcAdsDll.dll lives');
    assert(/HKLM:\\SOFTWARE\\WOW6432Node\\Beckhoff\\TwinCAT3/.test(ps), 'it reads the TwinCAT install folder from the registry');
    assert(/TwinCAT\.Ads\.TcAdsClient/.test(ps) && /\.Timeout = \$TimeoutMs/.test(ps) && /param\([\s\S]*\[int\]\$TimeoutMs/.test(ps),
        'one TcAdsClient per address, with the ADS timeout passed in');
    assert(/adsError = \$code/.test(ps) && /TwinCAT\.Ads\.\*/.test(ps), 'an ADS error comes back as its code (TwinCAT.Ads exceptions only)');
    assert(/ToBase64String/.test(ps) && /FromBase64String/.test(ps), 'binary payloads are base64');
    assert(/return ,\(\[Convert\]::FromBase64String/.test(ps), 'the decoded bytes are not unrolled by PowerShell');
    assert(/New-Object TwinCAT\.Ads\.StateInfo -ArgumentList \(\[TwinCAT\.Ads\.AdsState\]\[int\]\$Request\.adsState\), \(\[int16\]\$Request\.deviceState\)/.test(ps)
        && /\$c\.WriteControl\(\$si\)/.test(ps), 'writecontrol: TcAdsClient.WriteControl(StateInfo(AdsState, deviceState)) (Start/Stop PLC)');
    assert(!/199\.\d+\.\d+\.\d+/.test(ps), 'no real NetId in the script');
    // The configured DLL locations (tcToolkit.adsDll.*): used as given, checked before any search.
    assert(/param\([\s\S]*\[string\]\$AdsDll = ''[\s\S]*\[string\]\$AdsNativeDir = ''\s*\)/.test(ps), 'the script takes -AdsDll and -AdsNativeDir');
    const nativeCheck = ps.indexOf("if ($AdsNativeDir -and -not (Test-Path -LiteralPath (Join-Path $AdsNativeDir 'TcAdsDll.dll') -PathType Leaf))");
    const managedCheck = ps.indexOf('if ($AdsDll -and -not (Test-Path -LiteralPath $AdsDll -PathType Leaf))');
    const search = ps.indexOf('$candidates = @(Get-AdsDllCandidates)');
    assert(nativeCheck > 0 && managedCheck > 0 && search > managedCheck && search > nativeCheck,
        'a configured TcAdsDll.dll folder and TwinCAT.Ads.dll are checked before the search');
    const after = (/** @type {number} */ i) => ps.slice(i, ps.indexOf('exit 2', i) + 6);
    assert(/dllName = 'TcAdsDll\.dll'; configured = \$true/.test(after(nativeCheck)) && /kind = 'dll-not-found'/.test(after(nativeCheck))
        && /dllName = 'TwinCAT\.Ads\.dll'; configured = \$true/.test(after(managedCheck)) && /kind = 'dll-not-found'/.test(after(managedCheck)),
        'a configured path that does not hold its DLL is dll-not-found, named, configured, and the helper exits (no search)');
    assert(/if \(\$AdsDll -and \(Test-Path -LiteralPath \$AdsDll -PathType Container\)\) \{ \$AdsDll = Join-Path \$AdsDll 'TwinCAT\.Ads\.dll' \}/.test(ps),
        'a folder holding TwinCAT.Ads.dll is accepted for -AdsDll');
    assert(/\$common = if \(\$AdsNativeDir\) \{ \$AdsNativeDir \} elseif \(\$c\.Root\)/.test(ps), 'a configured folder replaces Common64/Common32 on PATH');
    assert(/kind = 'dll-not-found'; bitness = \$bitness; dllName = 'TwinCAT\.Ads\.dll'; configured = \$false/.test(ps)
        && /kind = 'dll-load'; bitness = \$bitness; dllName = 'TwinCAT\.Ads\.dll'; configured = \[bool\]\$AdsDll/.test(ps),
        'the searched not-found and the load failure say which DLL and whether it was configured');
}

// ── 3. the helper process ─────────────────────────────────────────────────────────────────────────
async function helperProcess() {
    const args = helperArgs('C:\\ext\\resources\\online\\ads-helper.ps1', 2000);
    assert(args.includes('-NoProfile') && args[args.indexOf('-ExecutionPolicy') + 1] === 'Bypass' && args.indexOf('-ExecutionPolicy') < args.indexOf('-File'),
        '-NoProfile, -ExecutionPolicy Bypass before -File');
    assert(args[args.indexOf('-File') + 1] === 'C:\\ext\\resources\\online\\ads-helper.ps1' && args[args.indexOf('-TimeoutMs') + 1] === '2000',
        '-File names the script; -TimeoutMs passes the ADS timeout');
    assert(!args.includes('-AdsDll') && !args.includes('-AdsNativeDir')
        && JSON.stringify(helperArgs('s.ps1', 2000, { dotNetLibrary: '', nativeDllFolder: '' })) === JSON.stringify(helperArgs('s.ps1', 2000)),
        'empty settings pass no DLL flag (the helper searches, as before)');
    const dllArgs = helperArgs('s.ps1', 2000, { dotNetLibrary: 'D:\\Beckhoff\\TwinCAT.Ads.dll', nativeDllFolder: 'D:\\Beckhoff\\Common64' });
    assert(dllArgs[dllArgs.indexOf('-AdsDll') + 1] === 'D:\\Beckhoff\\TwinCAT.Ads.dll' && dllArgs[dllArgs.indexOf('-AdsNativeDir') + 1] === 'D:\\Beckhoff\\Common64'
        && dllArgs.indexOf('-AdsDll') > dllArgs.indexOf('-File'), 'the configured paths go to -AdsDll and -AdsNativeDir, after -File');
    {
        const s = readAdsDllSettings((k) => ({ dotNetLibrary: '  D:\\x\\TwinCAT.Ads.dll ', nativeDllFolder: 7 })[k]);
        assert(s.dotNetLibrary === 'D:\\x\\TwinCAT.Ads.dll' && s.nativeDllFolder === '', 'the settings are read trimmed; a non-string is empty');
    }

    let err = null;
    try { await startAdsHelper({ platform: 'linux' }); } catch (e) { err = e; }
    assert(err && err.kind === 'not-windows', 'not on Windows: refused before anything is spawned');

    const plc = createRawPlc();
    let fake = createFakeHelperSpawn(plc);
    const h = await startAdsHelper({ spawn: fake.spawn, platform: 'win32' });
    const sp = fake.spawned[0];
    assert(sp.cmd === 'powershell.exe' && sp.opts.windowsHide === true && sp.args.includes(HELPER_SCRIPT), 'powershell.exe, hidden, with the shipped script');
    assert(h.info.dllVersion === '4.3.32.0' && h.info.bitness === 64, 'the ready line (DLL, version, bitness) is kept');
    const st = await h.request('state', { netId: '10.0.0.4.1.1', port: 10000 });
    assert(st.adsState === 5, 'a request is answered by id');
    err = null;
    try { await h.request('read', { netId: '10.0.0.5.1.1', port: 851, ig: 0x4040, io: 0, len: 2 }); } catch (e) { err = e; }
    assert(err && err.kind === 'ads' && err.adsError === 7, 'an ADS error comes back as kind "ads" with its code');
    await h.close();
    assert(sp.exited && !sp.killed && !h.alive(), 'close() ends stdin and the helper exits by itself');

    fake = createFakeHelperSpawn(plc, { ready: { id: 0, event: 'ready', ok: false, kind: 'dll-not-found', error: 'TwinCAT.Ads.dll was not found', searched: ['C:\\TwinCAT\\3.1\\Components\\Base\\v*\\TwinCAT.Ads.dll'] } });
    err = null;
    try { await startAdsHelper({ spawn: fake.spawn, platform: 'win32' }); } catch (e) { err = e; }
    assert(err && err.kind === 'dll-not-found' && /not found/.test(err.message), 'a missing DLL is reported as dll-not-found');

    fake = createFakeHelperSpawn(plc, { intercept: (req) => (req.cmd === 'read' ? 'hang' : null), ignoreStdinEnd: true });
    const hung = await startAdsHelper({ spawn: fake.spawn, platform: 'win32', requestTimeoutMs: 80 });
    let exitReason = null;
    hung.onExit((r) => { exitReason = r; });
    const p1 = hung.request('read', { netId: '10.0.0.4.1.1', port: 851, ig: 0x4040, io: 0, len: 2 }).catch(e => e);
    const p2 = hung.request('state', { netId: '10.0.0.4.1.1', port: 851 }).catch(e => e);
    const [e1, e2] = await Promise.all([p1, p2]);
    assert(e1.kind === 'timeout' && e2 && e2.kind === 'timeout', 'an unanswered request times out, and what queued behind it fails');
    assert(fake.spawned[0].killed && exitReason === 'timeout' && !hung.alive(), 'a hung helper is killed (hang guard), and its owner is told');
    assert(fake.spawned[0].requests.length === 1, 'one request at a time: the queued one was never sent to the hung helper');
    err = await hung.request('state', {}).catch(e => e);
    assert(err.kind === 'closed', 'a dead helper refuses new requests at once');

    fake = createFakeHelperSpawn(plc, { ignoreStdinEnd: true });
    const stubborn = await startAdsHelper({ spawn: fake.spawn, platform: 'win32', killAfterMs: 30 });
    await stubborn.close();
    assert(fake.spawned[0].killed, 'a helper that does not exit when stdin closes is killed');

    fake = createFakeHelperSpawn(plc, { intercept: (req) => (req.cmd === 'read' ? 'hang' : null) });
    const dying = await startAdsHelper({ spawn: fake.spawn, platform: 'win32' });
    const pending = dying.request('read', { netId: '10.0.0.4.1.1', port: 851, ig: 0x4040, io: 0, len: 2 }).catch(e => e);
    fake.spawned[0].proc.crash();
    err = await pending;
    assert(err.kind === 'exited', 'a helper that exits fails the pending request');
}

// ── 4. which failures switch to the helper ────────────────────────────────────────────────────────
function trigger() {
    const R = { mode: 'router', routerAddress: '127.0.0.1', targetAmsNetId: '10.0.0.4.1.1', targetAdsPort: 851 };
    const e = (/** @type {string} */ t) => ({ message: 'x', trace: ['connect(): failed', t] });
    const conn = 'connectToTarget(): Connecting to 127.0.0.1:48898 failed';
    assert(isRouterRefusal(e(`${conn} (socket error -4077)`), R), 'Windows ECONNRESET (-4077, measured on 4026 user mode) switches');
    assert(isRouterRefusal(e(`${conn} (socket error -4078)`), R) && isRouterRefusal(e(`${conn} (socket error -104)`), R),
        'ECONNREFUSED and the Linux errno switch too');
    assert(isRouterRefusal(e(`${conn} - socket closed by remote (hadError: false)`), R) && isRouterRefusal(e(`${conn} - socket ended by remote`), R),
        'a router that closes or ends the connection during the connect switches');
    assert(isRouterRefusal(e('connectToTarget(): Registering ADS port failed'), R), 'a router that does not register our port switches');
    assert(!isRouterRefusal(e(`${conn} - No response from target in 2000 ms (timeout)`), R), 'a timeout does not switch');
    assert(!isRouterRefusal({ message: 'x', adsError: { errorCode: 7 }, trace: ['x'] }, R), 'a missing route (ADS 0x7) does not switch');
    assert(!isRouterRefusal(e('connectToTarget(): Connecting to 10.1.1.1:48898 failed (socket error -4077)'), { ...R, routerAddress: '10.1.1.1' }),
        'a remote router does not switch');
    assert(!isRouterRefusal(e(`${conn} (socket error -4077)`), { ...R, mode: 'direct' }), 'direct mode does not switch');
    assert(isRouterRefusal(e(`${conn} (socket error -4077)`), { ...R, routerAddress: undefined }), 'an unset router address is this PC');
}

// ── 5. end to end through the online session ──────────────────────────────────────────────────────
async function endToEnd() {
    const router = await resettingRouter();
    const plc = createRawPlc();
    plc.set('MAIN.nCount', 7);
    plc.set('TwinCAT_SystemInfoVarList._AppInfo.ProjectName', 'TcToolkitSample_PLC');
    const fake = createFakeHelperSpawn(plc);
    const lines = [];
    const session = helperSession(fake, lines);
    const events = [];
    session.onDidChange((w) => events.push(w));
    const res = await session.connect({ mode: 'router', routerAddress: '127.0.0.1', routerTcpPort: router.port, targetAmsNetId: '10.0.0.4.1.1', targetAdsPort: 851 });
    assert(session.state === 'online' && res.transport === 'helper', 'the reset router is bypassed: online through the helper');
    assert(lines.some(l => /refused this client's TCP connection/.test(l) && /socket error -104/.test(l) && /PowerShell helper \(user-mode fallback\)/.test(l)),
        'the switch is logged with the router\'s own error');
    assert(lines.some(l => /^Connected through TwinCAT's ADS DLL \(C:\\TwinCAT\\.*TwinCAT\.Ads\.dll, version 4\.3\.32\.0, 64-bit PowerShell\)/.test(l)),
        'the DLL used is logged');
    assert(lines.some(l => /^Online: .* over TwinCAT's ADS DLL \(user-mode fallback\)\), local AmsNetId 10\.0\.0\.9\.1\.1$/.test(l)),
        'the Online line names the transport');
    assert(fake.spawned.length === 1, 'one helper');
    await waitFor(() => session.info.projectName !== null);
    assert(session.info.plcState === 'Run' && session.info.projectName === 'TcToolkitSample_PLC',
        `the status poll reads the PLC state and _AppInfo.ProjectName through the helper (${session.info.plcState}, ${session.info.projectName})`);

    const r = await session.resolve('MAIN.nCount');
    const missing = await session.resolve('MAIN.nGuessed');
    assert(r.ok && r.scalar && r.symbol.type === 'INT' && r.symbol.indexGroup === 0x4040, 'a symbol resolves (SymbolInfoByNameEx through ReadWrite)');
    assert(!missing.ok, 'a path the PLC does not know does not resolve (ADS 0x710 through the helper)');
    const sumBefore = plc.sumReads;
    const flag = await session.resolve('MAIN.bRun');
    const values = await session.readMany([r, flag]);
    assert(values.get('MAIN.nCount').value === 7 && values.get('MAIN.bRun').value === false && plc.sumReads >= sumBefore + 1,
        'readMany decodes a sum read (0xF080) answered by the helper');

    const seen = [];
    const sub = await session.subscribe('MAIN.nCount', 200, (v) => seen.push(v));
    assert(sub.ok, 'a watch subscription is accepted');
    await waitFor(() => seen.length >= 1);
    assert(seen[0] === 7, 'the current value arrives first, as a PLC sends it');
    plc.set('MAIN.nCount', 11);
    await waitFor(() => seen.includes(11), 1500);
    assert(seen.includes(11), `a change arrives through the polled notification (${seen})`);
    const n = seen.length;
    await tick(450);
    assert(seen.length === n, 'on change only: an unchanged value is not sent again');

    await session.write('MAIN.nCount', 42);
    assert(plc.memory.readInt16LE(0) === 42, 'a write lands in PLC memory (Write through the helper)');
    await session.write('GVL.fValue', 1.5);
    assert(plc.memory.readFloatLE(4) === 1.5, 'a REAL write is encoded by ads-client, as on the TCP path');

    // Start/Stop PLC over the helper: ads-client's stopPlc/startPlc send WriteControl (cmd 5) through it.
    const stopped = await session.controlPlc('stop');
    const wc = fake.spawned[0].requests.filter(q => q.cmd === 'writecontrol');
    assert(stopped === 'Stop' && plc.adsState === 6 && plc.controls.length === 1 && plc.controls[0].adsState === 6 && plc.controls[0].deviceState === 0
        && wc.length === 1 && wc[0].netId === '10.0.0.4.1.1' && wc[0].port === 851 && wc[0].data === '',
        `Stop PLC reaches the PLC as WriteControl Stop (6) on its port, device state kept, no data (${JSON.stringify(wc[0])})`);
    assert(session.info.plcState === 'Stop', 'the session reads the new state at once');
    const started = await session.controlPlc('start');
    assert(started === 'Run' && plc.adsState === 5 && plc.controls[1].adsState === 5 && session.info.plcState === 'Run', 'Start PLC: WriteControl Run (5)');

    const before = events.filter(e => e === 'symbols').length;
    plc.symbolVersion = 2;
    await waitFor(() => events.filter(e => e === 'symbols').length > before, 1500);
    assert(events.filter(e => e === 'symbols').length > before && lines.some(l => /symbol version changed/.test(l)),
        'a download (symbol version) is seen through the polled notification and re-reads symbols');

    // A WriteControl the PLC refuses: the ADS error reaches the caller with its code, as on the TCP path.
    const refusing = createFakeHelperSpawn(plc, { intercept: (q) => (q.cmd === 'writecontrol' ? { ok: false, error: 'Ads-Error 0x712', adsError: 0x712 } : null) });
    const s2 = helperSession(refusing, []);
    await s2.connect({ mode: 'router', routerAddress: '127.0.0.1', routerTcpPort: router.port, targetAmsNetId: '10.0.0.4.1.1', targetAdsPort: 851 });
    let ctlErr = null;
    try { await s2.controlPlc('stop'); } catch (e) { ctlErr = e; }
    assert(ctlErr && ctlErr.adsError && ctlErr.adsError.errorCode === 0x712 && failureText(ctlErr) === 'ADS error 0x712 (Server is in invalid state)' && plc.adsState === 5,
        `a refused WriteControl comes back as its ADS error (${ctlErr && failureText(ctlErr)})`);
    await s2.disconnect();

    await session.disconnect();
    assert(fake.spawned[0].exited && !fake.spawned[0].killed, 'Go Offline ends the helper through stdin');
    const count = fake.spawned[0].requests.length;
    await tick(300);
    assert(fake.spawned[0].requests.length === count, 'nothing is polled after Go Offline');
    router.server.close();
}

// ── 6. a helper that dies while online ────────────────────────────────────────────────────────────
async function helperDies() {
    const router = await resettingRouter();
    const plc = createRawPlc();
    const fake = createFakeHelperSpawn(plc);
    const lines = [];
    const deps = { platform: 'win32', startHelper: (/** @type {any} */ x) => startAdsHelper({ ...x, spawn: fake.spawn, platform: 'win32' }) };
    const C = class extends Client { constructor(s) { super({ ...s, reconnectInterval: 50 }); } };
    const session = createOnlineSession({ createClient: (o) => createAdsClient(o, { ...deps, Client: C }), log: (l) => lines.push(l) });
    await session.connect({ mode: 'router', routerAddress: '127.0.0.1', routerTcpPort: router.port, targetAmsNetId: '10.0.0.4.1.1', targetAdsPort: 851 });
    fake.spawned[0].proc.crash();
    await waitFor(() => lines.includes('Connection lost; reconnecting.'));
    await waitFor(() => lines.includes('Reconnected.'), 3000);
    assert(lines.includes('Connection lost; reconnecting.') && lines.includes('Reconnected.') && fake.spawned.length === 2,
        `a helper that exits is a lost connection; the reconnect starts a new helper (${fake.spawned.length} spawned)`);
    const r = await session.resolve('MAIN.nCount');
    assert(r.ok, 'and the session works through it');
    await session.disconnect();
    assert(fake.spawned.every(s => s.exited), 'no helper outlives Go Offline');
    router.server.close();
}

// ── 7. when the fallback fails too, and when there is none ───────────────────────────────────────
async function failures() {
    const router = await resettingRouter();
    const base = { mode: 'router', routerAddress: '127.0.0.1', routerTcpPort: router.port, targetAdsPort: 851 };
    const plc = createRawPlc();
    /**
     * @param {any} fake
     * @param {any} o
     */
    const tryConnect = async (fake, o) => {
        const lines = [];
        const session = helperSession(fake, lines);
        let err = null;
        try { await session.connect(o); } catch (e) { err = e; }
        return { err, lines, session, f: err ? describeConnectError(err, o) : null };
    };

    let fake = createFakeHelperSpawn(plc, { ready: { id: 0, event: 'ready', ok: false, kind: 'dll-not-found', error: 'TwinCAT.Ads.dll was not found' } });
    let t = await tryConnect(fake, { ...base, targetAmsNetId: '10.0.0.4.1.1' });
    assert(t.f && t.f.kind === 'helper-unavailable' && t.f.fallback &&
        /^The ADS router at 127\.0\.0\.1:48898 refused this client's TCP connection, and the fallback through TwinCAT's ADS DLL could not start: TwinCAT\.Ads\.dll was not found\.$/.test(t.f.message),
        `DLL missing: both failures named (${t.f && t.f.message})`);
    assert(/socket error -104/.test(t.f.raw) && t.session.state === 'offline', 'the log keeps the router\'s own error too; offline');
    assert(t.f.setting === SETTING_ADS_DOTNET_LIBRARY && t.f.hint.includes(SETTING_ADS_DOTNET_LIBRARY) && t.f.hint.includes(adsDllHint('managed'))
        && /Components\\Base\\v170\\TwinCAT\.Ads\.dll/.test(t.f.hint), `DLL missing: the hint names the setting and the usual path (${t.f.hint})`);

    // The configured paths reach the helper's command line through the session's client.
    {
        const dlls = { dotNetLibrary: 'D:\\TC\\TwinCAT.Ads.dll', nativeDllFolder: 'D:\\TC\\Common64' };
        fake = createFakeHelperSpawn(plc, { ready: { id: 0, event: 'ready', ok: false, kind: 'dll-not-found', dllName: 'TcAdsDll.dll', configured: true,
            error: 'TcAdsDll.dll was not found in the configured folder D:\\TC\\Common64.', searched: ['D:\\TC\\Common64\\TcAdsDll.dll'] } });
        const deps = { platform: 'win32', dlls, startHelper: (/** @type {any} */ x) => startAdsHelper({ ...x, spawn: fake.spawn, platform: 'win32' }) };
        const session = createOnlineSession({ createClient: (opts) => createAdsClient(opts, deps), log: () => {}, statusIntervalMs: 50 });
        const o = { ...base, targetAmsNetId: '10.0.0.4.1.1', dlls };
        let e = null;
        try { await session.connect(o); } catch (x) { e = x; }
        const a = fake.spawned[0] ? fake.spawned[0].args : [];
        assert(a[a.indexOf('-AdsDll') + 1] === dlls.dotNetLibrary && a[a.indexOf('-AdsNativeDir') + 1] === dlls.nativeDllFolder,
            'the session\'s helper gets both configured paths');
        const f = describeConnectError(e, o);
        assert(f.kind === 'helper-unavailable' && f.setting === SETTING_ADS_NATIVE_DLL_FOLDER && /TcAdsDll\.dll was not found in the configured folder D:\\TC\\Common64\./.test(f.message)
            && f.hint === adsDllHint('native', { configured: true }) && /used as given/.test(f.hint),
            `a configured TcAdsDll.dll folder without the DLL: named with the folder, "correct or clear" (${f.message} ${f.hint})`);
    }
    fake = createFakeHelperSpawn(plc, { ready: { id: 0, event: 'ready', ok: false, kind: 'dll-not-found', dllName: 'TwinCAT.Ads.dll', configured: true,
        error: 'TwinCAT.Ads.dll was not found at the configured path D:\\TC\\TwinCAT.Ads.dll.' } });
    t = await tryConnect(fake, { ...base, targetAmsNetId: '10.0.0.4.1.1' });
    assert(t.f && t.f.setting === SETTING_ADS_DOTNET_LIBRARY && /at the configured path D:\\TC\\TwinCAT\.Ads\.dll\./.test(t.f.message) && /used as given/.test(t.f.hint),
        `a configured TwinCAT.Ads.dll that does not exist: the path and the setting are named (${t.f && t.f.message})`);
    fake = createFakeHelperSpawn(plc, { ready: { id: 0, event: 'ready', ok: false, kind: 'dll-load', dllName: 'TwinCAT.Ads.dll', configured: false,
        error: 'TwinCAT.Ads.dll did not load: C:\\x\\TwinCAT.Ads.dll: bad image' } });
    t = await tryConnect(fake, { ...base, targetAmsNetId: '10.0.0.4.1.1' });
    assert(t.f && t.f.setting === SETTING_ADS_DOTNET_LIBRARY && t.f.hint === adsDllHint('managed'), 'a DLL that did not load: the TwinCAT.Ads.dll setting is offered');
    // TcAdsDll.dll is loaded on the first request: a missing one fails "open" with DllNotFoundException.
    fake = createFakeHelperSpawn(plc, { intercept: (req) => (req.cmd === 'open'
        ? { ok: false, error: 'Unable to load DLL \'TcAdsDll.dll\': The specified module could not be found. (Exception from HRESULT: 0x8007007E)' } : null) });
    t = await tryConnect(fake, { ...base, targetAmsNetId: '10.0.0.4.1.1' });
    assert(t.f && t.f.kind === 'helper-unavailable' && t.f.setting === SETTING_ADS_NATIVE_DLL_FOLDER && /could not load TcAdsDll\.dll\.$/.test(t.f.message)
        && t.f.hint === adsDllHint('native'), `TcAdsDll.dll missing at the first request: the folder setting is offered (${t.f && t.f.message})`);

    fake = createFakeHelperSpawn(plc);
    t = await tryConnect(fake, { ...base, targetAmsNetId: 'localhost', label: 'Local runtime' });
    assert(t.f && t.f.kind === 'no-route' && /^The local router refused a TCP connection, so TC Toolkit used TwinCAT's ADS DLL, but the router does not know the local runtime \(ADS error 0x7\)\.$/.test(t.f.message) && t.f.hint === RUNTIME_NETID_HINT,
        `the local runtime at the router's own NetId: points at Enter AMS Net ID with the runtime's NetId (${t.f && t.f.message})`);
    assert(/Enter AMS Net ID/.test(RUNTIME_NETID_HINT) && /console window \("AmsNetId: …"\)/.test(RUNTIME_NETID_HINT) && /10\.0\.0\.4\.1\.1/.test(RUNTIME_NETID_HINT),
        'the hint names the console window\'s "AmsNetId:" line, with an example NetId');
    assert(fake.spawned.length === 1 && fake.spawned[0].exited, 'the failed helper does not outlive the attempt');

    fake = createFakeHelperSpawn(plc);
    t = await tryConnect(fake, { ...base, targetAmsNetId: '10.0.0.5.1.1' });
    assert(t.f && t.f.kind === 'no-route' && /the router does not know 10\.0\.0\.5\.1\.1 \(ADS error 0x7\): the runtime is not running, or there is no route/.test(t.f.message),
        `a runtime that is not running (0x7) (${t.f && t.f.message})`);

    fake = createFakeHelperSpawn(plc);
    t = await tryConnect(fake, { ...base, targetAmsNetId: '10.0.0.4.1.1', targetAdsPort: 852 });
    assert(t.f && t.f.kind === 'no-plc' && /no PLC runtime answers on ADS port 852 at 10\.0\.0\.4\.1\.1 \(ADS error 0x6\)/.test(t.f.message),
        `no PLC on the port (0x6) (${t.f && t.f.message})`);

    // No fallback off Windows: the reset is called a reset, never "No ADS router answered".
    let spawned = 0;
    const linux = createOnlineSession({ createClient: (o) => createAdsClient(o, { platform: 'linux', startHelper: () => { spawned++; return Promise.reject(new Error('no')); } }) });
    let err = null;
    const o = { ...base, targetAmsNetId: '10.0.0.4.1.1' };
    try { await linux.connect(o); } catch (e) { err = e; }
    const f = describeConnectError(err, o);
    assert(spawned === 0 && f.kind === 'router-reset' && /^The ADS router at 127\.0\.0\.1:48898 answered but reset this client's TCP connection\.$/.test(f.message) &&
        f.hint === USER_MODE_HINT && !/No ADS router answered/.test(f.message), `off Windows: no helper, and the reset is named a reset (${f.message})`);
    assert(/switches to TwinCAT's own ADS DLL by itself/.test(USER_MODE_HINT) && /kernel-mode/.test(USER_MODE_HINT), 'the user-mode hint mentions the automatic fallback and the kernel-mode workaround');
    const fw = describeConnectError({ message: 'x', trace: ['connectToTarget(): Connecting to 127.0.0.1:48898 failed (socket error -4077)'] }, o);
    assert(fw.kind === 'router-reset', 'the measured Windows text (-4077) is a reset');

    // Direct mode keeps today's path (a remote router is covered by isRouterRefusal above).
    for (const [name, opts] of [['direct mode', { mode: 'direct', routerAddress: '127.0.0.1', routerTcpPort: router.port, localAmsNetId: '10.0.0.8.1.1', localAdsPort: 32750, targetAmsNetId: '10.0.0.4.1.1', targetAdsPort: 851 }]]) {
        spawned = 0;
        const s = createOnlineSession({ createClient: (x) => createAdsClient(x, { platform: 'win32', startHelper: () => { spawned++; return Promise.reject(new Error('no')); } }) });
        err = null;
        try { await s.connect(/** @type {any} */ (opts)); } catch (e) { err = e; }
        assert(err && spawned === 0 && !err.fallback, `${name}: no fallback`);
    }
    router.server.close();
}

(async () => {
    contract();
    scriptContract();
    await helperProcess();
    trigger();
    await endToEnd();
    await helperDies();
    await failures();
    if (errors) {
        console.error(`\n${errors} ADS helper assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll ADS helper assertions passed.');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
