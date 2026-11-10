/**
 * @file test_st_output_path.js
 * @description The pure output-path mapping behind "Generate ST" (`src/stOutputPath.js`).
 *
 * Generate ST is project-aware: each `.plcproj`'s objects are written inside that project's own
 * directory, `<project dir>/ST_Files/<object path relative to the project>.st`. Nothing goes into the
 * workspace's top-level folder, and two projects that share an object path can never overwrite each
 * other because each output lives under its own project.
 *
 * Pinned here because a plausible refactor reintroduces a collision or an escape: strip the
 * extension, keep the file's path RELATIVE TO ITS PROJECT, never let a linked file's `..\` climb out
 * of the project's `ST_Files`, and never treat a generated output as an input.
 */

const path = require('path');
const { ST_FILES_DIR, stOutputRelPath, stOutputPath, isUnderStFiles } = require('../src/stOutputPath');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
/** Normalize to '/' so the assertions read the same on both platforms. */
const norm = p => p.split(path.sep).join('/');

const ws = path.join('C:', 'ws');
const lineA = path.join(ws, 'LineA', 'TcToolkitSample_PLC');
const lineB = path.join(ws, 'LineB', 'TcToolkitSample_PLC');

assert(ST_FILES_DIR === 'ST_Files', 'the output folder is named ST_Files');

// A file nested inside its project keeps its in-project path.
assert(norm(stOutputRelPath(lineA, path.join(lineA, 'POUs', 'Machine', 'FB_Station.TcPOU'))) === 'POUs/Machine/FB_Station.st',
    'nested object keeps its path relative to the project, with a .st extension');
assert(norm(stOutputRelPath(lineB, path.join(lineB, 'MAIN.TcPOU'))) === 'MAIN.st',
    'object in the project root maps directly under ST_Files');

// The absolute output is INSIDE the project directory — never the workspace's top-level folder.
assert(norm(stOutputPath(lineA, path.join(lineA, 'POUs', 'Machine', 'FB_Station.TcPOU')))
    === norm(path.join(lineA, 'ST_Files', 'POUs', 'Machine', 'FB_Station.st')),
    'the output path is <project dir>/ST_Files/<path in the project>.st');
assert(!norm(stOutputPath(lineA, path.join(lineA, 'POUs', 'MAIN.TcPOU'))).startsWith(norm(path.join(ws, 'ST_Files'))),
    'nothing is written under the workspace-level ST_Files');

// THE COLLISION: two projects with the same object relative path must NOT share an output path.
const a = norm(stOutputPath(lineA, path.join(lineA, 'POUs', 'MAIN.TcPOU')));
const b = norm(stOutputPath(lineB, path.join(lineB, 'POUs', 'MAIN.TcPOU')));
assert(a !== b && a.startsWith(norm(lineA) + '/') && b.startsWith(norm(lineB) + '/'),
    'identical object paths in two projects map to distinct outputs, each inside its own project');

// Every TwinCAT object extension is stripped and replaced with .st, case-insensitively.
for (const ext of ['.TcPOU', '.TcGVL', '.TcDUT', '.TcIO', '.tcpou', '.TcTLEO']) {
    assert(norm(stOutputRelPath(path.join(ws, 'P'), path.join(ws, 'P', 'DUTs', 'X' + ext))) === 'DUTs/X.st',
        `${ext} is replaced with .st`);
}

// A LINKED object (Include="..\Shared\X.TcPOU") is outside the project dir; it must NOT escape the
// project's own ST folder — it is placed by basename so `..` can never climb out of ST_Files.
assert(norm(stOutputPath(path.join(ws, 'LineA', 'PLC'), path.join(ws, 'Shared', 'X.TcPOU')))
    === norm(path.join(ws, 'LineA', 'PLC', 'ST_Files', 'X.st')),
    'a linked object outside the project dir is placed by basename, inside that project\'s ST_Files');

// An output is never an input: any ST_Files segment, at any depth, in either case or separator.
assert(isUnderStFiles(path.join(lineA, 'ST_Files', 'POUs', 'MAIN.st')), 'a file in <project>/ST_Files is generated output');
assert(isUnderStFiles('ST_Files/POUs/MAIN.TcPOU') && isUnderStFiles('LineA\\PLC\\st_files\\MAIN.TcPOU'),
    'ST_Files matches at the root and nested, case-insensitively, with either separator');
assert(!isUnderStFiles(path.join(lineA, 'POUs', 'MAIN.TcPOU')) && !isUnderStFiles(path.join(lineA, 'POUs', 'ST_Files.TcPOU')),
    'an ordinary object — or a FILE merely named ST_Files — is not generated output');

if (errors > 0) {
    console.error(`\n${errors} ST-output-path assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll ST-output-path assertions passed.');
