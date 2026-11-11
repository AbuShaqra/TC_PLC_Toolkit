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
const { indexStDirectory, parseAndIndexDocument } = require('./parser');
const { fileUriToFsPath, fsPathToFileUri } = require('../fileUri');
const {
    walkFiles,
    createDirectoryListingMemo,
    CONFIG_OBJECT_SKIP_DIRS,
    ST_INDEX_SKIP_DIRS
} = require('../twincatWorkspace');
const stLog = require('./log');
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
 * @typedef {Object} ReadinessGate
 * @property {(fileUri: string) => Promise<boolean>} readyFor Resolves once the index that answers this
 *   file is COMPLETE: true when it is, false when this workspace was superseded or its scan failed
 *   before getting there (the caller then re-resolves against the current workspace). A file in a
 *   project waits for that project only; a file under no project waits for the whole scan.
 * @property {() => Promise<boolean>} readyAll Resolves once every index is complete (true), or false as above.
 * @property {(fileUri: string) => boolean} isReadyFor Synchronous form of readyFor's "true".
 * @property {() => boolean} isComplete True once every index is complete.
 */

/**
 * The gate of a workspace that is complete the moment it exists (the pre-scan empty workspace and a
 * synchronous scan's result).
 * @returns {ReadinessGate}
 */
function completeGate() {
    return {
        readyFor: () => Promise.resolve(true),
        readyAll: () => Promise.resolve(true),
        isReadyFor: () => true,
        isComplete: () => true
    };
}

/**
 * The pre-scan state, so a handler that fires before onInitialize never sees null.
 * @returns {Workspace & ReadinessGate}
 */
function createEmptyWorkspace() {
    return Object.assign(makeWorkspace(null, []), completeGate());
}

/**
 * @typedef {Object} ScanTask One unit of a scan that leaves ONE index complete.
 * @property {string} key The project key whose index this task completes.
 * @property {() => void} run Indexes everything that index will ever receive in this scan.
 */

/**
 * Discovers the projects under the roots and plans their indexing as one task per index.
 *
 * A task holds EVERYTHING its index receives in a scan — its objects, its libraries, and the loose
 * `.st` files routed to it — so once a task has run, that index is final for the scan and may answer
 * requests while other projects are still being indexed. Nothing a task does reads or writes another
 * project's index (the archive, parse and listing caches it shares are content caches), so the tasks
 * can run in any order and each index comes out the same as in a one-pass scan.
 * @param {Array<string>} rootPaths Absolute workspace-root paths.
 * @param {Object} [deps] As scanWorkspace's.
 * @returns {{workspace: Workspace, tasks: Array<ScanTask>, finish: () => void}}
 */
function planWorkspaceScan(rootPaths, deps) {
    const { log = () => {}, error = () => {}, indexLibraries = () => {} } = deps || {};
    const roots = rootPaths || [];
    const projectMap = createProjectMap(roots);
    const workspace = makeWorkspace(projectMap, roots.slice());
    // One directory-listing memo per scan, handed to every project's library index: they all walk the
    // same workspace roots for the signatures dump. Dropped with the scan — never reused by the next
    // one, which is what keeps an added or removed dump or `.tmc` visible to the next reindex.
    const listing = createDirectoryListingMemo();

    if (projectMap.isEmpty()) {
        // No .plcproj anywhere: a fresh clone, or a loose folder of TwinCAT files. Index everything
        // into one index — the pre-existing fallback, unchanged, as ONE task.
        const loose = workspace.indexForKey(LOOSE_PROJECT_KEY);
        return {
            workspace,
            tasks: [{
                key: LOOSE_PROJECT_KEY,
                run: () => {
                    for (const root of roots) {
                        try {
                            indexTwinCatDirectory(loose, root, null);
                            indexStDirectory(root, loose);
                            indexLibraries(root, loose, roots, listing);
                        } catch (e) {
                            error(`Failed to index folder ${root}: ${e.message}`);
                        }
                    }
                }
            }],
            finish: () => {}
        };
    }

    // Loose .st files route to the project whose directory contains them, or to EVERY project when no
    // project directory contains one: a .st file is not a `.plcproj` compilation unit, so there is no
    // correctness argument for hiding it from a project the way an unlisted .TcPOU orphan is hidden —
    // the pre-existing (single-index) behaviour put every .st where every document could see it.
    // Collected once, up front, by the same walk indexStDirectory does (same skip set, same order), so
    // each project's task can index exactly the files routed to it, in walk order.
    const allKeys = projectMap.keys();
    const stFiles = [];
    for (const root of roots) {
        for (const fsPath of walkFiles(root, {
            skipDirs: ST_INDEX_SKIP_DIRS,
            isMatch: (name) => name.toLowerCase().endsWith('.st')
        })) {
            const key = projectMap.projectFor(fsPath);
            stFiles.push({ fsPath, keys: key !== LOOSE_PROJECT_KEY ? [key] : allKeys });
        }
    }
    // A .st routed to several projects is read once per scan, not once per project.
    /** @type {Map<string, {code?: string, error?: Error}>} */
    const stText = new Map();
    const readSt = (fsPath) => {
        let hit = stText.get(fsPath);
        if (!hit) {
            try {
                hit = { code: fs.readFileSync(fsPath, 'utf8') };
            } catch (e) {
                hit = { error: e };
            }
            stText.set(fsPath, hit);
        }
        return hit;
    };

    const tasks = Array.from(projectMap.projects.values()).map((project) => ({
        key: project.key,
        run: () => {
            const index = workspace.indexForKey(project.key);
            // objectFiles values, NOT objectPaths: the normalized (lowercased) keys exist for ownership
            // identity only. A symbol node's uri is minted from the path given here, and a lowercased
            // uri makes every cross-file navigation open a duplicate, lowercase-titled editor tab
            // (vscode.openWith treats a differently-cased uri as a different resource).
            for (const objectFile of project.objectFiles.values()) {
                indexXmlFile(index, objectFile);
            }
            try {
                indexLibraries(project.dir, index, roots, listing);
            } catch (e) {
                error(`Failed to index libraries for ${project.name}: ${e.message}`);
            }
            // The .st files last, as in the one-pass scan (a .st redefining an object's name wins).
            for (const st of stFiles) {
                if (!st.keys.includes(project.key)) continue;
                const text = readSt(st.fsPath);
                try {
                    if (text.error) throw text.error;
                    parseAndIndexDocument(text.code, fsPathToFileUri(st.fsPath), index);
                } catch (err) {
                    stLog.error('st-file-index-failed', { file: st.fsPath, error: err });
                }
            }
        }
    }));

    return {
        workspace,
        tasks,
        finish: () => {
            log(`Indexed ${projectMap.projects.size} PLC project(s): ` + projectMap.keys()
                .map(k => `${projectMap.displayName(k)} (${Object.keys(workspace.indexForKey(k)).length} symbols)`)
                .join(', '));
        }
    };
}

/**
 * Discovers the projects under the given roots and indexes each one's objects into its own index, in
 * one synchronous pass. The language server uses startWorkspaceScan (below), which runs the same tasks
 * with the event loop free between projects; this form is for the harnesses and any caller that wants
 * the finished workspace in hand.
 * @param {Array<string>} rootPaths Absolute workspace-root paths.
 * @param {{log?: (m: string) => void, error?: (m: string) => void,
 *   indexLibraries?: (dir: string, index: Object, roots: Array<string>, listing: Object) => void}} [deps]
 *   Injected side effects. `indexLibraries` is stubbed by the harnesses that only care about the
 *   partition. The third argument is the full set of workspace roots — `library-signatures.xml` is a
 *   WORKSPACE-level artifact (`twincat.updateLibraryDefinitions` writes it to `folders[0].fsPath`, see
 *   libraryCommands.js), not a per-project one, and it normally sits ABOVE `project.dir` in the tree,
 *   so a callee that only scans `dir` downward can never reach it. The fourth is the scan's
 *   directory-listing memo.
 * @returns {Workspace & ReadinessGate}
 */
function scanWorkspace(rootPaths, deps) {
    const plan = planWorkspaceScan(rootPaths, deps);
    for (const task of plan.tasks) task.run();
    plan.finish();
    return Object.assign(plan.workspace, completeGate());
}

/**
 * @typedef {Object} ScanHandle
 * @property {Workspace & ReadinessGate} workspace Routes immediately; each index answers only once its
 *   gate says so.
 * @property {Promise<'complete'|'cancelled'>} done Settles when the scan finishes or is cancelled;
 *   rejects when a task throws (every pending gate then resolves false first).
 * @property {() => void} cancel Stops after the task in progress; pending gates resolve false.
 */

/**
 * Starts a scan that indexes one project at a time with the event loop free in between, so a request
 * for a project that is already indexed is answered while the rest of the workspace is still being
 * scanned, and a request for one that is not yet indexed moves that project to the front of the queue.
 *
 * **The readiness gate is the whole point, and it is per index.** A project's gate opens only after its
 * task — objects, libraries and its `.st` files — has run to the end; nothing writes to that index for
 * the rest of the scan. A request must await `readyFor(uri)` before it touches `indexForUri(uri)`, and
 * between that await resolving and the handler running nothing else can run (one thread), so a request
 * can never see a half-built index. A file under no project (or a workspace with no projects at all)
 * waits for the whole scan.
 * @param {Array<string>} rootPaths Absolute workspace-root paths.
 * @param {Object} [deps] As scanWorkspace's, plus:
 *   `yieldToEventLoop` — () => Promise<void>, how the scan lets requests in between projects
 *   (setImmediate by default; the harness steps it by hand);
 *   `onProjectReady` — (key: string) => void, told as each project's gate opens;
 *   `onFailure` — (error: Error) => void, called when a task throws, BEFORE any pending gate resolves
 *   false, so whoever owns "the current workspace" has already moved off this one when a waiter wakes.
 * @returns {ScanHandle}
 */
function startWorkspaceScan(rootPaths, deps) {
    const {
        yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve)),
        onProjectReady = () => {},
        onFailure = () => {}
    } = deps || {};
    const plan = planWorkspaceScan(rootPaths, deps);
    // Every gate method is attached below, before the handle is returned.
    const workspace = /** @type {Workspace & ReadinessGate} */ (plan.workspace);

    /** A promise with its settle functions outside. */
    const deferred = () => {
        let settle;
        const promise = new Promise(resolve => { settle = resolve; });
        return { promise, settle, settled: false, value: false };
    };
    const gates = new Map(plan.tasks.map(t => [t.key, deferred()]));
    const all = deferred();
    const open = (gate, value) => {
        if (gate.settled) return;
        gate.settled = true;
        gate.value = value;
        gate.settle(value);
    };
    const failPending = () => {
        for (const gate of gates.values()) open(gate, false);
        open(all, false);
    };

    const queue = plan.tasks.slice();
    let cancelled = false;
    const gateKeyFor = (fileUri) => {
        if (!workspace.projectMap || workspace.projectMap.isEmpty()) return null;
        const key = workspace.projectMap.projectFor(uriToFsPath(fileUri));
        return gates.has(key) ? key : null;
    };

    Object.assign(workspace, {
        readyFor: (fileUri) => {
            const key = gateKeyFor(fileUri);
            if (key === null) return all.promise;
            const gate = gates.get(key);
            if (!gate.settled) {
                // Asked for before it was indexed: index it next.
                const at = queue.findIndex(t => t.key === key);
                if (at > 0) queue.unshift(queue.splice(at, 1)[0]);
            }
            return gate.promise;
        },
        readyAll: () => all.promise,
        isReadyFor: (fileUri) => {
            const key = gateKeyFor(fileUri);
            const gate = key === null ? all : gates.get(key);
            return gate.settled && gate.value === true;
        },
        isComplete: () => all.settled && all.value === true
    });

    const done = (async () => {
        // Yield first: the caller (onInitialize) answers before any project is indexed.
        await yieldToEventLoop();
        while (queue.length > 0) {
            if (cancelled) break;
            const task = queue.shift();
            task.run();
            open(gates.get(task.key), true);
            onProjectReady(task.key);
            await yieldToEventLoop();
        }
        if (cancelled) {
            failPending();
            return 'cancelled';
        }
        plan.finish();
        open(all, true);
        return 'complete';
    })().catch((e) => {
        try {
            onFailure(e);
        } catch (hookError) {
            /* the gates must still resolve */
        }
        failPending();
        throw e;
    });

    return {
        workspace,
        done,
        cancel: () => { cancelled = true; }
    };
}

module.exports = {
    CONFIG_OBJECT_EXTS,
    startWorkspaceScan,
    planWorkspaceScan,
    uriToFsPath,
    collectConfigObjectFiles,
    createEmptyWorkspace,
    scanWorkspace,
    selectLibraryCatalog,
    normalizeProjectPath
};
