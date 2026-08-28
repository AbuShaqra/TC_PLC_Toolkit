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

const path = require('path');

const { indexXmlFile, indexTwinCatDirectory } = require('./xmlIndexer');
const { indexStDirectory } = require('./parser');
const { fileUriToFsPath } = require('../fileUri');
const { walkFiles, CONFIG_OBJECT_SKIP_DIRS } = require('../twincatWorkspace');
const {
    LOOSE_PROJECT_KEY,
    createProjectMap,
    normalizeProjectPath
} = require('./projectMap');

/**
 * TwinCAT non-code object extensions that can carry a PLC symbol reference (lower-cased): the two
 * visualization formats, the two text-list formats, and the task configuration. Genuinely local to
 * this walk (configuration objects, not source objects) — not part of the shared discovery owner.
 * @type {Set<string>}
 */
const CONFIG_OBJECT_EXTS = new Set(['.tcvis', '.tcvmo', '.tctlo', '.tcgtlo', '.tctto']);

/**
 * Converts an LSP file URI to a platform-correct filesystem path. Bare paths pass through unchanged.
 * @param {string} uri File or folder URI.
 * @returns {string} Filesystem path.
 */
function uriToFsPath(uri) {
    return fileUriToFsPath(uri);
}

/**
 * Recursively collects every TwinCAT configuration object under the given roots. Rename is a rare,
 * deliberate action, so an on-demand walk is fine — no standing index of these files is kept.
 * @param {Array<string>} roots Absolute paths to walk.
 * @returns {Array<string>} Absolute configuration-object file paths.
 */
function collectConfigObjectFiles(roots) {
    return walkFiles(roots || [], {
        skipDirs: CONFIG_OBJECT_SKIP_DIRS,
        isMatch: (name) => CONFIG_OBJECT_EXTS.has(path.extname(name).toLowerCase())
    });
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
 * @typedef {Object} LibraryCatalogResponse
 * @property {'project'|'union'} scope Which catalog was answered with.
 * @property {string|null} projectKey The project key when scoped, else null. An identity key, not a
 *           path and not a label — never mint a URI or a display name from it.
 * @property {Array<Object>} libraries The catalog entries.
 */

/**
 * Picks the library catalog `custom/libraries` answers with, given the active file (if any).
 *
 * Lives here, not in server.js, for the reason the whole file exists: server.js opens IPC at require
 * time and cannot be loaded by a harness, and *which index answers a request* is exactly the decision
 * that needs a regression gate. The two catalog builders are injected rather than required so this
 * module keeps its current require graph (libsymbols.js pulls in the archive readers).
 *
 * The scope rule, and why each half is the way it is:
 * - A `fileUri` that routes to a real PLC project answers with **that project's** catalog, **even
 *   when it is empty** — an explicit scope must never silently widen. A project that references no
 *   libraries has an empty Libraries view, and that is the truth about it; showing the neighbour's
 *   libraries there would be a lie the user cannot tell from a bug.
 * - No `fileUri`, or one that routes to the `(loose)` index (a file under no project directory at
 *   all), answers with the **union** of every project. There is no project to be right about, and an
 *   empty view is the regression this fallback was added to prevent. `projectForUri` returning null
 *   is the routing API's own way of saying "loose" — the key string is identity, never parsed here.
 * @param {Workspace} workspace The routed workspace.
 * @param {string} fileUri The active file's URI, or '' when the host has none.
 * @param {{getLibraryCatalog: (index: Object) => Array<Object>,
 *   getUnionLibraryCatalog: (indexes: Iterable<Object>) => Array<Object>}} catalogFns Injected builders.
 * @returns {LibraryCatalogResponse}
 */
function selectLibraryCatalog(workspace, fileUri, catalogFns) {
    const { getLibraryCatalog, getUnionLibraryCatalog } = catalogFns;
    const project = fileUri ? workspace.projectForUri(fileUri) : null;
    if (project) {
        return {
            scope: 'project',
            projectKey: project.key,
            libraries: getLibraryCatalog(workspace.indexForKey(project.key))
        };
    }
    return {
        scope: 'union',
        projectKey: null,
        libraries: getUnionLibraryCatalog(workspace.indexes.values())
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
    selectLibraryCatalog,
    normalizeProjectPath
};
