/**
 * @file treeDragAndDrop.js
 * @description Drag & drop controller for the "TwinCAT Objects" explorer. Two motions are
 * supported: dragging a POU member (method/property/action/transition) into a virtual folder of
 * its own file (an XML FolderPath edit), and dragging a file or physical directory into another
 * directory or the empty area (= workspace root; a filesystem move plus .plcproj sync).
 *
 * The controller is deliberately thin: WHAT a drop does is decided by the pure compatibility
 * matrix in dndRules.js (unit-tested in test/test_dnd_rules.js); this class only serializes the
 * drag payload, classifies the drop target, and executes the plan. Incompatible drops are silent
 * no-ops by design — exactly like dropping onto dead space.
 */

const vscode = require('vscode');
const path = require('path');
const { describeDragged, planDrop } = require('./dndRules');
const { setComponentFolderPathInXml } = require('./xmlParser');
const { registerInPlcProj, registerTreeInPlcProj, unregisterFromPlcProj } = require('./plcProjHelper');

// VS Code only routes tree-internal drags whose mime is `application/vnd.code.tree.<viewId>`
// (lower-cased). Listing just this one mime on both sides makes the reorg internal-only:
// external drops (files from the OS, text, other views) never match and are ignored.
const TREE_MIME = 'application/vnd.code.tree.twincatexplorer';

/**
 * @typedef {vscode.TreeItem & { componentId?: string, folderPath?: string }} TwinCatTreeItemLike
 * The Objects tree's items (treeDataProvider.js TwinCatTreeItem), typed structurally: the class
 * only reaches tsc through a CommonJS `module.exports = {…}`, which JSDoc's import() cannot
 * surface as a type — and the controller only reads these members anyway.
 */

/**
 * @implements {vscode.TreeDragAndDropController<TwinCatTreeItemLike>}
 */
class TwinCatDragAndDropController {
    /**
     * @param {Object} deps Injected collaborators owned by extension.js.
     * @param {any} deps.treeProvider The Objects tree data provider (refreshed after edits —
     * the workspace watcher's onDidChange does not refresh the objects tree by itself).
     * @param {(fileUri: vscode.Uri, xmlModifier: (xml: string) => string) => Promise<void>} deps.applyXmlEdit
     * The byte-preserving XML editor from objectCommands.js.
     */
    constructor({ treeProvider, applyXmlEdit }) {
        this.treeProvider = treeProvider;
        this.applyXmlEdit = applyXmlEdit;
        this.dropMimeTypes = [TREE_MIME];
        this.dragMimeTypes = [TREE_MIME];
    }

    /**
     * Serializes the draggable subset of the selection into the transfer. Items outside the
     * matrix (virtual folders, Get/Set accessors, workspace roots) are dropped here; if nothing
     * remains, nothing is set and the drag carries no payload for this tree.
     * @param {readonly TwinCatTreeItemLike[]} sourceItems The dragged tree items.
     * @param {vscode.DataTransfer} dataTransfer The transfer to fill.
     */
    handleDrag(sourceItems, dataTransfer) {
        const dragged = sourceItems.map(describeDragged).filter(Boolean);
        if (dragged.length === 0) return;
        // Uris are serialized as strings: the payload must survive JSON (VS Code stringifies the
        // transfer item for cross-window drags), and handleDrop revives them with Uri.parse.
        const payload = dragged.map(d => Object.assign({}, d, { uri: d.uri.toString() }));
        dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
    }

    /**
     * Executes the drop: classifies the target, asks the matrix for a plan per dragged item, and
     * applies it. A failed item must not be silent (console + error message) but must not stop
     * the remaining items either.
     * @param {TwinCatTreeItemLike|undefined} target The item dropped onto, or undefined for the
     * view's empty area.
     * @param {vscode.DataTransfer} dataTransfer The transfer filled by handleDrag.
     */
    async handleDrop(target, dataTransfer) {
        const transferItem = dataTransfer.get(TREE_MIME);
        if (!transferItem) return;

        let payload;
        try {
            payload = JSON.parse(await transferItem.asString());
        } catch (err) {
            return; // not a payload we produced
        }
        if (!Array.isArray(payload)) return;

        for (const raw of payload) {
            if (!raw || typeof raw.uri !== 'string') continue;
            const dragged = Object.assign({}, raw, { uri: vscode.Uri.parse(raw.uri) });
            const plan = planDrop(dragged, this._classifyTarget(target, dragged.uri));
            if (!plan) continue; // outside the compatibility matrix: silent no-op by design

            const label = plan.action === 'move' ? path.basename(plan.sourceFsPath) : plan.componentName;
            try {
                if (plan.action === 'setFolderPath') {
                    await this.applyXmlEdit(/** @type {vscode.Uri} */ (plan.fileUri), (xml) =>
                        setComponentFolderPathInXml(xml, plan.componentType, plan.componentName, plan.newFolderPath));
                    this.treeProvider.refresh();
                } else {
                    await this._executeMove(plan);
                }
            } catch (err) {
                console.error('TwinCAT: drop failed:', err);
                vscode.window.showErrorMessage(`Failed to move "${label}": ${err.message}`);
            }
        }
    }

    /**
     * Maps the tree item under the cursor to the planDrop target shape.
     * @param {TwinCatTreeItemLike|undefined} target The drop target item, or undefined for the
     * empty area below the tree.
     * @param {vscode.Uri} draggedUri Used to resolve which workspace folder an empty-area drop
     * means: the one containing the dragged item, not whichever folder happens to be first.
     * @returns {import('./dndRules').DropTarget|null}
     */
    _classifyTarget(target, draggedUri) {
        if (!target) {
            const folder = vscode.workspace.getWorkspaceFolder(draggedUri);
            return folder ? { kind: 'workspaceRoot', fsPath: folder.uri.fsPath } : null;
        }
        const cv = target.contextValue || '';
        if (cv === 'directory') {
            return { kind: 'directory', fsPath: target.resourceUri.fsPath };
        }
        if (cv.startsWith('pouVirtualFolder')) {
            return { kind: 'virtualFolder', uri: target.resourceUri, folderPath: target.folderPath || '' };
        }
        if (cv === 'pouFile' || cv === 'pouFileProgram' || cv === 'itfFile') {
            return { kind: 'file', uri: target.resourceUri, contextValue: cv };
        }
        return null;
    }

    /**
     * Moves a file or directory into its planned target directory, then re-syncs the .plcproj.
     * @param {{ action: 'move', sourceFsPath: string, targetDirFsPath: string, isDirectory: boolean }} plan
     */
    async _executeMove(plan) {
        const oldUri = vscode.Uri.file(plan.sourceFsPath);
        const newUri = vscode.Uri.file(path.join(plan.targetDirFsPath, path.basename(plan.sourceFsPath)));

        // Refuse to clobber: stat resolves exactly when something already sits at the destination.
        let destinationTaken = true;
        try {
            await vscode.workspace.fs.stat(newUri);
        } catch (err) {
            destinationTaken = false;
        }
        if (destinationTaken) {
            vscode.window.showErrorMessage(
                `Cannot move "${path.basename(plan.sourceFsPath)}": "${newUri.fsPath}" already exists.`);
            return;
        }

        // Rename through a WorkspaceEdit (not fs.rename) so open editors follow the file.
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(oldUri, newUri);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) throw new Error('the filesystem rename was not applied');

        // .plcproj sync AFTER the rename: unregister only computes relative paths from the old
        // uri (findPlcProjFile tolerates the now-missing directory and walks up), and the tree
        // walk in registerTreeInPlcProj needs the moved contents on disk at their new location.
        await unregisterFromPlcProj(oldUri, plan.isDirectory);
        if (plan.isDirectory) {
            await registerTreeInPlcProj(newUri);
        } else {
            await registerInPlcProj(newUri, false);
        }
        this.treeProvider.refresh();
    }
}

module.exports = {
    TwinCatDragAndDropController
};
