/**
 * @file treeDataProvider.js
 * @description VS Code adapter for the TwinCAT Objects tree. The tree itself (its shape, nodes, ids,
 * contextValues and parent links) is src/objectsTreeModel.js; this file only turns model nodes into
 * TreeItems and does the VS Code I/O the model asks for.
 *
 * The tree's elements ARE model nodes. Context-menu commands, drag-and-drop and the clipboard receive
 * them directly and read `resourceUri`, `contextValue`, `componentId`, `folderPath` and `label`,
 * which every node carries.
 */

const vscode = require('vscode');
const { createObjectsTreeModel } = require('./objectsTreeModel');

/** @typedef {import('./objectsTreeModel').ObjectsTreeNode} ObjectsTreeNode */

const COLLAPSIBLE = {
    none: vscode.TreeItemCollapsibleState.None,
    collapsed: vscode.TreeItemCollapsibleState.Collapsed,
    expanded: vscode.TreeItemCollapsibleState.Expanded
};

/**
 * The VS Code I/O the model needs.
 * @type {import('./objectsTreeModel').ObjectsTreeHost}
 */
const HOST = {
    uriForPath: (fsPath) => vscode.Uri.file(fsPath),
    joinPath: (base, name) => vscode.Uri.joinPath(/** @type {vscode.Uri} */ (base), name),
    readDirectory: (dir) => Promise.resolve(vscode.workspace.fs.readDirectory(/** @type {vscode.Uri} */ (dir))),
    readFileText: async (file) =>
        Buffer.from(await vscode.workspace.fs.readFile(/** @type {vscode.Uri} */ (file))).toString('utf8'),
    readDocumentText: async (file) =>
        (await vscode.workspace.openTextDocument(/** @type {vscode.Uri} */ (file))).getText()
};

/**
 * Data provider for the TwinCAT explorer tree view sidebar.
 * @implements {vscode.TreeDataProvider<ObjectsTreeNode>}
 */
class TwinCatTreeDataProvider {
    /**
     * @param {(() => Object|null)} [getProjectMap] Supplies the extension host's current project
     *   partition (see src/lsp/projectMap.js). Reused rather than rebuilt here: `createProjectMap`
     *   walks the filesystem and parses every `.plcproj`. Same shape as
     *   `createProjectStatusBar(context, getProjectMap)` in src/projectStatusBar.js, so both
     *   consumers share one map and one refresh point. Defaults to `() => null` (no grouping).
     * @param {(() => Object|null)} [getSolutionMap] Supplies the cached solution-to-project
     *   presentation model built by src/solutionMap.js.
     */
    constructor(getProjectMap, getSolutionMap) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.getProjectMap = getProjectMap || (() => null);
        this.getSolutionMap = getSolutionMap || (() => null);
        /** @type {{model: ReturnType<typeof createObjectsTreeModel>, projectMap: Object|null, solutionMap: Object|null, folders: string}|null} */
        this._cache = null;
    }

    /**
     * The model for the current workspace state. Rebuilt when the project map, the solution map or
     * the workspace folders change, and on refresh(); otherwise reused, so a reveal links to the same
     * project and solution rows the tree shows.
     * @returns {ReturnType<typeof createObjectsTreeModel>}
     */
    model() {
        const projectMap = this.getProjectMap();
        const solutionMap = this.getSolutionMap();
        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri);
        const folders = workspaceFolders.map(u => u.toString()).join('\n');
        const c = this._cache;
        if (c && c.projectMap === projectMap && c.solutionMap === solutionMap && c.folders === folders) return c.model;
        const model = createObjectsTreeModel({ host: HOST, workspaceFolders, projectMap, solutionMap });
        this._cache = { model, projectMap, solutionMap, folders };
        return model;
    }

    /**
     * Triggers a UI refresh of the tree view.
     */
    refresh() {
        this._cache = null;
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Builds the TreeItem VS Code renders for a node. Id and contextValue are the model's.
     * @param {ObjectsTreeNode} node
     * @returns {vscode.TreeItem}
     */
    getTreeItem(node) {
        const item = new vscode.TreeItem(node.label, COLLAPSIBLE[node.collapsible]);
        item.id = node.id;
        item.resourceUri = /** @type {vscode.Uri} */ (node.resourceUri);
        item.contextValue = node.contextValue;
        if (node.icon) {
            item.iconPath = node.icon.color
                ? new vscode.ThemeIcon(node.icon.id, new vscode.ThemeColor(node.icon.color))
                : new vscode.ThemeIcon(node.icon.id);
        }
        if (node.tooltip !== undefined) item.tooltip = node.tooltip;
        if (node.opens !== null) {
            item.command = {
                command: 'twincat.openComponent',
                title: 'Open Component',
                arguments: [node.resourceUri, node.opens]
            };
        }
        return item;
    }

    /**
     * The parent of a node, for TreeView.reveal. A field read: every node is created with its parent.
     * @param {ObjectsTreeNode} node
     * @returns {ObjectsTreeNode|null}
     */
    getParent(node) {
        return (node && node.parent) || null;
    }

    /**
     * The children of a node, or the roots for none.
     * @param {ObjectsTreeNode|undefined} node
     * @returns {Promise<Array<ObjectsTreeNode>>}
     */
    getChildren(node) {
        return this.model().childrenOf(node);
    }

    /**
     * Builds the node passed to TreeView.reveal for a file or one of its components, with its
     * ancestor chain attached. Only the target file is parsed; the cached extension-host project map
     * remains the sole source of project grouping, so navigation never launches a workspace scan.
     * @param {vscode.Uri} fileUri Backing TwinCAT file URI.
     * @param {string} componentId Component id, or `root` for the file itself.
     * @returns {Promise<ObjectsTreeNode>} Exact component when found, otherwise the file node.
     */
    getRevealItem(fileUri, componentId = 'root') {
        return this.model().revealTarget(fileUri, componentId);
    }
}

module.exports = {
    TwinCatTreeDataProvider
};
