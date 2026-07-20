/**
 * @file features/visuReferences.js
 * @description Find references to a PLC symbol inside TwinCAT visualization files (.TcVIS/.TcVMO), so
 * that a reference-aware rename can update them too. Visu files reference PLC symbols two ways — as
 * quoted dotted paths (`"GVL_System.fbAxisX.stStatus.stError.bError"`) and inside embedded Structured
 * Text snippets (`"GVL_HMI_Manuell.bEnable := TRUE;"`) — and a rename that leaves them stale makes XAE
 * fail to build the visualization.
 *
 * Matching here is conservative *by construction*, and deliberately the OPPOSITE of the code-side
 * Find References ("keep any occurrence I cannot resolve"): a wrong visu edit silently corrupts an HMI,
 * so anything whose ownership cannot be positively proved is skipped. A missed visu reference merely
 * reproduces today's build failure until the user fixes it by hand; a spurious one rewrites a path that
 * pointed somewhere else.
 */

const fs = require('fs');
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
 * which is precisely the set of places a PLC symbol can be named.
 * @type {RegExp}
 */
const CHAIN_SCAN = /(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?![A-Za-z0-9_])/g;

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
 * Finds references to a PLC symbol inside a supplied set of visualization files.
 *
 * The spec is exactly the one `custom/referencesForSymbol` takes, and the resolution prologue applies
 * the identical guards, so the visu reference set is keyed off the same target the code-side rename
 * uses — the two can never disagree about *which* symbol is being renamed.
 *
 * @param {{ rootName: string, fileUri: string,
 *           member?: { kind: 'Method'|'Property'|'Action', name: string } }} spec The symbol to search
 *        for: a root object by name, optionally narrowed to one of its members.
 * @param {Object} symbolIndex Workspace symbol index. Mutated: this registers, on demand, the external
 *        library/`.tmc` symbols a file's chains reference (the same accepted behavior as the by-symbol
 *        query — the added nodes are left in the index).
 * @param {Array<string>} visuFilePaths Absolute paths of the `.TcVIS`/`.TcVMO` files to scan.
 * @returns {{ resolved: boolean,
 *             occurrences: Array<{uri: string, offset: number, length: number, chain: string}> }}
 *          `offset`/`length` are UTF-16 code-unit offsets into the file's BOM-stripped text covering
 *          exactly the one chain segment to replace; `chain` is the full dotted chain, for logs.
 *          `resolved` is false on the same guards the by-symbol query fails on (unknown/external root,
 *          uri identity mismatch, missing member). Occurrences are sorted by uri, then offset.
 */
function findVisuReferencesForSymbol(spec, symbolIndex, visuFilePaths) {
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
    // visu matching needs to know what a path RESOLVES to, not where a declaration sits.)
    let member = null;
    if (spec.member) {
        member = findMemberOnNode(node, spec.member);
        if (!member) return unresolved;
    }

    const rootLower = spec.rootName.toLowerCase();
    const memberLower = member ? member.name.toLowerCase() : null;
    const occurrences = [];

    for (const filePath of (visuFilePaths || [])) {
        let raw;
        try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { continue; }

        // Strip a leading BOM. TwinCAT visu files are UTF-8 *with* a BOM, but VS Code documents
        // exclude it — so every offset must be into the BOM-stripped text (the same string the
        // extension host holds and will splice into), or a rename lands one code unit off on the
        // whole file.
        const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
        const uri = 'file:///' + filePath.replace(/\\/g, '/');

        // Extract every dotted chain, keeping its absolute offset in the stripped text.
        const chains = [];
        CHAIN_SCAN.lastIndex = 0;
        let m;
        while ((m = CHAIN_SCAN.exec(text)) !== null) {
            chains.push({ text: m[0], index: m.index });
        }
        if (!chains.length) continue;

        // Register the external library/`.tmc` symbols these chains reference, so intermediate struct
        // hops (`fbAxisX.stStatus.…`, where a hop's type lives only in a library) resolve. Per file,
        // bounded — the same on-demand discipline the diagnostics and by-symbol queries use.
        registerLibrarySymbolNodes(symbolIndex, chains.map(c => c.text).join('\n'));

        for (const chain of chains) {
            const segs = chain.text.split('.');

            if (!member) {
                // Root rename: the chain's FIRST segment names the object. An FB *type* never appears
                // as a path root in visu (only instances do), so an FB-root query naturally finds
                // nothing; GVLs and PROGRAMs are the real cases. Name equality is the whole test —
                // resolving a namespace root against itself would add nothing.
                if (segs[0].toLowerCase() === rootLower) {
                    occurrences.push({ uri, offset: chain.index, length: segs[0].length, chain: chain.text });
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
                    // cannot resolve" — an unproven visu rename corrupts the HMI.
                    if (prefixType) {
                        const baseNode = findNode(symbolIndex, prefixType);
                        // A resolved type with no node is a library type (indexed by name only): its
                        // member belongs to it, not to the target, and the target is always a real
                        // workspace node — so this cannot be the same symbol.
                        if (baseNode && pousRelated(baseNode, node, symbolIndex)) {
                            occurrences.push({ uri, offset: segOffset, length: seg.length, chain: chain.text });
                        }
                    }
                }
                segOffset += seg.length + 1; // advance past this segment and its trailing dot
            }
        }
    }

    occurrences.sort((a, b) =>
        a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : a.offset - b.offset);
    return { resolved: true, occurrences };
}

module.exports = {
    findVisuReferencesForSymbol
};
