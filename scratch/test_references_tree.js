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

console.log(`\n--- REFERENCES TREE TESTS COMPLETE with ${errors} errors ---`);
process.exit(errors > 0 ? 1 : 0);
