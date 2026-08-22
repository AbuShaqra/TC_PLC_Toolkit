/** @file test_editor_mapping.js @description Pure production editor-coordinate helper coverage. */

const assert = require('assert');
const {
    localToAbsolute,
    absoluteToLocal,
    paneTextFromUnit,
    peekPath
} = require('../src/livePath');
const { fsPathToFileUri } = require('../src/fileUri');

const lineMap = {
    root: { decl: { start: 2, end: 4 }, impl: { start: 6, end: 7 } },
    method_Run: { decl: { start: 10, end: 11 }, impl: null }
};

assert.deepStrictEqual(localToAbsolute(lineMap, 'root', 'decl', 1, 1), { line: 1, character: 0 });
assert.deepStrictEqual(localToAbsolute(lineMap, 'root', 'decl', 3, 5), { line: 3, character: 4 });
assert.strictEqual(localToAbsolute(lineMap, 'missing', 'decl', 1, 1), null);
assert.strictEqual(localToAbsolute(lineMap, 'method_Run', 'impl', 1, 1), null);

assert.deepStrictEqual(absoluteToLocal(lineMap, 1), { componentId: 'root', pane: 'decl', localLine0: 0 });
assert.deepStrictEqual(absoluteToLocal(lineMap, 6), { componentId: 'root', pane: 'impl', localLine0: 1 });
assert.strictEqual(absoluteToLocal(lineMap, 4), null, 'synthesized separator line is not editable');
assert.strictEqual(absoluteToLocal(lineMap, 50), null);

const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`);
assert.strictEqual(paneTextFromUnit(lines, lineMap, 'root', 'decl'), 'line-2\nline-3\nline-4');
assert.strictEqual(paneTextFromUnit(lines, lineMap, 'method_Run', 'impl'), null);

const hashFsPath = process.platform === 'win32'
    ? 'C:\\PLC Projects\\MAIN#copy.TcPOU'
    : '/PLC Projects/MAIN#copy.TcPOU';
const encoded = fsPathToFileUri(hashFsPath);
assert.strictEqual(peekPath(encoded, 'method_Run', 'impl'), '/Run.impl/MAIN#copy.TcPOU');
assert.strictEqual(peekPath('', 'root', 'decl'), '/root.decl/object');

// A transition peek path carries the member name, not the raw id (trans_ never matched transition_).
assert.ok(peekPath('file:///c%3A/x/FB_A.TcPOU', 'transition_Ready', 'impl').startsWith('/Ready.impl/'),
    'transition peek path must strip the kind prefix');

console.log('All production editor-mapping checks passed.');
