/**
 * @file test_ads_write.js
 * @description Online monitoring (R15): the write path (src/online/writeGuard.js), against the
 * in-memory PLC of test/_fakeAds.js, with the dialogs and the output channel recorded.
 *
 * User decisions D2/D5 (2026-11-13) under test: writes are OFF by default (the setting refuses
 * without asking anything); with the setting on, writes are enabled once per online session through
 * a modal; every write needs the modal confirmation, which names the target, the path, the old and
 * new values and the PLC state, and is never called "Force"; a refused or cancelled write never
 * reaches the PLC; writes are blocked while the project differs or cannot be checked, while an editor
 * has unsaved edits, and when the symbol's online type differs from its declaration — re-checked
 * after the dialog; every attempt and outcome is logged.
 */

'use strict';

const { createOnlineSession } = require('../src/online/session');
const { performWrite, WRITE_BUTTON, ENABLE_BUTTON } = require('../src/online/writeGuard');
const { createFakePlc, dataType } = require('./_fakeAds');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

(async () => {
    const plc = createFakePlc({ symbols: {
        'MAIN.nCount': { type: 'INT', value: 7 },
        'MAIN.eState': { type: 'E_State', value: { name: 'Idle', value: 0 },
            dataType: dataType('E_State', { size: 2, enumInfos: [{ name: 'Idle', value: 0 }, { name: 'Running', value: 1 }] }) },
        'MAIN.stData': { type: 'ST_Data', value: { a: 1 }, dataType: dataType('ST_Data', { subItems: [{ name: 'a', type: 'INT' }] }) }
    } });
    const session = createOnlineSession({ createClient: plc.createClient, statusIntervalMs: 1000 });

    const log = [];
    const dialogs = [];
    const inputs = [];
    const world = {
        allow: false, project: /** @type {'match'|'differs'|'unknown'} */ ('match'), dirty: false,
        confirmAnswers: /** @type {boolean[]} */ ([]), inputAnswers: /** @type {Array<string|undefined>} */ ([]),
        duringConfirm: /** @type {(() => void)|null} */ (null)
    };
    const sessionWrites = { enabled: false };
    const deps = {
        session, sessionWrites,
        allowWrites: () => world.allow,
        projectState: () => world.project,
        hasUnsavedEdits: () => world.dirty,
        input: async (o) => { inputs.push(o); return world.inputAnswers.shift(); },
        confirm: async (o) => { dialogs.push(o); if (world.duringConfirm) world.duringConfirm(); return !!world.confirmAnswers.shift(); },
        log: (l) => log.push(l)
    };
    const write = (path, extra = {}) => performWrite({ path, localType: 'INT', source: 'editor', ...extra }, deps);

    // offline
    let r = await write('MAIN.nCount');
    assert(r.status === 'refused' && /Not online/.test(r.message), 'offline: refused');
    await session.connect({ mode: 'router', targetAmsNetId: 'localhost', targetAdsPort: 851, label: 'Local runtime' });

    // off by default
    r = await write('MAIN.nCount');
    assert(r.status === 'refused' && /tcToolkit\.online\.allowWrites/.test(r.message), 'writes are off by default and the refusal names the setting');
    assert(dialogs.length === 0 && inputs.length === 0 && plc.writes.length === 0, 'and nothing was asked or written');

    // setting on: enable for the session first
    world.allow = true;
    world.confirmAnswers = [false];
    r = await write('MAIN.nCount');
    assert(r.status === 'cancelled' && dialogs[0].button === ENABLE_BUTTON && /for this online session/.test(dialogs[0].message),
        'with the setting on, the first write asks to enable writes for this online session');
    assert(!sessionWrites.enabled && plc.writes.length === 0, 'declining leaves writes off and nothing written');

    world.confirmAnswers = [true, false];
    world.inputAnswers = ['12'];
    r = await write('MAIN.nCount');
    assert(sessionWrites.enabled, 'accepting enables writes for the session');
    const modal = dialogs[dialogs.length - 1];
    assert(r.status === 'cancelled' && modal.button === WRITE_BUTTON, 'every write then needs the modal confirmation; cancelling it cancels the write');
    assert(/Write 12 to MAIN\.nCount on Local runtime\?/.test(modal.message) && /Current value: 7/.test(modal.detail)
        && /New value: 12/.test(modal.detail) && /PLC state: Run/.test(modal.detail), `the modal names target, path, old and new values and the PLC state (${modal.message} / ${modal.detail})`);
    assert(!/force/i.test(modal.button) && /It is not a force/.test(modal.detail), 'nothing is called "Force"; the modal says a write is not one');
    assert(plc.writes.length === 0, 'a cancelled write never reaches the PLC');
    assert(inputs[inputs.length - 1].value === '7' && inputs[inputs.length - 1].validate('99999') && inputs[inputs.length - 1].validate('5') === null,
        'the input box starts at the current value and validates against the type');

    world.confirmAnswers = [true];
    world.inputAnswers = ['12'];
    r = await write('MAIN.nCount');
    assert(r.status === 'written' && plc.get('MAIN.nCount') === 12 && plc.writes.length === 1, 'a confirmed write is written once');
    assert(dialogs.filter(d => d.button === ENABLE_BUTTON).length === 2, 'the session enable is not asked again once given');
    assert(log.some(l => /Write requested: MAIN\.nCount = 12 on Local runtime \(current 7, from the editor\)/.test(l))
        && log.some(l => /Written: MAIN\.nCount = 12 on Local runtime \(was 7\)/.test(l)), 'request and result are logged');

    world.confirmAnswers = [true];
    world.inputAnswers = ['Running'];
    r = await write('MAIN.eState', { localType: 'E_State', source: 'watch' });
    assert(r.status === 'written' && plc.writes[1].value === 'Running', 'an enum is written by name');

    // guards
    const before = plc.writes.length;
    world.project = 'differs';
    r = await write('MAIN.nCount');
    assert(r.status === 'refused' && /different project/.test(r.message), 'blocked while the PLC runs a different project');
    world.project = 'unknown';
    r = await write('MAIN.nCount');
    assert(r.status === 'refused' && /could not be checked/.test(r.message), 'blocked while the project cannot be checked');
    world.project = 'match';
    world.dirty = true;
    r = await write('MAIN.nCount');
    assert(r.status === 'refused' && /unsaved edits/.test(r.message), 'blocked while an editor has unsaved edits');
    world.dirty = false;
    r = await write('MAIN.nCount', { localType: 'DINT' });
    assert(r.status === 'refused' && /INT on the PLC but DINT in the project/.test(r.message), 'blocked when the online type differs from the declaration');
    r = await write('MAIN.stData', { localType: 'ST_Data' });
    assert(r.status === 'refused' && /Only single values/.test(r.message), 'a struct is never written');
    r = await write('MAIN.nGuess');
    assert(r.status === 'refused' && /no symbol MAIN\.nGuess/.test(r.message), 'a path the PLC does not know is refused');
    r = await performWrite({ path: null, reason: 'method-local', source: 'editor' }, deps);
    assert(r.status === 'refused' && /Method locals/.test(r.message), 'a method local is refused with the reason');
    world.confirmAnswers = [true];
    world.inputAnswers = ['3'];
    world.duringConfirm = () => { world.dirty = true; };
    r = await write('MAIN.nCount');
    assert(r.status === 'refused' && /unsaved edits/.test(r.message), 'the guards are checked again after the dialog');
    world.duringConfirm = null;
    world.dirty = false;
    assert(plc.writes.length === before, 'no refused write reached the PLC');
    assert(log.filter(l => /^Write refused/.test(l)).length >= 7, 'refusals are logged');

    // a failing write
    world.confirmAnswers = [true];
    world.inputAnswers = ['4'];
    plc.removeSymbol('MAIN.nCount');
    const resolvedBefore = await session.resolve('MAIN.nCount');
    r = await write('MAIN.nCount');
    assert(resolvedBefore.ok && r.status === 'failed' && log.some(l => /Write FAILED: MAIN\.nCount/.test(l)),
        'a write the PLC rejects is reported and logged as failed');

    await session.disconnect();
    if (errors) { console.error(`\n${errors} ADS write assertion(s) failed`); process.exit(1); }
    console.log('\nAll ADS write assertions passed.');
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
