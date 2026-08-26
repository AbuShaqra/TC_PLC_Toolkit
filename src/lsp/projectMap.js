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
 * (`fs`/`path`/`../twincatWorkspace` only, no `vscode`) so the LSP server and the extension host can
 * both require it.
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
const {
    PROJECT_WALK_SKIP_DIRS,
    TWINCAT_XML_EXTS,
    decodeXmlAttribute,
    walkFiles,
    suffixDisplayNames
} = require('../twincatWorkspace');
const log = require('./log');

// Identity re-export: projectMap.js and xmlIndexer.js must agree on the same Set object, not merely
// an equal one (test_project_map.js's cross-pin). twincatWorkspace.js is the shared owner now; this
// module keeps its own name for the constant so every existing call site here reads unchanged.
/** TwinCAT object extensions a `.plcproj` can `<Compile>` (lower-cased). */
const TWINCAT_EXTS = TWINCAT_XML_EXTS;

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
    const out = walkFiles(roots || [], {
        skipDirs: PROJECT_WALK_SKIP_DIRS,
        isMatch: (n) => n.toLowerCase().endsWith('.plcproj')
    });
    out.sort();
    return out;
}

/**
 * Returns an existing path with the spelling recorded by the Windows filesystem.
 *
 * TwinCAT can keep an older directory casing in `<Compile Include>` after the folder was renamed
 * only by case. Windows still opens that path, but VS Code treats the include-spelled URI and the
 * explorer/custom-editor URI as different resources. Walking directory entries is deliberate:
 * `realpath` also expands 8.3 names and junctions, changing the workspace URI prefix even while it
 * fixes the descendant's case. POSIX paths are case-sensitive already, so they stay byte-for-byte
 * as written in the project. Missing/unreadable objects also stay present in the map under their
 * include spelling; the indexer will conservatively skip them as before.
 * @param {string} includePath Absolute path resolved from the `.plcproj` Include.
 * @param {string} projectDir Directory spelling inherited from workspace discovery.
 * @param {Map<string, Map<string, string>|null>} directoryCache Per-project directory entries,
 *   keyed by normalized path; avoids an O(objects × path-depth) filesystem walk.
 * @returns {string} Actual on-disk spelling when available, otherwise `includePath`.
 */
function pathWithDiskSpelling(includePath, projectDir, directoryCache) {
    if (process.platform !== 'win32') return includePath;
    try {
        const projectResolved = path.resolve(projectDir);
        const includeResolved = path.resolve(includePath);
        const projectParsed = path.parse(projectResolved);
        const includeParsed = path.parse(includeResolved);
        if (projectParsed.root.toLowerCase() !== includeParsed.root.toLowerCase()) return includePath;

        const projectParts = projectResolved.slice(projectParsed.root.length).split(path.sep).filter(Boolean);
        const includeParts = includeResolved.slice(includeParsed.root.length).split(path.sep).filter(Boolean);
        let common = 0;
        while (common < projectParts.length && common < includeParts.length &&
            projectParts[common].toLowerCase() === includeParts[common].toLowerCase()) common++;
        let anchor = projectParsed.root;
        if (common > 0) anchor = path.join(anchor, ...projectParts.slice(0, common));

        let current = anchor;
        for (const wanted of includeParts.slice(common)) {
            const cacheKey = normalizeProjectPath(current);
            if (!directoryCache.has(cacheKey)) {
                let entries = null;
                try {
                    entries = new Map(fs.readdirSync(current).map(name => [name.toLowerCase(), name]));
                } catch (e) {
                    // Cache failures too: a project with many missing objects under one directory
                    // should not retry the same unreadable path for every Include. The caching is also
                    // what keeps this record per-DIRECTORY rather than per-Include.
                    log.debug('include-directory-read-failed', { dir: current, error: e });
                }
                directoryCache.set(cacheKey, entries);
            }
            const entries = directoryCache.get(cacheKey);
            const actual = entries && entries.get(wanted.toLowerCase());
            if (!actual) return includePath;
            current = path.join(current, actual);
        }
        return current;
    } catch (e) {
        return includePath;
    }
}

/**
 * The TwinCAT objects a single `.plcproj` compiles.
 *
 * The value keeps the real filesystem spelling for an existing Windows object (and the `.plcproj`
 * spelling as a conservative fallback), because the indexer builds every symbol node's uri from it.
 * Indexing from either the normalized key or a stale case-only Include gives the scan-time node a
 * uri different from the explorer/custom editor's uri; cross-file Go to Definition then opens a
 * DUPLICATE tab because vscode.openWith() treats different casing as a different resource.
 * @param {string} plcprojPath Absolute `.plcproj` path.
 * @returns {Map<string, string>} Normalized absolute object path → real on-disk spelling where it
 *   can be recovered, otherwise the Include spelling (empty when the project file is unreadable).
 */
function readCompileIncludes(plcprojPath) {
    let xml;
    try {
        xml = fs.readFileSync(plcprojPath, 'utf8');
    } catch (e) {
        // The ONE `warn` in the LSP's degraded-condition set, and it earns it: the walk just found this
        // `.plcproj`, so failing to read it is not a routine skip — the project ends up compiling no
        // objects at all, its index stays empty, and every feature on every file in it goes quiet. A
        // healthy project never produces this line.
        log.warn('plcproj-unreadable', { file: plcprojPath, error: e });
        return new Map();
    }
    const projDir = path.dirname(plcprojPath);
    const out = new Map();
    /** @type {Map<string, Map<string, string>|null>} */
    const directoryCache = new Map();
    // <Compile Include="POUs\Modules\FB_Feeder.TcPOU"> — relative to the .plcproj, and TwinCAT
    // writes backslashes regardless of platform. A link uses the same element with a ..\ path.
    const includeRe = /<Compile\b[^>]*?\bInclude="([^"]+)"/gi;
    let m;
    while ((m = includeRe.exec(xml)) !== null) {
        const abs = path.resolve(projDir, decodeXmlAttribute(m[1]).replace(/\\/g, path.sep));
        if (TWINCAT_EXTS.has(path.extname(abs).toLowerCase())) {
            out.set(normalizeProjectPath(abs), pathWithDiskSpelling(abs, projDir, directoryCache));
        }
    }
    return out;
}

/**
 * @typedef {Object} Project
 * @property {string} key Normalized `.plcproj` path — the partition key.
 * @property {string} plcprojPath Absolute `.plcproj` path, in its on-disk spelling.
 * @property {string} dir The project directory (where the `.plcproj` sits).
 * @property {string} name Display name (the `.plcproj` basename without extension).
 * @property {Set<string>} objectPaths Normalized paths of the objects this project `<Compile>`s —
 *   the identity keys for ownership and membership tests.
 * @property {Map<string, string>} objectFiles Normalized path → real on-disk spelling for existing
 *   Windows objects, otherwise Include spelling. The indexer reads files (and mints symbol-node
 *   uris) from these values; neither the normalized form nor stale Include casing may leak into a
 *   uri (see readCompileIncludes).
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
        const objectFiles = readCompileIncludes(plcprojPath);
        projects.set(key, {
            key,
            plcprojPath,
            dir: path.dirname(plcprojPath),
            name: path.basename(plcprojPath, path.extname(plcprojPath)),
            objectPaths: new Set(objectFiles.keys()),
            objectFiles
        });
        for (const obj of objectFiles.keys()) {
            if (!owners.has(obj)) owners.set(obj, []);
            owners.get(obj).push(key);
        }
    }

    const displayNames = suffixDisplayNames(
        Array.from(projects.values()), p => p.name, p => collapseOwnDir(p),
        { includeRoot: true, sharedMaxDepth: true });

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
            : (displayNames.get(key) || ((projects.get(key) || {}).name || key)))
    };
}

/**
 * The directory that disambiguates a project's label. Skips the project's own directory when its
 * basename repeats the project name (the common `MyProject/MyProject.plcproj` layout) so the suffix
 * doesn't waste its first, most-specific segment restating the name that's already shown. This
 * collapse rule is projectMap policy, not shared discovery knowledge, so it stays local and is
 * passed into the shared `suffixDisplayNames` core as its `dirOf` callback.
 * @param {{dir: string, name: string}} project
 * @returns {string} The directory to disambiguate from.
 */
function collapseOwnDir(project) {
    return path.basename(project.dir).toLowerCase() === project.name.toLowerCase()
        ? path.dirname(project.dir)
        : project.dir;
}

/**
 * The tree groups for a workspace: one per PLC project, sorted by name. Returns an EMPTY array when
 * there are fewer than two projects — the Objects tree then keeps its flat, directory-driven shape,
 * which is the right thing for the overwhelmingly common single-project workspace.
 * @param {{projects: Map<string, Object>, displayName: (key: string) => string}} projectMap The workspace partition.
 * @param {Array<string>} folderPaths Absolute workspace-root paths (unused today; kept so a future
 *   multi-root workspace can label a group with its containing folder without a signature change).
 * @returns {Array<{key: string, name: string, dir: string}>} Groups, or [] to stay flat.
 */
function groupRootsByProject(projectMap, folderPaths) {
    if (!projectMap || projectMap.projects.size < 2) return [];
    return Array.from(projectMap.projects.values())
        .map(p => ({ key: p.key, name: projectMap.displayName(p.key), dir: p.dir }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
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
