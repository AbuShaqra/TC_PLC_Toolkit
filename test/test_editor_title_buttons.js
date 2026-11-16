/**
 * @file test_editor_title_buttons.js
 * @description The buttons contributed to the title bar of a PLC file's editor tab (user request
 * 2026-11-16): Build, Build and Activate, Go Online / Go Offline (one slot, swapped by the
 * `twincat.online` context key) and Show Activation Targets. Each must be shown only for TC Toolkit's
 * custom editor, carry an icon (a title-bar button without one renders as text), and name a
 * contributed command. The three XAE buttons are Windows-only, like their palette entries.
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

if (errors) { console.error(`\n${errors} failure(s)`); process.exit(1); }
console.log('\nAll editor title button checks passed.');
