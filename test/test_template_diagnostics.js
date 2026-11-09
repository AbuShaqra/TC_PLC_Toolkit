/**
 * @file test_template_diagnostics.js
 * @description A project made by "Create New Project" (src/projectTemplate.js) is correct TwinCAT, so
 * — exactly like `sample/` — every diagnostic the language server reports on it is a bug. For both
 * shipped templates this creates a project in a temp folder, indexes it the way the server does
 * (`.plcproj` namespaces, library archives, `.tmc`, then each object through the raw live-path unit)
 * and requires ZERO diagnostics, with every check switched on. It then makes the first edit a user
 * makes — a variable in `GVL_Main` (a `qualified_only` list) used from `MAIN` as `GVL_Main.x` — and
 * requires zero again.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TEMPLATE_VERSIONS, createProject, templateDirFor } = require('../src/projectTemplate');
const { parseTwinCatXml, replaceComponentCdata } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideDiagnostics, setDiagnosticsConfig } = require('../src/lsp/features');
const { createProjectMap } = require('../src/lsp/projectMap');
const { indexSampleLibraries, syncDocument, walkTwinCatFiles } = require('./_baseline');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_template_diag_'));
const TEMPLATES = path.join(__dirname, '..', 'resources', 'templates');

/**
 * Indexes a project directory and diagnoses every object, as test_sample_diagnostics.js does.
 * @param {string} dir
 * @returns {{files: number, symbols: string[], diags: Array<{file: string, message: string, line: number}>}}
 */
function diagnoseProject(dir) {
    clearWorkspaceIndex();
    indexSampleLibraries(dir);
    const index = getWorkspaceSymbolIndex();
    const files = walkTwinCatFiles(dir);
    const units = [];
    for (const file of files) {
        const xml = fs.readFileSync(file, 'utf8');
        const parsed = parseTwinCatXml(xml);
        if (!parsed) throw new Error(`could not parse ${file}`);
        const { stText } = convertXmlToSt(parsed, { raw: true });
        const fileUri = 'file:///' + file.replace(/\\/g, '/').replace(/^\//, '');
        indexXmlObject(index, xml, fileUri);
        units.push({ file, stText, fileUri });
    }
    const diags = [];
    for (const u of units) {
        syncDocument(index, u.stText, u.fileUri);
        for (const d of provideDiagnostics(u.stText, index, u.fileUri)) {
            diags.push({ file: path.relative(dir, u.file), message: d.message, line: d.range.start.line + 1 });
        }
    }
    return { files: files.length, symbols: Object.keys(index), diags };
}

/**
 * Replaces one CDATA block of an object file in place, through the extension's own byte-preserving
 * writer — the path an edit in the custom editor takes.
 * @param {string} file
 * @param {string} blockType 'Declaration' | 'Implementation'
 * @param {string} content
 */
function editBlock(file, blockType, content) {
    const xml = fs.readFileSync(file, 'utf8');
    const out = replaceComponentCdata(xml, {}, blockType, content);
    if (out === xml) throw new Error(`edit of ${blockType} in ${file} changed nothing`);
    fs.writeFileSync(file, out, 'utf8');
}

setDiagnosticsConfig({ memberAccess: true, callArguments: true, declarationTypes: true, typeCompatibility: true });

for (const version of TEMPLATE_VERSIONS) {
    const label = `[${version.id}]`;
    const location = path.join(ROOT, version.dir);
    fs.mkdirSync(location, { recursive: true });
    const created = createProject({ templateDir: templateDirFor(TEMPLATES, version.id), location, name: 'Cell_7' });

    const projectMap = createProjectMap([created.targetDir]);
    const project = [...projectMap.projects.values()][0];
    assert(projectMap.projects.size === 1 && project && project.objectFiles.size === 2,
        `${label} the language server's project map owns the new PLC project and its two objects`);

    const first = diagnoseProject(created.targetDir);
    assert(first.files === 2, `${label} two objects indexed (MAIN, GVL_Main): ${first.files}`);
    assert(['main', 'gvl_main'].every(s => first.symbols.some(k => k.toLowerCase() === s)), `${label} MAIN and GVL_Main are in the symbol index`);
    assert(first.diags.length === 0, `${label} ZERO diagnostics on the new project (${first.diags.map(d => `${d.file}:${d.line} ${d.message}`).join('; ') || 'none'})`);

    // The first edit a user makes.
    const plcDir = path.dirname(created.plcprojPath);
    const gvl = path.join(plcDir, 'GVLs', 'GVL_Main.TcGVL');
    const main = path.join(plcDir, 'POUs', 'MAIN.TcPOU');
    editBlock(gvl, 'Declaration', "{attribute 'qualified_only'}\r\nVAR_GLOBAL\r\n\tnCount\t: INT;\r\n\tbRun\t: BOOL;\r\nEND_VAR");
    editBlock(main, 'Implementation', 'IF GVL_Main.bRun THEN\r\n\tGVL_Main.nCount := GVL_Main.nCount + 1;\r\nEND_IF');
    const second = diagnoseProject(created.targetDir);
    assert(second.diags.length === 0, `${label} ZERO diagnostics after using GVL_Main.x from MAIN (${second.diags.map(d => `${d.file}:${d.line} ${d.message}`).join('; ') || 'none'})`);

    // And the check is live, not blind: an undeclared name IS reported.
    editBlock(main, 'Implementation', 'GVL_Main.nCount := nNoSuchVariable;');
    const third = diagnoseProject(created.targetDir);
    assert(third.diags.some(d => /nNoSuchVariable/.test(d.message)), `${label} the same pipeline does report a real error (${third.diags.length} diagnostic(s))`);
}

fs.rmSync(ROOT, { recursive: true, force: true });
if (errors) {
    console.error(`\n${errors} failure(s)`);
    process.exit(1);
}
console.log('\nAll template diagnostics tests passed.');
