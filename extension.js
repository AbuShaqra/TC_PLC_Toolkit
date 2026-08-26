/**
 * @file extension.js
 * @description Main entry point and orchestration controller for the TwinCAT PLC Toolkit VS Code extension.
 */

const vscode = require('vscode');
const path = require('path');

// Import modular components
const { registerLspBridgeCommands } = require('./src/commands/lspBridgeCommands');
const { registerLibraryCommands } = require('./src/commands/libraryCommands');
const { registerObjectCommands, applyXmlEdit } = require('./src/commands/objectCommands');
const { registerObjectInsertCommands } = require('./src/commands/objectInsertCommands');
const { registerClipboardCommands } = require('./src/commands/clipboardCommands');
const { registerRenameCommands } = require('./src/commands/renameCommands');
const { TwinCatDragAndDropController } = require('./src/treeDragAndDrop');
const { TwinCatCustomEditorProvider } = require('./src/customEditorProvider');
const { TwinCatTreeDataProvider } = require('./src/treeDataProvider');
const { TwinCatReferencesProvider } = require('./src/referencesProvider');
const { TwinCatLibraryTreeDataProvider } = require('./src/libraryTreeProvider');
// Lives under media/ because the webview loads it with a <script> tag; it is written to require()
// cleanly as well so both editors fold ST identically from one copy of the algorithm.
const stFolding = require('./media/stFolding');
const { createDebouncer } = require('./src/util/debounce');
const { TWINCAT_EDITOR_EXTS, TWINCAT_WATCH_EXTS } = require('./src/twincatWorkspace');
const { LanguageClient, TransportKind, State } = require('vscode-languageclient/node');

let client;

/**
 * Quiet period for the `.plcproj` watcher, in milliseconds. src/plcProjHelper.js rewrites the
 * `.plcproj` on every Objects-tree create/delete, and each rewrite used to trigger a FULL workspace
 * re-index — every project, every library archive — so adding three methods in a row paid for three
 * whole scans. Long enough to swallow a burst of those writes, short enough that a library added in
 * TwinCAT still shows up as soon as the user looks.
 * @type {number}
 */
const PLCPROJ_REINDEX_DEBOUNCE_MS = 400;

/**
 * Activates the extension. Sets up providers, watches workspace changes, and registers commands.
 * @param {vscode.ExtensionContext} context The extension context.
 */
function activate(context) {
    // References results view (populated when the user runs Find All References in the editor).
    const referencesProvider = new TwinCatReferencesProvider();
    const referencesView = vscode.window.createTreeView('twincatReferences', { treeDataProvider: referencesProvider });
    context.subscriptions.push(referencesView);

    const showReferences = (targetWord, items) => {
        referencesProvider.setReferences(targetWord, items);
        vscode.commands.executeCommand('setContext', 'twincat.hasReferences', items && items.length > 0);
        if (items && items.length > 0 && referencesProvider.roots.length > 0) {
            referencesView.title = `TwinCAT References (${referencesProvider.total})`;
            // Reveal, but never focus. This runs *while Monaco is opening its peek widget* inside the
            // webview — the webview posts `showExternalReferences` from within provideReferences — so
            // focusing the panel here pulled focus out of the webview and the peek was destroyed before
            // the user ever saw it. The panel is the secondary surface; the peek is the one the user
            // asked for.
            //
            // focus:false still brings the view to the front: VS Code's $reveal opens the view
            // (switching the panel to this tab, and opening the panel if it is closed) and only then
            // decides whether to focus it. That is what makes the results visible when the panel was
            // sitting on Terminal or Problems.
            //
            // Expansion is reveal-driven — every root is revealed with expand: 2 (file -> component;
            // occurrences are leaves) — instead of the nodes claiming collapsibleState Expanded: a
            // refresh racing a reveal could leave a group's children unfetched, an arrow that expands
            // to nothing (real user report). reveal serializes against the pending refresh. The roots
            // are walked in reverse so the final reveal — roots[0], the only selected one — leaves the
            // viewport scrolled to the first group.
            //
            // A rejection here means the results are on screen nowhere, so it must not be silent —
            // reveal() rejects outright if the provider has no getParent(), which is exactly how this
            // went unnoticed before.
            (async () => {
                try {
                    const roots = referencesProvider.roots;
                    for (let i = roots.length - 1; i >= 1; i--) {
                        await referencesView.reveal(roots[i], { select: false, focus: false, expand: 2 });
                    }
                    await referencesView.reveal(roots[0], { focus: false, expand: 2 });
                } catch (err) {
                    console.error('TwinCAT: could not reveal the References view', err);
                }
            })();
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.clearReferences', () => {
            referencesProvider.clear();
            vscode.commands.executeCommand('setContext', 'twincat.hasReferences', false);
        })
    );

    // Extension-host copy of the project partition (the LSP's copy lives in the other process and
    // is not reachable from here). The sibling solution model is presentation-only and follows the
    // `.sln`/`.tsproj`/`.xti` chain for the Objects tree. Both rebuild on activation and relevant
    // project-structure changes; only `.plcproj` changes trigger an LSP reindex below.
    const { createProjectMap } = require('./src/lsp/projectMap');
    const { createSolutionMap } = require('./src/solutionMap');
    const { createProjectStatusBar } = require('./src/projectStatusBar');
    let hostProjectMap = null;
    let hostSolutionMap = null;
    /**
     * Rebuilds the extension host's project partition and solution presentation hierarchy.
     */
    const refreshProjectMap = () => {
        const folders = vscode.workspace.workspaceFolders || [];
        hostProjectMap = createProjectMap(folders.map(f => f.uri.fsPath));
        hostSolutionMap = createSolutionMap(folders.map(f => f.uri.fsPath), hostProjectMap);
    };
    refreshProjectMap();
    // Declared before revealUri (next) is defined: revealUri calls projectStatusBar.refresh() on
    // every invocation, including the synchronous "reveal the already-open active editor" call
    // below (~line 133) that runs before the tree/editor-provider setup further down — constructing
    // this any later would reference projectStatusBar before its declaration executes.
    const projectStatusBar = createProjectStatusBar(context, () => hostProjectMap);

    let treeView;
    let treeProvider;
    const revealUri = async (uri, componentId = 'root') => {
        // Runs for every active-file change (custom-editor webview activation AND plain text
        // editors), independent of the tree-reveal eligibility check below, so switching to a
        // non-TwinCAT file correctly hides the indicator rather than leaving it showing the
        // previously active project.
        projectStatusBar.refresh(uri);
        if (!treeView) return;
        const ext = path.extname(uri.fsPath).toLowerCase();
        if (!TWINCAT_EDITOR_EXTS.has(ext)) {
            return;
        }

        try {
            const item = await treeProvider.getRevealItem(uri, componentId);
            await treeView.reveal(item, { select: true, focus: false, expand: true });
        } catch (err) {
            // Ignore error
        }
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document) {
                revealUri(editor.document.uri);
                // A plain text editor is now the most recent place the user typed, so an insert must
                // no longer go to a TwinCAT webview they have left (see insertTextIntoActivePanel).
                provider.clearLastActivePanel();
            }
        })
    );

    // Reveal active text editor immediately if open
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
        revealUri(vscode.window.activeTextEditor.document.uri);
    }

    const provider = new TwinCatCustomEditorProvider(context, {
        showReferences,
        onActiveFileChange: revealUri,
        // Re-read on every call: a `.plcproj` edit rebuilds the map (same contract as the tree/status bar).
        getProjectMap: () => hostProjectMap
    });

    // Push a single TwinCAT file's raw XML to the LSP so it can build a real-range symbol node.
    const indexFileOnLsp = async (uri) => {
        if (!client) return;
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const xml = Buffer.from(bytes).toString('utf8');
            await client.sendRequest('custom/indexXmlDocument', {
                fileUri: uri.toString(),
                xml: xml
            });
        } catch (e) {
            console.error('Failed to index XML document on LSP server:', e);
        }
    };

    // Initialize and start custom LSP server
    const serverModule = context.asAbsolutePath(path.join('src', 'lsp', 'server.js'));
    const serverOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6009'] }
        }
    };
    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'twincat-st' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.st')
        }
    };
    client = new LanguageClient(
        'twincatStLsp',
        'TwinCAT Structured Text LSP',
        serverOptions,
        clientOptions
    );
    client.start();

    /**
     * Runs an indexing round-trip under the status-bar progress indicator.
     *
     * The extension host is a SEPARATE process from the LSP, so its event loop is free even while
     * the server is blocked inside a synchronous scan — which is exactly why a host-side indicator
     * works at all, and why it is the only honest signal available today. `ProgressLocation.Window`
     * is the status-bar spot language servers conventionally use; `Notification` would put a popup on
     * screen every time a window opens.
     *
     * The progress is deliberately INDETERMINATE — no "3 of 8". Per-project counts would need the
     * scan to yield to the event loop between projects, which it does not do; a fabricated percentage
     * would be a worse lie than a spinner.
     *
     * `Promise.resolve` wraps the Thenable withProgress returns, so callers get a real Promise with
     * `.catch` rather than a bare `.then`.
     * @param {string} title Status-bar text.
     * @param {() => Thenable<any>} task The work to run while the indicator is up.
     * @returns {Promise<any>} The task's result.
     */
    const withIndexingProgress = (title, task) => Promise.resolve(
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => task())
    );

    // Starting, indexing and stopped/crashed used to be ONE silence: language features simply did
    // nothing, and there was no way to tell "wait a moment" from "this is broken" — a distinction
    // that cost a day of hunting a bug that was not there. The progress indicator above covers
    // indexing; this covers the other two. client.onDidChangeState has existed all along and was
    // never wired up.
    const lspStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    context.subscriptions.push(lspStatus);
    context.subscriptions.push(
        client.onDidChangeState(e => {
            if (e.newState === State.Running) {
                lspStatus.hide();
            } else if (e.newState === State.Starting) {
                lspStatus.text = '$(sync~spin) TwinCAT: starting…';
                lspStatus.tooltip = 'The TwinCAT language server is starting.';
                lspStatus.show();
            } else {
                // Stopped. Reached by a crash and by the clean shutdown in deactivate() alike; the
                // item is disposed with the extension, so the shutdown case is never seen for long.
                lspStatus.text = '$(warning) TwinCAT: language server stopped';
                lspStatus.tooltip = 'The TwinCAT language server is not running: completion, go to '
                    + 'definition, references and diagnostics are unavailable. Reload the window to restart it.';
                lspStatus.show();
                console.error('TwinCAT: the language server stopped.');
            }
        })
    );

    // Folding for plain `.st` files opened in VS Code's own editor, from the same module the webview
    // panes use. Without it these files keep VS Code's indentation folding and both defects that came
    // with it: an unmatched `{endregion}` truncating the enclosing VAR fold, and an unindented line
    // under an indented VAR body growing a fold arrow of its own. The language configuration's region
    // markers are inert while this is registered — a range provider replaces the indentation one — and
    // are kept as the declarative fallback. See media/stFolding.js.
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider({ language: 'twincat-st' }, {
            provideFoldingRanges(document) {
                const lines = [];
                for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);
                return stFolding.computeFoldingRanges(lines).map(r => new vscode.FoldingRange(
                    // VS Code's FoldingRange is 0-based; stFolding speaks the 1-based line numbers
                    // Monaco's provider API wants.
                    r.start - 1,
                    r.end - 1,
                    r.kind === 'region' ? vscode.FoldingRangeKind.Region : undefined
                ));
            }
        })
    );

    // Push diagnostics configuration to the LSP, and keep it in sync with settings changes.
    const sendDiagnosticsConfig = () => {
        if (!client) return;
        const cfg = vscode.workspace.getConfiguration('twincat.diagnostics');
        client.sendRequest('custom/setDiagnosticsConfig', {
            memberAccess: cfg.get('memberAccess', true),
            callArguments: cfg.get('callArguments', true),
            declarationTypes: cfg.get('declarationTypes', false),
            typeCompatibility: cfg.get('typeCompatibility', true)
        }).catch(e => console.error('Failed to set diagnostics config on LSP server:', e));
    };
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('twincat.diagnostics')) {
                sendDiagnosticsConfig();
                // Re-run diagnostics in open webviews so the change takes effect immediately.
                for (const panel of provider.activePanels.values()) {
                    panel.webview.postMessage({ type: 'refreshDiagnostics' });
                }
            }
        })
    );

    // Wait for the LSP's initial workspace index. This is a BARRIER, not a rebuild request: the
    // server already indexes the workspace folders in onInitialize, and everything below only needs
    // to happen *after* that index exists. Sending `custom/reindex` here — which means "the data
    // changed, rebuild unconditionally" — made every startup pay for the whole scan a second time
    // (~35 s cold on an eight-project folder). `custom/indexReady` says what this actually wants; the
    // fallback keeps a server that predates it working, since it is only the barrier either way.
    if (client) {
        const folders = vscode.workspace.workspaceFolders || [];
        const folderUris = folders.map(f => f.uri.toString());
        withIndexingProgress('TwinCAT: indexing…', () =>
            client.sendRequest('custom/indexReady', { folders: folderUris })
                .catch(() => client.sendRequest('custom/reindex', { folders: folderUris }))
        ).then(() => {
            sendDiagnosticsConfig();
            // The library catalog is a product of that index — refresh the view with it, so the
            // two can never disagree about which libraries the project references.
            libraryProvider.refresh();
        }).catch(e => console.error('Failed to trigger LSP re-index:', e));
    }

    // Register custom editor provider
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('twincat.xmlViewer', provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );

    // Register tree view provider. Drag & drop logic lives entirely in the controller (and the
    // pure matrix under it) — extension.js only supplies its dependencies.
    treeProvider = new TwinCatTreeDataProvider(() => hostProjectMap, () => hostSolutionMap);
    treeView = vscode.window.createTreeView('twincatExplorer', {
        treeDataProvider: treeProvider,
        dragAndDropController: new TwinCatDragAndDropController({ treeProvider, applyXmlEdit })
    });
    context.subscriptions.push(treeView);

    // "TwinCAT Libraries" view: the .plcproj's libraries, listed under the namespace the code must
    // use — they are frequently different names. The catalog lives in the LSP (it falls out of the
    // library index), so the provider is handed a closure over the client rather than the client.
    const libraryProvider = new TwinCatLibraryTreeDataProvider(
        (method, params) => (client ? client.sendRequest(method, params) : Promise.resolve([]))
    );
    context.subscriptions.push(
        vscode.window.createTreeView('twincatLibraries', {
            treeDataProvider: libraryProvider
        })
    );

    // "TwinCAT Libraries" view commands: refresh, regenerate signatures (drives TwinCAT), copy
    // namespace / qualified name, and insert a symbol at the caret.
    registerLibraryCommands(context, { libraryProvider, provider, getClient: () => client });

    // Watch for document saves/changes to refresh the explorer tree and the LSP index
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async e => {
            const extName = path.extname(e.fileName).toLowerCase();
            if (TWINCAT_WATCH_EXTS.has(extName)) {
                treeProvider.refresh();
                await indexFileOnLsp(e.uri);
            }
        })
    );

    // Watch filesystem for external creations, deletions, and changes
    const workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*');

    const shouldRefresh = (uri) => {
        const fsPath = uri.fsPath;
        const parts = fsPath.split(path.sep);
        if (parts.includes('.git') || parts.includes('node_modules') || parts.includes('.vscode')) {
            return false;
        }
        return true;
    };

    // The .plcproj is where the library references live, so it is the only file whose change can
    // change the Libraries view. The catalog is built by the LSP's library index, so refreshing the
    // view alone would only re-render the stale list: the LSP has to re-read the .plcproj first, or
    // a library added in TwinCAT would never appear.
    //
    // Debounced, because the bursts are self-inflicted: src/plcProjHelper.js rewrites the `.plcproj`
    // on every Objects-tree create/delete, so creating three methods used to fire three full
    // workspace re-indexes back to back. Only the final state of the file is worth indexing, so the
    // burst collapses into one `custom/reindex` and one view refresh (trailing edge — a leading call
    // would index the `.plcproj` as it stood before the change that triggered it).
    const reindexForLibraries = createDebouncer(() => {
        const folders = vscode.workspace.workspaceFolders || [];
        return withIndexingProgress('TwinCAT: indexing…', () =>
            client.sendRequest('custom/reindex', { folders: folders.map(f => f.uri.toString()) })
        ).then(() => libraryProvider.refresh())
            .catch(e => {
                console.error('Failed to re-index after a .plcproj change:', e);
                libraryProvider.refresh(); // still re-render: a stale list beats a frozen one
            });
    }, PLCPROJ_REINDEX_DEBOUNCE_MS);
    // A queued re-index firing into a torn-down extension host would reject against a dead client.
    context.subscriptions.push({ dispose: () => reindexForLibraries.cancel() });

    const refreshProjectStructureFor = (uri) => {
        const ext = path.extname(uri.fsPath).toLowerCase();
        if (!['.sln', '.tsproj', '.xti', '.plcproj'].includes(ext)) return;
        // The host's own partition (used by the status bar) is independent of the LSP's copy and
        // must be rebuilt when either ownership or the solution membership chain changes.
        refreshProjectMap();
        treeProvider.refresh();
        // Only `.plcproj` content changes language/library indexing. Solution, system-project and
        // XTI changes merely regroup already-known project directories in the Objects tree.
        if (ext !== '.plcproj') return;
        if (!client) {
            libraryProvider.refresh();
            return;
        }
        reindexForLibraries.schedule();
    };

    context.subscriptions.push(
        workspaceWatcher.onDidCreate(async uri => {
            if (shouldRefresh(uri)) {
                treeProvider.refresh();
                refreshProjectStructureFor(uri);
                // Only TwinCAT source files get cached/indexed. Creating a *folder* also fires this
                // watcher, and reading a directory throws EISDIR — so gate on the extension, exactly
                // as onDidChange does. (The tree refresh still runs for every relevant create.)
                const extName = path.extname(uri.fsPath).toLowerCase();
                if (TWINCAT_WATCH_EXTS.has(extName)) {
                    await indexFileOnLsp(uri);
                }
            }
        })
    );

    context.subscriptions.push(
        workspaceWatcher.onDidDelete(uri => {
            if (shouldRefresh(uri)) {
                treeProvider.refresh();
                refreshProjectStructureFor(uri);
            }
        })
    );

    context.subscriptions.push(
        workspaceWatcher.onDidChange(async uri => {
            if (shouldRefresh(uri)) {
                refreshProjectStructureFor(uri);
                const extName = path.extname(uri.fsPath).toLowerCase();
                if (TWINCAT_WATCH_EXTS.has(extName)) {
                    treeProvider.refresh();
                    await indexFileOnLsp(uri);
                }
            }
        })
    );

    context.subscriptions.push(workspaceWatcher);

    // LSP-bridge routing + the tree-view "open component and select" navigation command.
    registerLspBridgeCommands(context, { provider, getClient: () => client });

    // TwinCAT Objects explorer create/delete commands (methods, properties, actions; new files;
    // physical and virtual folders; components).
    registerObjectCommands(context, { treeProvider });

    // Objects explorer insert-at-caret commands (the object's own name, or a call template built
    // from its real parameters). Needs `provider`, because a TwinCAT file is a webview and the
    // insert has to be posted to the panel — same wiring as registerLibraryCommands above.
    registerObjectInsertCommands(context, { provider });

    // Objects explorer copy/paste (copy = duplicate; drag & drop is the move). Needs treeView —
    // keybinding invocations carry no item, so the selection stands in — hence registered after
    // createTreeView above.
    registerClipboardCommands(context, { treeView, treeProvider, applyXmlEdit });

    // Objects explorer rename (F2). Renames files, members, directories and virtual folders, and —
    // after a confirmation modal — updates cross-file references via the LSP + renameEngine. Needs
    // treeView (F2 carries no item, so the selection stands in) and getClient (the reference query),
    // mirroring the clipboard and library command wiring.
    registerRenameCommands(context, { treeView, treeProvider, applyXmlEdit, getClient: () => client });
}

function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

module.exports = {
    activate,
    deactivate
};
