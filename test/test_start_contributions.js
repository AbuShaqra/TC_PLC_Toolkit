/**
 * @file test_start_contributions.js
 * @description The TwinCAT sidebar and start page as package.json declares them (roadmap R2): the
 * Activity Bar container, its three views in order with their ids unchanged, every start command
 * contributed, registered, reachable from the Command Palette and able to activate the extension on
 * VS Code 1.66, the welcome buttons pointing at real commands, an offline monochrome icon, and an
 * offline start page (CSP, no remote loads).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { renderStartPageHtml, HELP_LINKS, PROJECT_ACTIONS } = require('../src/startPageHtml');
const { TEMPLATE_VERSIONS } = require('../src/projectTemplate');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const REPO = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const c = pkg.contributes;

// ── Container and views ─────────────────────────────────────────────────────────────────────────
const bar = (c.viewsContainers.activitybar || []).find(v => v.id === 'twincat');
assert(!!bar && bar.title === 'TwinCAT', 'an Activity Bar container "twincat" titled TwinCAT');
assert(!!bar && fs.existsSync(path.join(REPO, bar.icon)), `its icon exists (${bar && bar.icon})`);
const views = (c.views.twincat || []).map(v => v.id);
assert(JSON.stringify(views) === JSON.stringify(['twincatStart', 'twincatExplorer', 'twincatLibraries']),
    `the container holds Start, Objects, Libraries in that order (${views.join(', ')})`);
assert(!c.views.explorer || !c.views.explorer.some(v => ['twincatExplorer', 'twincatLibraries'].includes(v.id)),
    'Objects and Libraries are no longer contributed to the Explorer');
assert((c.views['twincat-references-panel'] || []).some(v => v.id === 'twincatReferences'), 'References stays in its panel');
const names = Object.fromEntries((c.views.twincat || []).map(v => [v.id, v.name]));
assert(names.twincatExplorer === 'TwinCAT Objects' && names.twincatLibraries === 'TwinCAT Libraries' && names.twincatStart === 'Start',
    'view names unchanged (TwinCAT Objects, TwinCAT Libraries) plus Start');
// Every view id used in a when-clause or keybinding still exists.
const allViewIds = new Set(Object.values(c.views).flat().map(v => v.id));
const whenText = JSON.stringify([c.menus, c.keybindings]);
const referenced = new Set([...whenText.matchAll(/(?:view|focusedView) == (\w+)/g)].map(m => m[1]));
const dangling = [...referenced].filter(id => !allViewIds.has(id));
assert(dangling.length === 0, `every view id in a when-clause exists (${dangling.join(', ') || 'none dangling'})`);

// ── The icon: monochrome, offline, no vendor artwork ────────────────────────────────────────────
{
    const svg = fs.readFileSync(path.join(REPO, bar.icon), 'utf8');
    assert(/^<svg[\s>]/.test(svg.trim()) && /viewBox="0 0 24 24"/.test(svg), 'the icon is a 24x24 SVG');
    const colours = new Set((svg.match(/#[0-9a-fA-F]{3,6}\b/g) || []).map(s => s.toLowerCase()));
    assert(colours.size <= 1 && !/<image|<text|<linearGradient|<radialGradient/.test(svg), 'the icon is monochrome line art');
    assert(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(svg) && !/xlink:href/.test(svg), 'the icon loads nothing remote');
}

// ── Commands: contributed, in the palette, registered, activating ─────────────────────────────
const START_COMMANDS = [
    'twincat.openStartPage', 'twincat.createProject', 'twincat.openProject', 'twincat.generateSt',
    'twincat.openSettings', 'twincat.openGettingStarted', 'twincat.openRoadmap', 'twincat.openReleaseNotes',
    'twincat.reportIssue'
];
const contributed = new Map(c.commands.map(cmd => [cmd.command, cmd]));
const hidden = new Set((c.menus.commandPalette || []).filter(m => m.when === 'false').map(m => m.command));
const sources = [path.join(REPO, 'extension.js'), ...fs.readdirSync(path.join(REPO, 'src', 'commands')).map(f => path.join(REPO, 'src', 'commands', f))]
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');
const registered = new Set([...sources.matchAll(/registerCommand\(\s*'([^']+)'/g)].map(m => m[1]));
for (const id of START_COMMANDS) {
    const cmd = contributed.get(id);
    assert(!!cmd && cmd.category === 'TwinCAT', `${id} is contributed under the TwinCAT category`);
    assert(!hidden.has(id), `${id} is in the Command Palette`);
    assert(registered.has(id), `${id} is registered`);
    assert(pkg.activationEvents.includes(`onCommand:${id}`), `${id} activates the extension (onCommand, needed on VS Code 1.66)`);
}
assert(pkg.activationEvents.includes('onView:twincatStart'), 'opening the Start view activates the extension');
assert(pkg.activationEvents.includes('onWebviewPanel:twincat.startPage'), 'a restored start page activates the extension');
assert(contributed.has('twincat.updateLibraryDefinitions') && registered.has('twincat.updateLibraryDefinitions'),
    'Update Library Definitions (reused by the start page) is still contributed and registered');
for (const a of PROJECT_ACTIONS) assert(registered.has(a.command), `start-page action ${a.command} is a registered command`);
assert(/^\^1\.66\./.test(pkg.engines.vscode), `engine stays ^1.66 (${pkg.engines.vscode})`);

// ── Welcome content ─────────────────────────────────────────────────────────────────────────────
{
    const start = (c.viewsWelcome || []).find(w => w.view === 'twincatStart');
    assert(!!start, 'the Start view has welcome content');
    const links = start ? [...start.contents.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]) : [];
    const cmdLinks = links.filter(l => l.startsWith('command:')).map(l => l.slice('command:'.length));
    for (const id of ['twincat.createProject', 'twincat.openProject', 'twincat.openStartPage', 'twincat.openSettings', 'twincat.openGettingStarted']) {
        assert(cmdLinks.includes(id), `Start view offers ${id}`);
    }
    assert(cmdLinks.every(id => contributed.has(id)), 'every welcome command link names a contributed command');
    const web = links.filter(l => /^https:/.test(l));
    assert(web.includes('https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv'), 'Start view links the roadmap page');
    assert(web.includes('https://github.com/AbuShaqra/TC_PLC_Toolkit/releases') && web.includes('https://github.com/AbuShaqra/TC_PLC_Toolkit/issues'),
        'Start view links the release notes and the issue tracker');
}

// ── Start page HTML: offline, strict CSP, theme-aware ──────────────────────────────────────────
{
    const html = renderStartPageHtml({
        cspSource: 'vscode-webview://abc', nonce: 'N0nce', styleUri: 'vscode-webview://abc/startPage.css',
        scriptUri: 'vscode-webview://abc/startPage.js', nameScriptUri: 'vscode-webview://abc/projectName.js',
        iconSvg: fs.readFileSync(path.join(REPO, 'media', 'twincat-activitybar.svg'), 'utf8'), versions: TEMPLATE_VERSIONS
    });
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html);
    assert(!!csp && /default-src 'none'/.test(csp[1]) && /script-src 'nonce-N0nce'/.test(csp[1]) && !/unsafe-inline|unsafe-eval|https?:/.test(csp[1]),
        `strict CSP (${csp && csp[1]})`);
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(m => m[1]);
    assert(scripts.length === 2 && scripts.every(s => /nonce="N0nce"/.test(s) && /src="vscode-webview:/.test(s)), 'only the two local nonce scripts');
    const urls = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1]);
    assert(urls.every(u => u.startsWith('vscode-webview://')), `no remote load in the page (${urls.join(', ')})`);
    assert(!/<img\b/.test(html) && /stroke="currentColor"/.test(html), 'the logo is inline and follows the theme colour');
    for (const v of TEMPLATE_VERSIONS) assert(html.includes(`value="${v.id}"`), `version ${v.id} is offered`);
    for (const l of HELP_LINKS) assert(html.includes(`data-link="${l.id}"`), `help link ${l.id} is on the page`);
    assert(/id="strucpp-check" disabled/.test(html) && /Coming in R3\.2/.test(html), 'Check with STruC++ is shown disabled (coming in R3.2)');
    const css = fs.readFileSync(path.join(REPO, 'media', 'startPage.css'), 'utf8');
    assert(!/https?:|@import|url\(/.test(css), 'the stylesheet loads nothing');
    const colours = (css.match(/#[0-9a-fA-F]{3,6}\b|rgb\(/g) || []).length;
    assert(/var\(--vscode-editor-background\)/.test(css) && colours === 0, 'colours come from VS Code theme variables (fallback rgba only)');
    const js = fs.readFileSync(path.join(REPO, 'media', 'startPage.js'), 'utf8');
    assert(!/fetch\(|XMLHttpRequest|https?:\/\//.test(js), 'the page script makes no network request');
}

// ── Packaging: the derived templates ship, the raw XAE source does not ─────────────────────────
{
    const ignore = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    assert(ignore.includes('resources/templates/xae-3.1.4024/**'), '.vscodeignore drops the raw XAE 3.1.4024 source');
    assert(!ignore.some(l => l === 'resources/templates/**' || l === 'resources/**'), '.vscodeignore no longer drops every template');
    assert(!ignore.some(l => /^media\/(startPage|projectName|twincat-activitybar)/.test(l)), 'the start page and icon files ship');
}

if (errors) {
    console.error(`\n${errors} failure(s)`);
    process.exit(1);
}
console.log('\nAll start contribution tests passed.');
