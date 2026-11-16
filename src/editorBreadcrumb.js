/**
 * @file The PLC editor header's breadcrumb (user decision 2026-11-16): PLC project › folders inside
 * the project › object name, built from what the host already has (the project map and the file
 * path). Pure, so test/test_editor_breadcrumb.js runs it under plain Node.
 */
'use strict';

const path = require('path');
const { LOOSE_PROJECT_KEY } = require('./lsp/projectMap');

/**
 * Splits a relative directory path into its folder names, for either separator.
 * @param {string} rel A relative path ('' for none).
 * @returns {string[]} Folder names, empty when `rel` is empty or '.'.
 */
function splitFolders(rel) {
    return String(rel || '').split(/[\\/]+/).filter(s => s && s !== '.');
}

/**
 * The breadcrumb for one PLC object file. The project is the one the file routes to
 * (`projectFor`); the folders are the file's directory relative to that project's directory. A
 * file outside every project, or outside its project's directory (a link), shows what is known:
 * no project, and the file's own directory name as the only folder.
 * @param {string} fsPath The object file's absolute path.
 * @param {{projectFor?: (p: string) => string, get?: (key: string) => ({name: string, dir: string}|null)}|null|undefined} projectMap
 * @returns {{project: string|null, folders: string[], name: string, title: string}} `title` is the
 *   full location, one line, for the tooltip.
 */
function breadcrumbFor(fsPath, projectMap) {
    const file = String(fsPath || '');
    const ext = path.extname(file);
    const name = path.basename(file, ext);
    let project = null;
    let folders = [];
    const key = projectMap && typeof projectMap.projectFor === 'function' ? projectMap.projectFor(file) : LOOSE_PROJECT_KEY;
    const proj = key && key !== LOOSE_PROJECT_KEY && projectMap && typeof projectMap.get === 'function' ? projectMap.get(key) : null;
    if (proj) {
        project = proj.name;
        const rel = path.relative(proj.dir, path.dirname(file));
        // A file outside the project's directory (linked in) has no folder path inside the project.
        folders = rel.startsWith('..') || path.isAbsolute(rel) ? [] : splitFolders(rel);
    } else if (file) {
        const dir = path.basename(path.dirname(file));
        if (dir) folders = [dir];
    }
    const title = [project, ...folders, name + ext].filter(Boolean).join(' › ');
    return { project, folders, name, title };
}

module.exports = { breadcrumbFor, splitFolders };
