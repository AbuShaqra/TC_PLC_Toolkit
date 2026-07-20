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

const fs = require('fs');
const path = require('path');

const {
    parseAndIndexDocument,
    indexStDirectory,
    clearWorkspaceIndex
} = require('./parser');

// The server OWNS the workspace symbol index and threads it explicitly into the parser/indexer and
// every language-feature call, rather than reaching for the parser.js module global. That global
// remains only the default for the standalone test harnesses; here the data flow is explicit, and a
// future multi-root setup could hold one index per workspace folder without touching global state.
const workspaceIndex = {};

// The workspace-root filesystem paths, captured on the initial scan. The visualization-file
// reference scan (custom/visuReferencesForSymbol) needs to discover .TcVIS/.TcVMO files on demand,
// and those roots are the only place to start the walk. Kept in sync on reindex.
const workspaceRootPaths = [];

const {
    indexTwinCatDirectory,
    indexXmlObject,
    collectPlcProjObjectPaths
} = require('./xmlIndexer');

const {
    indexLibraryNamespaces,
    clearLibraryNamespaces
} = require('./libraries');

const {
    indexLibrarySymbols,
    indexTypeSystem,
    indexLibrarySignatures,
    indexBrowserCache,
    registerLibrarySymbolNodes,
    clearLibrarySymbols,
    getLibraryCatalog
} = require('./libsymbols');

/**
 * Converts an LSP folder URI (file:///C:/...) to a filesystem path.
 * @param {string} uri Folder URI.
 * @returns {string} Filesystem path.
 */
function uriToFsPath(uri) {
    return decodeURIComponent(uri.replace(/^file:\/\/\//i, '')).replace(/\//g, '\\');
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
 * @param {string} fsPath Absolute folder path.
 */
function indexLibraries(fsPath) {
    indexLibraryNamespaces(fsPath);
    const stats = indexLibrarySymbols(fsPath);
    const tmc = indexTypeSystem(fsPath);
    // Signatures merge AFTER the `.tmc`, so a `.tmc` type with real members wins over a signature's
    // bare-name entry (see libsymbols.js indexLibrarySignaturesFromXml). A project with no generated
    // library-signatures.xml gets zeroed stats and no registry change.
    const sig = indexLibrarySignatures(fsPath);
    // Browsercache enrichment runs LAST: it adds method/property NAMES to the FB/interface types the
    // signatures and `.tmc` have already filed under a namespace (see libsymbols.js indexBrowserCache).
    const bc = indexBrowserCache(fsPath);
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
 */
function syncDocument(code, fileUri) {
    parseAndIndexDocument(code, fileUri, workspaceIndex);
    registerLibrarySymbolNodes(workspaceIndex, code);
}

const {
    provideCompletions,
    provideDefinition,
    provideReferences,
    provideReferencesForSymbol,
    findVisuReferencesForSymbol,
    provideDocumentHighlights,
    provideDiagnostics,
    setDiagnosticsConfig,
    clearStFileCache
} = require('./features');

/** Directories skipped when walking for visu files — the same set the XML indexer skips. */
const VISU_SKIP_DIRS = new Set(['.git', 'node_modules', '.vscode', '_libraries']);

/**
 * Recursively collects every TwinCAT visualization file (`.TcVIS`/`.TcVMO`, case-insensitive) under
 * the given workspace roots. Rename is a rare, deliberate action, so an on-demand walk is fine — no
 * standing index of visu files is kept.
 * @param {Array<string>} roots Absolute workspace-root paths.
 * @returns {Array<string>} Absolute visu file paths.
 */
function collectVisuFiles(roots) {
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
                if (VISU_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
                walk(full);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (ext === '.tcvis' || ext === '.tcvmo') out.push(full);
            }
        }
    };
    for (const root of (roots || [])) walk(root);
    return out;
}

// Create connection for the server, using Node IPC
const connection = createConnection(ProposedFeatures.all);

// Simple document manager
const documents = new TextDocuments(TextDocument);

connection.onInitialize((params) => {
    // Perform initial workspace scan: index TwinCAT XML objects directly (real cross-file index),
    // and also pick up any generated .st files.
    const folders = params.workspaceFolders;
    if (folders && folders.length > 0) {
        const index = workspaceIndex;
        workspaceRootPaths.length = 0;
        // The .plcproj — not the filesystem — defines the project: only its <Compile>d objects are
        // indexed, so a backup/orphan copy on disk cannot shadow a real object in the name-keyed
        // index (which silently stole its references from cross-file rename). null = no project found,
        // so index everything (fresh clone, or a loose folder of TwinCAT files).
        const includedPaths = collectPlcProjObjectPaths(folders.map(f => uriToFsPath(f.uri)));
        folders.forEach(f => {
            const fsPath = uriToFsPath(f.uri);
            workspaceRootPaths.push(fsPath);
            try {
                indexTwinCatDirectory(index, fsPath, includedPaths);
                indexStDirectory(fsPath, workspaceIndex);
                indexLibraries(fsPath);
            } catch (e) {
                connection.console.error(`Failed to index folder ${fsPath}: ${e.message}`);
            }
        });
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
        syncDocument(doc.getText(), doc.uri);
        const diagnostics = provideDiagnostics(doc.getText(), workspaceIndex, doc.uri);
        connection.sendDiagnostics({ uri: doc.uri, diagnostics });
    } catch (err) {
        connection.console.error(`Error parsing document: ${err.message}`);
    }
});

connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    try {
        return provideCompletions(doc.getText(), params.position, workspaceIndex, doc.uri);
    } catch (e) {
        return [];
    }
});

connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    try {
        return provideDefinition(doc.getText(), params.position, workspaceIndex, doc.uri);
    } catch (e) {
        return null;
    }
});

connection.onReferences((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    try {
        return provideReferences(doc.getText(), params.position, workspaceIndex, doc.uri);
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
        syncDocument(params.code, params.fileUri);
        return provideCompletions(params.code, params.position, workspaceIndex, params.fileUri);
    } catch (e) {
        return [];
    }
});

connection.onRequest('custom/definition', (params) => {
    try {
        syncDocument(params.code, params.fileUri);
        return provideDefinition(params.code, params.position, workspaceIndex, params.fileUri);
    } catch (e) {
        return null;
    }
});

connection.onRequest('custom/references', (params) => {
    try {
        syncDocument(params.code, params.fileUri);
        return provideReferences(params.code, params.position, workspaceIndex, params.fileUri);
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
        return provideReferencesForSymbol(params, workspaceIndex);
    } catch (e) {
        return { resolved: false, references: [], declaration: null };
    }
});

// References to a symbol inside the TwinCAT visualization files (.TcVIS/.TcVMO) — the other half of
// a rename, since visu paths reference PLC symbols and a stale one breaks the XAE build. Takes the
// same by-NAME spec as custom/referencesForSymbol; the visu files are discovered on demand by walking
// the workspace roots (rename is rare, so no standing index is kept).
connection.onRequest('custom/visuReferencesForSymbol', (params) => {
    try {
        const visuFiles = collectVisuFiles(workspaceRootPaths);
        return findVisuReferencesForSymbol(params, workspaceIndex, visuFiles);
    } catch (e) {
        return { resolved: false, occurrences: [] };
    }
});

connection.onRequest('custom/diagnostics', (params) => {
    try {
        syncDocument(params.code, params.fileUri);
        return provideDiagnostics(params.code, workspaceIndex, params.fileUri);
    } catch (e) {
        return [];
    }
});

connection.onRequest('custom/updateDocument', (params) => {
    try {
        syncDocument(params.code, params.fileUri);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

connection.onRequest('custom/updateTypesMap', (params) => {
    try {
        const typesMap = params.typesMap || {};
        const index = workspaceIndex;

        for (const [name, typeInfo] of Object.entries(typesMap)) {
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
        clearWorkspaceIndex(workspaceIndex);
        clearLibraryNamespaces();
        clearLibrarySymbols();
        // The converted-file cache keys on mtime, so it self-heals on edits; this drops entries for
        // files that no longer exist (deleted or renamed) rather than letting them accumulate.
        clearStFileCache();
        const index = workspaceIndex;
        if (params.folders) {
            workspaceRootPaths.length = 0;
            // Re-resolve the project object set: a .plcproj edit (a file added, removed or renamed) is
            // exactly what triggers custom/reindex, so the include set must be rebuilt here too.
            const includedPaths = collectPlcProjObjectPaths(params.folders.map(f => uriToFsPath(f)));
            params.folders.forEach(f => {
                const fsPath = uriToFsPath(f);
                workspaceRootPaths.push(fsPath);
                indexTwinCatDirectory(index, fsPath, includedPaths);
                indexStDirectory(fsPath, workspaceIndex);
                indexLibraries(fsPath);
            });
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
connection.onRequest('custom/libraries', () => {
    try {
        return getLibraryCatalog();
    } catch (e) {
        return [];
    }
});

// Index (or re-index) a single TwinCAT XML object from its raw content. Called by the
// extension when a TwinCAT file is created, changed, or saved.
connection.onRequest('custom/indexXmlDocument', (params) => {
    try {
        const index = workspaceIndex;
        indexXmlObject(index, params.xml, params.fileUri);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();
