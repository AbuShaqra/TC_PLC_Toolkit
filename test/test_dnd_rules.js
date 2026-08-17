/**
 * @file test_dnd_rules.js
 * @description The drag & drop AND copy/paste compatibility matrices (src/dndRules.js) over fake
 * tree items. The matrices are the ONLY place that decides whether a drop or a paste is legal —
 * the vscode-bound controllers (src/treeDragAndDrop.js, src/commands/clipboardCommands.js) just
 * execute their plans — so this harness carries the whole weight of both features' correctness:
 *
 *  - what is draggable/copyable at all (components / files; NOT virtual folders, NOT a
 *    property's Get/Set accessors — they live inside the property's tag and travel with it;
 *    directories drag but do NOT copy — a recursive duplicate mass-produces duplicate symbols);
 *  - components MOVE only within their own file (FolderPath is an attribute on the member's
 *    tag, so a "move" to another file has no XML meaning) but PASTE cross-file — a duplicate
 *    under another POU is meaningful — gated on POU↔interface kind;
 *  - files/directories move only into a directory (or the workspace root), never onto
 *    themselves, their own subtree, or where they already live — while a file PASTES into its
 *    own directory too (duplicate-in-place; the paste always renames).
 */

const path = require('path');
const { describeDragged, planDrop, describeCopied, planPaste } = require('../src/dndRules');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
// The matrix is pure and reads uris structurally ({ fsPath, toString() }), so plain objects are
// enough — no vscode import. Paths are built from a platform root so the suite passes on any OS,
// while still exercising the Windows shapes the feature targets (CI runs windows-latest).

const ROOT = process.platform === 'win32' ? 'C:\\' : '/';
/** Builds an absolute platform path under the fake root. */
const p = (...segs) => path.join(ROOT, ...segs);

/** A vscode.Uri stand-in exposing exactly what the matrix reads. */
function fakeUri(fsPath) {
    return { fsPath, toString() { return 'file:///' + fsPath.replace(/\\/g, '/').replace(/^\//, ''); } };
}

/** A TwinCatTreeItem stand-in. `extra` carries componentId / folderPath. */
function item(contextValue, fsPath, extra = {}) {
    return Object.assign({ contextValue, resourceUri: fakeUri(fsPath) }, extra);
}

const pouPath = p('proj', 'PLC', 'FB_Axis.TcPOU');
const otherPouPath = p('proj', 'PLC', 'FB_Other.TcPOU');

// ── describeDragged: what may enter a drag at all ────────────────────────────────────────────────

const method = describeDragged(item('component', pouPath, { componentId: 'method_Home' }));
assert(method && method.kind === 'component' && method.componentType === 'Method' && method.componentName === 'Home',
    'a method is draggable and resolves to XML tag Method, name Home');

// Names may contain underscores: only the type prefix is stripped.
const underscored = describeDragged(item('component', pouPath, { componentId: 'method_do_stuff' }));
assert(underscored && underscored.componentType === 'Method' && underscored.componentName === 'do_stuff',
    'method_do_stuff resolves to name "do_stuff" (underscores in the name survive)');

const prop = describeDragged(item('propertyNode', pouPath, { componentId: 'prop_Value' }));
assert(prop && prop.componentType === 'Property' && prop.componentName === 'Value',
    'a property is draggable and resolves to XML tag Property (accessors move with it implicitly)');

const action = describeDragged(item('component', pouPath, { componentId: 'action_Init' }));
assert(action && action.componentType === 'Action' && action.componentName === 'Init',
    'an action is draggable and resolves to XML tag Action');

const transition = describeDragged(item('component', pouPath, { componentId: 'transition_Ramp' }));
assert(transition && transition.componentType === 'Transition' && transition.componentName === 'Ramp',
    'a transition is draggable and resolves to XML tag Transition');

// Get/Set accessors carry the same 'component' contextValue as methods — the id shape is the only
// thing that tells them apart, so the exclusion MUST key on it, not on the contextValue.
assert(describeDragged(item('component', pouPath, { componentId: 'prop_Value_get' })) === null,
    'a Get accessor (prop_Value_get) is NOT draggable');
assert(describeDragged(item('component', pouPath, { componentId: 'prop_Value_set' })) === null,
    'a Set accessor (prop_Value_set) is NOT draggable');

for (const cv of ['pouFile', 'pouFileProgram', 'pouFileFunction', 'itfFile', 'gvlFile', 'dutFile', 'stFile']) {
    const f = describeDragged(item(cv, pouPath));
    assert(f && f.kind === 'file' && f.fsPath === pouPath, `a ${cv} node is draggable as a file`);
}

const dir = describeDragged(item('directory', p('proj', 'PLC', 'Motion')));
assert(dir && dir.kind === 'directory' && dir.fsPath === p('proj', 'PLC', 'Motion'),
    'a directory node is draggable as a directory');

// Virtual folders are deliberately not draggable in v1: moving one means rewriting every member's
// FolderPath prefix.
for (const cv of ['pouVirtualFolder', 'pouVirtualFolderProgram', 'pouVirtualFolderInterface']) {
    assert(describeDragged(item(cv, pouPath, { folderPath: 'Internal\\' })) === null,
        `a ${cv} is NOT draggable`);
}

assert(describeDragged(item('component', pouPath, { componentId: undefined })) === null,
    'a component with no componentId is not draggable (defensive)');
assert(describeDragged(null) === null, 'null input yields null (defensive)');

// ── planDrop: component ↔ virtual folder / file node ─────────────────────────────────────────────

const vfSameFile = { kind: 'virtualFolder', uri: fakeUri(pouPath), folderPath: 'Methods\\Internal\\' };
const plan1 = planDrop(method, vfSameFile);
assert(plan1 && plan1.action === 'setFolderPath' && plan1.newFolderPath === 'Methods\\Internal\\',
    'component -> virtual folder of its own file plans setFolderPath, path carried verbatim (trailing backslash intact)');
assert(plan1 && plan1.componentType === 'Method' && plan1.componentName === 'Home' && plan1.fileUri.fsPath === pouPath,
    'the setFolderPath plan carries the component identity and its backing file');

// Same file reached with different casing must still count as the same file — VS Code uris differ
// in drive-letter casing depending on which API produced them. Proven both ways: case-different
// same path is accepted, genuinely different path is rejected.
const vfCaseDiff = { kind: 'virtualFolder', uri: fakeUri(pouPath.toUpperCase()), folderPath: 'Methods\\' };
assert(planDrop(method, vfCaseDiff) !== null,
    'component -> own-file folder still matches when the uri differs only in case');
const vfOtherFile = { kind: 'virtualFolder', uri: fakeUri(otherPouPath), folderPath: 'Methods\\' };
assert(planDrop(method, vfOtherFile) === null,
    'component -> another file\'s virtual folder is rejected');

const ownFile = { kind: 'file', uri: fakeUri(pouPath), contextValue: 'pouFile' };
const plan2 = planDrop(method, ownFile);
assert(plan2 && plan2.action === 'setFolderPath' && plan2.newFolderPath === '',
    'component -> its own file node plans setFolderPath \'\' (back to the root)');

assert(planDrop(method, { kind: 'file', uri: fakeUri(otherPouPath), contextValue: 'pouFile' }) === null,
    'component -> ANOTHER file node is rejected');
assert(planDrop(method, { kind: 'directory', fsPath: p('proj', 'PLC') }) === null,
    'component -> directory is rejected');
assert(planDrop(method, { kind: 'workspaceRoot', fsPath: p('proj') }) === null,
    'component -> workspace root (empty area) is rejected');
assert(planDrop(method, null) === null, 'component -> unclassifiable target is rejected');

// ── planDrop: file / directory ↔ directory / workspace root ──────────────────────────────────────

const file = describeDragged(item('pouFile', pouPath));
const plan3 = planDrop(file, { kind: 'directory', fsPath: p('proj', 'PLC', 'Motion') });
assert(plan3 && plan3.action === 'move' && plan3.sourceFsPath === pouPath
    && plan3.targetDirFsPath === p('proj', 'PLC', 'Motion') && plan3.isDirectory === false,
    'file -> directory plans a move');

assert(planDrop(file, { kind: 'directory', fsPath: p('proj', 'PLC') }) === null,
    'file -> the directory it already lives in is a no-op');
assert(planDrop(file, { kind: 'directory', fsPath: p('PROJ', 'plc') }) === null,
    'file -> its current directory in different casing is still a no-op');
assert(planDrop(file, vfSameFile) === null, 'file -> virtual folder is rejected');
assert(planDrop(file, ownFile) === null, 'file -> file node is rejected');

const rootTarget = { kind: 'workspaceRoot', fsPath: p('proj') };
const plan4 = planDrop(file, rootTarget);
assert(plan4 && plan4.action === 'move' && plan4.targetDirFsPath === p('proj'),
    'file -> empty area plans a move into the workspace root');

const motion = describeDragged(item('directory', p('proj', 'PLC', 'Motion')));
const plan5 = planDrop(motion, { kind: 'directory', fsPath: p('proj', 'PLC', 'Safety') });
assert(plan5 && plan5.action === 'move' && plan5.isDirectory === true,
    'directory -> sibling directory plans a move (isDirectory carried)');
assert(planDrop(motion, rootTarget) && planDrop(motion, rootTarget).action === 'move',
    'directory -> empty area plans a move into the workspace root');

assert(planDrop(motion, { kind: 'directory', fsPath: p('proj', 'PLC', 'Motion') }) === null,
    'directory -> itself is rejected');
assert(planDrop(motion, { kind: 'directory', fsPath: p('proj', 'PLC', 'MOTION') }) === null,
    'directory -> itself in different casing is rejected');
assert(planDrop(motion, { kind: 'directory', fsPath: p('proj', 'PLC', 'Motion', 'Axes', 'X') }) === null,
    'directory -> its own descendant is rejected');
assert(planDrop(motion, { kind: 'directory', fsPath: p('proj', 'PLC') }) === null,
    'directory -> its current parent is a no-op');

// The descendant check must compare path SEGMENTS, not string prefixes: <root>/a/bc is a sibling
// of <root>/a/b, not its child — only the trailing separator in the compare keeps them apart.
const dirB = describeDragged(item('directory', p('a', 'b')));
const planEdge = planDrop(dirB, { kind: 'directory', fsPath: p('a', 'bc') });
assert(planEdge && planEdge.action === 'move',
    `${p('a', 'bc')} is NOT treated as a descendant of ${p('a', 'b')} (shared name prefix)`);

// ── describeCopied: what may enter the clipboard at all ─────────────────────────────────────────

const itfPath = p('proj', 'PLC', 'I_Motion.TcIO');

const copiedMethod = describeCopied(item('component', pouPath, { componentId: 'method_Home' }));
assert(copiedMethod && copiedMethod.kind === 'component' && copiedMethod.componentType === 'Method'
    && copiedMethod.componentName === 'Home' && copiedMethod.sourceIsItf === false,
    'a POU method is copyable and carries sourceIsItf === false');

const copiedItfMethod = describeCopied(item('component', itfPath, { componentId: 'method_Move' }));
assert(copiedItfMethod && copiedItfMethod.sourceIsItf === true,
    'an interface method is copyable and carries sourceIsItf === true (derived from .TcIO)');

// EVERY file kind is copyable — the move matrix's semantic exclusions (function/GVL/DUT/ST) do
// not apply to a duplicate.
for (const cv of ['pouFile', 'pouFileProgram', 'pouFileFunction', 'itfFile', 'gvlFile', 'dutFile', 'stFile']) {
    const f = describeCopied(item(cv, pouPath));
    assert(f && f.kind === 'file' && f.fsPath === pouPath, `a ${cv} node is copyable as a file`);
}

// Directories deliberately do NOT copy (v1): a recursive duplicate mass-produces duplicate symbols.
assert(describeCopied(item('directory', p('proj', 'PLC', 'Motion'))) === null,
    'a directory is NOT copyable (drag-only)');
assert(describeCopied(item('component', pouPath, { componentId: 'prop_Value_get' })) === null,
    'a Get accessor is NOT copyable (it rides with its property)');
for (const cv of ['pouVirtualFolder', 'pouVirtualFolderProgram', 'pouVirtualFolderInterface']) {
    assert(describeCopied(item(cv, pouPath, { folderPath: 'Internal\\' })) === null,
        `a ${cv} is NOT copyable`);
}
assert(describeCopied(null) === null, 'null input yields null (defensive)');

// ── planPaste: component ↔ folder / file / sibling — CROSS-FILE, gated on POU↔interface kind ────

// Cross-file is the one place copy deliberately differs from the move matrix: prove it against
// planDrop's rejection of the very same pair.
const otherVf = { kind: 'virtualFolder', uri: fakeUri(otherPouPath), folderPath: 'Dest\\' };
assert(planDrop(copiedMethod, otherVf) === null,
    'CONTRAST: the move matrix rejects a component -> another file\'s folder');
const paste1 = planPaste(copiedMethod, otherVf);
assert(paste1 && paste1.action === 'pasteComponent' && paste1.targetUri.fsPath === otherPouPath
    && paste1.newFolderPath === 'Dest\\' && paste1.targetIsItf === false,
    'the paste matrix allows component -> another POU\'s virtual folder (cross-file duplicate)');
assert(paste1 && paste1.sourceUri.fsPath === pouPath && paste1.componentType === 'Method'
    && paste1.componentName === 'Home',
    'the pasteComponent plan carries the source file and component identity');

const paste2 = planPaste(copiedMethod, { kind: 'file', uri: fakeUri(otherPouPath), contextValue: 'pouFile' });
assert(paste2 && paste2.action === 'pasteComponent' && paste2.newFolderPath === '',
    'component -> a POU file node pastes at the file root (no FolderPath)');

// Pasting onto a component means "as its sibling": same file, same virtual folder.
const sibling = { kind: 'componentSibling', uri: fakeUri(otherPouPath), folderPath: 'Methods\\Internal\\' };
const paste3 = planPaste(copiedMethod, sibling);
assert(paste3 && paste3.action === 'pasteComponent' && paste3.targetUri.fsPath === otherPouPath
    && paste3.newFolderPath === 'Methods\\Internal\\',
    'component -> another component pastes as a SIBLING, carrying that component\'s folder');

// Kind gate: interface members have no Implementation blocks, POU members do — a block pasted
// across the divide is invalid XML on arrival. Both directions must reject.
assert(planPaste(copiedMethod, { kind: 'file', uri: fakeUri(itfPath), contextValue: 'itfFile' }) === null,
    'POU method -> interface file is rejected (kind gate)');
assert(planPaste(copiedItfMethod, { kind: 'file', uri: fakeUri(otherPouPath), contextValue: 'pouFile' }) === null,
    'interface method -> POU file is rejected (kind gate)');
const itfToItf = planPaste(copiedItfMethod, { kind: 'file', uri: fakeUri(itfPath), contextValue: 'itfFile' });
assert(itfToItf && itfToItf.action === 'pasteComponent' && itfToItf.targetIsItf === true,
    'interface method -> interface file is allowed (kinds match, targetIsItf carried)');

// Interfaces have no actions/transitions at all — rejected whatever the source (an action cannot
// even come FROM an interface, so the gate is necessarily one-directional in practice).
const copiedAction = describeCopied(item('component', pouPath, { componentId: 'action_Init' }));
assert(planPaste(copiedAction, { kind: 'file', uri: fakeUri(itfPath), contextValue: 'itfFile' }) === null,
    'action -> interface file is rejected even though the action itself is copyable');

// Members can only land in POUs and interfaces.
for (const cv of ['pouFileFunction', 'gvlFile', 'dutFile', 'stFile']) {
    assert(planPaste(copiedMethod, { kind: 'file', uri: fakeUri(otherPouPath), contextValue: cv }) === null,
        `component -> a ${cv} node is rejected (no members)`);
}
assert(planPaste(copiedMethod, { kind: 'directory', fsPath: p('proj', 'PLC') }) === null,
    'component -> directory is rejected');
assert(planPaste(copiedMethod, null) === null, 'component -> unclassifiable target is rejected');

// ── planPaste: file ↔ directory / workspace root — same-directory duplicate ALLOWED ─────────────

const copiedFile = describeCopied(item('pouFile', pouPath));
assert(planDrop(copiedFile, { kind: 'directory', fsPath: p('proj', 'PLC') }) === null,
    'CONTRAST: the move matrix treats file -> its own directory as a no-op');
const paste4 = planPaste(copiedFile, { kind: 'directory', fsPath: p('proj', 'PLC') });
assert(paste4 && paste4.action === 'pasteFile' && paste4.sourceFsPath === pouPath
    && paste4.targetDirFsPath === p('proj', 'PLC'),
    'the paste matrix allows file -> its OWN directory (duplicate-in-place; the paste renames)');

const paste5 = planPaste(copiedFile, { kind: 'workspaceRoot', fsPath: p('proj') });
assert(paste5 && paste5.action === 'pasteFile' && paste5.targetDirFsPath === p('proj'),
    'file -> empty area pastes into the workspace root');

assert(planPaste(copiedFile, { kind: 'file', uri: fakeUri(otherPouPath), contextValue: 'pouFile' }) === null,
    'file -> a file node is rejected (paste targets are directories and the empty area)');
assert(planPaste(copiedFile, vfSameFile) === null, 'file -> virtual folder is rejected');
assert(planPaste(null, rootTarget) === null, 'null clipboard yields null (defensive)');

if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
console.log('\nAll drag & drop + copy/paste matrix assertions passed.');
