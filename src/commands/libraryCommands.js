/**
 * @file libraryCommands.js
 * @description Registers the "TwinCAT Libraries" view commands: refresh, regenerate the library
 * signatures by driving a TwinCAT XAE shell, copy a namespace / qualified name, and insert a library
 * symbol (name-only or with its full parameter list) at the caret. The signature regeneration is the
 * one place the extension touches TwinCAT — see src/xaeShell.js — and only when the user asks for it.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { findTwinCatShells, runSignatureGenerator } = require('../xaeShell');
const { insertTextForNode, formattedDefinitionForNode } = require('../libraryTreeProvider');

/**
 * Registers the TwinCAT Libraries view commands.
 * @param {vscode.ExtensionContext} context The extension context.
 * @param {object} deps Injected collaborators owned by extension.js.
 * @param {any} deps.libraryProvider The library tree data provider.
 * @param {any} deps.provider The custom editor provider (for insert-at-caret routing).
 * @param {() => any} deps.getClient Returns the live LSP client, or undefined before start.
 */
function registerLibraryCommands(context, { libraryProvider, provider, getClient }) {
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
            const client = getClient();
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
}

module.exports = { registerLibraryCommands };
