/**
 * @file symbolNode.js
 * @description The single definition of a workspace symbol node's core shape.
 *
 * A symbol node is built in two places — `parser.js` (`parseAndIndexDocument`, for the active
 * document's ST unit) and `xmlIndexer.js` (`buildNodeFromXml`, for every other document). Those two
 * literals had already drifted (parser carried `returnType`/`bodyRange`; the XML indexer did not), and
 * every field added to the model — `extendsAll` was the most recent — had to be remembered in both. A
 * node built one way then read by code expecting the other shape is a quiet bug source.
 *
 * `createSymbolNode` is the one place the core shape is declared, so the two indexers can no longer
 * diverge on it. Source-specific fields that only one indexer knows about (`dutKind`, `membersComplete`,
 * `external`, `libKind`, …) are still added by that indexer AFTER construction — this factory owns only
 * the fields every node must have. A conformance test (test/test_symbol_node.js) pins the two together.
 */

/**
 * @typedef {Object} SymbolNode
 * @property {string} name        Symbol name.
 * @property {string} type        POU/DUT kind: FUNCTION_BLOCK | PROGRAM | FUNCTION | INTERFACE | GVL | DUT | ...
 * @property {string} [uri]       Owning document URI.
 * @property {Object} range       Whole-symbol source range.
 * @property {Object|null} nameRange  Range of the name token.
 * @property {string|null} extends    First EXTENDS parent (kept for single-parent call sites).
 * @property {string[]} extendsAll    All EXTENDS parents (an interface may extend several).
 * @property {string[]} implements    Implemented interface names.
 * @property {string|null} returnType FUNCTION return type, when known.
 * @property {Array} variables    Declared variables.
 * @property {Array} methods      Nested methods.
 * @property {Array} properties   Nested properties.
 * @property {Array} actions      Nested actions.
 * @property {Object|null} bodyRange  Implementation body range, when computed.
 * @property {string} [dutKind]   Source-specific extra, added by xmlIndexer.js for DUT nodes:
 *                                'struct' | 'union' | 'enum' | 'alias' (a subrange classifies as 'alias'). Not set by the
 *                                factory — an example of a field layered on top of the core shape.
 */

/**
 * Builds a symbol node with the canonical core shape. Every field is always present, so a node never
 * depends on which indexer produced it. Pass whatever is known; the rest take their neutral defaults
 * (null / empty array) — exactly the values both original literals used.
 * @param {Partial<SymbolNode>} [fields]
 * @returns {SymbolNode}
 */
function createSymbolNode(fields = {}) {
    const f = fields || {};
    return {
        name: f.name || '',
        type: f.type || '',
        uri: f.uri,
        range: f.range || { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
        nameRange: f.nameRange !== undefined ? f.nameRange : null,
        extends: f.extends !== undefined ? f.extends : null,
        extendsAll: f.extendsAll || [],
        implements: f.implements || [],
        returnType: f.returnType !== undefined ? f.returnType : null,
        variables: f.variables || [],
        methods: f.methods || [],
        properties: f.properties || [],
        actions: f.actions || [],
        bodyRange: f.bodyRange !== undefined ? f.bodyRange : null
    };
}

/** The canonical core key set every symbol node carries (used by the conformance test). */
const SYMBOL_NODE_KEYS = Object.freeze(Object.keys(createSymbolNode()));

module.exports = { createSymbolNode, SYMBOL_NODE_KEYS };
