/**
 * @file dndRules.js
 * @description The drag & drop AND copy/paste compatibility matrices for the "TwinCAT Objects"
 * explorer, as pure data-in/data-out functions — no vscode, no fs — so both matrices are
 * unit-testable (test/test_dnd_rules.js). treeDragAndDrop.js / clipboardCommands.js own the side
 * effects (XML edits, filesystem moves/writes, .plcproj sync); everything that decides WHETHER a
 * drop or a paste is legal lives here.
 *
 * Path comparisons are case-insensitive throughout: TwinCAT projects are Windows-native, and the
 * same file can reach us with different casing depending on which VS Code API produced the uri
 * (drive letters especially). A wrong "same path" match would only suppress a move the filesystem
 * would treat as a no-op anyway.
 */

const path = require('path');
const { parse: parseComponentId, isAccessor, KIND_TO_XML_TAG } = require('./componentId');

/**
 * @typedef {{ fsPath: string, toString(): string }} UriLike
 * A vscode.Uri, or any stand-in exposing the two members the matrix reads. Keeping this structural
 * (instead of requiring a real vscode.Uri) is what lets the harness use plain objects.
 */

/**
 * @typedef {Object} DraggedDescriptor
 * @property {'component'|'file'|'directory'} kind What is being dragged.
 * @property {UriLike} uri The backing file (components: the file that contains them).
 * @property {string} [fsPath] Filesystem path — files and directories only.
 * @property {'Method'|'Property'|'Action'|'Transition'} [componentType] XML tag — components only.
 * @property {string} [componentName] Name attribute value — components only.
 */

/**
 * @typedef {Object} DropTarget
 * @property {'virtualFolder'|'file'|'directory'|'workspaceRoot'} kind Where the drop landed.
 * @property {UriLike} [uri] The backing file — virtualFolder and file targets.
 * @property {string} [folderPath] Virtual-folder path, trailing backslash — virtualFolder targets.
 * @property {string} [contextValue] The tree item's contextValue — file targets.
 * @property {string} [fsPath] Directory path — directory and workspaceRoot targets.
 */

/** contextValues of the physical-file tree items a user may move between directories. */
const FILE_CONTEXT_VALUES = new Set([
    'pouFile', 'pouFileProgram', 'pouFileFunction', 'itfFile', 'gvlFile', 'dutFile', 'stFile'
]);

/**
 * Classifies a tree item at drag start. Returns null for everything that must not be draggable:
 * property Get/Set accessors (they live inside the property's tag and move with it), virtual
 * folders (v1 exclusion — moving one means rewriting every member's FolderPath prefix), and
 * workspace roots.
 * @param {{ contextValue?: string, resourceUri?: UriLike, componentId?: string }} item A
 * TwinCatTreeItem (or a test stand-in with the same shape).
 * @returns {DraggedDescriptor|null} The descriptor, or null when the item is not draggable.
 */
function describeDragged(item) {
    if (!item || !item.contextValue || !item.resourceUri) return null;
    const cv = item.contextValue;

    if (cv === 'component' || cv === 'propertyNode') {
        const id = item.componentId || '';
        // Get/Set accessors carry the same 'component' contextValue as methods/actions, so they
        // can only be told apart by their id shape (`prop_<name>_get` / `prop_<name>_set`); they
        // live inside the property's tag and move with it.
        if (isAccessor(id)) return null;
        const p = parseComponentId(id);
        if (p && p.kind !== 'root') {
            return {
                kind: 'component',
                uri: item.resourceUri,
                componentType: /** @type {'Method'|'Property'|'Action'|'Transition'} */ (KIND_TO_XML_TAG[p.kind]),
                componentName: p.name
            };
        }
        return null;
    }

    if (FILE_CONTEXT_VALUES.has(cv)) {
        return { kind: 'file', uri: item.resourceUri, fsPath: item.resourceUri.fsPath };
    }
    if (cv === 'directory') {
        return { kind: 'directory', uri: item.resourceUri, fsPath: item.resourceUri.fsPath };
    }
    return null;
}

/**
 * Normalizes an fsPath for comparison: resolves `.`/`..` segments, strips trailing separators,
 * lower-cases (see the file header for why comparisons are case-insensitive).
 * @param {string} fsPath
 * @returns {string}
 */
function normalizeFsPath(fsPath) {
    let p = path.normalize(fsPath);
    while (p.length > 1 && p.endsWith(path.sep)) p = p.slice(0, -1);
    return p.toLowerCase();
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} Whether the two fsPaths denote the same filesystem entry.
 */
function isSameFsPath(a, b) {
    return normalizeFsPath(a) === normalizeFsPath(b);
}

/**
 * Decides what (if anything) a drop should do. Every pair outside the compatibility matrix
 * returns null — the caller treats null as a silent no-op, per the design: rejections give no
 * feedback, exactly like dropping onto dead space.
 * @param {DraggedDescriptor|null} dragged The dragged item's descriptor (from describeDragged).
 * @param {DropTarget|null} target The classified drop target, or null for an unusable one.
 * @returns {{ action: 'setFolderPath', fileUri: UriLike, componentType: string, componentName: string, newFolderPath: string }
 *         | { action: 'move', sourceFsPath: string, targetDirFsPath: string, isDirectory: boolean }
 *         | null} The planned operation, or null when the pair is incompatible.
 */
function planDrop(dragged, target) {
    if (!dragged || !target) return null;

    if (dragged.kind === 'component') {
        // A component only ever travels inside its own file: FolderPath is an attribute on the
        // member's XML tag, so "moving" it to another file's folder has no XML meaning.
        if (target.kind === 'virtualFolder' && isSameFsPath(dragged.uri.fsPath, target.uri.fsPath)) {
            return {
                action: 'setFolderPath',
                fileUri: dragged.uri,
                componentType: dragged.componentType,
                componentName: dragged.componentName,
                newFolderPath: target.folderPath
            };
        }
        // Dropping onto the component's own file node moves it back to the root (no FolderPath).
        if (target.kind === 'file' && isSameFsPath(dragged.uri.fsPath, target.uri.fsPath)) {
            return {
                action: 'setFolderPath',
                fileUri: dragged.uri,
                componentType: dragged.componentType,
                componentName: dragged.componentName,
                newFolderPath: ''
            };
        }
        return null;
    }

    if (dragged.kind === 'file' || dragged.kind === 'directory') {
        if (target.kind !== 'directory' && target.kind !== 'workspaceRoot') return null;
        // Dropping where the item already lives is a no-op, not a move.
        if (isSameFsPath(path.dirname(dragged.fsPath), target.fsPath)) return null;
        if (dragged.kind === 'directory') {
            // A directory must not move into itself or its own subtree. The trailing separator in
            // the prefix compare keeps siblings that merely share a name prefix apart:
            // C:\a\bc is NOT a descendant of C:\a\b.
            const source = normalizeFsPath(dragged.fsPath);
            const targetDir = normalizeFsPath(target.fsPath);
            if (targetDir === source || targetDir.startsWith(source + path.sep)) return null;
        }
        return {
            action: 'move',
            sourceFsPath: dragged.fsPath,
            targetDirFsPath: target.fsPath,
            isDirectory: dragged.kind === 'directory'
        };
    }

    return null;
}

/**
 * @typedef {Object} CopiedDescriptor
 * @property {'component'|'file'} kind What was copied (copy = duplicate; DnD is the move).
 * @property {UriLike} uri The backing file (components: the file that contains them).
 * @property {string} [fsPath] Filesystem path — files only.
 * @property {'Method'|'Property'|'Action'|'Transition'} [componentType] XML tag — components only.
 * @property {string} [componentName] Name attribute value — components only.
 * @property {boolean} [sourceIsItf] Whether the component comes from an Interface (.TcIO) —
 * components only; the paste kind gate keys on it.
 */

/**
 * @typedef {DropTarget | { kind: 'componentSibling', uri: UriLike, folderPath: string }} PasteTarget
 * planPaste accepts every planDrop target shape plus a component under the cursor: pasting onto a
 * component means "as its sibling" — same file, same virtual folder.
 */

/**
 * @param {UriLike} uri
 * @returns {boolean} Whether the uri denotes an Interface file (.TcIO).
 */
function isItfUri(uri) {
    return path.extname(uri.fsPath).toLowerCase() === '.tcio';
}

/**
 * Classifies a tree item at copy time. Differs from describeDragged in exactly two places, both
 * deliberate: EVERY file kind is copyable (a move must keep .plcproj semantics intact, but a
 * duplicate of a function/GVL/DUT/ST file is always meaningful), while directories are NOT
 * (v1 exclusion — a recursive directory duplicate mass-produces duplicate symbols). The accessor
 * exclusion is identical: Get/Set ride with their property.
 * @param {{ contextValue?: string, resourceUri?: UriLike, componentId?: string }} item A
 * TwinCatTreeItem (or a test stand-in with the same shape).
 * @returns {CopiedDescriptor|null} The descriptor, or null when the item is not copyable.
 */
function describeCopied(item) {
    const described = describeDragged(item);
    if (!described || described.kind === 'directory') return null;
    if (described.kind === 'component') {
        return {
            kind: 'component',
            uri: described.uri,
            componentType: described.componentType,
            componentName: described.componentName,
            // The paste matrix gates on source/target file kind: interface members have no
            // Implementation blocks, POU members do — mixing the two produces invalid XML.
            sourceIsItf: isItfUri(described.uri)
        };
    }
    return { kind: 'file', uri: described.uri, fsPath: described.fsPath };
}

/** File-node contextValues a component may be pasted into: only POUs and interfaces have members. */
const COMPONENT_PASTE_FILE_TARGETS = new Set(['pouFile', 'pouFileProgram', 'itfFile']);

/**
 * Decides what (if anything) a paste should do. Unlike the move matrix, a component pastes
 * CROSS-FILE (a duplicate under another POU is meaningful where a move is not) and a file pastes
 * into its OWN directory (duplicate-in-place). Every pair outside the matrix returns null — the
 * caller treats null as a silent no-op, same design as planDrop.
 * @param {CopiedDescriptor|null} copied The copied item's descriptor (from describeCopied).
 * @param {PasteTarget|null} target The classified paste target, or null for an unusable one.
 * @returns {{ action: 'pasteComponent', sourceUri: UriLike, targetUri: UriLike, componentType: string, componentName: string, newFolderPath: string, targetIsItf: boolean }
 *         | { action: 'pasteFile', sourceFsPath: string, targetDirFsPath: string }
 *         | null} The planned operation, or null when the pair is incompatible.
 */
function planPaste(copied, target) {
    if (!copied || !target) return null;

    if (copied.kind === 'component') {
        /** @type {UriLike|null} */
        let targetUri = null;
        let newFolderPath = '';
        if (target.kind === 'virtualFolder') {
            targetUri = target.uri;
            newFolderPath = target.folderPath || '';
        } else if (target.kind === 'file') {
            // Functions, GVLs, DUTs and ST files have no members to paste into.
            if (!COMPONENT_PASTE_FILE_TARGETS.has(target.contextValue)) return null;
            targetUri = target.uri;
        } else if (target.kind === 'componentSibling') {
            targetUri = target.uri;
            newFolderPath = target.folderPath || '';
        } else {
            return null;
        }

        const targetIsItf = isItfUri(targetUri);
        // Kind gate: POU members carry Implementation blocks, interface members must not — a block
        // pasted across the divide is invalid XML on arrival.
        if (!!copied.sourceIsItf !== targetIsItf) return null;
        // Interfaces have no actions or transitions at all, whatever the source.
        if (targetIsItf && (copied.componentType === 'Action' || copied.componentType === 'Transition')) return null;

        return {
            action: 'pasteComponent',
            sourceUri: copied.uri,
            targetUri,
            componentType: copied.componentType,
            componentName: copied.componentName,
            newFolderPath,
            targetIsItf
        };
    }

    if (copied.kind === 'file') {
        if (target.kind !== 'directory' && target.kind !== 'workspaceRoot') return null;
        // Same directory is deliberately ALLOWED (unlike planDrop): duplicate-in-place is the
        // classic copy gesture, and the paste always prompts for a fresh file name anyway.
        return {
            action: 'pasteFile',
            sourceFsPath: copied.fsPath,
            targetDirFsPath: target.fsPath
        };
    }

    return null;
}

module.exports = {
    describeDragged,
    planDrop,
    describeCopied,
    planPaste
};
