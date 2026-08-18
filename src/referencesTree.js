/**
 * @file referencesTree.js
 * @description Pure (vscode-free) grouping logic for the References view, so it can be unit-tested.
 */

const { fileUriBasename } = require('./fileUri');

/**
 * Humanizes a component id for display (e.g. 'method_cyclic' -> 'cyclic()', 'root' -> 'Main').
 * @param {string} componentId
 * @returns {string}
 */
function componentLabel(componentId) {
    if (!componentId || componentId === 'root') return 'Main';
    const m = componentId.match(/^(method|prop|action|get|set)_(.+)$/);
    if (m) {
        const name = m[2].replace(/_(get|set)$/i, '');
        return name + (m[1] === 'method' ? '()' : '');
    }
    return componentId;
}

/** Extracts a file basename from a file URI string without depending on vscode. */
function basenameFromUri(uri) {
    try {
        return fileUriBasename(uri);
    } catch (e) {
        return String(uri);
    }
}

/**
 * Groups flat reference items into a file -> component -> occurrence tree.
 *
 * Every node gets a deterministic `id` (two calls with the same items produce the same ids at
 * every position). The provider copies it onto TreeItem.id, giving VS Code's async tree a stable
 * identity across refreshes — without one, identity churns per refresh, and a refresh racing a
 * reveal() could drop a group's children fetch, leaving an expand arrow that opens onto nothing.
 * Occurrence ids carry the index within their component's list so duplicate positions never collide.
 *
 * @param {Array<Object>} items Each { uri, componentId, targetWord, lineText, line }.
 * @returns {Array<Object>} File group nodes.
 */
function buildTree(items) {
    const fileMap = new Map();
    for (const it of items) {
        if (!fileMap.has(it.uri)) fileMap.set(it.uri, new Map());
        const compMap = fileMap.get(it.uri);
        const cid = it.componentId || 'root';
        if (!compMap.has(cid)) compMap.set(cid, []);
        compMap.get(cid).push(it);
    }

    const fileNodes = [];
    for (const [uri, compMap] of fileMap) {
        const compNodes = [];
        for (const [cid, occ] of compMap) {
            compNodes.push({
                kind: 'component',
                id: `${uri}::${cid}`,
                label: componentLabel(cid),
                count: occ.length,
                children: occ.map((o, index) => ({
                    kind: 'occurrence',
                    ...o,
                    id: `${uri}::${cid}::${o.line}:${o.startCharacter}::${index}`
                }))
            });
        }
        fileNodes.push({
            kind: 'file',
            id: uri,
            label: basenameFromUri(uri),
            count: compNodes.reduce((n, c) => n + c.count, 0),
            children: compNodes
        });
    }
    return fileNodes;
}

module.exports = { componentLabel, basenameFromUri, buildTree };
