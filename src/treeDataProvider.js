/**
 * @file treeDataProvider.js
 * @description VS Code Tree Data Provider for displaying TwinCAT file and POU/Interface structures.
 */

const vscode = require('vscode');
const path = require('path');
const { parseTwinCatXml, getFoldersDetailedFromXml } = require('./xmlParser');
const { classifyPou, classifyDut, componentKind, ICONS, LABELS, COLORS } = require('./objectKinds');
const { groupRootsByProject } = require('./lsp/projectMap');
const { accessorIdsFor } = require('./componentId');
const { BASE_SKIP_DIRS } = require('./twincatWorkspace');

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
        /** @type {string|undefined} Component id, assigned externally after construction. */
        this.componentId = undefined;
        /** @type {string|undefined} Virtual-folder path, assigned externally after construction. */
        this.folderPath = undefined;
        /** @type {TwinCatTreeItem|undefined} Logical tree parent used by TreeView.reveal. */
        this.parent = undefined;
        /** @type {string|undefined} PLC-project identity for a project grouping node. */
        this.projectKey = undefined;
        /** @type {string|undefined} Solution identity for a solution grouping node. */
        this.solutionKey = undefined;
    }

    // @ts-expect-error — `id` is deliberately a lazy getter (not a constructor-set property):
    // it derives from componentId/folderPath, which are assigned after construction, so it cannot
    // be a plain field like the base TreeItem.id it overrides.
    get id() {
        if (!this.resourceUri) return undefined;
        const cv = this.contextValue;
        if (cv === 'solution') return this.resourceUri.toString() + '#solution';
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
    /**
     * @param {(() => Object|null)} [getProjectMap] Supplies the extension host's current project
     *   partition (see src/lsp/projectMap.js), re-read on every root expansion because a `.plcproj`
     *   change rebuilds it. Reused rather than rebuilt here: `createProjectMap` walks the filesystem
     *   and parses every `.plcproj`, and `getParent` is called repeatedly during `TreeView.reveal()`
     *   — running that walk per call would be a real cost on a large project. Same shape as
     *   `createProjectStatusBar(context, getProjectMap)` in src/projectStatusBar.js, so both
     *   consumers share one map and one refresh point. Defaults to `() => null` (no grouping) so the
     *   provider stays constructible without an extension-host wiring, e.g. from a future test.
     * @param {(() => Object|null)} [getSolutionMap] Supplies the cached solution-to-project
     *   presentation model built by src/solutionMap.js.
     */
    constructor(getProjectMap, getSolutionMap) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.getProjectMap = getProjectMap || (() => null);
        this.getSolutionMap = getSolutionMap || (() => null);
    }

    /**
     * Triggers a UI refresh of the tree view.
     */
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
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

        // Components do not live beside their backing file in the filesystem tree. They live under
        // the file, optionally through virtual folders and, for Get/Set, a property node. Keep that
        // logical ancestry on the items built by parseFileComponents so reveal() can expand the
        // exact path instead of stopping at and selecting the file's disk directory.
        if (element.parent) return element.parent;
        if (element.contextValue === 'solution') return null;

        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return null;

        const elementUri = element.resourceUri;
        const projectMap = this.getProjectMap();
        const solutionMap = this.getSolutionMap();
        const projectGroups = groupRootsByProject(projectMap, folders.map(f => f.uri.fsPath));
        const hasProjectHierarchy = !!(solutionMap && solutionMap.solutions.length > 0) || projectGroups.length > 0;

        // A project directory is a logical child of its solution, not of the directory holding the
        // `.sln`. This branch also handles an id-equivalent project node reconstructed while VS Code
        // walks a reveal chain.
        const projectAtElement = projectMap && Array.from(projectMap.projects.values()).find(project =>
            vscode.Uri.file(project.dir).toString() === elementUri.toString());
        if (projectAtElement && hasProjectHierarchy) {
            const projectItem = this.createProjectItem(projectAtElement, solutionMap);
            return projectItem.parent || null;
        }
        // Several PLC projects: each project directory is ITSELF a top-level tree node (see
        // getChildren below), exactly like a workspace folder is — so an element that IS a project
        // directory must report no parent too, whatever depth it sits at under the workspace root
        // (a real TwinCAT solution nests the .plcproj at least one level under the opened folder;
        // see sample/TcToolkitSample/TcToolkitSample_PLC/*.plcproj). Getting this on the ELEMENT
        // itself (not its parent-on-disk) matters: reveal() only ever needs getParent(groupNode) to
        // stop here — everything one level further down (e.g. a project's "POUs" folder) still
        // synthesizes a generic 'directory' ancestor below, and that synthesized item's `id`
        // (resourceUri.toString(), per the TwinCatTreeItem id getter) already matches the real group
        // node's id, so VS Code's id-based reveal() matching resolves it correctly without any
        // further special-casing.
        const isProjectRoot = projectGroups.some(g =>
            vscode.Uri.file(g.dir).toString() === elementUri.toString());
        const isRoot = isProjectRoot || folders.some(f => f.uri.toString() === elementUri.toString());
        if (isRoot) return null;

        const parentUri = vscode.Uri.file(path.dirname(elementUri.fsPath));
        const projectAtParent = projectMap && Array.from(projectMap.projects.values()).find(project =>
            vscode.Uri.file(project.dir).toString() === parentUri.toString());
        if (projectAtParent && hasProjectHierarchy) {
            return this.createProjectItem(projectAtParent, solutionMap);
        }
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

            const solutionMap = this.getSolutionMap();
            if (solutionMap && solutionMap.solutions.length > 0) {
                const solutionItems = solutionMap.solutions.map(solution => this.createSolutionItem(solution));
                const orphanItems = solutionMap.orphanProjects.map(project => this.createProjectItem(project, solutionMap));
                return solutionItems.concat(orphanItems);
            }

            // Several PLC projects under one folder: give each its own top-level node. Symbols,
            // references and rename are scoped per project, so a flat tree would show two identical
            // MAIN entries with no way to tell them apart. Fewer than two projects (the common case)
            // and groupRootsByProject returns [], so the tree keeps its existing flat shape below.
            const groups = groupRootsByProject(
                this.getProjectMap(),
                folders.map(f => f.uri.fsPath)
            );
            if (groups.length > 0) {
                return groups.map(g => this.createProjectItem(g, null));
            }

            let allItems = [];
            for (const folder of folders) {
                const items = await this.readDir(folder.uri);
                allItems = allItems.concat(items);
            }
            return allItems;
        }

        if (element.contextValue === 'solution') return element.children || [];

        if (element.contextValue === 'directory') {
            return this.readDir(element.resourceUri);
        }

        if (element.contextValue === 'pouFile' || element.contextValue === 'pouFileProgram' || element.contextValue === 'itfFile') {
            return this.parseFileComponents(element.resourceUri, element.contextValue, element);
        }

        if (element.contextValue && (element.contextValue.startsWith('pouVirtualFolder') || element.contextValue === 'propertyNode')) {
            return element.children;
        }

        return [];
    }

    /** Builds a solution node and its attached PLC-project children. */
    createSolutionItem(solution) {
        const item = new TwinCatTreeItem(
            solution.displayName,
            vscode.Uri.file(solution.slnPath),
            solution.projects.length > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.None,
            'solution',
            null,
            new vscode.ThemeIcon('project')
        );
        item.solutionKey = solution.key;
        item.tooltip = `TwinCAT solution — ${solution.displayName}`;
        item.children = solution.projects.map(project => this.createProjectItem(project, null, item));
        return item;
    }

    /** Builds a PLC-project node, optionally attaching its solution parent for TreeView.reveal. */
    createProjectItem(project, solutionMap, knownParent) {
        let parent = knownParent || null;
        if (!parent && solutionMap) {
            const solution = solutionMap.solutionForProject(project.key);
            if (solution) parent = this.createSolutionItem(solution);
        }
        const item = new TwinCatTreeItem(
            project.displayName || project.name,
            vscode.Uri.file(project.dir),
            vscode.TreeItemCollapsibleState.Expanded,
            'directory',
            null,
            new vscode.ThemeIcon('circuit-board')
        );
        item.projectKey = project.key;
        item.parent = parent || undefined;
        item.tooltip = `PLC project — ${project.displayName || project.name}`;
        return item;
    }

    /**
     * Builds the stable tree element passed to TreeView.reveal for a file or one of its components.
     * Only the target file is parsed; the cached extension-host project map remains the sole source
     * of project grouping, so navigation never launches another workspace scan.
     * @param {vscode.Uri} fileUri Backing TwinCAT file URI.
     * @param {string} componentId Component id, or `root` for the file itself.
     * @returns {Promise<TwinCatTreeItem>} Exact component when found, otherwise the file item.
     */
    async getRevealItem(fileUri, componentId = 'root') {
        const ext = path.extname(fileUri.fsPath).toLowerCase();
        let contextValue = 'pouFile';
        if (ext === '.tcio') contextValue = 'itfFile';
        else if (ext === '.tcgvl') contextValue = 'gvlFile';
        else if (ext === '.tcdut' || ext === '.tctleo') contextValue = 'dutFile';
        else if (ext === '.st') contextValue = 'stFile';

        const expandable = ext === '.tcpou' || ext === '.tcio';
        const fileItem = new TwinCatTreeItem(
            path.basename(fileUri.fsPath),
            fileUri,
            expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            contextValue,
            null,
            null
        );
        if (!componentId || componentId === 'root' || !expandable) return fileItem;

        const children = await this.parseFileComponents(fileUri, contextValue, fileItem);
        const pending = children.slice();
        while (pending.length > 0) {
            const item = pending.shift();
            if (item.componentId === componentId) return item;
            if (item.children) pending.unshift(...item.children);
        }
        return fileItem;
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
                    if (BASE_SKIP_DIRS.has(name.toLowerCase())) continue;
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
     * @param {TwinCatTreeItem} [fileItem] File node used as the logical parent during reveal.
     * @returns {Promise<Array<TwinCatTreeItem>>} List of nested virtual items.
     */
    async parseFileComponents(fileUri, fileType, fileItem) {
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

            const buildVirtualFolderItems = (folderNode, currentPath = '', parentItem = fileItem) => {
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
                    folderItem.parent = parentItem;
                    folderItem.children = buildVirtualFolderItems(node, nextPath, folderItem);
                    folderItems.push(folderItem);
                }
                
                // Add components
                for (const comp of folderNode.components) {
                    const item = this.createComponentTreeItem(comp, fileUri, parsed.components);
                    item.parent = parentItem;
                    folderItems.push(item);
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
            // Accessor ids come from the grammar owner, which builds them by concatenation on purpose —
            // parsing c.id would misread a property named `*_get` as its own accessor (see componentId.js).
            const accessorIds = accessorIdsFor(c.id);
            const getAcc = parsedComponents.find(x => x.id === accessorIds.get);
            const setAcc = parsedComponents.find(x => x.id === accessorIds.set);
            
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
        // Sibling paste ("paste onto a component" = same file, same virtual folder) needs the
        // component's folder. Safe to add: the id getter's component branch keys on componentId,
        // so carrying folderPath causes no tree-item id churn.
        item.folderPath = c.folderPath || '';
        item.tooltip = `${tooltip} — ${c.name}`;
        if (children) {
            item.children = children;
            for (const child of children) child.parent = item;
        }
        return item;
    }
}

module.exports = {
    TwinCatTreeItem,
    TwinCatTreeDataProvider
};
