/**
 * @file stOutputPath.js
 * @description The pure path mapping behind the project-aware "Generate ST" export.
 *
 * Generate ST writes each `.plcproj`'s objects under its OWN subtree of `ST_Files/`, so two
 * projects that share an object's relative path (every workspace with a `MAIN` per project) never
 * overwrite each other — the bug the old flat, workspace-relative mirror had. The project subtree
 * is keyed by the project's DIRECTORY relative to the workspace, not by its display name: a display
 * name can carry ` / ` and ` — ` disambiguation separators that are meaningless (or nesting) as a
 * folder, whereas a directory path is unique per project and already filesystem-safe.
 *
 * Kept vscode-free and side-effect-free so `test/test_st_output_path.js` can pin it.
 */

'use strict';

const path = require('path');

/**
 * Maps one object file to its `ST_Files`-relative output path.
 * @param {string} projectFolderRel The project directory relative to the workspace (e.g.
 *   `LineA/TcToolkitSample_PLC`), used verbatim as the project's folder under `ST_Files/`.
 * @param {string} projectDir Absolute path of the project directory (the `.plcproj`'s folder).
 * @param {string} filePath Absolute path of the TwinCAT object file.
 * @returns {string} The output path relative to `ST_Files/`, with a `.st` extension.
 */
function stOutputRelPath(projectFolderRel, projectDir, filePath) {
    let rel = path.relative(projectDir, filePath);
    // A linked object (`Include="..\Shared\X.TcPOU"`) resolves outside the project directory, so its
    // relative path climbs out with `..`. Placing it by basename keeps every output inside the
    // project's own folder — a `..` must never escape `ST_Files/<project>/`.
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        rel = path.basename(filePath);
    }
    const ext = path.extname(rel);
    const stem = ext ? rel.slice(0, -ext.length) : rel;
    return path.join(projectFolderRel, stem + '.st');
}

/** Case-insensitive on Windows, case-sensitive elsewhere — matches how the filesystem compares. */
function pathStartsWith(child, parent) {
    const a = process.platform === 'win32' ? child.toLowerCase() : child;
    const b = process.platform === 'win32' ? parent.toLowerCase() : parent;
    return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * The folder a project's ST output lives in, relative to the workspace.
 *
 * A project directory is unique, so its path relative to its owning workspace folder is a
 * collision-free key. The workspace-folder NAME is prepended only for a multi-root workspace — where
 * two roots could otherwise contribute the same relative sub-path — so a single-root export stays
 * `<project sub-path>` rather than the redundant `<rootName>/<project sub-path>` that
 * `vscode.workspace.asRelativePath(dir, true)` produces.
 * @param {string[]} folderPaths Absolute fs paths of the workspace folders.
 * @param {string} projectDir Absolute path of the project directory.
 * @returns {string} The project's folder path relative to `ST_Files/`.
 */
function projectFolderRelPath(folderPaths, projectDir) {
    const owning = (folderPaths || []).find(f => pathStartsWith(projectDir, f));
    if (!owning) return path.basename(projectDir);
    const rel = path.relative(owning, projectDir) || path.basename(projectDir);
    return folderPaths.length > 1 ? path.join(path.basename(owning), rel) : rel;
}

module.exports = { stOutputRelPath, projectFolderRelPath };
