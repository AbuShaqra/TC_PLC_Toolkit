/**
 * @file startCommands.js
 * @description Registers the TwinCAT sidebar's Start view and the start-page commands (roadmap R2):
 * create a new project from a template, open an existing one (or a recent one), open the start page,
 * Generate ST, settings, and the help links. Each is a Command Palette entry under "TwinCAT:", and the
 * start page (src/startPage.js) runs exactly these commands — there is no second code path.
 *
 * The file work lives in src/projectTemplate.js (no `vscode`, unit-tested); this module is only the
 * VS Code half: prompts, dialogs, notifications, opening the folder, and the recent-solutions list.
 */

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { TEMPLATE_VERSIONS, validateProjectName, checkTarget, createProject, templateDirFor } = require('../projectTemplate');
const { createRecentStore } = require('../recentProjects');
const { findSolutionFiles, solutionReferences } = require('../solutionMap');
const { StartPageController, START_PAGE_VIEW_TYPE, LAST_LOCATION_KEY } = require('../startPage');
const { SETTING_GPP_PATH } = require('../gpp');

/** Public pages the help links open. The repository's releases and issues; the roadmap page. */
const LINKS = Object.freeze({
    roadmap: 'https://claude.ai/artifact/8RG7TZtBV2cuupsrwWtknv',
    releaseNotes: 'https://github.com/AbuShaqra/TC_PLC_Toolkit/releases',
    reportIssue: 'https://github.com/AbuShaqra/TC_PLC_Toolkit/issues'
});

/** How to open a created or chosen project, offered as a quick pick. */
const OPEN_CHOICES = Object.freeze([
    Object.freeze({ id: 'here', label: '$(window) Open in This Window' }),
    Object.freeze({ id: 'new', label: '$(empty-window) Open in a New Window' }),
    Object.freeze({ id: 'add', label: '$(add) Add to Workspace' })
]);

/**
 * Whether a `.sln` is a TwinCAT solution (it references a system project or a PLC project).
 * @param {string} slnPath
 * @returns {boolean}
 */
function isTwinCatSolution(slnPath) {
    const refs = solutionReferences(slnPath);
    return refs.tsproj.length > 0 || refs.plcproj.length > 0;
}

/**
 * Registers the Start view and the start-page commands.
 * @param {vscode.ExtensionContext} context
 * @param {object} deps
 * @param {any} deps.provider The custom editor provider (owns Generate ST).
 * @param {() => any} deps.getProjectMap The host's current project partition.
 * @param {() => any} deps.getSolutionMap The host's current solution model.
 * @param {() => boolean} [deps.isCompilerAvailable] Whether Compile Project's compiler file exists (the
 *   bundled one, or the override the setting names).
 * @param {() => {generateCpp: boolean, buildWithGpp: boolean}} [deps.compileOptions] The Compile
 *   dropdown's two switches (src/commands/compileCommands.js).
 * @param {(key: string, value: boolean) => Promise<boolean>} [deps.setCompileOption] Writes one of them.
 * @param {() => {available: boolean, showWindow: boolean, running: boolean, configuration: string, platform: string}} [deps.xaeOptions]
 *   Build through XAE's dropdown state (R14).
 * @param {(key: string, value: boolean) => Promise<boolean>} [deps.setXaeOption] Writes its window switch.
 * @param {() => any} [deps.gppMachine] How the start page checks and detects g++ (tests only; the real machine by default).
 * @returns {{startPage: InstanceType<typeof StartPageController>, recordOpenSolutions: () => void}}
 */
function registerStartCommands(context, { provider, getProjectMap, getSolutionMap, isCompilerAvailable, compileOptions, setCompileOption, gppMachine, xaeOptions, setXaeOption }) {
    const recents = createRecentStore(context.globalState, (p) => fs.existsSync(p));
    const startPage = new StartPageController(context, {
        recents,
        hasProject: () => { const m = getProjectMap(); return !!(m && m.projects && m.projects.size > 0); },
        compilerReady: () => !!(isCompilerAvailable && isCompilerAvailable()),
        compileOptions, setCompileOption, gppMachine, xaeOptions, setXaeOption
    });
    const templatesRoot = path.join(context.extensionPath, 'resources', 'templates');

    // The Start view has no items of its own: its content is the `viewsWelcome` buttons in
    // package.json, which VS Code shows only for an EMPTY tree — so it needs a provider that is.
    const emptyProvider = { getChildren: () => [], getTreeItem: (/** @type {any} */ item) => item };
    context.subscriptions.push(vscode.window.createTreeView('twincatStart', { treeDataProvider: emptyProvider }));

    // Bring the start page back after a window reload if it was open.
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(START_PAGE_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => { startPage.attach(panel); }
    }));

    /**
     * Opens a folder the way the user picks (or `mode` says).
     * @param {string} folder
     * @param {string} [mode] 'here' | 'new' | 'add' | 'none'; asked when absent.
     * @returns {Promise<boolean>} false when the user cancelled the choice.
     */
    async function openFolder(folder, mode) {
        let choice = mode;
        if (!choice) {
            const picked = await vscode.window.showQuickPick(OPEN_CHOICES.slice(), {
                title: `Open ${path.basename(folder)}`, placeHolder: 'How do you want to open the project?'
            });
            if (!picked) return false;
            choice = picked.id;
        }
        const uri = vscode.Uri.file(folder);
        if (choice === 'here') await vscode.commands.executeCommand('vscode.openFolder', uri, false);
        else if (choice === 'new') await vscode.commands.executeCommand('vscode.openFolder', uri, true);
        else if (choice === 'add') {
            const count = (vscode.workspace.workspaceFolders || []).length;
            vscode.workspace.updateWorkspaceFolders(count, 0, { uri });
        }
        return true;
    }

    /**
     * Opens a TwinCAT solution: its folder, unless the workspace already holds it.
     * @param {string} slnPath
     * @param {string} [mode]
     */
    async function openSolution(slnPath, mode) {
        if (!fs.existsSync(slnPath)) {
            await recents.remove(slnPath);
            startPage.postState();
            vscode.window.showWarningMessage(`${slnPath} no longer exists; it was removed from the recent list.`);
            return;
        }
        await recents.add(slnPath);
        const folder = path.dirname(slnPath);
        const open = (vscode.workspace.workspaceFolders || []).find(f => {
            const rel = path.relative(f.uri.fsPath, slnPath);
            return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        });
        if (open && !mode) {
            vscode.window.showInformationMessage(`${path.basename(slnPath)} is already in this workspace.`);
            await vscode.commands.executeCommand('twincatExplorer.focus');
            return;
        }
        await openFolder(folder, mode);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.openStartPage', () => startPage.show()),

        // Create a new solution from a template. `args` (from the start page, or a caller that has
        // already asked) skips the prompts it answers; the result tells the caller what happened.
        vscode.commands.registerCommand('twincat.createProject', async (args) => {
            const a = args && typeof args === 'object' ? args : {};
            const fail = (/** @type {string} */ error) => {
                if (!a.fromStartPage) vscode.window.showErrorMessage(error);
                return { ok: false, error };
            };

            let version = typeof a.version === 'string' && a.version ? a.version : '';
            if (!version) {
                const picked = await vscode.window.showQuickPick(
                    TEMPLATE_VERSIONS.map(v => ({ label: v.id, description: v.label, id: v.id })),
                    { title: 'Create New TwinCAT Project (1/3)', placeHolder: 'TwinCAT version' });
                if (!picked) return { ok: false };
                version = picked.id;
            }
            if (!TEMPLATE_VERSIONS.some(v => v.id === version)) return fail(`Unknown TwinCAT version "${version}".`);

            let name = typeof a.name === 'string' ? a.name.trim() : '';
            if (!name) {
                const typed = await vscode.window.showInputBox({
                    title: 'Create New TwinCAT Project (2/3)', prompt: 'Project name (the PLC project is named <name>_PLC)',
                    validateInput: (value) => validateProjectName(value.trim())
                });
                if (typed === undefined) return { ok: false };
                name = typed.trim();
            }
            const nameProblem = validateProjectName(name);
            if (nameProblem) return fail(nameProblem);

            let location = typeof a.location === 'string' ? a.location : '';
            if (!location) {
                const last = context.globalState.get(LAST_LOCATION_KEY);
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
                    defaultUri: typeof last === 'string' && last ? vscode.Uri.file(last) : undefined,
                    openLabel: 'Create Here', title: 'Create New TwinCAT Project (3/3): location'
                });
                if (!picked || !picked[0]) return { ok: false };
                location = picked[0].fsPath;
            }

            const check = checkTarget({ location, name });
            if (!check.ok) return fail(check.reason || 'The project cannot be created there.');

            let created;
            try {
                created = createProject({ templateDir: templateDirFor(templatesRoot, version), location, name });
            } catch (err) {
                return fail(`Could not create the project: ${err && err.message ? err.message : err}`);
            }
            await recents.add(created.slnPath);
            await context.globalState.update(LAST_LOCATION_KEY, location);
            startPage.postState();

            const opened = await openFolder(created.targetDir, typeof a.open === 'string' ? a.open : undefined);
            if (!opened || a.open === 'none') {
                vscode.window.showInformationMessage(`Created ${created.slnPath}.`);
            }
            return { ok: true, slnPath: created.slnPath, targetDir: created.targetDir };
        }),

        // Open an existing solution or folder. `args.slnPath` opens that solution (a recent entry).
        vscode.commands.registerCommand('twincat.openProject', async (args) => {
            if (args && typeof args.slnPath === 'string') {
                await openSolution(args.slnPath, typeof args.open === 'string' ? args.open : undefined);
                return;
            }
            const kind = await vscode.window.showQuickPick([
                { label: '$(file) Open a Solution (.sln)…', id: 'sln' },
                { label: '$(folder) Open a Folder…', id: 'folder' }
            ], { title: 'Open TwinCAT Project' });
            if (!kind) return;
            if (kind.id === 'sln') {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    filters: { 'TwinCAT solution': ['sln'] }, openLabel: 'Open Solution'
                });
                if (!picked || !picked[0]) return;
                const slnPath = picked[0].fsPath;
                if (!isTwinCatSolution(slnPath)) {
                    vscode.window.showErrorMessage(`${path.basename(slnPath)} is not a TwinCAT solution (it references no TwinCAT system or PLC project).`);
                    return;
                }
                await openSolution(slnPath);
                return;
            }
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Open Folder'
            });
            if (!picked || !picked[0]) return;
            const folder = picked[0].fsPath;
            const solutions = findSolutionFiles([folder]).filter(isTwinCatSolution);
            for (const sln of solutions.slice(0, 10).reverse()) await recents.add(sln);
            if (solutions.length === 0) {
                const go = await vscode.window.showWarningMessage(
                    `No TwinCAT solution was found in ${folder}. Open it anyway?`, 'Open', 'Cancel');
                if (go !== 'Open') return;
            }
            await openFolder(folder);
        }),

        // Generate ST for every project, or for the ones picked when the workspace has several.
        vscode.commands.registerCommand('twincat.generateSt', async () => {
            const projects = provider.listProjects();
            if (projects.length === 0) {
                await provider.generateAllStFiles();
                return;
            }
            /** @type {Array<vscode.QuickPickItem & {key: string}>} */
            const items = projects.map((/** @type {{key: string, label: string}} */ p) => ({ label: p.label, key: p.key, picked: true }));
            const picked = await vscode.window.showQuickPick(items, { title: 'Generate ST', placeHolder: 'Projects to export', canPickMany: true });
            if (!picked || picked.length === 0) return;
            await provider.generateAllStFiles(picked.map(p => p.key));
        }),

        // `query` narrows the Settings UI to one of the extension's own sections (the start page's
        // "Change…" passes `tcToolkit.xaeShell`); anything else opens all of the extension's settings.
        // `{target: 'user'}` opens the User settings, where a machine-scoped setting is shown.
        vscode.commands.registerCommand('twincat.openSettings', (query, options) => {
            const q = typeof query === 'string' && /^tcToolkit\.[A-Za-z0-9.]+$/.test(query) ? query : `@ext:${context.extension.id}`;
            return options && options.target === 'user'
                ? vscode.commands.executeCommand('workbench.action.openGlobalSettings', { query: q })
                : vscode.commands.executeCommand('workbench.action.openSettings', q);
        }),
        vscode.commands.registerCommand('twincat.openGettingStarted', () =>
            vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(context.extensionPath, 'README.md')))),
        vscode.commands.registerCommand('twincat.openRoadmap', () => vscode.env.openExternal(vscode.Uri.parse(LINKS.roadmap))),
        vscode.commands.registerCommand('twincat.openReleaseNotes', () => vscode.env.openExternal(vscode.Uri.parse(LINKS.releaseNotes))),
        vscode.commands.registerCommand('twincat.reportIssue', () => vscode.env.openExternal(vscode.Uri.parse(LINKS.reportIssue)))
    );

    // A change to what the page shows from the settings (the recent-list length, the XAE Shell paths,
    // the g++ path) reaches an open start page at once.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tcToolkit.startPage') || e.affectsConfiguration('tcToolkit.xaeShell')
            || e.affectsConfiguration(SETTING_GPP_PATH)) startPage.postState();
    }));

    /** Records the TwinCAT solutions open in this workspace as recently opened. */
    function recordOpenSolutions() {
        const solutionMap = getSolutionMap();
        const solutions = (solutionMap && solutionMap.solutions) || [];
        // Oldest first, so the first solution ends up on top.
        for (const s of solutions.slice(0, 10).reverse()) recents.add(s.slnPath);
        startPage.postState();
    }

    return { startPage, recordOpenSolutions };
}

module.exports = { registerStartCommands, LINKS };
