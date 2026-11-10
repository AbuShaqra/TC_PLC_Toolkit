/**
 * @file server.js
 * @description Background LSP server entrypoint communicating via Node IPC.
 */

const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    TextDocumentSyncKind
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');

const {
    parseAndIndexDocument
} = require('./parser');

const {
    indexXmlObject
} = require('./xmlIndexer');

const {
    registerLibrarySymbolNodes,
    configureArchiveCache,
    flushArchiveCache,
    archiveCacheInfo,
    getLibraryCatalog,
    getUnionLibraryCatalog
} = require('./libsymbols');

const {
    createEmptyWorkspace,
    scanWorkspace,
    selectLibraryCatalog,
    uriToFsPath
} = require('./workspaceScan');

const {
    createScanController
} = require('./scanController');

const {
    createRequestRouter
} = require('./requestPipeline');

const { createIndexLibraries } = require('./libraryIndex');

// Quiet by default (threshold `warn`, from TWINCAT_LSP_LOG) and writes to stderr, which the extension
// host captures — see log.js. Every handler below keeps returning its safe default on failure; the
// logger is what makes that default explicable instead of indistinguishable from "nothing to report".
const log = require('./log');

// The server OWNS the workspace and threads its indexes explicitly into the parser/indexer and every
// language-feature call, rather than reaching for the parser.js module global. There is ONE INDEX
// PER PLC PROJECT: a `.plcproj` is its own compilation unit (XAE does not resolve symbols across
// projects), and a single flat name-keyed map made two projects' same-named objects collide —
// last-write-wins, so half the workspace vanished and references pointed into the wrong project.
/** @type {import('./workspaceScan').Workspace} */
let workspace = createEmptyWorkspace();

/**
 * Rebuilds the partition and every index from the given roots.
 * @param {Array<string>} rootPaths Absolute workspace-root paths.
 */
function rescan(rootPaths) {
    workspace = scanWorkspace(rootPaths, {
        log: (m) => connection.console.log(m),
        error: (m) => connection.console.error(m),
        indexLibraries
    });
    // Persist what this scan decoded, so the next session reads names instead of inflating archives.
    // A no-op when nothing changed or no storage directory was given. A rejected (corrupt, foreign or
    // outdated) cache file was ignored and is rewritten by this flush; say so at debug level.
    const info = archiveCacheInfo();
    if (info.rejected || info.dropped) log.debug('archive-cache-ignored', { reason: info.rejected, dropped: info.dropped });
    flushArchiveCache();
}

// Which of the two requests that can trigger a scan actually has to run one. `custom/reindex` means
// "the data changed, rebuild"; `custom/indexReady` means "resolve once these roots are indexed", and
// the extension host's startup request is only ever the latter — it exists to order
// sendDiagnosticsConfig() and the Libraries refresh after the index. Sending it as a reindex made
// every startup pay for the whole scan a SECOND time, on top of onInitialize's. The decision lives in
// scanController.js because nothing in this file is loadable by a harness (IPC opens at require
// time), so the scan is injected the way workspaceScan.js injects indexLibraries.
const scanController = createScanController({ scan: rescan });

// The per-project library composition lives in libraryIndex.js, where the harnesses and the timing
// script drive the same code (nothing in this file is loadable standalone). `connection` is read at
// call time, after module load.
const indexLibraries = createIndexLibraries({ log: (m) => connection.console.log(m) });

/**
 * Brings the symbol index up to date with a document before any language feature runs on it:
 * parses the unit's own symbols, and registers the external-library symbols it references (see
 * libsymbols.js — this is what stops `DEFAULT_ADS_TIMEOUT`, `T_MaxString`, … being reported as
 * undeclared). Every withDocument-wrapped custom/* handler and the .st document listener go through
 * here (the router makes it unskippable), so no language request can be answered against an index
 * that has not seen the document's library usage.
 * @param {string} code Structured Text of the document.
 * @param {string} fileUri Document URI.
 * @param {Object} index The owning project's symbol index.
 */
function syncDocument(code, fileUri, index) {
    parseAndIndexDocument(code, fileUri, index);
    registerLibrarySymbolNodes(index, code);
}

const {
    provideCompletions,
    provideDefinition,
    provideReferences,
    provideReferencesForSymbol,
    findConfigReferencesForSymbol,
    provideDocumentHighlights,
    provideDiagnostics,
    setDiagnosticsConfig,
    clearStFileCache
} = require('./features');

// Create connection for the server, using Node IPC
const connection = createConnection(ProposedFeatures.all);

// Simple document manager
const documents = new TextDocuments(TextDocument);

connection.onInitialize((params) => {
    const folders = params.workspaceFolders || [];
    // The persisted archive-name cache lives in the extension's global storage (the host passes the
    // path); without one the cache stays in memory only, exactly as before. Configured BEFORE the
    // first scan, which is the scan that benefits.
    const initOptions = params.initializationOptions || {};
    if (typeof initOptions.archiveCacheDir === 'string' && initOptions.archiveCacheDir) {
        configureArchiveCache(initOptions.archiveCacheDir);
    }
    // Through the controller, not rescan() directly, so the completion is RECORDED — that record is
    // what lets the extension host's custom/indexReady resolve without scanning the same roots again.
    // scanWorkspace is synchronous, so this still blocks initialize exactly as it always has; the
    // promise is only the barrier's shape. An empty folder list is scanned too (it costs nothing —
    // no roots to walk, and the resulting workspace routes identically to createEmptyWorkspace's),
    // because that is what makes "no workspace folders" a *completed* state rather than one the host
    // would then re-request.
    scanController.ensureScanned(folders.map(f => uriToFsPath(f.uri)))
        .catch(e => connection.console.error(`Initial workspace scan failed: ${e.message}`));

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ['.']
            },
            definitionProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true
        }
    };
});

/**
 * True for generated ST exports (the "Generate ST" output folder). These are derived artifacts
 * and must not be indexed, or they would shadow the authoritative TwinCAT XML symbol nodes.
 * @param {string} uri Document URI.
 * @returns {boolean}
 */
function isGeneratedSt(uri) {
    return /[\/\\]ST_Files[\/\\]/i.test(uri);
}

// Standard Document Event Handlers (for .st text documents opened directly).
documents.onDidChangeContent((change) => {
    const doc = change.document;
    if (isGeneratedSt(doc.uri)) return; // ignore generated exports
    try {
        const index = workspace.indexForUri(doc.uri);
        syncDocument(doc.getText(), doc.uri, index);
        const diagnostics = provideDiagnostics(doc.getText(), index, doc.uri);
        connection.sendDiagnostics({ uri: doc.uri, diagnostics });
    } catch (err) {
        connection.console.error(`Error parsing document: ${err.message}`);
    }
});

/**
 * The `fields` object every request-failure record carries: which document, and where in it. The
 * position is flattened into two numbers rather than nested, so one grep of the log line gives the
 * coordinates the failing request was answering at.
 * @param {string} uri Document URI.
 * @param {{line: number, character: number}|undefined} position Cursor position, or undefined for a
 *   request that has none (the by-symbol and workspace-level ones).
 * @param {Error} error The swallowed error.
 * @returns {Object} Flat field object for log.error.
 */
function requestFailureFields(uri, position, error) {
    return {
        uri,
        line: position ? position.line : undefined,
        character: position ? position.character : undefined,
        error
    };
}

connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    try {
        return provideCompletions(doc.getText(), params.position, workspace.indexForUri(params.textDocument.uri), doc.uri);
    } catch (e) {
        log.error('completion-request-failed', requestFailureFields(doc.uri, params.position, e));
        return [];
    }
});

connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    try {
        return provideDefinition(doc.getText(), params.position, workspace.indexForUri(params.textDocument.uri), doc.uri);
    } catch (e) {
        log.error('definition-request-failed', requestFailureFields(doc.uri, params.position, e));
        return null;
    }
});

connection.onReferences((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    try {
        return provideReferences(doc.getText(), params.position, workspace.indexForUri(params.textDocument.uri), doc.uri);
    } catch (e) {
        log.error('references-request-failed', requestFailureFields(doc.uri, params.position, e));
        return [];
    }
});

connection.onDocumentHighlight((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    try {
        return provideDocumentHighlights(doc.getText(), params.position);
    } catch (e) {
        log.error('document-highlight-request-failed', requestFailureFields(doc.uri, params.position, e));
        return [];
    }
});

// Custom JSON-RPC requests for Monaco Webview bridge

// The wrapper every custom/* language-feature request below goes through — see requestPipeline.js's
// file header for why the sync must run before the handler, in that order, on every call, and for
// what withoutDocument's absence of that sync means. Built with an ARROW around
// `workspace.indexForUri`, not a bound method: `workspace` is REASSIGNED wholesale by rescan() (see
// its declaration above), and capturing the method at construction time would freeze the router to
// whatever `workspace` was before the first scan ever completed.
const router = createRequestRouter({
    getIndexForUri: (uri) => workspace.indexForUri(uri),
    sync: syncDocument,
    // The router swallows every failure so a bad request cannot take the server down — which is also
    // why a webview pane that suddenly offers no completions looks identical to one that has nothing
    // to offer. Report it; the fallback the caller receives is unchanged. `params.code` is a whole
    // document and never logged — only the identity and the coordinates of the failing request.
    onError: ({ event, error, params }) => log.error(`${event}-request-failed`,
        requestFailureFields(params && params.fileUri, params && params.position, error))
});

connection.onRequest('custom/completions', router.withDocument(
    [],
    (p, index) => provideCompletions(p.code, p.position, index, p.fileUri),
    'completion'
));

connection.onRequest('custom/definition', router.withDocument(
    null,
    (p, index) => provideDefinition(p.code, p.position, index, p.fileUri),
    'definition'
));

connection.onRequest('custom/references', router.withDocument(
    [],
    (p, index) => provideReferences(p.code, p.position, index, p.fileUri),
    'references'
));

// References for a symbol identified by NAME (root object, optionally a member), rather than by a
// cursor position — what a rename needs, and the only way to seed on a GVL (whose own name never
// appears in its converted ST). Deliberately NO syncDocument: there is no `code` param, and reading
// the target's file from disk is the whole point (provideReferencesForSymbol does that itself).
connection.onRequest('custom/referencesForSymbol', router.withoutDocument(
    { resolved: false, references: [], declaration: null },
    (p, index) => provideReferencesForSymbol(p, index),
    'references-for-symbol'
));

// References to a symbol inside the TwinCAT non-code objects — visualizations (.TcVIS/.TcVMO), text
// lists (.TcTLO/.TcGTLO) and task configurations (.TcTTO). This is the other half of a rename: all
// three name PLC symbols, and a stale one breaks the XAE build. Takes the same by-NAME spec as
// custom/referencesForSymbol; the files are discovered on demand, scoped to the symbol's own project
// so a rename never rewrites a same-named symbol's config objects in a project the user never opened.
// Needs a second workspace lookup (configFilesFor) beyond the index withoutDocument already resolves,
// so it reads `workspace` directly here rather than forcing that through the single-index handler
// signature.
connection.onRequest('custom/configReferencesForSymbol', router.withoutDocument(
    { resolved: false, occurrences: [] },
    (p, index) => findConfigReferencesForSymbol(p, index, workspace.configFilesFor(p.fileUri)),
    'config-references-for-symbol'
));

connection.onRequest('custom/diagnostics', router.withDocument(
    [],
    (p, index) => provideDiagnostics(p.code, index, p.fileUri),
    'diagnostics'
));

// The sync IS the work here: updateDocument exists to bring the index up to date, not to answer a
// language feature, so the handler itself just reports success.
connection.onRequest('custom/updateDocument', router.withDocument(
    (e) => ({ success: false, error: e.message }),
    () => ({ success: true }),
    'update-document'
));

// The five requests below are deliberately left UNWRAPPED by the router: none of them carry a
// document's live `params.code` for withDocument/withoutDocument to resolve an index around the same
// way — reindex/indexReady act on workspace folders, setDiagnosticsConfig/indexXmlDocument take their
// own payloads (a config object, raw XML), and libraries just reads the already-built catalog. Each
// keeps its own try/catch with a fallback shaped for its own response, as before.

// "The data changed, rebuild." UNCONDITIONAL, and it must stay that way: the .plcproj watcher and
// twincat.updateLibraryDefinitions send it with the roots UNCHANGED — it is the content under them
// that moved — so any "already scanned these roots" shortcut here would silently stop picking up
// added libraries and added objects. A caller that only wants the index to exist sends
// custom/indexReady instead.
connection.onRequest('custom/reindex', async (params) => {
    try {
        // The converted-file cache keys on mtime, so it self-heals on edits; this drops entries for
        // files that no longer exist (deleted or renamed) rather than letting them accumulate.
        clearStFileCache();
        if (params.folders) {
            // A .plcproj edit (a file added, removed or renamed) is exactly what triggers a reindex,
            // so the partition itself is rebuilt here — a new project must produce a new index.
            await scanController.rescan(params.folders.map(f => uriToFsPath(f)));
        }
        return { success: true };
    } catch (e) {
        log.error('reindex-request-failed', { folders: (params && params.folders) || [], error: e });
        return { success: false, error: e.message };
    }
});

// "Resolve once these roots are indexed." The extension host's startup barrier: its .then() runs
// sendDiagnosticsConfig() and refreshes the Libraries view, and the catalog is a by-product of the
// index, so the two must not be asked for before it exists. Scans only when no completed scan for
// this exact root set exists — normally none, because onInitialize has just done it.
connection.onRequest('custom/indexReady', async (params) => {
    try {
        const folders = (params && params.folders) || [];
        const result = await scanController.ensureScanned(folders.map(f => uriToFsPath(f)));
        return { success: true, scanned: result.scanned };
    } catch (e) {
        log.error('index-ready-request-failed', { folders: (params && params.folders) || [], error: e });
        return { success: false, error: e.message };
    }
});

// Update semantic-diagnostics toggles from the extension's configuration.
connection.onRequest('custom/setDiagnosticsConfig', (params) => {
    try {
        setDiagnosticsConfig(params || {});
        return { success: true };
    } catch (e) {
        log.error('set-diagnostics-config-request-failed', { error: e });
        return { success: false, error: e.message };
    }
});

// The referenced libraries, each with its title/version/company and the namespace the code must use.
// Answered from here rather than read directly by the extension host: the catalog is a by-product of
// an index that costs ~32k symbols and ~50 MB of archive reads, and duplicating that in a second
// process would pay for it twice.
connection.onRequest('custom/libraries', (params) => {
    try {
        // The catalog is per project — two projects reference different libraries. The extension
        // passes the active file so the view shows that project's libraries; the scope decision
        // itself lives in workspaceScan.js, where the routing it depends on lives (and where a
        // harness can reach it — nothing in this file is loadable standalone).
        return selectLibraryCatalog(workspace, (params && params.fileUri) || '',
            { getLibraryCatalog, getUnionLibraryCatalog });
    } catch (e) {
        // The Libraries view renders empty on an empty `libraries`, and an empty view has always been
        // the visible symptom of this catch — this is the line that says whether it was empty or broken.
        log.error('libraries-request-failed', { uri: (params && params.fileUri) || '', error: e });
        return { scope: 'union', projectKey: null, libraries: [] };
    }
});

// Index (or re-index) a single TwinCAT XML object from its raw content. Called by the
// extension when a TwinCAT file is created, changed, or saved.
connection.onRequest('custom/indexXmlDocument', (params) => {
    try {
        indexXmlObject(workspace.indexForUri(params.fileUri), params.xml, params.fileUri);
        return { success: true };
    } catch (e) {
        log.error('index-xml-document-request-failed', { uri: params && params.fileUri, error: e });
        return { success: false, error: e.message };
    }
});

// Write any names decoded since the last scan (a lazily harvested nested namespace) before the
// process goes away.
connection.onShutdown(() => {
    flushArchiveCache();
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();
