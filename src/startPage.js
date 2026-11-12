/**
 * @file startPage.js
 * @description The TwinCAT start page (roadmap R2): a singleton webview panel in an editor tab with
 * the create-project form, open-project and recent solutions, project actions, help links and
 * settings. The page (src/startPageHtml.js + media/startPage.js) only sends messages; every action
 * runs here through the same `twincat.*` command the Command Palette runs, so the two can never
 * behave differently.
 *
 * Offline by construction: the CSP admits only the webview's own resources, and links leave through
 * `vscode.env.openExternal` on the host, never from inside the page.
 */

'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderStartPageHtml, PROJECT_ACTIONS } = require('./startPageHtml');
const { TEMPLATE_VERSIONS } = require('./projectTemplate');
const { recentsShownLimit } = require('./recentProjects');
const { XAE_SHELL_SECTION, describeConfiguredShells } = require('./xaeShellDetect');

/** The panel's view type (also the `onWebviewPanel:` activation event and the serializer key). */
const START_PAGE_VIEW_TYPE = 'twincat.startPage';

/** `globalState` key of the folder the last project was created in, offered as the next default. */
const LAST_LOCATION_KEY = 'twincat.lastProjectLocation';

/** Commands the page may run. Anything else a (compromised) page posts is ignored. */
const ALLOWED_COMMANDS = new Set([...PROJECT_ACTIONS.map(a => a.command), 'twincat.compileProject', 'twincat.openSettings', 'twincat.detectXaeShell']);

/** Settings sections the page may open filtered (`openSettings {section}`) → the Settings UI query. */
const SETTINGS_SECTIONS = Object.freeze({ xaeShell: XAE_SHELL_SECTION });

/** Help link ids → the command that opens each. */
const LINK_COMMANDS = Object.freeze({
    gettingStarted: 'twincat.openGettingStarted',
    roadmap: 'twincat.openRoadmap',
    releaseNotes: 'twincat.openReleaseNotes',
    reportIssue: 'twincat.reportIssue'
});

/**
 * Owns the singleton start-page panel.
 */
class StartPageController {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {{recents: {list: () => any[], remove: (p: string) => Thenable<void>}, hasProject: () => boolean,
     *   compilerReady?: () => boolean, compileOptions?: () => {generateCpp: boolean, buildWithGpp: boolean},
     *   setCompileOption?: (key: string, value: boolean) => Promise<boolean>}} deps `compilerReady`: the
     *   compiler file exists (the bundled one, or the override); `compileOptions` / `setCompileOption`:
     *   the Compile dropdown's two switches (R13).
     */
    constructor(context, deps) {
        this.context = context;
        this.deps = deps;
        /** @type {vscode.WebviewPanel|null} */
        this.panel = null;
    }

    /** Opens the start page, or brings the open one to the front. */
    show() {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(START_PAGE_VIEW_TYPE, 'TC Toolkit Start',
            vscode.ViewColumn.Active, this.webviewOptions());
        this.attach(panel);
    }

    /** @returns {vscode.WebviewOptions & vscode.WebviewPanelOptions} */
    webviewOptions() {
        return {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };
    }

    /**
     * Wires a panel — a new one, or one VS Code restored after a reload (the serializer).
     * @param {vscode.WebviewPanel} panel
     */
    attach(panel) {
        this.panel = panel;
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'marketplace-icon.png');
        panel.webview.options = this.webviewOptions();
        const media = (file) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file)).toString();
        panel.webview.html = renderStartPageHtml({
            cspSource: panel.webview.cspSource,
            nonce: crypto.randomBytes(16).toString('base64'),
            styleUri: media('startPage.css'),
            scriptUri: media('startPage.js'),
            nameScriptUri: media('projectName.js'),
            logoUri: media('marketplace-icon.png'),
            versions: TEMPLATE_VERSIONS
        });
        const subs = [
            panel.webview.onDidReceiveMessage(msg => this.onMessage(msg)),
            panel.onDidChangeViewState(() => { if (panel.visible) this.postState(); })
        ];
        panel.onDidDispose(() => {
            subs.forEach(s => s.dispose());
            if (this.panel === panel) this.panel = null;
        });
    }

    /** The folder offered as the default location. */
    defaultLocation() {
        const last = this.context.globalState.get(LAST_LOCATION_KEY);
        if (typeof last === 'string' && last) return last;
        const folders = vscode.workspace.workspaceFolders || [];
        return folders.length ? path.dirname(folders[0].uri.fsPath) : os.homedir();
    }

    /** Sends the page what it cannot know by itself. Safe to call when no page is open. */
    postState() {
        if (!this.panel) return;
        const xaeConfig = vscode.workspace.getConfiguration(XAE_SHELL_SECTION);
        this.panel.webview.postMessage({
            type: 'state',
            location: this.defaultLocation(),
            sep: path.sep,
            recents: this.deps.recents.list(),
            recentsShown: recentsShownLimit(vscode.workspace.getConfiguration('tcToolkit.startPage').get('recentProjectsShown')),
            hasProject: this.deps.hasProject(),
            compilerReady: !!(this.deps.compilerReady && this.deps.compilerReady()),
            compileOptions: this.deps.compileOptions ? this.deps.compileOptions() : { generateCpp: false, buildWithGpp: false },
            xaeShells: describeConfiguredShells((key) => xaeConfig.get(key), (p) => fs.existsSync(p))
        });
    }

    /**
     * @param {any} msg A message from media/startPage.js. Untrusted: every field is checked.
     */
    async onMessage(msg) {
        if (!msg || typeof msg.type !== 'string' || !this.panel) return;
        const panel = this.panel;
        switch (msg.type) {
            case 'ready':
                this.postState();
                break;
            case 'browseLocation': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
                    defaultUri: vscode.Uri.file(this.defaultLocation()),
                    openLabel: 'Select Location', title: 'Where to create the TwinCAT project'
                });
                if (picked && picked[0]) panel.webview.postMessage({ type: 'location', location: picked[0].fsPath });
                break;
            }
            case 'create': {
                /** @type {any} */
                const result = await vscode.commands.executeCommand('twincat.createProject', {
                    version: String(msg.version || ''), name: String(msg.name || ''),
                    location: String(msg.location || ''), fromStartPage: true
                });
                panel.webview.postMessage({ type: 'createResult', ok: !!(result && result.ok), error: result && result.error });
                this.postState();
                break;
            }
            case 'openProject':
                await vscode.commands.executeCommand('twincat.openProject');
                this.postState();
                break;
            case 'openRecent':
                if (typeof msg.slnPath === 'string') await vscode.commands.executeCommand('twincat.openProject', { slnPath: msg.slnPath });
                this.postState();
                break;
            case 'removeRecent':
                if (typeof msg.slnPath === 'string') await this.deps.recents.remove(msg.slnPath);
                this.postState();
                break;
            case 'command':
                if (ALLOWED_COMMANDS.has(msg.command)) await vscode.commands.executeCommand(msg.command);
                break;
            case 'setCompileOption':
                // Only the two switches, only booleans; the host applies the coupling and posts the result.
                if ((msg.key === 'generateCpp' || msg.key === 'buildWithGpp') && typeof msg.value === 'boolean' && this.deps.setCompileOption) {
                    await this.deps.setCompileOption(msg.key, msg.value);
                }
                this.postState();
                break;
            case 'openSettings':
                if (Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, msg.section)) {
                    await vscode.commands.executeCommand('twincat.openSettings', SETTINGS_SECTIONS[msg.section]);
                }
                break;
            case 'link':
                if (Object.prototype.hasOwnProperty.call(LINK_COMMANDS, msg.id)) {
                    await vscode.commands.executeCommand(LINK_COMMANDS[msg.id]);
                }
                break;
        }
    }
}

module.exports = { StartPageController, START_PAGE_VIEW_TYPE, LAST_LOCATION_KEY, ALLOWED_COMMANDS, LINK_COMMANDS, SETTINGS_SECTIONS };
