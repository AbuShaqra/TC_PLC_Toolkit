/**
 * @file test_editor_title_buttons.js
 * @description The buttons contributed to the title bar of a PLC file's editor tab (user request
 * 2026-11-16): Build, Build and Activate, Go Online / Go Offline (one slot, swapped by the
 * `twincat.online` context key) and Show Activation Targets. Each must be shown only for TC Toolkit's
 * custom editor, carry an icon (a title-bar button without one renders as text), and name a
 * contributed command. The three XAE buttons are Windows-only, like their palette entries.
 *
 * The same four actions sit in the PLC Objects view's title bar (user request 2026-11-16, for when no
 * file is open), shown while the workspace has a PLC project (`twincat.hasPlcProject`, set by
 * extension.js whenever the project map is rebuilt) — Go Offline whenever a session is online.
 *
 * The PLC Watch views' title bar carries Start PLC / Stop PLC (one slot, swapped by the
 * `twincat.plcRunning` context key) right after Go Online / Go Offline, only while online.
 */

'use strict';

const pkg = require('../package.json');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const EDITOR = 'activeCustomEditorId == twincat.xmlViewer';
const items = (pkg.contributes.menus || {})['editor/title'] || [];
const commands = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
const byCommand = new Map(items.map((i) => [i.command, i]));

for (const id of ['twincat.xaeBuild', 'twincat.xaeBuildAndActivate', 'twincat.goOnline', 'twincat.goOffline', 'twincat.xaeShowTargets']) {
    const item = byCommand.get(id);
    assert(!!item, `${id} has an editor title button`);
    if (!item) continue;
    assert(typeof item.when === 'string' && item.when.startsWith(EDITOR), `${id} shows only in the PLC file editor`);
    assert(/^navigation@\d+$/.test(item.group || ''), `${id} is an inline button (navigation group)`);
    const cmd = commands.get(id);
    assert(!!cmd && typeof cmd.icon === 'string' && /^\$\([a-z-]+\)$/.test(cmd.icon), `${id} carries a codicon`);
}

for (const id of ['twincat.xaeBuild', 'twincat.xaeBuildAndActivate', 'twincat.xaeShowTargets']) {
    const item = byCommand.get(id);
    assert(!!item && /\bisWindows\b/.test(item.when), `${id}'s button shows on Windows only, like its palette entry`);
}

const online = byCommand.get('twincat.goOnline');
const offline = byCommand.get('twincat.goOffline');
assert(!!online && !!offline && online.group === offline.group, 'Go Online and Go Offline share one slot');
assert(!!online && /!twincat\.online\b/.test(online.when) && !!offline && /(^|&& )twincat\.online\b/.test(offline.when),
    'the slot swaps on the twincat.online context key');
assert(items.every((i) => commands.has(i.command)), 'every editor title entry names a contributed command');

// ── The PLC Objects view's title bar ──────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const VIEW = 'view == twincatExplorer';
const viewItems = ((pkg.contributes.menus || {})['view/title'] || []).filter((i) => typeof i.when === 'string' && i.when.startsWith(VIEW));
const viewByCommand = new Map(viewItems.map((i) => [i.command, i]));
for (const id of ['twincat.xaeBuild', 'twincat.xaeBuildAndActivate', 'twincat.goOnline', 'twincat.goOffline', 'twincat.xaeShowTargets']) {
    const item = viewByCommand.get(id);
    const editorItem = byCommand.get(id);
    assert(!!item, `${id} has a PLC Objects view title button`);
    if (!item) continue;
    assert(!!editorItem && item.group === editorItem.group, `${id} takes the same slot as in the editor tab (${item.group})`);
    if (id !== 'twincat.goOffline') assert(/&& twincat\.hasPlcProject\b/.test(item.when), `${id} shows only while the workspace has a PLC project`);
    assert(/\bisWindows\b/.test(item.when) === /\bisWindows\b/.test(editorItem ? editorItem.when : ''), `${id} has the editor tab's Windows gating`);
}
const vOnline = viewByCommand.get('twincat.goOnline');
const vOffline = viewByCommand.get('twincat.goOffline');
assert(!!vOnline && /!twincat\.online\b/.test(vOnline.when) && !!vOffline && /&& twincat\.online\b/.test(vOffline.when),
    'the view slot swaps on twincat.online too; Go Offline shows whenever online, project or not');
assert(viewItems.length === 5, `the PLC Objects view has exactly these five title entries (${viewItems.length})`);
const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const refresh = /const refreshProjectMap = \(\) => \{[\s\S]*?\n {4}\};/.exec(ext);
assert(!!refresh && /setContext', 'twincat\.hasPlcProject'/.test(refresh[0]),
    'extension.js sets twincat.hasPlcProject in refreshProjectMap (activation and every project-structure change)');

// ── The PLC Watch views' title bar: Start / Stop PLC next to Go Online / Go Offline ──────────────
// (user request 2026-11-16). One slot right after connect/disconnect, swapped by twincat.plcRunning;
// shown only while online, in both PLC Watch views (panel and sidebar).
const WATCH = 'view =~ /^twincatWatch(Sidebar)?$/';
const watchItems = ((pkg.contributes.menus || {})['view/title'] || []).filter((i) => typeof i.when === 'string' && i.when.startsWith(WATCH));
const watchBy = new Map(watchItems.filter((i) => /^navigation@/.test(i.group || '')).map((i) => [i.command, i]));
const slot = (/** @type {string} */ id) => { const i = watchBy.get(id); return i ? Number(/@(\d+)$/.exec(i.group)[1]) : NaN; };
const wStart = watchBy.get('twincat.online.startPlc');
const wStop = watchBy.get('twincat.online.stopPlc');
assert(!!wStart && !!wStop && wStart.group === wStop.group, 'Start PLC and Stop PLC share one PLC Watch title slot');
assert(slot('twincat.goOnline') === slot('twincat.goOffline') && slot('twincat.online.startPlc') === slot('twincat.goOnline') + 1,
    `the Start/Stop slot comes right after Go Online / Go Offline (${slot('twincat.goOnline')} -> ${slot('twincat.online.startPlc')})`);
assert(slot('twincat.watch.add') > slot('twincat.online.startPlc') && slot('twincat.watch.clear') > slot('twincat.watch.add'),
    'Add and Clear follow it, in their old order');
assert(!!wStart && /&& twincat\.online\b/.test(wStart.when) && /!twincat\.plcRunning\b/.test(wStart.when)
    && !!wStop && /&& twincat\.online\b/.test(wStop.when) && /&& twincat\.plcRunning\b/.test(wStop.when),
    'only while online; the slot swaps on twincat.plcRunning');
for (const [id, icon, key] of [['twincat.online.startPlc', '$(debug-start)', 'twincat.plcStopped'], ['twincat.online.stopPlc', '$(debug-stop)', 'twincat.plcRunning']]) {
    const cmd = commands.get(id);
    assert(!!cmd && cmd.icon === icon && cmd.category === 'TC Toolkit' && /^(Start|Stop) PLC…$/.test(cmd.title),
        `${id}: "${cmd && cmd.title}" under TC Toolkit with ${icon}`);
    assert(!!cmd && typeof cmd.enablement === 'string' && cmd.enablement.includes('twincat.online') && cmd.enablement.includes(key)
        && cmd.enablement.includes('!twincat.plcControlBusy'), `${id} is enabled only online, in the state it applies to, and not while one runs`);
    assert(((pkg.contributes.menus || {}).commandPalette || []).some((m) => m.command === id && m.when === 'twincat.online'),
        `${id} is in the Command Palette while online`);
    assert((pkg.activationEvents || []).includes(`onCommand:${id}`), `${id} activates the extension`);
}
const oc = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'onlineCommands.js'), 'utf8');
assert(/setContext', 'twincat\.plcRunning'/.test(oc) && /setContext', 'twincat\.plcStopped'/.test(oc) && /setContext', 'twincat\.plcControlBusy'/.test(oc),
    'onlineCommands.js sets twincat.plcRunning, twincat.plcStopped and twincat.plcControlBusy');

if (errors) { console.error(`\n${errors} failure(s)`); process.exit(1); }
console.log('\nAll editor, PLC Objects and PLC Watch title button checks passed.');
