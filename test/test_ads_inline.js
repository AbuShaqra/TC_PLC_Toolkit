/**
 * @file test_ads_inline.js
 * @description Online monitoring (R15): the inline values of one editor (src/online/inlineMonitor.js)
 * and how values become text (src/online/values.js), against test/_fakeAds.js.
 *
 * Covers: only paths the PLC knows are shown, only scalars; a declared type that differs from the
 * online one shows "type differs" and never a value; polling at the configured interval with one sum
 * read per tick, posting only when something changed; a hidden editor is not polled; the per-editor
 * path cap and its message; values dim when the PLC is stopped; a project mismatch shows nothing;
 * stop() clears the webview.
 */

'use strict';

const { createOnlineSession } = require('../src/online/session');
const { createInlineMonitor } = require('../src/online/inlineMonitor');
const { formatValue, inlineText, parseInput, typesMatch, isScalar, editText } = require('../src/online/values');
const { createFakePlc, dataType } = require('./_fakeAds');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const ROUTER = { mode: 'router', targetAmsNetId: 'localhost', targetAdsPort: 851 };

/** A pane occurrence as src/online/editorPaths.js produces it, with the ADS path filled in. */
const occ = (line, text, adsPath, localType, pane = 'impl') => ({ componentId: 'root', pane, line, startColumn: 1, endColumn: 1 + text.length,
    eol: pane === 'decl', path: adsPath, adsPath, reason: null, localType, text });

(async () => {
    // ── values ────────────────────────────────────────────────────────────────────────────────────
    assert(formatValue(true) === 'TRUE' && formatValue(false) === 'FALSE', 'BOOL as TRUE/FALSE');
    assert(formatValue(9007199254740993n) === '9007199254740993', '64-bit values exactly');
    assert(formatValue(1.23456789) === '1.234568' && formatValue(42) === '42', 'reals shortened to 7 significant digits');
    assert(formatValue('abc', dataType('STRING(80)')) === "'abc'" && formatValue('w', dataType('WSTRING(10)')) === '"w"', 'strings quoted the ST way');
    assert(formatValue({ name: 'Running', value: 2 }) === 'Running (2)', 'an enum shows its name and value');
    assert(formatValue(1500, dataType('TIME')) === 'T#1500ms', 'TIME as a T# literal');
    assert(inlineText('x'.repeat(100), dataType('STRING(255)')).length === 40, 'inline text is shortened');
    assert(isScalar(dataType('INT')) && !isScalar(dataType('ST_X', { subItems: [{}] })) && !isScalar(dataType('A', { arrayInfos: [{}] })),
        'scalars are values without members or dimensions');
    assert(typesMatch('STRING', 'STRING(80)') === true && typesMatch('ARRAY[0..9] OF INT', 'ARRAY [0..9] OF INT') === true
        && typesMatch('INT', 'DINT') === false && typesMatch(null, 'INT') === null, 'types compare the way the PLC spells them');
    const pInt = parseInput('40000', dataType('INT'));
    assert(!pInt.ok && /-32768 to 32767/.test(pInt.error), 'an INT out of range is refused with the range');
    assert(parseInput('16#FF', dataType('BYTE')).value === 255 && parseInput('-5', dataType('SINT')).value === -5, 'ST integer literals');
    assert(parseInput('9223372036854775807', dataType('LINT')).value === 9223372036854775807n, '64-bit input stays exact (BigInt)');
    assert(parseInput('true', dataType('BOOL')).value === true && !parseInput('yes', dataType('BOOL')).ok, 'BOOL input');
    assert(parseInput('1.5e3', dataType('LREAL')).value === 1500 && !parseInput('1,5', dataType('REAL')).ok, 'REAL input');
    assert(parseInput("'ab'", dataType('STRING(2)')).value === 'ab' && !parseInput('abc', dataType('STRING(2)')).ok, 'STRING input, length checked');
    const en = dataType('E_State', { enumInfos: [{ name: 'Idle', value: 0 }, { name: 'Running', value: 1 }] });
    assert(parseInput('E_State.Running', en).value === 'Running' && parseInput('0', en).value === 'Idle' && !parseInput('Nope', en).ok,
        'enum input by name, qualified name or value');
    assert(editText({ name: 'Idle', value: 0 }, en) === 'Idle' && editText('s', dataType('STRING')) === 's', 'the write box starts from a re-readable text');
    assert(!parseInput('1', dataType('ST_X', { subItems: [{}] })).ok, 'a struct is never written');

    // ── the monitor ───────────────────────────────────────────────────────────────────────────────
    const plc = createFakePlc({ symbols: {
        'MAIN.nCount': { type: 'INT', value: 7 },
        'MAIN.bRun': { type: 'BOOL', value: true },
        'MAIN.sName': { type: 'STRING(80)', value: 'cell' },
        'MAIN.stData': { type: 'ST_Data', value: { a: 1 }, dataType: dataType('ST_Data', { subItems: [{ name: 'a', type: 'INT' }] }) },
        'MAIN.nChanged': { type: 'DINT', value: 1 }
    } });
    const session = createOnlineSession({ createClient: plc.createClient, statusIntervalMs: 1000 });
    await session.connect(ROUTER);
    const posts = [];
    let capped = null;
    const interval = 20;
    const mon = createInlineMonitor({ session, post: (m) => posts.push(m), intervalMs: () => interval, maxPaths: 5,
        onCapped: (n, max) => { capped = { n, max }; } });
    await mon.setOccurrences([
        occ(1, 'nCount', 'MAIN.nCount', 'INT'),
        occ(2, 'nCount', 'MAIN.nCount', 'INT'),
        occ(3, 'bRun', 'MAIN.bRun', 'BOOL'),
        occ(4, 'stData', 'MAIN.stData', 'ST_Data'),
        occ(5, 'nGuess', 'MAIN.nGuess', 'INT'),
        occ(6, 'nChanged', 'MAIN.nChanged', 'INT'),
        occ(7, 'local', null, null),
        occ(8, 'sName', 'MAIN.sName', 'STRING(80)')
    ]);
    let last = posts[posts.length - 1];
    assert(last && last.type === 'online/values', 'values are posted as online/values');
    const byLine = (n) => last.items.find(i => i.line === n);
    assert(byLine(1).text === '7' && byLine(2).text === '7' && byLine(3).text === 'TRUE',
        'every occurrence of a known scalar gets its value (one read per distinct path)');
    assert(!byLine(4), 'a struct gets no inline value');
    assert(!byLine(5), 'a path the PLC does not know gets nothing (no guessing)');
    assert(byLine(6) && byLine(6).state === 'differs' && byLine(6).text === 'type differs',
        'a declared INT that is a DINT on the PLC shows "type differs", never a value');
    assert(!byLine(7), 'an occurrence without a path gets nothing');
    assert(!byLine(8), 'a path past the cap is left out');
    assert(capped && capped.n === 6 && capped.max === 5, `more distinct paths than the cap: the cap message fires (${JSON.stringify(capped)})`);

    const sumBefore = plc.sumReads;
    mon.start();
    await tick(75);
    const ticks = plc.sumReads - sumBefore;
    assert(ticks >= 2 && ticks <= 5, `polled at the interval, one sum read per tick (${ticks} in 75 ms at 20 ms)`);
    const postsBefore = posts.length;
    await tick(50);
    assert(posts.length === postsBefore, 'nothing is posted while nothing changes');
    plc.set('MAIN.nCount', 8);
    await tick(40);
    last = posts[posts.length - 1];
    assert(byLine(1).text === '8', 'a changed value is posted at the next tick');

    mon.setVisible(false);
    const hiddenBase = plc.sumReads;
    await tick(60);
    assert(plc.sumReads === hiddenBase, 'a hidden editor is not polled');
    mon.setVisible(true);
    await tick(30);
    assert(plc.sumReads > hiddenBase, 'polling resumes when it is visible again');

    plc.state = 'Stop';
    await session.refreshStatus();
    await tick(40);
    last = posts[posts.length - 1];
    assert(byLine(1).state === 'stopped', 'values dim (state "stopped") while the PLC is not in Run');
    plc.state = 'Run';
    await session.refreshStatus();

    await mon.setOccurrences([occ(1, 'nCount', 'MAIN.nCount', 'INT')], { blocked: true });
    last = posts[posts.length - 1];
    assert(last.items.length === 0 && mon.blocked, 'a project mismatch (blocked) shows nothing');
    await mon.setOccurrences([occ(1, 'nCount', 'MAIN.nCount', 'INT')]);
    mon.stop();
    last = posts[posts.length - 1];
    assert(last.items.length === 0 && !mon.running, 'stop() clears the values in the webview');
    const stopBase = plc.sumReads;
    await tick(50);
    assert(plc.sumReads === stopBase, 'and stops polling');
    mon.dispose();
    await session.disconnect();
    assert(plc.openConnections === 0, 'nothing left open');

    if (errors) { console.error(`\n${errors} inline-value assertion(s) failed`); process.exit(1); }
    console.log('\nAll inline-value assertions passed.');
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
