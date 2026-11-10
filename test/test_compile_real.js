/**
 * @file test_compile_real.js
 * @description The REAL-compiler gate of Compile Project: runs an external IEC 61131-3 compiler over
 * the committed sample, through the same code the command uses (`src/compileCheck.js`).
 *
 * It runs only when `TWINCAT_COMPILER_BUNDLE` names the compiler's bundled command-line file and a
 * Node >= 22 is available (`TWINCAT_COMPILER_NODE`, else `node` on PATH); otherwise it SKIPS and
 * says so. CI has no compiler, so this gate is optional in test/run.js — it is listed in the run
 * summary as ran or skipped, and never makes a run REDUCED.
 *
 * Asserted:
 *   - the sample is a CORRECT TwinCAT project, so the compiler reports ZERO errors on it (a ratchet,
 *     like the diagnostics baseline — an error here is a bug in the unit, the dialect profile or the
 *     compiler, and must not be answered by suppressing it);
 *   - the only warnings filtered are the pragma-skipped ones, and nothing else is left;
 *   - an error planted in one method is reported on that file, component, pane and line;
 *   - an error planted in a declaration pane and in a GVL land there too.
 */

const fs = require('fs');
const path = require('path');
const { reportCoverage } = require('./_coverage');
const { parseTwinCatXml } = require('../src/xmlParser');
const { createProjectMap } = require('../src/lsp/projectMap');
const cc = require('../src/compileCheck');

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
    if (!bundle) skip('TWINCAT_COMPILER_BUNDLE is not set');
    if (!fs.existsSync(sampleDir)) skip('sample/ is absent');
    const setup = await cc.checkSetup({ compilerPath: bundle, nodePath: process.env.TWINCAT_COMPILER_NODE || '' });
    if (!setup.ok) skip(setup.problems.map(p => p.message).join(' '));

    const projectMap = createProjectMap([sampleDir]);
    const project = [...projectMap.projects.values()][0];
    const filePaths = [...project.objectFiles.values()].sort();
    const read = (edit) => filePaths.map(filePath => {
        const text = fs.readFileSync(filePath, 'utf8');
        return { filePath, text: edit ? edit(filePath, text) : text };
    });
    const check = async (edit) => {
        const built = cc.buildCheckInputs(read(edit), parseTwinCatXml);
        const result = await cc.runCheck({ nodeCommand: setup.nodeCommand, compilerPath: setup.compilerPath, dialectFile, inputs: built.inputs });
        return { built, result };
    };
    const show = (d) => `${path.basename(d.filePath || '?')} ${d.componentId || ''} ${d.pane || ''}:${d.line}:${d.column} ${d.severity}: ${d.message}`;

    // ── The ratchet: zero errors on the sample ──────────────────────────────────────────────────
    const clean = await check(null);
    assert(clean.result.status === 'done', `the check ran (${clean.result.status}${clean.result.message ? ': ' + clean.result.message : ''})`);
    assert(clean.built.inputs.length === filePaths.length && clean.built.unparsed.length === 0,
        `all ${filePaths.length} sample objects became check units`);
    for (const d of [...clean.result.diagnostics, ...clean.result.general]) console.log(`    ${show(d)}`);
    assert(clean.result.errors <= SAMPLE_ERROR_BASELINE,
        `SAMPLE: ${clean.result.errors} error(s) against a baseline of ${SAMPLE_ERROR_BASELINE} — every error on the sample is a bug`);
    assert(clean.result.warnings <= SAMPLE_WARNING_BASELINE,
        `SAMPLE: ${clean.result.warnings} warning(s) after the filter, against a baseline of ${SAMPLE_WARNING_BASELINE}`);
    console.log(`    filtered pragma warnings: ${clean.result.filteredPragmaWarnings}; ${clean.result.durationMs} ms`);
    assert(clean.result.general.length === 0, 'SAMPLE: no diagnostic is left without a file');

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

    // The same position, found in the XML document (what the Problems panel points at).
    if (e.filePath) {
        const text = plantIn('FB_Cylinder.TcPOU', 'refExtendOut := TRUE;', 'refExtendOut := TRUE;\r\nnNotDeclared := 5;')(e.filePath, fs.readFileSync(e.filePath, 'utf8'));
        const comp = parseTwinCatXml(text).components.find(c => c.id === e.componentId);
        const range = cc.xmlRangeFor(text, comp.xmlContext, e);
        const line = text.split(/\r\n|\r|\n/)[range.start.line] || '';
        assert(line.substring(range.start.character).startsWith('nNotDeclared := 5;'), `PLANT: the XML range starts at the planted statement (${JSON.stringify(line)})`);
    }

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

    reportCoverage(GATE, 'ran');
    if (errors > 0) {
        console.error(`\n${errors} real-compiler assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll real-compiler assertions passed.');
})().catch((err) => { console.error(err); process.exit(1); });
