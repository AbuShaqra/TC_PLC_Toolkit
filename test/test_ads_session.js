/**
 * @file test_ads_session.js
 * @description Online monitoring (R15): the connection and everything read through it, against the
 * in-memory PLC of test/_fakeAds.js — plus the ads-client adapter's contract against a stand-in of
 * ads-client's own Client class.
 *
 * Covers: connect and disconnect leave no connection open; a cancelled or superseded Go Online closes
 * the client it started, even when the connect settles after the cancel; deactivation (disconnect)
 * waits for background closes; connect errors become the right message, including the clear
 * user-mode-runtime explanation (D4) and never a silent fallback to direct mode (D3); the status poll
 * reads the project name, the forces indicator (and "not reported" on older runtimes) and drops
 * resolved symbols on an online change; paths are checked against the PLC; sum reads; the
 * notification cap; FB instance discovery.
 */

'use strict';

const { createOnlineSession } = require('../src/online/session');
const { buildClientSettings, createAdsClient, stateOf } = require('../src/online/adsClient');
const { describeConnectError, USER_MODE_HINT } = require('../src/online/connectErrors');
const { createFakePlc, fakeAdsClientClass, dataType, encode } = require('./_fakeAds');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const ROUTER = { mode: 'router', targetAmsNetId: 'localhost', targetAdsPort: 851 };

/** A cancellation token like VS Code's. */
function token() {
    const fns = [];
    return { isCancellationRequested: false, onCancellationRequested: (fn) => { fns.push(fn); return { dispose() {} }; },
        cancel() { this.isCancellationRequested = true; fns.forEach(f => f()); } };
}

function samplePlc(extra = {}) {
    return createFakePlc({
        symbols: {
            'MAIN.nCount': { type: 'INT', value: 7 },
            'MAIN.bRun': { type: 'BOOL', value: true },
            'MAIN.fbA': { type: 'FB_Station', value: { _eState: 1 }, dataType: dataType('FB_Station', { subItems: [{ name: '_eState', type: 'INT', subItems: [] }] }) },
            'MAIN.fbA._eState': { type: 'INT', value: 1 },
            'GVL_System.fbStation': { type: 'FB_Station', value: {}, dataType: dataType('FB_Station', { subItems: [{ name: '_eState', type: 'INT', subItems: [] }] }) },
            'GVL_System.stCell': { type: 'ST_Cell', value: {}, dataType: dataType('ST_Cell', { subItems: [
                { name: 'fbInner', type: 'FB_Station', subItems: [{ name: '_eState', type: 'INT', subItems: [] }] },
                { name: 'aFbs', type: 'ARRAY [1..2] OF FB_Station', arrayInfos: [{ startIndex: 1, length: 2 }], subItems: [] }] }) },
            'GVL_System.fbDerived': { type: 'FB_StationDerived', value: {}, dataType: dataType('FB_StationDerived') },
            'GVL_Io.nBig': { type: 'LINT', value: 9007199254740993n },
            ...extra
        }
    });
}

(async () => {
    // ── adapter: settings and the never-direct-by-accident rule ───────────────────────────────────
    const router = buildClientSettings({ mode: 'router', targetAmsNetId: 'localhost', targetAdsPort: 851 });
    assert(router.routerAddress === '127.0.0.1' && router.routerTcpPort === 48898,
        'router mode goes to the local router at 127.0.0.1:48898 by default');
    assert(!('localAmsNetId' in router) && !('localAdsPort' in router),
        'router mode never sets a local AmsNetId or ADS port (that would make it a direct connection)');
    assert(router.hideConsoleWarnings === true && router.autoReconnect === true, 'console warnings are off, reconnect is on');
    const routed = buildClientSettings({ mode: 'router', targetAmsNetId: '5.1.2.3.1.1', targetAdsPort: 852, routerAddress: '10.1.1.1' });
    assert(routed.routerAddress === '10.1.1.1' && !('localAmsNetId' in routed), 'a router-address setting moves the router, still not direct');
    let threw = null;
    try { buildClientSettings({ mode: 'direct', targetAmsNetId: '5.1.2.3.1.1', targetAdsPort: 851, routerAddress: '192.168.1.5' }); } catch (e) { threw = e; }
    assert(threw && /localAmsNetId/.test(threw.message), 'direct mode without its settings is refused, not guessed');
    const direct = buildClientSettings({ mode: 'direct', targetAmsNetId: '5.1.2.3.1.1', targetAdsPort: 851, routerAddress: '192.168.1.5', localAmsNetId: '192.168.1.20.1.1', localAdsPort: 32750 });
    assert(direct.routerAddress === '192.168.1.5' && direct.localAmsNetId === '192.168.1.20.1.1' && direct.localAdsPort === 32750,
        'direct mode connects to the PLC with the configured local address');

    const { Client, instances } = fakeAdsClientClass();
    const port = createAdsClient(ROUTER, { Client });
    const raw = instances[0];
    const connecting = port.connect();
    await tick();
    const closing = port.disconnect();
    let closedEarly = false;
    closing.then(() => { closedEarly = true; });
    await tick(5);
    assert(!closedEarly, 'the adapter\'s disconnect waits for an in-flight connect (ads-client ignores a disconnect then)');
    raw.connectGate.resolve();
    let cancelErr = null;
    try { await connecting; } catch (e) { cancelErr = e; }
    await closing;
    assert(cancelErr && cancelErr.cancelled, 'a connect that settles after the disconnect reports cancelled');
    assert(raw.calls.includes('disconnect(force)') && !raw.connected, 'and the connection it opened is closed');
    const port2 = createAdsClient(ROUTER, { Client });
    const raw2 = instances[1];
    const c2 = port2.connect();
    raw2.connectGate.resolve();
    await c2;
    let got = null;
    await port2.subscribeRaw({ indexGroup: 1, indexOffset: 2, size: 8 }, 200, (b) => { got = b; });
    assert(raw2.calls.some(c => c === 'subscribeRaw(1,2,8,200,true)'),
        'subscriptions use subscribeRaw on change (issue #189: no library-side parse of the value)');
    raw2.lastCallback({ value: Buffer.from([1, 2]) });
    assert(Buffer.isBuffer(got) && got.length === 2, 'the raw bytes reach the caller, converted outside the library');
    assert(stateOf({ adsState: 5 }).state === 'Run' && stateOf({ adsState: 6, adsStateStr: 'Stop' }).state === 'Stop', 'ADS states are named');
    await port2.disconnect();
    await port2.disconnect();
    assert(raw2.calls.filter(c => c === 'disconnect').length === 1, 'disconnect is idempotent');

    // ── connect / disconnect ──────────────────────────────────────────────────────────────────────
    let plc = samplePlc();
    const lines = [];
    let session = createOnlineSession({ createClient: plc.createClient, log: (l) => lines.push(l), statusIntervalMs: 20 });
    const states = [];
    session.onDidChange((w) => { if (w === 'state') states.push(session.state); });
    await session.connect({ ...ROUTER, label: 'Local runtime' });
    assert(session.state === 'online' && plc.openConnections === 1, 'connect opens one connection');
    assert(session.info.plcState === 'Run' && session.info.projectName === 'TcToolkitSample_PLC',
        `the status poll reads the runtime state and _AppInfo.ProjectName (${JSON.stringify(session.info)})`);
    assert(session.info.forces && session.info.forces.plc === false && session.info.forces.io === false, 'forces: none active');
    assert(lines.some(l => /Online: Local runtime \(through the local router\)/.test(l)), 'going online is logged with the mode');
    plc.appInfo.forces = { plc: true, io: false };
    await tick(60);
    assert(session.info.forces.plc === true, 'the forces indicator follows ActivePlcForces while online');
    await session.disconnect();
    assert(session.state === 'offline' && plc.openConnections === 0, 'disconnect closes it');
    assert(JSON.stringify(states) === JSON.stringify(['connecting', 'online', 'offline']), `state changes are announced (${states})`);
    await session.disconnect();
    assert(plc.openConnections === 0, 'a second disconnect is harmless');

    // ── an older runtime: forces not reported ─────────────────────────────────────────────────────
    plc = samplePlc();
    plc.appInfo.forces = null;
    session = createOnlineSession({ createClient: plc.createClient });
    await session.connect(ROUTER);
    assert(session.info.forces === null, 'a runtime without ActivePlcForces reports forces as "not reported" (null), not as none');
    await session.disconnect();

    // ── cancel ────────────────────────────────────────────────────────────────────────────────────
    plc = samplePlc();
    plc.connectBehavior = { delayMs: 30 };
    session = createOnlineSession({ createClient: plc.createClient });
    const t = token();
    const p = session.connect(ROUTER, t);
    await tick(5);
    t.cancel();
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert(err && err.cancelled && session.state === 'offline', 'Go Online is cancellable while connecting');
    await tick(50);
    assert(plc.openConnections === 0, 'and the late-arriving connection is not left open');
    // superseded: a second connect while the first is in flight
    plc.connectBehavior = { delayMs: 20 };
    const first = session.connect(ROUTER).catch(e => e);
    await tick(2);
    plc.connectBehavior = {};
    await session.connect(ROUTER);
    const firstErr = await first;
    assert(firstErr && firstErr.cancelled, 'a newer Go Online supersedes the one in flight');
    await tick(30);
    assert(plc.openConnections === 1 && session.state === 'online', 'only the newer connection stays open');
    // deactivate while a cancelled connect is still closing
    plc.connectBehavior = { delayMs: 40 };
    const t2 = token();
    const p2 = session.connect(ROUTER, t2).catch(e => e);
    await tick(5);
    t2.cancel();
    await p2;
    await session.disconnect();
    assert(plc.openConnections === 0 && session.closingCount === 0,
        'deactivation (disconnect) waits for background closes: no connection is left after it resolves');

    // ── connect errors ────────────────────────────────────────────────────────────────────────────
    plc = samplePlc();
    plc.connectBehavior = { error: Object.assign(new Error('connectToTarget(): Connecting to 127.0.0.1:48898 failed (socket error -4078)'), { trace: ['connect(): Connecting to target failed', 'connectToTarget(): Connecting to 127.0.0.1:48898 failed (socket error -4078)'] }) };
    session = createOnlineSession({ createClient: plc.createClient });
    err = null;
    try { await session.connect(ROUTER); } catch (e) { err = e; }
    const noRouter = describeConnectError(err, ROUTER);
    assert(noRouter.kind === 'no-router' && /No ADS router answered at 127\.0\.0\.1:48898/.test(noRouter.message),
        `no router: says so (${noRouter.message})`);
    assert(noRouter.hint.includes(USER_MODE_HINT) && /user-mode runtime/.test(noRouter.hint) && /kernel-mode/.test(noRouter.hint),
        'and explains the 4026 user-mode runtime with the documented workarounds');
    assert(plc.clients.length === 1 && plc.clients[0].options.mode === 'router',
        'a failed router connect is NOT retried in direct mode (D3)');
    const portFail = describeConnectError({ message: 'x', trace: ['connect(): failed', 'connectToTarget(): Registering ADS port failed', 'registerAdsPort(): Timeout - no response in 2000 ms'] }, ROUTER);
    assert(portFail.kind === 'port-registration' && portFail.hint === USER_MODE_HINT,
        'a router that does not register our port gets the user-mode explanation');
    const noRoute = describeConnectError({ message: 'x', adsError: { errorCode: 7 }, trace: ['x'] }, { ...ROUTER, targetAmsNetId: '5.1.2.3.1.1' });
    assert(noRoute.kind === 'no-route' && /no route to 5\.1\.2\.3\.1\.1/.test(noRoute.message) && /XAE/.test(noRoute.hint) && /never creates routes/.test(noRoute.hint),
        'no route: points at XAE, and says the extension never creates one (D7)');
    const noPlc = describeConnectError({ message: 'x', adsError: { errorCode: 6 }, trace: ['x'] }, ROUTER);
    assert(noPlc.kind === 'no-plc' && /port 851/.test(noPlc.message), 'no PLC on the port');
    const halfOpen = describeConnectError({ message: 'x', trace: ['connectToTarget(): Connection failed - failed to set PLC connection. ...'] }, ROUTER);
    assert(halfOpen.kind === 'no-plc' && /CONFIG/.test(halfOpen.hint), 'connected but no PLC program: CONFIG mode / no download');
    const directRefused = describeConnectError({ message: 'x', trace: ['connectToTarget(): Connecting to 192.168.1.5:48898 failed (socket error -111)'] },
        { mode: 'direct', routerAddress: '192.168.1.5', targetAmsNetId: '192.168.1.5.1.1', targetAdsPort: 851 });
    assert(directRefused.kind === 'no-router' && !/user-mode/.test(directRefused.hint), 'direct mode: about the PLC address, not the local router');
    session = createOnlineSession({ createClient: () => { throw new Error('Direct mode needs tcToolkit.online.direct.plcAddress'); } });
    err = null;
    try { await session.connect({ mode: 'direct', targetAmsNetId: 'x', targetAdsPort: 851 }); } catch (e) { err = e; }
    const cfg = describeConnectError(err, ROUTER);
    assert(cfg.kind === 'config' && /plcAddress/.test(cfg.message) && session.state === 'offline', 'a settings error is shown as it is');

    // ── resolve, read, online change ──────────────────────────────────────────────────────────────
    plc = samplePlc();
    session = createOnlineSession({ createClient: plc.createClient, statusIntervalMs: 15, log: (l) => lines.push(l) });
    await session.connect(ROUTER);
    const ok = await session.resolve('MAIN.nCount');
    const missing = await session.resolve('MAIN.nGuessed');
    assert(ok.ok && ok.scalar && ok.symbol.type === 'INT', 'a path the PLC knows resolves, with its type');
    assert(!missing.ok, 'a path the PLC does not know does not resolve (never read)');
    const fb = await session.resolve('MAIN.fbA');
    assert(fb.ok && !fb.scalar, 'an FB instance resolves but is not a scalar');
    plc.noDataType.add('lint');
    const big = await session.resolve('GVL_Io.nBig');
    assert(big.ok && big.dataType, 'a type the PLC will not describe by name falls back to the readValue data type');
    const values = await session.readMany([ok, big]);
    assert(values.get('MAIN.nCount').value === 7 && values.get('GVL_Io.nBig').value === 9007199254740993n,
        'readMany decodes every value of one sum read, 64-bit values exactly');
    assert(plc.sumReads === 1, 'one sum command for the batch');
    const symbolsEvents = [];
    session.onDidChange((w) => { if (w === 'symbols') symbolsEvents.push(w); });
    plc.appInfo.OnlineChangeCnt = 2;
    await tick(50);
    assert(symbolsEvents.length === 1 && lines.some(l => /Online change detected/.test(l)),
        'an online change (OnlineChangeCnt) drops the resolved symbols and says so');
    plc.removeSymbol('MAIN.nCount');
    const after = await session.resolve('MAIN.nCount');
    assert(!after.ok, 'after it, a path is checked against the PLC again');
    await session.disconnect();

    // ── notification cap ──────────────────────────────────────────────────────────────────────────
    let max = 2;
    session = createOnlineSession({ createClient: plc.createClient, maxNotifications: () => max });
    await session.connect(ROUTER);
    const seen = [];
    const s1 = await session.subscribe('MAIN.bRun', 200, (v) => seen.push(v));
    const s2 = await session.subscribe('MAIN.fbA._eState', 200, () => {});
    const s3 = await session.subscribe('GVL_Io.nBig', 200, () => {});
    assert(s1.ok && s2.ok && !s3.ok && s3.capped, 'a subscription past maxNotifications is refused as capped');
    assert(plc.notifications.size === 2, 'the PLC sees exactly the capped number of notifications');
    await tick(5);
    plc.set('MAIN.bRun', false);
    await tick(5);
    assert(seen[seen.length - 1] === false, 'an on-change notification delivers the decoded value');
    await s1.handle.unsubscribe();
    assert(session.subscriptionCount === 1 && plc.notifications.size === 1, 'unsubscribing frees a slot');
    max = 1;
    const s4 = await session.subscribe('GVL_Io.nBig', 200, () => {});
    assert(!s4.ok && s4.capped, 'the cap is read at every subscribe, so a lowered setting applies at once');
    await session.disconnect();
    assert(plc.notifications.size === 0 && plc.openConnections === 0, 'going offline removes every notification and the connection');

    // ── instance discovery ────────────────────────────────────────────────────────────────────────
    plc = samplePlc();
    session = createOnlineSession({ createClient: plc.createClient });
    await session.connect(ROUTER);
    const inst = await session.findInstances(['FB_Station', 'FB_StationDerived']);
    const paths = inst.map(i => i.path).sort();
    assert(JSON.stringify(paths) === JSON.stringify(['GVL_System.fbDerived', 'GVL_System.fbStation', 'GVL_System.stCell.fbInner', 'MAIN.fbA']),
        `instances are found at top level and nested in structs, derived FBs included, arrays left out (${paths})`);
    await session.disconnect();
    assert(encode(1).length > 0, 'fake encodes');

    if (errors) { console.error(`\n${errors} ADS session assertion(s) failed`); process.exit(1); }
    console.log('\nAll ADS session assertions passed.');
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
