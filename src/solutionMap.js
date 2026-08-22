/**
 * @file solutionMap.js
 * @description Discovers TwinCAT solutions and maps their PLC projects for the Objects tree.
 *
 * Kept dependency-free (Node fs/path plus ./lsp/projectMap and ./twincatWorkspace, no `vscode`) so
 * the model is testable outside VS Code. This is an extension-host presentation model: LSP
 * ownership remains exclusively in lsp/projectMap.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeProjectPath } = require('./lsp/projectMap');
const { SOLUTION_SKIP_DIRS, decodeXmlAttribute, walkFiles, suffixDisplayNames } = require('./twincatWorkspace');

function readText(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

/** Finds `.sln` files without descending into generated/vendor directories. */
function findSolutionFiles(roots) {
    const out = walkFiles(roots || [], {
        skipDirs: SOLUTION_SKIP_DIRS,
        isMatch: (n) => n.toLowerCase().endsWith('.sln')
    });
    return out.sort((a, b) => a.localeCompare(b));
}

function resolveProjectPath(baseDir, raw) {
    const decoded = decodeXmlAttribute(raw).replace(/[\\/]/g, path.sep);
    return path.isAbsolute(decoded) ? path.normalize(decoded) : path.resolve(baseDir, decoded);
}

/** Returns TwinCAT system-project and direct PLC-project paths referenced by a solution. */
function solutionReferences(slnPath) {
    const text = readText(slnPath);
    const tsproj = [];
    const plcproj = [];
    const refRe = /^Project\("[^"]+"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gmi;
    let match;
    while ((match = refRe.exec(text)) !== null) {
        const resolved = resolveProjectPath(path.dirname(slnPath), match[1]);
        const ext = path.extname(resolved).toLowerCase();
        if (ext === '.tsproj') tsproj.push(resolved);
        else if (ext === '.plcproj') plcproj.push(resolved);
    }
    return { tsproj, plcproj };
}

/** Resolves each `<Plc><Project File="…xti">` reference in a TwinCAT system project. */
function xtiReferences(tsprojPath) {
    const text = readText(tsprojPath);
    if (!text) return [];
    const plcBlock = /<Plc\b[^>]*>([\s\S]*?)<\/Plc>/i.exec(text);
    if (!plcBlock) return [];
    const out = [];
    const refRe = /<Project\b[^>]*\bFile="([^"]+\.xti)"/gi;
    let match;
    while ((match = refRe.exec(plcBlock[1])) !== null) {
        const raw = decodeXmlAttribute(match[1]).replace(/[\\/]/g, path.sep);
        const direct = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(path.dirname(tsprojPath), raw);
        const config = path.resolve(path.dirname(tsprojPath), '_Config', 'PLC', raw);
        out.push(fs.existsSync(direct) ? direct : config);
    }
    return out;
}

/** Resolves the `.plcproj` referenced by one PLC configuration XTI. */
function plcProjectFromXti(xtiPath) {
    const match = /\bPrjFilePath="([^"]+\.plcproj)"/i.exec(readText(xtiPath));
    return match ? resolveProjectPath(path.dirname(xtiPath), match[1]) : '';
}

function isInside(child, parent) {
    const childKey = normalizeProjectPath(child);
    const parentKey = normalizeProjectPath(parent).replace(/\/$/, '') + '/';
    return childKey.startsWith(parentKey);
}

/**
 * Builds the solution → PLC-project presentation model used by the Objects tree.
 * Explicit XTI membership wins. If an older/unusual solution cannot be followed completely, an
 * unassigned PLC project is attached only when exactly one deepest solution directory contains it.
 * @param {string[]} roots Workspace roots.
 * @param {{projects: Map<string, Object>, displayName: (key: string) => string}} projectMap
 */
function createSolutionMap(roots, projectMap) {
    const projectByKey = (projectMap && projectMap.projects) || new Map();
    const rawSolutions = [];
    for (const slnPath of findSolutionFiles(roots)) {
        const refs = solutionReferences(slnPath);
        // Ignore unrelated Visual Studio solutions. A TwinCAT solution references at least one
        // system project (`.tsproj`) or, in some layouts, a PLC project directly.
        if (refs.tsproj.length === 0 && refs.plcproj.length === 0) continue;
        const referencedKeys = new Set(refs.plcproj.map(normalizeProjectPath));
        for (const tsprojPath of refs.tsproj) {
            for (const xtiPath of xtiReferences(tsprojPath)) {
                const plcprojPath = plcProjectFromXti(xtiPath);
                if (plcprojPath) referencedKeys.add(normalizeProjectPath(plcprojPath));
            }
        }
        rawSolutions.push({
            key: normalizeProjectPath(slnPath),
            slnPath,
            dir: path.dirname(slnPath),
            name: path.basename(slnPath, path.extname(slnPath)),
            referencedKeys,
            projects: []
        });
    }

    const solutionNames = suffixDisplayNames(rawSolutions, s => s.name, s => s.dir);
    const assigned = new Set();
    const projectToSolution = new Map();

    // Deterministic single placement if two solutions reference the same PLC project. The project
    // still has one compilation identity; one tree parent is necessary for TreeView.reveal().
    for (const solution of rawSolutions) {
        for (const key of solution.referencedKeys) {
            const project = projectByKey.get(key);
            if (!project || assigned.has(key)) continue;
            solution.projects.push(project);
            assigned.add(key);
            projectToSolution.set(key, solution.key);
        }
    }

    // Conservative fallback for hand-edited/older TwinCAT metadata: only a unique deepest
    // containing solution may claim an otherwise orphan project.
    for (const project of projectByKey.values()) {
        if (assigned.has(project.key)) continue;
        const candidates = rawSolutions.filter(solution => isInside(project.plcprojPath, solution.dir));
        if (candidates.length === 0) continue;
        const maxDepth = Math.max(...candidates.map(s => normalizeProjectPath(s.dir).length));
        const deepest = candidates.filter(s => normalizeProjectPath(s.dir).length === maxDepth);
        if (deepest.length !== 1) continue;
        deepest[0].projects.push(project);
        assigned.add(project.key);
        projectToSolution.set(project.key, deepest[0].key);
    }

    const projectLabels = new Map();
    for (const solution of rawSolutions) {
        const labels = suffixDisplayNames(solution.projects, p => p.name, p => {
            const sameNamedDir = path.basename(p.dir).toLowerCase() === p.name.toLowerCase();
            return sameNamedDir ? path.dirname(p.dir) : p.dir;
        });
        solution.displayName = solutionNames.get(solution.key) || solution.name;
        solution.projects = solution.projects
            .map(project => ({ ...project, displayName: labels.get(project.key) || project.name }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key));
        for (const project of solution.projects) projectLabels.set(project.key, project.displayName);
    }
    rawSolutions.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key));

    const orphanProjects = Array.from(projectByKey.values())
        .filter(project => !assigned.has(project.key))
        .map(project => ({ ...project, displayName: projectMap.displayName(project.key) }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key));

    return {
        solutions: rawSolutions,
        orphanProjects,
        projectToSolution,
        solutionForProject: (key) => rawSolutions.find(s => s.key === projectToSolution.get(key)) || null,
        projectLabel: (key) => projectLabels.get(key) ||
            ((orphanProjects.find(p => p.key === key) || {}).displayName || '')
    };
}

module.exports = {
    findSolutionFiles,
    solutionReferences,
    xtiReferences,
    plcProjectFromXti,
    createSolutionMap
};
