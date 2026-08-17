/**
 * @file workspaceScan.js
 * @description The workspace partition: one symbol index per PLC project, and the routing that
 * decides which index answers a request.
 *
 * This lives outside server.js on purpose. server.js opens an IPC connection at require time, so
 * nothing in it is loadable by a standalone harness — and the behaviour here (which project owns a
 * file, which index a request lands in, which configuration objects a rename may touch) is exactly
 * what needs a regression gate. The connection is injected as log callbacks instead.
 *
 * The `.plcproj` — not the filesystem — defines a project. An object on disk but absent from every
 * `.plcproj` (a backup or experimental copy) is never indexed and so cannot shadow a real object.
 * An object linked into two projects is indexed into BOTH, because it genuinely belongs to both.
 */

const fs = require('fs');
const path = require('path');

const { indexXmlFile, indexTwinCatDirectory } = require('./xmlIndexer');
const { indexStDirectory } = require('./parser');
const {
    LOOSE_PROJECT_KEY,
    createProjectMap,
    normalizeProjectPath
} = require('./projectMap');

/**
 * TwinCAT non-code object extensions that can carry a PLC symbol reference (lower-cased): the two
 * visualization formats, the two text-list formats, and the task configuration.
 * @type {Set<string>}
 */
const CONFIG_OBJECT_EXTS = new Set(['.tcvis', '.tcvmo', '.tctlo', '.tcgtlo', '.tctto']);

/** Directories skipped when walking for configuration objects — the same set the XML indexer skips. */
const CONFIG_OBJECT_SKIP_DIRS = new Set(['.git', 'node_modules', '.vscode', '_libraries']);

/**
 * Converts an LSP file URI (file:///C:/...) to a filesystem path.
 *
 * The separator flip is guarded on `path.sep`, not applied unconditionally. `file:///` strips all
 * three slashes, which is right on Windows (`file:///c:/a` → `c:/a` → `c:\a`) but on POSIX eats the
 * root: `file:///home/u/a` became `home/u/a` and then `\home\u\a`, a relative path full of
 * backslashes that no `fs` call can open. Windows behaviour here is byte-for-byte what it was.
 * @param {string} uri File or folder URI.
 * @returns {string} Filesystem path.
 */
function uriToFsPath(uri) {
    const raw = String(uri || '');
    const stripped = decodeURIComponent(raw.replace(/^file:\/\/\//i, ''));
    if (path.sep === '\\') return stripped.replace(/\//g, '\\');
    // Only a real file URI lost its root slash to the strip above; a bare path must pass through.
    return /^file:\/\/\//i.test(raw) ? '/' + stripped : stripped;
}

/**
 * Recursively collects every TwinCAT configuration object under the given roots. Rename is a rare,
 * deliberate action, so an on-demand walk is fine — no standing index of these files is kept.
 * @param {Array<string>} roots Absolute paths to walk.
 * @returns {Array<string>} Absolute configuration-object file paths.
 */
function collectConfigObjectFiles(roots) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (CONFIG_OBJECT_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
                walk(full);
            } else if (entry.isFile()) {
                if (CONFIG_OBJECT_EXTS.has(path.extname(entry.name).toLowerCase())) out.push(full);
            }
        }
    };
    for (const root of (roots || [])) walk(root);
    return out;
}

/**
 * @typedef {Object} Workspace
 * @property {Object|null} projectMap The partition (see projectMap.js), or null before a scan.
 * @property {Map<string, Object>} indexes Project key → symbol index.
 * @property {Array<string>} rootPaths The workspace roots this was scanned from.
 * @property {(key: string) => Object} indexForKey
 * @property {(fileUri: string) => Object} indexForUri
 * @property {(fileUri: string) => (Object|null)} projectForUri
 * @property {(fileUri: string) => Array<string>} configFilesFor
 */

/**
 * Wraps a set of indexes and a partition in the routing API the request handlers use.
 * @param {Object|null} projectMap The partition, or null.
 * @param {Array<string>} rootPaths Workspace roots.
 * @returns {Workspace}
 */
function makeWorkspace(projectMap, rootPaths) {
    const indexes = new Map();

    const indexForKey = (key) => {
        if (!indexes.has(key)) indexes.set(key, {});
        return indexes.get(key);
    };

    const keyForUri = (fileUri) => {
        if (!projectMap) return LOOSE_PROJECT_KEY;
        return projectMap.projectFor(uriToFsPath(fileUri));
    };

    return {
        projectMap,
        indexes,
        rootPaths,
        indexForKey,
        indexForUri: (fileUri) => indexForKey(keyForUri(fileUri)),
        projectForUri: (fileUri) => {
            if (!projectMap) return null;
            return projectMap.get(keyForUri(fileUri));
        },
        /**
         * The configuration objects a rename of a symbol in this file may touch — its own project's,
         * and nothing else. An unscoped walk rewrites the OTHER project's .TcVIS/.TcTLO/.TcTTO:
         * those name PLC symbols by bare name, two projects share object names, and the edit breaks
         * the neighbour's XAE build in a file the user never opened.
         * @param {string} fileUri The renamed symbol's document URI.
         * @returns {Array<string>} Absolute configuration-object paths.
         */
        configFilesFor: (fileUri) => {
            if (!projectMap) return collectConfigObjectFiles(rootPaths);
            const project = projectMap.get(keyForUri(fileUri));
            if (!project) return collectConfigObjectFiles(rootPaths);
            return collectConfigObjectFiles([project.dir]);
        }
    };
}

/**
 * The pre-scan state, so a handler that fires before onInitialize never sees null.
 * @returns {Workspace}
 */
function createEmptyWorkspace() {
    return makeWorkspace(null, []);
}

/**
 * Discovers the projects under the given roots and indexes each one's objects into its own index.
 * @param {Array<string>} rootPaths Absolute workspace-root paths.
 * @param {{log?: (m: string) => void, error?: (m: string) => void,
 *   indexLibraries?: (dir: string, index: Object, roots: Array<string>) => void}} [deps] Injected side
 *   effects. `indexLibraries` is stubbed by the harnesses that only care about the partition.
 *   The third argument is the full set of workspace roots — `library-signatures.xml` is a
 *   WORKSPACE-level artifact (`twincat.updateLibraryDefinitions` writes it to `folders[0].fsPath`, see
 *   libraryCommands.js), not a per-project one, and it normally sits ABOVE `project.dir` in the tree,
 *   so a callee that only scans `dir` downward can never reach it. server.js's `indexLibraries` uses
 *   this to also scan the roots for that dump.
 * @returns {Workspace}
 */
function scanWorkspace(rootPaths, deps) {
    const { log = () => {}, error = () => {}, indexLibraries = () => {} } = deps || {};
    const roots = rootPaths || [];
    const projectMap = createProjectMap(roots);
    const workspace = makeWorkspace(projectMap, roots.slice());

    if (projectMap.isEmpty()) {
        // No .plcproj anywhere: a fresh clone, or a loose folder of TwinCAT files. Index everything
        // into one index — the pre-existing fallback, unchanged.
        const loose = workspace.indexForKey(LOOSE_PROJECT_KEY);
        for (const root of roots) {
            try {
                indexTwinCatDirectory(loose, root, null);
                indexStDirectory(root, loose);
                indexLibraries(root, loose, roots);
            } catch (e) {
                error(`Failed to index folder ${root}: ${e.message}`);
            }
        }
        return workspace;
    }

    for (const project of projectMap.projects.values()) {
        const index = workspace.indexForKey(project.key);
        // objectFiles values, NOT objectPaths: the normalized (lowercased) keys exist for ownership
        // identity only. A symbol node's uri is minted from the path given here, and a lowercased
        // uri makes every cross-file navigation open a duplicate, lowercase-titled editor tab
        // (vscode.openWith treats a differently-cased uri as a different resource).
        for (const objectFile of project.objectFiles.values()) {
            indexXmlFile(index, objectFile);
        }
        try {
            indexLibraries(project.dir, index, roots);
        } catch (e) {
            error(`Failed to index libraries for ${project.name}: ${e.message}`);
        }
    }

    // Loose .st files route to the project whose directory contains them (every project, when NO
    // project directory contains it — see routeFile below). The `index` fallback argument here is
    // never read — indexForFile is supplied on every call, including the recursive ones, so every .st
    // is routed through routeFile.
    const routeFile = (fsPath) => {
        const key = projectMap.projectFor(fsPath);
        if (key !== LOOSE_PROJECT_KEY) return workspace.indexForKey(key);
        // A .st file is not a `.plcproj` compilation unit, so there is no correctness argument for
        // hiding it from a project the way an unlisted .TcPOU orphan is hidden — the pre-existing
        // (single-index) behaviour put every .st where every document could see it. Restore that by
        // indexing it into EVERY project, rather than into the `(loose)` index nothing ever consults
        // (indexForUri only ever resolves to (loose) for a file under no project directory at all).
        return Array.from(projectMap.projects.values()).map(p => workspace.indexForKey(p.key));
    };
    for (const root of roots) {
        try {
            indexStDirectory(root, {}, routeFile);
        } catch (e) {
            error(`Failed to index .st files under ${root}: ${e.message}`);
        }
    }

    log(`Indexed ${projectMap.projects.size} PLC project(s): ` + projectMap.keys()
        .map(k => `${projectMap.displayName(k)} (${Object.keys(workspace.indexForKey(k)).length} symbols)`)
        .join(', '));
    return workspace;
}

module.exports = {
    CONFIG_OBJECT_EXTS,
    uriToFsPath,
    collectConfigObjectFiles,
    createEmptyWorkspace,
    scanWorkspace,
    normalizeProjectPath
};
