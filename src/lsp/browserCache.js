'use strict';

/**
 * @file browserCache.js
 * @description Reads TwinCAT's per-library **browsercache** — the plain-XML object tree it caches under
 * `%ProgramData%\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries\<Company>\<Title>\<Version>\browsercache`.
 *
 * Why this exists: neither the `.compiled-library` archives (bare names), the project `.tmc` (structure,
 * but only for the ~types the project uses), nor `ProduceAllLibrarySignatures` (FB/function I/O, no
 * methods) lists a library FB's or interface's **methods and properties** for types the project has not
 * adopted. The browsercache does — for *every* installed library, fully offline. It is a navigation tree,
 * so it carries member **names and kinds only**: no parameters, no return types (those live in the
 * library's opaque binary `.object` entries). So it complements the `.tmc`, which keeps its richer
 * method signatures on overlap — the merge in libsymbols.js `indexBrowserCache` lets the `.tmc` win.
 *
 * The tree is `<Node Name="…" TypeGUID="…" ObjectGUID="…">children</Node>`, nested so that a member is a
 * child of the FB/interface that owns it. The TypeGUIDs are CODESYS object-type GUIDs — stable across
 * libraries and versions — and were established empirically against IbtCoreLib and Tc2_System.
 */

const fs = require('fs');
const path = require('path');

// CODESYS object-type GUIDs (stable). A TYPE node owns members; a PROPERTY's Get/Set accessors are its
// own children, never the FB's, so a direct child of a type is a property (by this GUID) or else a
// method — which folds in method variants (interface methods, implementers) and the rare action without
// depending on an exhaustive method-GUID list.
const GUID_FB = '{6f9dac99-8de1-4efc-8465-68ac443b7d08}';
const GUID_INTERFACE = '{6654496c-404d-479a-aad2-8551054e5f1e}';
const GUID_PROPERTY = '{5a3b8626-d3e9-4f37-98b5-66420063d91e}';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One `<Node …>` open/self-close, or a `</Node>` close. */
const NODE_TAG = /<Node\s+([^>]*?)(\/?)>|<\/Node>/g;

/** Reads an attribute out of a `<Node>`'s attribute string. */
function nodeAttr(attrs, name) {
    const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
    return m ? m[1] : '';
}

/**
 * Parses a browsercache XML string into the members of each function block and interface.
 *
 * A stack tracks the enclosing type; every direct child of a type node is filed as one of its members.
 * Member names are de-duplicated case-insensitively (Structured Text is case-insensitive) and kept in
 * first-seen order.
 * @param {string} xml The browsercache file contents.
 * @returns {Map<string, {name: string, kind: 'fb'|'interface', methods: string[], properties: string[]}>}
 *          Keyed by the type name, lower-cased.
 */
function parseBrowserCache(xml) {
    /** @type {Map<string, {name:string, kind:'fb'|'interface', methods:string[], properties:string[]}>} */
    const types = new Map();
    if (!xml || typeof xml !== 'string') return types;

    /** @type {Array<{type: any|null}>} */
    const stack = [];
    let m;
    NODE_TAG.lastIndex = 0;
    while ((m = NODE_TAG.exec(xml)) !== null) {
        if (m[0] === '</Node>') { stack.pop(); continue; }

        const attrs = m[1];
        const selfClose = m[2] === '/';
        const name = nodeAttr(attrs, 'Name');
        const guid = nodeAttr(attrs, 'TypeGUID');
        const parent = stack.length ? stack[stack.length - 1] : null;

        // A member: a direct child of a type node. Property by its own GUID; anything else code is a method.
        if (parent && parent.type && IDENTIFIER.test(name)) {
            const bucket = guid === GUID_PROPERTY ? parent.type.properties : parent.type.methods;
            if (!bucket.some(n => n.toLowerCase() === name.toLowerCase())) bucket.push(name);
        }

        // A type node: register it, and become the context its children are filed under.
        let type = null;
        if (guid === GUID_FB || guid === GUID_INTERFACE) {
            const key = name.toLowerCase();
            type = types.get(key);
            if (!type) {
                type = { name, kind: guid === GUID_FB ? 'fb' : 'interface', methods: [], properties: [] };
                types.set(key, type);
            }
        }

        // Descend into non-leaf nodes. `type` is the context for a type node; a folder/property pushes a
        // null context so ITS children are not mistaken for members of the type further up the stack.
        if (!selfClose) stack.push({ type });
    }

    return types;
}

/** Managed-libraries root — where TwinCAT caches every installed library's browsercache. */
const MANAGED_LIBRARIES = path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'Beckhoff', 'TwinCAT', 'PlcEngineering', 'Managed Libraries'
);

/** Case-insensitive child-directory lookup (library titles/companies vary in casing between sources). */
function childDirCI(parent, name) {
    let entries;
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch (e) { return null; }
    const hit = entries.find(e => e.isDirectory() && e.name.toLowerCase() === String(name).toLowerCase());
    return hit ? path.join(parent, hit.name) : null;
}

/**
 * Locates the browsercache file for one library, trying each candidate title (the `.plcproj` gives a
 * library three different spellings). Any installed version that has a browsercache is accepted — a
 * library usually has one version installed, and a member NAME does not change between minor versions,
 * so exact-version matching would only cost coverage for no correctness gain.
 * @param {string} company The library's distributor (folder under Managed Libraries).
 * @param {string[]} titles Candidate library titles, most specific first.
 * @returns {string|null} Absolute path to a browsercache file, or null.
 */
function findBrowserCacheFile(company, titles) {
    const companyDir = childDirCI(MANAGED_LIBRARIES, company);
    if (!companyDir) return null;
    for (const title of titles) {
        if (!title) continue;
        const titleDir = childDirCI(companyDir, title);
        if (!titleDir) continue;
        let versions;
        try { versions = fs.readdirSync(titleDir, { withFileTypes: true }); } catch (e) { continue; }
        for (const v of versions) {
            if (!v.isDirectory()) continue;
            const bc = path.join(titleDir, v.name, 'browsercache');
            if (fs.existsSync(bc)) return bc;
        }
    }
    return null;
}

module.exports = { parseBrowserCache, findBrowserCacheFile, MANAGED_LIBRARIES };
