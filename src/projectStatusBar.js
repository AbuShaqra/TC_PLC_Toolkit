/**
 * @file projectStatusBar.js
 * @description Shows which PLC project the active file belongs to.
 *
 * A workspace can hold several `.plcproj` files, and each is its own compilation unit: symbols,
 * references and rename are all scoped to one project. Without an indicator that scoping is
 * invisible — two same-named objects look identical in the tab bar. Shown only when there is
 * something to disambiguate (two or more projects); a single-project workspace sees nothing.
 */

// `vscode` is required lazily, inside createProjectStatusBar() below — NOT at module top level.
// projectLabel must stay importable (and callable) under plain Node, because
// test/test_project_map.js requires this file just to reach projectLabel, and it runs standalone
// (no VS Code, no build step — see CLAUDE.md). An eager require('vscode') here would crash that
// require with "Cannot find module 'vscode'" before projectLabel is ever reached, defeating the
// "pure, unit-testable" point this module exists to make.
const { LOOSE_PROJECT_KEY } = require('./lsp/projectMap');

/** Extensions whose editor should show the indicator (lower-cased). */
const TWINCAT_FILE_EXTS = /\.(tcpou|tcgvl|tcdut|tcio|st)$/i;

/**
 * The label for a file, or '' when there is nothing worth showing.
 * Pure — no `vscode` use — so it is unit-testable.
 * @param {{projects: Map<string, Object>, projectFor: (p: string) => string,
 *   displayName: (p: string) => string}} projectMap The workspace partition.
 * @param {string} fsPath Absolute file path.
 * @returns {string} Display name, or '' for a workspace with fewer than two projects.
 */
function projectLabel(projectMap, fsPath) {
    if (!projectMap || projectMap.projects.size < 2) return '';
    const key = projectMap.projectFor(fsPath);
    return key === LOOSE_PROJECT_KEY ? 'Loose files' : projectMap.displayName(key);
}

/**
 * Creates the status-bar item and returns a handle the extension refreshes on file change.
 * @param {vscode.ExtensionContext} context Extension context (the item is registered for disposal).
 * @param {() => Object|null} getProjectMap Supplies the current partition; re-read on every
 *   refresh because a `.plcproj` edit rebuilds it.
 * @returns {{refresh: (uri: vscode.Uri|null) => void, dispose: () => void}}
 */
function createProjectStatusBar(context, getProjectMap) {
    const vscode = require('vscode');
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.tooltip = 'The PLC project this file belongs to. References, rename and diagnostics are scoped to it.';
    context.subscriptions.push(item);

    const refresh = (uri) => {
        const label = uri && TWINCAT_FILE_EXTS.test(uri.fsPath)
            ? projectLabel(getProjectMap(), uri.fsPath)
            : '';
        if (!label) { item.hide(); return; }
        item.text = `$(circuit-board) ${label}`;
        item.show();
    };

    return { refresh, dispose: () => item.dispose() };
}

module.exports = { projectLabel, createProjectStatusBar };
