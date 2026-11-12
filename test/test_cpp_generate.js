/**
 * @file test_cpp_generate.js
 * @description C++ generation without the real compiler (src/cppGenerate.js, roadmap R13): the
 * output paths (`<project dir>/CPP_Files/<project>.cpp|.hpp|.o`), the compile-mode command line
 * (the check's inputs and defines, `-o`, no `--check`/`--json`), ownership — only files the toolkit
 * wrote and nobody changed since are replaced or deleted, per project, with a foreign record
 * refused — and running the compile mode through a fake child process (the temporary directory is
 * deleted, a failure keeps the compiler's output). The real compiler run is test/test_cpp_real.js.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cg = require('../src/cppGenerate');
const cc = require('../src/compileCheck');
const { isUnderStFiles } = require('../src/stOutputPath');
const { createFakeSpawn } = require('./_fakeChild');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_cpp_generate_'));
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

(async () => {
    try {
        // ── Names and paths ───────────────────────────────────────────────────────────────────
        assert(cg.cppFileStem('TcToolkitSample_PLC') === 'TcToolkitSample_PLC', 'STEM: a plain project name is kept');
        assert(cg.cppFileStem('My Plc (v2)') === 'My_Plc_v2_' && cg.cppFileStem('..evil') === 'evil' && cg.cppFileStem('') === 'project',
            'STEM: spaces and punctuation become _, no leading dots, never empty');
        const p = cg.cppOutputPaths(path.join(ROOT, 'Proj', 'PLC'), 'PLC');
        assert(p.dir === path.join(ROOT, 'Proj', 'PLC', 'CPP_Files') && p.cpp === path.join(p.dir, 'PLC.cpp') && p.hpp === path.join(p.dir, 'PLC.hpp')
            && p.obj === path.join(p.dir, 'PLC.o') && p.manifest === path.join(p.dir, '.tc-toolkit-generated.json'),
        'PATHS: CPP_Files beside the .plcproj (where ST_Files goes), <project>.cpp/.hpp/.o and the ownership record');
        assert(cg.isUnderCppFiles('C:\\w\\PLC\\CPP_Files\\PLC.cpp') && cg.isUnderCppFiles('/w/PLC/cpp_files/x/y.hpp') && !cg.isUnderCppFiles('/w/PLC/CPP_Files')
            && !cg.isUnderCppFiles('/w/PLC/POUs/CPP_Files.TcPOU'), 'PATHS: isUnderCppFiles, like isUnderStFiles');
        assert(!isUnderStFiles(p.cpp), 'PATHS: the C++ output is not under ST_Files (the two never mix)');

        // ── The compile-mode command line ─────────────────────────────────────────────────────
        const inputs = [{ name: '1.st', unit: { globalListName: null } }, { name: '2.st', unit: { globalListName: 'GVL_Io' } }];
        const extraFiles = [{ name: 'lib_1.st', text: '', globalListName: 'GVL_Lib' }];
        const base = { compilerPath: '/c/compiler.cjs', dialectFile: '/d/twincat3.json', inputs, extraFiles, defineArgs: ['--pragma-define', 'SIM', '--file-define', '2.st=X'] };
        const gen = cc.buildCompilerArgs({ ...base, output: 'PLC.cpp' });
        assert(eq(gen, ['/c/compiler.cjs', '--dialect-file', '/d/twincat3.json', '--pragma-define', 'SIM', '--file-define', '2.st=X', 'lib_1.st', '1.st', '2.st',
            '--global-list', 'lib_1.st=GVL_Lib', '--global-list', '2.st=GVL_Io', '-o', 'PLC.cpp']),
        `ARGS: generation = the check's dialect, defines, inputs and list names, then -o, without --check/--json (${gen.join(' ')})`);
        assert(eq(cc.buildCheckArgs(base), ['/c/compiler.cjs', '--check', '--json', ...gen.slice(1, -2)]), 'ARGS: the check is unchanged (same inputs, --check --json, no -o)');
        assert(eq(cc.buildCheckArgs({ ...base, output: 'x.cpp' }), cc.buildCheckArgs(base)), 'ARGS: buildCheckArgs never takes an output');

        // ── Ownership ─────────────────────────────────────────────────────────────────────────
        const dir = path.join(ROOT, 'own', 'CPP_Files');
        let w = cg.writeOwnedOutputs({ dir, project: 'PLC', files: [{ name: 'PLC.cpp', text: 'cpp1' }, { name: 'PLC.hpp', text: 'hpp1' }] });
        const record = () => JSON.parse(fs.readFileSync(path.join(dir, cg.MANIFEST_NAME), 'utf8'));
        assert(w.ok && w.written.length === 2 && w.refused.length === 0 && fs.readFileSync(path.join(dir, 'PLC.cpp'), 'utf8') === 'cpp1',
            'OWN: a fresh folder is created and both files are written');
        assert(record().generator === 'TC Toolkit' && record().files['PLC.cpp'].sha256 === sha('cpp1') && record().files['PLC.hpp'].project === 'PLC',
            'OWN: the record names each file, its project and its SHA-256');
        w = cg.writeOwnedOutputs({ dir, project: 'PLC', files: [{ name: 'PLC.cpp', text: 'cpp2' }, { name: 'PLC.hpp', text: 'hpp2' }] });
        assert(w.written.length === 2 && fs.readFileSync(path.join(dir, 'PLC.cpp'), 'utf8') === 'cpp2' && record().files['PLC.cpp'].sha256 === sha('cpp2'),
            'OWN: an unchanged earlier output is replaced, and the record follows');
        fs.writeFileSync(path.join(dir, 'PLC.hpp'), 'hpp2 + my edit');
        w = cg.writeOwnedOutputs({ dir, project: 'PLC', files: [{ name: 'PLC.cpp', text: 'cpp3' }, { name: 'PLC.hpp', text: 'hpp3' }] });
        assert(eq(w.refused, [{ path: path.join(dir, 'PLC.hpp'), reason: 'changed' }]) && fs.readFileSync(path.join(dir, 'PLC.hpp'), 'utf8') === 'hpp2 + my edit'
            && fs.readFileSync(path.join(dir, 'PLC.cpp'), 'utf8') === 'cpp3', 'OWN: a generated file the user edited is left alone and reported (changed); the other is written');
        fs.unlinkSync(path.join(dir, 'PLC.hpp'));
        fs.writeFileSync(path.join(dir, 'Other.cpp'), 'mine');
        w = cg.writeOwnedOutputs({ dir, project: 'Other', files: [{ name: 'Other.cpp', text: 'gen' }, { name: 'Other.hpp', text: 'gen' }] });
        assert(eq(w.refused, [{ path: path.join(dir, 'Other.cpp'), reason: 'foreign' }]) && fs.readFileSync(path.join(dir, 'Other.cpp'), 'utf8') === 'mine',
            'OWN: a file of the same name the toolkit never wrote is not overwritten (foreign)');
        assert(fs.readFileSync(path.join(dir, 'PLC.cpp'), 'utf8') === 'cpp3' && !!record().files['PLC.cpp'],
            "OWN: another project's run never deletes this project's files (per-project record)");
        // Renamed project: this project's earlier outputs go, if unchanged.
        w = cg.writeOwnedOutputs({ dir, project: 'PLC', files: [{ name: 'PLC_v2.cpp', text: 'a' }, { name: 'PLC_v2.hpp', text: 'b' }] });
        assert(w.removed.length === 1 && w.removed[0] === path.join(dir, 'PLC.cpp') && !fs.existsSync(path.join(dir, 'PLC.cpp')) && !record().files['PLC.cpp'],
            "OWN: this project's earlier output that the run did not produce is deleted (it was unchanged)");
        // The object file: claimed before g++ runs (an owned one is removed, so a failed build leaves none), recorded after.
        fs.writeFileSync(path.join(dir, 'PLC.o'), 'obj');
        assert(cg.claimOutput(dir, 'PLC.o') === 'foreign' && fs.existsSync(path.join(dir, 'PLC.o')), 'OBJ: a foreign object file is not claimed');
        fs.unlinkSync(path.join(dir, 'PLC.o'));
        assert(cg.claimOutput(dir, 'PLC.o') === 'absent', 'OBJ: an absent object file is free');
        fs.writeFileSync(path.join(dir, 'PLC.o'), 'obj1');
        assert(cg.recordOwnedFile(dir, 'PLC', 'PLC.o') && record().files['PLC.o'].sha256 === sha('obj1'), "OBJ: g++'s object file is recorded after a build");
        assert(cg.claimOutput(dir, 'PLC.o') === 'owned' && !fs.existsSync(path.join(dir, 'PLC.o')) && !record().files['PLC.o'],
            'OBJ: an owned object file is deleted before the next build');
        fs.writeFileSync(path.join(dir, 'PLC.o'), 'obj2');
        cg.recordOwnedFile(dir, 'PLC', 'PLC.o');
        w = cg.writeOwnedOutputs({ dir, project: 'PLC', files: [{ name: 'PLC_v2.cpp', text: 'a2' }, { name: 'PLC_v2.hpp', text: 'b2' }] });
        assert(!fs.existsSync(path.join(dir, 'PLC.o')) && w.removed.includes(path.join(dir, 'PLC.o')),
            'OBJ: generation without a build deletes the owned object file of an earlier build (it no longer matches the .cpp)');
        // A record that is not ours.
        const foreignDir = path.join(ROOT, 'foreign', 'CPP_Files');
        fs.mkdirSync(foreignDir, { recursive: true });
        fs.writeFileSync(path.join(foreignDir, cg.MANIFEST_NAME), '{"something":"else"}');
        w = cg.writeOwnedOutputs({ dir: foreignDir, project: 'P', files: [{ name: 'P.cpp', text: 'x' }] });
        assert(w.ok === false && /not the record TC Toolkit keeps/.test(w.message) && !fs.existsSync(path.join(foreignDir, 'P.cpp'))
            && fs.readFileSync(path.join(foreignDir, cg.MANIFEST_NAME), 'utf8') === '{"something":"else"}', 'OWN: a foreign file in place of the record stops the write, untouched');
        assert(cg.claimOutput(foreignDir, 'P.o') === 'bad-record', 'OBJ: no g++ output is claimed under a foreign record');
        // A record entry that tries to leave its folder is ignored.
        fs.writeFileSync(path.join(foreignDir, cg.MANIFEST_NAME), JSON.stringify({ generator: 'TC Toolkit', version: 1, files: { '../escape.cpp': { project: 'P', sha256: sha('x') } } }));
        fs.writeFileSync(path.join(ROOT, 'foreign', 'escape.cpp'), 'x');
        cg.writeOwnedOutputs({ dir: foreignDir, project: 'P', files: [{ name: 'P.cpp', text: 'y' }] });
        assert(fs.existsSync(path.join(ROOT, 'foreign', 'escape.cpp')), 'OWN: a record entry with a path is ignored; nothing outside the folder is deleted');

        // ── Running the compile mode (fake child process) ─────────────────────────────────────
        let seenDir = '';
        let script = (call) => {
            seenDir = call.options.cwd;
            const out = call.args[call.args.indexOf('-o') + 1];
            fs.writeFileSync(path.join(call.options.cwd, out), '#include "PLC.hpp"\n');
            fs.writeFileSync(path.join(call.options.cwd, out.replace(/\.cpp$/, '.hpp')), '#pragma once\n');
            return { stdout: 'Compiling 1 files...\nCompilation successful!\n', stderr: '1.st:1:1: warning: Pragma ignored: x\n', code: 0 };
        };
        const fake = createFakeSpawn((call) => script(call));
        const unitInputs = [{ filePath: '/x/MAIN.TcPOU', name: '1.st', unit: { stText: 'PROGRAM MAIN END_PROGRAM', globalListName: null } }];
        let r = await cg.runGenerate({ nodeCommand: 'node', compilerPath: '/c/compiler.cjs', dialectFile: '/d/t.json', inputs: unitInputs, stem: 'PLC', spawn: fake.spawn });
        assert(r.status === 'done' && r.cppText === '#include "PLC.hpp"\n' && r.hppText === '#pragma once\n', 'RUN: the .cpp and .hpp the compiler wrote are returned');
        assert(fake.calls[0].args.includes('-o') && !fake.calls[0].args.includes('--check') && fake.calls[0].args.slice(-2).join(' ') === '-o PLC.cpp',
            'RUN: the compiler runs in compile mode, writing PLC.cpp into its temporary directory');
        assert(!!seenDir && !fs.existsSync(seenDir), 'RUN: the temporary directory is deleted afterwards');
        script = () => ({ stderr: 'Compiling 1 files...\n\nCompilation failed:\n\n1.st:2:3: error: Undeclared variable \'X\'\n', code: 1 });
        r = await cg.runGenerate({ nodeCommand: 'node', compilerPath: '/c/compiler.cjs', dialectFile: '/d/t.json', inputs: unitInputs, stem: 'PLC', spawn: fake.spawn });
        assert(r.status === 'failed' && /exit code 1/.test(r.message) && /Undeclared variable 'X'/.test(r.message) && /Compilation failed/.test(r.log),
            `RUN: a failed generation says why and keeps the compiler's output for the output channel (${r.message})`);
        script = () => ({ code: 0 });
        r = await cg.runGenerate({ nodeCommand: 'node', compilerPath: '/c/compiler.cjs', dialectFile: '/d/t.json', inputs: unitInputs, stem: 'PLC', spawn: fake.spawn });
        assert(r.status === 'failed' && /wrote no C\+\+ files/.test(r.message), 'RUN: exit 0 with no files written is a failure');
        script = () => ({ hang: true });
        r = await cg.runGenerate({ nodeCommand: 'node', compilerPath: '/c/compiler.cjs', dialectFile: '/d/t.json', inputs: unitInputs, stem: 'PLC', spawn: fake.spawn, timeoutMs: 30 });
        assert(r.status === 'timeout', 'RUN: a hung compiler is stopped at the timeout');
    } finally {
        fs.rmSync(ROOT, { recursive: true, force: true });
    }

    if (errors > 0) {
        console.error(`\n${errors} C++ generation assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll C++ generation assertions passed.');
})().catch((e) => { console.error(e); process.exit(1); });
