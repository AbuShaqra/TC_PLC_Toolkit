/**
 * @file features/completions.js
 * @description Autocompletion for Structured Text: caret-context classification and the
 * completion-item builders.
 */

const { tokenize, TokenType, isSkippable } = require('../parser');
const { STANDARD_TYPES, STANDARD_KEYWORDS } = require('../builtins');
const { deref, findNode, findMethodOwnerInChain, typeFromNode } = require('../types');
const { inferType } = require('../exprParser');
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
const {
    prevMeaningful,
    lvalueStart,
    isHeaderColon,
    walkExtendsChain,
    findActiveScope,
    resolvePathType,
    isCallParamScope,
    classifyCallSite
} = require('./core');
const { listAttributes, lookupDirective } = require('../pragmas');

// Implicit FB_init parameters, supplied by the TwinCAT runtime at every declaration site. They are
// legal to write by hand — diagnostics accept them (see getInitParams in types.js) — but a user
// never does, so completion does not offer them.
const IMPLICIT_FB_INIT_PARAMS = new Set(['binitretains', 'bincopycode']);

// sortText prefix for named parameters of an enclosing call. '00_' sorts ahead of every generic
// suggestion, snippets ('0_') included, so the parameter names surface at the top of the list.
const PARAM_SORT_PREFIX = '00_';

// Structured Text control-flow & boilerplate snippets. insertTextRules 4 = InsertAsSnippet,
// kind 27 = Snippet. sortText '0_' ranks them above plain keyword matches.
const ST_SNIPPETS = [
    { label: 'IF', detail: 'IF … THEN … END_IF', insertText: 'IF ${1:condition} THEN\n\t$0\nEND_IF' },
    { label: 'IFELSE', detail: 'IF … THEN … ELSE … END_IF', insertText: 'IF ${1:condition} THEN\n\t$2\nELSE\n\t$0\nEND_IF' },
    { label: 'ELSIF', detail: 'ELSIF … THEN', insertText: 'ELSIF ${1:condition} THEN\n\t$0' },
    { label: 'FOR', detail: 'FOR … DO … END_FOR', insertText: 'FOR ${1:i} := ${2:1} TO ${3:n} ${4:BY 1} DO\n\t$0\nEND_FOR' },
    { label: 'WHILE', detail: 'WHILE … DO … END_WHILE', insertText: 'WHILE ${1:condition} DO\n\t$0\nEND_WHILE' },
    { label: 'REPEAT', detail: 'REPEAT … UNTIL … END_REPEAT', insertText: 'REPEAT\n\t$0\nUNTIL ${1:condition}\nEND_REPEAT' },
    { label: 'CASE', detail: 'CASE … OF … END_CASE', insertText: 'CASE ${1:selector} OF\n\t${2:value}:\n\t\t$0\nELSE\n\nEND_CASE' },
    { label: 'VAR', detail: 'VAR … END_VAR', insertText: 'VAR\n\t$0\nEND_VAR' }
];

// ---------------------------------------------------------------------------------------------
// Caret-context vocabularies.
//
// A completion list is only useful if every item is legal *where the caret is*. The classifier
// below (classifyCaretContext) decides which ST context the caret sits in; these sets say what
// each context accepts. They are deliberately kept here rather than in builtins.js: builtins.js
// answers "is this a known symbol", which is a different question from "may it be written here".
// ---------------------------------------------------------------------------------------------

/** Keywords that may open a statement in an implementation body. */
const STATEMENT_KEYWORDS = ['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'RETURN', 'EXIT', 'CONTINUE', 'THIS', 'SUPER'];

/**
 * Keywords that open a VAR section. Offered at a statement start as well, ranked last (see
 * VAR_SECTION_SORT_PREFIX): the single ST unit the LSP sees concatenates a component's declaration
 * and its body, so the token prefix at "first line of the body" and at "another VAR section may
 * follow" is identical — and after an END_VAR both really are legal.
 */
const VAR_SECTION_KEYWORDS = [
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL',
    'VAR_TEMP', 'VAR_STAT', 'VAR_INST', 'VAR_EXTERNAL', 'VAR_CONFIG'
];

/** Modifiers that may follow a VAR section keyword (`VAR CONSTANT`, `VAR RETAIN PERSISTENT`). */
const VAR_MODIFIER_KEYWORDS = ['CONSTANT', 'RETAIN', 'PERSISTENT'];

/** Keywords that may *start* an expression. Binary word-operators (AND/OR/…) may not — they follow one. */
const VALUE_KEYWORDS = ['TRUE', 'FALSE', 'NULL', 'NOT', 'THIS', 'SUPER'];

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
 * Index node types that name a *type* (usable after ':' , EXTENDS, ARRAY … OF, POINTER TO).
 *
 * `LIBRARY` (libsymbols.js) is deliberately absent, and must stay absent: a library symbol node is a
 * bare name with no kind behind it, and the registry holds ~32k of them — admitting them here would
 * empty every library the project references into every type caret. They are reachable at a type
 * position all the same, but only once the caret is *qualified* by a library namespace
 * (`Tc2_MC2.▮`), where the list narrows to that one library. See pushLibraryNamespaces().
 */
const TYPE_NODE_KINDS = new Set(['FUNCTION_BLOCK', 'INTERFACE', 'DUT']);

// sortText prefix for the VAR-section keywords at a statement start: legal there (a new VAR
// section may open), but never what the user is most likely reaching for, so they rank last.
const VAR_SECTION_SORT_PREFIX = '9_';

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

// ---------------------------------------------------------------------------------------------
// Completion-item builders. Each appends to `out`; a context is assembled from the ones it accepts.
// ---------------------------------------------------------------------------------------------

/** Local variables, the POU's own members, and everything it inherits via EXTENDS. */
function pushScopeMembers(out, pou, method, symbolIndex) {
    if (method) {
        method.variables.forEach(v => out.push({ label: v.name, kind: 6, detail: `Local Variable : ${v.type}` }));
    }
    if (!pou) return;

    pou.variables.forEach(v => out.push({ label: v.name, kind: 6, detail: `POU Variable : ${v.type}` }));
    pou.methods.forEach(m => out.push({ label: m.name, kind: 2, detail: `POU Method : ${m.returnType}` }));
    pou.properties.forEach(p => out.push({ label: p.name, kind: 10, detail: `POU Property : ${p.type}` }));
    pou.actions.forEach(a => out.push({ label: a.name, kind: 23, detail: 'POU Action' }));

    // Inherited members from the EXTENDS chain. Stop at the first unresolved ancestor
    // (missing suggestions are harmless here — no conservative concern).
    const { ancestors } = walkExtendsChain(pou, symbolIndex);
    ancestors.forEach(anc => {
        anc.variables.forEach(v => out.push({ label: v.name, kind: 6, detail: `Inherited Variable : ${v.type} (from ${anc.name})` }));
        (anc.methods || []).forEach(m => out.push({ label: m.name, kind: 2, detail: `Inherited Method : ${m.returnType} (from ${anc.name})` }));
        (anc.properties || []).forEach(p => out.push({ label: p.name, kind: 10, detail: `Inherited Property : ${p.type} (from ${anc.name})` }));
        (anc.actions || []).forEach(a => out.push({ label: a.name, kind: 23, detail: `Inherited Action (from ${anc.name})` }));
    });
}

/** GVL names and their global variables. */
function pushGlobals(out, symbolIndex) {
    for (const key of Object.keys(symbolIndex)) {
        const node = symbolIndex[key];
        if (!node || node.type !== 'GVL') continue;
        out.push({ label: key, kind: 9, detail: `GVL : ${key}` });
        node.variables.forEach(gv => out.push({ label: gv.name, kind: 6, detail: `${gv.type} (Global in ${key})` }));
    }
}

/**
 * Every non-GVL project symbol (FBs, PROGRAMs, FUNCTIONs, DUTs, INTERFACEs). Offered wherever an
 * expression or a statement may start: a function call, a qualified enum label (`E_State.eIdle`),
 * a PROGRAM's variable (`PRG_Main.bFlag`), a type argument (`SIZEOF(ST_Data)`).
 */
function pushProjectSymbols(out, symbolIndex) {
    for (const key of Object.keys(symbolIndex)) {
        const node = symbolIndex[key];
        if (!node || node.type === 'GVL') continue;
        out.push({ label: key, kind: 7, detail: `${node.type} : ${key}` });
    }
}

/**
 * The library namespaces the project imports (`Tc2_MC2`, `VisuElems`, … — 28 in the sample), as
 * module-kind items.
 *
 * They belong at a type position because they legitimately *begin* one: `stStatus :
 * Tc2_MC2.ST_AxisStatus`, `stData : VisuElems.VisuStructClientData`. Offering the namespace is also
 * the only way a library type is discoverable at all — the symbols behind it are far too many to
 * offer unqualified (see TYPE_NODE_KINDS), but once the user picks the namespace and types the dot,
 * the list narrows to that library (provideCompletions' dotted branch).
 *
 * The names come from libsymbols.js, which keeps the .plcproj's own spelling; libraries.js lower-
 * cases its registry, so it is only the fallback for a workspace where solely it was indexed.
 * @param {Array<Object>} out Output items.
 * @param {Object} [index] The project's symbol index — its library registry. Omit for the default.
 */
function pushLibraryNamespaces(out, index) {
    const spelled = getLibraryNamespaceNames(index);
    const names = spelled.length ? spelled : getLibraryNamespaces(index);
    names.forEach(ns => out.push({ label: ns, kind: 9 /* Module */, detail: `Library : ${ns}` }));
}

/** Standard elementary types plus every project type (FB, INTERFACE, DUT). Nothing else is a type. */
function pushTypeNames(out, symbolIndex) {
    STANDARD_TYPES.forEach(t => out.push({ label: t, kind: 25 }));
    for (const key of Object.keys(symbolIndex)) {
        const node = symbolIndex[key];
        if (!node || !TYPE_NODE_KINDS.has(node.type)) continue;
        out.push({ label: key, kind: 7, detail: `${node.type} : ${key}` });
    }
    pushLibraryNamespaces(out, symbolIndex);
}

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
 * Members of the project's enums. `preferred`, when given, is the enum the caret's context expects
 * (an assignment target, a CASE selector); its members rank ahead of everything else in the list.
 *
 * The unqualified sweep stays project-only (`type === 'DUT'`): a library enum's members are legal at
 * a value caret too, but the registry holds thousands of them and dumping every registered library
 * enum into every expression would drown the list. A library enum reached as the *preferred* one —
 * `CASE eDeviceState OF ▮` on a `E_EthercatDeviceState` — is a different matter: it is precisely what
 * the caret is asking for, so it is offered.
 * @param {Array<Object>} out Output items.
 * @param {Object} symbolIndex Workspace symbol index.
 * @param {Object} preferred Enum node to rank first (may be null).
 * @param {boolean} othersToo When false, only `preferred`'s members are offered.
 */
function pushEnumMembers(out, symbolIndex, preferred, othersToo = true) {
    const preferredName = preferred ? preferred.name.toLowerCase() : null;
    for (const key of Object.keys(symbolIndex)) {
        const node = symbolIndex[key];
        if (!node || typeFromNode(node).kind !== 'enum') continue;
        const isPreferred = preferredName !== null && node.name.toLowerCase() === preferredName;
        if (!isPreferred && (!othersToo || node.type !== 'DUT')) continue;
        node.variables.forEach(m => {
            const item = { label: m.name, kind: 20, detail: `Enum Member (of ${node.name})` };
            if (isPreferred) item.sortText = PARAM_SORT_PREFIX + m.name;
            out.push(item);
        });
    }
}

/**
 * Ranks an inline (anonymous) enum's values to the top of a suggestion list they are ALREADY in.
 *
 * Deliberately re-ranking rather than pushing: the parser registers inline-enum values as ordinary
 * scope variables (that is what makes them resolve as identifiers at all), so pushScopeMembers has
 * already offered every one of them. Pushing again duplicated the whole set. Only the ordering was
 * missing — at `eState := ▮` its own values are what the user reaches for.
 * @param {Array<Object>} out Completion items, re-ranked in place.
 * @param {Object} type A Type with `anonymous: true` and a `values` array.
 */
function rankInlineEnumValues(out, type) {
    if (!type || !type.anonymous || !Array.isArray(type.values)) return;
    const wanted = new Set(type.values.map(v => v.toLowerCase()));
    out.forEach(item => {
        if (wanted.has(String(item.label).toLowerCase())) {
            item.sortText = PARAM_SORT_PREFIX + item.label;
        }
    });
}

/** Keyword items, optionally with a sortText prefix. */
function pushKeywords(out, keywords, sortPrefix) {
    keywords.forEach(kw => {
        const item = { label: kw, kind: 14 };
        if (sortPrefix) item.sortText = sortPrefix + kw;
        out.push(item);
    });
}

/** Control-flow / boilerplate snippets (they insert their own matching END_ terminator). */
function pushSnippets(out, accept) {
    ST_SNIPPETS.forEach(s => {
        if (accept && !accept(s)) return;
        out.push({
            label: s.label,
            kind: 27, // Snippet
            insertText: s.insertText,
            insertTextRules: 4, // InsertAsSnippet
            detail: s.detail,
            sortText: '0_' + s.label
        });
    });
}

/**
 * The full, context-blind list: everything that could be written anywhere. Used as the fallback
 * when the caret's context cannot be established, and inside a call's parentheses.
 */
function pushEverything(out, pou, method, symbolIndex) {
    pushScopeMembers(out, pou, method, symbolIndex);
    pushGlobals(out, symbolIndex);
    pushProjectSymbols(out, symbolIndex);
    pushKeywords(out, Array.from(STANDARD_KEYWORDS));
    STANDARD_TYPES.forEach(t => out.push({ label: t, kind: 25 }));
    pushSnippets(out);
}

// sortText prefixes inside a pragma. Every item in that list carries one, so only their order
// relative to each other matters: Infosys-documented names first, then the ones that are merely
// measured to exist. Both sort before nothing else, because a pragma completion never shares its
// list with ordinary ST suggestions.
const PRAGMA_DOCUMENTED_SORT_PREFIX = '0_';
const PRAGMA_OBSERVED_SORT_PREFIX = '1_';

/**
 * Pragma heads offered at `{▮`. `attribute` is not one of the catalog's `directives` — it names a
 * whole category rather than a single form — so it is added here with the category's own page.
 */
const PRAGMA_HEADS = ['attribute', 'region', 'endregion', 'IF', 'ELSIF', 'ELSE', 'END_IF',
    'define', 'undefine', 'text', 'info', 'warning', 'error'];

/**
 * Completions inside a pragma, or null when the caret is not in one.
 *
 * Pragmas are their own little language — nothing in ST's scope, type or statement machinery applies
 * inside `{ … }`, and the caller returns this list verbatim rather than merging it. Two carets are
 * worth answering: the head (`{▮`) and an attribute name (`{attribute '▮`), which is the one that
 * actually pays, since the name has to be spelled exactly and there are 78 of them.
 *
 * Detection is textual and deliberately narrow: the last `{` on the line, still unclosed. TwinCAT
 * writes every pragma on one line, so a `{` with no `}` after it *is* the pragma being typed.
 * @param {string} textBeforeCursor Text on the caret's line, up to the caret.
 * @returns {?Array<Object>} LSP CompletionItems, or null if the caret is not inside a pragma.
 */
function pragmaCompletions(textBeforeCursor) {
    const open = textBeforeCursor.lastIndexOf('{');
    if (open === -1) return null;
    const span = textBeforeCursor.slice(open);
    if (span.includes('}')) return null;

    // `{▮` / `{att▮` — the head. Monaco replaces the typed word, so the label alone is the insert.
    if (/^\{\s*[A-Za-z_]*$/.test(span)) {
        return PRAGMA_HEADS.map(head => {
            const entry = lookupDirective(head);
            return {
                label: head,
                kind: 14, // Keyword
                detail: entry ? entry.syntax : "attribute '<name>'",
                sortText: PRAGMA_DOCUMENTED_SORT_PREFIX + head.toLowerCase()
            };
        });
    }

    // `{attribute '▮` — inside the quotes. Also answered for `{attribute ▮`, where the quotes do not
    // exist yet and therefore have to come along with the name.
    const insideQuotes = /^\{\s*attribute\s+'[^']*$/i.test(span);
    const beforeQuotes = /^\{\s*attribute\s+$/i.test(span);
    if (insideQuotes || beforeQuotes) {
        return listAttributes().map(attr => ({
            label: attr.name,
            kind: 10, // Property
            insertText: insideQuotes ? attr.name : `'${attr.name}'`,
            detail: attr.tier === 'documented'
                ? 'TwinCAT attribute (Beckhoff Infosys)'
                : (attr.note || 'TwinCAT attribute (observed in libraries; not documented)'),
            sortText: (attr.tier === 'documented' ? PRAGMA_DOCUMENTED_SORT_PREFIX : PRAGMA_OBSERVED_SORT_PREFIX) + attr.name.toLowerCase()
        }));
    }

    return null;
}

/**
 * Provides autocompletions for Structured Text.
 * @param {string} code
 * @param {Object} position { line, character } 0-indexed
 * @param {Object} symbolIndex
 * @param {string} fileUri
 * @returns {Array<Object>} LSP CompletionItems
 */
function provideCompletions(code, position, symbolIndex, fileUri) {
    const lines = code.split('\n');
    const lineIndex = position.line;
    const lineText = lines[lineIndex] || '';
    const textBeforeCursor = lineText.substring(0, position.character);

    // Inside `{ … }` nothing else is legal, so this returns instead of contributing — see
    // pragmaCompletions. It is first because a pragma sits in the declaration part, where the
    // scope lookup below would otherwise offer variables into the middle of an attribute name.
    const pragmaItems = pragmaCompletions(textBeforeCursor);
    if (pragmaItems) return pragmaItems;

    // Identify scopes
    const { pou, method } = findActiveScope(symbolIndex, fileUri, lineIndex + 1);

    // Check if typing after a dot
    const dotMatch = textBeforeCursor.match(/([a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?)*)\.([a-zA-Z0-9_]*)$/i);

    if (dotMatch) {
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

    const suggestions = [];

    // Named parameters of an enclosing call / FB initialization list, when the caret sits at an
    // argument-name position. Strictly ADDITIVE — the context list below still follows, because the
    // same caret may be a *positional* argument instead (`fbInst(bEnable`). Their sortText ranks
    // them above everything else. The classifier calls both positions inside the parentheses —
    // the name one and the value one after `:=` / `=>` — a 'value' context, since a positional
    // argument is an expression: no IF, no END_VAR, no snippet is legal at either of them.
    provideNamedParamCompletions(code, position, pou, method, symbolIndex)
        .forEach(item => suggestions.push(item));

    // What is legal at the caret decides what is offered. An unclassifiable caret falls back to
    // the full list — a missing suggestion is a worse failure than a noisy one.
    const ctx = classifyCaretContext(code, position, pou, method, symbolIndex);

    switch (ctx.kind) {
        // `x : ▮`, `ARRAY [1..3] OF ▮`, `POINTER TO ▮`, `EXTENDS ▮`, `METHOD m : ▮` — a type, and
        // nothing else. No keywords, no snippets, no variables.
        case 'type':
            pushTypeNames(suggestions, symbolIndex);
            break;

        // Inside a VAR block / STRUCT, at the start of a declaration: the user is inventing a name,
        // so there is nothing to complete — except the terminator that closes the open block, and
        // the modifiers that may follow the section keyword (`VAR CONSTANT`).
        case 'varName':
            pushKeywords(suggestions, [ctx.terminator]);
            if (ctx.afterSectionKeyword) pushKeywords(suggestions, VAR_MODIFIER_KEYWORDS);
            break;

        // Between `CASE x OF` and its first label: the selector's enum members are the answer.
        // The enum's own name too — TwinCAT labels may be qualified (`E_State.eIdle`).
        case 'caseLabel': {
            const selected = enumNodeOfSelector(ctx.selector, pou, method, symbolIndex);
            if (selected && selected.anonymousEnum) {
                // No qualified form to offer: the "name" of an inline enum is its own value list,
                // which is not something a user can write as a label.
                selected.variables.forEach(m => suggestions.push({
                    label: m.name, kind: 20, detail: 'Enum Member (inline enum)',
                    sortText: PARAM_SORT_PREFIX + m.name
                }));
                pushKeywords(suggestions, ['ELSE']);
            } else if (selected) {
                pushEnumMembers(suggestions, symbolIndex, selected, false);
                suggestions.push({ label: selected.name, kind: 7, detail: `DUT : ${selected.name}` });
                pushKeywords(suggestions, ['ELSE']);
            } else {
                // A non-enum selector (INT, BYTE, …): the labels are literals or constants, which we
                // cannot single out from the index — fall back to the value list rather than nothing.
                pushScopeMembers(suggestions, pou, method, symbolIndex);
                pushGlobals(suggestions, symbolIndex);
                pushProjectSymbols(suggestions, symbolIndex);
                pushEnumMembers(suggestions, symbolIndex, null);
                pushKeywords(suggestions, ['ELSE']);
            }
            break;
        }

        // After `:=`, `=>`, a comparison/arithmetic operator, or inside an IF/WHILE/UNTIL condition:
        // an expression. No block terminators, no snippets, no declaration keywords.
        case 'value': {
            pushScopeMembers(suggestions, pou, method, symbolIndex);
            pushGlobals(suggestions, symbolIndex);
            pushProjectSymbols(suggestions, symbolIndex);
            const targetType = ctx.target ? deref(inferType(ctx.target, { pou, method }, symbolIndex)) : null;
            const targetEnum = (targetType && targetType.kind === 'enum' && !targetType.anonymous)
                ? findNode(symbolIndex, targetType.name) : null;
            pushEnumMembers(suggestions, symbolIndex, targetEnum);
            // `eState := ▮` on an inline enum: its values are already in the list as scope
            // variables, so lift them to the top rather than adding a second copy of each.
            rankInlineEnumValues(suggestions, targetType);
            pushKeywords(suggestions, VALUE_KEYWORDS);
            break;
        }

        // The start of a statement in an implementation body.
        case 'statement': {
            pushScopeMembers(suggestions, pou, method, symbolIndex);
            pushGlobals(suggestions, symbolIndex);
            pushProjectSymbols(suggestions, symbolIndex);
            pushKeywords(suggestions, STATEMENT_KEYWORDS);

            // A terminator / mid-construct keyword ONLY where it closes or continues a block that is
            // actually open at the caret — the whole reason the block stack is tracked.
            if (ctx.openBlock && BLOCK_CONTINUATIONS[ctx.openBlock]) {
                pushKeywords(suggestions, BLOCK_CONTINUATIONS[ctx.openBlock]);
            }

            // Directly inside a CASE body a label may begin here just as well as a statement, so the
            // selector's enum members are offered too — ranked first, since a label is the likelier
            // intent on a fresh line there.
            const caseEnum = ctx.selector ? enumNodeOfSelector(ctx.selector, pou, method, symbolIndex) : null;
            if (caseEnum) pushEnumMembers(suggestions, symbolIndex, caseEnum, false);

            // A VAR section may legally open here too: the LSP sees declaration and body as one ST
            // unit, so "first statement of the body" and "another VAR section follows" share the same
            // token prefix after an END_VAR. Ranked last — they are rarely what is wanted.
            pushKeywords(suggestions, VAR_SECTION_KEYWORDS, VAR_SECTION_SORT_PREFIX);

            // Snippets insert their own matching END_ terminator, so they are safe here — with two
            // exceptions: VAR is a declaration, not a statement (it goes with the VAR keywords
            // above), and ELSIF continues an IF, so it obeys the same open-block rule its keyword does.
            pushSnippets(suggestions, s => {
                if (s.label === 'VAR') return false;
                if (s.label === 'ELSIF') return ctx.openBlock === 'IF';
                return true;
            });
            break;
        }

        // Context unknown (or inside a call's parentheses): offer everything, as before.
        default:
            pushEverything(suggestions, pou, method, symbolIndex);
            break;
    }

    return suggestions;
}

module.exports = {
    provideCompletions,
    // Pure; exported for the harness — the module state it would otherwise need is only present on
    // a machine with the right libraries installed and the project built.
    rankNamespaceSymbol,
    // Pure, and answered without a symbol index at all; exported so the pragma harness can test the
    // caret detection directly rather than through a whole indexed document.
    pragmaCompletions
};
