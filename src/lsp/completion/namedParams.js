/**
 * @file completion/namedParams.js
 * @description Named-parameter completions for an argument position inside a call's or an
 * initialization list's parentheses: the caret test, the call-site resolution, and the
 * EXTENDS-chain parameter collection behind them.
 */

const { tokenize, TokenType } = require('../parser');
const { findNode, findMethodOwnerInChain, typeFromNode } = require('../types');
const {
    prevMeaningful,
    resolvePathType,
    isCallParamScope,
    classifyCallSite
} = require('../features/core');
const { PARAM_SORT_PREFIX } = require('./sources');

// Implicit FB_init parameters, supplied by the TwinCAT runtime at every declaration site. They are
// legal to write by hand — diagnostics accept them (see getInitParams in types.js) — but a user
// never does, so completion does not offer them.
const IMPLICIT_FB_INIT_PARAMS = new Set(['binitretains', 'bincopycode']);

/** True for the VAR scope a structured-initialization argument can target. */
function isInputScope(scope) {
    return (scope || '').toUpperCase() === 'VAR_INPUT';
}

/** Human-readable label for a call-parameter scope, used as the completion item's detail. */
function scopeLabel(scope) {
    const s = (scope || '').toUpperCase();
    if (s === 'VAR_OUTPUT') return 'Output';
    if (s === 'VAR_IN_OUT') return 'In/Out';
    return 'Input';
}

/**
 * Collects a node's named parameters across its EXTENDS chain, most-derived declaration first.
 * Stops at the first unresolved ancestor — for completions a missing suggestion is harmless, while
 * an invented one is not.
 * @param {Object} node Starting symbol-index node.
 * @param {Object} index Workspace symbol index.
 * @param {(name: string) => boolean} scopeOk Predicate on a variable's declared VAR scope.
 * @returns {Array<Object>} Variable nodes, de-duplicated by name (the most-derived one wins).
 */
function collectParamVarsInChain(node, index, scopeOk) {
    const out = [];
    const seenNames = new Set();
    const seenNodes = new Set();
    let cur = node;
    while (cur && !seenNodes.has(cur.name.toLowerCase())) {
        seenNodes.add(cur.name.toLowerCase());
        (cur.variables || []).forEach(v => {
            const key = v.name.toLowerCase();
            if (!scopeOk(v.scope) || seenNames.has(key)) return;
            seenNames.add(key);
            out.push(v);
        });
        cur = cur.extends ? findNode(index, cur.extends) : null;
    }
    return out;
}

/**
 * Builds the named-parameter completion items valid at an argument position of a classified call site.
 * Conservative: yields [] whenever the callee, its FB_init, or an ancestor cannot be fully resolved —
 * a name is only ever offered when it is certainly a parameter of that callee.
 *
 * Structured initialization (`x : T := ( … )`) reaches two different member sets depending on what T
 * is: an FB's own VAR_INPUT, or — for a struct DUT — its fields.
 * @param {Object} site Result of classifyCallSite.
 * @param {Object} pou Active POU node (may be null).
 * @param {Object} method Active method node (may be null).
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {Array<Object>} Completion items (possibly empty).
 */
function namedParamCompletions(site, pou, method, symbolIndex) {
    const items = [];
    const push = (v, detail, kind = 6 /* Variable */) => {
        items.push({
            label: v.name,
            kind: kind,
            detail: detail,
            sortText: PARAM_SORT_PREFIX + v.name
        });
    };
    const pushCallParams = (vars) => {
        (vars || []).forEach(v => {
            if (isCallParamScope(v.scope)) push(v, `${scopeLabel(v.scope)} : ${v.type}`);
        });
    };

    // `inst : FB_Type(...)` / `inst : FB_Type := (...)` — both name the initialized *type* directly.
    if (site.kind === 'declInitList' || site.kind === 'structuredInit') {
        const node = findNode(symbolIndex, site.pathParts[0]);
        if (!node) return items;

        // `st : ST_T := (...)` — structured initialization of a struct DUT targets its FIELDS.
        // typeFromNode is the existing DUT discriminator: a DUT that is not an enum is a struct.
        // Enums are deliberately excluded — `e : E_T := (...)` is not field initialization.
        if (site.kind === 'structuredInit' && typeFromNode(node).kind === 'struct') {
            // A struct node's variables *are* its fields. TwinCAT structs may EXTENDS, so the same
            // chain walk used for FB inputs collects inherited fields; it stops at the first
            // unresolved ancestor, which costs suggestions but never invents one.
            collectParamVarsInChain(node, symbolIndex, () => true)
                .forEach(v => push(v, `Field : ${v.type}`, 5 /* Field */));
            return items;
        }

        if (node.type !== 'FUNCTION_BLOCK') return items;

        if (site.kind === 'structuredInit') {
            collectParamVarsInChain(node, symbolIndex, isInputScope)
                .forEach(v => push(v, `Input : ${v.type}`));
            return items;
        }

        // FB_init's own VAR_INPUT — falsy result means the method is absent or the EXTENDS chain
        // broke (findMethodOwnerInChain returns undefined), in which case we offer nothing.
        const found = findMethodOwnerInChain(node, 'FB_init', symbolIndex);
        if (!found) return items;
        (found.method.variables || []).forEach(v => {
            if (!isCallParamScope(v.scope)) return;
            if (IMPLICIT_FB_INIT_PARAMS.has(v.name.toLowerCase())) return;
            push(v, `FB_init parameter : ${v.type}`);
        });
        return items;
    }

    // Ordinary call — `fbInst(`, `MyFunc(`, a bare sibling `Method(`, or `recv.Method(`.
    const parts = site.pathParts;
    const last = parts[parts.length - 1];

    if (parts.length === 1) {
        const instType = resolvePathType([last], pou, method, symbolIndex);
        const node = instType ? findNode(symbolIndex, instType) : null;
        if (node) {
            pushCallParams(collectParamVarsInChain(node, symbolIndex, isCallParamScope));
            return items;
        }
        // Not an instance/type — a bare call on a method of the active POU (or one it inherits).
        const owner = pou ? findMethodOwnerInChain(pou, last, symbolIndex) : null;
        if (owner) pushCallParams(owner.method.variables);
        return items;
    }

    const parentType = resolvePathType(parts.slice(0, -1), pou, method, symbolIndex);
    const parentNode = parentType ? findNode(symbolIndex, parentType) : null;
    if (!parentNode) return items;
    const owner = findMethodOwnerInChain(parentNode, last, symbolIndex);
    if (owner) pushCallParams(owner.method.variables);
    return items;
}

/**
 * Named-parameter completions for the caret, when it sits at an *argument-name* position inside a
 * call's parentheses: the previous meaningful token is '(' or ',', allowing a partially typed name
 * under the caret. After a ':=' / '=>' the caret is on the argument *value* side, where parameter
 * names do not belong and nothing is injected.
 * @param {string} code Structured Text unit.
 * @param {Object} position { line, character } 0-indexed.
 * @param {Object} pou Active POU node (may be null).
 * @param {Object} method Active method node (may be null).
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {Array<Object>} Completion items (empty when the caret is elsewhere, or nothing resolves).
 */
function provideNamedParamCompletions(code, position, pou, method, symbolIndex) {
    // Tokenize only up to the caret: the enclosing '(' is necessarily behind it, and a declaration
    // that is still being typed (`fb : FB_T(`) has no matching ')' to tokenize past anyway.
    const lines = code.split('\n');
    let offset = 0;
    for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1;
    offset += position.character;
    const prefix = code.slice(0, offset);

    let tokens;
    try {
        tokens = tokenize(prefix);
    } catch (e) {
        return []; // unparseable prefix (e.g. cut inside a string) — offer nothing
    }

    // The token before the caret, stepping over a partially typed identifier sitting under it.
    let idx = prevMeaningful(tokens, tokens.length - 1);
    if (idx >= 0 && tokens[idx].type === TokenType.Identifier && /[A-Za-z0-9_]$/.test(prefix)) {
        idx = prevMeaningful(tokens, idx - 1);
    }
    if (idx < 0) return [];

    const prevTok = tokens[idx];
    const atArgName = prevTok.type === TokenType.Punctuation &&
        (prevTok.value === '(' || prevTok.value === ',');
    if (!atArgName) return [];

    const site = classifyCallSite(tokens, idx, pou, method, symbolIndex);
    if (!site) return [];
    return namedParamCompletions(site, pou, method, symbolIndex);
}

module.exports = {
    provideNamedParamCompletions,
    // Also the detail label for a library FB's call parameters — see completion/memberAccess.js.
    scopeLabel
};
