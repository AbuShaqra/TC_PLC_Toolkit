/**
 * @file test_cpp_real.js
 * @description The REAL end-to-end gate of C++ generation and the g++ build (roadmap R13): every PLC
 * project of a TEMPORARY COPY of sample/ goes through the same steps Compile Project takes — check
 * units, library preparation, the project's compiler defines, the check (zero errors), the
 * compiler's compile mode, the write into `<project dir>/CPP_Files/` under the ownership record —
 * and, when a g++ is found, g++ compiles each generated `.cpp` against the vendored runtime headers
 * (`resources/compiler/include/`), its messages placed on the generated files as the command does.
 * sample/ itself is never written: the gate asserts it has no CPP_Files afterwards.
 *
 * Two optional gates, reported apart by test/run.js (neither makes a run REDUCED):
 *   - `cpp-real` needs the compiler's Node >= 22 (as test_compile_real.js finds one);
 *   - `gpp-real` also needs g++: `TC_TEST_GPP`, else the same detection the command uses (PATH, then
 *     the usual Windows install folders). Without one it SKIPS and says so.
 *
 * g++ ratchet: a project builds cleanly, or every g++ error is a KNOWN compiler gap listed below
 * (matched by message) — a new g++ error fails the gate, and a gap that no longer occurs is printed
 * so its entry can be removed.
 */

'use strict';

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
const { projectDefineArgs, fileDefineArgs } = require('../src/compilerDefines');

const REPO = path.join(__dirname, '..');
const SAMPLE = path.join(REPO, 'sample');
const DIALECT = path.join(REPO, 'resources', 'dialects', 'twincat3.json');
const INCLUDE = path.join(REPO, 'resources', 'compiler', 'include');

/**
 * g++ errors on correct sample code that are gaps of the compiler's C++ output (its check accepts
 * the code). Each must still be placed on the generated files. Remove an entry once it is fixed.
 */
const KNOWN_GPP_GAPS = {
    // `GVL_System.fbStation.State` (a PROPERTY read through a global FB instance) is emitted as a
    // field access instead of the getter call `get_STATE()` (found 2026-11-12, compiler eb52d2c).
    TcToolkitSample_PLC: [/has no member named 'STATE'/]
};

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
            assert(!/\.st\b/.test(path.basename(paths.cpp)) && fs.readdirSync(paths.dir).sort().join(',') === ['.tc-toolkit-generated.json', `${stem}.cpp`, `${stem}.hpp`].sort().join(','),
                `${project.name}: CPP_Files holds the two files and the ownership record, nothing from the compiler's temporary directory`);
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
                assert(warns.length === 0, `${name}: no g++ warnings with the build's flags (-Wno-c++17-extensions silences the inline globals) (${warns.map(w => w.message).join(' | ')})`);
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
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    assert(JSON.stringify(cppFolders(SAMPLE)) === JSON.stringify(sampleCppBefore), 'sample/ itself is untouched (no CPP_Files written there)');
    finish();
})().catch((e) => { console.error(e); errors++; finish(); });
