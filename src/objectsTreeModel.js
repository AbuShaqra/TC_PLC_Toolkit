/**
 * @file objectsTreeModel.js
 * @description The PLC Objects tree as a plain node graph, with no dependency on `vscode`.
 *
 * Every row of the Objects view is an {@link ObjectsTreeNode}: a solution, a PLC project, a disk
 * directory, a TwinCAT file, a virtual folder inside a POU, or a component (method, property, action,
 * transition, property accessor). Each node carries its parent link, its children once they are
 * loaded, and the two strings VS Code keys on:
 *  - `id`: drives expansion state, selection and `TreeView.reveal()`. It must stay stable for the
 *    same workspace across releases (test/test_objects_tree_ids.js pins it on the sample).
 *  - `contextValue`: drives every `view/item/context` menu and the drag-and-drop/paste/rename rules.
 * Both are assigned in exactly one place, {@link makeNode}.
 *
 * The model also owns the tree's SHAPE rule (solutions → projects, or one root per PLC project when
 * there are two or more, otherwise the flat directory tree). That rule used to live in
 * src/lsp/projectMap.js, the LSP ownership module, which should not decide presentation.
 *
 * I/O goes through an injected {@link ObjectsTreeHost}, and uris are opaque values the host mints
 * (VS Code's `Uri` in the extension, a plain stub in tests). The model only reads `fsPath` and calls
 * `toString()` on them, so src/treeDataProvider.js can stay a thin adapter and the tests need no
 * `vscode` stub.
 */

const path = require('path');
const { parseTwinCatXml, getFoldersDetailedFromXml } = require('./xmlParser');
const { classifyPou, classifyDut, componentKind, propertyContextValue, ICONS, LABELS, COLORS } = require('./objectKinds');
const { accessorIdsFor } = require('./componentId');
const { BASE_SKIP_DIRS, GENERATED_OUTPUT_DIRS } = require('./twincatWorkspace');

/**
 * Directory-entry types, with the numeric values of `vscode.FileType`, so the host can pass VS Code's
 * `readDirectory` result through unchanged. A symbolic link ORs in 64, so a linked directory (66)
 * is neither of these and is skipped, as it always was.
 */
const ENTRY_TYPE = Object.freeze({ File: 1, Directory: 2 });

/**
 * @typedef {{fsPath: string, toString: () => string}} UriLike An opaque uri minted by the host.
 */

/**
 * @typedef {Object} ObjectsTreeHost The I/O the model needs, injected by the adapter.
 * @property {(fsPath: string) => UriLike} uriForPath Uri for an absolute path (`vscode.Uri.file`).
 * @property {(base: UriLike, name: string) => UriLike} joinPath Child uri (`vscode.Uri.joinPath`).
 * @property {(dir: UriLike) => Promise<Array<[string, number]>>} readDirectory Entries as
 *   `[name, type]`, type as in {@link ENTRY_TYPE}.
 * @property {(file: UriLike) => Promise<string>} readFileText The file's bytes on disk, as UTF-8.
 *   Used to pick a file row's icon.
 * @property {(file: UriLike) => Promise<string>} readDocumentText The document's current text,
 *   unsaved edits included. Used to build a file's members.
 */

/**
 * @typedef {Object} ObjectsTreeNode One row of the Objects view.
 * @property {'solution'|'project'|'directory'|'file'|'virtualFolder'|'component'} kind
 * @property {string} label
 * @property {UriLike} resourceUri The backing solution file, directory or TwinCAT file.
 * @property {string} contextValue
 * @property {string} id
 * @property {'none'|'collapsed'|'expanded'} collapsible
 * @property {{id: string, color: string|null}|null} icon A codicon id and an optional theme colour id.
 * @property {string|undefined} tooltip
 * @property {string|null} opens Component id opened on click (`root` for the file), or null.
 * @property {string|undefined} componentId Set on component rows.
 * @property {string|undefined} folderPath Virtual-folder path (`A\B\`) on folder and component rows.
 * @property {string|undefined} projectKey Set on PLC-project rows.
 * @property {string|undefined} solutionKey Set on solution rows.
 * @property {ObjectsTreeNode|null} parent The node VS Code expands through on reveal; null for a root.
 * @property {Array<ObjectsTreeNode>|null} children Loaded children, or null when not loaded yet.
 * @property {string} [fileContext] On file rows: the file's contextValue, which also picks the
 *   contextValue of its virtual folders.
 */

/**
 * The contextValue of a node. Called only by {@link makeNode}.
 * @param {ObjectsTreeNode['kind']} kind
 * @param {Object} facts `fileContext` for a file or virtual folder; `type`, `hasGet`, `hasSet` for a component;
 *   `generated` for a directory inside Generate ST's output (`ST_Files`).
 * @returns {string}
 */
function contextValueOf(kind, facts) {
    switch (kind) {
        case 'solution': return 'solution';
        case 'project': return 'directory';
        // Generate ST's output folder (and everything below it) is not project content: its own
        // contextValue matches no create/delete/rename/paste menu and no drag-and-drop rule.
        case 'directory': return facts.generated ? 'generatedDirectory' : 'directory';
        case 'file': return facts.fileContext;
        case 'virtualFolder':
            if (facts.fileContext === 'pouFileProgram') return 'pouVirtualFolderProgram';
            if (facts.fileContext === 'itfFile') return 'pouVirtualFolderInterface';
            return 'pouVirtualFolder';
        case 'component':
            // Which accessors a property is missing drives "Add Get/Set Accessor" (issue #25).
            return facts.type === 'Property' ? propertyContextValue(facts.hasGet, facts.hasSet) : 'component';
        default: throw new Error(`objectsTreeModel: unknown node kind '${kind}'`);
    }
}

/**
 * The tree id of a node. Kept byte-identical to the ids the provider has always produced: the uri
 * alone for disk rows, `#solution` for a solution, `#<componentId>` for a component and
 * `#folder#<folderPath>` for a virtual folder.
 * @param {ObjectsTreeNode['kind']} kind
 * @param {UriLike} resourceUri
 * @param {{componentId?: string, folderPath?: string, label: string}} names
 * @returns {string}
 */
function nodeId(kind, resourceUri, names) {
    const uri = resourceUri.toString();
    if (kind === 'solution') return uri + '#solution';
    if (kind === 'component') return uri + '#' + (names.componentId || names.label);
    if (kind === 'virtualFolder') return uri + '#folder#' + (names.folderPath || names.label);
    return uri;
}

/**
 * Builds a node. The ONLY place a node's contextValue and id are assigned.
 * @param {Object} spec
 * @param {ObjectsTreeNode['kind']} spec.kind
 * @param {string} spec.label
 * @param {UriLike} spec.resourceUri
 * @param {Object} [spec.facts] Inputs to the contextValue, see {@link contextValueOf}.
 * @param {ObjectsTreeNode['collapsible']} [spec.collapsible]
 * @param {ObjectsTreeNode['icon']} [spec.icon]
 * @param {string} [spec.tooltip]
 * @param {string|null} [spec.opens]
 * @param {string} [spec.componentId]
 * @param {string} [spec.folderPath]
 * @param {string} [spec.projectKey]
 * @param {string} [spec.solutionKey]
 * @param {ObjectsTreeNode|null} [spec.parent]
 * @returns {ObjectsTreeNode}
 */
function makeNode(spec) {
    const facts = spec.facts || {};
    /** @type {ObjectsTreeNode} */
    const node = {
        kind: spec.kind,
        label: spec.label,
        resourceUri: spec.resourceUri,
        contextValue: contextValueOf(spec.kind, facts),
        id: nodeId(spec.kind, spec.resourceUri, spec),
        collapsible: spec.collapsible || 'none',
        icon: spec.icon || null,
        tooltip: spec.tooltip,
        opens: spec.opens === undefined ? null : spec.opens,
        componentId: spec.componentId,
        folderPath: spec.folderPath,
        projectKey: spec.projectKey,
        solutionKey: spec.solutionKey,
        parent: spec.parent || null,
        children: null
    };
    if (spec.kind === 'file' || spec.kind === 'virtualFolder') node.fileContext = facts.fileContext;
    return node;
}

/**
 * The icon for an object kind from src/objectKinds.js. A kind with an entry in COLORS gets a coloured
 * icon: a bare codicon always draws in the tree's foreground colour, whatever its glyph.
 * @param {string} kind A key of ICONS.
 * @returns {{icon: {id: string, color: string|null}, tooltip: string}}
 */
function decorate(kind) {
    return { icon: { id: ICONS[kind], color: COLORS[kind] || null }, tooltip: LABELS[kind] };
}

/**
 * The tree groups for a workspace: one per PLC project, sorted by name. Returns an EMPTY array when
 * there are fewer than two projects — the Objects tree then keeps its flat, directory-driven shape,
 * which is the right thing for the overwhelmingly common single-project workspace.
 * @param {{projects: Map<string, Object>, displayName: (key: string) => string}|null} projectMap The workspace partition.
 * @param {Array<string>} [folderPaths] Absolute workspace-root paths (unused today; kept so a future
 *   multi-root workspace can label a group with its containing folder without a signature change).
 * @returns {Array<{key: string, name: string, dir: string}>} Groups, or [] to stay flat.
 */
function groupRootsByProject(projectMap, folderPaths) {
    if (!projectMap || projectMap.projects.size < 2) return [];
    return Array.from(projectMap.projects.values())
        .map(p => ({ key: p.key, name: projectMap.displayName(p.key), dir: p.dir }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/**
 * The file row's contextValue and object kind (icon), from its extension and, for `.TcPOU` /
 * `.TcDUT`, its declaration. Null for a file the tree does not show.
 * @param {string} name File name.
 * @param {{declaration: string, hasChildren: boolean}} content What the file's XML says.
 * @returns {{fileContext: string, kind: string, collapsible: 'none'|'collapsed'}|null}
 */
function classifyFile(name, content) {
    const ext = path.extname(name).toLowerCase();
    const expandable = content.hasChildren ? 'collapsed' : 'none';
    if (ext === '.tcdut') return { fileContext: 'dutFile', kind: classifyDut(content.declaration), collapsible: 'none' };
    if (ext === '.tcio') return { fileContext: 'itfFile', kind: 'interface', collapsible: expandable };
    if (ext === '.tcpou') {
        const kind = classifyPou(content.declaration);
        // A function has no methods, properties or actions to expand into.
        if (kind === 'function') return { fileContext: 'pouFileFunction', kind, collapsible: 'none' };
        return { fileContext: kind === 'program' ? 'pouFileProgram' : 'pouFile', kind, collapsible: expandable };
    }
    if (ext === '.tcgvl') return { fileContext: 'gvlFile', kind: 'gvl', collapsible: 'none' };
    if (ext === '.st') return { fileContext: 'stFile', kind: 'stFile', collapsible: 'none' };
    return null;
}

/**
 * True when picking a file row's icon needs its content: a `.TcPOU` is a function block, program or
 * function, and a `.TcDUT` a struct, enum, union or alias, and the kind lives in the declaration.
 * @param {string} name File name.
 * @returns {boolean}
 */
function needsContent(name) {
    const ext = path.extname(name).toLowerCase();
    return ext === '.tcpou' || ext === '.tcio' || ext === '.tcdut';
}

/**
 * Reads what a file row needs from the XML: the root declaration and whether there is anything to
 * expand into. Unparseable XML yields an empty declaration and no children.
 * @param {string} text File content.
 * @returns {{declaration: string, hasChildren: boolean}}
 */
function summarizeFile(text) {
    const parsed = parseTwinCatXml(text);
    if (!parsed) return { declaration: '', hasChildren: false };
    const rootComp = parsed.components.find(c => c.id === 'root');
    return {
        declaration: (rootComp && rootComp.declaration) || '',
        hasChildren: getFoldersDetailedFromXml(text).length > 0 || parsed.components.some(c => c.id !== 'root')
    };
}

/**
 * Builds a component row and, for a property, its Get/Set accessor rows.
 * @param {Object} c Parsed component (src/xmlParser.js).
 * @param {UriLike} fileUri Backing file.
 * @param {Array<Object>} parsedComponents Every component of the file.
 * @param {ObjectsTreeNode} parent The virtual folder or file the row sits under.
 * @returns {ObjectsTreeNode}
 */
function componentNode(c, fileUri, parsedComponents, parent) {
    const { icon, tooltip } = decorate(componentKind(c.type));
    let getAcc = null;
    let setAcc = null;
    if (c.type === 'Property') {
        // Accessor ids come from the grammar owner, which builds them by concatenation on purpose —
        // parsing c.id would misread a property named `*_get` as its own accessor (see componentId.js).
        const accessorIds = accessorIdsFor(c.id);
        getAcc = parsedComponents.find(x => x.id === accessorIds.get) || null;
        setAcc = parsedComponents.find(x => x.id === accessorIds.set) || null;
    }
    const accessors = [getAcc, setAcc].filter(Boolean);
    const node = makeNode({
        kind: 'component',
        label: c.name,
        resourceUri: fileUri,
        facts: { type: c.type, hasGet: !!getAcc, hasSet: !!setAcc },
        collapsible: accessors.length > 0 ? 'collapsed' : 'none',
        icon,
        tooltip: `${tooltip} — ${c.name}`,
        opens: c.id,
        componentId: c.id,
        // Sibling paste ("paste onto a component" = same file, same virtual folder) needs the
        // component's folder. The id keys on componentId, so carrying it causes no id churn.
        folderPath: c.folderPath || '',
        parent
    });
    if (accessors.length > 0) {
        node.children = accessors.map(acc => componentNode(acc, fileUri, parsedComponents, node));
    }
    return node;
}

/**
 * The members of a POU or interface file: its virtual folders (nested by `FolderPath`) and its
 * components, folders first, each level sorted by label. Get/Set accessors sit under their property.
 * @param {ObjectsTreeNode} fileNode The file row; becomes the parent of the top-level rows.
 * @param {string} text The file's XML.
 * @returns {Array<ObjectsTreeNode>}
 */
function buildFileMembers(fileNode, text) {
    const parsed = parseTwinCatXml(text);
    if (!parsed) return [];
    const fileUri = fileNode.resourceUri;

    const newFolder = (label) => ({ label, subfolders: {}, components: [] });
    const rootFolder = newFolder('');
    const descend = (folderPath) => {
        let current = rootFolder;
        for (const part of folderPath.split('\\').map(p => p.trim()).filter(p => p.length > 0)) {
            if (!current.subfolders[part]) current.subfolders[part] = newFolder(part);
            current = current.subfolders[part];
        }
        return current;
    };
    // Folders defined in the XML show even when empty.
    for (const f of getFoldersDetailedFromXml(text)) descend(f.path);
    for (const c of parsed.components) {
        if (c.id === 'root') continue;
        if (c.type === 'Get' || c.type === 'Set') continue; // nested inside their property
        descend(c.folderPath || '').components.push(c);
    }

    const build = (folder, currentPath, parent) => {
        const rows = [];
        for (const sub of Object.values(folder.subfolders)) {
            const nextPath = `${currentPath}${sub.label}\\`;
            const folderNode = makeNode({
                kind: 'virtualFolder',
                label: sub.label,
                resourceUri: fileUri,
                facts: { fileContext: fileNode.fileContext },
                collapsible: 'collapsed',
                icon: { id: 'folder', color: null },
                folderPath: nextPath,
                parent
            });
            folderNode.children = build(sub, nextPath, folderNode);
            rows.push(folderNode);
        }
        for (const c of folder.components) rows.push(componentNode(c, fileUri, parsed.components, parent));
        rows.sort((a, b) => {
            const aIsFolder = a.kind === 'virtualFolder';
            const bIsFolder = b.kind === 'virtualFolder';
            if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
            return a.label.localeCompare(b.label);
        });
        return rows;
    };
    return build(rootFolder, '', fileNode);
}

/**
 * Builds the Objects tree for one workspace state. Rebuild it when the project or solution map, or
 * the workspace folders, change; the adapter does that.
 * @param {Object} options
 * @param {ObjectsTreeHost} options.host
 * @param {Array<UriLike>} options.workspaceFolders Workspace-root uris.
 * @param {{projects: Map<string, Object>, displayName: (key: string) => string}|null} [options.projectMap]
 *   The extension host's project partition (src/lsp/projectMap.js).
 * @param {{solutions: Array<Object>, orphanProjects: Array<Object>}|null} [options.solutionMap]
 *   The solution presentation model (src/solutionMap.js).
 * @returns {{
 *   isFlat: boolean,
 *   roots: Array<ObjectsTreeNode>|null,
 *   childrenOf: (node?: ObjectsTreeNode|null) => Promise<Array<ObjectsTreeNode>>,
 *   revealTarget: (fileUri: UriLike, componentId?: string) => Promise<ObjectsTreeNode>,
 *   projectNodeForDir: (dirUri: UriLike) => ObjectsTreeNode|null
 * }}
 */
function createObjectsTreeModel({ host, workspaceFolders, projectMap = null, solutionMap = null }) {
    const folders = workspaceFolders || [];
    const rootKeys = new Set(folders.map(u => u.toString()));
    /** Project directory uri string → its project row, for reveal ancestry. Empty in the flat tree. */
    const projectByDir = new Map();
    /** Every PLC project directory, lower-cased: their `ST_Files` folders are Generate ST's output. */
    const projectDirs = new Set();
    if (projectMap && projectMap.projects) {
        for (const p of projectMap.projects.values()) if (p && p.dir) projectDirs.add(path.resolve(p.dir).toLowerCase());
    }

    const projectNode = (project, label, parent) => {
        const node = makeNode({
            kind: 'project',
            label,
            resourceUri: host.uriForPath(project.dir),
            collapsible: 'expanded',
            icon: { id: 'circuit-board', color: null },
            tooltip: `PLC project — ${label}`,
            projectKey: project.key,
            parent
        });
        projectByDir.set(node.resourceUri.toString(), node);
        return node;
    };

    /** @type {Array<ObjectsTreeNode>|null} */
    let roots = null;
    if (solutionMap && solutionMap.solutions.length > 0) {
        roots = solutionMap.solutions.map(solution => {
            const node = makeNode({
                kind: 'solution',
                label: solution.displayName,
                resourceUri: host.uriForPath(solution.slnPath),
                collapsible: solution.projects.length > 0 ? 'expanded' : 'none',
                icon: { id: 'project', color: null },
                tooltip: `TwinCAT solution — ${solution.displayName}`,
                solutionKey: solution.key
            });
            node.children = solution.projects.map(p => projectNode(p, p.displayName || p.name, node));
            return node;
        }).concat(solutionMap.orphanProjects.map(p => projectNode(p, p.displayName || p.name, null)));
    } else {
        // Several PLC projects under one folder: each gets its own top-level row. Symbols, references
        // and rename are scoped per project, so a flat tree would show two identical MAIN entries with
        // no way to tell them apart. Fewer than two projects (the common case): stay flat.
        const groups = groupRootsByProject(projectMap, folders.map(u => u.fsPath));
        if (groups.length > 0) roots = groups.map(g => projectNode(g, g.name, null));
    }

    /**
     * Whether a directory is generated output: an `ST_Files` (Generate ST) or `CPP_Files` (Compile
     * Project's C++) folder directly in a PLC project's directory (or in a workspace root, the
     * no-`.plcproj` export), or any folder below one.
     * @param {string} dirFsPath
     * @returns {boolean}
     */
    function isGeneratedDir(dirFsPath) {
        let current = path.resolve(dirFsPath);
        for (;;) {
            const parent = path.dirname(current);
            if (parent === current) return false;
            if (GENERATED_OUTPUT_DIRS.has(path.basename(current).toLowerCase())
                && (projectDirs.has(parent.toLowerCase()) || rootKeys.has(host.uriForPath(parent).toString()))) return true;
            current = parent;
        }
    }

    /**
     * Lists a directory: subdirectories first, then the TwinCAT files the tree shows, each group by
     * name. Inside Generate ST's output (`ST_Files`) the rows are read-only: their own contextValues
     * (`generatedDirectory`, `generatedStFile`) take no TwinCAT command. A read failure yields no rows.
     * @param {ObjectsTreeNode|null} parent The directory row, or null for a workspace root.
     * @param {UriLike} dirUri
     * @returns {Promise<Array<ObjectsTreeNode>>}
     */
    async function listDirectory(parent, dirUri) {
        let entries;
        try {
            entries = (await host.readDirectory(dirUri)).slice();
        } catch (err) {
            console.error(err);
            return [];
        }
        entries.sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0].localeCompare(b[0])));
        const insideOutput = isGeneratedDir(dirUri.fsPath);
        const rows = [];
        for (const [name, type] of entries) {
            const entryUri = host.joinPath(dirUri, name);
            if (type === ENTRY_TYPE.Directory) {
                if (BASE_SKIP_DIRS.has(name.toLowerCase())) continue;
                const generated = insideOutput || isGeneratedDir(entryUri.fsPath);
                rows.push(makeNode({
                    kind: 'directory', label: name, resourceUri: entryUri, collapsible: 'collapsed',
                    icon: { id: 'folder', color: null }, parent, facts: { generated },
                    tooltip: generated ? `Generated output — ${name}` : undefined
                }));
            } else if (type === ENTRY_TYPE.File) {
                let content = { declaration: '', hasChildren: false };
                if (needsContent(name)) {
                    try {
                        content = summarizeFile(await host.readFileText(entryUri));
                    } catch (e) {
                        // An unreadable file still shows, with its default icon.
                    }
                }
                // Compile Project's C++ output (CPP_Files, R13): the .cpp and .hpp are listed and open as text.
                if (insideOutput && /^\.(cpp|hpp)$/i.test(path.extname(name))) {
                    rows.push(makeNode({
                        kind: 'file', label: name, resourceUri: entryUri, facts: { fileContext: 'generatedCppFile' },
                        collapsible: 'none', icon: { id: 'file-code', color: null },
                        tooltip: `Generated C++ — ${name}`, opens: 'root', parent
                    }));
                    continue;
                }
                const cls = classifyFile(name, content);
                if (!cls) continue;
                // Only the .st files Generate ST wrote are listed in its output; they open as text.
                if (insideOutput && cls.kind !== 'stFile') continue;
                const { icon, tooltip } = decorate(cls.kind);
                rows.push(makeNode({
                    kind: 'file', label: name, resourceUri: entryUri,
                    facts: { fileContext: insideOutput ? 'generatedStFile' : cls.fileContext },
                    collapsible: cls.collapsible, icon,
                    tooltip: insideOutput ? `Generated Structured Text — ${name}` : `${tooltip} — ${name}`, opens: 'root', parent
                }));
            }
        }
        if (parent) parent.children = rows;
        return rows;
    }

    /**
     * Loads a file row's members from the document's current text. A read failure yields none.
     * @param {ObjectsTreeNode} fileNode
     * @returns {Promise<Array<ObjectsTreeNode>>}
     */
    async function loadFileMembers(fileNode) {
        try {
            fileNode.children = buildFileMembers(fileNode, await host.readDocumentText(fileNode.resourceUri));
        } catch (err) {
            console.error(err);
            fileNode.children = [];
        }
        return fileNode.children;
    }

    /**
     * The children VS Code asks for when it expands `node` (or the roots for none). Disk directories
     * and files are re-read on every call, so a refresh shows the current state.
     * @param {ObjectsTreeNode|null} [node]
     * @returns {Promise<Array<ObjectsTreeNode>>}
     */
    async function childrenOf(node) {
        if (!node) {
            if (roots) return roots;
            let all = [];
            for (const folder of folders) all = all.concat(await listDirectory(null, folder));
            return all;
        }
        switch (node.kind) {
            case 'solution': return node.children || [];
            case 'project':
            case 'directory': return listDirectory(node, node.resourceUri);
            case 'file':
                return ['pouFile', 'pouFileProgram', 'itfFile'].includes(node.contextValue)
                    ? loadFileMembers(node)
                    : [];
            default: return node.children || [];
        }
    }

    /**
     * Links a detached disk row to its ancestors, as VS Code will find them in the tree: directory
     * rows up to the owning PLC project row (when the tree shows projects) or up to a workspace root.
     * Builds ancestors only, never siblings, and each step is one Map/Set lookup.
     * @param {ObjectsTreeNode} node
     */
    function attachAncestry(node) {
        let current = node;
        for (;;) {
            const dir = path.dirname(current.resourceUri.fsPath);
            if (dir === current.resourceUri.fsPath) { current.parent = null; return; }
            const dirUri = host.uriForPath(dir);
            const key = dirUri.toString();
            const project = projectByDir.get(key);
            if (project) { current.parent = project; return; }
            if (rootKeys.has(key)) { current.parent = null; return; }
            const generated = isGeneratedDir(dir);
            const dirNode = makeNode({
                kind: 'directory', label: path.basename(dir), resourceUri: dirUri, collapsible: 'collapsed',
                icon: { id: 'folder', color: null }, facts: { generated },
                tooltip: generated ? `Generated output — ${path.basename(dir)}` : undefined
            });
            current.parent = dirNode;
            current = dirNode;
        }
    }

    /**
     * The node `TreeView.reveal()` is given for a file or one of its components, with its whole
     * ancestor chain attached so `getParent` is a field read. Only the target file is read.
     * @param {UriLike} fileUri Backing TwinCAT file.
     * @param {string} [componentId] Component id, or `root` for the file itself.
     * @returns {Promise<ObjectsTreeNode>} The exact component when found, otherwise the file row.
     */
    async function revealTarget(fileUri, componentId = 'root') {
        const ext = path.extname(fileUri.fsPath).toLowerCase();
        // Picked from the extension alone, without reading the file: VS Code matches the revealed
        // row by id, which does not depend on the contextValue.
        let fileContext = 'pouFile';
        if (ext === '.tcio') fileContext = 'itfFile';
        else if (ext === '.tcgvl') fileContext = 'gvlFile';
        else if (ext === '.tcdut' || ext === '.tctleo') fileContext = 'dutFile';
        else if (ext === '.st') fileContext = 'stFile';
        const expandable = ext === '.tcpou' || ext === '.tcio';
        const fileNode = makeNode({
            kind: 'file',
            label: path.basename(fileUri.fsPath),
            resourceUri: fileUri,
            facts: { fileContext },
            collapsible: expandable ? 'collapsed' : 'none'
        });
        attachAncestry(fileNode);
        if (!componentId || componentId === 'root' || !expandable) return fileNode;

        const pending = (await loadFileMembers(fileNode)).slice();
        while (pending.length > 0) {
            const node = pending.shift();
            if (node.componentId === componentId) return node;
            if (node.children) pending.unshift(...node.children);
        }
        return fileNode;
    }

    return {
        isFlat: roots === null,
        roots,
        childrenOf,
        revealTarget,
        projectNodeForDir: (dirUri) => projectByDir.get(dirUri.toString()) || null
    };
}

module.exports = {
    ENTRY_TYPE,
    createObjectsTreeModel,
    groupRootsByProject,
    makeNode,
    nodeId,
    classifyFile,
    buildFileMembers
};
