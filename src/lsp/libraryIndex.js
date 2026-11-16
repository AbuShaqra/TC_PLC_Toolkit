/**
 * @file libraryIndex.js
 * @description The per-project library-index composition: every external source a PLC project
 * depends on, run in the validated stage order of requestPipeline.js's `runLibraryIndexPipeline`.
 *
 * Moved out of server.js for the reason workspaceScan.js and scanController.js live outside it:
 * server.js opens an IPC connection at require time, so nothing in it is loadable by a harness — and
 * the timing script (scripts/measure-indexing.js) and the scan harnesses must drive the SAME
 * composition the server runs, not a hand-written copy that can drift from it.
 */

const { indexLibraryNamespaces } = require('./libraries');
const {
    indexLibrarySymbols,
    indexTypeSystem,
    indexLibrarySignatures,
    indexBrowserCache
} = require('./libsymbols');
const { normalizeProjectPath } = require('./projectMap');
const { runLibraryIndexPipeline } = require('./requestPipeline');

/**
 * Builds the `indexLibraries` callback `scanWorkspace` injects.
 *
 * Indexes everything external a project depends on: library namespaces from the .plcproj, symbol
 * names from the ZIP `.compiled-library` archives, and the project's TwinCAT type system (`.tmc`).
 * The type system is required, not a nicety: some types the project resolves are in no readable
 * archive (a library may ship only as the opaque `.compiled-library-v3`, and some names live outside
 * the string table), yet TwinCAT exports every one of them into the plain-XML `.tmc`.
 *
 * The harvested names are NOT put into the symbol index here — that happens per document, in
 * server.js's syncDocument(), so the index stays at project scale.
 * @param {{log?: (line: string) => void}} [deps] Where the per-project summary line goes.
 * @returns {(fsPath: string, index: Object, roots?: Array<string>, discovery?: Object) => void}
 *   `fsPath` is the PROJECT directory, so only that project's own .plcproj, archives and .tmc are
 *   read. `index` is the owning project's symbol index — every registry is attached to it, so two
 *   projects' libraries never union. `roots` is the full set of workspace roots: `library-signatures.xml`
 *   is a WORKSPACE-level artifact (`twincat.updateLibraryDefinitions` writes it to `folders[0].fsPath`)
 *   and normally sits ABOVE `fsPath`, which `indexLibrarySignatures` (a downward scan) can never reach,
 *   so every root is scanned too. `discovery` is the scan's discovery memo (libsymbols.js
 *   `createDiscoveryMemo`), shared by every project of ONE scan so each directory is walked once.
 */
function createIndexLibraries(deps) {
    const { log = () => {} } = deps || {};
    return function indexLibraries(fsPath, index, roots, discovery) {
        // Shared between the `signatures` and `rootSignatures` runners below: runLibraryIndexPipeline's
        // patch merge is shallow last-write-wins per key, not a sum, so the running total across the
        // extra per-root scan has to be built by the runners themselves, closing over one object.
        let sig;
        const result = runLibraryIndexPipeline({
            namespaces: () => { indexLibraryNamespaces(fsPath, index); },
            symbols: () => ({ stats: indexLibrarySymbols(fsPath, index) }),
            typeSystem: () => ({ tmc: indexTypeSystem(fsPath, index, discovery) }),
            // Signatures merge AFTER the `.tmc`, so a `.tmc` type with real members wins over a
            // signature's bare-name entry. A project with no generated library-signatures.xml gets
            // zeroed stats and no registry change.
            signatures: () => {
                sig = indexLibrarySignatures(fsPath, index, discovery);
                return { sig };
            },
            // Also scan every workspace root for a signatures dump. Skip a root that IS fsPath —
            // already scanned by the `signatures` stage. Merging into every project's registry is safe
            // even when a root sits ABOVE a sibling project's directory too: namespaceForLibraryTitle()
            // returns '' for a library this project's .plcproj does not reference, so an unattributed
            // type lands only as a bare name — which can only SILENCE an undeclared-identifier
            // diagnostic, never raise one.
            rootSignatures: () => {
                for (const root of roots || []) {
                    if (normalizeProjectPath(root) === normalizeProjectPath(fsPath)) continue;
                    const rootSig = indexLibrarySignatures(root, index, discovery);
                    sig.files += rootSig.files;
                    sig.functions += rootSig.functions;
                    sig.functionBlocks += rootSig.functionBlocks;
                    sig.types += rootSig.types;
                    sig.added += rootSig.added;
                }
                return { sig };
            },
            // Browsercache enrichment runs LAST: it adds method/property NAMES to the FB/interface
            // types the signatures and `.tmc` have already filed under a namespace.
            browsercache: () => ({ bc: indexBrowserCache(fsPath, index) })
        }, { fsPath, index, roots });
        if (result.logLine) log(result.logLine);
    };
}

module.exports = { createIndexLibraries };
