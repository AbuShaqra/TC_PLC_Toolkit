/**
 * @file completion/context.js
 * @description The caret-context classifier: the prefix scanner that reconstructs the structural
 * state at the caret, the CASE-selector helpers, and classifyCaretContext itself, plus the token
 * and keyword tables the classifier reads.
 */

const { tokenize, TokenType, isSkippable } = require('../parser');
const { deref, findNode, typeFromNode } = require('../types');
const { inferType } = require('../exprParser');
const { prevMeaningful, lvalueStart, isHeaderColon } = require('../features/core');
const { VAR_MODIFIER_KEYWORDS } = require('./sources');

// ---------------------------------------------------------------------------------------------
// Caret-context vocabularies.
//
// A completion list is only useful if every item is legal *where the caret is*. The classifier
// below (classifyCaretContext) decides which ST context the caret sits in; these sets say what
// each context accepts. They are deliberately kept here rather than in builtins.js: builtins.js
// answers "is this a known symbol", which is a different question from "may it be written here".
// ---------------------------------------------------------------------------------------------

/** Operators after which an expression (a value) is expected. */
const VALUE_OPERATORS = new Set([':=', '=>', '+', '-', '*', '/', '=', '<>', '<', '<=', '>', '>=']);

/** Keywords after which an expression (a value) is expected. `TO` here is FOR's, not POINTER TO's. */
const VALUE_PRECEDING_KEYWORDS = new Set([
    'IF', 'ELSIF', 'WHILE', 'UNTIL', 'TO', 'BY',
    'AND', 'OR', 'XOR', 'NOT', 'MOD', 'AND_THEN', 'OR_ELSE'
]);

/** Keywords after which a statement begins. */
const STATEMENT_PRECEDING_KEYWORDS = new Set([
    'THEN', 'ELSE', 'DO', 'REPEAT',
    'END_IF', 'END_CASE', 'END_FOR', 'END_WHILE', 'END_REPEAT', 'END_VAR'
]);

/**
 * What may legally close or continue each open block. The hard rule for terminators and
 * mid-construct keywords is that they are offered ONLY when the block they belong to is actually
 * open at the caret — which is what the block stack in scanPrefix establishes.
 */
const BLOCK_CONTINUATIONS = {
    IF: ['ELSIF', 'ELSE', 'END_IF'],
    CASE: ['ELSE', 'END_CASE'],
    FOR: ['END_FOR'],
    WHILE: ['END_WHILE'],
    REPEAT: ['UNTIL', 'END_REPEAT']
};

/** Blocks tracked on the block stack (their terminators/continuations live in BLOCK_CONTINUATIONS). */
const BLOCK_OPENERS = new Set(['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT']);

/**
 * Keywords that start or end a component. Hitting one resets the scanner's block/paren state:
 * an unbalanced construct in an *earlier* component (the user is mid-edit somewhere) must not
 * poison the context of the component the caret is actually in.
 */
const COMPONENT_KEYWORDS = new Set([
    'FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE', 'GVL', 'METHOD', 'PROPERTY', 'ACTION',
    'TYPE', 'GET', 'SET',
    'END_FUNCTION_BLOCK', 'END_PROGRAM', 'END_FUNCTION', 'END_INTERFACE', 'END_METHOD',
    'END_PROPERTY', 'END_ACTION', 'END_TYPE', 'END_GET', 'END_SET'
]);

/**
 * Walks the token prefix that precedes the caret and reconstructs the structural state at it:
 * which declaration block is open, which control-flow blocks are open, and which bracket the
 * caret is nested in. Linear, allocation-light, and never throws.
 *
 * Component keywords reset the state — the caret's component is the only one whose structure can
 * be trusted, since any earlier one may be half-typed.
 * @param {Array<Object>} tokens Tokens of the text before the caret.
 * @returns {{inVarBlock: boolean, inStruct: boolean, inTypeDecl: boolean,
 *            openers: Array<number>, blocks: Array<Object>}}
 *          `openers` holds the token indices of the still-unclosed '(' / '['; `blocks` the open
 *          control-flow blocks, innermost last ({ word, startIdx, ofIdx } — ofIdx is the CASE's OF).
 */
function scanPrefix(tokens) {
    let inVarBlock = false;
    let inStruct = false;
    let inTypeDecl = false;
    const openers = [];
    const blocks = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (isSkippable(t)) continue;

        if (t.type === TokenType.Punctuation) {
            if (t.value === '(' || t.value === '[') openers.push(i);
            else if (t.value === ')' || t.value === ']') openers.pop();
            continue;
        }
        if (t.type !== TokenType.Keyword) continue;

        const kw = t.value.toUpperCase();

        if (COMPONENT_KEYWORDS.has(kw)) {
            inVarBlock = false;
            inStruct = false;
            inTypeDecl = (kw === 'TYPE');
            openers.length = 0;
            blocks.length = 0;
            continue;
        }
        if (kw === 'END_VAR') { inVarBlock = false; continue; }
        if (kw.startsWith('VAR')) { inVarBlock = true; continue; }
        if (kw === 'STRUCT' || kw === 'UNION') { inStruct = true; continue; }
        if (kw === 'END_STRUCT' || kw === 'END_UNION') { inStruct = false; continue; }

        if (BLOCK_OPENERS.has(kw)) { blocks.push({ word: kw, startIdx: i, ofIdx: -1 }); continue; }
        if (kw === 'OF') {
            // The OF of an open CASE. `ARRAY [..] OF` never reaches here with a CASE on top of the
            // stack, and a declaration block is excluded outright.
            const top = blocks[blocks.length - 1];
            if (!inVarBlock && !inStruct && top && top.word === 'CASE' && top.ofIdx === -1) top.ofIdx = i;
            continue;
        }
        if (kw.startsWith('END_')) {
            const word = kw.slice(4);
            const top = blocks[blocks.length - 1];
            if (top && top.word === word) blocks.pop();
        }
    }

    return { inVarBlock, inStruct, inTypeDecl, openers, blocks };
}

/**
 * Collects the selector tokens of a `CASE <selector> OF` whose OF sits at `ofIdx`.
 * @param {Array<Object>} tokens Token stream.
 * @param {number} ofIdx Index of the OF keyword.
 * @returns {Array<Object>|null} Meaningful selector tokens, or null when no CASE precedes it.
 */
function caseSelectorTokens(tokens, ofIdx) {
    const out = [];
    for (let i = ofIdx - 1; i >= 0; i--) {
        const t = tokens[i];
        if (isSkippable(t)) continue;
        if (t.type === TokenType.Keyword && t.value.toUpperCase() === 'CASE') {
            return out.length ? out : null;
        }
        if (t.type === TokenType.Punctuation && t.value === ';') return null; // ran past the statement
        out.unshift(t);
    }
    return null;
}

/**
 * Resolves the selector tokens of a CASE to their enum node, when they name one.
 * @param {Array<Object>} selector Meaningful selector tokens.
 * @param {Object} pou Active POU node (may be null).
 * @param {Object} method Active method node (may be null).
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {Object|null} The enum's index node, or null when the selector is not an enum.
 */
function enumNodeOfSelector(selector, pou, method, symbolIndex) {
    if (!selector || selector.length === 0) return null;
    const type = deref(inferType(selector, { pou, method }, symbolIndex));
    if (!type || type.kind !== 'enum') return null;
    // An inline enum (`eState : (idle, running)`) has no DUT node to find — the values are carried
    // on the Type itself. Hand back a node-shaped stand-in so the caret is served the same way.
    if (type.anonymous) {
        return {
            name: type.name,
            type: 'DUT',
            anonymousEnum: true,
            variables: type.values.map(v => ({ name: v, type: 'Enum' }))
        };
    }
    const node = findNode(symbolIndex, type.name);
    return node && typeFromNode(node).kind === 'enum' ? node : null;
}

/**
 * Classifies the caret's context so that provideCompletions can offer only what is valid there.
 *
 * Two rules govern it, and they pull against each other:
 *   - never offer what cannot be written at the caret — a block terminator where a *type* belongs,
 *     a control-flow snippet inside a VAR block — which is the whole point of the classifier;
 *   - never starve the user: when the context cannot be established with confidence it returns
 *     'unknown', and the caller falls back to the full context-blind list. A missing suggestion is
 *     a worse failure than a noisy one, and the caret is mid-edit by definition.
 *
 * Never throws: the line under the caret is, by definition, half-written.
 * @param {string} code Structured Text unit.
 * @param {Object} position { line, character } 0-indexed.
 * @param {Object} pou Active POU node (may be null).
 * @param {Object} method Active method node (may be null).
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {Object} { kind: 'type'|'varName'|'statement'|'value'|'caseLabel'|'unknown', … }
 */
function classifyCaretContext(code, position, pou, method, symbolIndex) {
    const UNKNOWN_CTX = { kind: 'unknown' };
    try {
        const lines = code.split('\n');
        let offset = 0;
        for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1;
        offset += position.character;
        const prefix = code.slice(0, offset);

        // Drop the partially typed word under the caret: it is what the user is *completing*, not
        // context. Cutting it off textually (rather than dropping a token) keeps a half-typed
        // keyword — 'EN' of 'END_IF' — from being read as an identifier.
        const word = (prefix.match(/[A-Za-z_][A-Za-z0-9_]*$/) || [''])[0];
        const head = prefix.slice(0, prefix.length - word.length);

        const tokens = tokenize(head);

        // Caret inside a comment / pragma / string: whatever precedes that token says nothing about
        // where the caret is. Fall back rather than misclassify.
        const lastTok = tokens[tokens.length - 1];
        if (lastTok && lastTok.end >= head.length &&
            (lastTok.type === TokenType.Comment || lastTok.type === TokenType.Pragma || lastTok.type === TokenType.String)) {
            return UNKNOWN_CTX;
        }

        const state = scanPrefix(tokens);
        const p = prevMeaningful(tokens, tokens.length - 1);
        const prev = p >= 0 ? tokens[p] : null;
        if (!prev) return UNKNOWN_CTX; // start of the unit — nothing to go on

        const statementCtx = () => {
            const top = state.blocks[state.blocks.length - 1];
            return {
                kind: 'statement',
                openBlock: top ? top.word : null,
                // Only when the *innermost* open block is a CASE past its OF is the caret in that
                // CASE's body, where the selector's enum members are what the user reaches for.
                selector: (top && top.word === 'CASE' && top.ofIdx !== -1)
                    ? caseSelectorTokens(tokens, top.ofIdx) : null
            };
        };

        // The target of an assignment/initialization decides what the value may be: `eState := ▮`
        // and `eState : E_State := ▮` both want that enum's members first.
        const valueCtx = () => {
            let target = null;
            if (prev.type === TokenType.Operator && prev.value === ':=') {
                const start = lvalueStart(tokens, p - 1);
                if (start !== -1) {
                    const lhs = [];
                    for (let q = start; q < p; q++) if (!isSkippable(tokens[q])) lhs.push(tokens[q]);
                    target = lhs.length ? lhs : null;
                }
            }
            return { kind: 'value', target };
        };

        // 1. Inside a call's / an initialization list's parentheses. Two different positions live in
        //    there and they accept different things, so the branch must tell them apart. It also has
        //    to answer for the whole paren interior — an FB init list sits inside a VAR block, and
        //    falling through would let the varName rule (step 4) classify the arguments.
        const openIdx = state.openers.length ? state.openers[state.openers.length - 1] : -1;
        let inCallParens = false;
        if (openIdx >= 0 && tokens[openIdx].value === '(') {
            const b = prevMeaningful(tokens, openIdx - 1);
            const before = b >= 0 ? tokens[b] : null;
            const isCall = !!before && before.type === TokenType.Identifier;
            // `inst : FB_T := (▮)` / `st : ST_T := (▮)` — structured initialization. Only a
            // declaration block can mean that; in a body, `x := (` is an ordinary grouping paren.
            const isStructuredInit = !!before && before.type === TokenType.Operator && before.value === ':='
                && (state.inVarBlock || state.inStruct);
            inCallParens = isCall || isStructuredInit;
        }

        const prevKw = prev.type === TokenType.Keyword ? prev.value.toUpperCase() : null;

        if (inCallParens) {
            // Argument-*name* position (`FB_T(▮`, `FB_T(a := 1, ▮`). provideNamedParamCompletions
            // owns the parameter names here and injects them on top, ranked first. What the caret
            // accepts *besides* a parameter name is a POSITIONAL argument — which is an expression.
            // So this is a value position too: no IF, no END_VAR, no snippet is legal at it.
            if (prev.type === TokenType.Punctuation && (prev.value === '(' || prev.value === ',')) {
                return valueCtx();
            }
            // Argument-*value* position (`FB_T(ipAxis := ▮`, `fbInst(bOut => ▮`, `f(n := a + ▮`).
            // The same expression rule, reached after the `:=` / `=>` that names the parameter.
            if (prev.type === TokenType.Operator && VALUE_OPERATORS.has(prev.value)) return valueCtx();
            if (prevKw && VALUE_PRECEDING_KEYWORDS.has(prevKw)) return valueCtx();
            return UNKNOWN_CTX; // anything else inside the parens — unclassifiable, so fall back
        }

        // 2. Type positions.
        if (prevKw === 'EXTENDS' || prevKw === 'IMPLEMENTS') return { kind: 'type' };
        if (prevKw === 'TO') {
            const b = tokens[prevMeaningful(tokens, p - 1)];
            if (b && b.type === TokenType.Keyword && ['POINTER', 'REFERENCE'].includes(b.value.toUpperCase())) {
                return { kind: 'type' };
            }
            // otherwise it is FOR's `TO` — an expression follows (handled in step 4).
        }
        if (prevKw === 'OF') {
            const b = tokens[prevMeaningful(tokens, p - 1)];
            if (b && b.type === TokenType.Punctuation && b.value === ']') return { kind: 'type' }; // ARRAY [..] OF ▮
            const selector = caseSelectorTokens(tokens, p);
            if (selector) return { kind: 'caseLabel', selector };
            return UNKNOWN_CTX;
        }
        if (prev.type === TokenType.Punctuation && prev.value === ':') {
            if (state.inVarBlock || state.inStruct || state.inTypeDecl) return { kind: 'type' };
            if (isHeaderColon(tokens, p)) return { kind: 'type' };
            return statementCtx(); // a CASE label's / an ACTION header's ':' — a statement follows
        }

        // 3. Value positions. Checked before the VAR-name rule: an initializer (`n : INT := ▮`) sits
        //    inside a VAR block but is an expression, not a name.
        if (prev.type === TokenType.Operator && VALUE_OPERATORS.has(prev.value)) return valueCtx();
        if (prevKw && VALUE_PRECEDING_KEYWORDS.has(prevKw)) return valueCtx();
        if (openIdx >= 0 && prev.type === TokenType.Punctuation && ['(', '[', ','].includes(prev.value)) {
            return valueCtx(); // a grouping paren or an index expression
        }

        // 4. Declaration blocks: the caret is on the name the user is inventing.
        if (state.inVarBlock || state.inStruct) {
            const terminator = state.inStruct ? 'END_STRUCT' : 'END_VAR';
            if (prevKw && (prevKw.startsWith('VAR') || prevKw === 'STRUCT' || prevKw === 'UNION')) {
                return { kind: 'varName', terminator, afterSectionKeyword: prevKw.startsWith('VAR') };
            }
            if (prevKw && VAR_MODIFIER_KEYWORDS.includes(prevKw)) {
                return { kind: 'varName', terminator, afterSectionKeyword: true };
            }
            if (prev.type === TokenType.Punctuation && (prev.value === ';' || prev.value === ',')) {
                return { kind: 'varName', terminator, afterSectionKeyword: false };
            }
            return UNKNOWN_CTX;
        }

        // 5. Statement starts.
        if (prev.type === TokenType.Punctuation && prev.value === ';') return statementCtx();
        if (prevKw && STATEMENT_PRECEDING_KEYWORDS.has(prevKw)) return statementCtx();

        return UNKNOWN_CTX;
    } catch (e) {
        return UNKNOWN_CTX; // half-written code must never break completion
    }
}

module.exports = {
    BLOCK_CONTINUATIONS,
    classifyCaretContext,
    enumNodeOfSelector
};
