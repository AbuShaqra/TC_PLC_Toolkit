/**
 * @file libraries.js
 * @description Registry of external library namespaces declared by the project's .plcproj files.
 *
 * TwinCAT projects reference libraries (Tc2_System, VisuElems, ...) that ship as binary
 * `.compiled-library` archives; their symbols are never indexed, so every identifier rooted at a
 * library namespace would otherwise be reported as undeclared. The `.plcproj` is plain XML and
 * names each library's namespace explicitly, in one of two element kinds — a version-resolved
 * placeholder, or a pinned direct reference:
 *
 *     <PlaceholderReference Include="System_VisuElems">
 *       <DefaultResolution>VisuElems, 4.8.0.0 (System)</DefaultResolution>
 *       <Namespace>VisuElems</Namespace>
 *     </PlaceholderReference>
 *
 *     <LibraryReference Include="Tc2_EtherCAT,3.5.1.0,Beckhoff Automation GmbH">
 *       <Namespace>Tc2_EtherCAT</Namespace>
 *     </LibraryReference>
 *
 * Both kinds must be harvested: the sample declares 26 of the former and 2 of the latter
 * (Tc2_ControllerToolbox, Tc2_EtherCAT), and a namespace missed here is a false positive.
 *
 * Harvesting those names lets the undeclared-identifier check stay silent on namespace heads
 * (`VisuElems` in `VisuElems.VisuElemBase.Visu_Globals.g_ClientManager.BeginIteration()`) without
 * suppressing anything else. Parsing is regex-based, in the style of xmlParser.js — no XML DOM.
 */

const fs = require('fs');
const {
    parseLibraryReferences,
    readLibraryReferences,
    collectPlcProjFiles
} = require('./plcprojRefs');

/**
 * The registry key on a symbol index. A `Symbol` deliberately: `Object.keys()`, `for…in` and
 * `JSON.stringify` all skip symbol-keyed properties, and the index is iterated by key in several hot
 * paths (the reference scan, the GVL-global lookup in types.js). Attaching the registry to the index
 * therefore costs those loops nothing and needs no signature change where the index is already in
 * hand — notably registerLibrarySymbolNodes(index, code).
 */
const NAMESPACE_REGISTRY = Symbol.for('twincat.libraryNamespaces');

/**
 * Known library namespaces for the DEFAULT (unscoped) registry, stored lower-cased: Structured Text
 * is case-insensitive. This module global remains the fallback for callers with no index — the
 * standalone test harnesses, and any single-project path that has not been threaded yet.
 * @type {Set<string>}
 */
const libraryNamespaces = new Set();

/**
 * The namespace registry for a symbol index — READ side. Never mutates `index`: when this exact
 * index has never had its own registry created (nothing was ever indexed *into* it — see
 * ensureRegistryFor, the write-side twin), this falls back to the shared default registry rather than
 * silently reading an empty one.
 *
 * That fallback is what keeps ~15 pre-existing standalone harnesses working unchanged: they populate
 * the namespace registry with NO index (the default), then exercise a feature (provideDiagnostics,
 * provideCompletions) against a real, separately-constructed symbol index that was never itself
 * indexed. For any project `indexLibraries` HAS processed (see ensureRegistryFor), this branch is
 * never taken — that project's own registry already exists by the time isLibraryNamespace/
 * getLibraryNamespaces run. It IS taken for an index nothing has indexed yet: workspaceScan.js's
 * `indexForKey` lazily creates an empty `{}` for any project key not yet scanned (reachable for
 * LOOSE_PROJECT_KEY), and that is exactly what made the custom/libraries handler return nothing before
 * its union fallback was added (see server.js, getUnionLibraryCatalog).
 * @param {Object} [index] A project's symbol index. Omit for the default registry.
 * @returns {Set<string>} The lower-cased namespace set for that project (or the default's).
 */
function registryFor(index) {
    if (!index) return libraryNamespaces;
    return index[NAMESPACE_REGISTRY] || libraryNamespaces;
}

/**
 * The namespace registry for a symbol index — WRITE side: creates and attaches this index's OWN
 * registry on first use, even if the write that follows adds nothing to it (a project that
 * references no libraries still gets an empty registry of its own, so a later read is correctly
 * isolated rather than falling back to the default). Every function that populates or clears the
 * registry must go through this, never registryFor — reading-and-creating would let one project's
 * write silently land on the shared default instead of its own index.
 * @param {Object} [index] A project's symbol index. Omit for the default registry.
 * @returns {Set<string>} The lower-cased namespace set for that project.
 */
function ensureRegistryFor(index) {
    if (!index) return libraryNamespaces;
    if (!index[NAMESPACE_REGISTRY]) index[NAMESPACE_REGISTRY] = new Set();
    return index[NAMESPACE_REGISTRY];
}

/**
 * Extracts the library namespaces declared by a .plcproj's <PlaceholderReference> and
 * <LibraryReference> blocks. Only <Namespace> tags *inside* such a block are taken — the element
 * name is generic enough (it also appears under <Compile>) that matching it document-wide would
 * pick up unrelated settings.
 *
 * Kept as an exported string entry point (test_libraries.js drives it), now over the shared block
 * parse in plcprojRefs.js so this and libsymbols.js's title harvest read the same blocks the same way.
 * ALL of a block's namespaces are taken, as before — `namespaces`, not the first-only `namespace`.
 * @param {string} plcProjXml Raw .plcproj XML text.
 * @returns {string[]} Namespace names, in document order (may contain duplicates).
 */
function extractNamespaces(plcProjXml) {
    const names = [];
    for (const block of parseLibraryReferences(plcProjXml)) {
        for (const name of block.namespaces) names.push(name);
    }
    return names;
}

/**
 * Scans a workspace folder for .plcproj files and unions their library namespaces into the given
 * project's registry. Additive: call clearLibraryNamespaces(index) first to rebuild from scratch.
 * @param {string} rootDir Absolute folder path — for a scoped call, the PROJECT directory, so only
 *   that project's .plcproj is read.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string[]} The namespaces found in this scan (as written in the XML).
 */
function indexLibraryNamespaces(rootDir, index) {
    if (!rootDir || !fs.existsSync(rootDir)) return [];
    const registry = ensureRegistryFor(index);

    const found = [];
    const files = [];
    collectPlcProjFiles(rootDir, files);

    for (const file of files) {
        // Read once per workspace, not once per consumer: libsymbols.js indexLibraryTitles wants the
        // same blocks (twice — indexLibrarySymbols and indexTypeSystem each call it), and this used to
        // be the third read of identical bytes. The records are read-only, so they are shared, not
        // cloned (plcprojRefs.js).
        const blocks = readLibraryReferences(file);
        if (!blocks) continue; // unreadable .plcproj: skip, never throw out of indexing
        for (const block of blocks) {
            for (const name of block.namespaces) {
                found.push(name);
                registry.add(name.toLowerCase());
            }
        }
    }
    return found;
}

/**
 * True if the name is a library namespace head declared by a .plcproj (case-insensitive).
 * @param {string} name Identifier to test.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {boolean}
 */
function isLibraryNamespace(name, index) {
    if (!name) return false;
    return registryFor(index).has(String(name).toLowerCase());
}

/**
 * Returns the registered library namespaces (lower-cased).
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 * @returns {string[]}
 */
function getLibraryNamespaces(index) {
    return Array.from(registryFor(index));
}

/**
 * Empties the registry. Used by custom/reindex and by the test harnesses. Write-side (ensures the
 * index has its OWN registry first): clearing must never accidentally clear the shared default
 * because this specific index had not been indexed yet.
 * @param {Object} [index] The project's symbol index. Omit for the default registry.
 */
function clearLibraryNamespaces(index) {
    ensureRegistryFor(index).clear();
}

module.exports = {
    extractNamespaces,
    indexLibraryNamespaces,
    isLibraryNamespace,
    getLibraryNamespaces,
    clearLibraryNamespaces,
    NAMESPACE_REGISTRY
};
