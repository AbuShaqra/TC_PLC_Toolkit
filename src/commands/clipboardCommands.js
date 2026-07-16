/**
 * @file clipboardCommands.js
 * @description Registers the "TwinCAT Objects" explorer copy/paste commands. Copy = duplicate —
 * drag & drop is the move — so a component pastes CROSS-FILE (into another POU/interface) and a
 * file pastes into any directory, its own included. WHAT a paste does is decided by the pure
 * matrix in dndRules.js (describeCopied/planPaste, unit-tested in test/test_dnd_rules.js); this
 * module owns the side effects: the fresh-Id XML splice, the rename prompts, the file write and
 * the .plcproj registration. The clipboard is a single internal descriptor (module state, not the
 * OS clipboard): tree items are not text, and an internal clipboard can never paste stale garbage
 * copied from another application.
 */

const vscode = require('vscode');
const path = require('path');
const { describeCopied, planPaste } = require('../dndRules');
const {
    parseTwinCatXml,
    extractComponentBlockFromXml,
    insertComponentBlockIntoXml,
    renameRootObjectInXml,
    regenerateObjectIdsInXml
} = require('../xmlParser');
const { registerInPlcProj } = require('../plcProjHelper');

/** contextValues classified as file paste targets; planPaste applies the member-target gates. */
const FILE_CONTEXT_VALUES = new Set([
    'pouFile', 'pouFileProgram', 'pouFileFunction', 'itfFile', 'gvlFile', 'dutFile', 'stFile'
]);

/**
 * The single-item clipboard. Module state on purpose: it must survive across command invocations
 * but must NOT survive an extension-host reload (a stale descriptor could point at a file from a
 * previous workspace).
 * @type {{ descriptor: import('../dndRules').CopiedDescriptor } | null}
 */
let clipboard = null;

/**
 * First name of the form `<base>_Copy`, `<base>_Copy2`, … that `isTaken` rejects — the prefill
 * for both rename prompts, mirroring how desktop file managers name duplicates.
 * @param {string} base The original name.
 * @param {(candidate: string) => boolean} isTaken Whether a candidate name is already in use.
 * @returns {string} The first free candidate.
 */
function firstFreeName(base, isTaken) {
    let candidate = `${base}_Copy`;
    for (let i = 2; isTaken(candidate); i++) {
        candidate = `${base}_Copy${i}`;
    }
    return candidate;
}

/**
 * Registers the TwinCAT Objects explorer copy/paste commands.
 * @param {vscode.ExtensionContext} context The extension context.
 * @param {object} deps Injected collaborators owned by extension.js.
 * @param {vscode.TreeView<any>} deps.treeView The Objects tree view (keybinding invocations carry
 * no item argument, so the current selection stands in).
 * @param {any} deps.treeProvider The Objects tree data provider (refreshed after edits).
 * @param {(fileUri: vscode.Uri, xmlModifier: (xml: string) => string) => Promise<void>} deps.applyXmlEdit
 * The byte-preserving XML editor from objectCommands.js.
 */
function registerClipboardCommands(context, { treeView, treeProvider, applyXmlEdit }) {
    // Context keys are per-window state that outlives an extension-host reload; the module
    // clipboard does not. Reset on activation so a stale key cannot enable Paste over nothing.
    vscode.commands.executeCommand('setContext', 'twincat.canPaste', false);

    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.copyObject', (item) => {
            const node = item || (treeView.selection && treeView.selection[0]);
            if (!node) return;
            const descriptor = describeCopied(node);
            if (!descriptor) {
                // Not copyable — say why instead of silently ignoring Ctrl+C. Accessors get the
                // specific hint (their exclusion is invisible from the tree); the rest (virtual
                // folders, directories) the generic one.
                const isAccessor = /^prop_.+_(get|set)$/.test(node.componentId || '');
                vscode.window.setStatusBarMessage(
                    isAccessor
                        ? 'Get/Set accessors are copied with their property'
                        : 'This item cannot be copied',
                    3000);
                return;
            }
            clipboard = { descriptor };
            vscode.commands.executeCommand('setContext', 'twincat.canPaste', true);
            const label = descriptor.kind === 'component'
                ? descriptor.componentName
                : path.basename(descriptor.fsPath);
            vscode.window.setStatusBarMessage(`Copied ${label}`, 3000);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.pasteObject', async (item) => {
            if (!clipboard) return;
            // Context-menu invocations pass the item; keybindings pass nothing, so the selection
            // stands in — and no selection at all means the empty area (workspace-root semantics).
            const node = item || (treeView.selection && treeView.selection[0]);
            const plan = planPaste(clipboard.descriptor, classifyPasteTarget(node, clipboard.descriptor));
            if (!plan) return; // outside the compatibility matrix: silent no-op, same as DnD

            try {
                if (plan.action === 'pasteComponent') {
                    await executeComponentPaste(plan);
                } else {
                    await executeFilePaste(plan);
                }
            } catch (err) {
                // A failed paste must not be silent: the user just performed an explicit gesture.
                console.error('TwinCAT: paste failed:', err);
                vscode.window.showErrorMessage(`Failed to paste: ${err.message}`);
            }
        })
    );

    /**
     * Maps the tree item under the paste to the planPaste target shape.
     * @param {(vscode.TreeItem & { componentId?: string, folderPath?: string })|undefined} node
     * The target item, or undefined for the view's empty area.
     * @param {import('../dndRules').CopiedDescriptor} descriptor Used to resolve which workspace
     * folder an empty-area paste means: the one containing the copied item.
     * @returns {import('../dndRules').PasteTarget|null}
     */
    function classifyPasteTarget(node, descriptor) {
        if (!node) {
            const folder = vscode.workspace.getWorkspaceFolder(/** @type {vscode.Uri} */(descriptor.uri));
            return folder ? { kind: 'workspaceRoot', fsPath: folder.uri.fsPath } : null;
        }
        const cv = node.contextValue || '';
        if (cv === 'directory') {
            return { kind: 'directory', fsPath: node.resourceUri.fsPath };
        }
        if (cv.startsWith('pouVirtualFolder')) {
            return { kind: 'virtualFolder', uri: node.resourceUri, folderPath: node.folderPath || '' };
        }
        if (FILE_CONTEXT_VALUES.has(cv)) {
            return { kind: 'file', uri: node.resourceUri, contextValue: cv };
        }
        if (cv === 'component' || cv === 'propertyNode') {
            // Pasting onto a component means "as its sibling": same file, same virtual folder
            // (an accessor item carries its property's folderPath, so it lands beside the
            // property — the only sensible reading).
            return { kind: 'componentSibling', uri: node.resourceUri, folderPath: node.folderPath || '' };
        }
        return null;
    }

    /**
     * Duplicates a component into the target file: fresh block from the SOURCE (the copy may be
     * stale), collision-checked against the target, renamed if needed, spliced in with fresh Ids.
     * @param {{ action: 'pasteComponent', sourceUri: any, targetUri: any, componentType: string, componentName: string, newFolderPath: string, targetIsItf: boolean }} plan
     */
    async function executeComponentPaste(plan) {
        // Re-read the source at paste time: the component may have been edited — or deleted —
        // since the copy. The clipboard survives a failed paste (undoing the deletion revives it).
        const sourceDoc = await vscode.workspace.openTextDocument(/** @type {vscode.Uri} */(plan.sourceUri));
        const block = extractComponentBlockFromXml(sourceDoc.getText(), plan.componentType, plan.componentName);
        if (!block) {
            vscode.window.showErrorMessage(
                `Cannot paste "${plan.componentName}": it no longer exists in ${path.basename(plan.sourceUri.fsPath)}.`);
            return;
        }

        const targetUri = /** @type {vscode.Uri} */ (plan.targetUri);
        const targetDoc = await vscode.workspace.openTextDocument(targetUri);
        const parsed = parseTwinCatXml(targetDoc.getText());
        if (!parsed) {
            vscode.window.showErrorMessage(
                `Cannot paste into ${path.basename(targetUri.fsPath)}: not a recognized TwinCAT file.`);
            return;
        }

        // Collision domain: every existing component name — via xmlContext.subName, NOT the
        // display name (a property renders as "X (Property Signature)") — plus the root object's
        // own name (a member shadowing its POU is illegal). Case-insensitive: IEC names are.
        const taken = new Set([parsed.rootName.toLowerCase()]);
        for (const c of parsed.components) {
            if (c.xmlContext && c.xmlContext.subName) taken.add(c.xmlContext.subName.toLowerCase());
        }

        let newName = plan.componentName;
        if (taken.has(newName.toLowerCase())) {
            // title + ignoreFocusOut on both paste prompts, as on the create prompts: the widget
            // is easy to miss at the top of the window, and the default focus-out dismissal made a
            // missed prompt look like the paste silently did nothing (user report).
            newName = await vscode.window.showInputBox({
                title: `TwinCAT — Paste ${plan.componentType}`,
                ignoreFocusOut: true,
                prompt: `"${plan.componentName}" already exists in ${path.basename(targetUri.fsPath)} — name for the pasted copy`,
                value: firstFreeName(plan.componentName, (cand) => taken.has(cand.toLowerCase())),
                validateInput: (val) => {
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(val || '')) return 'Invalid identifier';
                    if (taken.has(val.toLowerCase())) return `"${val}" already exists in the target`;
                    return null;
                }
            });
            if (!newName) return; // Esc aborts silently
        }

        await applyXmlEdit(targetUri, (xml) =>
            insertComponentBlockIntoXml(xml, block, {
                oldName: plan.componentName,
                newName,
                newFolderPath: plan.newFolderPath,
                isItf: plan.targetIsItf
            }));
        treeProvider.refresh();
    }

    /**
     * Duplicates a file into the target directory under a new name. Always prompts: even into
     * another directory, a same-name copy would duplicate the object's symbol workspace-wide.
     * @param {{ action: 'pasteFile', sourceFsPath: string, targetDirFsPath: string }} plan
     */
    async function executeFilePaste(plan) {
        const ext = path.extname(plan.sourceFsPath); // original casing kept (.TcPOU, .TcGVL, …)
        const stem = path.basename(plan.sourceFsPath, ext);

        // One directory listing beats a stat probe per candidate name.
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(plan.targetDirFsPath));
        const existing = new Set(entries.map(([name]) => name.toLowerCase()));
        const isTaken = (cand) => existing.has((cand + ext).toLowerCase());

        const newName = await vscode.window.showInputBox({
            title: 'TwinCAT — Paste File',
            ignoreFocusOut: true,
            prompt: `Name for the copy of ${path.basename(plan.sourceFsPath)}`,
            value: firstFreeName(stem, isTaken),
            validateInput: (val) => {
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(val || '')) return 'Invalid identifier';
                if (isTaken(val)) return `"${val}${ext}" already exists there`;
                return null;
            }
        });
        if (!newName) return; // Esc aborts silently

        const newUri = vscode.Uri.file(path.join(plan.targetDirFsPath, newName + ext));
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(plan.sourceFsPath));
        if (ext.toLowerCase() === '.st') {
            // Plain byte copy: .st files carry no XML wrapper to rewrite, and they are not
            // .plcproj members anywhere else in the extension either.
            await vscode.workspace.fs.writeFile(newUri, bytes);
        } else {
            // Rename, then re-identify: the copy must not share a single object Id with its
            // source (root or member) — TwinCAT keys objects on those GUIDs. Two steps on
            // purpose: a future rename-in-place must keep Ids, so renameRootObjectInXml doesn't
            // regenerate them itself.
            const xml = Buffer.from(bytes).toString('utf8');
            const rewritten = regenerateObjectIdsInXml(renameRootObjectInXml(xml, newName));
            await vscode.workspace.fs.writeFile(newUri, Buffer.from(rewritten, 'utf8'));
            // The workspace watcher indexes the new file, but it does NOT touch the .plcproj —
            // registration is this command's job, same as file creation in objectCommands.js.
            await registerInPlcProj(newUri, false);
        }
        treeProvider.refresh();
    }
}

module.exports = { registerClipboardCommands };
