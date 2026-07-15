/**
 * @file treeDataProvider.js
 * @description VS Code Tree Data Provider for displaying TwinCAT file and POU/Interface structures.
 */

const vscode = require('vscode');
const path = require('path');
const { parseTwinCatXml, getFoldersDetailedFromXml } = require('./xmlParser');
const { classifyPou, classifyDut, componentKind, ICONS, LABELS, COLORS } = require('./objectKinds');

/**
 * Builds the icon + tooltip for a kind from src/objectKinds.js. A kind with an entry in COLORS gets a
 * coloured icon — a bare ThemeIcon always draws in the tree's foreground colour, whatever its glyph.
 * @param {string} kind A key of ICONS.
 * @returns {{icon: vscode.ThemeIcon, tooltip: string}} Icon and its human-readable kind name.
 */
function decorate(kind) {
    const icon = COLORS[kind]
        ? new vscode.ThemeIcon(ICONS[kind], new vscode.ThemeColor(COLORS[kind]))
        : new vscode.ThemeIcon(ICONS[kind]);
    return { icon, tooltip: LABELS[kind] };
}

/**
 * Custom TreeItem representation for TwinCAT elements.
 */
class TwinCatTreeItem extends vscode.TreeItem {
    /**
     * @param {string} label The display label of the item.
     * @param {vscode.Uri} resourceUri The file URI associated with the item.
     * @param {vscode.TreeItemCollapsibleState} collapsibleState Collapsible state (None, Collapsed, Expanded).
     * @param {string} contextValue VS Code context key for context menu bindings.
     * @param {vscode.Command|null} command Command triggered on click.
     * @param {vscode.ThemeIcon|vscode.Uri|null} iconPath Item icon path or VS Code theme icon.
     * @param {Array<TwinCatTreeItem>|null} children Child items if pre-computed.
     */
    constructor(label, resourceUri, collapsibleState, contextValue, command, iconPath, children = null) {
        super(label, collapsibleState);
        this.resourceUri = resourceUri;
        this.contextValue = contextValue;
        this.command = command;
        this.iconPath = iconPath;
        this.children = children;
    }

    get id() {
        if (!this.resourceUri) return undefined;
        const cv = this.contextValue;
        if (cv === 'component' || cv === 'propertyNode' || cv === 'Get' || cv === 'Set' || cv === 'Action' || cv === 'Transition') {
            return this.resourceUri.toString() + '#' + (this.componentId || this.label);
        } else if (cv && cv.startsWith('pouVirtualFolder')) {
            return this.resourceUri.toString() + '#folder#' + (this.folderPath || this.label);
        }
        return this.resourceUri.toString();
    }
}

/**
 * Data provider for the TwinCAT explorer tree view sidebar.
 */
class TwinCatTreeDataProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    /**
     * Triggers a UI refresh of the tree view.
     */
    refresh() {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Returns the TreeItem representation of the element.
     * @param {TwinCatTreeItem} element 
     * @returns {vscode.TreeItem}
     */
    getTreeItem(element) {
        return element;
    }

    /**
     * Returns the parent of the given element, required for TreeView.reveal.
     * @param {TwinCatTreeItem} element
     * @returns {TwinCatTreeItem|null}
     */
    getParent(element) {
        if (!element || !element.resourceUri) return null;

        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return null;

        const elementUri = element.resourceUri;
        const isRoot = folders.some(f => f.uri.toString() === elementUri.toString());
        if (isRoot) return null;

        const parentUri = vscode.Uri.file(path.dirname(elementUri.fsPath));
        const isParentRoot = folders.some(f => f.uri.toString() === parentUri.toString());
        if (isParentRoot) return null;

        const parentName = path.basename(parentUri.fsPath);
        return new TwinCatTreeItem(
            parentName,
            parentUri,
            vscode.TreeItemCollapsibleState.Collapsed,
            'directory',
            null,
            new vscode.ThemeIcon('folder')
        );
    }

    /**
     * Resolves child tree items for a given element.
     * @param {TwinCatTreeItem|undefined} element Parent element, or undefined for workspace root.
     * @returns {Promise<Array<TwinCatTreeItem>>} List of child tree items.
     */
    async getChildren(element) {
        if (!element) {
            // Root elements - Open workspace folder
            const folders = vscode.workspace.workspaceFolders;
            if (!folders) return [];
            
            let allItems = [];
            for (const folder of folders) {
                const items = await this.readDir(folder.uri);
                allItems = allItems.concat(items);
            }
            return allItems;
        }

        if (element.contextValue === 'directory') {
            return this.readDir(element.resourceUri);
        }

        if (element.contextValue === 'pouFile' || element.contextValue === 'pouFileProgram' || element.contextValue === 'itfFile') {
            return this.parseFileComponents(element.resourceUri, element.contextValue);
        }

        if (element.contextValue && (element.contextValue.startsWith('pouVirtualFolder') || element.contextValue === 'propertyNode')) {
            return element.children;
        }

        return [];
    }

    /**
     * Reads a directory on disk and filters it for folders and relevant TwinCAT files.
     * @param {vscode.Uri} dirUri Directory URI.
     * @returns {Promise<Array<TwinCatTreeItem>>} List of tree items.
     */
    async readDir(dirUri) {
        try {
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
            entries.sort((a, b) => {
                if (a[1] !== b[1]) {
                    return b[1] - a[1]; // Directories first
                }
                return a[0].localeCompare(b[0]);
            });

            const items = [];
            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(dirUri, name);
                if (type === vscode.FileType.Directory) {
                    if (name === '.git' || name === 'node_modules' || name === '.vscode') continue;
                    items.push(new TwinCatTreeItem(
                        name,
                        entryUri,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'directory',
                        null,
                        new vscode.ThemeIcon('folder')
                    ));
                } else if (type === vscode.FileType.File) {
                    const ext = path.extname(name).toLowerCase();
                    let contextValue = '';
                    let kind = '';
                    let collapsible = vscode.TreeItemCollapsibleState.None;

                    // `.TcPOU` and `.TcDUT` cover several kinds each — a POU is a function block, a
                    // program or a function; a DUT is a struct, an enum, a union or an alias — and the
                    // kind lives in the declaration, so the file has to be read to pick the icon.
                    if (ext === '.tcpou' || ext === '.tcio' || ext === '.tcdut') {
                        let declaration = '';
                        let hasChildren = false;
                        try {
                            const fileBytes = await vscode.workspace.fs.readFile(entryUri);
                            const content = Buffer.from(fileBytes).toString('utf8');
                            const parsed = parseTwinCatXml(content);
                            if (parsed) {
                                const rootComp = parsed.components.find(c => c.id === 'root');
                                declaration = (rootComp && rootComp.declaration) || '';
                                const folders = getFoldersDetailedFromXml(content);
                                const hasSubComponents = parsed.components.some(c => c.id !== 'root');
                                hasChildren = folders.length > 0 || hasSubComponents;
                            }
                        } catch (e) {
                            // ignore
                        }

                        if (ext === '.tcdut') {
                            contextValue = 'dutFile';
                            kind = classifyDut(declaration);
                        } else if (ext === '.tcio') {
                            contextValue = 'itfFile';
                            kind = 'interface';
                            collapsible = hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
                        } else {
                            kind = classifyPou(declaration);
                            if (kind === 'function') {
                                // A function has no methods, properties or actions to expand into.
                                contextValue = 'pouFileFunction';
                            } else {
                                contextValue = kind === 'program' ? 'pouFileProgram' : 'pouFile';
                                collapsible = hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
                            }
                        }
                    } else if (ext === '.tcgvl') {
                        contextValue = 'gvlFile';
                        kind = 'gvl';
                    } else if (ext === '.st') {
                        contextValue = 'stFile';
                        kind = 'stFile';
                    } else {
                        continue;
                    }

                    const { icon, tooltip } = decorate(kind);
                    const item = new TwinCatTreeItem(
                        name,
                        entryUri,
                        collapsible,
                        contextValue,
                        {
                            command: 'twincat.openComponent',
                            title: 'Open Component',
                            arguments: [entryUri, 'root']
                        },
                        icon
                    );
                    item.tooltip = `${tooltip} — ${name}`;
                    items.push(item);
                }
            }
            return items;
        } catch (err) {
            console.error(err);
            return [];
        }
    }

    /**
     * Parses virtual folders and sub-components inside a POU/Interface file and formats them for the tree view.
     * @param {vscode.Uri} fileUri File URI.
     * @param {string} fileType 'pouFile', 'pouFileProgram', or 'itfFile'.
     * @returns {Promise<Array<TwinCatTreeItem>>} List of nested virtual items.
     */
    async parseFileComponents(fileUri, fileType) {
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const text = document.getText();
            const parsed = parseTwinCatXml(text);
            if (!parsed) return [];

            const rootFolder = {
                subfolders: {},
                components: []
            };

            // Pre-populate the root folder hierarchy with all defined folders from the XML
            const xmlFolders = getFoldersDetailedFromXml(text);
            xmlFolders.forEach(f => {
                const pathParts = f.path.split('\\').map(p => p.trim()).filter(p => p.length > 0);
                let current = rootFolder;
                for (const part of pathParts) {
                    if (!current.subfolders[part]) {
                        current.subfolders[part] = {
                            label: part,
                            subfolders: {},
                            components: []
                        };
                    }
                    current = current.subfolders[part];
                }
            });

            parsed.components.forEach(c => {
                if (c.id === 'root') return;
                if (c.type === 'Get' || c.type === 'Set') return; // Nested inside parent properties
                
                const folderPath = c.folderPath || '';
                const pathParts = folderPath.split('\\').map(p => p.trim()).filter(p => p.length > 0);
                
                let current = rootFolder;
                for (const part of pathParts) {
                    if (!current.subfolders[part]) {
                        current.subfolders[part] = {
                            label: part,
                            subfolders: {},
                            components: []
                        };
                    }
                    current = current.subfolders[part];
                }
                current.components.push(c);
            });

            const buildVirtualFolderItems = (folderNode, currentPath = '') => {
                const folderItems = [];
                
                // Add subfolders
                for (const node of Object.values(folderNode.subfolders)) {
                    const nextPath = currentPath ? `${currentPath}${node.label}\\` : `${node.label}\\`;
                    let folderContext = 'pouVirtualFolder';
                    if (fileType === 'pouFileProgram') {
                        folderContext = 'pouVirtualFolderProgram';
                    } else if (fileType === 'itfFile') {
                        folderContext = 'pouVirtualFolderInterface';
                    }
                    const folderItem = new TwinCatTreeItem(
                        node.label,
                        fileUri,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        folderContext,
                        null,
                        new vscode.ThemeIcon('folder')
                    );
                    folderItem.folderPath = nextPath;
                    folderItem.children = buildVirtualFolderItems(node, nextPath);
                    folderItems.push(folderItem);
                }
                
                // Add components
                for (const comp of folderNode.components) {
                    folderItems.push(this.createComponentTreeItem(comp, fileUri, parsed.components));
                }
                
                // Sort so folders come first, then components
                folderItems.sort((a, b) => {
                    const aIsFolder = a.contextValue && a.contextValue.startsWith('pouVirtualFolder');
                    const bIsFolder = b.contextValue && b.contextValue.startsWith('pouVirtualFolder');
                    if (aIsFolder !== bIsFolder) {
                        return bIsFolder - aIsFolder;
                    }
                    return a.label.localeCompare(b.label);
                });
                
                return folderItems;
            };

            const fileChildren = buildVirtualFolderItems(rootFolder, '');
            return fileChildren;
        } catch (err) {
            console.error(err);
            return [];
        }
    }

    /**
     * Builds a single leaf node or parent property node with children.
     * @param {Object} c Component data.
     * @param {vscode.Uri} fileUri File URI.
     * @param {Array<Object>} parsedComponents All components inside the file.
     * @returns {TwinCatTreeItem} Built tree item.
     */
    createComponentTreeItem(c, fileUri, parsedComponents) {
        const { icon, tooltip } = decorate(componentKind(c.type));
        let collapsible = vscode.TreeItemCollapsibleState.None;
        const contextValue = c.type === 'Property' ? 'propertyNode' : 'component';

        let children = null;
        if (c.type === 'Property' && parsedComponents) {
            const getAcc = parsedComponents.find(x => x.id === `${c.id}_get`);
            const setAcc = parsedComponents.find(x => x.id === `${c.id}_set`);
            
            const accItems = [];
            if (getAcc) {
                accItems.push(this.createComponentTreeItem(getAcc, fileUri, parsedComponents));
            }
            if (setAcc) {
                accItems.push(this.createComponentTreeItem(setAcc, fileUri, parsedComponents));
            }
            if (accItems.length > 0) {
                collapsible = vscode.TreeItemCollapsibleState.Collapsed;
                children = accItems;
            }
        }

        const item = new TwinCatTreeItem(
            c.name,
            fileUri,
            collapsible,
            contextValue,
            {
                command: 'twincat.openComponent',
                title: 'Open Component',
                arguments: [fileUri, c.id]
            },
            icon
        );
        item.componentId = c.id;
        item.tooltip = `${tooltip} — ${c.name}`;
        if (children) {
            item.children = children;
        }
        return item;
    }
}

module.exports = {
    TwinCatTreeItem,
    TwinCatTreeDataProvider
};
