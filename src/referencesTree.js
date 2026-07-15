/**
 * @file referencesTree.js
 * @description Pure (vscode-free) grouping logic for the References view, so it can be unit-tested.
 */

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
        const noQuery = String(uri).split(/[?#]/)[0];
        const last = noQuery.split(/[\\/]/).pop() || noQuery;
        return decodeURIComponent(last);
    } catch (e) {
        return String(uri);
    }
}

/**
 * Groups flat reference items into a file -> component -> occurrence tree.
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
                label: componentLabel(cid),
                count: occ.length,
                children: occ.map(o => ({ kind: 'occurrence', ...o }))
            });
        }
        fileNodes.push({
            kind: 'file',
            label: basenameFromUri(uri),
            count: compNodes.reduce((n, c) => n + c.count, 0),
            children: compNodes
        });
    }
    return fileNodes;
}

module.exports = { componentLabel, basenameFromUri, buildTree };
