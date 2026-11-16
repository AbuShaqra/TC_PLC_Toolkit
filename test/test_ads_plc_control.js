/**
 * @file test_ads_plc_control.js
 * @description Online monitoring (R15): Start / Stop PLC (src/online/plcControl.js and
 * session.controlPlc; user request 2026-11-16), against the in-memory PLC of test/_fakeAds.js, with
 * the modal and the output channel recorded.
 *
 * Under test: the toggle offers Start only in Stop and Stop only in Run, and neither offline, before
 * the state is read, in any other state (Config, Error, …), while the connection is re-established or
 * while a request runs; every start and stop is confirmed by a modal naming the target (label and AMS
 * address) with one confirm button, and is NOT gated by `tcToolkit.online.allowWrites` (there is no
 * such dependency here at all); a refused or cancelled one never reaches the PLC; the connection and
 * the PLC state are checked again after the modal; the new state is read at once (no wait for the
 * status poll); a failure names the ADS error; every attempt and outcome is logged with the target.
 */

'use strict';

const { createOnlineSession } = require('../src/online/session');
const { performPlcControl, toggleState, actionFor, failureText } = require('../src/online/plcControl');
const { createFakePlc } = require('./_fakeAds');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

(async () => {
    // ── the toggle's mapping ──────────────────────────────────────────────────────────────────────
    assert(actionFor('Run') === 'stop' && actionFor('Stop') === 'start' && actionFor('run') === 'stop',
        'Run offers Stop, Stop offers Start');
    assert(['Config', 'Error', 'Exception', 'Invalid', 'Init', 'Unknown', null, undefined, ''].every(s => actionFor(/** @type {any} */ (s)) === null),
        'any other state (Config, Error, Exception, Invalid, Init, unknown) offers neither');
    const fakeSession = (state, plcState, lost = false) => ({ state, info: { plcState, lost } });
    let t = toggleState(/** @type {any} */ (fakeSession('offline', null)));
    assert(!t.online && t.action === null && /Not online/.test(t.reason), 'offline: no toggle');
    t = toggleState(/** @type {any} */ (fakeSession('connecting', 'Run')));
    assert(!t.online && t.action === null, 'connecting: no toggle');
    t = toggleState(/** @type {any} */ (fakeSession('online', null)));
    assert(t.online && t.action === null && /not been read/.test(t.reason), 'online, state not read yet: disabled, with the reason');
    t = toggleState(/** @type {any} */ (fakeSession('online', 'Config')));
    assert(t.action === null && /The PLC is in Config: Start and Stop are offered in Stop and Run only\./.test(t.reason), `Config: disabled (${t.reason})`);
    t = toggleState(/** @type {any} */ (fakeSession('online', 'Run', true)));
    assert(t.action === null && /re-established/.test(t.reason), 'a lost connection (reconnecting): disabled');
    t = toggleState(/** @type {any} */ (fakeSession('online', 'Run')), true);
    assert(t.action === null && t.busy && /in progress/.test(t.reason), 'while a request runs: disabled');
    assert(failureText({ adsError: { errorCode: 0x712, errorStr: 'Server is in invalid state' } }) === 'ADS error 0x712 (Server is in invalid state)'
        && failureText(new Error('Timeout')) === 'Timeout', 'a failure names the ADS error code and its text');

    // ── against the in-memory PLC ─────────────────────────────────────────────────────────────────
    const plc = createFakePlc({ symbols: { 'MAIN.nCount': { type: 'INT', value: 1 } } });
    const session = createOnlineSession({ createClient: plc.createClient, statusIntervalMs: 60000 });
    const log = [];
    const dialogs = [];
    const world = { answers: /** @type {boolean[]} */ ([]), duringConfirm: /** @type {(() => any)|null} */ (null) };
    const guard = { busy: false };
    const deps = {
        session, guard, log: (l) => log.push(l),
        confirm: async (o) => {
            dialogs.push(o);
            if (world.duringConfirm) await world.duringConfirm();
            return !!world.answers.shift();
        }
    };

    let r = await performPlcControl('stop', deps);
    assert(r.status === 'refused' && /Not online/.test(r.message) && dialogs.length === 0 && plc.controls.length === 0, 'offline: refused, no modal, nothing sent');

    await session.connect({ mode: 'router', targetAmsNetId: '10.0.0.4.1.1', targetAdsPort: 851, label: 'Line 1' });
    assert(session.info.plcState === 'Run', 'online, the PLC runs');

    r = await performPlcControl('start', deps);
    assert(r.status === 'refused' && /The PLC is in Run/.test(r.message) && dialogs.length === 0 && plc.controls.length === 0,
        `Start while the PLC runs: refused before any modal (${r.message})`);

    // cancelled
    world.answers = [false];
    r = await performPlcControl('stop', deps);
    const d = dialogs[0];
    assert(r.status === 'cancelled' && plc.controls.length === 0 && plc.state === 'Run', 'cancelled: nothing reaches the PLC');
    assert(d && d.message === 'Stop the PLC on Line 1 (10.0.0.4.1.1:851)?' && d.button === 'Stop PLC' && typeof d.detail === 'string',
        `the modal names the target (label and AMS address), with one confirm button (${d && d.message} / ${d && d.button})`);
    assert(log.some(l => l === 'PLC stop on Line 1 (10.0.0.4.1.1:851): cancelled.'), 'the cancel is logged with the target');
    assert(!guard.busy, 'the busy flag is released after a cancel');

    // stop, confirmed
    world.answers = [true];
    let busyDuring = false;
    world.duringConfirm = () => { busyDuring = guard.busy; };
    const events = [];
    const sub = session.onDidChange((w) => events.push(w));
    r = await performPlcControl('stop', deps);
    world.duringConfirm = null;
    assert(busyDuring, 'busy while the modal is open (a second click is refused)');
    assert(r.status === 'done' && r.state === 'Stop' && plc.controls.join() === 'stop' && plc.state === 'Stop',
        `confirmed: the PLC is stopped (${r.status}, ${r.state})`);
    assert(session.info.plcState === 'Stop' && events.includes('info'), 'the new state is read at once (no wait for the status poll) and announced');
    assert(toggleState(session).action === 'start', 'the toggle now offers Start');
    assert(log.some(l => /^PLC stop on Line 1 \(10\.0\.0\.4\.1\.1:851\): sending \(PLC state Run\)\.$/.test(l))
        && log.some(l => /^PLC stop on Line 1 \(10\.0\.0\.4\.1\.1:851\): done \(PLC state now Stop\)\.$/.test(l)),
    'the attempt and the result are logged with the target');
    sub.dispose();

    // start, confirmed
    world.answers = [true];
    r = await performPlcControl('start', deps);
    assert(r.status === 'done' && plc.state === 'Run' && session.info.plcState === 'Run' && dialogs[dialogs.length - 1].message === 'Start the PLC on Line 1 (10.0.0.4.1.1:851)?'
        && dialogs[dialogs.length - 1].button === 'Start PLC', 'Start: its own modal and button; the PLC runs again');

    // busy: a second request while one waits on its modal
    world.answers = [false];
    let release;
    world.duringConfirm = () => new Promise((res) => { release = res; });
    const first = performPlcControl('stop', deps);
    await new Promise(res => setImmediate(res));
    const second = await performPlcControl('stop', deps);
    assert(second.status === 'refused' && /already in progress/.test(second.message), 'a second request while one runs is refused');
    release();
    await first;
    world.duringConfirm = null;

    // the PLC state changes while the modal is open
    world.answers = [true];
    world.duringConfirm = () => { session.info.plcState = 'Stop'; };
    const before = plc.controls.length;
    r = await performPlcControl('stop', deps);
    world.duringConfirm = null;
    assert(r.status === 'refused' && /changed to Stop while the dialog was open; nothing was sent/.test(r.message) && plc.controls.length === before,
        `a state change during the modal refuses, nothing sent (${r.message})`);
    session.info.plcState = 'Run';

    // the connection changes while the modal is open
    world.answers = [true];
    world.duringConfirm = async () => {
        await session.connect({ mode: 'router', targetAmsNetId: '10.0.0.5.1.1', targetAdsPort: 851, label: 'Line 2' });
    };
    r = await performPlcControl('stop', deps);
    world.duringConfirm = null;
    assert(r.status === 'refused' && /connection changed/.test(r.message) && plc.controls.length === before,
        `a Go Online elsewhere during the modal refuses, nothing sent (${r.message})`);
    let threw = false;
    try { await session.controlPlc('stop', { connectionId: -1, netId: 'x', port: 1, mode: 'router', label: 'x' }); } catch (e) { threw = /connection changed/.test(String(e.message)); }
    assert(threw && plc.controls.length === before, 'session.controlPlc itself refuses another connection');

    // a failure
    plc.controlError = Object.assign(new Error('stopPlc(): Stopping PLC runtime failed'), { adsError: { errorCode: 0x712, errorStr: 'Server is in invalid state' } });
    world.answers = [true];
    r = await performPlcControl('stop', deps);
    assert(r.status === 'failed' && r.message === 'Stopping the PLC failed: ADS error 0x712 (Server is in invalid state)',
        `a failure is shown with the ADS error (${r.message})`);
    assert(log.some(l => /^PLC stop on Line 2 \(10\.0\.0\.5\.1\.1:851\) FAILED: ADS error 0x712 \(Server is in invalid state\)$/.test(l)), 'and logged');
    assert(!guard.busy, 'the busy flag is released after a failure');

    // unknown action (a webview message is untrusted)
    r = await performPlcControl(/** @type {any} */ ('reset'), deps);
    assert(r.status === 'refused' && /Unknown action/.test(r.message), 'an unknown action is refused');

    await session.disconnect();
    if (errors) {
        console.error(`\n${errors} Start/Stop PLC assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll Start/Stop PLC assertions passed.');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
