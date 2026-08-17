/**
 * @file objectInsertCommands.js
 * @description Registers the "TwinCAT Objects" explorer insert commands: write a project object's
 * own name at the caret, or a ready-to-fill call template for it.
 *
 * The Libraries view has had both since 0.1.x, but only for *library* symbols — right-clicking your
 * own FB offered nothing. These are the same two actions over the project's own objects, so they
 * share the formatter (src/insertTemplates.js) with the library commands and differ only in where
 * the parameters come from: the object's own XML, read through the LSP's dependency-free
 * src/lsp/xmlIndexer.js rather than over a round-trip to the server.
 *
 * Kept apart from objectCommands.js on purpose — that module owns the structural XML edits (create /
 * delete, every one of them going through applyXmlEdit); nothing here writes to a file.
 */

const vscode = require('vscode');
const { buildNodeFromXml } = require('../lsp/xmlIndexer');
const { objectInsertText, objectDefinitionText } = require('../insertTemplates');

/**
 * Tree contextValues that stand for a member *inside* a file rather than the file's own object. For
 * these the tree item's label IS the symbol; for a file row the label is the file name
 * (`FB_Gripper.TcPOU`), so the object's name has to come from the parsed XML instead.
 */
const MEMBER_CONTEXTS = new Set(['component', 'propertyNode']);

/**
 * Registers the TwinCAT Objects explorer insert commands.
 * @param {vscode.ExtensionContext} context The extension context.
 * @param {object} deps Injected collaborators owned by extension.js.
 * @param {any} deps.provider The custom editor provider (for insert-at-caret routing).
 */
function registerObjectInsertCommands(context, { provider }) {
    /**
     * Reads a tree node's backing object and returns everything the templates need.
     * @param {any} node The tree item the context menu was opened on.
     * @returns {Promise<{symbolNode: Object|null, memberName: string|null}|null>} Null when the node
     *   carries no file, or its XML cannot be parsed (in which case there is nothing to insert).
     */
    async function resolveNode(node) {
        if (!node || !node.resourceUri) return null;
        let document;
        try {
            // openTextDocument rather than a disk read: a TwinCAT file open in the custom editor is
            // still backed by a TextDocument, so this sees the same content the editor does.
            document = await vscode.workspace.openTextDocument(node.resourceUri);
        } catch (e) {
            return null;
        }
        const symbolNode = buildNodeFromXml(document.getText(), node.resourceUri.toString());
        if (!symbolNode) return null;
        // TreeItem.label is `string | TreeItemLabel` in the API; this tree always builds the string
        // form, but reading it blind would insert "[object Object]" if that ever changed.
        const label = typeof node.label === 'string' ? node.label : (node.label && node.label.label);
        const memberName = MEMBER_CONTEXTS.has(node.contextValue) && label ? label : null;
        return { symbolNode, memberName };
    }

    /**
     * Writes text at the caret. A TwinCAT file is a *webview*, not a text editor, so
     * `vscode.window.activeTextEditor` is undefined for it and the insert has to be posted to the
     * panel; only a loose .st file goes through the normal editor API. Same order as the Libraries
     * view's insert commands — getting it the other way round makes the command silently do nothing
     * in the editor the user is actually looking at.
     * @param {string} text The text to insert.
     * @returns {Promise<void>}
     */
    async function insertAtCaret(text) {
        if (!text) return;
        if (provider.insertTextIntoActivePanel(text, false)) return;

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await editor.edit(b => b.insert(editor.selection.active, text));
            return;
        }
        vscode.window.showWarningMessage('Open a TwinCAT file and place the cursor where you want to insert.');
    }

    /**
     * Both commands need the tree node the context menu was opened on. Invoked from the Command
     * Palette there is none, and returning silently is the worst answer available: a user hunting for
     * this feature runs it, nothing happens, and the reasonable conclusion is that it is broken. Say
     * where it lives instead. (Hiding them from the palette would answer the no-op but not the
     * hunt — the search that led here is exactly the one that should get a pointer.)
     */
    const sayWhereItLives = () => vscode.window.showInformationMessage(
        'Right-click an object in the TwinCAT Objects view (or a symbol in TwinCAT Libraries) to insert it at the cursor.'
    );

    context.subscriptions.push(
        // The object's (or member's) bare name — the counterpart of the Libraries view's Insert at
        // Cursor, for the project's own objects.
        vscode.commands.registerCommand('twincat.insertObjectAtCursor', async (node) => {
            if (!node) { sayWhereItLives(); return; }
            const resolved = await resolveNode(node);
            if (!resolved) return;
            await insertAtCaret(objectInsertText(resolved.symbolNode, resolved.memberName));
        }),
        // A call/usage snippet with the object's real parameters laid out — the bare name is no use
        // for an FB with a dozen inputs you would then have to look up one at a time.
        vscode.commands.registerCommand('twincat.insertObjectDefinitionAtCursor', async (node) => {
            if (!node) { sayWhereItLives(); return; }
            const resolved = await resolveNode(node);
            if (!resolved) return;
            await insertAtCaret(objectDefinitionText(resolved.symbolNode, resolved.memberName));
        })
    );
}

module.exports = { registerObjectInsertCommands, MEMBER_CONTEXTS };
