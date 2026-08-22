/**
 * @file test_tree_reveal.js
 * @description Exact Objects-tree reveal targets and their logical parent chains.
 *
 * Go to Definition / Find References already carried the target component id, but extension.js
 * rebuilt only a file node and the Objects provider treated every component URI as a filesystem
 * child. VS Code therefore selected the parent file (or its directory) instead of the method,
 * property, action/transition, or property accessor that actually opened.
 */

const Module = require('module');
const path = require('path');

const XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="FB_Reveal" Id="{00000000-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Reveal
]]></Declaration>
    <Implementation><ST><![CDATA[]]></ST></Implementation>
    <Folder Name="Logic" Id="{00000000-0000-0000-0000-000000000002}">
      <Folder Name="Nested" Id="{00000000-0000-0000-0000-000000000003}" />
    </Folder>
    <Folder Name="Steps" Id="{00000000-0000-0000-0000-000000000004}" />
    <Method Name="Run" Id="{00000000-0000-0000-0000-000000000005}" FolderPath="Logic\\Nested\\">
      <Declaration><![CDATA[METHOD Run
]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
    </Method>
    <Property Name="Value" Id="{00000000-0000-0000-0000-000000000006}" FolderPath="Logic\\Nested\\">
      <Declaration><![CDATA[PROPERTY Value : INT
]]></Declaration>
      <Get Name="Get" Id="{00000000-0000-0000-0000-000000000007}">
        <Declaration><![CDATA[]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
      </Get>
      <Set Name="Set" Id="{00000000-0000-0000-0000-000000000008}">
        <Declaration><![CDATA[]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
      </Set>
    </Property>
    <Property Name="Data_get" Id="{00000000-0000-0000-0000-000000000011}">
      <Declaration><![CDATA[PROPERTY Data_get : INT
]]></Declaration>
    </Property>
    <Action Name="Start" Id="{00000000-0000-0000-0000-000000000009}" FolderPath="Steps\\">
      <Implementation><ST><![CDATA[]]></ST></Implementation>
    </Action>
    <Transition Name="Ready" Id="{00000000-0000-0000-0000-000000000010}" FolderPath="Steps\\">
      <Implementation><ST><![CDATA[]]></ST></Implementation>
    </Transition>
  </POU>
</TcPlcObject>`;

const uriFor = (fsPath) => ({
    fsPath,
    toString: () => 'file:///' + fsPath.replace(/\\/g, '/').replace(/^\/+/, '')
});

const ModuleResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === 'vscode') return 'vscode-tree-reveal-stub';
    return ModuleResolve.call(this, req, ...rest);
};

let projectMapReads = 0;
const rootPath = path.resolve('C:\\RevealWorkspace');
const projectDir = path.join(rootPath, 'PLC');
const filePath = path.join(projectDir, 'POUs', 'FB_Reveal.TcPOU');
const projectKey = 'reveal-project';
const projectRecord = { key: projectKey, name: 'PLC', displayName: 'PLC', dir: projectDir };
const solutionRecord = {
    key: 'reveal-solution', name: 'RevealSolution', displayName: 'RevealSolution',
    slnPath: path.join(rootPath, 'RevealSolution.sln'), projects: [projectRecord]
};
const projectMap = {
    projects: new Map([[projectKey, projectRecord]]),
    displayName: () => 'PLC'
};
const solutionMap = {
    solutions: [solutionRecord],
    orphanProjects: [],
    solutionForProject: key => key === projectKey ? solutionRecord : null
};
require.cache['vscode-tree-reveal-stub'] = {
    id: 'vscode-tree-reveal-stub', filename: 'vscode-tree-reveal-stub', loaded: true,
    exports: {
        EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
        TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
        ThemeColor: class { constructor(id) { this.id = id; } },
        Uri: {
            file: uriFor,
            joinPath: (base, name) => uriFor(path.join(base.fsPath, name))
        },
        workspace: {
            workspaceFolders: [{ uri: uriFor(rootPath) }],
            openTextDocument: async () => ({ getText: () => XML })
        }
    }
};

const vscode = require('vscode');
const { TwinCatTreeDataProvider } = require('../src/treeDataProvider');
const provider = new TwinCatTreeDataProvider(() => { projectMapReads++; return projectMap; }, () => solutionMap);
const fileUri = uriFor(filePath);

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

function parentIds(item) {
    const ids = [];
    let current = item;
    while ((current = provider.getParent(current))) ids.push(current.componentId || current.folderPath || current.label);
    return ids;
}

(async () => {
    const root = await provider.getRevealItem(fileUri, 'root');
    assert(root.resourceUri.toString() === fileUri.toString() && !root.componentId,
        'root navigation reveals the backing file');

    const method = await provider.getRevealItem(fileUri, 'method_Run');
    assert(method.componentId === 'method_Run', 'method navigation resolves the exact method item');
    assert(JSON.stringify(parentIds(method).slice(0, 3)) === JSON.stringify(['Logic\\Nested\\', 'Logic\\', 'FB_Reveal.TcPOU']),
        `method parent chain includes nested virtual folders and file (${JSON.stringify(parentIds(method))})`);
    assert(parentIds(method).slice(-2).join(',') === 'PLC,RevealSolution',
        `method reveal ancestry reaches its PLC project and solution (${JSON.stringify(parentIds(method))})`);

    const property = await provider.getRevealItem(fileUri, 'prop_Value');
    assert(property.componentId === 'prop_Value', 'property navigation resolves the property node');
    assert(provider.getParent(property).folderPath === 'Logic\\Nested\\',
        'property reports its virtual folder as parent');

    for (const id of ['prop_Value_get', 'prop_Value_set']) {
        const accessor = await provider.getRevealItem(fileUri, id);
        assert(accessor.componentId === id, `${id.endsWith('_get') ? 'Get' : 'Set'} navigation resolves the exact accessor`);
        assert(provider.getParent(accessor).componentId === 'prop_Value',
            `${id.endsWith('_get') ? 'Get' : 'Set'} accessor reports its property as parent`);
    }

    // Regression: a Property literally NAMED "Data_get" mints id `prop_Data_get`. componentId.parse()
    // misreads that id as the Get accessor of a property named "Data" (the accessor grammar is
    // ambiguous by design — see componentId.js's header). A parse()+make() accessor lookup would
    // remint the property's OWN id here, so parsedComponents.find(...) would return the property
    // itself as its own "Get accessor" and createComponentTreeItem would recurse on itself forever.
    // The concatenative `${c.id}_get` lookup used in production code is immune: it only appends.
    const dataGetProperty = await provider.getRevealItem(fileUri, 'prop_Data_get');
    assert(dataGetProperty.componentId === 'prop_Data_get',
        'a Property literally named "Data_get" resolves to itself, not a phantom self-accessor');
    assert(dataGetProperty.collapsibleState === vscode.TreeItemCollapsibleState.None,
        'the "Data_get" property finds no real Get/Set accessors and stays a leaf (no self-recursion)');

    for (const id of ['action_Start', 'transition_Ready']) {
        const item = await provider.getRevealItem(fileUri, id);
        assert(item.componentId === id, `${id.split('_')[0]} navigation resolves the exact component`);
        assert(provider.getParent(item).folderPath === 'Steps\\',
            `${id.split('_')[0]} reports its virtual folder as parent`);
    }

    const missing = await provider.getRevealItem(fileUri, 'method_Missing');
    assert(!missing.componentId && missing.resourceUri.toString() === fileUri.toString(),
        'a stale component id conservatively falls back to the file');

    // Attached component/folder/property ancestors do not consult the project map. Only the final
    // file-to-disk ancestry lookup needs the already-cached map supplied by extension.js.
    projectMapReads = 0;
    const accessor = await provider.getRevealItem(fileUri, 'prop_Value_get');
    const propParent = provider.getParent(accessor);
    const nestedParent = provider.getParent(propParent);
    const logicParent = provider.getParent(nestedParent);
    const fileParent = provider.getParent(logicParent);
    assert(fileParent.resourceUri.toString() === fileUri.toString() && projectMapReads === 0,
        `component-to-file ancestry needs no project-map lookup (got ${projectMapReads})`);
    provider.getParent(fileParent);
    assert(projectMapReads === 1,
        `the cached project map is first consulted at the file/disk boundary (got ${projectMapReads})`);

    if (errors) process.exit(1);
    console.log('\nAll Objects-tree reveal assertions passed.');
})().catch(err => {
    console.error('[FAIL] harness crashed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
