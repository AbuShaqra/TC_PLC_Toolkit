/**
 * @file test_signature_generator_args.js
 * @description The command line src/xaeShell.js's `runSignatureGenerator` gives PowerShell for the
 * library-signature generator: `-ExecutionPolicy Bypass` (an unsigned script must run under a local
 * AllSigned/RemoteSigned policy, as the XAE Build script does), `-NoProfile`, `-STA`, `-File <script>`,
 * the workspace folder, `-ShellExe` and `-ProgId`. `spawn` is replaced by a recorder; nothing runs.
 */

'use strict';

const Module = require('module');
const { EventEmitter } = require('events');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const spawned = [];
const childProcessStub = {
    spawn: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts });
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 0));
        return proc;
    }
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'child_process') return childProcessStub;
    if (request === 'vscode') return {};
    return realLoad.call(this, request, parent, isMain);
};

const { runSignatureGenerator } = require('../src/xaeShell');

(async () => {
    const output = { appendLine: () => {} };
    const code = await runSignatureGenerator(
        'C:\\ext\\scripts\\generate-library-signatures.ps1',
        'C:\\work\\project',
        { exePath: 'C:\\TwinCAT\\TcXaeShell.exe', progId: 'TcXaeShell.DTE.17.0' },
        output,
        () => {}
    );
    assert(code === 0, 'resolves with the script exit code');
    assert(spawned.length === 1 && spawned[0].cmd === 'powershell.exe', 'starts powershell.exe once');
    const a = spawned[0] ? spawned[0].args : [];
    assert(a[a.indexOf('-ExecutionPolicy') + 1] === 'Bypass',
        '-ExecutionPolicy Bypass is passed, so an unsigned script runs under a local AllSigned/RemoteSigned policy');
    assert(a.indexOf('-ExecutionPolicy') < a.indexOf('-File'), '-ExecutionPolicy comes before -File (PowerShell reads arguments after -File as script arguments)');
    assert(a.includes('-NoProfile') && a.includes('-STA'), '-NoProfile and -STA are present');
    assert(a[a.indexOf('-File') + 1] === 'C:\\ext\\scripts\\generate-library-signatures.ps1', '-File names the script');
    assert(a[a.indexOf('-File') + 2] === 'C:\\work\\project', 'the workspace folder is the first script argument');
    assert(a[a.indexOf('-ShellExe') + 1] === 'C:\\TwinCAT\\TcXaeShell.exe' && a[a.indexOf('-ProgId') + 1] === 'TcXaeShell.DTE.17.0',
        '-ShellExe and -ProgId pass the chosen shell');

    Module._load = realLoad;
    if (errors) { console.error(`\n${errors} failure(s)`); process.exit(1); }
    console.log('\nAll signature-generator argument checks passed.');
})();
