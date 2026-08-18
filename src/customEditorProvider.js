/**
 * @file customEditorProvider.js
 * @description TwinCAT Custom Text Editor Provider managing webview setup and Monaco integrations.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { parseTwinCatXml, replaceComponentCdata } = require('./xmlParser');
const { updateDocument } = require('./plcProjHelper');
const { convertXmlToSt, mapDiagnosticsToMonaco } = require('./stConverter');
const { normalizeFileUri } = require('./fileUri');
const { localToAbsolute, absoluteToLocal, paneTextFromUnit, peekPath } = require('./editorMapping');
const EXT_VERSION = (() => { try { return require('../package.json').version; } catch (e) { return '?'; } })();

/**
 * Normalizes a URI for same-file comparison so that percent-encoded and unencoded
 * forms of the same path (e.g. file:///c%3A/... vs file:///c:/...) compare equal.
 * Local to the extension host; intentionally not shared with the LSP module.
 * @param {string} uri File URI.
 * @returns {string} Normalized key.
 */
function normUri(uri) {
    return normalizeFileUri(uri);
}

/**
 * Assembles the full document as a single Structured Text compilation unit, applying the
 * webview's live (unsaved) edits for the active component as an overlay so the LSP sees a
 * complete, valid POU/GVL/DUT — giving methods/properties/actions correct scope.
 * @param {vscode.TextDocument} document The backing XML document.
 * @param {Object} overlay { componentId, decl?, impl? } live edits for the active component.
 * @returns {Object|null} { stText, lineMap } or null if the document could not be parsed.
 */
function assembleSt(document, overlay) {
    const parsed = parseTwinCatXml(document.getText());
    if (!parsed) return null;
    if (overlay && overlay.componentId) {
        const comp = parsed.components.find(c => c.id === overlay.componentId);
        if (comp) {
            if (typeof overlay.decl === 'string' && comp.declaration !== null && comp.declaration !== undefined) {
                comp.declaration = overlay.decl;
            }
            if (typeof overlay.impl === 'string' && comp.implementation !== null && comp.implementation !== undefined) {
                comp.implementation = overlay.impl;
            }
        }
    }
    // raw: keep declarations/implementations verbatim so the lineMap matches the editor content 1:1.
    return convertXmlToSt(parsed, { raw: true });
}

/**
 * Builds a per-request resolver from a file URI to its assembled ST unit.
 *
 * Every navigation feature has the same problem: the LSP answers in absolute lines of a unit, and
 * that unit belongs to whichever file the symbol lives in — which is often not the open one. The
 * active document is already assembled (unsaved edits included) and must be reused rather than
 * re-read; anything else is read from disk and converted. Results are cached per request because a
 * search with many hits in one file would otherwise re-read and re-split it once per hit.
 *
 * Note the consequence, unchanged from before: another file is read from DISK, so a target inside a
 * file with unsaved edits in some other tab is located against the SAVED text.
 * @param {string} activeFileUri URI of the document this request came from.
 * @param {Object} activeCtx Its assembled unit ({ stText, lineMap }) from assembleSt.
 * @returns {Function} async (uri) => { st, lines } for that file, or null when it is unreadable.
 */
function createStResolver(activeFileUri, activeCtx) {
    const cache = new Map();
    return async function getSt(uri) {
        const key = normUri(uri);
        if (cache.has(key)) return cache.get(key);
        let result = null;
        if (key === normUri(activeFileUri)) {
            result = { st: activeCtx, lines: activeCtx.stText.split('\n') };
        } else {
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
                const parsed = parseTwinCatXml(Buffer.from(bytes).toString('utf8'));
                if (parsed) {
                    const converted = convertXmlToSt(parsed, { raw: true });
                    result = { st: converted, lines: converted.stText.split('\n') };
                }
            } catch (e) { /* unreadable: the caller degrades, it never guesses */ }
        }
        cache.set(key, result);
        return result;
    };
}

/**
 * Ceilings on what one Find References may materialise as peek models. A symbol used in a hundred
 * files would otherwise read, convert and hold a hundred panes — the peek is a preview, and the
 * References panel already lists every hit without any of this cost. Refs past the cap simply get
 * no peek entry, which is exactly the behaviour the whole feature started from.
 */
const PEEK_MAX_PANES = 50;
const PEEK_MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * Custom text editor provider that acts as a wrapper around TwinCAT XML files
 * and serves the Monaco webview editor.
 */
class TwinCatCustomEditorProvider {
    /**
     * @param {vscode.ExtensionContext} context The extension context.
     * @param {Object} [options] { showReferences(targetWord, items) } sink for the References view.
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
                    this.options.onActiveFileChange(document.uri);
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
                    let pendingText = document.getText();
                    for (const edit of message.edits) {
                        pendingText = replaceComponentCdata(
                            pendingText,
                            edit.context,
                            edit.blockType,
                            edit.content
                        );
                    }
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
                    let saveText = document.getText();
                    for (const edit of message.edits) {
                        saveText = replaceComponentCdata(
                            saveText,
                            edit.context,
                            edit.blockType,
                            edit.content
                        );
                    }
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
                        const ctx = assembleSt(document, message);
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
                        const ctx = assembleSt(document, message);
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
                            if (definition && definition.uri && definition.range) {
                                // Resolve the answer to an exact (component, pane, local line), the same
                                // way custom/references does. Without it the webview only knew a file, a
                                // component and a NAME, and fell back to a first-match word search — which
                                // lands on the name's first appearance in the declaration pane. In an FB
                                // whose header comment mentions its own outputs ("…until bDone or bError"),
                                // that is a line of prose in a comment, not the declaration.
                                //
                                // The target may live in another file, so its own unit is what the range
                                // must be mapped against; createStResolver reads and converts it.
                                const entry = await createStResolver(message.fileUri, ctx)(definition.uri);
                                const loc = entry ? absoluteToLocal(entry.st.lineMap, definition.range.start.line) : null;
                                if (loc) {
                                    // componentId comes from the same mapping as pane/localLine so the
                                    // three can never disagree; it matches what the LSP reports.
                                    definition = Object.assign({}, definition, {
                                        componentId: loc.componentId,
                                        pane: loc.pane,
                                        localLine: loc.localLine0
                                    });
                                }
                            }
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
                        const ctx = assembleSt(document, message);
                        let mapped = [];
                        const panes = [];
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
                                // line) so the webview can render it in the peek. A location whose URI has
                                // no loaded model makes Monaco throw "Model not found", so each pane that
                                // is not one of the live editors ships its TEXT too and the webview builds
                                // a hidden model from it.
                                //
                                // This reads and converts the referenced files, which the
                                // showExternalReferences pass then does again for the panel. Kept as two
                                // passes deliberately: merging them would restructure the panel path for a
                                // few ms on a handful of files, and PEEK_MAX_PANES already bounds the work
                                // here to the files the preview can actually show.
                                const stCache = new Map();
                                const resolveSt = createStResolver(message.fileUri, ctx);
                                // The cap below counts FILES already opened, so the resolver's own cache is
                                // not enough — this pass needs to know whether a file has been seen yet.
                                const getSt = async (uri) => {
                                    const key = normUri(uri);
                                    const result = await resolveSt(uri);
                                    stCache.set(key, result);
                                    return result;
                                };

                                const paneByKey = new Map();
                                let textBudget = PEEK_MAX_TEXT_BYTES;
                                for (const r of (refs || [])) {
                                    if (!r || !r.uri) continue;
                                    const key = normUri(r.uri);
                                    // Stop opening NEW files once the preview is full; already-read ones
                                    // still resolve, so the cap bounds file reads, not just models.
                                    if (!stCache.has(key) && paneByKey.size >= PEEK_MAX_PANES) continue;
                                    const entry = await getSt(r.uri);
                                    if (!entry) continue;
                                    const loc = absoluteToLocal(entry.st.lineMap, r.range.start.line);
                                    if (!loc) continue;

                                    const paneKey = `${key}::${loc.componentId}::${loc.pane}`;
                                    if (!paneByKey.has(paneKey) && paneByKey.size < PEEK_MAX_PANES) {
                                        const text = paneTextFromUnit(entry.lines, entry.st.lineMap, loc.componentId, loc.pane);
                                        if (text !== null && text.length <= textBudget) {
                                            textBudget -= text.length;
                                            paneByKey.set(paneKey, {
                                                key: paneKey,
                                                uri: r.uri,
                                                componentId: loc.componentId,
                                                pane: loc.pane,
                                                path: peekPath(r.uri, loc.componentId, loc.pane),
                                                text: text
                                            });
                                        }
                                    }

                                    mapped.push({
                                        sameFile: key === normUri(message.fileUri),
                                        uri: r.uri,
                                        paneKey: paneKey,
                                        componentId: loc.componentId,
                                        pane: loc.pane,
                                        line: loc.localLine0,
                                        startCharacter: r.range.start.character,
                                        endCharacter: r.range.end.character
                                    });
                                }
                                panes.push(...paneByKey.values());
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
                        const ctx = assembleSt(document, message);
                        let mapped = [];
                        if (ctx) {
                            /** @type {any} */
                            const diagnostics = await vscode.commands.executeCommand('twincat.lsp.queryDiagnostics', {
                                code: ctx.stText,
                                fileUri: message.fileUri
                            });
                            // Map full-unit diagnostics back to per-component panes/lines.
                            mapped = mapDiagnosticsToMonaco(diagnostics || [], ctx.lineMap);
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
                        const ctx = assembleSt(document, message);
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
                        // can be listed and navigated to (cross-file references can't render in the webview peek).
                        // Cache the split lines alongside the converted ST: the line lookup below runs
                        // once per reference, and splitting the whole unit each time made a search with
                        // many hits in one file re-split that file's entire text for every one of them.
                        const getSt = createStResolver(message.fileUri, ctx);

                        const items = [];
                        let searchedWord = '';
                        for (const r of refs) {
                            const entry = await getSt(r.uri);
                            if (!entry) continue;
                            const st = entry.st;
                            const lines = entry.lines;
                            const lineText = (lines[r.range.start.line] || '').trim();
                            const targetWord = (lines[r.range.start.line] || '').substring(r.range.start.character, r.range.end.character);
                            if (!searchedWord) searchedWord = targetWord;
                            const loc = absoluteToLocal(st.lineMap, r.range.start.line);
                            // Carry the exact location (pane + local line + start/end columns) so the
                            // References panel can navigate to the precise occurrence instead of relying
                            // on a first-match word search (which lands on the wrong hit when the same
                            // word appears earlier in the target component). `line` stays absolute for
                            // the .st navigation branch; pane/localLine are null when outside any block.
                            items.push({
                                uri: r.uri,
                                componentId: loc ? loc.componentId : 'root',
                                targetWord: targetWord,
                                lineText: lineText,
                                line: r.range.start.line,
                                pane: loc ? loc.pane : null,
                                localLine: loc ? loc.localLine0 : null,
                                startCharacter: r.range.start.character,
                                endCharacter: r.range.end.character
                            });
                        }

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
