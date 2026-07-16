/**
 * @file referencesProvider.js
 * @description TreeDataProvider for the "TwinCAT References" view. Presents reference results
 * grouped by file and component, navigable via the twincat.openComponent command. Used instead of
 * Monaco's peek widget for cross-file / cross-component usages, which the split-pane webview
 * cannot render as live models.
 *
 * TreeItems carry the stable ids buildTree assigns, and group nodes render Collapsed — expansion
 * is driven by reveal() in extension.js, not by collapsibleState (see groupCollapsibleState).
 */

const vscode = require('vscode');
const { buildTree } = require('./referencesTree');

/**
 * Collapsible state for a file/component group node: Collapsed, never Expanded. An Expanded node
 * rendered while a reveal() raced the onDidChangeTreeData refresh could leave its children
 * unfetched — a twistie that expands to nothing (real user report: a file group with count 1 and
 * a dead arrow, while buildTree's output was verifiably correct). A Collapsed node's twistie click
 * triggers a lazy getChildren, which always works; showReferences in extension.js does the
 * expansion via reveal(..., { expand: 2 }) instead. And a group that somehow has no children must
 * not render an arrow at all — a dead twistie is exactly the bug this replaces.
 * @param {Object} element A file or component node.
 * @returns {number} A vscode.TreeItemCollapsibleState value.
 */
function groupCollapsibleState(element) {
    if (!element.children || element.children.length === 0) return vscode.TreeItemCollapsibleState.None;
    return vscode.TreeItemCollapsibleState.Collapsed;
}

class TwinCatReferencesProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.roots = [];
        this.targetWord = '';
    }

    /**
     * Replaces the displayed references.
     * @param {string} targetWord The symbol being searched.
     * @param {Array<Object>} items Flat reference items.
     */
    setReferences(targetWord, items) {
        this.targetWord = targetWord || '';
        this.roots = buildTree(items || []);
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Clears the view. */
    clear() {
        this.targetWord = '';
        this.roots = [];
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Total occurrence count across all files. */
    get total() {
        return this.roots.reduce((n, f) => n + f.count, 0);
    }

    getChildren(element) {
        if (!element) return this.roots;
        return element.children || [];
    }

    /**
     * Required by TreeView.reveal — without it VS Code rejects every reveal() call, and the view is
     * never brought to the front. That is not theoretical: this method was missing, the rejection was
     * swallowed, and so running "Go to References" while another panel tab (Terminal, Problems, …) was
     * active left the results invisible behind it, looking to the user like nothing had happened.
     *
     * The tree is file -> component -> occurrence and its nodes carry no parent link, so the parent is
     * found by identity. The trees are small (one search result) and reveal is called once per search,
     * so the walk is not worth a back-pointer — which would make the nodes cyclic and unserialisable.
     *
     * @param {Object} element A node handed out by getChildren.
     * @returns {Object|undefined} Its parent, or undefined for a file (root) node.
     */
    getParent(element) {
        if (!element || element.kind === 'file') return undefined;
        for (const file of this.roots) {
            const components = file.children || [];
            if (components.includes(element)) return file;
            for (const component of components) {
                if ((component.children || []).includes(element)) return component;
            }
        }
        return undefined;
    }

    getTreeItem(element) {
        if (element.kind === 'occurrence') {
            const item = new vscode.TreeItem(element.lineText || element.targetWord, vscode.TreeItemCollapsibleState.None);
            item.id = element.id;
            item.iconPath = new vscode.ThemeIcon('symbol-field');
            item.tooltip = element.lineText;
            // Carry the exact occurrence location so navigation lands on the right hit instead of a
            // first-match word search. The shape serves both consumers of twincat.openComponent:
            //   - the .st branch reads start/end as absolute file coordinates (element.line is absolute
            //     there; pane/localLine are null because the .st lineMap is empty);
            //   - the TcPOU branch forwards pane + localLine + start/end columns to the webview.
            let selectionRange;
            if (typeof element.startCharacter === 'number') {
                selectionRange = {
                    pane: element.pane != null ? element.pane : null,
                    localLine: element.localLine != null ? element.localLine : null,
                    start: { line: element.line, character: element.startCharacter },
                    end: { line: element.line, character: element.endCharacter }
                };
            }
            item.command = {
                command: 'twincat.openComponent',
                title: 'Open Reference',
                arguments: [vscode.Uri.parse(element.uri), element.componentId || 'root', selectionRange, element.targetWord]
            };
            return item;
        }
        if (element.kind === 'component') {
            const item = new vscode.TreeItem(element.label, groupCollapsibleState(element));
            item.id = element.id;
            item.iconPath = new vscode.ThemeIcon('symbol-method');
            item.description = `${element.count}`;
            return item;
        }
        // file
        const item = new vscode.TreeItem(element.label, groupCollapsibleState(element));
        item.id = element.id;
        item.iconPath = new vscode.ThemeIcon('file-code');
        item.description = `${element.count}`;
        return item;
    }
}

module.exports = { TwinCatReferencesProvider };
