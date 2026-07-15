/**
 * @file test_library_tree.js
 * @description The "TwinCAT Libraries" tree: what is expandable, and what each row inserts.
 *
 * There was no harness for this file, and it showed: methods shipped in 0.4.0 with the type row's
 * collapsible state still computed from `members` alone. Every *interface* — methods and no fields —
 * therefore rendered as a leaf, and its whole surface was unreachable from the tree (I_List: 21
 * methods, none of them clickable). 127 methods across a real project's catalog were hidden that way.
 *
 * `vscode` is stubbed, so this runs in plain Node like every other harness.
 */

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
        TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        MarkdownString: class { appendMarkdown() {} }
    }
};

const {
    TwinCatLibraryTreeDataProvider, insertTextForNode, formattedDefinitionForNode
} = require('../src/libraryTreeProvider');

const LEAF = 0;
const EXPANDABLE = 1;

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// A catalog shaped exactly like the one the LSP sends over `custom/libraries`.
const CATALOG = [{
    include: 'Dyn Collections', title: 'Dyn Collections', version: '1.0.0.0', company: 'X',
    namespace: 'TcDynCollections', kind: 'library', symbolCount: 3,
    types: [
        {
            // An INTERFACE: methods, no fields. The row that used to be a leaf.
            name: 'I_List', kind: 'fb', returnType: '', extendsType: '', members: [],
            methods: [
                { name: 'Add', returnType: 'BOOL', params: [{ name: 'item', type: 'DWORD', scope: 'VAR_INPUT' }] },
                { name: 'Clear', returnType: '', params: [] }
            ]
        },
        {
            // An FB with both.
            name: 'FB_List', kind: 'fb', returnType: '', extendsType: '',
            members: [
                { name: 'nCapacity', type: 'UDINT', scope: 'VAR_INPUT' },
                { name: 'bError', type: 'BOOL', scope: 'VAR_OUTPUT' }
            ],
            methods: [
                { name: 'Remove', returnType: 'BOOL', params: [
                    { name: 'nIndex', type: 'UDINT', scope: 'VAR_INPUT' },
                    { name: 'bOk', type: 'BOOL', scope: 'VAR_OUTPUT' }
                ] }
            ]
        },
        // A struct: no methods, must be unaffected.
        { name: 'ST_Entry', kind: 'struct', returnType: '', extendsType: '', methods: [],
          members: [{ name: 'nKey', type: 'UDINT', scope: '' }] }
    ]
}];

const provider = new TwinCatLibraryTreeDataProvider(async () => CATALOG);

(async () => {
    const libs = await provider.getChildren();
    const groups = await provider.getChildren(libs[0]);
    const fbGroup = groups.find(g => g.group.kind === 'fb');
    const types = await provider.getChildren(fbGroup);

    const iList = types.find(t => t.type.name === 'I_List');
    const fbList = types.find(t => t.type.name === 'FB_List');

    console.log('--- what is expandable ---');
    assert(provider.getTreeItem(iList).collapsibleState === EXPANDABLE,
        'a type with methods but NO members is expandable (the interface leaf bug)');
    assert(provider.getTreeItem(fbList).collapsibleState === EXPANDABLE,
        'a type with both members and methods is expandable');

    const structGroup = groups.find(g => g.group.kind === 'struct');
    const stEntry = (await provider.getChildren(structGroup))[0];
    assert(provider.getTreeItem(stEntry).collapsibleState === EXPANDABLE, 'a struct with fields is expandable');

    console.log('\n--- children ---');
    const iKids = await provider.getChildren(iList);
    assert(iKids.length === 2 && iKids.every(k => k.kind === 'method'),
        `an interface's children are its methods (got ${iKids.map(k => k.kind).join(', ')})`);

    const fKids = await provider.getChildren(fbList);
    assert(fKids.filter(k => k.kind === 'member').length === 2 && fKids.filter(k => k.kind === 'method').length === 1,
        `an FB lists its members then its methods (got ${fKids.map(k => k.kind).join(', ')})`);

    const remove = fKids.find(k => k.kind === 'method');
    const item = provider.getTreeItem(remove);
    assert(item.contextValue === 'twincatLibraryMethod',
        `a method row's contextValue drives the Insert Definition menu (got ${item.contextValue})`);
    assert(item.description === '(nIndex, bOk) : BOOL',
        `a method row shows its signature (got ${JSON.stringify(item.description)})`);
    assert(item.collapsibleState === EXPANDABLE, 'a method with parameters expands to show them');

    const clear = iKids.find(k => k.method.name === 'Clear');
    assert(provider.getTreeItem(clear).collapsibleState === LEAF, 'a method with no parameters is a leaf');

    console.log('\n--- what each row inserts ---');
    assert(insertTextForNode(remove) === 'Remove',
        `Insert at Cursor on a method gives its bare name (got ${JSON.stringify(insertTextForNode(remove))})`);

    // Qualified with the owner: a bare `Remove(` at a cursor says nothing about what it belongs to.
    const def = formattedDefinitionForNode(remove);
    assert(def === [
        'TcDynCollections.FB_List.Remove(',
        '    nIndex := ,  // UDINT',
        '    bOk    =>   // BOOL',
        ');'
    ].join('\n'), `Insert Definition on a method: owner-qualified, inputs :=, outputs =>\n${def}`);

    assert(formattedDefinitionForNode(clear) === 'TcDynCollections.I_List.Clear();',
        `a parameterless method still gets a call, not a bare name (got ${formattedDefinitionForNode(clear)})`);

    const fbDef = formattedDefinitionForNode(fbList);
    assert(fbDef.startsWith('TcDynCollections.FB_List(') && fbDef.includes('bError    =>'),
        `Insert Definition on the FB itself is unchanged\n${fbDef}`);

    // A struct has no call parameters, so there is no template to give.
    assert(formattedDefinitionForNode(stEntry) === 'TcDynCollections.ST_Entry',
        `a struct falls back to its qualified name (got ${formattedDefinitionForNode(stEntry)})`);

    console.log(`\n--- LIBRARY TREE TESTS COMPLETE with ${errors} error(s) ---`);
    process.exit(errors > 0 ? 1 : 0);
})();
