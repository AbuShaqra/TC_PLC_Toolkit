/**
 * @file extension.js
 * @description Main entry point and orchestration controller for the TwinCAT PLC Toolkit VS Code extension.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

// Import modular components
const { TwinCatCustomEditorProvider } = require('./src/customEditorProvider');
const { TwinCatTreeDataProvider } = require('./src/treeDataProvider');
const { TwinCatReferencesProvider } = require('./src/referencesProvider');
const { TwinCatLibraryTreeDataProvider, insertTextForNode, formattedDefinitionForNode } = require('./src/libraryTreeProvider');
const { registerInPlcProj, unregisterFromPlcProj } = require('./src/plcProjHelper');
const {
    getWorkspaceTypesCache,
    setWorkspaceTypesCache,
    indexWorkspaceTypes,
    updateCacheForFile
} = require('./src/typesCache');
const {
    parseTwinCatXml,
    getFoldersDetailedFromXml,
    insertFolderIntoXml,
    insertComponentIntoXml,
    deleteComponentFromXml,
    deleteFolderTagFromXml
} = require('./src/xmlParser');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

/**
 * The TwinCAT XAE shells the signature generator knows how to drive, newest first.
 *
 * Both may be installed side by side, and they are **not** interchangeable: a library's signatures can
 * differ depending on which shell produced them — visualisation libraries especially — so the user is
 * asked which one to drive rather than us picking the first hit.
 * @type {{id: string, label: string, progId: string, exePath: string}[]}
 */
const TCXAESHELL_CANDIDATES = [
    {
        id: 'x64',
        label: 'TcXaeShell (64-bit)',
        progId: 'TcXaeShell.DTE.17.0',
        exePath: 'C:\\Program Files\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe'
    },
    {
        id: 'x86',
        label: 'TcXaeShell (32-bit)',
        progId: 'TcXaeShell.DTE.15.0',
        exePath: 'C:\\Program Files (x86)\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe'
    }
];

/**
 * Reads a registry key's *default* value with reg.exe, or null if the key/value is absent.
 *
 * Anchored on the `REG_SZ` type token rather than on the value's name: reg.exe is localized, so the
 * default value prints as "(Standard)" on a German Windows and "(Default)" on an English one.
 * @param {string} key Full key path, e.g. `HKCR\\TcXaeShell.DTE.17.0\\CLSID`.
 * @param {string} [view] Optional registry view flag — `/reg:64` or `/reg:32`.
 * @returns {string|null} The default value, or null.
 */
function regDefaultValue(key, view) {
    const args = ['query', key, '/ve'];
    if (view) args.push(view);
    try {
        const out = execFileSync('reg.exe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = /REG_SZ\s+(.+)/.exec(out);
        return m ? m[1].trim() : null;
    } catch (e) {
        return null;  // key not present in this view
    }
}

/**
 * Resolves a DTE ProgID to the .exe that serves it, via its CLSID's LocalServer32 registration.
 *
 * This is the fallback for a shell installed somewhere other than the default Beckhoff path: the COM
 * registration is what we actually need (that is how the script attaches), and it also records where the
 * .exe really is. The 32-bit shell registers its LocalServer32 in the 32-bit registry view only and the
 * 64-bit one in the 64-bit view only, so both views are tried.
 * @param {string} progId e.g. `TcXaeShell.DTE.17.0`.
 * @returns {string|null} Absolute path to an existing .exe, or null.
 */
function shellExeFromRegistry(progId) {
    const clsid = regDefaultValue(`HKCR\\${progId}\\CLSID`) || regDefaultValue(`HKCR\\${progId}\\CLSID`, '/reg:32');
    if (!clsid) return null;
    for (const view of ['/reg:64', '/reg:32']) {
        let raw = regDefaultValue(`HKCR\\CLSID\\${clsid}\\LocalServer32`, view);
        if (!raw) continue;
        // The registration may be quoted and may carry a trailing switch (e.g. /Automation).
        const quoted = /^"([^"]+)"/.exec(raw);
        if (quoted) raw = quoted[1];
        else if (!fs.existsSync(raw)) raw = raw.replace(/\s+[/-]\S+\s*$/, '');
        if (raw && fs.existsSync(raw)) return raw;
    }
    return null;
}

/**
 * The TwinCAT XAE shells actually installed on this machine, newest first.
 *
 * Probed before the generator is spawned so a user without TwinCAT gets an immediate, honest message
 * instead of a PowerShell window that fails a minute later — and so the user can be asked *which* shell
 * to drive when both are present.
 * @returns {{id: string, label: string, progId: string, exePath: string}[]} Possibly empty.
 */
function findTwinCatShells() {
    const shells = [];
    for (const cand of TCXAESHELL_CANDIDATES) {
        const exePath = fs.existsSync(cand.exePath) ? cand.exePath : shellExeFromRegistry(cand.progId);
        if (!exePath) continue;
        shells.push(Object.assign({}, cand, { exePath }));
    }
    return shells;
}

/**
 * Runs the library-signature generator over a workspace folder and resolves with its exit code.
 *
 * The generator is a PowerShell script rather than Node because it must drive TwinCAT's COM automation
 * interface, which needs a **single-threaded apartment** (`-STA`) and an `IOleMessageFilter` — neither
 * of which Node can provide. It is the only part of the toolkit that touches TwinCAT, and it only ever
 * runs when the user explicitly asks for it: the extension itself stays fully offline.
 *
 * The chosen shell is passed in explicitly (`-ShellExe` / `-ProgId`) instead of letting the script find
 * one itself: which shell produces the dump is a user decision, because the signatures can differ.
 * @param {string} scriptPath Absolute path to generate-library-signatures.ps1.
 * @param {string} workspaceFolder Absolute workspace folder to generate for.
 * @param {{exePath: string, progId: string}} shell The XAE shell the user chose to drive.
 * @param {vscode.OutputChannel} output Channel the script's stdout/stderr is streamed to.
 * @param {(line: string) => void} onLine Called with each output line (drives the progress report).
 * @returns {Promise<number>} The script's exit code (0 = success).
 */
function runSignatureGenerator(scriptPath, workspaceFolder, shell, output, onLine) {
    return new Promise((resolve) => {
        const proc = spawn(
            'powershell.exe',
            [
                '-NoProfile', '-STA', '-File', scriptPath, workspaceFolder,
                '-ShellExe', shell.exePath,
                '-ProgId', shell.progId
            ],
            { windowsHide: true }
        );

        let pending = '';
        const consume = (chunk) => {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();           // keep the partial trailing line for the next chunk
            for (const line of lines) {
                output.appendLine(line);
                if (line.trim()) onLine(line.trim());
            }
        };

        proc.stdout.on('data', consume);
        proc.stderr.on('data', consume);
        proc.on('error', (err) => {
            output.appendLine(`Failed to start PowerShell: ${err.message}`);
            resolve(1);
        });
        proc.on('close', (code) => {
            if (pending.trim()) output.appendLine(pending.trim());
            resolve(code === null ? 1 : code);
        });
    });
}

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
            // A rejection here means the results are on screen nowhere, so it must not be silent —
            // reveal() rejects outright if the provider has no getParent(), which is exactly how this
            // went unnoticed before.
            referencesView.reveal(referencesProvider.roots[0], { focus: false, expand: true })
                .then(() => {}, (err) => console.error('TwinCAT: could not reveal the References view', err));
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.clearReferences', () => {
            referencesProvider.clear();
            vscode.commands.executeCommand('setContext', 'twincat.hasReferences', false);
        })
    );

    let treeView;
    const { TwinCatTreeItem } = require('./src/treeDataProvider');
    const revealUri = async (uri) => {
        if (!treeView) return;
        const ext = path.extname(uri.fsPath).toLowerCase();
        if (!['.tcpou', '.tcio', '.tcgvl', '.tcdut', '.st'].includes(ext)) {
            return;
        }

        let contextValue = 'pouFile';
        if (ext === '.tcio') {
            contextValue = 'itfFile';
        } else if (ext === '.tcgvl') {
            contextValue = 'gvlFile';
        } else if (ext === '.tcdut') {
            contextValue = 'dutFile';
        } else if (ext === '.st') {
            contextValue = 'stFile';
        }

        const fileItem = new TwinCatTreeItem(
            path.basename(uri.fsPath),
            uri,
            vscode.TreeItemCollapsibleState.None,
            contextValue,
            null,
            null
        );

        try {
            await treeView.reveal(fileItem, { select: true, focus: false, expand: true });
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
        onActiveFileChange: revealUri
    });

    const broadcastTypesMap = () => {
        const typesMap = getWorkspaceTypesCache();
        for (const panel of provider.activePanels.values()) {
            panel.webview.postMessage({
                type: 'updateTypesMap',
                typesMap: typesMap
            });
        }
        if (client) {
            client.sendRequest('custom/updateTypesMap', {
                typesMap: typesMap
            }).catch(e => console.error('Failed to update types map on LSP server:', e));
        }
    };

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
    
    // Index the workspace types asynchronously at startup
    indexWorkspaceTypes().then(map => {
        setWorkspaceTypesCache(map);
        if (client) {
            const folders = vscode.workspace.workspaceFolders || [];
            client.sendRequest('custom/reindex', {
                folders: folders.map(f => f.uri.toString())
            }).then(() => {
                sendDiagnosticsConfig();
                broadcastTypesMap();
                // The library catalog is a product of that index — refresh the view with it, so the
                // two can never disagree about which libraries the project references.
                libraryProvider.refresh();
            }).catch(e => console.error('Failed to trigger LSP re-index:', e));
        } else {
            broadcastTypesMap();
        }
    }).catch(err => {
        console.error('Failed to initially index workspace types:', err);
    });
    
    // Register custom editor provider
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('twincat.xmlViewer', provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );

    // Register tree view provider
    const treeProvider = new TwinCatTreeDataProvider();
    treeView = vscode.window.createTreeView('twincatExplorer', {
        treeDataProvider: treeProvider
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

    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.refreshLibraries', () => libraryProvider.refresh()),
        // Regenerate library-signatures.xml by driving TwinCAT (see scripts/generate-library-signatures.ps1).
        // The dump carries what neither the archives nor the project's .tmc can give us — function
        // signatures, I/O of FBs the project has not adopted yet, and global constants — for every
        // referenced library. Once written, the normal reindex path picks it up offline.
        vscode.commands.registerCommand('twincat.updateLibraryDefinitions', async () => {
            const folders = vscode.workspace.workspaceFolders || [];
            if (folders.length === 0) {
                vscode.window.showErrorMessage('Open a TwinCAT project folder before updating library definitions.');
                return;
            }

            const shells = findTwinCatShells();
            if (shells.length === 0) {
                vscode.window.showErrorMessage(
                    'Updating library definitions requires a TwinCAT XAE installation (TcXaeShell) on this machine, ' +
                    'because only TwinCAT itself can export library signatures. The extension works fully offline ' +
                    'without it — you will just miss signatures for libraries the project does not already use.'
                );
                return;
            }

            const workspaceFolder = folders[0].uri.fsPath;
            const scriptPath = path.join(context.extensionPath, 'scripts', 'generate-library-signatures.ps1');
            if (!fs.existsSync(scriptPath)) {
                vscode.window.showErrorMessage(`Generator script not found: ${scriptPath}`);
                return;
            }

            // Which shell dumps the signatures is a real decision, not a detail: the same library can
            // produce different signatures from the 32-bit and the 64-bit shell (visualisation libraries
            // are the known case). So confirm — with one shell installed the pick is a confirmation,
            // with two it is a choice — and treat a cancelled pick as "do nothing".
            //
            // `twincat.libraryDefinitions.shell` skips the prompt for people who always use the same
            // one. A configured shell that is NOT installed falls back to asking rather than to the
            // other bitness: silently producing the signatures the user configured *against* is the one
            // outcome this whole setting exists to prevent.
            const configured = vscode.workspace.getConfiguration('twincat').get('libraryDefinitions.shell', 'ask');
            const preferred = configured !== 'ask' ? shells.find(s => s.id === configured) : null;

            let shell = preferred;
            if (!shell) {
                if (configured !== 'ask') {
                    vscode.window.showWarningMessage(
                        `twincat.libraryDefinitions.shell is set to "${configured}", but that XAE Shell is not ` +
                        'installed. Choose one instead.'
                    );
                }
                const picked = await vscode.window.showQuickPick(
                    shells.map(s => ({
                        label: s.label,
                        description: s.exePath,
                        detail: `${s.progId} — signatures can differ between the 32-bit and the 64-bit shell ` +
                                '(visualisation libraries especially), so pick the one this project is built with.',
                        shell: s
                    })),
                    {
                        title: 'Update Library Definitions',
                        placeHolder: shells.length > 1
                            ? 'Which TwinCAT XAE Shell should generate the library signatures?'
                            : 'Confirm the TwinCAT XAE Shell that will generate the library signatures',
                        ignoreFocusOut: true
                    }
                );
                if (!picked) return;  // cancelled — nothing has been started yet, so nothing to undo
                shell = picked.shell;
            }

            const output = vscode.window.createOutputChannel('TwinCAT Library Definitions');
            output.clear();
            output.show(true);

            const code = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Updating TwinCAT library definitions',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `Starting ${shell.label} (this can take a minute)...` });
                return runSignatureGenerator(scriptPath, workspaceFolder, shell, output, (line) => {
                    // The script's own progress lines are already user-facing prose — surface them as-is.
                    progress.report({ message: line });
                });
            });

            if (code !== 0) {
                vscode.window.showErrorMessage(
                    'Failed to update library definitions. See the "TwinCAT Library Definitions" output channel for details.'
                );
                return;
            }

            // The dump is only data on disk until the LSP re-reads it: custom/reindex is what runs
            // indexLibrarySignatures and merges it into the type registry. Refresh the view afterwards so
            // the two can never disagree about what is indexed (same order as the .plcproj watcher).
            if (client) {
                try {
                    await client.sendRequest('custom/reindex', { folders: folders.map(f => f.uri.toString()) });
                } catch (e) {
                    console.error('Failed to re-index after updating library definitions:', e);
                }
            }
            libraryProvider.refresh();
            vscode.window.showInformationMessage('TwinCAT library definitions updated.');
        }),
        vscode.commands.registerCommand('twincat.copyLibraryNamespace', async (node) => {
            if (!node || !node.entry) return;
            await vscode.env.clipboard.writeText(node.entry.namespace);
            vscode.window.setStatusBarMessage(`Copied "${node.entry.namespace}"`, 3000);
        }),
        vscode.commands.registerCommand('twincat.copyQualifiedName', async (node) => {
            if (!node || !node.type) return;
            const qualified = `${node.namespace}.${node.type.name}`;
            await vscode.env.clipboard.writeText(qualified);
            vscode.window.setStatusBarMessage(`Copied "${qualified}"`, 3000);
        }),
        // Insert at the caret. A TwinCAT file is a webview, not a text editor, so the insert has to be
        // posted to the panel; only a loose .st file goes through the normal editor API.
        vscode.commands.registerCommand('twincat.insertAtCursor', async (node) => {
            const text = insertTextForNode(node);
            if (!text) return;
            // A library inserts `Namespace.` — the caret then sits exactly where namespace-qualified
            // completion fires, so open the list for the user.
            const triggerSuggest = node.kind === 'library';

            if (provider.insertTextIntoActivePanel(text, triggerSuggest)) return;

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await editor.edit(b => b.insert(editor.selection.active, text));
                return;
            }
            vscode.window.showWarningMessage('Open a TwinCAT file and place the cursor where you want to insert.');
        }),
        // Same insertion path, but with the type's full parameter list laid out — the bare name is no
        // use for an FB with a dozen inputs you would then have to look up one by one.
        vscode.commands.registerCommand('twincat.insertDefinitionAtCursor', async (node) => {
            const text = formattedDefinitionForNode(node);
            if (!text) return;

            if (provider.insertTextIntoActivePanel(text, false)) return;

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await editor.edit(b => b.insert(editor.selection.active, text));
                return;
            }
            vscode.window.showWarningMessage('Open a TwinCAT file and place the cursor where you want to insert.');
        })
    );

    // Watch for document saves/changes to refresh the explorer tree and type cache
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async e => {
            const extName = path.extname(e.fileName).toLowerCase();
            if (['.tcpou', '.tcio', '.tcgvl', '.tcdut'].includes(extName)) {
                treeProvider.refresh();
                await updateCacheForFile(e.uri);
                await indexFileOnLsp(e.uri);
                broadcastTypesMap();
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
    const refreshLibrariesFor = (uri) => {
        if (path.extname(uri.fsPath).toLowerCase() !== '.plcproj') return;
        if (!client) {
            libraryProvider.refresh();
            return;
        }
        const folders = vscode.workspace.workspaceFolders || [];
        client.sendRequest('custom/reindex', { folders: folders.map(f => f.uri.toString()) })
            .then(() => libraryProvider.refresh())
            .catch(e => {
                console.error('Failed to re-index after a .plcproj change:', e);
                libraryProvider.refresh(); // still re-render: a stale list beats a frozen one
            });
    };

    context.subscriptions.push(
        workspaceWatcher.onDidCreate(async uri => {
            if (shouldRefresh(uri)) {
                treeProvider.refresh();
                refreshLibrariesFor(uri);
                await updateCacheForFile(uri);
                await indexFileOnLsp(uri);
                broadcastTypesMap();
            }
        })
    );

    context.subscriptions.push(
        workspaceWatcher.onDidDelete(uri => {
            if (shouldRefresh(uri)) {
                treeProvider.refresh();
                refreshLibrariesFor(uri);
                const rootName = path.basename(uri.fsPath, path.extname(uri.fsPath));
                const cache = getWorkspaceTypesCache();
                delete cache[rootName];
                broadcastTypesMap();
            }
        })
    );

    context.subscriptions.push(
        workspaceWatcher.onDidChange(async uri => {
            if (shouldRefresh(uri)) {
                refreshLibrariesFor(uri);
                const extName = path.extname(uri.fsPath).toLowerCase();
                if (['.tcpou', '.tcio', '.tcgvl', '.tcdut'].includes(extName)) {
                    treeProvider.refresh();
                    await updateCacheForFile(uri);
                    await indexFileOnLsp(uri);
                    broadcastTypesMap();
                }
            }
        })
    );

    context.subscriptions.push(workspaceWatcher);

    // Register navigation command from tree view
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.openComponent', async (fileUri, componentId, selectionRange, targetWord) => {
            const ext = path.extname(fileUri.fsPath).toLowerCase();
            if (ext === '.st') {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                let selection = undefined;
                if (selectionRange) {
                    const startPos = new vscode.Position(selectionRange.start.line, selectionRange.start.character);
                    const endPos = new vscode.Position(selectionRange.end.line, selectionRange.end.character);
                    selection = new vscode.Range(startPos, endPos);
                }
                await vscode.window.showTextDocument(doc, { selection: selection });
            } else {
                provider.setPendingSelection(fileUri.toString(), componentId, selectionRange, targetWord);
                await vscode.commands.executeCommand('vscode.openWith', fileUri, 'twincat.xmlViewer');
            }
        })
    );

    // Register custom commands to route webview Monaco queries to the LSP server
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.lsp.queryCompletions', async (params) => {
            if (!client) return [];
            return client.sendRequest('custom/completions', params);
        }),
        vscode.commands.registerCommand('twincat.lsp.queryDefinition', async (params) => {
            if (!client) return null;
            return client.sendRequest('custom/definition', params);
        }),
        vscode.commands.registerCommand('twincat.lsp.queryReferences', async (params) => {
            if (!client) return [];
            return client.sendRequest('custom/references', params);
        }),
        vscode.commands.registerCommand('twincat.lsp.queryDiagnostics', async (params) => {
            if (!client) return [];
            return client.sendRequest('custom/diagnostics', params);
        }),
        vscode.commands.registerCommand('twincat.lsp.updateDocument', async (params) => {
            if (!client) return { success: false };
            return client.sendRequest('custom/updateDocument', params);
        })
    );

    // Create Method Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createMethod', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleComponentCreation(node, 'Method');
        })
    );

    // Create Property Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createProperty', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleComponentCreation(node, 'Property');
        })
    );

    // Create Action Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createAction', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleComponentCreation(node, 'Action');
        })
    );

    // Create File FB Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileFB', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'FB');
        })
    );

    // Create File Program Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileProgram', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'PRG');
        })
    );

    // Create File Function Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileFunction', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'FUN');
        })
    );

    // Create File Interface Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileInterface', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'ITF');
        })
    );

    // Create File GVL Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileGVL', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'GVL');
        })
    );

    // Create Physical Folder Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createPhysicalFolder', async (node) => {
            if (!node || !node.resourceUri) return;
            const folderName = await vscode.window.showInputBox({
                prompt: 'Enter Folder Name',
                placeHolder: 'e.g. MyFolder',
                validateInput: val => {
                    if (!val || val.trim().length === 0) return 'Folder name cannot be empty';
                    if (val.includes('/') || val.includes('\\') || val.includes(':') || val.includes('*') || val.includes('?') || val.includes('"') || val.includes('<') || val.includes('>') || val.includes('|')) {
                        return 'Folder name contains invalid characters';
                    }
                    return null;
                }
            });
            if (!folderName) return;

            const newFolderUri = vscode.Uri.joinPath(node.resourceUri, folderName);
            try {
                await vscode.workspace.fs.createDirectory(newFolderUri);
                await registerInPlcProj(newFolderUri, true);
                treeProvider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to create folder: ${err.message}`);
            }
        })
    );

    // Delete Physical Item Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.deletePhysicalItem', async (node) => {
            if (!node || !node.resourceUri) return;
            
            const isDir = node.contextValue === 'directory';
            const label = path.basename(node.resourceUri.fsPath);
            const itemType = isDir ? 'folder' : 'file';
            
            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to delete the ${itemType} "${label}"?`,
                { modal: true },
                'Yes'
            );
            if (answer !== 'Yes') return;

            try {
                await unregisterFromPlcProj(node.resourceUri, isDir);
                await vscode.workspace.fs.delete(node.resourceUri, { recursive: true, useTrash: true });
                treeProvider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to delete ${itemType}: ${err.message}`);
            }
        })
    );

    // Create Virtual Folder Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createVirtualFolder', async (node) => {
            if (!node || !node.resourceUri) return;
            
            const folderName = await vscode.window.showInputBox({
                prompt: 'Enter Folder Name',
                placeHolder: 'e.g. Internal',
                validateInput: val => {
                    if (!val || val.trim().length === 0) return 'Folder name cannot be empty';
                    if (val.includes('\\') || val.includes('/')) return 'Folder name cannot contain slashes';
                    return null;
                }
            });
            if (!folderName) return;

            const fileUri = node.resourceUri;
            const parentFolderPath = (node && node.contextValue && node.contextValue.startsWith('pouVirtualFolder')) ? node.folderPath : '';
            
            await applyXmlEdit(fileUri, (xmlText) => {
                const uuid = `{${require('crypto').randomUUID()}}`;
                return insertFolderIntoXml(xmlText, parentFolderPath, folderName, uuid);
            });

            treeProvider.refresh();
        })
    );

    // Delete Component Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.deleteComponent', async (node) => {
            if (!node || !node.resourceUri || !node.componentId) return;
            
            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to delete "${node.label}"?`,
                { modal: true },
                'Yes'
            );
            if (answer !== 'Yes') return;

            const fileUri = node.resourceUri;
            
            await applyXmlEdit(fileUri, (xmlText) => {
                const parsed = parseTwinCatXml(xmlText);
                if (!parsed) return xmlText;
                
                const comp = parsed.components.find(c => c.id === node.componentId);
                if (!comp) return xmlText;
                
                const componentType = comp.xmlContext.subType || comp.type;
                const componentName = comp.xmlContext.subName || comp.name;
                const accessorType = comp.xmlContext.accessorType;
                if (!componentType || !componentName) return xmlText;
                
                return deleteComponentFromXml(xmlText, parsed.rootName, componentType, componentName, accessorType);
            });

            treeProvider.refresh();
        })
    );

    // Delete Virtual Folder Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.deleteVirtualFolder', async (node) => {
            if (!node || !node.resourceUri || !node.folderPath) return;
            
            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to delete virtual folder "${node.label}" and all its nested sub-components?`,
                { modal: true },
                'Yes'
            );
            if (answer !== 'Yes') return;

            const fileUri = node.resourceUri;
            const targetFolder = node.folderPath;
            
            await applyXmlEdit(fileUri, (xmlText) => {
                const parsed = parseTwinCatXml(xmlText);
                if (!parsed) return xmlText;
                
                let cleanedText = xmlText;
                
                // 1. Delete all sub-components inside this folder
                parsed.components.forEach(c => {
                    if (c.id === 'root') return;
                    if (c.folderPath && c.folderPath.startsWith(targetFolder)) {
                        const componentType = c.xmlContext.subType;
                        const componentName = c.xmlContext.subName;
                        if (componentType && componentName) {
                            cleanedText = deleteComponentFromXml(cleanedText, parsed.rootName, componentType, componentName);
                        }
                    }
                });
                
                // 2. Delete the Folder tag in the XML matching the folder label
                cleanedText = deleteFolderTagFromXml(cleanedText, targetFolder);
                
                return cleanedText;
            });

            treeProvider.refresh();
        })
    );

    /**
     * Coordinates the QuickPick selection dialogue and inputs when creating a sub-component.
     * @param {vscode.TreeItem & {folderPath?: string}} node The context tree item.
     * @param {string} componentType 'Method', 'Property', or 'Action'.
     */
    async function handleComponentCreation(node, componentType) {
        const fileUri = node.resourceUri;
        const isItf = path.extname(fileUri.fsPath).toLowerCase() === '.tcio';
        
        let document;
        try {
            document = await vscode.workspace.openTextDocument(fileUri);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to open document: ${err.message}`);
            return;
        }
        const xmlText = document.getText();
        
        if (componentType === 'Property') {
            const parsed = parseTwinCatXml(xmlText);
            if (!parsed) return;
            const rootComp = parsed.components.find(c => c.id === 'root');
            if (rootComp && /\bFUNCTION\b(?!\s*BLOCK)/i.test(rootComp.declaration || '')) {
                vscode.window.showWarningMessage(`Properties cannot be created under Functions (FUN) like "${rootComp.name}".`);
                return;
            }
        }
        
        const name = await vscode.window.showInputBox({
            prompt: `Enter ${componentType} Name`,
            placeHolder: componentType === 'Property' ? 'e.g. MyProperty' : (componentType === 'Method' ? 'e.g. M_DoSomething' : 'e.g. A_DoSomething'),
            validateInput: val => {
                if (!val || val.trim().length === 0) return `${componentType} name cannot be empty`;
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) return 'Invalid identifier';
                return null;
            }
        });
        if (!name) return;
        
        const existingFolders = getFoldersDetailedFromXml(xmlText).map(f => f.path);
        
        /** @type {Array<{label:string,description?:string,folderPath?:string,isCreateNew?:boolean}>} */
        const quickPickItems = [
            {
                label: '$(root) [Root / No Folder]',
                description: 'Place at root level',
                folderPath: ''
            },
            {
                label: '$(folder-active) [Create New Folder...]',
                description: 'Create a new virtual folder',
                isCreateNew: true
            }
        ];
        existingFolders.forEach(folder => {
            quickPickItems.push({
                label: `$(folder) ${folder}`,
                folderPath: folder
            });
        });
        
        const quickPick = vscode.window.createQuickPick();
        quickPick.items = quickPickItems;
        quickPick.title = `Select folder for ${componentType} "${name}"`;
        
        const isFolderNode = node && node.contextValue && node.contextValue.startsWith('pouVirtualFolder');
        if (isFolderNode && node.folderPath) {
            const matchedItem = quickPickItems.find(item => item.folderPath === node.folderPath);
            if (matchedItem) {
                quickPick.activeItems = [matchedItem];
            }
        }
        
        const selectedItem = await new Promise((resolve) => {
            quickPick.onDidAccept(() => {
                resolve(quickPick.selectedItems[0]);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                resolve(null);
                quickPick.dispose();
            });
            quickPick.show();
        });
        
        if (!selectedItem) return;
        
        let targetFolderPath = '';
        let parentPath = '';
        let newFolderName = '';
        let isNewFolder = false;
        
        if (selectedItem.isCreateNew) {
            newFolderName = await vscode.window.showInputBox({
                prompt: 'Enter New Folder Name',
                placeHolder: 'e.g. Internal',
                validateInput: val => {
                    if (!val || val.trim().length === 0) return 'Folder name cannot be empty';
                    if (val.includes('\\') || val.includes('/')) return 'Folder name cannot contain slashes';
                    return null;
                }
            });
            if (!newFolderName) return;
            
            /** @type {Array<{label:string,description?:string,folderPath?:string}>} */
            const parentQuickPickItems = [
                {
                    label: '$(root) [Root / No Folder]',
                    description: 'Place new folder at root level',
                    folderPath: ''
                }
            ];
            existingFolders.forEach(folder => {
                parentQuickPickItems.push({
                    label: `$(folder) ${folder}`,
                    folderPath: folder
                });
            });
            
            const parentQuickPick = vscode.window.createQuickPick();
            parentQuickPick.items = parentQuickPickItems;
            parentQuickPick.title = `Select parent folder for new folder "${newFolderName}"`;
            
            if (isFolderNode && node.folderPath) {
                const matchedItem = parentQuickPickItems.find(item => item.folderPath === node.folderPath);
                if (matchedItem) {
                    parentQuickPick.activeItems = [matchedItem];
                }
            }
            
            const selectedParent = await new Promise((resolve) => {
                parentQuickPick.onDidAccept(() => {
                    resolve(parentQuickPick.selectedItems[0]);
                    parentQuickPick.hide();
                });
                parentQuickPick.onDidHide(() => {
                    resolve(null);
                    parentQuickPick.dispose();
                });
                parentQuickPick.show();
            });
            
            if (!selectedParent) return;
            
            parentPath = selectedParent.folderPath;
            targetFolderPath = parentPath ? `${parentPath}${newFolderName}\\` : `${newFolderName}\\`;
            isNewFolder = true;
        } else {
            targetFolderPath = selectedItem.folderPath;
        }
        
        await applyXmlEdit(fileUri, (currentXml) => {
            let updatedXml = currentXml;
            if (isNewFolder) {
                const folderUuid = `{${require('crypto').randomUUID()}}`;
                updatedXml = insertFolderIntoXml(updatedXml, parentPath, newFolderName, folderUuid);
            }
            return insertComponentIntoXml(updatedXml, fileUri, isItf, name, componentType, targetFolderPath);
        });
    }

    /**
     * Coordinates the file creation dialogue and generates boilerplate XML template.
     * @param {vscode.TreeItem} node The context directory tree item.
     * @param {string} fileType 'FB', 'PRG', 'FUN', 'ITF', or 'GVL'.
     */
    async function handleFileCreation(node, fileType) {
        const dirUri = node.resourceUri;
        const name = await vscode.window.showInputBox({
            prompt: `Enter ${fileType} Name`,
            placeHolder: `e.g. My${fileType}`,
            validateInput: val => {
                if (!val || val.trim().length === 0) return `${fileType} name cannot be empty`;
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) return 'Invalid identifier';
                return null;
            }
        });
        if (!name) return;

        const isItf = fileType === 'ITF';
        const isGvl = fileType === 'GVL';
        const ext = isItf ? '.TcIO' : (isGvl ? '.TcGVL' : '.TcPOU');
        const fileName = name + ext;
        const fileUri = vscode.Uri.joinPath(dirUri, fileName);

        try {
            await vscode.workspace.fs.stat(fileUri);
            vscode.window.showErrorMessage(`File "${fileName}" already exists.`);
            return;
        } catch (err) {
            // File does not exist, safe to create
        }

        const uuid = `{${require('crypto').randomUUID()}}`;
        let xmlContent = '';
        if (fileType === 'FB') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[FUNCTION_BLOCK ${name}
VAR_INPUT
END_VAR
VAR_OUTPUT
END_VAR
VAR
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>\n`;
        } else if (fileType === 'PRG') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[PROGRAM ${name}
VAR
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>\n`;
        } else if (fileType === 'FUN') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[FUNCTION ${name} : BOOL
VAR_INPUT
END_VAR
VAR
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>\n`;
        } else if (fileType === 'ITF') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <Itf Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[INTERFACE ${name}]]></Declaration>
  </Itf>
</TcPlcObject>\n`;
        } else if (fileType === 'GVL') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <GVL Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[{attribute 'qualified_only'}
VAR_GLOBAL
END_VAR
]]></Declaration>
  </GVL>
</TcPlcObject>\n`;
        }

        try {
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(xmlContent, 'utf8'));
            await registerInPlcProj(fileUri, false);
            treeProvider.refresh();
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to create file: ${err.message}`);
        }
    }
}

/**
 * Applies an XML edit to a file Uri by opening it, modifying it, and saving it to disk.
 * @param {vscode.Uri} fileUri File URI.
 * @param {Function} xmlModifier A function mapping old XML string to new XML string.
 * @returns {Promise<void>}
 */
async function applyXmlEdit(fileUri, xmlModifier) {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const originalText = document.getText();
    const newText = xmlModifier(originalText);
    
    if (newText !== originalText) {
        const edit = new vscode.WorkspaceEdit();
        const lastLine = document.lineAt(document.lineCount - 1);
        const range = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
        edit.replace(fileUri, range, newText);
        
        await vscode.workspace.applyEdit(edit);
        await document.save();
    }
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
