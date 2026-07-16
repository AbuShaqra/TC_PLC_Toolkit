/**
 * @file test_references_tree.js
 * @description Unit tests for the References view grouping (file -> component -> occurrence), and
 * for the provider's getParent — which TreeView.reveal() refuses to work without.
 */

// `vscode` is stubbed so referencesProvider (which requires it) runs in plain Node like every other
// harness.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === 'vscode') return 'vscode-stub';
    return origResolve.call(this, req, ...rest);
};
require.cache['vscode-stub'] = {
    id: 'vscode-stub', filename: 'vscode-stub', loaded: true,
    exports: {
        EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
        TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        Uri: { parse: (s) => ({ toString: () => s }) }
    }
};

const { buildTree, componentLabel, basenameFromUri } = require('../src/referencesTree');
const { TwinCatReferencesProvider } = require('../src/referencesProvider');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// componentLabel
assert(componentLabel('root') === 'Main', 'root -> Main');
assert(componentLabel('method_cyclic') === 'cyclic()', 'method_cyclic -> cyclic()');
assert(componentLabel('prop_N_BinID') === 'N_BinID', 'prop_N_BinID -> N_BinID');
assert(componentLabel('action_Foo') === 'Foo', 'action_Foo -> Foo');

// basename
assert(basenameFromUri('file:///c:/proj/POUs/FB_Bin.TcPOU') === 'FB_Bin.TcPOU', 'basename from file uri');
assert(basenameFromUri('file:///c:/My%20Proj/MAIN.TcPOU') === 'MAIN.TcPOU', 'basename decodes %20');

// buildTree grouping
const items = [
    { uri: 'file:///p/FB_Bin.TcPOU', componentId: 'root', targetWord: 'FB_Bin', lineText: 'FUNCTION_BLOCK FB_Bin', line: 0 },
    { uri: 'file:///p/MAIN.TcPOU', componentId: 'root', targetWord: 'FB_Bin', lineText: 'fbBinA : FB_Bin;', line: 6 },
    { uri: 'file:///p/MAIN.TcPOU', componentId: 'root', targetWord: 'FB_Bin', lineText: 'fbBinB : FB_Bin;', line: 7 },
    { uri: 'file:///p/FB_Conveyor.TcPOU', componentId: 'method_cyclic', targetWord: 'FB_Bin', lineText: 'fbDestinationBin : REFERENCE TO FB_Bin;', line: 5 }
];
const tree = buildTree(items);
assert(tree.length === 3, `groups into 3 files (got ${tree.length})`);
const main = tree.find(f => f.label === 'MAIN.TcPOU');
assert(main && main.count === 2, `MAIN groups 2 occurrences (got ${main && main.count})`);
const conv = tree.find(f => f.label === 'FB_Conveyor.TcPOU');
assert(conv && conv.children[0].label === 'cyclic()', `FB_Conveyor occurrence under cyclic() component`);
const total = tree.reduce((n, f) => n + f.count, 0);
assert(total === 4, `total occurrence count is 4 (got ${total})`);

// Occurrence nodes must carry the exact-location fields end to end so navigation lands on the
// right hit (regression: first-match word search jumped to an earlier same-named occurrence).
const locItems = [
    { uri: 'file:///p/FB_Conveyor.TcPOU', componentId: 'method_cyclic', targetWord: 'INIT',
      lineText: 'IF eMode = E_operation_mode.INIT THEN', line: 42,
      pane: 'impl', localLine: 3, startCharacter: 27, endCharacter: 31 }
];
const locTree = buildTree(locItems);
const occ = locTree[0].children[0].children[0];
assert(occ.kind === 'occurrence', 'location item builds an occurrence node');
assert(occ.pane === 'impl', `occurrence carries pane (got ${occ.pane})`);
assert(occ.localLine === 3, `occurrence carries localLine (got ${occ.localLine})`);
assert(occ.startCharacter === 27, `occurrence carries startCharacter (got ${occ.startCharacter})`);
assert(occ.endCharacter === 31, `occurrence carries endCharacter (got ${occ.endCharacter})`);
assert(occ.line === 42, `occurrence carries absolute line (got ${occ.line})`);

// Stable TreeItem ids. VS Code's async tree tracks nodes across refreshes by TreeItem.id; without
// one, node identity churns on every refresh, and a refresh racing showReferences' reveal() could
// drop a group's children fetch — an expand arrow that opened onto nothing (real user report:
// GVL_System.TcGVL, count 1, dead twistie, while buildTree's output was verifiably correct).
// Ids must exist on every node, be unique across the tree, and be deterministic across rebuilds.
const collectNodes = (nodes, out = []) => {
    for (const n of nodes) {
        out.push(n);
        if (n.children) collectNodes(n.children, out);
    }
    return out;
};
const allNodes = collectNodes(tree);
assert(allNodes.every(n => typeof n.id === 'string' && n.id.length > 0),
    'every node in a built tree has a non-empty string id');
const idSet = new Set(allNodes.map(n => n.id));
assert(idSet.size === allNodes.length,
    `ids are unique across the tree (${idSet.size} distinct of ${allNodes.length} nodes)`);

// Determinism: two buildTree calls over the same items must produce identical ids at every
// position — a per-call counter or random suffix would defeat the identity tracking entirely.
const ids1 = collectNodes(buildTree(items)).map(n => n.id);
const ids2 = collectNodes(buildTree(items)).map(n => n.id);
assert(ids1.length === ids2.length && ids1.every((id, i) => id === ids2[i]),
    'ids are stable: two buildTree calls over the same items agree at every position');

// Two hits at the identical position must still get distinct ids (the index-within-component
// suffix) — a TreeItem.id collision makes VS Code throw and drop the element.
const dupItems = [
    { uri: 'file:///p/A.TcPOU', componentId: 'root', targetWord: 'x', lineText: 'x := x;', line: 1, startCharacter: 0, endCharacter: 1 },
    { uri: 'file:///p/A.TcPOU', componentId: 'root', targetWord: 'x', lineText: 'x := x;', line: 1, startCharacter: 0, endCharacter: 1 }
];
const dupOccs = buildTree(dupItems)[0].children[0].children;
assert(dupOccs.length === 2 && dupOccs[0].id !== dupOccs[1].id,
    'duplicate positions still get distinct occurrence ids');

// getParent. TreeView.reveal() rejects outright on a provider that does not implement it, so without
// this method "Go to References" never brings the view to the front — with another panel tab active
// (Terminal, Problems, …) the results stayed hidden behind it and the search looked like a no-op.
// The reveal is also the only thing that switches the panel tab, since it is deliberately called with
// focus:false to avoid killing Monaco's peek widget.
const provider = new TwinCatReferencesProvider();
provider.setReferences('FB_Bin', items);

assert(typeof provider.getParent === 'function',
    'the provider implements getParent — TreeView.reveal() rejects without it, and the panel never fronts');

const fileNode = provider.roots.find(f => f.label === 'MAIN.TcPOU');
const componentNode = fileNode.children[0];
const occurrenceNode = componentNode.children[0];

assert(provider.getParent(fileNode) === undefined, 'a file node is a root (no parent)');
assert(provider.getParent(componentNode) === fileNode, 'a component node reports its file as parent');
assert(provider.getParent(occurrenceNode) === componentNode, 'an occurrence node reports its component as parent');
assert(provider.getParent({ kind: 'occurrence' }) === undefined, 'a node not in the tree has no parent (no throw)');
assert(provider.getParent(undefined) === undefined, 'getParent(undefined) does not throw');

// reveal() is handed roots[0], so that node above all must resolve.
assert(provider.roots.length > 0 && provider.getParent(provider.roots[0]) === undefined,
    'roots[0] — the node showReferences reveals — resolves cleanly');

// getTreeItem: group nodes render Collapsed (1), never Expanded (2) — expansion is driven by
// reveal(..., { expand: 2 }) in extension.js. Expanded-during-refresh was the fragile path behind
// the dead-twistie report: VS Code rendered the arrow but never fetched the children. A Collapsed
// node's twistie click triggers a lazy getChildren, which always works.
const fileTreeItem = provider.getTreeItem(fileNode);
assert(fileTreeItem.collapsibleState === 1,
    `a file node with children renders Collapsed (got ${fileTreeItem.collapsibleState})`);
const componentTreeItem = provider.getTreeItem(componentNode);
assert(componentTreeItem.collapsibleState === 1,
    `a component node with children renders Collapsed (got ${componentTreeItem.collapsibleState})`);
const occurrenceTreeItem = provider.getTreeItem(occurrenceNode);
assert(occurrenceTreeItem.collapsibleState === 0,
    `an occurrence node is a leaf, None (got ${occurrenceTreeItem.collapsibleState})`);

// A group that somehow has no children must not render an arrow at all — a dead twistie is
// exactly the bug this guards against.
const emptyFileItem = provider.getTreeItem({ kind: 'file', id: 'file:///p/E.TcPOU', label: 'E.TcPOU', count: 0, children: [] });
assert(emptyFileItem.collapsibleState === 0,
    `a file node with no children renders no arrow, None (got ${emptyFileItem.collapsibleState})`);
const emptyComponentItem = provider.getTreeItem({ kind: 'component', id: 'file:///p/E.TcPOU::root', label: 'Main', count: 0, children: [] });
assert(emptyComponentItem.collapsibleState === 0,
    `a component node with no children renders no arrow, None (got ${emptyComponentItem.collapsibleState})`);

// TreeItems must carry the node's stable id — that is what gives VS Code a refresh-proof identity.
assert(fileTreeItem.id === fileNode.id, 'file TreeItem.id matches the node id');
assert(componentTreeItem.id === componentNode.id, 'component TreeItem.id matches the node id');
assert(occurrenceTreeItem.id === occurrenceNode.id, 'occurrence TreeItem.id matches the node id');

console.log(`\n--- REFERENCES TREE TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
