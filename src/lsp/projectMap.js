/**
 * @file projectMap.js
 * @description Which PLC project owns which file.
 *
 * A TwinCAT solution can hold several PLC projects, and each `.plcproj` is its own compilation unit:
 * XAE does not resolve symbols across them. Opening a folder that contains more than one is normal,
 * and it used to break everything downstream, because the symbol index was one flat map keyed by
 * object name — two projects with a `GVL_System` each collapsed onto one key, last-write-wins.
 *
 * This module is the single source of truth for the partition. It is deliberately dependency-free
 * (`fs`/`path` only, no `vscode`) so the LSP server and the extension host can both require it.
 *
 * Ownership has two flavours, and they are not the same question:
 *   - `ownersOf(file)`  — every project that `<Compile>`s the file. A file linked into two projects
 *     (a real TwinCAT pattern: "add existing item as link") is owned by both and must be indexed into
 *     both, or it would read as undeclared in all but one.
 *   - `projectFor(file)` — the ONE project a request for that file routes to. Single-valued by
 *     necessity: a completion has to be answered against one index.
 */

const fs = require('fs');
const path = require('path');

// `.tctleo` (EnumerationTextList) declares a real ST enum — xmlParser normalises its root element to
// DUT, so it indexes as one. `.tctto` (task) and `.tctlo` (HMI text list) are NOT ST types. Kept in
// sync with xmlIndexer.js's own TWINCAT_EXTS by hand (test_project_map.js pins the two against each
// other): duplicated rather than imported because this module is deliberately dependency-free, and
// importing xmlIndexer.js would pull in xmlParser + symbolNode for one constant.
/** TwinCAT object extensions a `.plcproj` can `<Compile>` (lower-cased). */
const TWINCAT_EXTS = new Set(['.tcpou', '.tcgvl', '.tcdut', '.tcio', '.tctleo']);

/** Directories that never hold a `.plcproj`: VCS, tooling, vendor archives, generated/build output. */
const SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    '.vscode',
    '_libraries',
    'st_files',
    '_compileinfo',
    '_boot'
]);

/**
 * The project key for files under no `.plcproj` — loose `.st` files, a bare folder of TwinCAT
 * objects, anything outside every project directory. They share one index, which is exactly the
 * pre-existing "no project found, index everything" behaviour.
 * @type {string}
 */
const LOOSE_PROJECT_KEY = '(loose)';

/**
 * Normalizes an absolute path for comparison: resolved, forward slashes, lower-cased. The extension
 * targets Windows/TwinCAT and the rest of the codebase already compares paths case-insensitively.
 * @param {string} p Absolute path.
 * @returns {string} Comparison key.
 */
function normalizeProjectPath(p) {
    return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Recursively finds every `.plcproj` under the given roots.
 * @param {Array<string>} roots Absolute workspace-root paths.
 * @returns {Array<string>} Absolute `.plcproj` paths, sorted for deterministic ordering.
 */
function findPlcProjFiles(roots) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return; // unreadable directory: skip, never throw out of discovery
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
                walk(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj')) {
                out.push(full);
            }
        }
    };
    for (const root of (roots || [])) walk(root);
    out.sort();
    return out;
}

/**
 * The TwinCAT objects a single `.plcproj` compiles.
 * @param {string} plcprojPath Absolute `.plcproj` path.
 * @returns {Set<string>} Normalized absolute object paths (empty when the file is unreadable).
 */
function readCompileIncludes(plcprojPath) {
    let xml;
    try {
        xml = fs.readFileSync(plcprojPath, 'utf8');
    } catch (e) {
        return new Set();
    }
    const projDir = path.dirname(plcprojPath);
    const out = new Set();
    // <Compile Include="POUs\Modules\FB_Loading.TcPOU"> — relative to the .plcproj, and TwinCAT
    // writes backslashes regardless of platform. A link uses the same element with a ..\ path.
    const includeRe = /<Compile\b[^>]*?\bInclude="([^"]+)"/gi;
    let m;
    while ((m = includeRe.exec(xml)) !== null) {
        const abs = path.resolve(projDir, m[1].replace(/\\/g, path.sep));
        if (TWINCAT_EXTS.has(path.extname(abs).toLowerCase())) out.add(normalizeProjectPath(abs));
    }
    return out;
}

/**
 * @typedef {Object} Project
 * @property {string} key Normalized `.plcproj` path — the partition key.
 * @property {string} plcprojPath Absolute `.plcproj` path, in its on-disk spelling.
 * @property {string} dir The project directory (where the `.plcproj` sits).
 * @property {string} name Display name (the `.plcproj` basename without extension).
 * @property {Set<string>} objectPaths Normalized paths of the objects this project `<Compile>`s.
 */

/**
 * Builds the workspace's project partition.
 * @param {Array<string>} roots Absolute workspace-root paths.
 * @returns {Object} ProjectMap with properties: projects (Map<string, Project>), isEmpty (() => boolean),
 *   keys (() => string[]), get ((key: string) => Project|null), projectFor ((fsPath: string) => string),
 *   ownersOf ((fsPath: string) => string[]), displayName ((key: string) => string)
 */
function createProjectMap(roots) {
    const projects = new Map();
    /** @type {Map<string, string[]>} normalized object path → the keys of every project compiling it. */
    const owners = new Map();

    for (const plcprojPath of findPlcProjFiles(roots)) {
        const key = normalizeProjectPath(plcprojPath);
        const objectPaths = readCompileIncludes(plcprojPath);
        projects.set(key, {
            key,
            plcprojPath,
            dir: path.dirname(plcprojPath),
            name: path.basename(plcprojPath, path.extname(plcprojPath)),
            objectPaths
        });
        for (const obj of objectPaths) {
            if (!owners.has(obj)) owners.set(obj, []);
            owners.get(obj).push(key);
        }
    }

    /** The project directory as a normalized prefix, so `startsWith` cannot match a sibling. */
    const dirPrefix = (proj) => normalizeProjectPath(proj.dir) + '/';

    /**
     * The project whose directory is the longest prefix of the path.
     * @param {string} norm Normalized file path.
     * @param {Array<Project>} candidates Projects to consider.
     * @returns {Project|null}
     */
    const nearestByDirectory = (norm, candidates) => {
        let best = null;
        for (const proj of candidates) {
            const prefix = dirPrefix(proj);
            if (!norm.startsWith(prefix)) continue;
            if (!best || prefix.length > dirPrefix(best).length) best = proj;
        }
        return best;
    };

    const projectFor = (fsPath) => {
        if (!fsPath) return LOOSE_PROJECT_KEY;
        const norm = normalizeProjectPath(fsPath);
        const owning = owners.get(norm);
        if (owning && owning.length === 1) return owning[0];
        // Either several projects compile it (a link) or none does (an orphan, a new file, a .st).
        // Both route the same way: the project the file physically sits under. A link therefore
        // answers requests from its home project, while still being indexed into every owner.
        const candidates = owning && owning.length > 1
            ? owning.map(k => projects.get(k))
            : Array.from(projects.values());
        const best = nearestByDirectory(norm, candidates);
        if (best) return best.key;
        return owning && owning.length > 1 ? owning[0] : LOOSE_PROJECT_KEY;
    };

    const ownersOf = (fsPath) => {
        if (!fsPath) return [];
        const owning = owners.get(normalizeProjectPath(fsPath));
        return owning && owning.length ? owning.slice() : [];
    };

    return {
        projects,
        isEmpty: () => projects.size === 0,
        keys: () => Array.from(projects.keys()),
        get: (key) => projects.get(key) || null,
        projectFor,
        ownersOf,
        displayName: (key) => (key === LOOSE_PROJECT_KEY
            ? 'Loose files'
            : ((projects.get(key) || {}).name || key))
    };
}

/**
 * The tree groups for a workspace: one per PLC project, sorted by name. Returns an EMPTY array when
 * there are fewer than two projects — the Objects tree then keeps its flat, directory-driven shape,
 * which is the right thing for the overwhelmingly common single-project workspace.
 * @param {{projects: Map<string, Object>}} projectMap The workspace partition.
 * @param {Array<string>} folderPaths Absolute workspace-root paths (unused today; kept so a future
 *   multi-root workspace can label a group with its containing folder without a signature change).
 * @returns {Array<{key: string, name: string, dir: string}>} Groups, or [] to stay flat.
 */
function groupRootsByProject(projectMap, folderPaths) {
    if (!projectMap || projectMap.projects.size < 2) return [];
    return Array.from(projectMap.projects.values())
        .map(p => ({ key: p.key, name: p.name, dir: p.dir }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
    LOOSE_PROJECT_KEY,
    TWINCAT_EXTS,
    normalizeProjectPath,
    findPlcProjFiles,
    readCompileIncludes,
    createProjectMap,
    groupRootsByProject
};
