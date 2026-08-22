/** @file test_file_uri.js @description File URI conversion and identity regression coverage. */

const assert = require('assert');
const path = require('path');
const {
    fsPathToFileUri,
    fileUriToFsPath,
    normalizeFileUri
} = require('../src/fileUri');

let passed = 0;
function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

check('round-trips reserved characters, spaces and Unicode', () => {
    const original = path.resolve('C:\\PLC Projects\\Müller #1\\100% ready?.TcPOU');
    const uri = fsPathToFileUri(original);
    assert(uri.includes('%23') && uri.includes('%25') && uri.includes('%3F'));
    assert.strictEqual(fileUriToFsPath(uri), original);
});

if (process.platform === 'win32') {
    check('round-trips a UNC path without losing its host or share', () => {
        const original = '\\\\plc-server\\TwinCAT Share\\Line #1\\MAIN.TcPOU';
        const uri = fsPathToFileUri(original);
        assert(/^file:\/\/plc-server\//i.test(uri));
        assert.strictEqual(fileUriToFsPath(uri), original);
    });
}

check('URI identity follows the platform filesystem case rules', () => {
    const lower = normalizeFileUri('file:///c%3A/PLC/MAIN.TcPOU');
    const differentCase = normalizeFileUri('file:///C:/PLC/main.tcpou');
    if (process.platform === 'win32') assert.strictEqual(lower, differentCase);
    else assert.notStrictEqual(lower, differentCase, 'POSIX identity remains case-sensitive');
});

check('URI normalization does not confuse a fragment with a literal hash in a filename', () => {
    const fsPathIn = process.platform === 'win32'
        ? 'C:\\PLC\\MAIN#backup.TcPOU'
        : '/PLC/MAIN#backup.TcPOU';
    const uri = fsPathToFileUri(fsPathIn);
    assert.ok(!uri.includes('#'), 'the hash must be percent-encoded in the URI, not a fragment');
    assert.strictEqual(path.basename(fileUriToFsPath(uri)), 'MAIN#backup.TcPOU');
});

console.log(`\nAll ${passed} file-URI checks passed.`);
