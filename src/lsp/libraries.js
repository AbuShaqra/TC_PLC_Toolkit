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
const path = require('path');

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
 * indexed. In production this branch is never taken — server.js always indexes a project's own index
 * (see ensureRegistryFor) before any request can read from it, so a real project's registry always
 * exists by the time isLibraryNamespace/getLibraryNamespaces run.
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
 * Directories that never hold the project's own .plcproj: vendored library archives, generated ST
 * exports, and build output. Compared lower-cased.
 * @type {Set<string>}
 */
const SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    '.vscode',
    '_libraries',
    'st_files',
    '_compileinfo'
]);

/**
 * Extracts the library namespaces declared by a .plcproj's <PlaceholderReference> and
 * <LibraryReference> blocks. Only <Namespace> tags *inside* such a block are taken — the element
 * name is generic enough (it also appears under <Compile>) that matching it document-wide would
 * pick up unrelated settings.
 * @param {string} plcProjXml Raw .plcproj XML text.
 * @returns {string[]} Namespace names, in document order (may contain duplicates).
 */
function extractNamespaces(plcProjXml) {
    const names = [];
    const blockRegex = /<(PlaceholderReference|LibraryReference)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let block;
    while ((block = blockRegex.exec(plcProjXml)) !== null) {
        const nsRegex = /<Namespace>([^<]+)<\/Namespace>/g;
        let ns;
        while ((ns = nsRegex.exec(block[2])) !== null) {
            const name = ns[1].trim();
            if (name) names.push(name);
        }
    }
    return names;
}

/**
 * Recursively collects .plcproj files under a directory.
 * @param {string} dirPath Absolute directory path.
 * @param {string[]} out Accumulator, mutated.
 */
function collectPlcProjFiles(dirPath, out) {
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
            collectPlcProjFiles(fullPath, out);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj')) {
            out.push(fullPath);
        }
    }
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
        let xml;
        try {
            xml = fs.readFileSync(file, 'utf8');
        } catch (e) {
            continue; // unreadable .plcproj: skip, never throw out of indexing
        }
        for (const name of extractNamespaces(xml)) {
            found.push(name);
            registry.add(name.toLowerCase());
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
