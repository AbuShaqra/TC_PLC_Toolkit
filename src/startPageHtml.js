/**
 * @file startPageHtml.js
 * @description Renders the TwinCAT start page (roadmap R2) — the HTML the `twincat.openStartPage`
 * webview shows. Pure string building (no `vscode`), so the browser harness renders exactly the page
 * the extension ships (test/browser/build_start_page.js) instead of a hand copy that drifts.
 *
 * The page is fully offline: its CSP allows nothing but the webview's own resources (`cspSource`) and
 * one nonce for the two local scripts; there is no remote font, image or script anywhere. Colours and
 * fonts come from VS Code's theme variables in media/startPage.css, so it follows the user's theme.
 *
 * Dynamic content (the default location, recent solutions, whether a project is open, the XAE Shell
 * paths) is not rendered
 * here: media/startPage.js asks the host for it with a `ready` message, so a refresh never rebuilds
 * the page and loses what the user typed.
 */

'use strict';

/** Help links, by id. The host owns the URLs/commands (src/startPage.js); the page only names them. */
const HELP_LINKS = Object.freeze([
    Object.freeze({ id: 'gettingStarted', label: 'Getting started', detail: 'The extension’s guide, offline' }),
    Object.freeze({ id: 'roadmap', label: 'Roadmap', detail: 'What is planned next' }),
    Object.freeze({ id: 'releaseNotes', label: 'Release notes', detail: 'GitHub releases' }),
    Object.freeze({ id: 'reportIssue', label: 'Report an issue', detail: 'GitHub issues' })
]);

/** Project actions: the existing commands the page may run (the host re-checks this list). */
const PROJECT_ACTIONS = Object.freeze([
    Object.freeze({ command: 'twincat.generateSt', label: 'Generate ST', detail: 'Export every object as Structured Text into each project’s ST_Files folder' }),
    Object.freeze({ command: 'twincat.updateLibraryDefinitions', label: 'Update Library Definitions', detail: 'Read library signatures through TwinCAT XAE (requires TwinCAT)' })
]);

/**
 * Small line icons drawn for this page (16 px, `currentColor`), so they follow the theme. Inline SVG
 * needs no CSP entry and no font.
 */
const ICON_PATHS = Object.freeze({
    create: '<path d="M8 3v10M3 8h10"/>',
    open: '<path d="M2 4.5V12a1 1 0 0 0 1 1h9.2a1 1 0 0 0 .97-.76L14.5 7H5.3a1 1 0 0 0-.97.76L2.6 13"/><path d="M2 4.5V3.5a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V7"/>',
    actions: '<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/>',
    help: '<path d="M2.5 3h4A1.5 1.5 0 0 1 8 4.5V13a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1.5 1.5 0 0 1 1.5-1.5h4z"/>',
    settings: '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.4"/><circle cx="10.5" cy="8" r="1.4"/><circle cx="5" cy="12" r="1.4"/>',
    chevron: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
    gettingStarted: '<path d="M4 2.5h6.5L12 4v9.5H4z"/><path d="M6 6.5h4M6 9h4M6 11.5h2.5"/>',
    roadmap: '<path d="M2 12.5 6 3.5l4 6 4-4"/><circle cx="14" cy="5.5" r=".6"/>',
    releaseNotes: '<path d="M8 2v8M5 7l3 3 3-3M3 13.5h10"/>',
    reportIssue: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 10.8v.2"/>'
});

/**
 * @param {keyof typeof ICON_PATHS} name
 * @param {string} [cls]
 * @returns {string} An inline, decorative SVG icon.
 */
function icon(name, cls = 'icon') {
    return `<svg class="${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ` +
        `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

/**
 * @param {string} s
 * @returns {string} `s` safe inside HTML text and double-quoted attributes.
 */
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Builds the start page.
 * @param {{cspSource: string, nonce: string, styleUri: string, scriptUri: string, nameScriptUri: string,
 *          logoUri: string, versions: ReadonlyArray<{id: string, label: string}>}} o
 *   `logoUri` is the webview URI of media/marketplace-icon.png, the extension's own icon.
 * @returns {string}
 */
function renderStartPageHtml(o) {
    const versionOptions = o.versions.map((v, i) =>
        `<option value="${escapeHtml(v.id)}"${i === 0 ? ' selected' : ''}>${escapeHtml(v.id)} — ${escapeHtml(v.label)}</option>`).join('');
    const actions = PROJECT_ACTIONS.map(a =>
        `<li><button type="button" class="action" data-command="${escapeHtml(a.command)}" data-needs-project>` +
        `<span class="action-text"><span class="action-label">${escapeHtml(a.label)}</span><span class="action-detail">${escapeHtml(a.detail)}</span></span>` +
        `${icon('chevron', 'icon chevron')}</button></li>`).join('');
    const links = HELP_LINKS.map(l =>
        `<li><a href="#" data-link="${escapeHtml(l.id)}">${icon(/** @type {any} */ (l.id), 'icon tile-icon')}` +
        `<span class="link-text"><span class="link-label">${escapeHtml(l.label)}</span> <span class="hint">${escapeHtml(l.detail)}</span></span>` +
        `${icon('chevron', 'icon chevron')}</a></li>`).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${escapeHtml(o.styleUri)}">
    <title>TwinCAT Start</title>
</head>
<body>
    <main class="page">
        <header class="masthead">
            <img class="logo" src="${escapeHtml(o.logoUri)}" alt="" width="64" height="64">
            <div class="masthead-text">
                <h1>TwinCAT PLC <span class="accent">Toolkit</span></h1>
                <p class="tagline">Create a TwinCAT 3 project, open one, or run a project action.</p>
                <ul class="chips" aria-label="Highlights">
                    <li>Works offline</li><li>TwinCAT 3.1.4024 and 3.1.4026</li><li>IEC 61131-3 Structured Text</li>
                </ul>
            </div>
        </header>
        <div class="grid">
            <section class="card" id="create" aria-labelledby="create-title">
                <h2 id="create-title"><span class="badge">${icon('create')}</span>Create new project</h2>
                <form id="create-form" novalidate>
                    <label for="tc-version">TwinCAT version</label>
                    <select id="tc-version">${versionOptions}</select>
                    <label for="project-name">Project name</label>
                    <input id="project-name" type="text" spellcheck="false" autocomplete="off" aria-describedby="name-hint name-error" aria-invalid="false">
                    <p id="name-hint" class="hint">Letters, digits and underscores. The PLC project is named <code id="plc-name">&lt;name&gt;_PLC</code>.</p>
                    <p id="name-error" class="error" role="alert" hidden></p>
                    <label for="location">Location</label>
                    <div class="row">
                        <input id="location" type="text" readonly aria-describedby="target-path">
                        <button type="button" id="browse" class="secondary">Browse…</button>
                    </div>
                    <p id="target-path" class="hint path"></p>
                    <p id="create-error" class="error" role="alert" hidden></p>
                    <div class="row end">
                        <button type="submit" id="create-btn" class="primary" disabled>Create</button>
                    </div>
                </form>
            </section>
            <section class="card" id="open" aria-labelledby="open-title">
                <h2 id="open-title"><span class="badge">${icon('open')}</span>Open existing project</h2>
                <button type="button" id="open-project" class="primary">Open Project…</button>
                <h3>Recent</h3>
                <ul id="recent-list" class="recents"></ul>
                <p id="recent-empty" class="hint">No recent TwinCAT solutions.</p>
            </section>
            <section class="card" id="actions" aria-labelledby="actions-title">
                <h2 id="actions-title"><span class="badge">${icon('actions')}</span>Project actions</h2>
                <p id="no-project" class="hint" hidden>Open a folder with a TwinCAT project to use these.</p>
                <ul class="actions">${actions}
                    <li><button type="button" class="action" id="compile-project" disabled title="Arrives in a later release">` +
        `<span class="action-text"><span class="action-label">Compile project</span><span class="action-detail">Coming in a later release</span></span><span class="soon">Soon</span></button></li>
                </ul>
            </section>
            <section class="card" id="help" aria-labelledby="help-title">
                <h2 id="help-title"><span class="badge">${icon('help')}</span>Help and links</h2>
                <ul class="links">${links}</ul>
            </section>
            <section class="card" id="settings" aria-labelledby="settings-title">
                <h2 id="settings-title"><span class="badge">${icon('settings')}</span>Settings</h2>
                <button type="button" class="tile" data-command="twincat.openSettings">` +
        `<span class="action-text"><span class="action-label">Open Settings</span><span class="action-detail">Diagnostics, library definitions and the XAE shell</span></span>` +
        `${icon('chevron', 'icon chevron')}</button>
                <h3 id="xae-title">XAE Shell</h3>
                <ul id="xae-list" class="xae-paths" aria-labelledby="xae-title"></ul>
                <div class="row wrap">
                    <button type="button" id="xae-change" class="secondary">Change…</button>
                    <button type="button" class="secondary" data-command="twincat.detectXaeShell">Detect again</button>
                </div>
            </section>
        </div>
        <footer class="footer">TwinCAT PLC Toolkit · AGPL-3.0-or-later · Not affiliated with Beckhoff Automation</footer>
    </main>
    <script nonce="${o.nonce}" src="${escapeHtml(o.nameScriptUri)}"></script>
    <script nonce="${o.nonce}" src="${escapeHtml(o.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { renderStartPageHtml, escapeHtml, HELP_LINKS, PROJECT_ACTIONS };
