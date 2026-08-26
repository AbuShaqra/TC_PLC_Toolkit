/**
 * @file completion/memberAccess.js
 * @description The dotted-path caret: a project node's own members, a library namespace's symbols,
 * a nested namespace's symbols, and the members of a library type — including the chained walk
 * through `.tmc` member types and the four-tier ranking of a namespace's string table.
 */

const { STANDARD_TYPES } = require('../builtins');
const { findNode } = require('../types');
const { getLibraryNamespaces } = require('../libraries');
const {
    getNamespaceSymbols,
    getLibraryNamespaceNames,
    getTypeSystemNamespaceTypes,
    getBrowserCacheNamespaceTypes,
    isBrowserCacheMemberName,
    getNestedNamespaceSymbols,
    getLibraryTypeNode
} = require('../libsymbols');
const { walkExtendsChain, resolvePathType, isCallParamScope } = require('../features/core');
const { scopeLabel } = require('./namedParams');

// sortText prefix for a library symbol the `.tmc` knows to be a real top-level type. A namespace's
// string table cannot tell a type from an internal member name, so `Tc2_MC2.▮` is a mix of both;
// the `.tmc`'s types are the ones a user can actually write, so they rank first.
const LIB_TYPE_SORT_PREFIX = '0_';

/**
 * sortText prefix for a library symbol the browsercache names as a real FB/interface but the
 * `.tmc` does not — a type the library declares and the project has not adopted yet. Ranks below
 * the `.tmc`'s (which carry members and parameters) and above the undifferentiated string table.
 */
const LIB_BC_TYPE_SORT_PREFIX = '1_';

/**
 * sortText prefix for a name known to be a MEMBER of some type in the namespace rather than a type
 * — `Tc2_MC2.ActStop`. Demoted, never dropped: see libraryNamespaceMembers on why this ranks.
 *
 * Letters, not a digit or punctuation, because this one has to sort BELOW the untiered entries,
 * which carry no sortText and therefore sort on their own (letter-initial) labels. A numeric prefix
 * like '9_' sorts before every letter and silently promoted these to the top instead; '~' sorts
 * last by code point but NOT under locale collation, which gives punctuation a low primary weight.
 * 'zz_' is the only shape that lands last under both.
 */
const LIB_MEMBER_SORT_PREFIX = 'zz_';

/** LSP CompletionItemKind per `.tmc` type kind (Class / Struct / Enum / Interface). */
const LIB_KIND_ITEM = {
    fb: { kind: 7, label: 'Function Block' },
    struct: { kind: 22, label: 'Struct' },
    enum: { kind: 13, label: 'Enum' },
    interface: { kind: 8, label: 'Interface' }
};

/**
 * The symbols of one library namespace — the answer to `Tc2_MC2.▮`.
 *
 * The map behind getNamespaceSymbols() is built once, at index time (libsymbols.js): a namespace is
 * a direct key lookup, never a scan of the 32k registry. A namespace that is unknown, or that could
 * not be attributed any symbol (a library shipped only as the opaque `.compiled-library-v3`), yields
 * an empty list — the caret then offers nothing rather than something invented.
 *
 * Elementary types are dropped: a library's string table holds every string it serialized, so `INT`
 * and `DWORD` are in there simply because the library *uses* them — but no namespace re-exports an
 * elementary type, and `Tc2_MC2.INT` is not a thing a user can write. They are offered unqualified
 * at every type caret anyway (pushTypeNames), so nothing is lost. Library FBs and functions that
 * happen to be builtins (`TON`, `LEN`) are deliberately NOT dropped — `Tc2_Standard.TON` is real.
 *
 * **Ranking, not filtering.** A string table cannot tell a top-level type from an internal member
 * name, so `Tc2_MC2.▮` is a long mix of both — 2,269 names, measured. Two sources can tell them
 * apart, and they cover different ground, so the list is ranked in four tiers:
 *
 *   0. the `.tmc`'s types — the richest description (fields, parameters), but it exports only what
 *      the project already *uses*: ~57 of the 2,269.
 *   1. the browsercache's FBs and interfaces — names only, but it lists every one the library
 *      declares, adopted or not: 128 of the 2,269. This is the tier that answers a *fresh* caret,
 *      where the user is reaching for a type precisely because the project has no instance yet.
 *   2. everything else the string table holds, undifferentiated.
 *   3. names the browsercache knows only as a METHOD or PROPERTY of some type in the library
 *      (`Tc2_MC2.ActStop`) — not writable in this position, so they sink.
 *
 * Nothing is dropped, at any tier. The browsercache covers only libraries installed on this
 * machine and the `.tmc` only appears after a build, so both are evidence of presence, never of
 * absence — filtering on either would hide real types on the machines that lack them.
 * @param {string} namespace The head of the dotted path under the caret.
 * @param {Object} [index] The project's symbol index — its library registry. Omit for the default.
 * @returns {Array<Object>} Completion items (possibly empty).
 */
function libraryNamespaceMembers(namespace, index) {
    const spelled = getLibraryNamespaceNames(index).find(n => n.toLowerCase() === namespace.toLowerCase());
    const label = spelled || namespace;

    // The .tmc's real types for this namespace, keyed for an O(1) test per candidate name.
    const known = new Map();
    getTypeSystemNamespaceTypes(namespace, index).forEach(t => known.set(t.name.toLowerCase(), t));
    const declared = getBrowserCacheNamespaceTypes(namespace, index);
    const isMember = name => isBrowserCacheMemberName(namespace, name, index);

    const items = [];
    for (const name of getNamespaceSymbols(namespace, index)) {
        if (STANDARD_TYPES.has(name.toUpperCase())) continue;
        items.push(rankNamespaceSymbol(name, label, known, declared, isMember));
    }
    return items;
}

/**
 * Reduces a declared type string to the bare name a `.tmc` lookup needs: `ARRAY [0..3] OF
 * Tc2_MC2.ST_X := ...` → `ST_X`. Deliberately textual — the member types come from the `.tmc`, not
 * from the parser, so there is no Type object to deref, and the qualified form is not an index key.
 * @param {string} typeStr Declared type as the `.tmc` spells it.
 * @returns {string} Unqualified type name (possibly empty).
 */
function bareTypeName(typeStr) {
    if (!typeStr) return '';
    let t = String(typeStr).trim();
    const assign = t.indexOf(':=');
    if (assign !== -1) t = t.slice(0, assign).trim();
    t = t.replace(/^ARRAY\s*\[[^\]]*\]\s*OF\s+/i, '');
    t = t.replace(/^(POINTER|REFERENCE)\s+TO\s+/i, '');
    return t.trim().split('.').pop();
}

/**
 * How far a member chain is followed. A struct may legitimately reach itself through a POINTER TO,
 * so the walk needs a stop; past a handful of hops a caret is not something anyone is typing.
 */
const MAX_LIBRARY_MEMBER_HOPS = 8;

/**
 * Follows a dotted path through library member types — the answer to `fbAxisRef.NcToPlc.▮`.
 *
 * Each hop reads the member's declared type from the `.tmc` and looks that type up directly, so no
 * node is ever added to the workspace index: the reason this used to stop after one hop is that a
 * library type is only registered when the document text NAMES it, and `NCTOPLC_AXLESTRUCT` appears
 * nowhere in code that merely writes `fbAxisRef.NcToPlc.ActPos`. Registering transitively instead
 * is the 78 s `Object.keys()` cliff; resolving transitively costs one map lookup per hop.
 * @param {Object} node The head type's node (external).
 * @param {string[]} segments Remaining path segments after the head.
 * @param {Object} symbolIndex Workspace symbol index (for the EXTENDS walk).
 * @returns {Object|null} The node whose members answer the caret, or null if any hop is unknown.
 */
function walkLibraryMemberPath(node, segments, symbolIndex) {
    let current = node;
    for (let i = 0; i < segments.length; i++) {
        if (!current || i >= MAX_LIBRARY_MEMBER_HOPS) return null;
        const wanted = segments[i].toLowerCase();
        let member = null;
        // A member may be declared on a base type, exactly as a method may — same walk.
        for (const owner of [current, ...walkExtendsChain(current, symbolIndex).ancestors]) {
            member = (owner.variables || []).find(v => v.name.toLowerCase() === wanted);
            if (member) break;
        }
        if (!member) return null;
        current = getLibraryTypeNode(bareTypeName(member.type), symbolIndex);
    }
    return current;
}

/**
 * True when the name is a library namespace the project references (either spelling source).
 * @param {string} name Identifier to test.
 * @param {Object} [index] The project's symbol index — its library registry. Omit for the default.
 * @returns {boolean}
 */
function isLibraryNamespace(name, index) {
    if (!name) return false;
    const key = String(name).toLowerCase();
    return getLibraryNamespaceNames(index).some(n => n.toLowerCase() === key)
        || getLibraryNamespaces(index).some(n => String(n).toLowerCase() === key);
}

/**
 * The symbols of a nested library namespace — the answer to `VisuElems.VisuElemBase.▮`.
 *
 * The inner segment names a library the `.plcproj` never references (it is a dependency of the
 * outer one), so its symbols are harvested on demand rather than indexed. They arrive as bare
 * names from a string table with no `.tmc` and no browsercache behind them, so every one is
 * reported as a plain library symbol — the same honesty as the outer namespace's untiered tier.
 * @param {string} outer The referenced namespace under the caret's head.
 * @param {string} inner The nested namespace segment.
 * @param {Object} [index] The project's symbol index — its library registry. Omit for the default.
 * @returns {Array<Object>} Completion items (empty when that library is not installed).
 */
function nestedNamespaceMembers(outer, inner, index) {
    const symbols = getNestedNamespaceSymbols(inner, index);
    if (symbols.length === 0) return [];
    const items = [];
    for (const name of symbols) {
        if (STANDARD_TYPES.has(name.toUpperCase())) continue;
        items.push({
            label: name,
            kind: 7,
            detail: `Library Symbol (${outer}.${inner})`
        });
    }
    return items;
}

/**
 * Assigns one library symbol to its tier — the whole of the ranking decision described on
 * libraryNamespaceMembers, kept pure so it can be exercised without a machine that happens to have
 * the right libraries installed. Both evidence sources are optional and independently absent: a
 * clone has no `.tmc` until something is built, and the browsercache only covers libraries
 * installed locally.
 * @param {string} name Symbol name, original spelling.
 * @param {string} label Namespace name as spelled in the .plcproj.
 * @param {Map<string, Object>} tmcTypes `.tmc` types, keyed lower-case.
 * @param {Map<string, Object>} bcTypes Browsercache top-level types, keyed lower-case.
 * @param {(name: string) => boolean} isMember True when the name is member-only in this namespace.
 * @returns {Object} A completion item.
 */
function rankNamespaceSymbol(name, label, tmcTypes, bcTypes, isMember) {
    const key = String(name).toLowerCase();

    // Tier 0 — the `.tmc` describes it: the richest source, so it wins wherever both apply.
    const tmcType = tmcTypes.get(key);
    const tmcShape = tmcType ? LIB_KIND_ITEM[tmcType.kind] : null;
    if (tmcShape) {
        return {
            label: name,
            kind: tmcShape.kind,
            detail: `${tmcShape.label} (${label})`,
            sortText: LIB_TYPE_SORT_PREFIX + name
        };
    }

    // Tier 1 — the library declares it, the project just has not used it yet.
    const bcType = bcTypes.get(key);
    const bcShape = bcType ? LIB_KIND_ITEM[bcType.kind] : null;
    if (bcShape) {
        return {
            label: name,
            kind: bcShape.kind,
            detail: `${bcShape.label} (${label})`,
            sortText: LIB_BC_TYPE_SORT_PREFIX + name
        };
    }

    // Tier 3 — known to be a member of some type here, so not writable as `Namespace.name`.
    if (isMember(name)) {
        return {
            label: name,
            kind: 7,
            detail: `Member of a ${label} type`,
            sortText: LIB_MEMBER_SORT_PREFIX + name
        };
    }

    // Tier 2 — the string table holds it and nothing can say more. No sortText: it sorts on the
    // label, between the identified types above and the known members below.
    return {
        label: name,
        kind: 7, // Class — a library symbol is a bare name; what is behind it is not indexed.
        detail: `Library Symbol (${label})`
    };
}

/**
 * The members of a library type the project's `.tmc` describes — the answer to `stAxis.▮`,
 * `MC_Power.▮`, `E_EthercatDeviceState.▮`.
 *
 * Purely additive, and deliberately confined to completion: the same member list must never reach a
 * diagnostic (the node carries `membersComplete: false`, and types.js honours it — see
 * lookupMember). A missing suggestion here costs a keystroke; a fabricated "is not a member of type"
 * on correct library code costs the user's trust in every diagnostic we emit.
 * @param {Object} node External symbol-index node (libsymbols.js).
 * @param {Object} symbolIndex Workspace symbol index, to walk the node's `<ExtendsType>` chain.
 * @returns {Array<Object>} Completion items — empty for a library symbol the `.tmc` does not know
 *          (an archive name has no members), which is the safe answer, not a bug.
 */
function libraryTypeMembers(node, symbolIndex) {
    const items = (node.variables || []).map(v => {
        if (v.scope === 'ENUM') {
            return { label: v.name, kind: 20 /* EnumMember */, detail: `Enum Member (of ${node.name})` };
        }
        // An FB's call parameters carry their direction; a struct's fields do not.
        const detail = isCallParamScope(v.scope)
            ? `${scopeLabel(v.scope)} : ${v.type} (of ${node.name})`
            : `${v.type} (Member of ${node.name})`;
        return { label: v.name, kind: 5 /* Field */, detail: detail };
    });

    // The library FB's methods, and those it inherits. `.tmc` `<Method>` blocks are declared on the
    // type that owns them, so an inherited method is only reachable by walking `<ExtendsType>` — the
    // same walk a project FB gets.
    for (const owner of [node, ...walkExtendsChain(node, symbolIndex).ancestors]) {
        for (const m of (owner.methods || [])) {
            items.push({
                label: m.name,
                kind: 2 /* Method */,
                detail: `Method : ${m.returnType || 'VOID'} (of ${owner.name})`
            });
        }
    }
    return items;
}

/**
 * Completions for a caret that follows a dot, or null when it does not.
 *
 * A dotted caret is answered on its own: every branch below returns a final list (an empty one when
 * nothing resolves), so the caller hands the result straight back rather than merging it with the
 * context list. Null means "not a member access" — only then does the caller go on to classify.
 * @param {string} textBeforeCursor Text on the caret's line, up to the caret.
 * @param {Object} pou Active POU node (may be null).
 * @param {Object} method Active method node (may be null).
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {?Array<Object>} Completion items, or null if the caret is not after a dot.
 */
function provideMemberAccessCompletions(textBeforeCursor, pou, method, symbolIndex) {
    // Check if typing after a dot
    const dotMatch = textBeforeCursor.match(/([a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?)*)\.([a-zA-Z0-9_]*)$/i);
    if (!dotMatch) return null;

    const pathStr = dotMatch[1];
    const cleanedPath = pathStr.replace(/\[[^\]]+\]/g, ''); // strip array brackets
    const parts = cleanedPath.split('.');

    // A *project* node answers from its own members; an *external* one (libsymbols.js) does not
    // fall in here, because the two answer from different places — see the library branches
    // below. The head of a namespace path is itself an external node (the library's string table
    // holds its own name, and registerLibrarySymbolNodes puts it in the index), so without this
    // split `Tc2_MC2.▮` would "resolve" to it and offer its (non-existent) members.
    const resolvedType = resolvePathType(parts, pou, method, symbolIndex);
    const resolvedNode = resolvedType ? findNode(symbolIndex, resolvedType) : null;
    if (resolvedNode && !resolvedNode.external) {
        const node = resolvedNode;
        const suggestions = [];

        // Suggest variables / fields
        node.variables.forEach(v => {
            suggestions.push({
                label: v.name,
                kind: 5, // Field
                detail: `${v.type} (Member of ${resolvedType})`
            });
        });

        // Suggest methods
        node.methods.forEach(m => {
            suggestions.push({
                label: m.name,
                kind: 2, // Method
                detail: `Method : ${m.returnType} (of ${resolvedType})`
            });
        });

        // Suggest properties
        node.properties.forEach(p => {
            suggestions.push({
                label: p.name,
                kind: 10, // Property
                detail: `Property : ${p.type} (of ${resolvedType})`
            });
        });

        // Suggest actions
        node.actions.forEach(a => {
            suggestions.push({
                label: a.name,
                kind: 23, // Event
                detail: `Action (of ${resolvedType})`
            });
        });

        return suggestions;
    }

    // `Tc2_MC2.▮` — the path resolves to nothing in the project, but its head is a library
    // namespace, so what follows the dot is that library's symbols. Checked *after* the project
    // index, which therefore still wins on a name collision, and *before* the library-type branch
    // below, so a namespace can never be mistaken for a same-named type.
    if (parts.length === 1) {
        const libItems = libraryNamespaceMembers(parts[0], symbolIndex);
        if (libItems.length > 0) return libItems;
    }

    // `VisuElems.VisuElemBase.▮` — a NESTED namespace: a library's namespace re-exports the
    // namespaces of the libraries it depends on, so a path can be two namespaces deep before it
    // names anything. Gated hard on the head being a namespace the project actually references,
    // which is what keeps an ordinary member path (`stAxis.MotionState.▮`) from ever reaching
    // the archive store, and confined to a two-part head: past that a segment is a symbol, and
    // guessing members for it is exactly the noise this must not produce.
    if (parts.length === 2 && isLibraryNamespace(parts[0], symbolIndex)) {
        const nested = nestedNamespaceMembers(parts[0], parts[1], symbolIndex);
        if (nested.length > 0) return nested;
    }

    // `stAxis.▮` (an instance of a library type), `MC_Power.▮`, `E_EthercatDeviceState.▮` — the
    // path resolves to an *external* node, whose members the project's `.tmc` describes. A node
    // the `.tmc` says nothing about (a bare archive name) has none, and answers with nothing.
    //
    // A declaration usually names the type through its namespace (`st : Tc2_MC2.ST_AxisStatus`),
    // and the qualified string is not an index key — the library node is filed under the bare
    // name. parseTypeString (types.js) already resolves it that way; this mirrors it, and accepts
    // the fallback only when it lands on an external node, so a project type of the same last
    // segment can never be answered under some other library's prefix.
    let externalNode = (resolvedNode && resolvedNode.external) ? resolvedNode : null;
    if (!externalNode && resolvedType && resolvedType.includes('.')) {
        const bare = findNode(symbolIndex, resolvedType.split('.').pop());
        if (bare && bare.external) externalNode = bare;
    }
    if (externalNode) return libraryTypeMembers(externalNode, symbolIndex);

    // `fbAxisRef.NcToPlc.▮` — a CHAINED member access on a library type. The whole path did not
    // resolve above because only the head's type is in the index: a library type is registered
    // when the document text names it, and the type of `NcToPlc` is named nowhere in code that
    // simply reads `fbAxisRef.NcToPlc.ActPos`. So resolve the head, then follow the rest through
    // the `.tmc` without registering anything — see walkLibraryMemberPath.
    if (parts.length >= 2) {
        const headType = resolvePathType([parts[0]], pou, method, symbolIndex);
        const headNode = headType ? findNode(symbolIndex, headType) : null;
        if (headNode && headNode.external) {
            const target = walkLibraryMemberPath(headNode, parts.slice(1), symbolIndex);
            if (target) return libraryTypeMembers(target, symbolIndex);
        }
    }
    return [];
}

module.exports = {
    provideMemberAccessCompletions,
    rankNamespaceSymbol
};
