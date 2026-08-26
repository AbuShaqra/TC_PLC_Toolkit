/**
 * @file test_st_output_path.js
 * @description The pure output-path mapping behind "Generate ST" (`src/stOutputPath.js`).
 *
 * Generate ST is project-aware: each `.plcproj`'s objects are written under its own subtree of
 * `ST_Files/`, keyed by the project's directory relative to the workspace — NOT by the project's
 * display name, which can contain ` / ` and ` — ` separators (unsafe as a folder) and, worse, was
 * why two projects that shared a `.plcproj` basename overwrote each other into one flat folder.
 * This maps (projectFolderRel, projectDir, filePath) → the ST_Files-relative output path.
 *
 * Pinned here because a plausible refactor reintroduces the collision: strip the extension, keep
 * the file's path RELATIVE TO ITS PROJECT (so two projects' identical `POUs/MAIN` never collide),
 * and never let a linked file's `..\` escape the project's own folder.
 */

const path = require('path');
const { stOutputRelPath, projectFolderRelPath } = require('../src/stOutputPath');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
/** Normalize to '/' so the assertions read the same on both platforms. */
const norm = p => p.split(path.sep).join('/');

// A file nested inside its project lands under ST_Files/<projectFolderRel>/<rel>.st.
assert(
    norm(stOutputRelPath('LineA/TcToolkitSample_PLC', path.join('C:', 'ws', 'LineA', 'TcToolkitSample_PLC'),
        path.join('C:', 'ws', 'LineA', 'TcToolkitSample_PLC', 'POUs', 'Machine', 'FB_Station.TcPOU')))
    === 'LineA/TcToolkitSample_PLC/POUs/Machine/FB_Station.st',
    'nested object maps under the project folder with .st extension');

// A file directly in the project root.
assert(
    norm(stOutputRelPath('LineB/TcToolkitSample_PLC', path.join('C:', 'ws', 'LineB', 'TcToolkitSample_PLC'),
        path.join('C:', 'ws', 'LineB', 'TcToolkitSample_PLC', 'MAIN.TcPOU')))
    === 'LineB/TcToolkitSample_PLC/MAIN.st',
    'object in the project root maps directly under the project folder');

// THE COLLISION: two projects with the same object relative path must NOT share an output path.
const a = norm(stOutputRelPath('LineA/TcToolkitSample_PLC', path.join('C:', 'ws', 'LineA', 'TcToolkitSample_PLC'),
    path.join('C:', 'ws', 'LineA', 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU')));
const b = norm(stOutputRelPath('LineB/TcToolkitSample_PLC', path.join('C:', 'ws', 'LineB', 'TcToolkitSample_PLC'),
    path.join('C:', 'ws', 'LineB', 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU')));
assert(a !== b && a === 'LineA/TcToolkitSample_PLC/POUs/MAIN.st' && b === 'LineB/TcToolkitSample_PLC/POUs/MAIN.st',
    'identical object paths in two projects map to distinct, project-scoped outputs');

// Every TwinCAT object extension is stripped and replaced with .st, case-insensitively.
for (const ext of ['.TcPOU', '.TcGVL', '.TcDUT', '.TcIO', '.tcpou', '.TcTLEO']) {
    assert(
        norm(stOutputRelPath('P', path.join('C:', 'ws', 'P'), path.join('C:', 'ws', 'P', 'DUTs', 'X' + ext)))
        === 'P/DUTs/X.st',
        `${ext} is replaced with .st`);
}

// A LINKED object (Include="..\Shared\X.TcPOU") is outside the project dir; it must NOT escape the
// project's own ST folder — it is placed by basename so `..` can never climb out of ST_Files.
assert(
    norm(stOutputRelPath('LineA/PLC', path.join('C:', 'ws', 'LineA', 'PLC'),
        path.join('C:', 'ws', 'Shared', 'X.TcPOU')))
    === 'LineA/PLC/X.st',
    'a linked object outside the project dir is placed by basename, never above the project folder');

// --- projectFolderRelPath: the project's folder under ST_Files, relative to the workspace.

const ws = path.join('C:', 'ws');
// Single root: NO redundant root-name prefix (the bug asRelativePath(dir, true) caused: `ws/LineA/...`).
assert(
    norm(projectFolderRelPath([ws], path.join(ws, 'LineA', 'TcToolkitSample_PLC'))) === 'LineA/TcToolkitSample_PLC',
    'single-root: project folder is its sub-path, with no workspace-name prefix');
assert(
    norm(projectFolderRelPath([ws], path.join(ws, 'LineB', 'TcToolkitSample_PLC'))) === 'LineB/TcToolkitSample_PLC',
    'single-root: the second line keeps its own distinct sub-path');

// Multi-root: prefix the workspace-folder name so two roots cannot collide on the same sub-path.
const rootX = path.join('C:', 'rootX');
const rootY = path.join('C:', 'rootY');
assert(
    norm(projectFolderRelPath([rootX, rootY], path.join(rootX, 'PLC'))) === 'rootX/PLC',
    'multi-root: the owning folder name is prepended');
assert(
    norm(projectFolderRelPath([rootX, rootY], path.join(rootY, 'PLC'))) === 'rootY/PLC'
    && norm(projectFolderRelPath([rootX, rootY], path.join(rootX, 'PLC'))) !== norm(projectFolderRelPath([rootX, rootY], path.join(rootY, 'PLC'))),
    'multi-root: same-named projects in different roots get distinct folders');

// A project that is itself a workspace root maps to its own basename.
assert(
    norm(projectFolderRelPath([path.join(ws, 'OnlyProj')], path.join(ws, 'OnlyProj'))) === 'OnlyProj',
    'a project dir equal to the root maps to its basename');

console.log(errors === 0 ? '\nAll ST output-path tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
