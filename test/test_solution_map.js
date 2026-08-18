/**
 * @file test_solution_map.js
 * @description TwinCAT solution → PLC-project discovery and display grouping.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProjectMap, normalizeProjectPath } = require('../src/lsp/projectMap');
const { createSolutionMap, findSolutionFiles } = require('../src/solutionMap');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const ROOT = path.join(os.tmpdir(), 'solution_map_' + Date.now());

function writePlcProject(dir, projectName) {
    fs.mkdirSync(path.join(dir, 'POUs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'POUs', 'MAIN.TcPOU'), '<TcPlcObject/>');
    const plcproj = path.join(dir, `${projectName}.plcproj`);
    fs.writeFileSync(plcproj,
        '<Project><ItemGroup><Compile Include="POUs\\MAIN.TcPOU"/></ItemGroup></Project>');
    return plcproj;
}

function writeSolution(lineDir, projectSpecs) {
    fs.mkdirSync(path.join(lineDir, '_Config', 'PLC'), { recursive: true });
    const sln = path.join(lineDir, 'Machine.sln');
    const tsproj = path.join(lineDir, 'Machine.tsproj');
    fs.writeFileSync(sln,
        'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
        'Project("{TWINCAT}") = "Machine", "Machine.tsproj", "{SYSTEM}"\nEndProject\n');
    fs.writeFileSync(tsproj,
        '<TcSmProject><Project><Plc>' + projectSpecs.map(spec =>
            `<Project File="${spec.xti}"/>`).join('') + '</Plc></Project></TcSmProject>');
    for (const spec of projectSpecs) {
        const xti = path.join(lineDir, '_Config', 'PLC', spec.xti);
        const relative = path.relative(path.dirname(xti), spec.plcproj).replace(/\\/g, '\\');
        fs.writeFileSync(xti, `<TcSmItem><Project Name="${spec.name}" PrjFilePath="${relative}"/></TcSmItem>`);
    }
    return sln;
}

const lineA = path.join(ROOT, 'AreaA');
const lineB = path.join(ROOT, 'AreaB');
const plcA1 = writePlcProject(path.join(lineA, 'Primary'), 'Controller');
const plcA2 = writePlcProject(path.join(lineA, 'Safety'), 'Safety');
const plcB = writePlcProject(path.join(lineB, 'Primary'), 'Controller');
const orphan = writePlcProject(path.join(ROOT, 'Orphan'), 'Standalone');
writeSolution(lineA, [
    { xti: 'Primary.xti', plcproj: plcA1, name: 'Controller' },
    { xti: 'Safety.xti', plcproj: plcA2, name: 'Safety' }
]);
writeSolution(lineB, [{ xti: 'Primary.xti', plcproj: plcB, name: 'Controller' }]);

// An unrelated C# solution must not pollute the TwinCAT Objects tree.
fs.mkdirSync(path.join(ROOT, 'Tools'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'Tools', 'Tools.sln'),
    'Project("{CSHARP}") = "Tools", "Tools.csproj", "{TOOLS}"\nEndProject\n');

const projectMap = createProjectMap([ROOT]);
const solutionMap = createSolutionMap([ROOT], projectMap);
const keyA1 = normalizeProjectPath(plcA1);
const keyA2 = normalizeProjectPath(plcA2);
const keyB = normalizeProjectPath(plcB);
const orphanKey = normalizeProjectPath(orphan);

assert(findSolutionFiles([ROOT]).length === 3, 'solution discovery sees both TwinCAT solutions and the unrelated .sln');
assert(solutionMap.solutions.length === 2, 'only TwinCAT solutions become Objects-tree roots');
assert(solutionMap.solutions.map(s => s.displayName).join(',') ===
    ['Machine — AreaA', 'Machine — AreaB'].join(','),
    `duplicate solution names use shortest unique parents (${solutionMap.solutions.map(s => s.displayName).join(',')})`);

const solutionA = solutionMap.solutionForProject(keyA1);
assert(!!solutionA && solutionA.projects.length === 2,
    `one solution contains both PLC projects (got ${solutionA ? solutionA.projects.length : 0})`);
assert(solutionA.projects.map(p => p.displayName).join(',') === 'Controller,Safety',
    `project labels are scoped within the solution (${solutionA.projects.map(p => p.displayName).join(',')})`);
assert(solutionMap.solutionForProject(keyA2).key === solutionA.key,
    'the second PLC project maps to the same solution');
assert(solutionMap.solutionForProject(keyB).displayName === 'Machine — AreaB',
    'the other solution owns its own same-named PLC project');
assert(solutionMap.projectLabel(keyA1) === 'Controller' && solutionMap.projectLabel(keyB) === 'Controller',
    'same PLC-project names in different solutions do not inherit global disambiguation suffixes');
assert(solutionMap.orphanProjects.length === 1 && solutionMap.orphanProjects[0].key === orphanKey,
    'a PLC project referenced by no solution remains a top-level orphan');

const noSolutionRoot = path.join(os.tmpdir(), 'solution_map_none_' + Date.now());
writePlcProject(path.join(noSolutionRoot, 'Only'), 'Only');
const noSolutionProjects = createProjectMap([noSolutionRoot]);
const noSolutions = createSolutionMap([noSolutionRoot], noSolutionProjects);
assert(noSolutions.solutions.length === 0 && noSolutions.orphanProjects.length === 1,
    'a workspace without a solution preserves the existing project fallback');

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(noSolutionRoot, { recursive: true, force: true });

console.log(`\n--- SOLUTION MAP TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors ? 1 : 0);
