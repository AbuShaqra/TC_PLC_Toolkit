/**
 * @file test_cpp_real.js
 * @description The REAL end-to-end gate of C++ generation and the g++ build (roadmap R13): every PLC
 * project of a TEMPORARY COPY of sample/ goes through the same steps Compile Project takes — check
 * units, library preparation, the project's compiler defines, the check (zero errors), the
 * compiler's compile mode, the write into `<project dir>/CPP_Files/` under the ownership record —
 * and, when a g++ is found, g++ compiles each generated `.cpp` against the vendored runtime headers
 * (`resources/compiler/include/`), its messages placed on the generated files as the command does.
 * sample/ itself is never written: the gate asserts it has no CPP_Files afterwards.
 * With git on PATH, a temporary repository over the copy proves CPP_Files/.gitignore makes git ignore
 * exactly the toolkit's files (`git check-ignore`, `git status`), and that once deleted it stays gone.
 *
 * Two optional gates, reported apart by test/run.js (neither makes a run REDUCED):
 *   - `cpp-real` needs the compiler's Node >= 22 (as test_compile_real.js finds one);
 *   - `gpp-real` also needs g++: `TC_TEST_GPP`, else the same detection the command uses (PATH, then
 *     the usual Windows install folders). Without one it SKIPS and says so.
 *
 * Library use (user decision 2026-11-12): a second temp copy of sample/ gets a SYNTHETIC library
 * (test/_synthLibProject.js: a `.plcproj` reference, the signatures dump, a `.tmc`) and a POU that
 * calls it. Its C++ is generated with the check's library declarations (empty-bodied library blocks,
 * named at the top of the files), g++ must compile it, and the summary sentence must name the
 * library. That includes a library parameter whose array bound is a library constant, and a derived
 * block of the project reading a variable it inherits from a library block. A library symbol with no
 * usable declaration (a type this compiler lacks) must make the generation fail and be named,
 * through its owner block, with its library.
 *
 * g++ ratchet: a project builds cleanly, or every g++ error is a KNOWN compiler gap listed below
 * (matched by message) — a new g++ error fails the gate, and a gap that no longer occurs is printed
 * so its entry can be removed.
 */

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reportCoverages } = require('./_coverage');
const { parseTwinCatXml } = require('../src/xmlParser');
const { createProjectMap } = require('../src/lsp/projectMap');
const cc = require('../src/compileCheck');
const cg = require('../src/cppGenerate');
const gpp = require('../src/gpp');
const { prepareLibraryCheck } = require('../src/libraryDecls');
const { SIGNATURES, TMC, pouXml } = require('./_synthLibProject');
const { projectDefineArgs, fileDefineArgs } = require('../src/compilerDefines');

const REPO = path.join(__dirname, '..');
const SAMPLE = path.join(REPO, 'sample');
const DIALECT = path.join(REPO, 'resources', 'dialects', 'twincat3.json');
const INCLUDE = path.join(REPO, 'resources', 'compiler', 'include');

/**
 * g++ errors on correct sample code that are gaps of the compiler's C++ output (its check accepts
 * the code). Each must still be placed on the generated files. Remove an entry once it is fixed.
 */
/** @type {Record<string, RegExp[]>} None left: the property read through a global FB instance (found
 *  2026-11-12 at eb52d2c) was fixed by the fork and arrived with release M (75a55de). */
const KNOWN_GPP_GAPS = {};

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const gates = { cpp: { gate: 'cpp-real', status: 'skipped', detail: '' }, gpp: { gate: 'gpp-real', status: 'skipped', detail: '' } };
function finish() {
    reportCoverages([gates.cpp, gates.gpp]);
    if (errors > 0) {
        console.error(`\n${errors} C++/g++ end-to-end assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll C++/g++ end-to-end assertions passed.');
    process.exit(0);
}
function skipAll(reason) {
    console.log(`[SKIP] C++ end-to-end gate: ${reason}`);
    gates.cpp.detail = reason;
    gates.gpp.detail = reason;
    finish();
}

/** Lists every CPP_Files folder under a directory. */
function cppFolders(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const p = path.join(d, e.name);
            if (e.name.toLowerCase() === 'cpp_files') out.push(p);
            else walk(p);
        }
    };
    walk(dir);
    return out;
}

/**
 * TcToolkitSample2 (a copy) with a synthetic library: generation with the library declarations, the
 * coverage named in the files and the summary sentence, and g++ (when found) compiling the result.
 * @param {string} tmp
 * @param {any} setup checkSetup's result.
 * @param {string} gppPath '' when no g++ was found.
 */
async function libraryScenario(tmp, setup, gppPath) {
    const ws = path.join(tmp, 'libsample');
    fs.cpSync(SAMPLE, ws, { recursive: true });
    const projectDir = path.join(ws, 'TcToolkitSample2', 'TcToolkitSample2', 'TcToolkitSample2_PLC');
    const plcprojPath = path.join(projectDir, 'TcToolkitSample2_PLC.plcproj');
    const plcproj = fs.readFileSync(plcprojPath, 'utf8')
        .replace('<Compile Include="POUs\\MAIN.TcPOU">', '<Compile Include="POUs\\P_LibUse.TcPOU">\r\n      <SubType>Code</SubType>\r\n    </Compile>\r\n' +
            '    <Compile Include="POUs\\FB_LibChild.TcPOU">\r\n      <SubType>Code</SubType>\r\n    </Compile>\r\n    <Compile Include="POUs\\MAIN.TcPOU">')
        .replace('<PlaceholderReference Include="Tc2_Standard">', '<PlaceholderReference Include="Synthetic Motion Library">\r\n      <DefaultResolution>Synthetic Motion Library, * (Synthetic Co)</DefaultResolution>\r\n      <Namespace>SynMotion</Namespace>\r\n    </PlaceholderReference>\r\n    <PlaceholderReference Include="Tc2_Standard">');
    assert(plcproj.includes('P_LibUse.TcPOU') && plcproj.includes('FB_LibChild.TcPOU') && plcproj.includes('<Namespace>SynMotion</Namespace>'), 'LIB: the sample copy references the synthetic library and compiles P_LibUse');
    fs.writeFileSync(plcprojPath, plcproj);
    fs.writeFileSync(path.join(ws, 'library-signatures.xml'), SIGNATURES);
    fs.writeFileSync(path.join(projectDir, 'SynLib.tmc'), TMC);
    const decl = ['PROGRAM P_LibUse', 'VAR', '\tfbAxis : FB_SynAxis;', '\tfbLog : SynMotion.FB_SynLogger;', '\tfbTimer : SynMotion.TON;',
        '\tstPos : ST_SynPos;', '\tsName : T_SynName;', '\tnSum : DINT;', '\tfDist : LREAL;', '\tbOk : BOOL;', '\taBuf : ARRAY [0..15] OF INT;', 'END_VAR'].join('\r\n');
    const impl = (extra) => ['nSum := F_SynAdd(nA := 1, nB := 2);', 'fDist := SynMotion.F_SynDistance(stFrom := stPos, stTo := stPos, bValid => bOk);',
        'fbAxis(bExecute := TRUE, fTarget := 10.0, sAxisName := sName, stPos := stPos);', 'bOk := fbAxis.MSynReset(bHard := FALSE);',
        'nSum := fbAxis.nSynCount;', "fbLog(sMessage := 'synthetic');", 'fbTimer(IN := bOk, PT := T#1S);', 'stPos.fX := cSynGain;',
        'bOk := F_SynBounded(aData := aBuf);', ...extra].join('\r\n');
    const pouPath = path.join(projectDir, 'POUs', 'P_LibUse.TcPOU');
    // A block of the project derived from a library block, reading a variable it inherits.
    const childPath = path.join(projectDir, 'POUs', 'FB_LibChild.TcPOU');
    const childDecl = ['FUNCTION_BLOCK FB_LibChild EXTENDS FB_SynAxis', 'VAR', '\tnCopy : DINT;', 'END_VAR'].join('\r\n');

    /** The command's steps for this project, with P_LibUse's and FB_LibChild's bodies given. */
    const runProject = async (extra, childImpl = ['nCopy := nInternal;']) => {
        fs.writeFileSync(pouPath, pouXml('P_LibUse', decl, impl(extra)));
        fs.writeFileSync(childPath, pouXml('FB_LibChild', childDecl, childImpl.join('\r\n')));
        const project = [...createProjectMap([ws]).projects.values()].find(p => p.dir === projectDir);
        const files = [...project.objectFiles.values()].sort().map(filePath => ({ filePath, text: fs.readFileSync(filePath, 'utf8') }));
        const built = cc.buildCheckInputs(files, parseTwinCatXml);
        const library = prepareLibraryCheck({ projectDir, roots: [ws], inputs: built.inputs, compilerPath: setup.compilerPath });
        const run = { nodeCommand: setup.nodeCommand, nodeEnv: setup.nodeEnv, compilerPath: setup.compilerPath, dialectFile: DIALECT,
            inputs: library.inputs, extraFiles: library.extraFiles, defineArgs: [] };
        const check = await cc.runCheck({ ...run, libraryFilter: library.filter });
        const coverage = cg.libraryCoverage({ declaredSymbols: library.declaredSymbols, compilerSubstitutes: library.compilerSubstitutes,
            undeclared: library.undeclaredUses(check.filteredLibrary) });
        const gen = await cg.runGenerate({ ...run, stem: 'TcToolkitSample2_PLC' });
        return { project, library, check, coverage, gen };
    };

    const ok = await runProject([]);
    assert(ok.project.objectFiles.size > 0 && ok.library.extraFiles.length > 0 && ok.check.status === 'done' && ok.check.errors === 0 && ok.check.filteredLibraryDiagnostics === 0,
        `LIB: the check of a project that calls library blocks has no errors (${ok.check.status} ${ok.check.errors} errors, ${ok.library.extraFiles.length} declaration files)`);
    const syn = ok.coverage.find(e => e.library === 'Synthetic Motion Library') || { blocks: [], substitutes: [], types: [], globalLists: [], undeclared: [] };
    assert(ok.coverage.length === 1 && ['FB_SynAxis', 'FB_SynLogger', 'F_SynAdd', 'F_SynBounded', 'F_SynDistance'].every(n => syn.blocks.includes(n))
        && syn.substitutes.join() === 'TON' && syn.types.includes('ST_SynPos') && syn.globalLists.join() === 'GVL_SynConst' && syn.undeclared.length === 0,
    `LIB: the coverage names the library as the .plcproj references it, with its blocks (${JSON.stringify(ok.coverage)})`);
    const summary = cg.libraryCoverageText(ok.coverage, { built: !!gppPath, channel: 'TC Toolkit Compile' });
    assert(/do(es)? not cover the library code of Synthetic Motion Library: their code is not available, so their function blocks and functions are declarations with empty bodies there\./.test(summary),
        `LIB: the summary sentence names the library (${summary})`);
    assert(ok.gen.status === 'done' && /FB_SYNAXIS::MSYNRESET/.test(ok.gen.cppText) && /F_SYNADD\(/.test(ok.gen.cppText)
        && /F_SYNBOUNDED\(/.test(ok.gen.cppText) && /class FB_LIBCHILD\s*:\s*public FB_SYNAXIS/.test(ok.gen.hppText) && /NINTERNAL/.test(ok.gen.hppText),
        `LIB: the compile mode, given the same declarations, generates C++ with the library blocks (${ok.gen.status} ${ok.gen.message})`);
    if (ok.gen.status !== 'done') { console.log(ok.gen.log); return; }
    const paths = cg.cppOutputPaths(projectDir, 'TcToolkitSample2_PLC');
    const header = cg.libraryCoverageHeader(ok.coverage);
    const w = cg.writeOwnedOutputs({ dir: paths.dir, project: 'TcToolkitSample2_PLC', files: [
        { name: path.basename(paths.cpp), text: cg.withCoverageHeader(ok.gen.cppText, header) },
        { name: path.basename(paths.hpp), text: cg.withCoverageHeader(ok.gen.hppText, header) }] });
    const cppText = fs.readFileSync(paths.cpp, 'utf8');
    assert(w.ok && w.written.length === 2 && cppText.startsWith('// TC Toolkit: this C++ does not contain the code of the library blocks below.')
        && /^\/\/ {3}Synthetic Motion Library: F_SynAdd, F_SynBounded, F_SynDistance, FB_SynAxis, FB_SynLogger$/m.test(cppText)
        && fs.readFileSync(paths.hpp, 'utf8').startsWith('// TC Toolkit:'), 'LIB: the generated files name the empty-bodied library blocks at the top');
    if (!gppPath) {
        console.log('[SKIP] LIB: g++ build of the library project (no g++ found)');
    } else {
        const r = await gpp.runGpp({ gppPath, cwd: paths.dir, args: gpp.buildGppArgs({ cppFile: paths.cpp, objFile: paths.obj, includeDir: INCLUDE, outDir: paths.dir }) });
        const placed = r.status === 'done' ? gpp.placeGppMessages(r.messages, { cwd: paths.dir, cppFile: paths.cpp, hppFile: paths.hpp }) : [];
        assert(r.status === 'done' && r.exitCode === 0 && placed.length === 0 && fs.existsSync(paths.obj),
            `LIB: g++ compiles the C++ with the empty-bodied library blocks, with no warning (${r.status} ${r.exitCode} ${placed.map(m => m.message).join(' | ')})`);
        if (r.exitCode !== 0) console.log(r.output);
    }

    // Library symbols with no usable declaration: their types (LTIME) are not ones this compiler has.
    const bad = await runProject([], ['tSynSpan := tSynSpan;']);
    const badSyn = bad.coverage.find(e => e.library === 'Synthetic Motion Library') || { undeclared: [] };
    assert(bad.check.status === 'done' && bad.check.errors === 0 && bad.check.filteredLibraryDiagnostics >= 1 && bad.gen.status === 'failed'
        && badSyn.undeclared.join() === 'FB_SynAxis.tSynSpan' && !bad.coverage.some(e => !e.library),
    `LIB: an inherited library variable with no usable declaration: the check hides it, the compile mode fails, and it is named through its owner with its library (${bad.gen.status}; ${JSON.stringify(bad.coverage.map(e => [e.library, e.undeclared]))})`);
    const badFn = await runProject(['bOk := F_SynLongTime(tSpan := T#1S);']);
    assert(badFn.gen.status === 'failed' && badFn.coverage.some(e => e.library === 'Synthetic Motion Library' && e.undeclared.join() === 'F_SynLongTime'),
        `LIB: a library function with no usable declaration is named in the library's spelling with its library (${badFn.gen.status}; ${JSON.stringify(badFn.coverage.map(e => [e.library, e.undeclared]))})`);
}

(async () => {
    if (!fs.existsSync(SAMPLE)) skipAll('sample/ is absent');
    const setup = await cc.checkSetup({ compilerPath: process.env.TWINCAT_COMPILER_BUNDLE || '', nodePath: process.env.TWINCAT_COMPILER_NODE || '' });
    if (!setup.ok) skipAll(setup.problems.map(p => p.message).join(' '));
    console.log(`    compiler: ${setup.compilerBundled ? 'bundled' : 'override'}; Node ${setup.nodeVersion} (${setup.nodeLabel})`);
    const sampleCppBefore = cppFolders(SAMPLE);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_cpp_real_'));
    try {
        const copy = path.join(tmp, 'sample');
        fs.cpSync(SAMPLE, copy, { recursive: true });
        const projectMap = createProjectMap([copy]);
        const projects = [...projectMap.projects.values()].sort((a, b) => a.dir.localeCompare(b.dir));
        assert(projects.length >= 2, `the copy holds every sample PLC project (${projects.map(p => p.name).join(', ')})`);

        // ── Generation, as the command does it ──────────────────────────────────────────────
        /** @type {Array<{name: string, paths: ReturnType<typeof cg.cppOutputPaths>}>} */
        const generated = [];
        for (const project of projects) {
            const files = [...project.objectFiles.values()].sort().map(filePath => ({ filePath, text: fs.readFileSync(filePath, 'utf8') }));
            const built = cc.buildCheckInputs(files, parseTwinCatXml);
            const library = prepareLibraryCheck({ projectDir: project.dir, roots: [copy], inputs: built.inputs, compilerPath: setup.compilerPath });
            const projectDefines = projectDefineArgs(project.plcprojPath, (p) => fs.readFileSync(p, 'utf8'));
            const perObject = fileDefineArgs(projectDefines.objects, library.inputs, project.plcprojPath);
            const run = { nodeCommand: setup.nodeCommand, nodeEnv: setup.nodeEnv, compilerPath: setup.compilerPath, dialectFile: DIALECT,
                inputs: library.inputs, extraFiles: library.extraFiles, defineArgs: [...projectDefines.args, ...perObject.args] };
            const check = await cc.runCheck({ ...run, libraryFilter: library.filter });
            assert(check.status === 'done' && check.errors === 0, `${project.name}: the check has no errors, so C++ is generated (${check.status} ${check.message} ${check.errors})`);
            const stem = path.basename(project.plcprojPath, path.extname(project.plcprojPath));
            const paths = cg.cppOutputPaths(project.dir, stem);
            const gen = await cg.runGenerate({ ...run, stem: paths.stem });
            assert(gen.status === 'done', `${project.name}: the compiler generates C++ (${gen.status} ${gen.message})`);
            if (gen.status !== 'done') { console.log(gen.log); continue; }
            const w = cg.writeOwnedOutputs({ dir: paths.dir, project: paths.stem, files: [
                { name: path.basename(paths.cpp), text: gen.cppText }, { name: path.basename(paths.hpp), text: gen.hppText }] });
            assert(w.ok && w.refused.length === 0 && fs.existsSync(paths.cpp) && fs.existsSync(paths.hpp)
                && path.dirname(paths.cpp) === path.join(path.dirname(project.plcprojPath), 'CPP_Files'),
            `${project.name}: ${stem}.cpp and ${stem}.hpp are written to CPP_Files beside the .plcproj`);
            assert(gen.cppText.includes(`#include "${stem}.hpp"`) && gen.cppText.length > 200 && gen.hppText.length > 200,
                `${project.name}: the .cpp includes its .hpp by the project's name (${gen.cppText.length} + ${gen.hppText.length} bytes)`);
            assert(!/\.st\b/.test(path.basename(paths.cpp)) && fs.readdirSync(paths.dir).sort().join(',') === ['.gitignore', '.tc-toolkit-generated.json', `${stem}.cpp`, `${stem}.hpp`].sort().join(','),
                `${project.name}: CPP_Files holds the two files, the ownership record and the .gitignore, nothing from the compiler's temporary directory`);
            assert(w.gitignore && w.gitignore.status === 'created', `${project.name}: the first generation writes CPP_Files/.gitignore`);
            // A second run replaces the toolkit's own files.
            const again = cg.writeOwnedOutputs({ dir: paths.dir, project: paths.stem, files: [
                { name: path.basename(paths.cpp), text: gen.cppText }, { name: path.basename(paths.hpp), text: gen.hppText }] });
            assert(again.written.length === 2 && again.refused.length === 0, `${project.name}: a second generation replaces its own files`);
            generated.push({ name: stem, paths });
        }
        assert(generated.length === projects.length, 'C++ is generated for every sample project');
        gates.cpp.status = 'ran';

        // ── The g++ build ───────────────────────────────────────────────────────────────────
        const found = gpp.resolveGpp({ configured: process.env.TC_TEST_GPP || '', platform: process.platform, env: process.env,
            exists: (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } } });
        if (found.ok === false) {
            gates.gpp.detail = 'no g++ found (set TC_TEST_GPP, or put g++ on PATH)';
            console.log(`[SKIP] g++ build gate: ${gates.gpp.detail}`);
        } else {
            console.log(`    g++: ${found.path} (${found.source})`);
            assert(fs.existsSync(path.join(INCLUDE, 'iec_types.hpp')), 'the vendored runtime headers are there');
            for (const { name, paths } of generated) {
                assert(cg.claimOutput(paths.dir, path.basename(paths.obj)) === 'absent', `${name}: the object file name is free`);
                const r = await gpp.runGpp({ gppPath: found.path, cwd: paths.dir,
                    args: gpp.buildGppArgs({ cppFile: paths.cpp, objFile: paths.obj, includeDir: INCLUDE, outDir: paths.dir }) });
                assert(r.status === 'done', `${name}: g++ ran to its end (${r.status} ${r.message})`);
                const placed = gpp.placeGppMessages(r.messages, { cwd: paths.dir, cppFile: paths.cpp, hppFile: paths.hpp });
                const errs = placed.filter(m => m.severity === 'error');
                const warns = placed.filter(m => m.severity === 'warning');
                assert(warns.length === 0, `${name}: no g++ warnings with the build's flags (-std=c++17: the inline globals are standard) (${warns.map(w => w.message).join(' | ')})`);
                const known = KNOWN_GPP_GAPS[name] || [];
                if (r.exitCode === 0) {
                    assert(fs.existsSync(paths.obj) && fs.statSync(paths.obj).size > 0 && cg.recordOwnedFile(paths.dir, name, path.basename(paths.obj)),
                        `${name}: g++ compiles the generated C++ (CPP_Files/${name}.o, recorded as the toolkit's)`);
                    if (known.length) console.log(`[NOTE] ${name}: builds cleanly now — remove its KNOWN_GPP_GAPS entry`);
                } else {
                    const unknown = errs.filter(e => !known.some(re => re.test(e.message)));
                    assert(errs.length > 0 && unknown.length === 0,
                        `${name}: g++ fails only on known compiler gaps (${errs.length} error(s); unknown: ${unknown.map(e => `${path.basename(e.filePath)}:${e.line}: ${e.message}`).join(' | ') || 'none'})`);
                    if (unknown.length) console.log(r.output);
                    // Every error lands on a generated file, at a real line of it.
                    for (const e of errs) {
                        const lines = fs.readFileSync(e.filePath, 'utf8').split(/\r?\n/);
                        assert((e.filePath === paths.cpp || e.filePath === paths.hpp) && e.line >= 1 && e.line <= lines.length,
                            `${name}: the g++ error is placed on ${path.basename(e.filePath)}:${e.line}:${e.column}`);
                    }
                    const member = errs.find(e => /has no member named 'STATE'/.test(e.message));
                    if (member) {
                        const text = fs.readFileSync(member.filePath, 'utf8').split(/\r?\n/)[member.line - 1] || '';
                        assert(text.includes('.STATE'), `${name}: the error's line is the line g++ means (${text.trim()})`);
                    }
                    assert(!fs.existsSync(paths.obj), `${name}: a failed build leaves no object file`);
                    console.log(`[KNOWN] ${name}: ${errs.map(e => e.message).join(' | ')}`);
                }
            }
            // A planted error is reported on its line of the generated .cpp.
            const first = generated[generated.length - 1];
            const text = fs.readFileSync(first.paths.cpp, 'utf8');
            const planted = text.replace(/(namespace strucpp \{\r?\n)/, '$1int plantedError = undeclaredName;\n');
            fs.writeFileSync(first.paths.cpp, planted);
            const plantedLine = planted.split(/\r?\n/).findIndex(l => l.includes('plantedError')) + 1;
            const bad = await gpp.runGpp({ gppPath: found.path, cwd: first.paths.dir,
                args: gpp.buildGppArgs({ cppFile: first.paths.cpp, objFile: first.paths.obj, includeDir: INCLUDE, outDir: first.paths.dir }) });
            const badPlaced = gpp.placeGppMessages(bad.messages, { cwd: first.paths.dir, cppFile: first.paths.cpp, hppFile: first.paths.hpp });
            assert(bad.exitCode !== 0 && badPlaced.some(m => m.severity === 'error' && m.filePath === first.paths.cpp && m.line === plantedLine && /undeclaredName/.test(m.message)),
                `PLANTED: an error planted in ${first.name}.cpp is placed on its line ${plantedLine}`);
            gates.gpp.status = 'ran';
        }

        // ── CPP_Files/.gitignore against a real git (user decision 2026-11-12) ────────────────
        const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
        const git = (args) => childProcess.spawnSync('git', ['-c', `core.excludesFile=${os.devNull}`, ...args], { cwd: copy, env: gitEnv, encoding: 'utf8' });
        const gitVersion = git(['--version']);
        if (gitVersion.error || gitVersion.status !== 0) {
            console.log('[SKIP] .gitignore check: git is not available');
        } else {
            assert(git(['init', '-q']).status === 0, 'GIT: a temporary git repository over the sample copy');
            for (const { name, paths } of generated) {
                const rel = (f) => path.relative(copy, f).split(path.sep).join('/');
                const ignored = [paths.cpp, paths.hpp, paths.obj, paths.manifest].map(rel);
                const r = git(['check-ignore', '-v', '--no-index', ...ignored]);
                const sources = r.stdout.trim().split(/\r?\n/).filter(Boolean);
                assert(r.status === 0 && sources.length === 4 && sources.every(l => l.startsWith(`${rel(path.join(paths.dir, '.gitignore'))}:`)),
                    `GIT: ${name}: git check-ignore ignores the .cpp, .hpp, .o and the record through CPP_Files/.gitignore (${sources.join(' | ')})`);
                const own = path.join(paths.dir, 'notes.txt');
                fs.writeFileSync(own, 'the user\'s own');
                const notIgnored = git(['check-ignore', '--no-index', rel(own), rel(path.join(paths.dir, '.gitignore'))]);
                assert(notIgnored.status === 1 && notIgnored.stdout.trim() === '',
                    `GIT: ${name}: a file of the user's in CPP_Files, and the .gitignore itself, are not ignored`);
                const status = git(['status', '--porcelain', '--untracked-files=all', '--', rel(paths.dir)]);
                const listed = status.stdout.trim().split(/\r?\n/).filter(Boolean).map(l => l.slice(3)).sort();
                assert(status.status === 0 && JSON.stringify(listed) === JSON.stringify([rel(path.join(paths.dir, '.gitignore')), rel(own)].sort()),
                    `GIT: ${name}: git status shows only the .gitignore and the user's file in CPP_Files (${listed.join(', ')})`);
                fs.unlinkSync(own);
            }
            // Only the toolkit's own files are ignored: a generated file the user edited is theirs, and git sees it.
            const relOf = (f) => path.relative(copy, f).split(path.sep).join('/');
            const ed = generated[0];
            const cppOriginal = fs.readFileSync(ed.paths.cpp, 'utf8');
            const regen = () => cg.writeOwnedOutputs({ dir: ed.paths.dir, project: ed.name, files: [
                { name: path.basename(ed.paths.cpp), text: cppOriginal }, { name: path.basename(ed.paths.hpp), text: fs.readFileSync(ed.paths.hpp, 'utf8') }] });
            fs.appendFileSync(ed.paths.cpp, '// my own change\n');
            const we = regen();
            const edCheck = git(['check-ignore', '--no-index', relOf(ed.paths.cpp)]);
            const hppCheck = git(['check-ignore', '--no-index', relOf(ed.paths.hpp)]);
            assert(we.refused.length === 1 && we.refused[0].reason === 'changed' && we.gitignore.status === 'updated' && edCheck.status === 1 && hppCheck.status === 0,
                `GIT: ${ed.name}: an edited .cpp is left alone and no longer ignored; the .hpp still is (${we.gitignore.status}, ${edCheck.status}/${hppCheck.status})`);
            fs.writeFileSync(ed.paths.cpp, cppOriginal);
            const wr = regen();
            assert(wr.refused.length === 0 && wr.gitignore.status === 'updated' && git(['check-ignore', '--no-index', relOf(ed.paths.cpp)]).status === 0,
                `GIT: ${ed.name}: with the edit undone the .cpp is the toolkit's again and ignored again (${wr.gitignore.status})`);
            // A user's own <stem>.o, there before the first write, is not claimed and not ignored.
            const uoDir = path.join(path.dirname(path.dirname(ed.paths.dir)), 'UserObj_PLC', cg.CPP_FILES_DIR); // under the copy's re-admitted sample tree
            fs.mkdirSync(uoDir, { recursive: true });
            fs.writeFileSync(path.join(uoDir, 'U.o'), 'the user\'s object');
            const wu = cg.writeOwnedOutputs({ dir: uoDir, project: 'U', files: [{ name: 'U.cpp', text: cppOriginal }, { name: 'U.hpp', text: 'h\n' }] });
            const uoCheck = git(['check-ignore', '--no-index', relOf(path.join(uoDir, 'U.o'))]);
            const ucCheck = git(['check-ignore', '--no-index', relOf(path.join(uoDir, 'U.cpp'))]);
            assert(wu.gitignore.status === 'created' && cg.claimOutput(uoDir, 'U.o') === 'foreign' && uoCheck.status === 1 && ucCheck.status === 0,
                `GIT: a user's U.o already in CPP_Files is not ignored, while the generated U.cpp is (${uoCheck.status}/${ucCheck.status})`);
            // Deleted by the user: the next generation does not bring it back, and git then sees the files.
            const last = generated[generated.length - 1];
            fs.unlinkSync(path.join(last.paths.dir, '.gitignore'));
            const w2 = cg.writeOwnedOutputs({ dir: last.paths.dir, project: last.name, files: [
                { name: path.basename(last.paths.cpp), text: fs.readFileSync(last.paths.cpp, 'utf8') }, { name: path.basename(last.paths.hpp), text: 'regenerated\n' }] });
            const after = git(['check-ignore', '--no-index', path.relative(copy, last.paths.cpp).split(path.sep).join('/')]);
            assert(w2.gitignore.status === 'not-recreated' && !fs.existsSync(path.join(last.paths.dir, '.gitignore')) && after.status === 1,
                `GIT: ${last.name}: a deleted .gitignore is not recreated, so git no longer ignores the .cpp (${w2.gitignore.status})`);
        }

        // ── A project that uses library blocks (synthetic library on a sample copy) ───────────
        await libraryScenario(tmp, setup, found.ok ? found.path : '');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    assert(JSON.stringify(cppFolders(SAMPLE)) === JSON.stringify(sampleCppBefore), 'sample/ itself is untouched (no CPP_Files written there)');
    finish();
})().catch((e) => { console.error(e); errors++; finish(); });
