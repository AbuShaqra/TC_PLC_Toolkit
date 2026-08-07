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
    getLibraryCatalog
} = require('./libsymbols');

const {
    createEmptyWorkspace,
    scanWorkspace,
    uriToFsPath
} = require('./workspaceScan');

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
 */
function indexLibraries(fsPath, index) {
    indexLibraryNamespaces(fsPath, index);
    const stats = indexLibrarySymbols(fsPath, index);
    const tmc = indexTypeSystem(fsPath, index);
    // Signatures merge AFTER the `.tmc`, so a `.tmc` type with real members wins over a signature's
    // bare-name entry (see libsymbols.js indexLibrarySignaturesFromXml). A project with no generated
    // library-signatures.xml gets zeroed stats and no registry change.
    const sig = indexLibrarySignatures(fsPath, index);
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
    const folders = params.workspaceFolders;
    if (folders && folders.length > 0) {
        rescan(folders.map(f => uriToFsPath(f.uri)));
    }

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

connection.onRequest('custom/updateTypesMap', (params) => {
    try {
        const typesMap = params.typesMap || {};

        for (const [name, typeInfo] of Object.entries(typesMap)) {
            // Routed per entry, not once for the whole map: typesMap is workspace-wide, and each
            // entry's own uri says which project's index it belongs to.
            const index = workspace.indexForUri(typeInfo.uri);
            // Non-destructive: never clobber a node already indexed from XML/ST with real ranges.
            // The typesMap (stubbed ranges) is only a fallback for symbols we haven't parsed directly.
            if (index[name]) continue;
            index[name] = {
                name: name,
                type: typeInfo.type,
                uri: typeInfo.uri || '',
                range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                extends: null,
                implements: [],
                variables: (typeInfo.variables || []).map(v => ({
                    name: v.name,
                    type: v.type,
                    scope: 'VAR',
                    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 }
                })),
                methods: (typeInfo.methods || []).map(mName => ({
                    name: mName,
                    variables: [],
                    returnType: 'BOOL',
                    declRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                    nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                    implRange: null
                })),
                properties: (typeInfo.properties || []).map(pName => ({
                    name: pName,
                    type: 'BOOL',
                    declRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                    nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                    getAccessor: null,
                    setAccessor: null
                })),
                actions: (typeInfo.actions || []).map(aName => ({
                    name: aName,
                    nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                    implRange: null
                }))
            };
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

connection.onRequest('custom/reindex', (params) => {
    try {
        // The converted-file cache keys on mtime, so it self-heals on edits; this drops entries for
        // files that no longer exist (deleted or renamed) rather than letting them accumulate.
        clearStFileCache();
        if (params.folders) {
            // A .plcproj edit (a file added, removed or renamed) is exactly what triggers a reindex,
            // so the partition itself is rebuilt here — a new project must produce a new index.
            rescan(params.folders.map(f => uriToFsPath(f)));
        }
        return { success: true };
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
        return getLibraryCatalog(workspace.indexForUri((params && params.fileUri) || ''));
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
