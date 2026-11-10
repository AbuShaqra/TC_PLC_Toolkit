/**
 * @file stOutputPath.js
 * @description The pure path mapping behind the project-aware "Generate ST" export.
 *
 * Generate ST writes each `.plcproj`'s objects into that project's OWN directory, under
 * `<project dir>/ST_Files/`, mirroring each object's path relative to the project. Two projects that
 * share an object's relative path (every workspace with a `MAIN` per project) therefore never
 * overwrite each other, and nothing is written into the workspace's top-level folder.
 *
 * Kept vscode-free and side-effect-free so `test/test_st_output_path.js` can pin it.
 */

'use strict';

const path = require('path');

/** The folder, inside a project directory, that holds the project's generated `.st` files. */
const ST_FILES_DIR = 'ST_Files';

/**
 * Maps one object file to its output path relative to the project's `ST_Files/` folder.
 * @param {string} projectDir Absolute path of the project directory (the `.plcproj`'s folder).
 * @param {string} filePath Absolute path of the TwinCAT object file.
 * @returns {string} The output path relative to `<projectDir>/ST_Files/`, with a `.st` extension.
 */
function stOutputRelPath(projectDir, filePath) {
    let rel = path.relative(projectDir, filePath);
    // A linked object (`Include="..\Shared\X.TcPOU"`) resolves outside the project directory, so its
    // relative path climbs out with `..`. Placing it by basename keeps every output inside the
    // project's own folder — a `..` must never escape `<project>/ST_Files/`.
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        rel = path.basename(filePath);
    }
    const ext = path.extname(rel);
    const stem = ext ? rel.slice(0, -ext.length) : rel;
    return stem + '.st';
}

/**
 * The absolute path one object file's `.st` is written to: `<projectDir>/ST_Files/<rel>.st`.
 * @param {string} projectDir Absolute path of the project directory.
 * @param {string} filePath Absolute path of the TwinCAT object file.
 * @returns {string}
 */
function stOutputPath(projectDir, filePath) {
    return path.join(projectDir, ST_FILES_DIR, stOutputRelPath(projectDir, filePath));
}

/**
 * Whether a path lies under a generated-output folder (`ST_Files`, any letter case, at any depth).
 * Generate ST never converts such a file: an output must not become the next run's input.
 * @param {string} filePath A path with either separator.
 * @returns {boolean}
 */
function isUnderStFiles(filePath) {
    return String(filePath || '').split(/[\\/]+/).slice(0, -1).some(seg => seg.toLowerCase() === 'st_files');
}

module.exports = { ST_FILES_DIR, stOutputRelPath, stOutputPath, isUnderStFiles };
