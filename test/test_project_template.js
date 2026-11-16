/**
 * @file test_project_template.js
 * @description "Create New Project" from the shipped templates (src/projectTemplate.js, roadmap R2):
 * every identity GUID re-issued consistently, every type GUID kept, no template name left, BOMs and
 * line endings preserved byte-for-byte, both template shapes (`.tspproj` for 3.1.4024, `.tsproj` +
 * `_Config/` for 3.1.4026), name validation, and refusal of a target that already holds a solution.
 * Also checks the committed templates are what scripts/build-project-templates.js derives.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    TEMPLATE_VERSIONS, validateProjectName, readTemplate, inventoryGuids, planProject,
    checkTarget, createProject, templateDirFor, decodeText, listFiles
} = require('../src/projectTemplate');
const { createProjectMap } = require('../src/lsp/projectMap');
const { createSolutionMap } = require('../src/solutionMap');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const TEMPLATES = path.join(__dirname, '..', 'resources', 'templates');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_project_template_'));
const GUID_RE = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

/** Deterministic GUID source for tests. */
function counterGuids() {
    let n = 0;
    return () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
}

// ── Name validation ─────────────────────────────────────────────────────────────────────────────
assert(validateProjectName('Machine_1') === null, 'a plain identifier is accepted');
assert(validateProjectName('_Line') === null, 'a leading underscore is accepted');
for (const bad of ['', '1Machine', 'My Machine', 'Machine-1', 'Mäschine', 'a__b', 'Line_', 'CON', 'lpt1', 'x'.repeat(49), '../evil']) {
    assert(typeof validateProjectName(bad) === 'string', `"${bad.slice(0, 20)}" is refused`);
}

// ── The committed templates are exactly what the build script derives ──────────────────────────
{
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-project-templates.js'), '--check'], { encoding: 'utf8' });
    assert(r.status === 0, `committed templates match scripts/build-project-templates.js --check (${(r.stdout + r.stderr).trim()})`);
}

for (const version of TEMPLATE_VERSIONS) {
    const templateDir = templateDirFor(TEMPLATES, version.id);
    const label = `[${version.id}]`;
    const template = readTemplate(templateDir);
    const inv = inventoryGuids(template.files);

    assert(inv.unclassified.length === 0 && inv.conflicts.length === 0,
        `${label} every template GUID is classified (${inv.regen.size} identity, ${inv.keep.size} kept)`);
    assert(!template.files.some(f => /\.tmc$/i.test(f.rel)), `${label} the template ships no .tmc`);
    // The identity set must cover the system project, the PLC project's ids, the task and both objects.
    assert(inv.regen.size >= 15, `${label} identity GUIDs found: ${inv.regen.size}`);

    const plan = planProject({ templateDir, name: 'Line_A', newGuid: counterGuids() });
    const outRels = plan.files.map(f => f.rel);

    // Names: no template name left anywhere, paths or content.
    const oldNames = [template.solutionName, template.systemName, template.plcName];
    const leftover = plan.files.filter(f => oldNames.some(n => f.rel.includes(n) || f.data.toString('utf8').includes(n)));
    assert(leftover.length === 0, `${label} no template name left (${leftover.map(f => f.rel).join(', ') || 'none'})`);
    assert(outRels.includes('Line_A.sln'), `${label} solution renamed to Line_A.sln`);
    assert(outRels.some(r => /(^|\/)Line_A_PLC\/Line_A_PLC\.plcproj$/.test(r)), `${label} PLC project renamed to Line_A_PLC`);

    // GUIDs: every identity GUID gone, every kept GUID still there, consistent mapping.
    const allOut = plan.files.map(f => f.data.toString('utf8')).join('\n');
    const outGuids = new Set((allOut.match(GUID_RE) || []).map(g => g.toLowerCase()));
    const stillOld = [...inv.regen.keys()].filter(g => outGuids.has(g));
    assert(stillOld.length === 0, `${label} every identity GUID is re-issued (${stillOld.join(', ') || 'none left'})`);
    const keptMissing = [...inv.keep.keys()].filter(g => !outGuids.has(g));
    assert(keptMissing.length === 0, `${label} every type/class GUID is kept (${keptMissing.join(', ') || 'all kept'})`);
    assert(plan.guidMap.size === inv.regen.size && new Set(plan.guidMap.values()).size === inv.regen.size,
        `${label} one distinct new GUID per old identity GUID`);
    // Same old → same new in every file: count occurrences of each old GUID in the template vs the new one in the output.
    const allIn = template.files.map(f => f.data.toString('utf8')).join('\n');
    const count = (text, g) => (text.match(new RegExp(g, 'gi')) || []).length;
    const mismatched = [...plan.guidMap].filter(([oldG, newG]) => count(allIn, oldG) !== count(allOut, newG));
    assert(mismatched.length === 0, `${label} every reference to a re-issued GUID follows it (${mismatched.length} mismatched)`);
    // Letter case per occurrence: the .sln stays upper-case, the .plcproj lower-case.
    const sln = plan.files.find(f => f.rel.endsWith('.sln')).data.toString('utf8');
    const slnGuids = sln.match(GUID_RE) || [];
    assert(slnGuids.length > 0 && slnGuids.every(g => g === g.toUpperCase()), `${label} .sln GUIDs stay upper-case`);
    const plcproj = plan.files.find(f => f.rel.endsWith('.plcproj')).data.toString('utf8');
    const projectGuid = /<ProjectGuid>\{([^}]+)\}/.exec(plcproj)[1];
    assert(projectGuid === projectGuid.toLowerCase(), `${label} .plcproj ProjectGuid stays lower-case`);
    assert(sln.includes(projectGuid.toUpperCase()), `${label} the .sln configuration lines name the new PLC project GUID`);

    // Bytes: BOM and line endings preserved per file; nothing but names/GUIDs changed.
    for (const src of template.files) {
        const out = plan.files.find(f => f.rel === src.rel.split(template.plcName).join('Line_A_PLC').split(template.solutionName).join('Line_A'));
        if (!out) { assert(false, `${label} ${src.rel} has an output`); continue; }
        const a = decodeText(src.data); const b = decodeText(out.data);
        const crlf = (t) => (t.match(/\r\n/g) || []).length;
        const lf = (t) => (t.match(/(?<!\r)\n/g) || []).length;
        const sameShape = a.bom === b.bom && crlf(a.text) === crlf(b.text) && lf(a.text) === lf(b.text) &&
            /\r?\n$/.test(a.text) === /\r?\n$/.test(b.text) && (a.text.match(/\t/g) || []).length === (b.text.match(/\t/g) || []).length;
        assert(sameShape, `${label} ${src.rel}: BOM, CRLF/LF, tabs and trailing newline preserved`);
        const strip = (t, names) => [...names].sort((x, y) => y.length - x.length).reduce((acc, n) => acc.split(n).join('NAME'), t).replace(GUID_RE, 'GUID');
        assert(strip(a.text, oldNames) === strip(b.text, ['Line_A_PLC', 'Line_A']), `${label} ${src.rel}: only names and GUIDs differ`);
    }

    // Starter content: MAIN, the PlcTask calling it, one empty GVL, nothing else.
    const objects = outRels.filter(r => /\.(TcPOU|TcGVL|TcDUT|TcIO|TcTTO)$/i.test(r)).map(r => path.basename(r)).sort();
    assert(JSON.stringify(objects) === JSON.stringify(['GVL_Main.TcGVL', 'MAIN.TcPOU', 'PlcTask.TcTTO']), `${label} starter objects: ${objects.join(', ')}`);
    const task = plan.files.find(f => f.rel.endsWith('PlcTask.TcTTO')).data.toString('utf8');
    assert(/<PouCall>\s*<Name>MAIN<\/Name>/.test(task), `${label} PlcTask calls MAIN`);
    const gvl = plan.files.find(f => f.rel.endsWith('GVL_Main.TcGVL')).data.toString('utf8');
    assert(/VAR_GLOBAL\r\nEND_VAR/.test(gvl), `${label} GVL_Main is empty`);

    // Shape: 4024 is one .tspproj; 4026 is .tsproj + _Config/.
    if (version.id === '3.1.4024') {
        assert(outRels.includes('Line_A/Line_A.tspproj') && !outRels.some(r => r.startsWith('_Config/')), `${label} .tspproj shape, no _Config/`);
    } else {
        assert(outRels.includes('Line_A.tsproj') && outRels.includes('_Config/PLC/Line_A_PLC.xti') &&
            outRels.includes('_Config/Line_A_PLC/Line_A_PLC Instance.xti'), `${label} .tsproj + _Config/ shape`);
        const xti = plan.files.find(f => f.rel === '_Config/PLC/Line_A_PLC.xti').data.toString('utf8');
        assert(xti.includes(`GUID="{${projectGuid.toUpperCase()}}"`), `${label} _Config xti names the new PLC project GUID`);
        assert(xti.includes('PrjFilePath="..\\..\\Line_A_PLC\\Line_A_PLC.plcproj"'), `${label} _Config xti points at the renamed .plcproj`);
    }

    // Write it, and check it reads back as one solution with one PLC project.
    const location = path.join(ROOT, version.dir);
    fs.mkdirSync(location, { recursive: true });
    const created = createProject({ templateDir, location, name: 'Line_A' });
    assert(fs.existsSync(created.slnPath) && fs.existsSync(created.plcprojPath), `${label} createProject writes the solution and the .plcproj`);
    assert(created.files.length === template.files.length, `${label} createProject writes ${template.files.length} files`);
    const projectMap = createProjectMap([location]);
    const solutionMap = createSolutionMap([location], projectMap);
    assert(projectMap.projects.size === 1, `${label} the created project is one PLC project to the project map`);
    assert(solutionMap.solutions.length === 1 && solutionMap.solutions[0].projects.length === 1 && solutionMap.orphanProjects.length === 0,
        `${label} the solution model finds the solution and its PLC project`);
    const project = [...projectMap.projects.values()][0];
    assert(project && project.objectFiles.size === 2, `${label} MAIN and GVL_Main are <Compile>d (${project && project.objectFiles.size})`);

    // A second create into the same place is refused, and nothing is touched.
    const before = listFiles(created.targetDir).join('|');
    let refused = '';
    try { createProject({ templateDir, location, name: 'Line_A' }); } catch (e) { refused = e.message; }
    assert(/already contains a TwinCAT solution/.test(refused), `${label} creating over an existing solution is refused`);
    assert(listFiles(created.targetDir).join('|') === before, `${label} the refused create touched nothing`);

    // Two creates give different identities.
    const second = planProject({ templateDir, name: 'Line_A' });
    const third = planProject({ templateDir, name: 'Line_A' });
    assert([...second.guidMap.values()].every(g => ![...third.guidMap.values()].includes(g)), `${label} each create mints fresh GUIDs`);
}

// ── Target checks ───────────────────────────────────────────────────────────────────────────────
{
    const loc = path.join(ROOT, 'targets');
    fs.mkdirSync(path.join(loc, 'Empty'), { recursive: true });
    assert(checkTarget({ location: loc, name: 'Empty' }).ok, 'an existing empty folder is accepted');
    assert(checkTarget({ location: loc, name: 'NewOne' }).ok, 'a folder that does not exist yet is accepted');
    fs.mkdirSync(path.join(loc, 'Docs'), { recursive: true });
    fs.writeFileSync(path.join(loc, 'Docs', 'notes.txt'), 'x');
    assert(checkTarget({ location: loc, name: 'Docs' }).ok, 'a folder with files but no TwinCAT solution is accepted');
    fs.mkdirSync(path.join(loc, 'Old', 'Deep', 'P'), { recursive: true });
    fs.writeFileSync(path.join(loc, 'Old', 'Deep', 'P', 'P.plcproj'), '<Project/>');
    const r = checkTarget({ location: loc, name: 'Old' });
    assert(!r.ok && /already contains a TwinCAT solution/.test(r.reason), 'a folder holding a .plcproj is refused');
    assert(!checkTarget({ location: path.join(loc, 'missing'), name: 'X' }).ok, 'a location that does not exist is refused');
    fs.mkdirSync(path.join(loc, 'Clash', 'Clash_PLC'), { recursive: true });
    fs.writeFileSync(path.join(loc, 'Clash', 'Clash_PLC', 'PlcTask.TcTTO'), 'mine');
    let msg = '';
    try { createProject({ templateDir: templateDirFor(TEMPLATES, '3.1.4026'), location: loc, name: 'Clash' }); } catch (e) { msg = e.message; }
    assert(/already exists/.test(msg), 'a file the template would overwrite is refused');
    assert(fs.readFileSync(path.join(loc, 'Clash', 'Clash_PLC', 'PlcTask.TcTTO'), 'utf8') === 'mine', 'the existing file is untouched');
    let threw = '';
    try { planProject({ templateDir: templateDirFor(TEMPLATES, '3.1.4026'), name: 'bad name' }); } catch (e) { threw = e.message; }
    assert(/invalid project name/.test(threw), 'planProject refuses an invalid name');
}

// ── An unclassified GUID is a template defect, not a guess ─────────────────────────────────────
{
    const files = [{ rel: 'X.plcproj', data: Buffer.from('<Project><Mystery>{11111111-2222-4333-8444-555555555555}</Mystery></Project>') }];
    const inv = inventoryGuids(files);
    assert(inv.unclassified.length === 1, 'a GUID outside every known context is reported unclassified');
}

fs.rmSync(ROOT, { recursive: true, force: true });
if (errors) {
    console.error(`\n${errors} failure(s)`);
    process.exit(1);
}
console.log('\nAll project-template tests passed.');
