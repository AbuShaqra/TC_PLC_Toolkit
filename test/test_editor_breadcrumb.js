/**
 * @file The PLC editor header's breadcrumb (`src/editorBreadcrumb.js`): PLC project › folders inside
 * the project › object name, from the real project map over the committed sample, plus the cases
 * where only part of it is known (a loose file, a file outside its project's directory, no map).
 */
'use strict';

const path = require('path');
const { breadcrumbFor, splitFolders } = require('../src/editorBreadcrumb');
const { createProjectMap } = require('../src/lsp/projectMap');

let errors = 0;
function assertEq(actual, expected, msg) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`[PASS] ${msg}`);
    else {
        console.error(`[FAIL] ${msg}`);
        console.error(`         expected: ${JSON.stringify(expected)}`);
        console.error(`         actual:   ${JSON.stringify(actual)}`);
        errors++;
    }
}

const sampleRoot = path.join(__dirname, '..', 'sample', 'TcToolkitSample');
const projDir = path.join(sampleRoot, 'TcToolkitSample_PLC');
const map = createProjectMap([sampleRoot]);

assertEq(breadcrumbFor(path.join(projDir, 'POUs', 'MAIN.TcPOU'), map),
    { project: 'TcToolkitSample_PLC', folders: ['POUs'], name: 'MAIN', title: 'TcToolkitSample_PLC › POUs › MAIN.TcPOU' },
    'a sample POU: project, its folder, the object name without the extension');
assertEq(breadcrumbFor(path.join(projDir, 'POUs', 'Station', 'Deep', 'FB_X.TcPOU'), map).folders, ['POUs', 'Station', 'Deep'],
    'nested folders inside the project keep their order');
assertEq(breadcrumbFor(path.join(projDir, 'GVL_X.TcGVL'), map).folders, [],
    'an object at the project root has no folder');
assertEq(breadcrumbFor(path.join(sampleRoot, '..', 'Elsewhere', 'Loose.TcPOU'), map),
    { project: null, folders: ['Elsewhere'], name: 'Loose', title: 'Elsewhere › Loose.TcPOU' },
    'a file under no project: no project, its own directory as what is known');
assertEq(breadcrumbFor(path.join(projDir, 'DUTs', 'ST_A.TcDUT'), null),
    { project: null, folders: ['DUTs'], name: 'ST_A', title: 'DUTs › ST_A.TcDUT' },
    'no project map yet: the directory and the name');
const linked = { projectFor: () => 'k', get: () => ({ name: 'P', dir: path.join(projDir, 'Sub') }) };
assertEq(breadcrumbFor(path.join(projDir, 'Other', 'X.TcPOU'), linked),
    { project: 'P', folders: [], name: 'X', title: 'P › X.TcPOU' },
    'a file outside its project directory (linked in): the project, no folder path');
assertEq(splitFolders('a\\b/c'), ['a', 'b', 'c'], 'either separator splits');
assertEq(breadcrumbFor('', null), { project: null, folders: [], name: '', title: '' }, 'no path: nothing');

console.log(errors === 0 ? '\nAll editor-breadcrumb tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
