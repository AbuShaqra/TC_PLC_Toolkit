/**
 * @file lspBridgeCommands.js
 * @description Registers the commands that bridge the webview's Monaco language features to the LSP
 * server, plus the tree-view navigation command that opens a component and selects a target. These are
 * pure routing: the webview posts a query, the extension forwards it to the LSP client and returns the
 * result. The client is passed as a getter because it is created after these commands register and is
 * owned by extension.js.
 */

const vscode = require('vscode');
const path = require('path');

/**
 * Registers the LSP-bridge and component-navigation commands.
 * @param {vscode.ExtensionContext} context The extension context.
 * @param {object} deps Injected collaborators owned by extension.js.
 * @param {any} deps.provider The custom editor provider (TwinCatCustomEditorProvider).
 * @param {() => any} deps.getClient Returns the live LSP client, or undefined before start.
 */
function registerLspBridgeCommands(context, { provider, getClient }) {
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
            const client = getClient();
            if (!client) return [];
            return client.sendRequest('custom/completions', params);
        }),
        vscode.commands.registerCommand('twincat.lsp.queryDefinition', async (params) => {
            const client = getClient();
            if (!client) return null;
            return client.sendRequest('custom/definition', params);
        }),
        vscode.commands.registerCommand('twincat.lsp.queryReferences', async (params) => {
            const client = getClient();
            if (!client) return [];
            return client.sendRequest('custom/references', params);
        }),
        vscode.commands.registerCommand('twincat.lsp.queryDiagnostics', async (params) => {
            const client = getClient();
            if (!client) return [];
            return client.sendRequest('custom/diagnostics', params);
        }),
        vscode.commands.registerCommand('twincat.lsp.updateDocument', async (params) => {
            const client = getClient();
            if (!client) return { success: false };
            return client.sendRequest('custom/updateDocument', params);
        })
    );
}

module.exports = { registerLspBridgeCommands };
