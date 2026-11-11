/**
 * @file test_compile_real.js
 * @description The REAL-compiler gate of Compile Project: runs an external IEC 61131-3 compiler over
 * the committed sample, through the same code the command uses (`src/compileCheck.js`).
 *
 * It runs the compiler that ships with the extension (`resources/compiler/compiler.cjs`), or the one
 * `TWINCAT_COMPILER_BUNDLE` names instead (an override, like the `tcToolkit.compiler.path` setting).
 * It needs a Node >= 22, found as the command finds one (`TWINCAT_COMPILER_NODE`, else `node` on
 * PATH, the usual install locations, then this process's own runtime); without one it SKIPS and
 * says so. It stays optional in test/run.js (CI's Node 16/20 legs skip it) — it is listed in the run
 * summary as ran or skipped, and never makes a run REDUCED.
 *
 * Asserted:
 *   - the bundled IEC standard libraries are found (TON, R_TRIG, LIMIT resolve; an unknown FB does not);
 *   - every PLC project under sample/ (two today: TcToolkitSample, 3.1.4026 layout, and
 *     TcToolkitSample2, 3.1.4024 layout) is checked on its own, as the command checks one project per
 *     run;
 *   - each is a CORRECT TwinCAT project, so the compiler reports ZERO errors on it (a ratchet,
 *     like the diagnostics baseline — an error here is a bug in the unit, the dialect profile or the
 *     compiler, and must not be answered by suppressing it);
 *   - the only warnings filtered are the pragma-skipped ones, and nothing else is left;
 *   - an error planted in one method is reported on that file, component, pane and line;
 *   - an error planted in a declaration pane and in a GVL land there too;
 *   - in the second sample, calling a method only the first sample's same-named FB_Cylinder has is an
 *     error there — the projects are never compiled together;
 *   - library declarations (R3.4, src/libraryDecls.js), on a project that calls a SYNTHETIC library
 *     through a synthetic signatures dump, `.tmc` and archive (test/_synthLibProject.js): correct
 *     calls give zero errors (and many without the declarations); a wrong argument type and an
 *     unknown parameter on a library call ARE reported; a library name with no declaration is
 *     filtered; a user typo is still reported; without the dump the correct project stays at zero.
 *     The sample runs go through the same library preparation as the command;
 *   - compiler defines, on a temporary copy of the second sample whose MAIN has `{IF defined(X)}` and
 *     `{IF hasvalue(X, 'v')}` blocks and whose .plcproj carries `<CompilerDefines>`: read through the
 *     command's own reader (src/compilerDefines.js), the defines select the branches (no defines →
 *     the ELSE branches' planted errors; the right defines → 0 errors; wrong case or value → ELSE
 *     again); a malformed entry is skipped; an integer value declares no global constant; a
 *     Debug-conditioned property group's define selects its branch, a Release-only one does not.
 */

const fs = require('fs');
const path = require('path');
const { reportCoverage } = require('./_coverage');
const { parseTwinCatXml } = require('../src/xmlParser');
const { createProjectMap } = require('../src/lsp/projectMap');
const cc = require('../src/compileCheck');
const { prepareLibraryCheck } = require('../src/libraryDecls');
const { buildSynthLibProject } = require('./_synthLibProject');
const { projectDefineArgs } = require('../src/compilerDefines');

const GATE = 'compile-real';
const bundle = process.env.TWINCAT_COMPILER_BUNDLE || '';
const sampleDir = path.join(__dirname, '..', 'sample');
const dialectFile = path.join(__dirname, '..', 'resources', 'dialects', 'twincat3.json');

/** Errors allowed on the sample. It is a correct project: zero, with no slack. */
const SAMPLE_ERROR_BASELINE = 0;
/** Warnings allowed on the sample after the pragma filter. */
const SAMPLE_WARNING_BASELINE = 0;

function skip(reason) {
    console.log(`[SKIP] real-compiler gate: ${reason}`);
    reportCoverage(GATE, 'skipped', reason);
    process.exit(0);
}

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

(async () => {
    if (!fs.existsSync(sampleDir)) skip('sample/ is absent');
    const setup = await cc.checkSetup({ compilerPath: bundle, nodePath: process.env.TWINCAT_COMPILER_NODE || '' });
    if (!setup.ok) skip(setup.problems.map(p => p.message).join(' '));
    console.log(`    compiler: ${setup.compilerBundled ? 'bundled' : 'override'} ${setup.compilerPath}; Node ${setup.nodeVersion} (${setup.nodeLabel})`);
    if (!bundle) assert(setup.compilerBundled && setup.compilerPath === cc.bundledCompilerPath(), 'with no override, the gate runs the bundled compiler');

    // ── The bundled libraries: IEC standard FBs and functions resolve, anything else does not ──
    {
        const pou = (decl, impl) => cc.buildCheckInputs([{ filePath: path.join(sampleDir, 'P_Libs.TcPOU'), text:
            `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <POU Name="P_Libs" Id="{00000000-0000-0000-0000-000000000001}" SpecialFunc="None">\r\n` +
            `    <Declaration><![CDATA[${decl}]]></Declaration>\r\n    <Implementation><ST><![CDATA[${impl}]]></ST></Implementation>\r\n  </POU>\r\n</TcPlcObject>` }], parseTwinCatXml).inputs;
        const ok = await cc.runCheck({ nodeCommand: setup.nodeCommand, nodeEnv: setup.nodeEnv, compilerPath: setup.compilerPath, dialectFile,
            inputs: pou('PROGRAM P_Libs\r\nVAR\r\n\tt : TON;\r\n\tr : R_TRIG;\r\n\tc : CTU;\r\n\tx : INT;\r\nEND_VAR', 't(IN := TRUE, PT := T#1S);\r\nx := LIMIT(0, x, 5);') });
        assert(ok.status === 'done' && ok.errors === 0, `LIBS: TON, R_TRIG, CTU and LIMIT resolve from the bundled libraries (${ok.status} ${ok.message} ${ok.errors} error(s))`);
        const bad = await cc.runCheck({ nodeCommand: setup.nodeCommand, nodeEnv: setup.nodeEnv, compilerPath: setup.compilerPath, dialectFile,
            inputs: pou('PROGRAM P_Libs\r\nVAR\r\n\tp : PID;\r\nEND_VAR', '') });
        assert(bad.status === 'done' && bad.errors === 1, `LIBS: a function block from a library that is NOT shipped (PID) is an error (${bad.errors})`);
    }

    const projectMap = createProjectMap([sampleDir]);
    const projects = [...projectMap.projects.values()].sort((a, b) => a.dir.localeCompare(b.dir));
    assert(projects.length >= 2, `sample/ holds every sample PLC project (${projects.map(p => p.name).join(', ')})`);
    const filesOf = (project) => [...project.objectFiles.values()].sort();
    const read = (filePaths, edit) => filePaths.map(filePath => {
        const text = fs.readFileSync(filePath, 'utf8');
        return { filePath, text: edit ? edit(filePath, text) : text };
    });
    // As the command runs it: the library preparation first (projectDir/roots), then the check.
    const checkFiles = async (filePaths, edit, libraryOptions, defineArgs) => {
        const built = cc.buildCheckInputs(read(filePaths, edit), parseTwinCatXml);
        const lib = libraryOptions === null ? null
            : prepareLibraryCheck({ projectDir: (libraryOptions && libraryOptions.projectDir) || path.dirname(filePaths[0]),
                roots: (libraryOptions && libraryOptions.roots) || [sampleDir], inputs: built.inputs, compilerPath: setup.compilerPath });
        const result = await cc.runCheck({ nodeCommand: setup.nodeCommand, nodeEnv: setup.nodeEnv, compilerPath: setup.compilerPath, dialectFile,
            inputs: lib ? lib.inputs : built.inputs, extraFiles: lib ? lib.extraFiles : [], libraryFilter: lib ? lib.filter : undefined, defineArgs });
        return { built, result, lib };
    };
    const show = (d) => `${path.basename(d.filePath || '?')} ${d.componentId || ''} ${d.pane || ''}:${d.line}:${d.column} ${d.severity}: ${d.message}`;

    // ── The ratchet: zero errors on every sample project ────────────────────────────────────────
    for (const project of projects) {
        const filePaths = filesOf(project);
        const started = Date.now();
        const clean = await checkFiles(filePaths, null, { projectDir: project.dir, roots: [sampleDir] });
        const tag = project.name;
        assert(clean.result.status === 'done', `${tag}: the check ran (${clean.result.status}${clean.result.message ? ': ' + clean.result.message : ''})`);
        assert(clean.built.inputs.length === filePaths.length && clean.built.unparsed.length === 0,
            `${tag}: all ${filePaths.length} objects became check units`);
        for (const d of [...clean.result.diagnostics, ...clean.result.general]) console.log(`    ${show(d)}`);
        assert(clean.result.errors <= SAMPLE_ERROR_BASELINE,
            `${tag}: ${clean.result.errors} error(s) against a baseline of ${SAMPLE_ERROR_BASELINE} — every error on the sample is a bug`);
        assert(clean.result.warnings <= SAMPLE_WARNING_BASELINE,
            `${tag}: ${clean.result.warnings} warning(s) after the filter, against a baseline of ${SAMPLE_WARNING_BASELINE}`);
        console.log(`    ${tag}: filtered pragma warnings: ${clean.result.filteredPragmaWarnings}; library: ${clean.lib.extraFiles.length} declaration(s), ` +
            `${clean.result.filteredLibraryDiagnostics} filtered, preparation ${clean.lib.stats.ms} ms; check ${clean.result.durationMs} ms; total ${Date.now() - started} ms`);
        assert(clean.result.filteredLibraryDiagnostics === 0 && clean.result.libraryMessages.length === 0,
            `${tag}: the library filter drops nothing on the sample, and no generated declaration draws a message`);
        assert(clean.result.general.length === 0, `${tag}: no diagnostic is left without a file`);
    }

    // The planted errors below are written against the FIRST sample's objects.
    const first = projects.find(p => /[\\/]TcToolkitSample[\\/]/i.test(p.dir + path.sep)) || projects[0];
    const check = (edit) => checkFiles(filesOf(first), edit, { projectDir: first.dir, roots: [sampleDir] });

    // ── A planted error in a method body ────────────────────────────────────────────────────────
    const plantIn = (basename, from, to) => (filePath, text) => {
        if (path.basename(filePath) !== basename) return text;
        if (!text.includes(from)) throw new Error(`fixture drift: ${basename} no longer contains ${JSON.stringify(from)}`);
        return text.replace(from, to);
    };
    let planted = await check(plantIn('FB_Cylinder.TcPOU', 'refExtendOut := TRUE;', 'refExtendOut := TRUE;\r\nnNotDeclared := 5;'));
    let errs = planted.result.diagnostics.filter(d => d.severity === 'error');
    for (const d of errs) console.log(`    ${show(d)}`);
    assert(planted.result.status === 'done' && errs.length === 1, `PLANT: one planted error gives exactly one error (${errs.length})`);
    const e = errs[0] || {};
    assert(path.basename(e.filePath || '') === 'FB_Cylinder.TcPOU' && e.componentId === 'method_Extend' && e.pane === 'impl' && e.line === 2 && e.exact === true,
        `PLANT: it is reported in FB_Cylinder.TcPOU, method Extend, implementation pane, line 2 (${show(e)})`);
    assert(/nnotdeclared/i.test(e.message || ''), `PLANT: the message names the undeclared variable (${e.message})`);

    // ── A planted error in a declaration pane ───────────────────────────────────────────────────
    planted = await check(plantIn('FB_Cylinder.TcPOU', 'METHOD Extend : BOOL\r\nVAR\r\n', 'METHOD Extend : BOOL\r\nVAR\r\n\tx : T_NoSuchType;\r\n'));
    errs = planted.result.diagnostics.filter(d => d.severity === 'error');
    for (const d of errs) console.log(`    ${show(d)}`);
    assert(errs.length >= 1 && errs.every(d => path.basename(d.filePath) === 'FB_Cylinder.TcPOU') &&
        errs.some(d => d.componentId === 'method_Extend' && d.pane === 'decl' && d.line === 3),
        'PLANT: an unknown type in a method declaration is reported in that declaration pane, line 3');

    // ── A planted error in a global variable list ───────────────────────────────────────────────
    planted = await check(plantIn('GVL_Hmi.TcGVL', '\tbEnable\t\t: BOOL;', '\tbEnable\t\t: BOOL_NOPE;'));
    errs = planted.result.diagnostics.filter(d => d.severity === 'error');
    for (const d of errs) console.log(`    ${show(d)}`);
    assert(errs.length >= 1 && errs.some(d => path.basename(d.filePath) === 'GVL_Hmi.TcGVL' && d.componentId === 'root' && d.pane === 'decl' && d.line === 4),
        'PLANT: an unknown type in a GVL is reported in that GVL, declaration pane, line 4');

    // ── A planted error in the SECOND sample, naming a member only the FIRST sample's FB_Cylinder has ──
    // Each project is its own compilation unit: Retract() exists on the other project's FB_Cylinder
    // only, so it must be reported, and in the second sample's MAIN.
    const second = projects.find(p => p !== first);
    if (second) {
        planted = await checkFiles(filesOf(second), plantIn('MAIN.TcPOU', 'nStroke := fbCylinder.Stroke();', 'nStroke := fbCylinder.Stroke();\r\nfbCylinder.Retract();'));
        errs = planted.result.diagnostics.filter(d => d.severity === 'error');
        for (const d of errs) console.log(`    ${show(d)}`);
        assert(errs.length >= 1 && errs.every(d => d.filePath.startsWith(second.dir)) &&
            errs.some(d => path.basename(d.filePath) === 'MAIN.TcPOU' && d.componentId === 'root' && d.pane === 'impl' && d.line === 11),
            `PLANT (${second.name}): a method of the OTHER project's FB_Cylinder is an error in this project's MAIN, implementation line 11`);
    }

    // ── Compiler defines: a temp copy of the second sample with {IF} blocks and <CompilerDefines> ──
    // The defines come from the copy's .plcproj through the command's own reader (compilerDefines.js);
    // the branch they select decides whether the planted undeclared name is compiled at all.
    if (second) {
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tc_compile_defines_'));
        try {
            const copyDir = path.join(tmp, path.basename(second.dir));
            fs.cpSync(second.dir, copyDir, { recursive: true });
            const mainPath = path.join(copyDir, 'POUs', 'MAIN.TcPOU');
            const anchorLine = 'nStroke := fbCylinder.Stroke();';
            const mainText = fs.readFileSync(mainPath, 'utf8');
            if (!mainText.includes(anchorLine)) throw new Error(`fixture drift: MAIN.TcPOU no longer contains ${anchorLine}`);
            fs.writeFileSync(mainPath, mainText.replace(anchorLine, anchorLine + [
                '', '{IF defined(TkSim)}', 'nStroke := 1;', '{ELSE}', 'nSimOff := 1;', '{END_IF}',
                "{IF hasvalue(TkMode, 'fast')}", 'nStroke := 2;', '{ELSE}', 'nModeOff := 1;', '{END_IF}'].join('\r\n')));
            const plcprojPath = fs.readdirSync(copyDir).filter(f => /\.plcproj$/i.test(f)).map(f => path.join(copyDir, f))[0];
            const plcprojText = fs.readFileSync(plcprojPath, 'utf8');
            const runWith = async (definesXml, groupsXml = '') => {
                const withDefines = definesXml === null ? plcprojText
                    : plcprojText.replace('</PropertyGroup>', `  <CompilerDefines>${definesXml}</CompilerDefines>\r\n  </PropertyGroup>`);
                fs.writeFileSync(plcprojPath, groupsXml ? withDefines.replace('</PropertyGroup>', `</PropertyGroup>\r\n${groupsXml}`) : withDefines);
                const map = createProjectMap([tmp]);
                const proj = [...map.projects.values()][0];
                const defines = projectDefineArgs(proj.plcprojPath);
                const r = await checkFiles([...proj.objectFiles.values()].sort(), null, { projectDir: proj.dir, roots: [tmp] }, defines.args);
                const names = r.result.diagnostics.filter(d => d.severity === 'error').map(d => (/'(\w+)'/.exec(d.message) || [])[1] || d.message);
                return { r, defines, names };
            };
            let d = await runWith(null);
            assert(d.r.result.status === 'done' && d.defines.args.length === 0 && d.names.join() === 'NSIMOFF,NMODEOFF',
                `DEFINES: with no <CompilerDefines> both ELSE branches compile, and their undeclared names are errors (${d.names.join(', ')})`);
            const simLine = d.r.result.diagnostics.find(x => /NSIMOFF/i.test(x.message));
            assert(!!simLine && path.basename(simLine.filePath) === 'MAIN.TcPOU' && simLine.pane === 'impl' && simLine.line === 14,
                `DEFINES: the error is placed on its line in MAIN's implementation pane (${simLine ? show(simLine) : 'none'})`);
            d = await runWith("TkSim, TkMode := 'fast'");
            assert(d.r.result.status === 'done' && d.defines.args.join(' ') === '-D TkSim -D TkMode=fast' && d.r.result.errors === 0,
                `DEFINES: with "TkSim, TkMode := 'fast'" in the .plcproj both IF branches compile: 0 errors (${d.defines.args.join(' ')}; ${d.names.join(', ')})`);
            d = await runWith("TKSIM, TkMode := 'slow'");
            assert(d.r.result.status === 'done' && d.names.join() === 'NSIMOFF,NMODEOFF',
                `DEFINES: names are case-sensitive and hasvalue compares the value: TKSIM / 'slow' select the ELSE branches (${d.names.join(', ')})`);
            d = await runWith("TkSim, TkMode := 'fast', 9bad");
            assert(d.r.result.status === 'done' && d.r.result.errors === 0 && d.defines.notes.length === 1 && /"9bad" skipped/.test(d.defines.notes[0]),
                'DEFINES: a malformed entry is skipped with a note; the run still uses the others');
            // TwinCAT: a define is never a variable. `-D nSimOff=3` would also declare a global constant
            // nSimOff, and the ELSE branch's `nSimOff := 1` would read "Cannot assign to CONSTANT variable".
            d = await runWith("nSimOff := '3'");
            const simMsg = (d.r.result.diagnostics.find(x => x.severity === 'error' && /NSIMOFF/i.test(x.message)) || { message: '' }).message;
            assert(d.r.result.status === 'done' && d.defines.args.join(' ') === '-D nSimOff' && d.names.join() === 'NSIMOFF,NMODEOFF' &&
                /Undeclared variable/i.test(simMsg) && !/CONSTANT/i.test(simMsg),
                `DEFINES: an integer value is passed as a name only, so it declares no global constant (${d.defines.args.join(' ')}; ${simMsg})`);
            // Conditions are evaluated for Debug | TwinCAT RT (x64): a Debug group selects the IF branch, a Release one does not.
            d = await runWith(null, "  <PropertyGroup Condition=\" '$(Configuration)|$(Platform)' == 'Debug|TwinCAT RT (x64)' \">\r\n" +
                '    <CompilerDefines>TkSim</CompilerDefines>\r\n  </PropertyGroup>\r\n' +
                "  <PropertyGroup Condition=\" '$(Configuration)' == 'Release' \">\r\n    <CompilerDefines>$(CompilerDefines), TkMode := 'fast'</CompilerDefines>\r\n  </PropertyGroup>");
            assert(d.r.result.status === 'done' && d.defines.args.join(' ') === '-D TkSim' && d.defines.notes.length === 0 && d.names.join() === 'NMODEOFF',
                `DEFINES: a Debug-conditioned define selects its IF branch, a Release-only one does not, and neither gives a note (${d.defines.args.join(' ')}; ${d.names.join(', ')})`);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // ── Library declarations (R3.4) on a synthetic library ──────────────────────────────────────
    {
        const synth = (options) => buildSynthLibProject(options);
        const runSynth = async (options, withLibrary = true) => {
            const p = synth(options);
            try {
                const r = await checkFiles(p.files, null, withLibrary ? { projectDir: p.projectDir, roots: [p.ws] } : null);
                return { ...r, p };
            } finally { p.cleanup(); }
        };
        const plantMain = (extra) => ({ edit: (name, o) => (name === 'MAIN' ? { decl: o.decl, impl: `${o.impl}\r\n${extra}` } : o) });
        const libErrs = (r) => r.result.diagnostics.filter(d => d.severity === 'error');

        const before = await runSynth({}, false);
        assert(before.result.status === 'done' && before.result.errors >= 3,
            `LIB: without library declarations the correct project has errors (${before.result.errors})`);
        const ok = await runSynth({});
        for (const d of [...ok.result.diagnostics, ...ok.result.general]) console.log(`    ${show(d)}`);
        assert(ok.result.status === 'done' && ok.result.errors === 0 && ok.result.warnings === 0,
            `LIB: with them the correct calls give 0 errors (${ok.result.errors}), ${ok.lib.extraFiles.length} declaration(s), ${ok.result.filteredLibraryDiagnostics} filtered, ${ok.result.durationMs} ms`);
        assert(ok.result.filteredLibraryDiagnostics >= 2 && ok.result.libraryMessages.length === 0,
            `LIB: library names with no declaration are filtered (${ok.result.filteredLibraryDiagnostics}); every generated declaration compiles (${ok.result.libraryMessages.map(m => m.message).join('; ')})`);

        const { MAIN_IMPL } = require('./_synthLibProject');
        const plantLine = MAIN_IMPL.split('\r\n').length + 1;
        let r = await runSynth(plantMain('fDist := F_SynDistance(stFrom := stLimits, stTo := stPos);'));
        let le = libErrs(r);
        for (const d of le) console.log(`    ${show(d)}`);
        assert(le.length === 1 && path.basename(le[0].filePath) === 'MAIN.TcPOU' && le[0].pane === 'impl' && le[0].line === plantLine && /ST_SYNLIMITS/i.test(le[0].message),
            'LIB: a wrong argument type on a library function call IS reported, in MAIN\'s implementation pane');
        r = await runSynth(plantMain('nSum := F_SynAdd(nA := 1, nC := 2);'));
        le = libErrs(r);
        assert(le.length === 1 && le[0].line === plantLine && /NC/.test(le[0].message), 'LIB: an unknown parameter on a library call IS reported');
        r = await runSynth(plantMain('nSum := SynMotion.F_SynAdd(nA := 1, nB := 2) + F_SynArchiveOnly(3);'));
        le = libErrs(r);
        assert(le.length === 0 && r.result.filteredLibraryDiagnostics > ok.result.filteredLibraryDiagnostics,
            `LIB: a library name known only from an archive (no declaration) is filtered; the qualified call checks (${le.length} error(s))`);
        r = await runSynth(plantMain('nSumm := 1;'));
        le = libErrs(r);
        assert(le.length === 1 && le[0].line === plantLine && le[0].column === 1 && /NSUMM/.test(le[0].message), 'LIB: a user typo is still reported, at its line and column');
        r = await runSynth(plantMain('fbAxis.ActSynHomeX();'));
        le = libErrs(r);
        assert(le.length === 1 && /ACTSYNHOMEX/.test(le[0].message), 'LIB: a typo in a member of a library function block is still reported');
        const qualified = 'nSum := SynMotion.F_SynNope(1);';
        r = await runSynth(plantMain(qualified));
        le = libErrs(r);
        for (const d of le) console.log(`    ${show(d)}`);
        assert(le.length === 1 && le[0].line === plantLine && le[0].column === qualified.indexOf('F_SynNope') + 1 && /F_SYNNOPE/.test(le[0].message),
            'LIB: an unknown name behind a library qualifier is reported, at its column in the pane (the qualifier is blanked, not removed)');
        const noDump = await runSynth({ withDump: false });
        for (const d of [...noDump.result.diagnostics, ...noDump.result.general]) console.log(`    ${show(d)}`);
        assert(noDump.result.status === 'done' && noDump.result.errors === 0 && !noDump.lib.hasSignatures,
            `LIB: without the dump the correct project stays at 0 errors (${noDump.result.errors}; ${noDump.result.filteredLibraryDiagnostics} filtered)`);
    }

    reportCoverage(GATE, 'ran');
    if (errors > 0) {
        console.error(`\n${errors} real-compiler assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll real-compiler assertions passed.');
})().catch((err) => { console.error(err); process.exit(1); });
