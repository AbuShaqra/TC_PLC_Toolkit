/**
 * @file test_cpp_generate.js
 * @description C++ generation without the real compiler (src/cppGenerate.js, roadmap R13): the
 * output paths (`<project dir>/CPP_Files/<project>.cpp|.hpp|.o`), the compile-mode command line
 * (the check's inputs and defines, `-o`, no `--check`/`--json`), ownership — only files the toolkit
 * wrote and nobody changed since are replaced or deleted, per project, with a foreign record
 * refused — and running the compile mode through a fake child process (the temporary directory is
 * deleted, a failure keeps the compiler's output), and the folder's `.gitignore` (written, kept
 * current, left alone when edited or foreign, never recreated once deleted). The real compiler run
 * is test/test_cpp_real.js.
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
        // This project's earlier output that a run did not produce goes, if unchanged.
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
        // ── A renamed project, driven the way src/commands/compileCommands.js does it ─────────────
        // The owner is cppOwnerId(<.plcproj text>, stem); the file names come from cppOutputPaths(dir, <.plcproj stem>).
        const guidProj = '<Project><PropertyGroup><ProjectGuid>{5A1B2C3D-0000-4000-8000-00000000ABCD}</ProjectGuid></PropertyGroup></Project>';
        assert(cg.cppOwnerId(guidProj, 'Old') === 'guid:5a1b2c3d-0000-4000-8000-00000000abcd' && cg.cppOwnerId(guidProj, 'New') === cg.cppOwnerId(guidProj, 'Old')
            && cg.cppOwnerId('<Project/>', 'Old') === 'Old' && cg.cppOwnerId('', 'Old') === 'Old',
        'OWNER: the <ProjectGuid> (a rename keeps it), else the .plcproj stem');
        const projDir = path.join(ROOT, 'renamed');
        const generate = (stem, text = 'x') => {
            const ps = cg.cppOutputPaths(projDir, stem);
            const res = cg.writeOwnedOutputs({ dir: ps.dir, project: cg.cppOwnerId(guidProj, ps.stem), files: [
                { name: path.basename(ps.cpp), text: `${text} cpp` }, { name: path.basename(ps.hpp), text: `${text} hpp` }] });
            return { ps, res };
        };
        const before = generate('Old');
        fs.writeFileSync(before.ps.obj, 'old obj');
        cg.recordOwnedFile(before.ps.dir, cg.cppOwnerId(guidProj, before.ps.stem), path.basename(before.ps.obj));
        const after = generate('New');
        assert(eq(after.res.removed.map(f => path.basename(f)).sort(), ['Old.cpp', 'Old.hpp', 'Old.o']) && eq(fs.readdirSync(after.ps.dir).sort(), ['.gitignore', cg.MANIFEST_NAME, 'New.cpp', 'New.hpp'])
            && eq(Object.keys(JSON.parse(fs.readFileSync(after.ps.manifest, 'utf8')).files).sort(), ['New.cpp', 'New.hpp']),
        `RENAME: after Old.plcproj → New.plcproj, the old .cpp, .hpp and .o are deleted and unrecorded (${fs.readdirSync(after.ps.dir).join(', ')})`);
        // A case-only rename (Plc.plcproj → PLC.plcproj) on a case-insensitive file system (Windows, macOS):
        // simulated by a file whose name on disk already has the new spelling while the record has the old one.
        const ciDir = path.join(ROOT, 'ci', 'CPP_Files');
        fs.mkdirSync(ciDir, { recursive: true });
        fs.writeFileSync(path.join(ciDir, 'PLC.cpp'), 'old cpp');
        fs.writeFileSync(path.join(ciDir, cg.MANIFEST_NAME), JSON.stringify({ generator: 'TC Toolkit', version: 1, files: { 'Plc.cpp': { project: 'guid:g', sha256: sha('old cpp') } } }));
        w = cg.writeOwnedOutputs({ dir: ciDir, project: 'guid:g', caseInsensitive: true, files: [{ name: 'PLC.cpp', text: 'new cpp' }] });
        const ciRecord = JSON.parse(fs.readFileSync(path.join(ciDir, cg.MANIFEST_NAME), 'utf8')).files;
        assert(w.refused.length === 0 && w.removed.length === 0 && fs.readFileSync(path.join(ciDir, 'PLC.cpp'), 'utf8') === 'new cpp' && eq(Object.keys(ciRecord), ['PLC.cpp']),
            `RENAME: a case-only rename on Windows finds the recorded file under its old spelling, overwrites it, and records the new one (${JSON.stringify(w.refused)})`);
        assert(cg.ownership(ciDir, { files: { 'plc.CPP': { project: 'g', sha256: sha('new cpp') } } }, 'PLC.cpp', true) === 'owned'
            && cg.ownership(ciDir, { files: { 'plc.CPP': { project: 'g', sha256: sha('new cpp') } } }, 'PLC.cpp', false) === 'foreign',
        'OWN: record names compare case-insensitively only where the file system does');

        // ── Line endings: a CRLF checkout of the toolkit's own files is not an edit ─────────────
        const eolDir = path.join(ROOT, 'eol', 'CPP_Files');
        cg.writeOwnedOutputs({ dir: eolDir, project: 'P', files: [{ name: 'P.cpp', text: 'a\nb\n' }, { name: 'P.hpp', text: 'h\n' }] });
        fs.writeFileSync(path.join(eolDir, 'P.cpp'), 'a\r\nb\r\n');
        fs.writeFileSync(path.join(eolDir, 'P.hpp'), 'h\r\n');
        w = cg.writeOwnedOutputs({ dir: eolDir, project: 'P', files: [{ name: 'P.cpp', text: 'a2\n' }, { name: 'P.hpp', text: 'h2\n' }] });
        assert(w.refused.length === 0 && w.written.length === 2 && fs.readFileSync(path.join(eolDir, 'P.cpp'), 'utf8') === 'a2\n',
            `EOL: files converted to CRLF (git core.autocrlf) are still the toolkit's own and are replaced (${JSON.stringify(w.refused)})`);
        fs.writeFileSync(path.join(eolDir, 'P.cpp'), 'a2 edited\r\n');
        assert(cg.ownership(eolDir, cg.readManifest(eolDir).manifest, 'P.cpp') === 'changed', 'EOL: a real edit still counts as changed');

        // ── A write that fails half-way keeps what was written recorded ──────────────────────
        const halfDir = path.join(ROOT, 'half', 'CPP_Files');
        fs.mkdirSync(path.join(halfDir, 'P.hpp'), { recursive: true }); // P.hpp cannot be written: it is a folder
        let threw = false;
        try { cg.writeOwnedOutputs({ dir: halfDir, project: 'P', files: [{ name: 'P.cpp', text: 'c1' }, { name: 'P.hpp', text: 'h1' }] }); } catch (e) { threw = true; }
        assert(threw && fs.existsSync(path.join(halfDir, cg.MANIFEST_NAME)) && !!cg.readManifest(halfDir).manifest.files['P.cpp'],
            'HALF: when the second write fails, the first file is recorded anyway');
        fs.rmSync(path.join(halfDir, 'P.hpp'), { recursive: true });
        w = cg.writeOwnedOutputs({ dir: halfDir, project: 'P', files: [{ name: 'P.cpp', text: 'c2' }, { name: 'P.hpp', text: 'h2' }] });
        assert(w.refused.length === 0 && w.written.length === 2 && fs.readFileSync(path.join(halfDir, 'P.cpp'), 'utf8') === 'c2',
            `HALF: the next run replaces it (not refused as foreign) (${JSON.stringify(w.refused)})`);

        // ── CPP_Files/.gitignore (user decision 2026-11-12) ───────────────────────────────────
        const giDir = path.join(ROOT, 'gi', 'CPP_Files');
        const giFile = path.join(giDir, '.gitignore');
        const giText = () => fs.readFileSync(giFile, 'utf8');
        const giRecord = () => JSON.parse(fs.readFileSync(path.join(giDir, cg.MANIFEST_NAME), 'utf8')).gitignore;
        const pair = (stem, t = 'x') => [{ name: `${stem}.cpp`, text: `${t} cpp` }, { name: `${stem}.hpp`, text: `${t} hpp` }];
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'P', files: pair('P') });
        assert(w.gitignore.status === 'created' && w.gitignore.path === giFile
            && giText() === `${cg.GITIGNORE_COMMENT}\n/.tc-toolkit-generated.json\n/P.cpp\n/P.hpp\n/P.o\n`,
        `GITIGNORE: the first write creates it: a comment line, then the .cpp, .hpp, the .o g++ will write and the record (${JSON.stringify(w.gitignore)})`);
        assert(/TC Toolkit/.test(cg.GITIGNORE_COMMENT) && /may delete/.test(cg.GITIGNORE_COMMENT) && cg.GITIGNORE_COMMENT.startsWith('#'),
            'GITIGNORE: its comment line says TC Toolkit wrote it and that it may be deleted');
        assert(!!giRecord() && giRecord().sha256 === sha(giText()) && !cg.readManifest(giDir).manifest.files['.gitignore'],
            'GITIGNORE: the record keeps its hash under its own key (it is never one of a project\'s outputs)');
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'P', files: pair('P', 'y') });
        assert(w.gitignore.status === 'unchanged', 'GITIGNORE: a run that changes no name leaves it as it is');
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'Q', files: pair('Q') });
        assert(w.gitignore.status === 'updated' && /\n\/Q\.cpp\n\/Q\.hpp\n\/Q\.o\n$/.test(giText()) && /\n\/P\.cpp\n/.test(giText()) && giRecord().sha256 === sha(giText()),
            'GITIGNORE: a second project in the folder is added to it (both projects listed), and the record follows');
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'Q', files: pair('Q2') });
        assert(w.gitignore.status === 'updated' && !/\/Q\./.test(giText()) && /\/Q2\.cpp\n/.test(giText()),
            'GITIGNORE: a renamed project\'s old names leave the list with its old files');
        // A CRLF checkout of it is still the toolkit's own.
        fs.writeFileSync(giFile, giText().replace(/\n/g, '\r\n'));
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'R', files: pair('R') });
        assert(w.gitignore.status === 'updated' && /\/R\.cpp\n/.test(giText()), 'GITIGNORE: converted to CRLF it is still owned and kept current');
        // Edited by the user: left alone from then on.
        fs.appendFileSync(giFile, '/my-extra\n');
        const edited = giText();
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'S', files: pair('S') });
        assert(w.gitignore.status === 'changed' && giText() === edited && !/\/S\.cpp/.test(giText()),
            'GITIGNORE: a .gitignore the user edited is left alone, even when a new project would be added');
        assert(/was changed since TC Toolkit wrote it and is left alone/.test(cg.gitignoreNote(w.gitignore)) && cg.gitignoreNote(w.gitignore).startsWith('gi/CPP_Files/.gitignore'),
            `GITIGNORE: the note names it and says it is left alone (${cg.gitignoreNote(w.gitignore)})`);
        // Deleted by the user: never written again.
        fs.unlinkSync(giFile);
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'S', files: pair('S', 'z') });
        assert(w.gitignore.status === 'not-recreated' && !fs.existsSync(giFile) && eq(giRecord(), { removed: true }),
            'GITIGNORE: deleted after the toolkit wrote it, it is not recreated, and the record remembers that');
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'T', files: pair('T') });
        assert(w.gitignore.status === 'not-recreated' && !fs.existsSync(giFile) && /was deleted after TC Toolkit wrote it, so it was not written again/.test(cg.gitignoreNote(w.gitignore)),
            'GITIGNORE: a later run (another project) still does not recreate it, and says so');
        // The record survives the object-file steps.
        fs.writeFileSync(path.join(giDir, 'T.o'), 'obj');
        cg.recordOwnedFile(giDir, 'T', 'T.o');
        cg.claimOutput(giDir, 'T.o');
        assert(eq(giRecord(), { removed: true }), 'GITIGNORE: recording and claiming the object file keep the record\'s .gitignore state');
        fs.writeFileSync(giFile, '# the user\'s own\n');
        w = cg.writeOwnedOutputs({ dir: giDir, project: 'T', files: pair('T', 'w') });
        assert(w.gitignore.status === 'foreign' && giText() === '# the user\'s own\n', 'GITIGNORE: a .gitignore the user makes after deleting the toolkit\'s is theirs, untouched');
        // A .gitignore already there before the first run is never overwritten, and not adopted.
        const fgDir = path.join(ROOT, 'gi-foreign', 'CPP_Files');
        fs.mkdirSync(fgDir, { recursive: true });
        fs.writeFileSync(path.join(fgDir, '.gitignore'), '*.o\n');
        w = cg.writeOwnedOutputs({ dir: fgDir, project: 'P', files: pair('P') });
        assert(w.gitignore.status === 'foreign' && fs.readFileSync(path.join(fgDir, '.gitignore'), 'utf8') === '*.o\n'
            && JSON.parse(fs.readFileSync(path.join(fgDir, cg.MANIFEST_NAME), 'utf8')).gitignore === undefined
            && /was not written by TC Toolkit and is left alone/.test(cg.gitignoreNote(w.gitignore)),
        'GITIGNORE: a foreign .gitignore already in the folder is never overwritten (noted), and stays unrecorded');
        w = cg.writeOwnedOutputs({ dir: fgDir, project: 'P', files: pair('P', 'v') });
        assert(w.gitignore.status === 'foreign', 'GITIGNORE: ... on every later run too');
        // A user's edit that happens to equal the wanted text makes it the toolkit's again.
        const adDir = path.join(ROOT, 'gi-adopt', 'CPP_Files');
        fs.mkdirSync(adDir, { recursive: true });
        fs.writeFileSync(path.join(adDir, '.gitignore'), `${cg.GITIGNORE_COMMENT}\n/.tc-toolkit-generated.json\n/P.cpp\n/P.hpp\n/P.o\n`);
        w = cg.writeOwnedOutputs({ dir: adDir, project: 'P', files: pair('P') });
        assert(w.gitignore.status === 'unchanged' && !!cg.readManifest(adDir).manifest.gitignore, 'GITIGNORE: a file already holding exactly the wanted text is taken as the toolkit\'s');
        assert(cg.gitignoreNote({ status: 'unchanged', path: giFile }) === '' && cg.gitignoreNote({ status: 'updated', path: giFile }) === ''
            && /written so the generated files are not committed; delete it/.test(cg.gitignoreNote({ status: 'created', path: giFile })) && cg.gitignoreNote(undefined) === '',
        'GITIGNORE: notes only for created, changed, foreign, not recreated and failed');
        assert(cg.gitignoreText({ files: { 'A[1].cpp': { project: 'p', sha256: '' } } }).includes('/A\\[1].cpp\n'), 'GITIGNORE: glob characters in a name are escaped');
        assert(cg.gitignoreText({ files: {} }) === '', 'GITIGNORE: nothing recorded, nothing to list');
        // Only the toolkit's own files are listed: a user's <stem>.o there before the first write is not.
        const foDir = path.join(ROOT, 'gi-userobj', 'CPP_Files');
        fs.mkdirSync(foDir, { recursive: true });
        fs.writeFileSync(path.join(foDir, 'A.o'), 'the user\'s object');
        w = cg.writeOwnedOutputs({ dir: foDir, project: 'A', files: pair('A') });
        const foText = fs.readFileSync(path.join(foDir, '.gitignore'), 'utf8');
        assert(w.gitignore.status === 'created' && cg.claimOutput(foDir, 'A.o') === 'foreign' && !/\/A\.o\n/.test(foText) && /\/A\.cpp\n\/A\.hpp\n/.test(foText),
            `GITIGNORE: a foreign <stem>.o already in the folder is not listed (the toolkit does not claim it) (${JSON.stringify(foText)})`);
        fs.unlinkSync(path.join(foDir, 'A.o'));
        w = cg.writeOwnedOutputs({ dir: foDir, project: 'A', files: pair('A') });
        assert(w.gitignore.status === 'updated' && /\/A\.o\n/.test(fs.readFileSync(path.join(foDir, '.gitignore'), 'utf8')),
            'GITIGNORE: once that file is gone the name is free again, and the .o g++ will write is listed');
        // A generated file the user edited is theirs now (ownership 'changed'): it leaves the list, so git sees it.
        const edDir = path.join(ROOT, 'gi-edited', 'CPP_Files');
        w = cg.writeOwnedOutputs({ dir: edDir, project: 'E', files: pair('E') });
        fs.appendFileSync(path.join(edDir, 'E.cpp'), '// mine\n');
        w = cg.writeOwnedOutputs({ dir: edDir, project: 'E', files: pair('E', 'y') });
        const edText = fs.readFileSync(path.join(edDir, '.gitignore'), 'utf8');
        assert(w.refused.length === 1 && w.refused[0].reason === 'changed' && w.gitignore.status === 'updated'
            && !/\/E\.cpp\n/.test(edText) && /\/E\.hpp\n/.test(edText) && /\/E\.o\n/.test(edText),
        `GITIGNORE: an edited generated file is refused and no longer listed; the others stay (${JSON.stringify(edText)})`);
        fs.writeFileSync(path.join(edDir, 'E.o'), 'obj');
        cg.recordOwnedFile(edDir, 'E', 'E.o');
        fs.appendFileSync(path.join(edDir, 'E.o'), 'patched');
        assert(!/\/E\.o\n/.test(cg.gitignoreText(cg.readManifest(edDir).manifest, edDir)) && /\/E\.o\n/.test(cg.gitignoreText(cg.readManifest(edDir).manifest)),
            'GITIGNORE: a recorded object file changed since is left out too; without the folder every name is listed');
        // A record entry named .gitignore is never taken as a project output (so cleanup never deletes it as one).
        const ngDir = path.join(ROOT, 'gi-entry', 'CPP_Files');
        fs.mkdirSync(ngDir, { recursive: true });
        fs.writeFileSync(path.join(ngDir, '.gitignore'), 'x');
        fs.writeFileSync(path.join(ngDir, cg.MANIFEST_NAME), JSON.stringify({ generator: 'TC Toolkit', version: 1, files: { '.gitignore': { project: 'P', sha256: sha('x') } } }));
        cg.writeOwnedOutputs({ dir: ngDir, project: 'P', files: pair('P') });
        assert(fs.readFileSync(path.join(ngDir, '.gitignore'), 'utf8') === 'x', 'GITIGNORE: a files entry named .gitignore is ignored, never cleaned up as an output');

        // ── Library symbols: what the C++ does not cover, per library (user decision 2026-11-12) ──
        assert(cg.libraryCoverage({}).length === 0 && cg.libraryCoverageText([], { built: true, channel: 'X' }) === ''
            && cg.libraryCoverageLines([]).length === 0 && cg.libraryCoverageHeader([]) === '' && cg.withCoverageHeader('a\n', '') === 'a\n',
        'LIBRARY: a project with no library symbols gets no note, no lines and no header');
        const cov = cg.libraryCoverage({
            declaredSymbols: [{ name: 'FB_VendorThing', kind: 'fb', library: 'Vendor_Lib' }, { name: 'F_Calc', kind: 'function', library: 'Vendor_Lib' },
                { name: 'ST_Pos', kind: 'struct', library: 'Vendor_Lib' }, { name: 'GVL_Consts', kind: 'gvl', library: 'Alpha_Lib' },
                { name: 'F_Loose', kind: 'function', library: '' }, { name: 'f_calc', kind: 'function', library: 'vendor_lib' }],
            compilerSubstitutes: [{ name: 'TON', library: 'Alpha_Lib' }],
            undeclared: [{ name: 'F_Missing', library: 'Vendor_Lib' }]
        });
        assert(JSON.stringify(cov.map(e => e.library)) === '["Alpha_Lib","Vendor_Lib",""]'
            && cov[1].blocks.join() === 'F_Calc,FB_VendorThing' && cov[1].types.join() === 'ST_Pos' && cov[1].undeclared.join() === 'F_Missing'
            && cov[0].globalLists.join() === 'GVL_Consts' && cov[0].substitutes.join() === 'TON' && cov[2].blocks.join() === 'F_Loose',
        `LIBRARY: grouped by library (case-insensitive, duplicates once), sorted, an unidentified library last (${JSON.stringify(cov)})`);
        const covText = cg.libraryCoverageText(cov, { built: true, channel: 'TC Toolkit Compile' });
        assert(covText === 'The generated C++ and the g++ check do not cover the library code of Alpha_Lib, Vendor_Lib, library not identified: their code is not available, so their function blocks and functions are declarations with empty bodies there. The library blocks used are listed in the "TC Toolkit Compile" output.',
            `LIBRARY: the summary sentence names every library (${covText})`);
        assert(/^The generated C\+\+ does not cover the library code of Alpha_Lib: the compiler's own implementation of their blocks is used instead\./.test(cg.libraryCoverageText([cov[0]], { built: false, channel: 'C' })),
            'LIBRARY: without g++ the sentence speaks of the C++ only; compiler stand-ins only → said so');
        const covLines = cg.libraryCoverageLines(cov);
        assert(covLines.includes('  Vendor_Lib:') && covLines.includes("    declarations with empty bodies (the library's code is not available): F_Calc, FB_VendorThing")
            && covLines.includes('    no usable declaration (the compiler cannot compile a use of these): F_Missing')
            && covLines.some(l => /global lists .*a value that is not known starts at 0.*: GVL_Consts$/.test(l)) && covLines.includes('  library not identified:'),
        `LIBRARY: the output channel lists the blocks per library (${covLines.join(' | ')})`);
        const header = cg.libraryCoverageHeader(cg.libraryCoverage({ declaredSymbols: [{ name: 'FB_X', kind: 'fb', library: 'Bad\nName' }] }));
        assert(header.startsWith('// TC Toolkit: this C++ does not contain the code of the library blocks below.') && header.includes('//   Bad Name: FB_X\n')
            && header.split('\n').every(l => l === '' || l.startsWith('//')),
        'LIBRARY: the header is line comments only, naming the blocks (a line break in a library name cannot end the comment)');
        assert(cg.libraryCoverageHeader(cg.libraryCoverage({ declaredSymbols: [{ name: 'ST_X', kind: 'struct', library: 'L' }] })) === '',
            'LIBRARY: types alone put no header on the files');
        assert(cg.withCoverageHeader('a\r\nb\r\n', '// h\n') === '// h\r\na\r\nb\r\n' && cg.withCoverageHeader('a\n', '// h\n') === '// h\na\n',
            'LIBRARY: the header follows the file\'s line endings');
        // The header is part of the recorded text: a second run with the same header replaces its own file.
        const hdrDir = path.join(ROOT, 'hdr', 'CPP_Files');
        const withHdr = cg.withCoverageHeader('int x;\n', header);
        cg.writeOwnedOutputs({ dir: hdrDir, project: 'P', files: [{ name: 'P.cpp', text: withHdr }] });
        assert(cg.ownership(hdrDir, cg.readManifest(hdrDir).manifest, 'P.cpp') === 'owned'
            && cg.writeOwnedOutputs({ dir: hdrDir, project: 'P', files: [{ name: 'P.cpp', text: 'int x;\n' }] }).written.length === 1,
        'LIBRARY: a file written with the header is owned, and is replaced when the header goes away');

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
