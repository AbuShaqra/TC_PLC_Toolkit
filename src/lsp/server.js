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
    indexLibraryNamespaces
} = require('./libraries');

const {
    indexLibrarySymbols,
    indexTypeSystem,
    indexLibrarySignatures,
    indexBrowserCache,
    registerLibrarySymbolNodes,
    getLibraryCatalog,
    getUnionLibraryCatalog
} = require('./libsymbols');

const {
    createEmptyWorkspace,
    scanWorkspace,
    uriToFsPath,
    normalizeProjectPath
} = require('./workspaceScan');

const {
    createScanController
} = require('./scanController');

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
}

// Which of the two requests that can trigger a scan actually has to run one. `custom/reindex` means
// "the data changed, rebuild"; `custom/indexReady` means "resolve once these roots are indexed", and
// the extension host's startup request is only ever the latter — it exists to order
// sendDiagnosticsConfig() and the Libraries refresh after the index. Sending it as a reindex made
// every startup pay for the whole scan a SECOND time, on top of onInitialize's. The decision lives in
// scanController.js because nothing in this file is loadable by a harness (IPC opens at require
// time), so the scan is injected the way workspaceScan.js injects indexLibraries.
const scanController = createScanController({ scan: rescan });

/**
 * Indexes everything external a workspace folder depends on: library namespaces from the .plcproj,
 * symbol names from the ZIP `.compiled-library` archives, and the project's TwinCAT type system
 * (`.tmc`). The type system is required, not a nicety: some types the project resolves are in no
 * readable archive (a library may ship only as the opaque `.compiled-library-v3`, and some names
 * live outside the string table), yet TwinCAT exports every one of them into the plain-XML `.tmc`.
 *
 * The harvested names are NOT put into the symbol index here — that happens per document, in
 * syncDocument(), so the index stays at project scale.
 * @param {string} fsPath Absolute folder path — the PROJECT directory, so only that project's own
 *   .plcproj, archives and .tmc are read.
 * @param {Object} [index] The owning project's symbol index. Every registry below is attached to it
 *   (see libraries.js / libsymbols.js registryFor / libRegistryFor), so two projects' libraries never
 *   union — each project stays quiet only about the libraries it actually references.
 * @param {Array<string>} [roots] The full set of workspace roots (see workspaceScan.js scanWorkspace).
 *   `library-signatures.xml` is a WORKSPACE-level artifact — `twincat.updateLibraryDefinitions` writes
 *   it to `folders[0].fsPath` (libraryCommands.js), and `scripts/generate-library-signatures.ps1`
 *   documents that target as `<workspace>\library-signatures.xml` — not a per-project one, and in the
 *   normal TwinCAT layout it sits ABOVE `fsPath` (the `.plcproj` directory is at least one level
 *   below the workspace root). `indexLibrarySignatures` only scans DOWNWARD from the directory it is
 *   given, so a scan rooted at `fsPath` alone can never reach it. Scan every root too.
 */
function indexLibraries(fsPath, index, roots) {
    indexLibraryNamespaces(fsPath, index);
    const stats = indexLibrarySymbols(fsPath, index);
    const tmc = indexTypeSystem(fsPath, index);
    // Signatures merge AFTER the `.tmc`, so a `.tmc` type with real members wins over a signature's
    // bare-name entry (see libsymbols.js indexLibrarySignaturesFromXml). A project with no generated
    // library-signatures.xml gets zeroed stats and no registry change.
    const sig = indexLibrarySignatures(fsPath, index);
    // Also scan every workspace root for a signatures dump (see the `roots` param doc above). Skip a
    // root that IS fsPath — already scanned on the line above, so scanning it again would only double
    // the reported stats. Merging into every project's registry is safe even when a root sits ABOVE a
    // sibling project's directory too (a multi-project workspace): namespaceForLibraryTitle() returns
    // '' for a library this project's .plcproj does not reference, so an unattributed type lands only
    // as a bare name in librarySymbols — which can only SILENCE an undeclared-identifier diagnostic,
    // never raise one. The merge itself is documented additive/idempotent, so overlap with fsPath's own
    // scan (or between two projects sharing a root) contributes nothing beyond wasted work.
    for (const root of roots || []) {
        if (normalizeProjectPath(root) === normalizeProjectPath(fsPath)) continue;
        const rootSig = indexLibrarySignatures(root, index);
        sig.files += rootSig.files;
        sig.functions += rootSig.functions;
        sig.functionBlocks += rootSig.functionBlocks;
        sig.types += rootSig.types;
        sig.added += rootSig.added;
    }
    // Browsercache enrichment runs LAST: it adds method/property NAMES to the FB/interface types the
    // signatures and `.tmc` have already filed under a namespace (see libsymbols.js indexBrowserCache).
    const bc = indexBrowserCache(fsPath, index);
    if (stats.archives > 0 || stats.failed > 0 || tmc.files > 0 || sig.files > 0) {
        connection.console.log(
            `Library symbols: ${stats.symbols} from ${stats.archives} archive(s) ` +
            `(${stats.failed} undecodable) in ${stats.ms} ms; ` +
            `type system: ${tmc.files} .tmc file(s), ${tmc.symbols} total symbols in ${tmc.ms} ms; ` +
            `signatures: ${sig.files} file(s), ${sig.functions} function(s), ` +
            `${sig.functionBlocks} FB(s), ${sig.added} type(s) merged in ${sig.ms} ms; ` +
            `browsercache: ${bc.methods} method(s) + ${bc.properties} propert${bc.properties === 1 ? 'y' : 'ies'} ` +
            `on ${bc.types} type(s) from ${bc.libraries} librar${bc.libraries === 1 ? 'y' : 'ies'} in ${bc.ms} ms.`
        );
    }
}

/**
 * Brings the symbol index up to date with a document before any language feature runs on it:
 * parses the unit's own symbols, and registers the external-library symbols it references (see
 * libsymbols.js — this is what stops `DEFAULT_ADS_TIMEOUT`, `T_MaxString`, … being reported as
 * undeclared). Every custom/* handler and the .st document listener go through here, so no request
 * can be answered against an index that has not seen the document's library usage.
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

connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    try {
        return provideCompletions(doc.getText(), params.position, workspace.indexForUri(params.textDocument.uri), doc.uri);
    } catch (e) {
        return [];
    }
});

connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    try {
        return provideDefinition(doc.getText(), params.position, workspace.indexForUri(params.textDocument.uri), doc.uri);
    } catch (e) {
        return null;
    }
});

connection.onReferences((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    try {
        return provideReferences(doc.getText(), params.position, workspace.indexForUri(params.textDocument.uri), doc.uri);
    } catch (e) {
        return [];
    }
});

connection.onDocumentHighlight((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    try {
        return provideDocumentHighlights(doc.getText(), params.position);
    } catch (e) {
        return [];
    }
});

// Custom JSON-RPC requests for Monaco Webview bridge
connection.onRequest('custom/completions', (params) => {
    try {
        const index = workspace.indexForUri(params.fileUri);
        syncDocument(params.code, params.fileUri, index);
        return provideCompletions(params.code, params.position, index, params.fileUri);
    } catch (e) {
        return [];
    }
});

connection.onRequest('custom/definition', (params) => {
    try {
        const index = workspace.indexForUri(params.fileUri);
        syncDocument(params.code, params.fileUri, index);
        return provideDefinition(params.code, params.position, index, params.fileUri);
    } catch (e) {
        return null;
    }
});

connection.onRequest('custom/references', (params) => {
    try {
        const index = workspace.indexForUri(params.fileUri);
        syncDocument(params.code, params.fileUri, index);
        return provideReferences(params.code, params.position, index, params.fileUri);
    } catch (e) {
        return [];
    }
});

// References for a symbol identified by NAME (root object, optionally a member), rather than by a
// cursor position — what a rename needs, and the only way to seed on a GVL (whose own name never
// appears in its converted ST). Deliberately NO syncDocument: there is no `code` param, and reading
// the target's file from disk is the whole point (provideReferencesForSymbol does that itself).
connection.onRequest('custom/referencesForSymbol', (params) => {
    try {
        return provideReferencesForSymbol(params, workspace.indexForUri(params.fileUri));
    } catch (e) {
        return { resolved: false, references: [], declaration: null };
    }
});

// References to a symbol inside the TwinCAT non-code objects — visualizations (.TcVIS/.TcVMO), text
// lists (.TcTLO/.TcGTLO) and task configurations (.TcTTO). This is the other half of a rename: all
// three name PLC symbols, and a stale one breaks the XAE build. Takes the same by-NAME spec as
// custom/referencesForSymbol; the files are discovered on demand, scoped to the symbol's own project
// so a rename never rewrites a same-named symbol's config objects in a project the user never opened.
connection.onRequest('custom/configReferencesForSymbol', (params) => {
    try {
        const configFiles = workspace.configFilesFor(params.fileUri);
        return findConfigReferencesForSymbol(params, workspace.indexForUri(params.fileUri), configFiles);
    } catch (e) {
        return { resolved: false, occurrences: [] };
    }
});

connection.onRequest('custom/diagnostics', (params) => {
    try {
        const index = workspace.indexForUri(params.fileUri);
        syncDocument(params.code, params.fileUri, index);
        return provideDiagnostics(params.code, index, params.fileUri);
    } catch (e) {
        return [];
    }
});

connection.onRequest('custom/updateDocument', (params) => {
    try {
        syncDocument(params.code, params.fileUri, workspace.indexForUri(params.fileUri));
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

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
        return { success: false, error: e.message };
    }
});

// Update semantic-diagnostics toggles from the extension's configuration.
connection.onRequest('custom/setDiagnosticsConfig', (params) => {
    try {
        setDiagnosticsConfig(params || {});
        return { success: true };
    } catch (e) {
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
        // passes the active file so the view shows that project's libraries.
        const catalog = getLibraryCatalog(workspace.indexForUri((params && params.fileUri) || ''));
        if (catalog.length > 0) return catalog;
        // No fileUri (the extension host has not been updated to send the active file), or the routed
        // project genuinely references no libraries: fall back to every project's catalog, unioned.
        // The view is read-only browsing, so a superset is harmless — showing nothing at all is the
        // regression. In a single-project workspace the union IS that project's own catalog, so this
        // restores exactly what custom/libraries returned before per-project scoping.
        return getUnionLibraryCatalog(workspace.indexes.values());
    } catch (e) {
        return [];
    }
});

// Index (or re-index) a single TwinCAT XML object from its raw content. Called by the
// extension when a TwinCAT file is created, changed, or saved.
connection.onRequest('custom/indexXmlDocument', (params) => {
    try {
        indexXmlObject(workspace.indexForUri(params.fileUri), params.xml, params.fileUri);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();
