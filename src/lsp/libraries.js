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
 * Known library namespaces, stored lower-cased: Structured Text is case-insensitive.
 * @type {Set<string>}
 */
const libraryNamespaces = new Set();

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
 * Scans a workspace folder for .plcproj files and unions their library namespaces into the
 * registry. Additive: call clearLibraryNamespaces() first to rebuild from scratch.
 * @param {string} rootDir Absolute folder path.
 * @returns {string[]} The namespaces found in this scan (as written in the XML).
 */
function indexLibraryNamespaces(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) return [];

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
            libraryNamespaces.add(name.toLowerCase());
        }
    }
    return found;
}

/**
 * True if the name is a library namespace head declared by a .plcproj (case-insensitive).
 * @param {string} name Identifier to test.
 * @returns {boolean}
 */
function isLibraryNamespace(name) {
    if (!name) return false;
    return libraryNamespaces.has(String(name).toLowerCase());
}

/**
 * Returns the registered library namespaces (lower-cased).
 * @returns {string[]}
 */
function getLibraryNamespaces() {
    return Array.from(libraryNamespaces);
}

/**
 * Empties the registry. Used by custom/reindex and by the test harnesses.
 */
function clearLibraryNamespaces() {
    libraryNamespaces.clear();
}

module.exports = {
    extractNamespaces,
    indexLibraryNamespaces,
    isLibraryNamespace,
    getLibraryNamespaces,
    clearLibraryNamespaces
};
