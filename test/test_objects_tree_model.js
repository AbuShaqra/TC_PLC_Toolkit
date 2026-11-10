/**
 * @file test_objects_tree_model.js
 * @description src/objectsTreeModel.js on its own, with an in-memory host and no `vscode` stub.
 *
 * Pins the tree's shape rule (solutions → projects; one root per PLC project when there are two or
 * more; otherwise the flat directory tree), the single place ids and contextValues are assigned, the
 * file and member rows (icons, virtual folders, property accessors and their `.noGet/.noSet`
 * contextValue), the directory listing rules, and the parent links reveal walks. The ids the
 * extension really renders on the sample are pinned separately, through the adapter, in
 * test_objects_tree_ids.js.
 */

const path = require('path');
const fs = require('fs');
const {
    createObjectsTreeModel, groupRootsByProject, makeNode, nodeId, classifyFile, ENTRY_TYPE
} = require('../src/objectsTreeModel');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ── an in-memory workspace ────────────────────────────────────────────────────────────────────────
const uriFor = (fsPath) => ({
    fsPath,
    toString: () => 'file:///' + fsPath.replace(/\\/g, '/').replace(/^\/+/, '')
});

const pou = (decl, members = '') => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="X" Id="{00000000-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[${decl}
]]></Declaration>
    <Implementation><ST><![CDATA[]]></ST></Implementation>
${members}
  </POU>
</TcPlcObject>`;
const method = (name, folder = '') => `    <Method Name="${name}" Id="{00000000-0000-0000-0000-0000000000${(name.length + 10)}}"${folder ? ` FolderPath="${folder}"` : ''}>
      <Declaration><![CDATA[METHOD ${name}
]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
    </Method>`;
const property = (name, get, set) => `    <Property Name="${name}" Id="{00000000-0000-0000-0000-000000000099}">
      <Declaration><![CDATA[PROPERTY ${name} : INT
]]></Declaration>
${get ? `      <Get Name="Get" Id="{00000000-0000-0000-0000-000000000098}">
        <Declaration><![CDATA[]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
      </Get>` : ''}
${set ? `      <Set Name="Set" Id="{00000000-0000-0000-0000-000000000097}">
        <Declaration><![CDATA[]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
      </Set>` : ''}
    </Property>`;
const itf = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <Itf Name="I_X" Id="{00000000-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[INTERFACE I_X
]]></Declaration>
    <Folder Name="Api" Id="{00000000-0000-0000-0000-000000000002}" />
${method('Go', 'Api\\')}
  </Itf>
</TcPlcObject>`;
const dut = (decl) => `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <DUT Name="D" Id="{00000000-0000-0000-0000-000000000001}">
    <Declaration><![CDATA[${decl}
]]></Declaration>
  </DUT>
</TcPlcObject>`;

const ROOT = path.resolve('/objects-tree-model-ws');
const P = (...parts) => path.join(ROOT, ...parts);
/** Absolute path → file text. Directories are implied by the paths. */
const FILES = {
    [P('LineA', 'PLC', 'POUs', 'FB_Motor.TcPOU')]: pou('FUNCTION_BLOCK FB_Motor', [
        '    <Folder Name="Zeta" Id="{00000000-0000-0000-0000-000000000003}" />',
        '    <Folder Name="Alpha" Id="{00000000-0000-0000-0000-000000000004}" />',
        method('Run', 'Alpha\\'), method('Beta'), method('Abort'),
        property('Both', true, true)
    ].join('\n')),
    [P('LineA', 'PLC', 'POUs', 'MAIN.TcPOU')]: pou('PROGRAM MAIN', [
        '    <Folder Name="Steps" Id="{00000000-0000-0000-0000-000000000005}" />',
        property('OnlyGet', true, false), property('OnlySet', false, true), property('Neither', false, false)
    ].join('\n')),
    [P('LineA', 'PLC', 'POUs', 'F_Add.TcPOU')]: pou('FUNCTION F_Add : INT', method('Ignored')),
    [P('LineA', 'PLC', 'POUs', 'FB_Empty.TcPOU')]: pou('FUNCTION_BLOCK FB_Empty'),
    [P('LineA', 'PLC', 'POUs', 'I_X.TcIO')]: itf,
    [P('LineA', 'PLC', 'DUTs', 'E_Mode.TcDUT')]: dut('TYPE E_Mode : (A, B); END_TYPE'),
    [P('LineA', 'PLC', 'DUTs', 'ST_Data.TcDUT')]: dut('TYPE ST_Data : STRUCT a : INT; END_STRUCT END_TYPE'),
    [P('LineA', 'PLC', 'GVLs', 'GVL_Main.TcGVL')]: '<TcPlcObject/>',
    [P('LineA', 'PLC', 'Text.st')]: 'PROGRAM X END_PROGRAM',
    [P('LineA', 'PLC', 'PLC.plcproj')]: '<Project/>',
    [P('LineA', 'PLC', 'Notes.txt')]: 'not shown',
    [P('LineA', 'PLC', '.git', 'HEAD')]: 'skipped dir',
    // Generate ST output: a project's own ST_Files is listed, read-only (no TwinCAT objects in it).
    [P('LineA', 'PLC', 'ST_Files', 'POUs', 'MAIN.st')]: 'PROGRAM MAIN END_PROGRAM',
    [P('LineA', 'PLC', 'ST_Files', 'Stray.TcPOU')]: pou('PROGRAM Stray'),
    [P('LineA', 'PLC', 'POUs', 'ST_Files', 'Nested.st')]: 'PROGRAM N END_PROGRAM',
    [P('LineB', 'PLC', 'POUs', 'MAIN.TcPOU')]: pou('PROGRAM MAIN')
};

let readDirectoryCalls = 0;
const host = {
    uriForPath: uriFor,
    joinPath: (base, name) => uriFor(path.join(base.fsPath, name)),
    readDirectory: async (dir) => {
        readDirectoryCalls++;
        const prefix = dir.fsPath + path.sep;
        const names = new Map();
        for (const f of Object.keys(FILES)) {
            if (!f.startsWith(prefix)) continue;
            const rest = f.slice(prefix.length).split(path.sep);
            names.set(rest[0], rest.length > 1 ? ENTRY_TYPE.Directory : ENTRY_TYPE.File);
        }
        // A symlinked directory reports Directory | SymbolicLink (66), and the tree never showed one.
        if (dir.fsPath === P('LineA', 'PLC')) names.set('Linked', 66);
        if (names.size === 0 && !Object.keys(FILES).some(f => f.startsWith(prefix))) throw new Error('ENOENT ' + dir.fsPath);
        return Array.from(names.entries());
    },
    readFileText: async (file) => FILES[file.fsPath],
    readDocumentText: async (file) => FILES[file.fsPath]
};

const project = (name, dir) => ({ key: name.toLowerCase() + '|' + dir, name, dir });
const projA = project('PLC', P('LineA', 'PLC'));
const projB = project('PLC', P('LineB', 'PLC'));
const projectMapOf = (projects, names) => ({
    projects: new Map(projects.map(p => [p.key, p])),
    displayName: (key) => names[key] || key
});
const twoProjects = projectMapOf([projA, projB], { [projA.key]: 'PLC — LineA', [projB.key]: 'PLC — LineB' });
const oneProject = projectMapOf([projA], { [projA.key]: 'PLC' });

const labels = (nodes) => nodes.map(n => n.label).join(',');

(async () => {
    // ── 1. no vscode anywhere in the model's require graph ───────────────────────────────────────
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'objectsTreeModel.js'), 'utf8');
    assert(!/require\(['"]vscode['"]\)/.test(src), 'MODEL: src/objectsTreeModel.js does not require vscode');
    assert(!Object.keys(require.cache).some(k => /[\\/]vscode[\\/]|^vscode$/.test(k)),
        'MODEL: loading the model pulled no vscode module into the require cache');

    // ── 2. ids and contextValues: one assignment site, the historical formulas ───────────────────
    const fileUri = uriFor(P('LineA', 'PLC', 'POUs', 'FB_Motor.TcPOU'));
    const u = fileUri.toString();
    assert(nodeId('solution', fileUri, { label: 'S' }) === u + '#solution', 'ID: solution is <uri>#solution');
    assert(nodeId('component', fileUri, { componentId: 'method_Run', label: 'Run' }) === u + '#method_Run',
        'ID: component is <uri>#<componentId>');
    assert(nodeId('virtualFolder', fileUri, { folderPath: 'A\\B\\', label: 'B' }) === u + '#folder#A\\B\\',
        'ID: virtual folder is <uri>#folder#<folderPath>');
    for (const kind of ['project', 'directory', 'file']) {
        assert(nodeId(kind, fileUri, { label: 'x' }) === u, `ID: ${kind} is the bare uri`);
    }
    const cvOf = (kind, facts) => makeNode({ kind, label: 'x', resourceUri: fileUri, facts }).contextValue;
    assert(cvOf('solution') === 'solution' && cvOf('project') === 'directory' && cvOf('directory') === 'directory',
        'CTX: solution / project / directory');
    assert(cvOf('virtualFolder', { fileContext: 'pouFile' }) === 'pouVirtualFolder'
        && cvOf('virtualFolder', { fileContext: 'pouFileProgram' }) === 'pouVirtualFolderProgram'
        && cvOf('virtualFolder', { fileContext: 'itfFile' }) === 'pouVirtualFolderInterface',
    'CTX: a virtual folder takes its file kind');
    assert(cvOf('component', { type: 'Method' }) === 'component' && cvOf('component', { type: 'Get' }) === 'component',
        'CTX: methods and accessors are plain component rows');
    let threw = false;
    try { makeNode({ kind: /** @type {any} */ ('bogus'), label: 'x', resourceUri: fileUri }); } catch (e) { threw = true; }
    assert(threw, 'CTX: an unknown node kind is an error, not a silent undefined contextValue');

    // Only makeNode assigns them: no other `contextValue =` / `id =` / `.id =` in the model.
    const assignments = src.split('\n')
        .filter(l => /\bcontextValue\s*[:=](?!=)|^\s*id\s*[:=](?!=)|\.id\s*=(?!=)/.test(l) && !/^\s*(\*|\/\/)/.test(l));
    assert(assignments.length === 2 && assignments.every(l => /contextValue: contextValueOf|id: nodeId/.test(l)),
        `CTX: makeNode is the single assignment site (${assignments.map(l => l.trim()).join(' | ')})`);

    // ── 3. file classification ───────────────────────────────────────────────────────────────────
    const cls = (name, decl, hasChildren = true) => classifyFile(name, { declaration: decl, hasChildren });
    assert(cls('a.TcPOU', 'FUNCTION_BLOCK A').fileContext === 'pouFile', 'FILE: function block → pouFile');
    assert(cls('a.TcPOU', 'PROGRAM A').fileContext === 'pouFileProgram', 'FILE: program → pouFileProgram');
    const fn = cls('a.TcPOU', 'FUNCTION A : INT');
    assert(fn.fileContext === 'pouFileFunction' && fn.collapsible === 'none', 'FILE: a function never expands');
    assert(cls('a.TcPOU', 'FUNCTION_BLOCK A', false).collapsible === 'none', 'FILE: a POU with no members is a leaf');
    assert(cls('a.TcIO', '').fileContext === 'itfFile' && cls('a.TcIO', '').collapsible === 'collapsed', 'FILE: interface');
    assert(cls('a.TcDUT', 'TYPE A : (X); END_TYPE').fileContext === 'dutFile', 'FILE: DUT');
    assert(cls('a.TcGVL', '').fileContext === 'gvlFile' && cls('a.st', '').fileContext === 'stFile', 'FILE: GVL and .st');
    assert(cls('a.txt', '') === null && cls('a.TcTTO', '') === null, 'FILE: other files are not shown');

    // ── 4. shape rule ────────────────────────────────────────────────────────────────────────────
    assert(groupRootsByProject(null).length === 0 && groupRootsByProject(oneProject).length === 0,
        'SHAPE: fewer than two projects → no groups');
    assert(labels(groupRootsByProject(twoProjects).map(g => ({ label: g.name }))) === 'PLC — LineA,PLC — LineB',
        'SHAPE: two projects → one group each, sorted by display name');

    const ws = [uriFor(ROOT)];
    const flat = createObjectsTreeModel({ host, workspaceFolders: ws, projectMap: oneProject, solutionMap: null });
    assert(flat.isFlat && flat.roots === null, 'SHAPE: one project, no solution → flat');
    assert(labels(await flat.childrenOf(null)) === 'LineA,LineB', 'SHAPE: the flat tree lists the workspace folder');
    assert(createObjectsTreeModel({ host, workspaceFolders: ws }).isFlat, 'SHAPE: no project map → flat');

    const grouped = createObjectsTreeModel({ host, workspaceFolders: ws, projectMap: twoProjects, solutionMap: null });
    const groupRoots = await grouped.childrenOf(null);
    assert(!grouped.isFlat && labels(groupRoots) === 'PLC — LineA,PLC — LineB'
        && groupRoots.every(n => n.kind === 'project' && n.parent === null && n.contextValue === 'directory'
            && n.collapsible === 'expanded' && n.icon.id === 'circuit-board'),
    'SHAPE: two projects → project roots');

    const solution = {
        key: 'sln', displayName: 'Line', slnPath: P('LineA', 'Line.sln'),
        projects: [{ ...projA, displayName: 'PLC' }]
    };
    const solutionMap = { solutions: [solution], orphanProjects: [{ ...projB, displayName: 'PLC — LineB' }] };
    const withSln = createObjectsTreeModel({ host, workspaceFolders: ws, projectMap: twoProjects, solutionMap });
    const slnRoots = await withSln.childrenOf(null);
    assert(labels(slnRoots) === 'Line,PLC — LineB' && slnRoots[0].contextValue === 'solution'
        && slnRoots[0].id === uriFor(solution.slnPath).toString() + '#solution' && slnRoots[0].solutionKey === 'sln',
    'SHAPE: solutions first, then orphan projects');
    const slnChildren = await withSln.childrenOf(slnRoots[0]);
    assert(labels(slnChildren) === 'PLC' && slnChildren[0].parent === slnRoots[0] && slnChildren[0].projectKey === projA.key,
        'SHAPE: a solution lists its projects, which point back to it');
    assert(slnRoots[1].parent === null, 'SHAPE: an orphan project is a root');
    const emptySln = createObjectsTreeModel({ host, workspaceFolders: ws, projectMap: oneProject,
        solutionMap: { solutions: [{ ...solution, projects: [] }], orphanProjects: [] } });
    assert(emptySln.roots[0].collapsible === 'none', 'SHAPE: a solution with no projects does not expand');

    // ── 5. directory listing ─────────────────────────────────────────────────────────────────────
    const projectRow = groupRoots[0];
    const plcRows = await grouped.childrenOf(projectRow);
    assert(labels(plcRows) === 'DUTs,GVLs,POUs,ST_Files,Text.st',
        `DIR: directories first, then shown files; .git, symlinked dirs and other files are skipped (${labels(plcRows)})`);
    assert(plcRows.every(n => n.parent === projectRow) && projectRow.children === plcRows,
        'DIR: listed rows point at the row that listed them');
    const pous = await grouped.childrenOf(plcRows.find(n => n.label === 'POUs'));
    assert(labels(pous) === 'ST_Files,F_Add.TcPOU,FB_Empty.TcPOU,FB_Motor.TcPOU,I_X.TcIO,MAIN.TcPOU', `DIR: files sorted by name (${labels(pous)})`);
    const nestedSt = pous.find(n => n.label === 'ST_Files');
    assert(!!nestedSt && nestedSt.contextValue === 'directory',
        `DIR: an ST_Files folder that is NOT directly in a project directory is an ordinary folder (${nestedSt && nestedSt.contextValue})`);
    const byName = Object.fromEntries(pous.map(n => [n.label, n]));
    assert(byName['F_Add.TcPOU'].contextValue === 'pouFileFunction' && byName['F_Add.TcPOU'].icon.id === 'symbol-operator',
        'DIR: a function file has the function icon');
    assert(byName['FB_Empty.TcPOU'].collapsible === 'none' && byName['FB_Motor.TcPOU'].collapsible === 'collapsed',
        'DIR: only a POU with members expands');
    assert(byName['FB_Motor.TcPOU'].opens === 'root' && byName['FB_Motor.TcPOU'].tooltip === 'Function Block — FB_Motor.TcPOU',
        'DIR: a file row opens its root and names its kind');
    assert(byName['MAIN.TcPOU'].contextValue === 'pouFileProgram', 'DIR: a program file');
    const duts = await grouped.childrenOf(plcRows.find(n => n.label === 'DUTs'));
    assert(duts.every(n => n.contextValue === 'dutFile') && duts[0].icon.id !== duts[1].icon.id,
        'DIR: DUT rows get their kind-specific icons');
    // A project's own ST_Files (Generate ST output) is listed, but nothing in it takes a TwinCAT command:
    // its rows have their own contextValues, which no menu, paste or drag rule names.
    const out = plcRows.find(n => n.label === 'ST_Files');
    assert(!!out && out.contextValue === 'generatedDirectory' && out.collapsible === 'collapsed' && out.icon.id === 'folder' && out.opens === null,
        `DIR: a project's own ST_Files is listed as generated output (${out && out.contextValue})`);
    const outRows = await grouped.childrenOf(out);
    assert(labels(outRows) === 'POUs', `DIR: inside ST_Files only folders and .st files are listed, not stray TwinCAT files (${labels(outRows)})`);
    assert(outRows[0].contextValue === 'generatedDirectory', 'DIR: a folder below ST_Files is generated output too');
    const outFiles = await grouped.childrenOf(outRows[0]);
    assert(outFiles.length === 1 && outFiles[0].label === 'MAIN.st' && outFiles[0].contextValue === 'generatedStFile'
        && outFiles[0].opens === 'root' && outFiles[0].collapsible === 'none' && /^Generated Structured Text/.test(outFiles[0].tooltip),
        `DIR: a generated .st is a read-only row that opens as text (${outFiles[0] && outFiles[0].contextValue})`);
    const plain = plcRows.find(n => n.label === 'Text.st');
    assert(!!plain && plain.contextValue === 'stFile', 'DIR: a .st outside ST_Files keeps the ordinary stFile row');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const menuText = JSON.stringify(pkg.contributes.menus);
    assert(!/generatedDirectory|generatedStFile/.test(menuText) && !/viewItem =~ \/[^/]*(directory|stFile)/.test(menuText),
        'DIR: no context-menu entry matches the generated rows (every menu tests exact contextValues)');
    const { describeDragged, describeCopied } = require('../src/dndRules');
    assert(describeDragged(out) === null && describeDragged(outFiles[0]) === null
        && describeCopied(out) === null && describeCopied(outFiles[0]) === null,
        'DIR: generated rows can be neither dragged nor copied');
    const before = readDirectoryCalls;
    const again = await grouped.childrenOf(projectRow);
    assert(readDirectoryCalls === before + 1 && again !== plcRows, 'DIR: children are re-read on every expansion');
    const quietError = console.error;
    console.error = () => {}; // the model logs the read failure; expected here
    const unreadable = await grouped.childrenOf(uriAsDirectory(P('Nope')));
    console.error = quietError;
    assert(unreadable.length === 0, 'DIR: an unreadable directory lists nothing');

    // ── 6. members: virtual folders, components, property accessors ──────────────────────────────
    const motor = byName['FB_Motor.TcPOU'];
    const members = await grouped.childrenOf(motor);
    assert(labels(members) === 'Alpha,Zeta,Abort,Beta,Both (Property Signature)', `MEMBERS: folders first, then components, each sorted (${labels(members)})`);
    const alpha = members[0];
    assert(alpha.contextValue === 'pouVirtualFolder' && alpha.folderPath === 'Alpha\\' && alpha.parent === motor
        && alpha.id === motor.resourceUri.toString() + '#folder#Alpha\\', 'MEMBERS: a virtual folder row');
    assert(labels(alpha.children) === 'Run' && alpha.children[0].parent === alpha && alpha.children[0].folderPath === 'Alpha\\',
        'MEMBERS: a component sits in its virtual folder');
    assert((await grouped.childrenOf(alpha)) === alpha.children, 'MEMBERS: a virtual folder answers with its children');
    const both = members.find(n => n.componentId === 'prop_Both');
    assert(both.contextValue === 'propertyNode' && both.collapsible === 'collapsed'
        && both.children.map(c => c.componentId).join(',') === 'prop_Both_get,prop_Both_set'
        && both.children.every(c => c.parent === both && c.contextValue === 'component'),
    'MEMBERS: a property lists its Get and Set under it');
    const abort = members.find(n => n.componentId === 'method_Abort');
    assert(abort.opens === 'method_Abort' && abort.componentId === 'method_Abort' && abort.folderPath === ''
        && abort.id === motor.resourceUri.toString() + '#method_Abort', 'MEMBERS: a method row');

    const main = await grouped.childrenOf(byName['MAIN.TcPOU']);
    const cvByLabel = Object.fromEntries(main.map(n => [n.label, n.contextValue]));
    assert(cvByLabel.Steps === 'pouVirtualFolderProgram', 'MEMBERS: a program\'s folder is pouVirtualFolderProgram');
    const prop = (name) => main.find(n => n.componentId === 'prop_' + name);
    assert(prop('OnlyGet').contextValue === 'propertyNode.noSet' && prop('OnlySet').contextValue === 'propertyNode.noGet'
        && prop('Neither').contextValue === 'propertyNode.noGet.noSet' && prop('Neither').collapsible === 'none',
    'MEMBERS: a property\'s contextValue names the accessors it is missing');
    assert(['OnlyGet', 'OnlySet', 'Neither'].every(n => prop(n).id === byName['MAIN.TcPOU'].resourceUri.toString() + '#prop_' + n),
        'MEMBERS: the property id does not depend on its accessors');
    const itfRows = await grouped.childrenOf(byName['I_X.TcIO']);
    assert(itfRows[0].contextValue === 'pouVirtualFolderInterface', 'MEMBERS: an interface\'s folder is pouVirtualFolderInterface');
    assert((await grouped.childrenOf(byName['F_Add.TcPOU'])).length === 0, 'MEMBERS: a function file lists nothing');

    // ── 7. reveal: the target's ancestry is attached and matches the tree ─────────────────────────
    const runUri = uriFor(P('LineA', 'PLC', 'POUs', 'FB_Motor.TcPOU'));
    const run = await grouped.revealTarget(runUri, 'method_Run');
    const chain = [];
    for (let n = run.parent; n; n = n.parent) chain.push(n);
    assert(chain.map(n => n.id).join('\n') === [alpha.id, motor.id, pous[0].parent.id, projectRow.id].join('\n'),
        'REVEAL: method → folder → file → POUs → project, by id');
    // Behaviour fix, pinned: the provider used to rebuild the project ancestor from the project
    // map's bare name ("PLC") while getChildren showed the disambiguated "PLC — LineA". The reveal
    // ancestor is now the tree's own project row: same object, so same id AND same label.
    const projectAncestor = chain[chain.length - 1];
    assert(projectAncestor === projectRow && projectAncestor.label === 'PLC — LineA' && projectAncestor.id === projectRow.id,
        `REVEAL: the project ancestor is the getChildren row, label "${projectAncestor.label}" (was the bare "PLC")`);
    const slnReveal = await withSln.revealTarget(runUri, 'root');
    const slnChain = [];
    for (let n = slnReveal.parent; n; n = n.parent) slnChain.push(n);
    assert(slnChain[slnChain.length - 1] === slnRoots[0] && slnChain[slnChain.length - 2] === slnChildren[0],
        'REVEAL: under a solution, the chain ends in the tree\'s solution and project rows');

    const flatReveal = await flat.revealTarget(runUri, 'root');
    const flatChain = [];
    for (let n = flatReveal.parent; n; n = n.parent) flatChain.push(n.label);
    assert(flatChain.join('<') === 'POUs<PLC<LineA', `REVEAL: the flat tree stops below the workspace root (${flatChain.join('<')})`);
    assert(flatReveal.contextValue === 'pouFile' && flatReveal.opens === null && flatReveal.icon === null,
        'REVEAL: the file row is built from the extension alone');

    const outside = await flat.revealTarget(uriFor(path.resolve('/elsewhere/deep/X.TcPOU')), 'root');
    let depth = 0;
    for (let n = outside.parent; n; n = n.parent) depth++;
    assert(outside.parent !== undefined && depth < 10, 'REVEAL: a file outside the workspace still ends its chain');

    const accessor = await grouped.revealTarget(uriFor(P('LineA', 'PLC', 'POUs', 'MAIN.TcPOU')), 'prop_OnlyGet_get');
    assert(accessor.componentId === 'prop_OnlyGet_get' && accessor.parent.componentId === 'prop_OnlyGet',
        'REVEAL: an accessor reveals under its property');
    const stale = await grouped.revealTarget(runUri, 'method_Gone');
    assert(stale.kind === 'file' && stale.id === motor.id, 'REVEAL: a stale component id falls back to the file');
    const gvl = await grouped.revealTarget(uriFor(P('LineA', 'PLC', 'GVLs', 'GVL_Main.TcGVL')), 'anything');
    assert(gvl.contextValue === 'gvlFile' && gvl.collapsible === 'none', 'REVEAL: a non-expandable file reveals itself');
    assert(grouped.projectNodeForDir(uriFor(projA.dir)) === projectRow && flat.projectNodeForDir(uriFor(projA.dir)) === null,
        'REVEAL: project rows are indexed by directory only when the tree shows projects');

    if (errors) {
        console.error(`\n${errors} Objects-tree model assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll Objects-tree model assertions passed.');
})().catch(err => {
    console.error('[FAIL] harness crashed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});

/**
 * A directory row for a path that does not exist, to exercise the read-failure path.
 * @param {string} fsPath
 */
function uriAsDirectory(fsPath) {
    return makeNode({ kind: 'directory', label: path.basename(fsPath), resourceUri: uriFor(fsPath) });
}
