/**
 * @file test_rename_commands.js
 * @description R7: the Objects-tree rename commands (src/commands/renameCommands.js) driven end to end
 * under a stubbed `vscode`, against a real project on disk and the REAL by-symbol reference query.
 *
 * What is pinned:
 *   - a file, member or directory rename is ONE WorkspaceEdit: every text edit (references, the
 *     `.plcproj` entry) and then the file/directory move — the shape a real VS Code records as ONE undo
 *     group (checked in VS Code 1.145: undo from a participating text editor restored text and file
 *     name together; three separate edits undid only the last);
 *   - the `.plcproj` entry is rewritten in place (its `<LinkAlways>` child survives);
 *   - a Method rename reaches the sibling implementor of the shared interface and not a POU that only
 *     shares the name; a sibling that already has a member by the new name stops it before any write;
 *   - a failed move puts every landed text edit back;
 *   - TC Toolkit: Undo Last Rename focuses a participating TEXT editor and runs `undo`, restoring every
 *     file byte for byte, and refuses once a participating file changed after the rename.
 * The stub's `undo` mirrors the VS Code behaviour measured above: it acts only when the active editor
 * is a text editor of a file in the last edit group.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_rename_cmd_'));
const PROJ = path.join(ROOT, 'Plc');
let seq = 0;
const guid = () => `{c0000000-0000-4a00-8a00-${String(++seq).padStart(12, '0')}}`;
const method = (name, body) => `
    <Method Name="${name}" Id="${guid()}">
      <Declaration><![CDATA[METHOD ${name} : BOOL
]]></Declaration>${body === null ? '' : `
      <Implementation>
        <ST><![CDATA[${body}]]></ST>
      </Implementation>`}
    </Method>`;
const pou = (name, header, members, decl, body) => `<?xml version="1.0" encoding="utf-8"?>\r
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <POU Name="${name}" Id="${guid()}" SpecialFunc="None">
    <Declaration><![CDATA[${header}
${decl || 'VAR\n\tn : INT;\nEND_VAR'}]]></Declaration>
    <Implementation>
      <ST><![CDATA[${body || 'n := n + 1;'}]]></ST>
    </Implementation>${members.join('')}
  </POU>
</TcPlcObject>`;
const files = {
    'POUs/I_Drive.TcIO': `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4026.18">
  <Itf Name="I_Drive" Id="${guid()}">
    <Declaration><![CDATA[INTERFACE I_Drive
]]></Declaration>${method('Start', null)}
  </Itf>
</TcPlcObject>`,
    'POUs/FB_A.TcPOU': pou('FB_A', 'FUNCTION_BLOCK FB_A IMPLEMENTS I_Drive', [method('Start', 'Start := TRUE;')]),
    'POUs/FB_B.TcPOU': pou('FB_B', 'FUNCTION_BLOCK FB_B IMPLEMENTS I_Drive', [method('Start', 'Start := TRUE;'), method('Run', 'Run := TRUE;')]),
    'POUs/FB_X.TcPOU': pou('FB_X', 'FUNCTION_BLOCK FB_X', [method('Start', 'Start := TRUE;')]),
    'POUs/MAIN.TcPOU': pou('MAIN', 'PROGRAM MAIN', [], 'VAR\n\tfbA : FB_A;\n\tfbB : FB_B;\n\tfbX : FB_X;\n\tb : BOOL;\nEND_VAR',
        'b := fbA.Start();\nb := fbB.Start();\nb := fbX.Start();'),
    'Plc.plcproj': [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
        '  <ItemGroup>',
        '    <Compile Include="POUs\\FB_A.TcPOU">',
        '      <SubType>Code</SubType>',
        '      <LinkAlways>true</LinkAlways>',
        '    </Compile>',
        '    <Compile Include="POUs\\FB_B.TcPOU">',
        '      <SubType>Code</SubType>',
        '    </Compile>',
        '    <Compile Include="POUs\\FB_X.TcPOU">',
        '      <SubType>Code</SubType>',
        '    </Compile>',
        '    <Compile Include="POUs\\I_Drive.TcIO">',
        '      <SubType>Code</SubType>',
        '    </Compile>',
        '    <Compile Include="POUs\\MAIN.TcPOU">',
        '      <SubType>Code</SubType>',
        '    </Compile>',
        '  </ItemGroup>',
        '  <ItemGroup>',
        '    <Folder Include="POUs" />',
        '  </ItemGroup>',
        '</Project>',
        ''
    ].join('\r\n')
};
function writeFixtures() {
    fs.rmSync(PROJ, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
        const p = path.join(PROJ, ...rel.split('/'));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text, 'utf8');
    }
}
/** Every file under the project, relative path → content. */
function snapshotDisk() {
    const out = {};
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else out[path.relative(PROJ, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
        }
    })(PROJ);
    return out;
}
const sameDisk = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── A `vscode` stub with documents, one-group workspace edits and VS Code's undo rule ──────────────
const toUriString = (p) => 'file://' + p.split(path.sep).join('/');
const mkUri = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => toUriString(p) });
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(a, b) { this.start = a; this.end = b; } }
class WorkspaceEdit {
    constructor() { this.ops = []; }
    replace(uri, range, text) { this.ops.push({ kind: 'replace', uri, text }); }
    renameFile(from, to) { this.ops.push({ kind: 'rename', from, to }); }
}
/** fsPath → document. A real VS Code keeps a model per open resource; this is that, minimally. */
const docs = new Map();
function makeDoc(p, text) {
    const doc = {
        uri: mkUri(p), text, isDirty: false,
        getText() { return this.text; },
        get lineCount() { return this.text.split('\n').length; },
        lineAt(i) { const line = this.text.split('\n')[i]; return { text: line, range: { end: new Position(i, line.length) } }; },
        async save() { fs.writeFileSync(this.uri.fsPath, this.text, 'utf8'); this.isDirty = false; return true; }
    };
    docs.set(p, doc);
    return doc;
}
const state = { applyEdits: [], errors: [], warnings: [], infos: [], status: [], executed: [], inputs: [], failMove: false, undoGroups: [] };
const vscodeStub = {
    Uri: {
        file: mkUri,
        parse: (s) => mkUri(decodeURIComponent(s.replace(/^file:\/\//, '')).split('/').join(path.sep)),
        joinPath: (base, ...parts) => mkUri(path.join(base.fsPath, ...parts))
    },
    Position, Range, WorkspaceEdit,
    FileType: { File: 1, Directory: 2 },
    workspace: {
        textDocuments: [],
        async openTextDocument(uri) {
            const p = uri.fsPath;
            if (docs.has(p)) return docs.get(p);
            return makeDoc(p, fs.readFileSync(p, 'utf8'));
        },
        async applyEdit(edit) {
            state.applyEdits.push(edit.ops.map(o => o.kind === 'replace'
                ? { kind: 'replace', file: path.relative(PROJ, o.uri.fsPath) }
                : { kind: 'rename', from: path.relative(PROJ, o.from.fsPath), to: path.relative(PROJ, o.to.fsPath) }));
            const group = { before: [], move: null };
            for (const op of edit.ops) {
                if (op.kind === 'replace') {
                    const d = docs.get(op.uri.fsPath);
                    group.before.push({ doc: d, text: d.text, dirty: d.isDirty });
                    d.text = op.text;
                    d.isDirty = true;
                } else {
                    if (state.failMove) return false;   // text edits landed, the move did not
                    fs.renameSync(op.from.fsPath, op.to.fsPath);
                    for (const [p, d] of Array.from(docs.entries())) {
                        if (p === op.from.fsPath || p.startsWith(op.from.fsPath + path.sep)) {
                            docs.delete(p);
                            d.uri = mkUri(op.to.fsPath + p.slice(op.from.fsPath.length));
                            docs.set(d.uri.fsPath, d);
                        }
                    }
                    group.move = { from: op.from.fsPath, to: op.to.fsPath };
                }
            }
            state.undoGroups.push(group);
            return true;
        },
        fs: {
            async stat(uri) { if (!fs.existsSync(uri.fsPath)) throw new Error('ENOENT'); return {}; },
            async readDirectory(uri) {
                return fs.readdirSync(uri.fsPath, { withFileTypes: true }).map(e => [e.name, e.isDirectory() ? 2 : 1]);
            }
        }
    },
    window: {
        activeTextEditor: undefined,
        visibleTextEditors: [],
        async showInputBox(opts) {
            const v = state.inputs.shift();
            state.lastValidation = v === undefined ? null : opts.validateInput(v);
            return state.lastValidation ? undefined : v;
        },
        async showWarningMessage(m, opts, ...buttons) { state.warnings.push(m); return buttons.find(b => /^Rename and update/.test(b)); },
        async showErrorMessage(m) { state.errors.push(m); },
        async showInformationMessage(m) { state.infos.push(m); },
        setStatusBarMessage(m) { state.status.push(m); },
        async showTextDocument(doc) {
            const editor = { document: doc };
            vscodeStub.window.activeTextEditor = editor;
            vscodeStub.window.visibleTextEditors = [editor];
            return editor;
        }
    },
    commands: {
        handlers: new Map(),
        registerCommand(id, fn) { this.handlers.set(id, fn); return { dispose() {} }; },
        async executeCommand(id, ...args) {
            state.executed.push(id);
            if (id === 'undo') return stubUndo();
            if (id === 'workbench.action.closeActiveEditor') { vscodeStub.window.activeTextEditor = undefined; vscodeStub.window.visibleTextEditors = []; return; }
            const h = this.handlers.get(id);
            return h ? h(...args) : undefined;
        }
    }
};
/** VS Code's rule, as measured: `undo` reaches a workspace edit only from a text editor of one of its files. */
function stubUndo() {
    const editor = vscodeStub.window.activeTextEditor;
    const group = state.undoGroups[state.undoGroups.length - 1];
    if (!editor || !group || !group.before.some(b => b.doc === editor.document)) return;
    state.undoGroups.pop();
    if (group.move) {
        fs.renameSync(group.move.to, group.move.from);
        for (const [p, d] of Array.from(docs.entries())) {
            if (p === group.move.to || p.startsWith(group.move.to + path.sep)) {
                docs.delete(p);
                d.uri = mkUri(group.move.from + p.slice(group.move.to.length));
                docs.set(d.uri.fsPath, d);
            }
        }
    }
    for (const b of group.before.slice().reverse()) { b.doc.text = b.text; b.doc.isDirty = true; }
}
const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.apply(this, arguments);
};

const { registerRenameCommands } = require('../src/commands/renameCommands');
const { indexXmlFile } = require('../src/lsp/xmlIndexer');
const { provideReferencesForSymbol } = require('../src/lsp/features');
const { parseTwinCatXml } = require('../src/xmlParser');

// The LSP client: a fresh index of the project on disk per query, through the production path.
const client = {
    async sendRequest(request, spec) {
        if (request !== 'custom/referencesForSymbol') return { resolved: true, occurrences: [] };
        const index = {};
        (function walk(dir) {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.Tc(POU|IO|GVL|DUT)$/.test(e.name)) indexXmlFile(index, p);
            }
        })(PROJ);
        return provideReferencesForSymbol(spec, index);
    }
};
const readXmlText = async (uri) => (await vscodeStub.workspace.openTextDocument(uri)).getText();
const writeXmlText = async (uri, text) => {
    const d = await vscodeStub.workspace.openTextDocument(uri);
    if (d.text === text) return;
    d.text = text;
    await d.save();
};
registerRenameCommands({ subscriptions: [] }, {
    treeView: { selection: [] },
    treeProvider: { refresh() {} },
    applyXmlEdit: async (uri, modify) => writeXmlText(uri, modify(await readXmlText(uri))),
    readXmlText, writeXmlText,
    getClient: () => client
});
const run = (id, ...args) => vscodeStub.commands.executeCommand(id, ...args);
function reset() {
    docs.clear();
    state.applyEdits = []; state.errors = []; state.warnings = []; state.infos = []; state.status = []; state.executed = [];
    state.inputs = []; state.failMove = false; state.undoGroups = [];
    vscodeStub.window.activeTextEditor = undefined;
    vscodeStub.window.visibleTextEditors = [];
    writeFixtures();
}
const P = (rel) => path.join(PROJ, ...rel.split('/'));
const methodNode = (rel, name) => {
    const comp = parseTwinCatXml(fs.readFileSync(P(rel), 'utf8')).components.find(c => c.xmlContext.subType === 'Method' && c.xmlContext.subName === name);
    return { contextValue: 'component', resourceUri: mkUri(P(rel)), componentId: comp.id };
};
const dirty = () => Array.from(docs.values()).filter(d => d.isDirty).map(d => path.relative(PROJ, d.uri.fsPath));

async function main() {
    // ── 1. File rename with reference updates ──
    console.log('\n--- file rename: FB_A -> FB_Axis ---');
    reset();
    const before = snapshotDisk();
    state.inputs.push('FB_Axis');
    await run('twincat.renameObject', { contextValue: 'pouFile', resourceUri: mkUri(P('POUs/FB_A.TcPOU')) });
    assert(state.errors.length === 0, `no error (got ${JSON.stringify(state.errors)})`);
    assert(state.applyEdits.length === 1, `ONE WorkspaceEdit (got ${state.applyEdits.length})`);
    const ops = state.applyEdits[0] || [];
    const last = ops[ops.length - 1] || {};
    assert(last.kind === 'rename' && last.from === path.join('POUs', 'FB_A.TcPOU') && last.to === path.join('POUs', 'FB_Axis.TcPOU'),
        'the file move is the LAST operation of that edit');
    assert(ops.some(o => o.kind === 'replace' && o.file === 'Plc.plcproj'), 'the .plcproj edit is inside the same WorkspaceEdit');
    assert(ops.some(o => o.kind === 'replace' && o.file === path.join('POUs', 'MAIN.TcPOU')), 'the reference edit in MAIN is inside it');
    let after = snapshotDisk();
    assert(!after['POUs/FB_A.TcPOU'] && /<POU Name="FB_Axis"/.test(after['POUs/FB_Axis.TcPOU'] || ''), 'disk: the file and its root object are renamed');
    assert(/fbA : FB_Axis;/.test(after['POUs/MAIN.TcPOU']), 'disk: MAIN declares fbA : FB_Axis');
    assert(after['Plc.plcproj'] === before['Plc.plcproj'].replace('POUs\\FB_A.TcPOU', 'POUs\\FB_Axis.TcPOU'),
        'disk: the .plcproj changed ONLY in that Include value (entry kept in place with <LinkAlways>)');
    assert(dirty().length === 0, `every edited document was saved (dirty: ${dirty()})`);

    console.log('\n--- Undo Last Rename (file) ---');
    await run('twincat.undoLastRename');
    assert(state.executed.includes('undo'), 'it ran VS Code\'s undo');
    after = snapshotDisk();
    assert(sameDisk(after, before), 'undo restored every file byte for byte, the file name included');
    assert(dirty().length === 0, 'undo saved what it restored');
    await run('twincat.undoLastRename');
    assert(state.infos.some(m => /no rename to undo/.test(m)), 'a second Undo Last Rename has nothing to undo');

    // ── 2. Interface method: sibling implementor, not the name-alike ──
    console.log('\n--- member rename: FB_A.Start -> Begin ---');
    reset();
    const before2 = snapshotDisk();
    state.inputs.push('Begin');
    await run('twincat.renameObject', methodNode('POUs/FB_A.TcPOU', 'Start'));
    assert(state.errors.length === 0, `no error (got ${JSON.stringify(state.errors)})`);
    assert(state.applyEdits.length === 1 && !state.applyEdits[0].some(o => o.kind === 'rename'), 'ONE WorkspaceEdit, no move');
    after = snapshotDisk();
    assert(/<Method Name="Begin"/.test(after['POUs/FB_B.TcPOU']) && /METHOD Begin : BOOL/.test(after['POUs/FB_B.TcPOU']),
        'the sibling implementor FB_B.Start is renamed');
    assert(/<Method Name="Begin"/.test(after['POUs/I_Drive.TcIO']), 'the interface method is renamed');
    assert(after['POUs/FB_X.TcPOU'] === before2['POUs/FB_X.TcPOU'], 'FB_X (shares only the name) is byte-identical');
    assert(/b := fbA\.Begin\(\);\nb := fbB\.Begin\(\);\nb := fbX\.Start\(\);/.test(after['POUs/MAIN.TcPOU']), 'MAIN: fbA and fbB calls renamed, fbX left');
    assert(after['Plc.plcproj'] === before2['Plc.plcproj'], 'a member rename does not touch the .plcproj');
    await run('twincat.undoLastRename');
    assert(sameDisk(snapshotDisk(), before2), 'undo restored all four files byte for byte');

    // ── 3. A sibling that already has the new name stops the rename before any write ──
    console.log('\n--- member rename into a sibling\'s existing name ---');
    reset();
    const before3 = snapshotDisk();
    state.inputs.push('Run');
    await run('twincat.renameObject', methodNode('POUs/FB_A.TcPOU', 'Start'));
    assert(state.errors.some(m => /"Run" already exists in FB_B/.test(m)), `refused, naming FB_B (got ${JSON.stringify(state.errors)})`);
    assert(state.applyEdits.length === 0 && sameDisk(snapshotDisk(), before3), 'nothing was written');

    // ── 4. A failed move puts the landed text edits back ──
    console.log('\n--- failed move ---');
    reset();
    const before4 = snapshotDisk();
    state.failMove = true;
    state.inputs.push('FB_Axis');
    await run('twincat.renameObject', { contextValue: 'pouFile', resourceUri: mkUri(P('POUs/FB_A.TcPOU')) });
    assert(state.errors.some(m => /aborted: VS Code did not apply it/.test(m)), `reported (got ${JSON.stringify(state.errors)})`);
    assert(sameDisk(snapshotDisk(), before4), 'disk unchanged');
    const buffersBack = Array.from(docs.values()).every(d => d.text === before4[path.relative(PROJ, d.uri.fsPath).split(path.sep).join('/')]);
    assert(buffersBack, 'every document buffer holds its original text again');
    await run('twincat.undoLastRename');
    assert(state.infos.some(m => /no rename to undo/.test(m)), 'a failed rename leaves nothing to undo');

    // ── 5. Undo is refused once a participant changed ──
    console.log('\n--- Undo Last Rename after a later edit ---');
    reset();
    state.inputs.push('FB_Axis');
    await run('twincat.renameObject', { contextValue: 'pouFile', resourceUri: mkUri(P('POUs/FB_A.TcPOU')) });
    const mainDoc = docs.get(P('POUs/MAIN.TcPOU'));
    mainDoc.text += '\n(* later *)';
    const before5 = snapshotDisk();
    await run('twincat.undoLastRename');
    assert(state.warnings.some(m => /Cannot undo the rename .*changed after it/.test(m)), 'refused with the reason');
    assert(!state.executed.includes('undo') && sameDisk(snapshotDisk(), before5), 'undo was not run; nothing changed');

    // ── 6. Directory rename ──
    console.log('\n--- directory rename: POUs -> Code ---');
    reset();
    const before6 = snapshotDisk();
    state.inputs.push('Code');
    await run('twincat.renameObject', { contextValue: 'directory', resourceUri: mkUri(P('POUs')) });
    assert(state.applyEdits.length === 1, 'ONE WorkspaceEdit');
    const ops6 = state.applyEdits[0] || [];
    assert(ops6.length === 2 && ops6[0].file === 'Plc.plcproj' && ops6[1].kind === 'rename', '.plcproj edit, then the directory move');
    after = snapshotDisk();
    assert(after['Plc.plcproj'] === before6['Plc.plcproj'].split('Include="POUs').join('Include="Code'),
        'every POUs entry is rewritten in place, nothing else');
    assert(after['Code/FB_A.TcPOU'] === before6['POUs/FB_A.TcPOU'], 'the directory moved with its files untouched');
    await run('twincat.undoLastRename');
    assert(sameDisk(snapshotDisk(), before6), 'undo restored the directory and the .plcproj');

    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(errors === 0 ? '\nAll rename-command checks passed.' : `\n${errors} failure(s)`);
    process.exit(errors > 0 ? 1 : 0);
}

main().catch(e => { console.error('[FAIL] harness crashed:', e); process.exit(1); });
