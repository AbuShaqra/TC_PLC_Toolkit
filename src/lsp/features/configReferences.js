/**
 * @file features/configReferences.js
 * @description Find references to a PLC symbol inside the TwinCAT project's NON-CODE objects, so that a
 * reference-aware rename can update them too. Three families carry PLC symbol references, and a rename
 * that leaves any of them stale makes XAE fail to build:
 *   - **visualizations** (`.TcVIS`/`.TcVMO`) — quoted dotted paths
 *     (`"GVL_System.fbAxisX.stStatus.stError.bError"`) and embedded Structured Text snippets
 *     (`"GVL_HMI_Manuell.bEnable := TRUE;"`);
 *   - **text lists** (`.TcTLO`/`.TcGTLO`) — text entries whose text IS a symbol path, used for dynamic
 *     visu text (`<v n="TextDefault">"GVL_HMI_Manuell.adValues[INDEX]"</v>`);
 *   - **task configurations** (`.TcTTO`) — the task's entry POU, named in a `<PouCall>` block.
 *
 * Matching here is conservative *by construction*, and deliberately the OPPOSITE of the code-side
 * Find References ("keep any occurrence I cannot resolve"): a wrong edit here silently corrupts an HMI
 * or a task config, so anything whose ownership cannot be positively proved is skipped. A missed
 * reference merely reproduces today's build failure until the user fixes it by hand; a spurious one
 * rewrites a path that pointed somewhere else.
 *
 * The two matchers are chosen by file extension and never both run on one file. Chain-bearing files
 * (visu + text lists) share one shape — a dotted path whose prefix must provably resolve through the
 * type model — because their decoys share it too (text-list ids `TL_*.X`, visu-lib names
 * `VisuDialogs.*`, and plain dotted prose like `Palletizer.Turn1` sitting in a text entry). Task
 * configs carry no paths at all, only a bare POU name, so the generic chain matcher would find nothing
 * there and is deliberately not run on them.
 */

const fs = require('fs');
const path = require('path');
const { fsPathToFileUri } = require('../../fileUri');
const { findNode } = require('../types');
const { registerLibrarySymbolNodes } = require('../libsymbols');
const { normalizeUri, resolvePathType } = require('./core');
const { pousRelated } = require('./references');

/**
 * Every dotted identifier chain in a file — a leading identifier followed by at least one `.member`.
 * The leading lookbehind refuses a start in the middle of a longer chain (so `GVL_SysX.y` is read
 * whole and never mistaken for `GVL_Sys`), and the trailing lookahead refuses a partial last segment.
 * Segments themselves are word-only (no dots), so splitting a match on `.` recovers them exactly.
 * This finds chains anywhere in the file — inside quoted attribute values AND inside STSnippet code —
 * which is precisely the set of places a PLC symbol can be named. An array subscript ends a chain
 * (`GVL_X.adValues[INDEX]` yields `GVL_X.adValues`), since `[` is not an identifier character.
 * @type {RegExp}
 */
const CHAIN_SCAN = /(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?![A-Za-z0-9_])/g;

/** Task-configuration extension: matched by the `<PouCall>` rule, never by the chain matcher. */
const TASK_EXT = '.tctto';

/**
 * Resolves the member the spec points at on a target node, mirroring the guards
 * provideReferencesForSymbol uses: the collection is chosen by kind and the member is matched by
 * lower-cased name.
 * @param {Object} node Target root node (already identity-checked).
 * @param {{kind: 'Method'|'Property'|'Action', name: string}} member Member spec.
 * @returns {Object|null} The member declaration, or null when it does not exist on the node.
 */
function findMemberOnNode(node, member) {
    const collection = member.kind === 'Method' ? node.methods
        : member.kind === 'Property' ? node.properties
        : member.kind === 'Action' ? node.actions
        : null;
    if (!collection) return null;
    const lower = String(member.name).toLowerCase();
    return collection.find(x => x.name.toLowerCase() === lower) || null;
}

/**
 * Finds the task-configuration POU calls that name the renamed object.
 *
 * A `.TcTTO` names its entry POU in exactly one place — `<PouCall><Name>MAIN</Name></PouCall>`, with
 * the Name on its own indented line in the files TwinCAT writes — and nothing else in the file is a
 * symbol reference. So this is a targeted slice walk rather than the generic chain matcher (which has
 * nothing to work with here: there is no path to resolve, only a bare name).
 *
 * The **no-dot rule** is the load-bearing guard: a task may call a *library* POU, and those are always
 * namespace-qualified (`VisuElems.Visu_Prg` in the sample's VISU_TASK). A workspace object can never be
 * spelled with a dot in a PouCall, so any dotted value belongs to a library and must be left alone —
 * renaming a project POU that happens to share the last segment's name would break that task.
 *
 * @param {string} text The file's BOM-stripped text.
 * @param {string} uri The file's uri.
 * @param {string} rootLower The renamed object's name, lower-cased.
 * @returns {Array<{uri: string, offset: number, length: number, chain: string}>} Occurrences spanning
 *          exactly the POU name inside the `<Name>` element.
 */
function findTaskPouCalls(text, uri, rootLower) {
    const OPEN = '<PouCall>';
    const CLOSE = '</PouCall>';
    const NAME_OPEN = '<Name>';
    const NAME_CLOSE = '</Name>';
    const out = [];

    let from = 0;
    for (;;) {
        const open = text.indexOf(OPEN, from);
        if (open === -1) break;
        const close = text.indexOf(CLOSE, open + OPEN.length);
        if (close === -1) break;          // unterminated element: nothing safe to edit, stop scanning
        from = close + CLOSE.length;

        // The <Name> must sit INSIDE this PouCall element — an index at or past `close` belongs to
        // some later element and is not this task's POU.
        const nameOpen = text.indexOf(NAME_OPEN, open + OPEN.length);
        if (nameOpen === -1 || nameOpen >= close) continue;
        const valueStart = nameOpen + NAME_OPEN.length;
        const nameClose = text.indexOf(NAME_CLOSE, valueStart);
        if (nameClose === -1 || nameClose >= close) continue;

        // Trim surrounding whitespace and carry the offset along with it, so the occurrence spans
        // exactly the identifier. An untrimmed value would fail the caller's splice guard and be
        // reported to the user as an unexplained skip rather than a clean match.
        const rawValue = text.slice(valueStart, nameClose);
        const lead = rawValue.length - rawValue.replace(/^\s+/, '').length;
        const value = rawValue.trim();
        if (!value) continue;

        // Namespace-qualified => a library POU => never a workspace object. Skipped without resolving.
        if (value.indexOf('.') !== -1) continue;
        if (value.toLowerCase() !== rootLower) continue;

        out.push({ uri, offset: valueStart + lead, length: value.length, chain: value });
    }
    return out;
}

/**
 * Finds the dotted-path references to the symbol in one chain-bearing file (visualization or text
 * list), by the rules described on findConfigReferencesForSymbol.
 * @param {string} text The file's BOM-stripped text.
 * @param {string} uri The file's uri.
 * @param {Object} symbolIndex Workspace symbol index (mutated: on-demand library registration).
 * @param {Object} node The resolved target root node.
 * @param {string} rootLower The target root's name, lower-cased.
 * @param {string|null} memberLower The target member's name lower-cased, or null for a root rename.
 * @returns {Array<{uri: string, offset: number, length: number, chain: string}>}
 */
function findChainReferences(text, uri, symbolIndex, node, rootLower, memberLower) {
    const out = [];

    // Extract every dotted chain, keeping its absolute offset in the stripped text.
    const chains = [];
    CHAIN_SCAN.lastIndex = 0;
    let m;
    while ((m = CHAIN_SCAN.exec(text)) !== null) {
        chains.push({ text: m[0], index: m.index });
    }
    if (!chains.length) return out;

    // Register the external library/`.tmc` symbols these chains reference, so intermediate struct
    // hops (`fbAxisX.stStatus.…`, where a hop's type lives only in a library) resolve. Per file,
    // bounded — the same on-demand discipline the diagnostics and by-symbol queries use.
    registerLibrarySymbolNodes(symbolIndex, chains.map(c => c.text).join('\n'));

    for (const chain of chains) {
        const segs = chain.text.split('.');

        if (!memberLower) {
            // Root rename: the chain's FIRST segment names the object. An FB *type* never appears
            // as a path root (only instances do), so an FB-root query naturally finds nothing;
            // GVLs and PROGRAMs are the real cases. Name equality is the whole test — resolving a
            // namespace root against itself would add nothing.
            if (segs[0].toLowerCase() === rootLower) {
                out.push({ uri, offset: chain.index, length: segs[0].length, chain: chain.text });
            }
            continue;
        }

        // Member rename: any segment i >= 1 spelled like the member, whose PREFIX (segments
        // 0..i-1) resolves to the target node or one related to it. The offset of a segment is its
        // start within the chain: the running sum of the earlier segments plus their dots.
        let segOffset = chain.index;
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            if (i >= 1 && seg.toLowerCase() === memberLower) {
                const prefixType = resolvePathType(segs.slice(0, i), null, null, symbolIndex);
                // Unresolved prefix, unknown type, or a member that lands on an unrelated owner:
                // skip silently. This is the deliberate inversion of the code-side "keep what I
                // cannot resolve" — an unproven edit here corrupts the HMI.
                if (prefixType) {
                    const baseNode = findNode(symbolIndex, prefixType);
                    // A resolved type with no node is a library type (indexed by name only): its
                    // member belongs to it, not to the target, and the target is always a real
                    // workspace node — so this cannot be the same symbol.
                    if (baseNode && pousRelated(baseNode, node, symbolIndex)) {
                        out.push({ uri, offset: segOffset, length: seg.length, chain: chain.text });
                    }
                }
            }
            segOffset += seg.length + 1; // advance past this segment and its trailing dot
        }
    }
    return out;
}

/**
 * Finds references to a PLC symbol inside a supplied set of TwinCAT configuration-object files
 * (visualizations, text lists and task configurations).
 *
 * The spec is exactly the one `custom/referencesForSymbol` takes, and the resolution prologue applies
 * the identical guards, so this reference set is keyed off the same target the code-side rename uses —
 * the two can never disagree about *which* symbol is being renamed.
 *
 * @param {{ rootName: string, fileUri: string,
 *           member?: { kind: 'Method'|'Property'|'Action', name: string } }} spec The symbol to search
 *        for: a root object by name, optionally narrowed to one of its members.
 * @param {Object} symbolIndex Workspace symbol index. Mutated: this registers, on demand, the external
 *        library/`.tmc` symbols a file's chains reference (the same accepted behavior as the by-symbol
 *        query — the added nodes are left in the index).
 * @param {Array<string>} configFilePaths Absolute paths of the `.TcVIS`/`.TcVMO`/`.TcTLO`/`.TcGTLO`/
 *        `.TcTTO` files to scan.
 * @returns {{ resolved: boolean,
 *             occurrences: Array<{uri: string, offset: number, length: number, chain: string}> }}
 *          `offset`/`length` are UTF-16 code-unit offsets into the file's BOM-stripped text covering
 *          exactly the one segment to replace; `chain` is the full dotted chain (or, for a task POU
 *          call, the bare name), for logs. `resolved` is false on the same guards the by-symbol query
 *          fails on (unknown/external root, uri identity mismatch, missing member). Occurrences are
 *          sorted by uri, then offset.
 */
function findConfigReferencesForSymbol(spec, symbolIndex, configFilePaths) {
    const unresolved = { resolved: false, occurrences: [] };
    if (!spec || !spec.rootName) return unresolved;

    // ---- Target resolution prologue — the same guards as provideReferencesForSymbol ----
    // A library symbol has no file to rename in, and an unknown name resolves to nothing.
    const node = findNode(symbolIndex, spec.rootName);
    if (!node || node.external) return unresolved;

    // Identity guard: the index is name-keyed and last-write-wins, so the node under this name may
    // belong to a DIFFERENT file than the caller meant. Editing it would corrupt the wrong object, so
    // a uri mismatch is a hard no. Normalized the same way the rest of the LSP compares uris.
    if (!node.uri || !spec.fileUri || normalizeUri(node.uri) !== normalizeUri(spec.fileUri)) {
        return unresolved;
    }

    // A member spec must name a member that actually exists on the node — else there is nothing to
    // rename and the caller should not have asked. (Type-model resolution, not ST defKey coordinates:
    // matching here needs to know what a path RESOLVES to, not where a declaration sits.)
    let member = null;
    if (spec.member) {
        member = findMemberOnNode(node, spec.member);
        if (!member) return unresolved;
    }

    const rootLower = spec.rootName.toLowerCase();
    const memberLower = member ? member.name.toLowerCase() : null;
    const occurrences = [];

    for (const filePath of (configFilePaths || [])) {
        let raw;
        try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { continue; }

        // Strip a leading BOM. TwinCAT configuration objects are UTF-8 *with* a BOM, but VS Code
        // documents exclude it — so every offset must be into the BOM-stripped text (the same string
        // the extension host holds and will splice into), or a rename lands one code unit off on the
        // whole file.
        const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
        const uri = fsPathToFileUri(filePath);

        if (path.extname(filePath).toLowerCase() === TASK_EXT) {
            // Task configs name a POU and nothing else — a member is never named in one, so a member
            // rename has nothing to find there.
            if (!member) {
                for (const occ of findTaskPouCalls(text, uri, rootLower)) occurrences.push(occ);
            }
            continue;
        }

        for (const occ of findChainReferences(text, uri, symbolIndex, node, rootLower, memberLower)) {
            occurrences.push(occ);
        }
    }

    occurrences.sort((a, b) =>
        a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : a.offset - b.offset);
    return { resolved: true, occurrences };
}

module.exports = {
    findConfigReferencesForSymbol
};
