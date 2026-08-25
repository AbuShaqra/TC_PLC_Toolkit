/**
 * @file customEditorProvider.js
 * @description TwinCAT Custom Text Editor Provider managing webview setup and Monaco integrations.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { parseTwinCatXml, replaceComponentCdata } = require('./xmlParser');
const { updateDocument } = require('./plcProjHelper');
const { convertXmlToSt } = require('./stConverter');
const { assembleSt, localToAbsolute, createStResolver, mapDefinition, collectPeekReferences, listExternalReferences, mapDiagnosticsToLocal } = require('./livePath');
const pendingEditsCore = require('../media/pendingEdits');
const EXT_VERSION = (() => { try { return require('../package.json').version; } catch (e) { return '?'; } })();

/**
 * Reads a file's raw text given its URI string, for injection into createStResolver.
 * @param {string} uri File URI.
 * @returns {Promise<string>} The file's text, decoded as UTF-8.
 */
async function readFile(uri) {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri))).toString('utf8');
}

/**
 * Custom text editor provider that acts as a wrapper around TwinCAT XML files
 * and serves the Monaco webview editor.
 */
class TwinCatCustomEditorProvider {
    /**
     * @param {vscode.ExtensionContext} context The extension context.
     * @param {Object} [options] References sink plus onActiveFileChange(uri, componentId) tree/status callback.
     */
    constructor(context, options = {}) {
        this.context = context;
        this.options = options;
        this.pendingSelections = new Map(); // URI string -> componentId
        this.activePanels = new Map(); // URI string -> WebviewPanel
        this.pendingEditsMap = new Map(); // URI string -> pendingEdits object
        // URI string of the panel the user was last in. A TwinCAT file is a *webview*, so
        // vscode.window.activeTextEditor is undefined for it and there is no other way to know which
        // document an Explorer-initiated insert should land in. Cleared when that panel is disposed.
        this.lastActivePanelUri = null;
    }

    /**
     * Inserts text at the caret of the TwinCAT webview the user was last editing.
     *
     * The insert is *posted*, not applied here: the caret lives inside Monaco, in the webview, and the
     * extension host cannot see it. The webview replies to the edit through its existing change
     * pipeline (executeEdits fires onDidChangeModelContent → the pending-edit/dirty path), so nothing
     * special has to be done to mark the document modified.
     * @param {string} text Text to insert at the caret (replacing any selection).
     * @param {boolean} [triggerSuggest] Open the completion list afterwards (used for `Namespace.`).
     * @returns {boolean} True if a panel took the message; false if no TwinCAT webview is open, in
     *          which case the caller must fall back rather than silently drop the insert.
     */
    insertTextIntoActivePanel(text, triggerSuggest) {
        if (!text) return false;
        const panel = this.lastActivePanelUri ? this.activePanels.get(this.lastActivePanelUri) : null;
        if (!panel) return false;
        panel.webview.postMessage({
            type: 'insertText',
            text: text,
            triggerSuggest: !!triggerSuggest
        });
        return true;
    }

    /**
     * Forgets the last-active TwinCAT webview. Called when a plain text editor becomes the active
     * one, so that an insert then goes to *that* editor instead of a webview the user has left.
     */
    clearLastActivePanel() {
        this.lastActivePanelUri = null;
    }

    /**
     * Registers a pending selection for a file to focus a specific component upon load.
     * @param {string} uriStr File URI string.
     * @param {string} componentId Selected component identifier.
     * @param {object} range Optional range object.
     * @param {string} targetWord Optional target word.
     */
    setPendingSelection(uriStr, componentId, range, targetWord) {
        this.pendingSelections.set(uriStr, { componentId, range, targetWord });

        const panel = this.activePanels.get(uriStr);
        if (panel) {
            // Webview already open: switch view directly and highlight.
            panel.webview.postMessage({
                type: 'selectComponent',
                id: componentId,
                range: range,
                targetWord: targetWord
            });
        }

        // The pending selection is NOT dropped here. A webview that is open but *hidden* has had its
        // context torn down by VS Code, so the message above goes nowhere — and deleting the selection
        // meant that when the editor was then revealed and re-initialised, it had nothing left to jump
        // to and simply opened wherever it last was. Keeping it lets the `init` path apply it. The
        // webview acks with `selectionApplied` once it has actually highlighted, and that is what
        // clears it (see resolveCustomTextEditor), so a stale entry cannot linger and hijack a later
        // open of the same file.
    }

    /**
     * Orchestrates webview panel configuration, loader initialization, and message handling.
     */
    resolveCustomTextEditor(document, webviewPanel, token) {
        const uriStr = document.uri.toString();
        let activeComponentId = 'root';
        this.activePanels.set(uriStr, webviewPanel);
        this.lastActivePanelUri = uriStr;

        // Notify that this file is now active
        if (this.options && typeof this.options.onActiveFileChange === 'function') {
            this.options.onActiveFileChange(document.uri);
        }

        const changeViewStateSubscription = webviewPanel.onDidChangeViewState(e => {
            if (webviewPanel.active) {
                this.lastActivePanelUri = uriStr;
                if (this.options && typeof this.options.onActiveFileChange === 'function') {
                    // A retained webview does not reload its component when its tab becomes active
                    // again, so no fresh activeComponentChanged message follows this callback. Keep
                    // the last confirmed id here or tab-away/tab-back would reselect the file root.
                    this.options.onActiveFileChange(document.uri, activeComponentId);
                }
            }
        });

        // Keep webview context alive when hidden (switching tabs) - configured via provider registration options
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media')
            ]
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        let isEditingFromWebview = false;

        // Track document changes to update webview
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                const text = e.document.getText();
                const parsed = parseTwinCatXml(text);
                if (parsed) {
                    webviewPanel.webview.postMessage({
                        type: 'update',
                        data: parsed,
                        isSelfEdit: isEditingFromWebview
                    });
                }
            }
        });

        webviewPanel.onDidDispose(() => {
            this.activePanels.delete(uriStr);
            if (this.lastActivePanelUri === uriStr) this.lastActivePanelUri = null;
            changeDocumentSubscription.dispose();
            changeViewStateSubscription.dispose();
        });

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'ready':
                    // Send initial document state to the webview
                    const text = document.getText();
                    const parsed = parseTwinCatXml(text);
                    if (parsed) {
                        const pending = this.pendingSelections.get(uriStr);
                        const isAutoSync = this.context.globalState.get('twincat.isAutoSync', true);
                        const cachedEdits = this.pendingEditsMap.get(uriStr) || {};
                        const splitterRatio = this.context.globalState.get('twincat.splitterRatio', 50);
                        webviewPanel.webview.postMessage({
                            type: 'init',
                            filename: path.basename(document.fileName),
                            data: parsed,
                            selectId: pending ? (typeof pending === 'string' ? pending : pending.componentId) : 'root',
                            pendingRange: pending && typeof pending === 'object' ? pending.range : null,
                            pendingTargetWord: pending && typeof pending === 'object' ? pending.targetWord : null,
                            isAutoSync: isAutoSync,
                            cachedEdits: cachedEdits,
                            splitterRatio: splitterRatio,
                            fileUri: uriStr
                        });
                        // Cleared by the webview's `selectionApplied` ack, not here: if the highlight
                        // never lands (the panes were not populated yet), dropping it now would leave
                        // nothing to retry with.
                    }
                    break;
                case 'selectionApplied':
                    // The webview has actually highlighted the location, so the pending selection has
                    // done its job and must not be re-applied on a later open of the same file.
                    this.pendingSelections.delete(uriStr);
                    break;
                case 'activeComponentChanged':
                    // The webview is authoritative about which component actually loaded. In
                    // particular, openWith first activates the file (which reveals its root) and
                    // only then applies a pending definition/reference target. Revealing here makes
                    // the final Objects-tree selection the method/property/action/accessor rather
                    // than letting the earlier file activation win that race.
                    activeComponentId = message.componentId || 'root';
                    if (this.options && typeof this.options.onActiveFileChange === 'function') {
                        this.options.onActiveFileChange(document.uri, activeComponentId);
                    }
                    break;
                case 'saveSplitterRatio':
                    await this.context.globalState.update('twincat.splitterRatio', message.ratio);
                    for (const [panelUri, panel] of this.activePanels.entries()) {
                        if (panelUri !== uriStr) {
                            panel.webview.postMessage({
                                type: 'setSplitterRatio',
                                ratio: message.ratio
                            });
                        }
                    }
                    break;
                case 'toggleSyncMode':
                    // Save to globalState (persisted across restarts)
                    await this.context.globalState.update('twincat.isAutoSync', message.isAutoSync);
                    // Broadcast the change to all other active webviews
                    for (const panel of this.activePanels.values()) {
                        panel.webview.postMessage({
                            type: 'setSyncMode',
                            isAutoSync: message.isAutoSync
                        });
                    }
                    break;
                case 'updatePendingEdits':
                    // Cache unsaved edits for this file in extension memory
                    this.pendingEditsMap.set(uriStr, message.pendingEdits);
                    break;
                case 'edit':
                    // Update document content on change
                    const currentText = document.getText();
                    const newText = replaceComponentCdata(
                        currentText,
                        message.context,
                        message.blockType,
                        message.content
                    );
                    if (newText !== currentText) {
                        isEditingFromWebview = true;
                        try {
                            await updateDocument(document, newText);
                            const isAutoSync = this.context.globalState.get('twincat.isAutoSync', true);
                            if (isAutoSync) {
                                await document.save();
                            }
                        } catch (err) {
                            console.error(err);
                        } finally {
                            isEditingFromWebview = false;
                        }
                    }
                    break;
                case 'sync-pending':
                    // Apply all pending edits at once
                    let pendingText = pendingEditsCore.foldEdits(document.getText(), message.edits, replaceComponentCdata);
                    if (pendingText !== document.getText()) {
                        isEditingFromWebview = true;
                        try {
                            await updateDocument(document, pendingText);
                            await document.save();
                        } catch (err) {
                            console.error(err);
                        } finally {
                            isEditingFromWebview = false;
                        }
                    }
                    this.pendingEditsMap.delete(uriStr);
                    break;
                case 'save':
                    // Apply pending edits and save document
                    let saveText = pendingEditsCore.foldEdits(document.getText(), message.edits, replaceComponentCdata);
                    if (saveText !== document.getText()) {
                        isEditingFromWebview = true;
                        try {
                            await updateDocument(document, saveText);
                        } catch (err) {
                            console.error(err);
                        } finally {
                            isEditingFromWebview = false;
                        }
                    }
                    this.pendingEditsMap.delete(uriStr);
                    // Trigger native document save
                    try {
                        await document.save();
                    } catch (err) {
                        vscode.window.showErrorMessage(`Failed to save document: ${err.message}`);
                    }
                    break;
                case 'custom/completions':
                    try {
                        const ctx = assembleSt(document.getText(), message);
                        let suggestions = [];
                        if (ctx) {
                            const abs = localToAbsolute(ctx.lineMap, message.componentId, message.pane, message.position.lineNumber, message.position.column);
                            if (abs) {
                                suggestions = await vscode.commands.executeCommand('twincat.lsp.queryCompletions', {
                                    code: ctx.stText,
                                    position: abs,
                                    fileUri: message.fileUri
                                });
                            }
                        }
                        webviewPanel.webview.postMessage({
                            type: 'custom/completionsResponse',
                            requestId: message.requestId,
                            suggestions: suggestions || []
                        });
                    } catch (err) {
                        console.error(err);
                    }
                    break;
                case 'custom/definition':
                    try {
                        const ctx = assembleSt(document.getText(), message);
                        let definition = null;
                        if (ctx) {
                            const abs = localToAbsolute(ctx.lineMap, message.componentId, message.pane, message.position.lineNumber, message.position.column);
                            if (abs) {
                                definition = await vscode.commands.executeCommand('twincat.lsp.queryDefinition', {
                                    code: ctx.stText,
                                    position: abs,
                                    fileUri: message.fileUri
                                });
                            }
                            // Resolve the answer to an exact (component, pane, local line) — see
                            // mapDefinition's doc comment in livePath.js for why.
                            definition = await mapDefinition(definition, createStResolver({ activeUri: message.fileUri, activeUnit: ctx, readFile }));
                        }
                        webviewPanel.webview.postMessage({
                            type: 'custom/definitionResponse',
                            requestId: message.requestId,
                            definition: definition
                        });
                    } catch (err) {
                        console.error(err);
                    }
                    break;
                case 'custom/references':
                    try {
                        const ctx = assembleSt(document.getText(), message);
                        let mapped = [];
                        let panes = [];
                        if (ctx) {
                            const abs = localToAbsolute(ctx.lineMap, message.componentId, message.pane, message.position.lineNumber, message.position.column);
                            if (abs) {
                                /** @type {any} */
                                const refs = await vscode.commands.executeCommand('twincat.lsp.queryReferences', {
                                    code: ctx.stText,
                                    position: abs,
                                    fileUri: message.fileUri
                                });

                                // Every reference — in this component, another component of this file, or
                                // another file entirely — is resolved to a (file, component, pane, local
                                // line) so the webview can render it in the peek. See
                                // collectPeekReferences's doc comment in livePath.js for the two-pass
                                // rationale shared with showExternalReferences.
                                const result = await collectPeekReferences(refs, {
                                    activeUri: message.fileUri,
                                    resolveSt: createStResolver({ activeUri: message.fileUri, activeUnit: ctx, readFile })
                                });
                                mapped = result.references;
                                panes = result.panes;
                            }
                        }
                        webviewPanel.webview.postMessage({
                            type: 'custom/referencesResponse',
                            requestId: message.requestId,
                            references: mapped,
                            panes: panes
                        });
                    } catch (err) {
                        console.error(err);
                    }
                    break;
                case 'custom/diagnostics':
                    try {
                        const ctx = assembleSt(document.getText(), message);
                        let mapped = [];
                        if (ctx) {
                            /** @type {any} */
                            const diagnostics = await vscode.commands.executeCommand('twincat.lsp.queryDiagnostics', {
                                code: ctx.stText,
                                fileUri: message.fileUri
                            });
                            // Map full-unit diagnostics back to per-component panes/lines.
                            mapped = mapDiagnosticsToLocal(diagnostics || [], ctx.lineMap);
                        }
                        webviewPanel.webview.postMessage({
                            type: 'custom/diagnosticsResponse',
                            requestId: message.requestId,
                            diagnostics: mapped
                        });
                    } catch (err) {
                        console.error(err);
                    }
                    break;
                case 'showExternalReferences':
                    try {
                        const ctx = assembleSt(document.getText(), message);
                        if (!ctx) break;
                        const abs = localToAbsolute(ctx.lineMap, message.componentId, message.pane, message.position.lineNumber, message.position.column);
                        if (!abs) break;
                        /** @type {any} */
                        const refs = await vscode.commands.executeCommand('twincat.lsp.queryReferences', {
                            code: ctx.stText,
                            position: abs,
                            fileUri: message.fileUri
                        }) || [];

                        // Resolve each reference to a file, component, line text and target word so it
                        // can be listed and navigated to — see listExternalReferences's doc comment in
                        // livePath.js for the per-reference line-split caching rationale.
                        const { items, searchedWord } = await listExternalReferences(
                            refs, createStResolver({ activeUri: message.fileUri, activeUnit: ctx, readFile }));

                        if (this.options && typeof this.options.showReferences === 'function') {
                            this.options.showReferences(searchedWord, items);
                        }
                    } catch (err) {
                        console.error(err);
                    }
                    break;
                case 'generate-st':
                    await this.generateAllStFiles();
                    break;
                case 'openFile':
                    try {
                        const fileUri = vscode.Uri.parse(message.fileUri);
                        await vscode.commands.executeCommand('twincat.openComponent', fileUri, message.componentId || 'root', message.range, message.targetWord);
                    } catch (err) {
                        console.error(err);
                    }
                    break;
                case 'error':
                    console.error(`[TwinCAT PLC Toolkit Webview Error]: ${message.message}\nStack: ${message.error}`);
                    vscode.window.showErrorMessage(`Webview Error: ${message.message}`);
                    break;
            }
        });
    }

    /**
     * Generates HTML context containing Monaco configuration and Blob-worker setups.
     * @param {vscode.Webview} webview The webview instance.
     * @returns {string} Fully formed HTML text.
     */
    getHtmlForWebview(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js'));
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css'));
        // Loaded ahead of editor.js, which registers the folding provider that calls into it. It is a
        // separate file because the extension host needs the same algorithm for plain `.st` files, and
        // with no build step a dual-mode module is the only way to keep one copy.
        const foldingUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'stFolding.js'));
        // Dual-mode pure modules editor.js consumes as globals (diagnosticMarkers, peekUri, pendingEditsCore) — same
        // reasoning as stFolding.js above: no build step, so one file that works both under Node and as a script tag.
        const diagnosticMarkersUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'diagnosticMarkers.js'));
        const peekUriUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'peekUri.js'));
        const pendingEditsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pendingEdits.js'));
        // Dev-host-only instrumentation, inert unless the dev-host harness (test/devhost/run.js) sets
        // TCDEV_TEST=1, and `.vscodeignore`d so it never reaches the VSIX. It must load BEFORE
        // editor.js: it memoizes `acquireVsCodeApi`, which throws on a second call.
        const testHookUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'devHostTestHook.js'));
        const testHookTag = process.env.TCDEV_TEST === '1' ? `<script src="${testHookUri}"></script>` : '';

        const vsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'monaco-editor', 'vs'));
        // The worker's AMD baseUrl must be the directory that CONTAINS `vs/`, because Monaco's module
        // ids already start with `vs/`. Pointing it at `.../vs/` doubled the segment (`vs/vs/…`), so the
        // worker's NLS strings file 404'd ("Failed trying to load default language strings").
        const monacoBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'monaco-editor'));
        const loaderUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'monaco-editor', 'vs', 'loader.js'));

        // Read workerMain.js content from the file system and base64-encode it
        let workerCodeBase64 = '';
        try {
            const workerPath = path.join(this.context.extensionPath, 'media', 'monaco-editor', 'vs', 'base', 'worker', 'workerMain.js');
            const workerCode = fs.readFileSync(workerPath, 'utf8');
            workerCodeBase64 = Buffer.from(workerCode).toString('base64');
        } catch (e) {
            console.error('Failed to read or encode workerMain.js:', e);
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline' blob:; font-src ${webview.cspSource}; worker-src 'self' blob: data:;">
    <link href="${stylesUri}" rel="stylesheet">
    <script src="${loaderUri}"></script>
    <script>
        // Synchronously decode the base64-encoded worker code and create Blob URL
        const workerCode = atob('${workerCodeBase64}');
        const blob = new Blob([
            \`self.MonacoEnvironment = { baseUrl: '${monacoBaseUri}/' };\\n\` + workerCode
        ], { type: 'application/javascript' });
        const workerBlobUrl = URL.createObjectURL(blob);

        window.MonacoEnvironment = {
            getWorker: function(workerId, label) {
                return new Worker(workerBlobUrl);
            }
        };
        require.config({ paths: { 'vs': '${vsUri}' } });
        window.monacoReady = new Promise((resolve) => {
            require(['vs/editor/editor.main'], function() {
                resolve(monaco);
            });
        });
    </script>
</head>
<body>
    <!-- Diagnostic Error Overlay -->
    <div id="error-overlay" style="display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(30, 5, 5, 0.95); color: #ff6b81; padding: 24px; font-family: monospace; z-index: 99999; overflow: auto; border: 2px solid #ff4757;"></div>

    <div id="app">
        <!-- Top bar with object details and dropdown -->
        <header class="app-header">
            <div class="header-left">
                <span class="logo-text">TwinCAT</span>
                <span class="pill" title="Extension build">v${EXT_VERSION}</span>
                <span id="obj-type" class="pill">POU</span>
                <h1 id="obj-name">MAIN</h1>
            </div>
            <div class="header-right">
                <select id="component-select" class="nav-select">
                    <!-- populated dynamically -->
                </select>
                <button id="generate-st-btn" class="action-btn">Generate ST</button>
                <div class="sync-toggle-container active" id="sync-toggle-wrapper">
                    <span class="sync-toggle-label" id="sync-mode-text">Auto Sync</span>
                    <label class="switch">
                        <input type="checkbox" id="sync-mode-toggle" checked>
                        <span class="slider round"></span>
                    </label>
                </div>
                <span id="save-status" class="status-indicator">Synced</span>
            </div>
        </header>

        <!-- Main Workspace -->
        <div id="editor-container" class="editor-container">
            <!-- Declaration Pane -->
            <div id="pane-decl" class="editor-pane">
                <div class="pane-header">Declaration (Variables)</div>
                <div class="editor-wrapper">
                    <div id="editor-decl-container" style="width: 100%; height: 100%;"></div>
                </div>
            </div>

            <!-- Vertical Resizer Splitter -->
            <div id="pane-splitter" class="pane-splitter"></div>

            <!-- Implementation Pane -->
            <div id="pane-impl" class="editor-pane">
                <div class="pane-header">Implementation (Structured Text)</div>
                <div class="editor-wrapper">
                    <div id="editor-impl-container" style="width: 100%; height: 100%;"></div>
                </div>
            </div>
        </div>
    </div>
    <script src="${foldingUri}"></script>
    <script src="${diagnosticMarkersUri}"></script>
    <script src="${peekUriUri}"></script>
    <script src="${pendingEditsUri}"></script>
    ${testHookTag}
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
    /**
     * Converts all TwinCAT XML files in the workspace to Structured Text files
     * and saves them under the 'ST_Files' directory mirroring the layout.
     */
    async generateAllStFiles() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No active workspace folder found.');
            return;
        }
        const workspaceRoot = workspaceFolders[0].uri;
        const targetDir = vscode.Uri.joinPath(workspaceRoot, 'ST_Files');

        // Find all TwinCAT XML files recursively
        const files = await vscode.workspace.findFiles('**/*.{TcPOU,TcIO,TcGVL,TcDUT,TcTLEO,tcpou,tcio,tcgvl,tcdut,tctleo}');
        
        let successCount = 0;
        let failCount = 0;

        for (const fileUri of files) {
            // Get relative path from workspace root
            const relPath = vscode.workspace.asRelativePath(fileUri, false);
            
            // Ignore files already inside ST_Files/
            if (relPath.startsWith('ST_Files/') || relPath.startsWith('ST_Files\\')) {
                continue;
            }

            try {
                const fileData = await vscode.workspace.fs.readFile(fileUri);
                const text = Buffer.from(fileData).toString('utf8');
                const parsed = parseTwinCatXml(text);
                if (parsed) {
                    const { stText } = convertXmlToSt(parsed);
                    
                    // Determine output path: ST_Files/<relPath without extension>.st
                    const ext = path.extname(relPath);
                    const baseNameWithoutExt = path.basename(relPath, ext);
                    const dirName = path.dirname(relPath);
                    
                    // Construct output URI
                    const outDirUri = vscode.Uri.joinPath(targetDir, dirName);
                    const outFileUri = vscode.Uri.joinPath(outDirUri, `${baseNameWithoutExt}.st`);
                    
                    // Ensure directory exists
                    await vscode.workspace.fs.createDirectory(outDirUri);
                    // Write file
                    await vscode.workspace.fs.writeFile(outFileUri, Buffer.from(stText, 'utf8'));
                    successCount++;
                }
            } catch (err) {
                console.error(`Failed to generate ST for ${fileUri.fsPath}:`, err);
                failCount++;
            }
        }

        if (failCount === 0) {
            vscode.window.showInformationMessage(`Successfully generated ${successCount} ST files inside "ST_Files" folder.`);
        } else {
            vscode.window.showWarningMessage(`Generated ${successCount} ST files. Failed to convert ${failCount} files.`);
        }
    }
}

module.exports = {
    TwinCatCustomEditorProvider
};
