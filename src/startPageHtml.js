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
 * Dynamic content (the default location, recent solutions, whether a project is open) is not rendered
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
    Object.freeze({ command: 'twincat.generateSt', label: 'Generate ST', detail: 'Export every object as Structured Text under ST_Files' }),
    Object.freeze({ command: 'twincat.updateLibraryDefinitions', label: 'Update Library Definitions', detail: 'Read library signatures through TwinCAT XAE (requires TwinCAT)' })
]);

/**
 * @param {string} s
 * @returns {string} `s` safe inside HTML text and double-quoted attributes.
 */
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Prepares the Activity Bar icon for inline use: theme colour, page size, no comments.
 * @param {string} svg
 * @returns {string}
 */
function inlineIcon(svg) {
    return String(svg || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/stroke="#[0-9a-fA-F]{3,6}"/, 'stroke="currentColor"')
        .replace(/ width="24" height="24"/, ' width="40" height="40"')
        .trim();
}

/**
 * Builds the start page.
 * @param {{cspSource: string, nonce: string, styleUri: string, scriptUri: string, nameScriptUri: string,
 *          iconSvg: string, versions: ReadonlyArray<{id: string, label: string}>}} o
 *   `iconSvg` is the markup of media/twincat-activitybar.svg; it is inlined and recoloured with
 *   `currentColor`, so the logo follows the theme (an `<img>` of it could not).
 * @returns {string}
 */
function renderStartPageHtml(o) {
    const versionOptions = o.versions.map((v, i) =>
        `<option value="${escapeHtml(v.id)}"${i === 0 ? ' selected' : ''}>${escapeHtml(v.id)} — ${escapeHtml(v.label)}</option>`).join('');
    const actions = PROJECT_ACTIONS.map(a =>
        `<li><button type="button" class="action" data-command="${escapeHtml(a.command)}" data-needs-project>` +
        `<span class="action-label">${escapeHtml(a.label)}</span><span class="action-detail">${escapeHtml(a.detail)}</span></button></li>`).join('');
    const links = HELP_LINKS.map(l =>
        `<li><a href="#" data-link="${escapeHtml(l.id)}">${escapeHtml(l.label)}</a> <span class="hint">${escapeHtml(l.detail)}</span></li>`).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${escapeHtml(o.styleUri)}">
    <title>TwinCAT Start</title>
</head>
<body>
    <main class="page">
        <header class="masthead">
            <span class="logo" aria-hidden="true">${inlineIcon(o.iconSvg)}</span>
            <div>
                <h1>TwinCAT PLC Toolkit</h1>
                <p class="hint">Create a TwinCAT 3 project, open one, or run a project action.</p>
            </div>
        </header>
        <div class="grid">
            <section class="card" id="create" aria-labelledby="create-title">
                <h2 id="create-title">Create new project</h2>
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
                <h2 id="open-title">Open existing project</h2>
                <button type="button" id="open-project" class="primary">Open Project…</button>
                <h3>Recent</h3>
                <ul id="recent-list" class="recents"></ul>
                <p id="recent-empty" class="hint">No recent TwinCAT solutions.</p>
            </section>
            <section class="card" id="actions" aria-labelledby="actions-title">
                <h2 id="actions-title">Project actions</h2>
                <p id="no-project" class="hint" hidden>Open a folder with a TwinCAT project to use these.</p>
                <ul class="actions">${actions}
                    <li><button type="button" class="action" id="strucpp-check" disabled title="Arrives with roadmap item R3.2">` +
        `<span class="action-label">Check with STruC++</span><span class="action-detail">Coming in R3.2</span></button></li>
                </ul>
            </section>
            <section class="card" id="help" aria-labelledby="help-title">
                <h2 id="help-title">Help and links</h2>
                <ul class="links">${links}</ul>
            </section>
            <section class="card" id="settings" aria-labelledby="settings-title">
                <h2 id="settings-title">Settings</h2>
                <p class="hint">Diagnostics, library definitions and the XAE shell.</p>
                <button type="button" class="secondary" data-command="twincat.openSettings">Open Settings</button>
            </section>
        </div>
    </main>
    <script nonce="${o.nonce}" src="${escapeHtml(o.nameScriptUri)}"></script>
    <script nonce="${o.nonce}" src="${escapeHtml(o.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { renderStartPageHtml, escapeHtml, HELP_LINKS, PROJECT_ACTIONS };
