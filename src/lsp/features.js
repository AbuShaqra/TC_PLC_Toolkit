/**
 * @file features.js
 * @description LSP language feature implementations: completions, definitions, references, highlights, diagnostics.
 */

const fs = require('fs');
const { tokenize, TokenType, isSkippable, parseAndIndexDocument } = require('./parser');
const { STANDARD_TYPES, STANDARD_KEYWORDS, isBuiltin } = require('./builtins');
const { parseTwinCatXml } = require('../xmlParser');
const { convertXmlToSt } = require('../stConverter');
const {
    UNKNOWN,
    parseTypeString,
    deref,
    lookupMember,
    resolveSymbolType,
    resolvePath,
    isAssignable,
    isRelatedAssignable,
    parentNames,
    findNode,
    findMethodOwnerInChain,
    getCallParams,
    getInitParams,
    typeFromNode
} = require('./types');
const { inferType } = require('./exprParser');
const { isLibraryNamespace, getLibraryNamespaces } = require('./libraries');
const {
    getNamespaceSymbols,
    getLibraryNamespaceNames,
    getTypeSystemNamespaceTypes
} = require('./libsymbols');

/**
 * Converts a file URI (file:///C:/...) to a filesystem path. Mirrors server.js's
 * uriToFsPath so encoded (file:///c%3A/...) and unencoded URIs resolve identically.
 * @param {string} uri File URI.
 * @returns {string} Filesystem path.
 */
function uriToFsPath(uri) {
    return decodeURIComponent(uri.replace(/^file:\/\/\//i, '')).replace(/\//g, '\\');
}

/**
 * Normalizes a URI for identity comparison so that percent-encoded and unencoded
 * forms of the same path (and case differences on Windows) compare equal.
 * @param {string} uri File URI.
 * @returns {string} Normalized key.
 */
function normalizeUri(uri) {
    return decodeURIComponent(uri).toLowerCase();
}

/**
 * Semantic diagnostic toggles. Conservative defaults; the extension may override via custom/config.
 */
let diagnosticsConfig = {
    memberAccess: true,
    callArguments: true,
    // Off by default. Library types and the project's .tmc type system are both indexed now
    // (libsymbols.js), so this no longer fires on every library reference — what is left is the
    // handful of symbols that stay genuinely unresolvable, which the undeclared-identifier check
    // already reports. Enabling it mostly re-reports those.
    declarationTypes: false,
    typeCompatibility: true
};

/**
 * Updates the semantic diagnostics configuration.
 * @param {Object} cfg Partial config overrides.
 */
function setDiagnosticsConfig(cfg) {
    diagnosticsConfig = Object.assign({}, diagnosticsConfig, cfg || {});
}

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

/** Keywords that introduce a named return/alias type: `METHOD m : ▮`, `FUNCTION f : ▮`, `TYPE t : ▮`. */
const TYPED_HEADER_KEYWORDS = new Set(['METHOD', 'FUNCTION', 'PROPERTY', 'TYPE']);

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

/** LSP CompletionItemKind per `.tmc` type kind (Class / Struct / Enum). */
const LIB_KIND_ITEM = {
    fb: { kind: 7, label: 'Function Block' },
    struct: { kind: 22, label: 'Struct' },
    enum: { kind: 13, label: 'Enum' }
};

/**
 * Walks a POU's EXTENDS graph and returns the resolved ancestor nodes. The starting POU itself is NOT
 * included. Handles multiple inheritance — an INTERFACE may extend several interfaces (`EXTENDS I_A,
 * I_B`) — by traversing every parent breadth-first, and is cycle-safe via a seen-set of node names.
 * For the common single-parent case this yields exactly the old linear chain.
 * @param {Object} pou Starting POU node.
 * @param {Object} index Workspace symbol index.
 * @returns {{ ancestors: Object[], fullyResolved: boolean }} fullyResolved is false when any `extends`
 *          reference cannot be found in the index (the graph is uncertain).
 */
function walkExtendsChain(pou, index) {
    const ancestors = [];
    const seen = new Set();
    if (pou && pou.name) seen.add(pou.name.toLowerCase());
    let fullyResolved = true;
    const queue = [...parentNames(pou)];
    while (queue.length) {
        const name = queue.shift();
        const node = findNode(index, name);
        if (!node) { fullyResolved = false; continue; } // unknown ancestor — graph uncertain
        const key = node.name.toLowerCase();
        if (seen.has(key)) continue; // already visited (diamond) or cycle — stop
        seen.add(key);
        ancestors.push(node);
        for (const pn of parentNames(node)) queue.push(pn);
    }
    return { ancestors, fullyResolved };
}

/**
 * Locates a member's declaration on a node or on any ancestor up its EXTENDS chain, searched in the
 * same order the bare-identifier path uses: variables, methods, properties, actions.
 *
 * External (library) nodes are skipped, not searched: they carry no uri and no range, so answering
 * with one would send the webview to an arbitrary line of the *active* file.
 * @param {Object} node Starting POU/interface node.
 * @param {string} name Member name.
 * @param {Object} index Workspace symbol index.
 * @returns {{uri: string, range: Object, componentId: string}|null} null when nothing declares it.
 */
function findMemberInChain(node, name, index) {
    const lower = name.toLowerCase();
    const { ancestors } = walkExtendsChain(node, index);

    for (const owner of [node, ...ancestors]) {
        if (!owner || owner.external) continue;

        const v = (owner.variables || []).find(x => x.name.toLowerCase() === lower);
        if (v) return { uri: owner.uri, range: convertToLspRange(v.range), componentId: 'root' };

        const m = (owner.methods || []).find(x => x.name.toLowerCase() === lower);
        if (m) return { uri: owner.uri, range: convertToLspRange(m.nameRange), componentId: `method_${m.name}` };

        const p = (owner.properties || []).find(x => x.name.toLowerCase() === lower);
        if (p) return { uri: owner.uri, range: convertToLspRange(p.nameRange), componentId: `prop_${p.name}` };

        const a = (owner.actions || []).find(x => x.name.toLowerCase() === lower);
        if (a) return { uri: owner.uri, range: convertToLspRange(a.nameRange), componentId: `action_${a.name}` };
    }
    return null;
}

/** Returns the index of the next non-skippable token at or after idx. */
function nextMeaningful(tokens, idx) {
    while (idx < tokens.length && isSkippable(tokens[idx])) idx++;
    return idx;
}

/** Returns the index of the previous non-skippable token at or before idx. */
function prevMeaningful(tokens, idx) {
    while (idx >= 0 && isSkippable(tokens[idx])) idx--;
    return idx;
}

/** Consumes a balanced bracket/paren group starting at an opening token; returns index past the close. */
function consumeBalanced(tokens, openIdx, open, close) {
    let depth = 0;
    let k = openIdx;
    while (k < tokens.length) {
        const t = tokens[k];
        if (t.type === TokenType.Punctuation && t.value === open) depth++;
        else if (t.type === TokenType.Punctuation && t.value === close) {
            depth--;
            if (depth === 0) return k + 1;
        }
        k++;
    }
    return k;
}

/**
 * Finds the start index of the lvalue path ending just before `endIdx` (an identifier-rooted
 * chain of `.member`, `[index]`, `^`). Returns the start token index, or -1.
 */
function lvalueStart(tokens, endIdx) {
    let i = prevMeaningful(tokens, endIdx);
    let start = -1;
    while (i >= 0) {
        const t = tokens[i];
        if (t.type === TokenType.Identifier) {
            start = i;
            const p = prevMeaningful(tokens, i - 1);
            if (tokens[p] && tokens[p].type === TokenType.Punctuation && tokens[p].value === '.') {
                i = prevMeaningful(tokens, p - 1);
                continue;
            }
            break;
        }
        if (t.type === TokenType.Operator && t.value === '^') { i = prevMeaningful(tokens, i - 1); continue; }
        if (t.type === TokenType.Punctuation && t.value === ']') {
            // Walk back to the matching '['.
            let depth = 0;
            while (i >= 0) {
                const v = tokens[i].value;
                if (tokens[i].type === TokenType.Punctuation && v === ']') depth++;
                else if (tokens[i].type === TokenType.Punctuation && v === '[') { depth--; if (depth === 0) { i--; break; } }
                i--;
            }
            i = prevMeaningful(tokens, i);
            continue;
        }
        break;
    }
    return start;
}

/**
 * Phase D — flags assignments whose value type is clearly incompatible with the target type.
 * Conservative: only fires when both sides resolve to known types and the mismatch is a clear
 * category error (e.g. struct/FB/string vs numeric, unrelated structs/enums).
 * @param {Array<Object>} tokens Token stream.
 * @param {Object} symbolIndex Workspace symbol index.
 * @param {string} fileUri Active file URI.
 * @param {Array<Object>} diagnostics Output diagnostics.
 */
function checkAssignments(tokens, symbolIndex, fileUri, diagnostics) {
    let depth = 0;
    for (let j = 0; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.type === TokenType.Punctuation && (t.value === '(' || t.value === '[')) { depth++; continue; }
        if (t.type === TokenType.Punctuation && (t.value === ')' || t.value === ']')) { depth--; continue; }
        if (depth !== 0) continue;
        if (!(t.type === TokenType.Operator && t.value === ':=')) continue;

        const start = lvalueStart(tokens, j - 1);
        if (start === -1) continue;

        // RHS: tokens after ':=' up to the next depth-0 ';'.
        let k = j + 1;
        let d2 = 0;
        const rhs = [];
        while (k < tokens.length) {
            const tk = tokens[k];
            if (tk.type === TokenType.Punctuation && (tk.value === '(' || tk.value === '[')) d2++;
            else if (tk.type === TokenType.Punctuation && (tk.value === ')' || tk.value === ']')) d2--;
            else if (d2 === 0 && tk.type === TokenType.Punctuation && tk.value === ';') break;
            if (!isSkippable(tk)) rhs.push(tk);
            k++;
        }
        if (rhs.length === 0) continue;

        const scope = findActiveScope(symbolIndex, fileUri, t.line);
        const lhsTokens = [];
        for (let q = start; q < j; q++) if (!isSkippable(tokens[q])) lhsTokens.push(tokens[q]);

        const targetType = inferType(lhsTokens, scope, symbolIndex);
        const sourceType = inferType(rhs, scope, symbolIndex);

        let verdict = isAssignable(targetType, sourceType);
        if (verdict === 'related') {
            verdict = isRelatedAssignable(targetType, sourceType, symbolIndex) ? 'ok' : 'incompatible';
        }
        if (verdict === 'incompatible') {
            const lhsTok = tokens[start];
            const endTok = tokens[prevMeaningful(tokens, j - 1)];
            diagnostics.push(createDiagnostic(
                lhsTok.line, lhsTok.col,
                (endTok && endTok.line === lhsTok.line) ? endTok.col + endTok.value.length : lhsTok.col + 1,
                `Type mismatch: cannot assign "${deref(sourceType).name}" to "${deref(targetType).name}".`, 1));
        }
    }
}

/** Walks pointer/reference/array wrappers to the underlying leaf type. */
function leafType(type) {
    let t = type;
    while (t && (t.kind === 'pointer' || t.kind === 'reference' || t.kind === 'array') && t.base) t = t.base;
    return t || UNKNOWN;
}

/**
 * Phase C — flags declarations whose type is not a known builtin, indexed type, or library type.
 * Opt-in (see diagnosticsConfig).
 * @param {Object} activePou The active POU node.
 * @param {Object} symbolIndex Workspace symbol index.
 * @param {Array<Object>} diagnostics Output diagnostics.
 */
function checkDeclarationTypes(activePou, symbolIndex, diagnostics) {
    const checkVar = (v) => {
        if (!v || !v.type) return;
        // An enum's members are not typed declarations — the parser and the XML indexer both mark
        // them with the pseudo-type 'Enum' (see isEnumNode in types.js, which tests the same two
        // fields). There is no type to check, so checking one only invents "Unknown type "Enum"".
        if (v.type === 'Enum' || v.scope === 'ENUM') return;
        const leaf = leafType(parseTypeString(v.type, symbolIndex));
        if (leaf.kind !== 'unknown') return;
        const name = leaf.name;
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return; // qualified/complex — skip
        if (isBuiltin(name)) return;
        // A symbol of an indexed external library (libsymbols.js) is declared — we just cannot see
        // what is behind the name. typeFromNode maps such a node to the deliberately *anonymous*
        // UNKNOWN, so the empty-name test above already covers it; this states the rule where it is
        // enforced, so the check cannot start flagging library types if that convention ever moves.
        const node = findNode(symbolIndex, name);
        if (node && node.external) return;
        const r = v.typeRange || v.range;
        if (!r) return;
        diagnostics.push(createDiagnostic(
            r.startLine, r.startCol, r.endCol > r.startCol ? r.endCol : r.startCol + name.length,
            `Unknown type "${name}".`, 1));
    };
    activePou.variables.forEach(checkVar);
    activePou.methods.forEach(m => m.variables.forEach(checkVar));
}

/**
 * Phase B — validates named arguments in calls (`inst(p := v, o => x)`, `recv.method(p := v)`) and
 * in declaration-site FB initialization lists (`inst : FB_Type(p := v);` inside a VAR block).
 * Only NAMED arguments are checked, and only when the callee's parameter set is known with
 * certainty; positional arguments and unresolved callees are ignored.
 *
 * A '(' inside a VAR…END_VAR block is never a statement call — it is an FB initialization list,
 * whose arguments TwinCAT passes to the FB's FB_init method rather than to the FB's own VAR_INPUT.
 * That case therefore resolves its parameter set through getInitParams, not getCallParams.
 * @param {Array<Object>} tokens Token stream.
 * @param {Object} symbolIndex Workspace symbol index.
 * @param {string} fileUri Active file URI.
 * @param {Array<Object>} diagnostics Output diagnostics.
 */
function checkCallArguments(tokens, symbolIndex, fileUri, diagnostics) {
    let inVarBlock = false;

    for (let j = 0; j < tokens.length; j++) {
        const t = tokens[j];

        // Track declaration blocks: VAR / VAR_INPUT / VAR_GLOBAL / … up to the matching END_VAR.
        if (t.type === TokenType.Keyword) {
            const kw = t.value.toUpperCase();
            if (kw === 'END_VAR') inVarBlock = false;
            else if (kw.startsWith('VAR')) inVarBlock = true;
        }

        if (!(t.type === TokenType.Punctuation && t.value === '(')) continue;

        // Callee identifier is the token immediately before '('.
        const ci = prevMeaningful(tokens, j - 1);
        const calleeTok = tokens[ci];
        if (!calleeTok || calleeTok.type !== TokenType.Identifier) continue;
        if (isBuiltin(calleeTok.value)) continue;

        // Receiver path (for `a.b.method(...)`).
        let receiverType = null;
        const dotIdx = prevMeaningful(tokens, ci - 1);
        const hasReceiver = tokens[dotIdx] && tokens[dotIdx].type === TokenType.Punctuation && tokens[dotIdx].value === '.';

        let params;
        if (inVarBlock) {
            // Declaration-site FB initialization list. A qualified type (`Lib.FB_X(...)`) belongs to
            // an external library whose FB_init we can never see — skip rather than guess.
            if (hasReceiver) continue;
            params = getInitParams(calleeTok.value, symbolIndex);
        } else {
            if (hasReceiver) {
                const parts = [];
                let idx = prevMeaningful(tokens, dotIdx - 1);
                let clean = true;
                while (idx >= 0) {
                    const tt = tokens[idx];
                    if (tt.type !== TokenType.Identifier) { clean = false; break; }
                    parts.unshift(tt.value);
                    const dot = prevMeaningful(tokens, idx - 1);
                    if (tokens[dot] && tokens[dot].type === TokenType.Punctuation && tokens[dot].value === '.') {
                        idx = prevMeaningful(tokens, dot - 1);
                    } else {
                        break;
                    }
                }
                if (!clean || parts.length === 0) continue; // receiver we can't model — skip
                const rScope = findActiveScope(symbolIndex, fileUri, calleeTok.line);
                const resolved = resolvePath(parts, rScope, symbolIndex);
                if (resolved.type.kind === 'unknown') continue;
                receiverType = resolved.type;
            }

            const scope = findActiveScope(symbolIndex, fileUri, calleeTok.line);
            params = getCallParams(receiverType, calleeTok.value, scope, symbolIndex);
        }
        if (!params) continue; // callee/params unknown — don't validate

        // Scan named arguments at the top level of this call's parentheses.
        const close = consumeBalanced(tokens, j, '(', ')');
        let depth = 0;
        for (let k = j; k < close; k++) {
            const tk = tokens[k];
            if (tk.type === TokenType.Punctuation && tk.value === '(') { depth++; continue; }
            if (tk.type === TokenType.Punctuation && tk.value === ')') { depth--; continue; }
            if (depth !== 1) continue;
            if (tk.type !== TokenType.Identifier) continue;

            const prevTk = tokens[prevMeaningful(tokens, k - 1)];
            const atArgStart = prevTk && prevTk.type === TokenType.Punctuation &&
                (prevTk.value === '(' || prevTk.value === ',');
            if (!atArgStart) continue;

            const nextTk = tokens[nextMeaningful(tokens, k + 1)];
            const isNamed = nextTk && nextTk.type === TokenType.Operator &&
                (nextTk.value === ':=' || nextTk.value === '=>');
            if (!isNamed) continue;

            if (!params.has(tk.value.toLowerCase())) {
                const calleeName = receiverType ? deref(receiverType).name + '.' + calleeTok.value : calleeTok.value;
                diagnostics.push(createDiagnostic(
                    tk.line, tk.col, tk.col + tk.value.length,
                    `"${tk.value}" is not a parameter of "${calleeName}".`, 1));
            }
        }
    }
}

/**
 * Phase A — validates dotted member-access chains (a.b.c, ptr^.x, arr[i].field, Enum.Member).
 * Flags a member only when its parent type fully resolves and the member is definitively absent.
 * @param {Array<Object>} tokens Token stream.
 * @param {Object} symbolIndex Workspace symbol index.
 * @param {string} fileUri Active file URI.
 * @param {Array<Object>} diagnostics Output diagnostics.
 */
function checkMemberAccess(tokens, symbolIndex, fileUri, diagnostics) {
    let scope = null;
    let scopeLine = -1;

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.type !== TokenType.Identifier) continue;
        if (isBuiltin(tok.value)) continue;

        // Only start a chain at the head of a path (not at a member after '.').
        const prev = tokens[prevMeaningful(tokens, i - 1)];
        if (prev && prev.type === TokenType.Punctuation && prev.value === '.') continue;

        if (tok.line !== scopeLine) {
            scope = findActiveScope(symbolIndex, fileUri, tok.line);
            scopeLine = tok.line;
        }

        let currentType = resolveSymbolType(tok.value, scope, symbolIndex);
        let j = nextMeaningful(tokens, i + 1);

        while (j < tokens.length) {
            const t = tokens[j];

            if (t.type === TokenType.Punctuation && t.value === '[') {
                j = consumeBalanced(tokens, j, '[', ']');
                const d = deref(currentType);
                currentType = d.kind === 'array' ? (d.base || UNKNOWN) : UNKNOWN;
                j = nextMeaningful(tokens, j);
                continue;
            }
            if (t.type === TokenType.Operator && t.value === '^') {
                currentType = deref(currentType);
                j = nextMeaningful(tokens, j + 1);
                continue;
            }
            if (t.type === TokenType.Punctuation && t.value === '(') {
                // Call on the base/member — we don't model return-type member access.
                j = nextMeaningful(tokens, consumeBalanced(tokens, j, '(', ')'));
                currentType = UNKNOWN;
                continue;
            }
            if (t.type === TokenType.Punctuation && t.value === '.') {
                const m = nextMeaningful(tokens, j + 1);
                const memberTok = tokens[m];
                if (!memberTok || memberTok.type !== TokenType.Identifier) break;

                if (currentType.kind !== 'unknown') {
                    const res = lookupMember(currentType, memberTok.value, symbolIndex);
                    if (res === null) {
                        diagnostics.push(createDiagnostic(
                            memberTok.line, memberTok.col, memberTok.col + memberTok.value.length,
                            `"${memberTok.value}" is not a member of type "${currentType.name}".`, 1));
                        currentType = UNKNOWN;
                    } else if (res === undefined) {
                        currentType = UNKNOWN;
                    } else {
                        currentType = res;
                    }
                }
                j = nextMeaningful(tokens, m + 1);
                continue;
            }
            break;
        }
    }
}

/**
 * Finds all identifier-token occurrences of a word in a code unit (case-insensitive, as ST is).
 * Skips matches inside comments, strings, pragmas, and keywords.
 * @param {string} text Structured Text content.
 * @param {string} word Target identifier.
 * @param {Array<Object>} [preTokens] Token stream of `text`, when the caller already has one.
 * @returns {Array<Object>} LSP ranges (0-based).
 */
function findIdentifierOccurrences(text, word, preTokens) {
    const out = [];
    const lower = word.toLowerCase();
    let toks = preTokens;
    if (!toks) {
        try { toks = tokenize(text); } catch (e) { return out; }
    }
    for (const t of toks) {
        if (t.type === TokenType.Identifier && t.value.toLowerCase() === lower) {
            out.push({
                start: { line: t.line - 1, character: t.col - 1 },
                end: { line: t.line - 1, character: t.col - 1 + t.value.length }
            });
        }
    }
    return out;
}

/**
 * Converted-file cache, keyed by path and invalidated on the file's mtime.
 *
 * Find References walks every indexed document on *every* search, and none of that work was cached:
 * measured on the 152-file sample, one search spent 40.6 ms in readFileSync, 2.5 ms parsing the XML,
 * 3.3 ms converting to ST and 28.3 ms tokenizing — 75 ms, repeated in full for each search, and a
 * single Go to References issues two of them (the peek and the panel). That was the lag.
 *
 * **Only the ST text is cached — deliberately not the tokens.** Caching tokens too made a warm search
 * ~2 ms faster, but measured on the sample it held 19.3 MB of the cache's 22.7 MB, which extrapolates
 * to roughly 150 MB on a 1000-file project: a lot of a language server's memory to buy 2 ms. Text
 * alone is ~1.7 MB per 152 files (~11 MB at 1000), and the files that must still be tokenized on each
 * search are only the few that actually contain the word — the pre-filter in provideReferences drops
 * the rest before they are ever tokenized, which is where most of that 28.3 ms went anyway.
 *
 * The mtime check keeps the semantics identical to reading the file every time — including for a file
 * edited outside VS Code — at the price of one statSync per file, which is far cheaper than the read.
 * @type {Map<string, {mtimeMs: number, stText: string|null}>}
 */
const stFileCache = new Map();

/** Drops the whole converted-file cache (used when the workspace is reindexed). */
function clearStFileCache() {
    stFileCache.clear();
}

/**
 * Returns the Structured Text content for an indexed file, converting from TwinCAT XML when needed
 * and reconverting only when the file has changed on disk.
 * @param {string} fsPath Filesystem path.
 * @returns {string|null} ST text, or null on failure.
 */
function readStForFile(fsPath) {
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(fsPath).mtimeMs;
    } catch (e) {
        stFileCache.delete(fsPath);   // gone from disk
        return null;
    }

    const hit = stFileCache.get(fsPath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.stText;

    let stText = null;
    try {
        const raw = fs.readFileSync(fsPath, 'utf8');
        if (/\.(tcpou|tcgvl|tcdut|tcio)$/i.test(fsPath) || /<TcPlcObject/i.test(raw)) {
            const parsed = parseTwinCatXml(raw);
            stText = parsed ? convertXmlToSt(parsed, { raw: true }).stText : null;
        } else {
            stText = raw;
        }
    } catch (e) {
        stText = null;
    }

    stFileCache.set(fsPath, { mtimeMs, stText });
    return stText;
}

/**
 * Helper to clean type names (strip POINTER TO, REFERENCE TO, ARRAY etc.)
 */
function cleanTypeName(typeStr) {
    if (!typeStr) return '';
    let t = typeStr.trim();
    const assignIdx = t.indexOf(':=');
    if (assignIdx !== -1) {
        t = t.substring(0, assignIdx).trim();
    }
    const ptrMatch = t.match(/(?:POINTER\s+TO|REFERENCE\s+TO)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/i);
    if (ptrMatch) {
        return ptrMatch[1];
    }
    const arrMatch = t.match(/ARRAY\s+\[[^\]]+\]\s+OF\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/i);
    if (arrMatch) {
        return arrMatch[1];
    }
    const cleanMatch = t.match(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*/);
    return cleanMatch ? cleanMatch[0] : t;
}

/**
 * Finds which POU and method/action contains a given line number.
 * @param {Object} symbolIndex 
 * @param {string} fileUri 
 * @param {number} line 1-indexed
 * @returns {Object} { pou, method, action }
 */
function findActiveScope(symbolIndex, fileUri, line) {
    let activePou = null;
    let activeMethod = null;
    let activeAction = null;

    for (const key of Object.keys(symbolIndex)) {
        const pou = symbolIndex[key];
        if (pou.uri === fileUri) {
            activePou = pou;
            
            // Check methods
            for (const method of pou.methods) {
                if (line >= method.declRange.startLine && method.declRange.endLine && line <= method.declRange.endLine) {
                    activeMethod = method;
                    break;
                }
            }

            // Check actions
            for (const action of pou.actions) {
                if (action.implRange && line >= action.nameRange.startLine && line <= action.implRange.endLine) {
                    activeAction = action;
                    break;
                }
            }
            break;
        }
    }

    return { pou: activePou, method: activeMethod, action: activeAction };
}

/**
 * True for the VAR scopes whose members can be passed as named arguments of a call.
 * @param {string} scope Declared scope, e.g. 'VAR_INPUT'.
 * @returns {boolean}
 */
function isCallParamScope(scope) {
    const s = (scope || '').toUpperCase();
    return s === 'VAR_INPUT' || s === 'VAR_OUTPUT' || s === 'VAR_IN_OUT';
}

/**
 * True when `name` denotes an indexed *type* directly rather than a variable in scope — i.e.
 * resolvePathType would fall through to its "direct type match" branch. Used to tell a
 * declaration-site FB initialization (`inst : FB_Type(...)`, the callee is a type name) apart
 * from an ordinary instance call that merely happens to sit behind a colon, such as a CASE
 * label (`1: fbInst(...)`).
 * @param {string} name Identifier to classify.
 * @param {Object} activePou
 * @param {Object} activeMethod
 * @param {Object} symbolIndex
 * @returns {boolean} True if the identifier resolves to a type, not to a variable.
 */
function isBareTypeName(name, activePou, activeMethod, symbolIndex) {
    const lower = name.toLowerCase();
    if (activeMethod && activeMethod.variables.some(v => v.name.toLowerCase() === lower)) return false;
    if (activePou && activePou.variables.some(v => v.name.toLowerCase() === lower)) return false;
    for (const key of Object.keys(symbolIndex)) {
        const node = symbolIndex[key];
        if (node.type === 'GVL' && node.variables.some(v => v.name.toLowerCase() === lower)) return false;
    }
    return Object.keys(symbolIndex).some(k => k.toLowerCase() === lower);
}

/**
 * Resolves the type of a dotted path.
 * @param {Array<string>} parts E.g., ['fbMCPower', 'Enable']
 * @param {Object} activePou
 * @param {Object} activeMethod
 * @param {Object} symbolIndex
 * @returns {string|null} Resolved POU/Struct/Enum type name.
 */
function resolvePathType(parts, activePou, activeMethod, symbolIndex) {
    if (parts.length === 0) return null;
    const firstPart = parts[0].toLowerCase();
    let currentType = null;

    // Check local method variables
    if (activeMethod) {
        const found = activeMethod.variables.find(v => v.name.toLowerCase() === firstPart);
        if (found) currentType = cleanTypeName(found.type);
    }

    // Check parent POU variables — INCLUDING INHERITED ONES.
    //
    // Searching only `activePou.variables` was the single biggest hole in the resolver. In
    // `FB_Indradrive EXTENDS FB_Axis`, the member `stStatus` is declared by the *base*, so the head of
    // `stStatus.stError.bError` resolved to nothing, the whole chain died, and Find References — which
    // keeps every occurrence it cannot resolve — then attached that line to any `bError` anywhere in
    // the workspace. Measured on the sample before this: 9,801 of 29,803 reported references (33%)
    // were kept purely because they failed to resolve.
    if (!currentType && activePou) {
        const found = findVarInChain(activePou, firstPart, symbolIndex);
        if (found) currentType = cleanTypeName(found.type);
    }

    // Check GVL globals
    if (!currentType) {
        for (const key of Object.keys(symbolIndex)) {
            const node = symbolIndex[key];
            if (node.type === 'GVL') {
                const found = node.variables.find(v => v.name.toLowerCase() === firstPart);
                if (found) {
                    currentType = cleanTypeName(found.type);
                    break;
                }
            }
        }
    }

    // Direct type match
    if (!currentType) {
        const foundKey = Object.keys(symbolIndex).find(k => k.toLowerCase() === firstPart);
        if (foundKey) {
            currentType = foundKey;
        }
    }

    if (!currentType) return null;

    // Follow dot parts
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i].toLowerCase();
        // findNode, not symbolIndex[currentType]: `currentType` is spelled the way the *declaration*
        // spells it (`ipDut : I_Dut`), which ST — being case-insensitive — lets differ from the way
        // the POU spells its own name (`INTERFACE I_DUT`). An exact-key lookup silently misses those.
        const typeNode = findNode(symbolIndex, currentType);
        if (!typeNode) return null;

        // Inherited again: a struct EXTENDS a base struct (`ST_AxisErrors EXTENDS ST_Errors`) and an
        // FB extends an FB, so a hop must search the ancestors too, not just the node itself.
        const member = findVarInChain(typeNode, part, symbolIndex);
        if (member) {
            currentType = cleanTypeName(member.type);
        } else {
            return null; // failed to resolve member
        }
    }

    return currentType;
}

/**
 * A TYPED member — variable or property — of a node or of anything it EXTENDS. `findMemberInChain`
 * answers *where* a member is declared (a definition); this answers *what type it has*, which is what
 * a path resolver needs in order to take the next hop.
 *
 * Properties are included because they are typed members and chains run straight through them:
 * `ipAxis.ST_Status.bError`, where `PROPERTY ST_Status : REFERENCE TO ST_AxisStatusParameters`. Looking
 * only at `variables` stopped the chain dead at the property, and every such occurrence then fell into
 * the "kept because unresolved" bucket in Find References.
 *
 * @param {Object} node A POU/DUT/interface node.
 * @param {string} name Member name (any case — ST is case-insensitive).
 * @param {Object} index The workspace symbol index.
 * @returns {Object|null} The declaration ({ name, type, … }), or null.
 */
function findVarInChain(node, name, index) {
    if (!node) return null;
    const lower = String(name).toLowerCase();
    const { ancestors } = walkExtendsChain(node, index);
    for (const owner of [node, ...ancestors]) {
        if (!owner || owner.external) continue;
        const v = (owner.variables || []).find(x => x.name.toLowerCase() === lower);
        if (v) return v;
        const p = (owner.properties || []).find(x => x.name.toLowerCase() === lower);
        if (p && p.type) return p;
    }
    return null;
}

/**
 * Classifies the call site whose parentheses enclose a token, by scanning left from `fromIdx`.
 *
 * The three shapes look alike but bind their named arguments to *different* declarations, so any
 * caller that wants to resolve an argument name must first know which one it is looking at:
 *   `inst : FB_Type( p := v )`      'declInitList'   — arguments of the FB's FB_init METHOD, i.e.
 *                                                      FB_init's VAR_INPUT (FB_init may be inherited).
 *   `inst : FB_Type := ( p := v )`  'structuredInit' — the FB's OWN VAR_INPUT.
 *   `fbInst( p := v )`              'call'           — an ordinary call on an instance or method.
 *
 * Shared by provideDefinition and provideCompletions so the two can never drift apart.
 * @param {Array<Object>} tokens Token stream.
 * @param {number} fromIdx Index to scan left from (inclusive) — a token known to sit inside the
 *        call's parentheses, or the '(' itself.
 * @param {Object} pou Active POU node (may be null).
 * @param {Object} method Active method node (may be null).
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {{kind: string, pathParts: Array<string>, openIdx: number}|null} null when `fromIdx` is
 *          not inside a call's parentheses, or the callee is not an identifier path.
 */
function classifyCallSite(tokens, fromIdx, pou, method, symbolIndex) {
    // The '(' that encloses fromIdx — balanced groups on the way left are skipped over.
    let parenDepth = 0;
    let openIdx = -1;
    for (let i = fromIdx; i >= 0; i--) {
        const tok = tokens[i];
        if (tok.type !== TokenType.Punctuation) continue;
        if (tok.value === ')') {
            parenDepth++;
        } else if (tok.value === '(') {
            parenDepth--;
            if (parenDepth < 0) { openIdx = i; break; }
        }
    }
    if (openIdx === -1) return null;

    // Callee path immediately left of the '('. A ':=' in between marks structured initialization,
    // whose arguments target the FB's own inputs rather than FB_init's parameters.
    let isStructuredInit = false;
    let pathIdx = prevMeaningful(tokens, openIdx - 1);
    if (pathIdx >= 0 && tokens[pathIdx].type === TokenType.Operator && tokens[pathIdx].value === ':=') {
        isStructuredInit = true;
        pathIdx = prevMeaningful(tokens, pathIdx - 1);
    }

    const pathParts = [];
    let pathStartIdx = -1;
    while (pathIdx >= 0 && tokens[pathIdx].type === TokenType.Identifier) {
        pathParts.unshift(tokens[pathIdx].value);
        pathStartIdx = pathIdx;
        const dotIdx = prevMeaningful(tokens, pathIdx - 1);
        if (dotIdx >= 0 && tokens[dotIdx].type === TokenType.Punctuation && tokens[dotIdx].value === '.') {
            pathIdx = prevMeaningful(tokens, dotIdx - 1);
        } else {
            break;
        }
    }
    if (pathParts.length === 0) return null;

    // Declaration-site FB_init list: a bare *type* name preceded by ':', with no ':=' in between.
    // Requiring a type name (not an instance) is what keeps a CASE label followed by an instance
    // call — `1: fbInst(p := v);` — out of this branch.
    let kind = isStructuredInit ? 'structuredInit' : 'call';
    if (!isStructuredInit && pathParts.length === 1 && pathStartIdx > 0) {
        const prev = prevMeaningful(tokens, pathStartIdx - 1);
        if (prev >= 0 && tokens[prev].type === TokenType.Punctuation && tokens[prev].value === ':'
            && isBareTypeName(pathParts[0], pou, method, symbolIndex)) {
            kind = 'declInitList';
        }
    }

    return { kind, pathParts, openIdx };
}

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
 * @param {function(string): boolean} scopeOk Predicate on a variable's declared VAR scope.
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
 * True when the ':' at `colonIdx` introduces a header's type — `METHOD m : ▮`, `FUNCTION f : ▮`,
 * `PROPERTY p : ▮`, `TYPE t : ▮` — as opposed to a CASE/jump label's ':' in a body.
 * @param {Array<Object>} tokens Token stream.
 * @param {number} colonIdx Index of the ':' token.
 * @returns {boolean}
 */
function isHeaderColon(tokens, colonIdx) {
    const nameIdx = prevMeaningful(tokens, colonIdx - 1);
    if (nameIdx < 0 || tokens[nameIdx].type !== TokenType.Identifier) return false;
    const kwIdx = prevMeaningful(tokens, nameIdx - 1);
    if (kwIdx < 0 || tokens[kwIdx].type !== TokenType.Keyword) return false;
    return TYPED_HEADER_KEYWORDS.has(tokens[kwIdx].value.toUpperCase());
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
 */
function pushLibraryNamespaces(out) {
    const spelled = getLibraryNamespaceNames();
    const names = spelled.length ? spelled : getLibraryNamespaces();
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
    pushLibraryNamespaces(out);
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
 * name, so `Tc2_MC2.▮` is a long mix of both (2,145 names in the sample). The `.tmc` *can* — it names
 * 57 of them as real Tc2_MC2 types — so those are marked with their true kind (Struct / Enum /
 * Function Block) and sorted to the top. The rest stay: the `.tmc` only exports what the project
 * already uses, so dropping everything it does not mention would hide every library type the project
 * has not adopted *yet*, which is precisely what a user reaches for at a fresh caret.
 * @param {string} namespace The head of the dotted path under the caret.
 * @returns {Array<Object>} Completion items (possibly empty).
 */
function libraryNamespaceMembers(namespace) {
    const spelled = getLibraryNamespaceNames().find(n => n.toLowerCase() === namespace.toLowerCase());
    const label = spelled || namespace;

    // The .tmc's real types for this namespace, keyed for an O(1) test per candidate name.
    const known = new Map();
    getTypeSystemNamespaceTypes(namespace).forEach(t => known.set(t.name.toLowerCase(), t));

    const items = [];
    for (const name of getNamespaceSymbols(namespace)) {
        if (STANDARD_TYPES.has(name.toUpperCase())) continue;
        const type = known.get(name.toLowerCase());
        const shape = type ? LIB_KIND_ITEM[type.kind] : null;
        if (shape) {
            items.push({
                label: name,
                kind: shape.kind,
                detail: `${shape.label} (${label})`,
                sortText: LIB_TYPE_SORT_PREFIX + name
            });
        } else {
            items.push({
                label: name,
                kind: 7, // Class — a library symbol is a bare name; what is behind it is not indexed.
                detail: `Library Symbol (${label})`
            });
        }
    }
    return items;
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
        // below, so a namespace can never be mistaken for a same-named type. Only a single-part head
        // is answered: a deeper path (`VisuElems.VisuElemBase.▮`) walks into a nested namespace we do
        // not index, and inventing members for it is exactly the noise this must not produce.
        if (parts.length === 1) {
            const libItems = libraryNamespaceMembers(parts[0]);
            if (libItems.length > 0) return libItems;
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
            if (selected) {
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
            const targetEnum = (targetType && targetType.kind === 'enum')
                ? findNode(symbolIndex, targetType.name) : null;
            pushEnumMembers(suggestions, symbolIndex, targetEnum);
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

/**
 * Provides Go to Definition.
 * @param {string} code
 * @param {Object} position { line, character } 0-indexed
 * @param {Object} symbolIndex
 * @param {string} fileUri
 * @returns {Object|null} LSP Location
 */
function provideDefinition(code, position, symbolIndex, fileUri) {
    let tokens;
    try { tokens = tokenize(code); } catch (e) { return null; }
    return definitionAt(code, tokens, position, symbolIndex, fileUri);
}

/**
 * Resolves the declaration the identifier at `position` refers to — the body of provideDefinition,
 * split out so a caller that already holds the token stream can resolve many positions in one
 * document without re-tokenizing it. provideReferences does exactly that: it asks this for *every*
 * occurrence of the word, and keeps only the ones that answer with the same declaration.
 * @param {string} code Document text.
 * @param {Array<Object>} tokens Token stream of `code` (tokenize()'d once by the caller).
 * @param {Object} position { line, character } 0-indexed.
 * @param {Object} symbolIndex Workspace symbol index.
 * @param {string} fileUri Document URI.
 * @returns {Object|null} { uri, range, componentId, targetWord }, or null when unresolvable.
 */
function definitionAt(code, tokens, position, symbolIndex, fileUri) {
    const lines = code.split('\n');
    const lineIndex = position.line;
    const lineText = lines[lineIndex] || '';

    // Find the word at the cursor
    const col = position.character;
    let start = col;
    while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1])) {
        start--;
    }
    let end = col;
    while (end < lineText.length && /[a-zA-Z0-9_]/.test(lineText[end])) {
        end++;
    }
    const targetWord = lineText.substring(start, end);
    if (!targetWord) return null;

    const { pou, method } = findActiveScope(symbolIndex, fileUri, lineIndex + 1);

    // 1. Parameter list call validation: fbMyPower(bEnable := TRUE)
    const targetTokenIdx = tokens.findIndex(t =>
        t.line === lineIndex + 1 && 
        col >= t.col - 1 && 
        col < (t.col - 1) + t.value.length
    );

    if (targetTokenIdx !== -1 && tokens[targetTokenIdx].type === TokenType.Identifier) {
        const targetTok = tokens[targetTokenIdx];
        const targetWordVal = targetTok.value;

        // Shape of the call site enclosing the target word. The three forms bind their named
        // arguments to different declarations — see classifyCallSite, which provideCompletions
        // shares so that both features agree on what the parentheses mean.
        const site = classifyCallSite(tokens, targetTokenIdx - 1, pou, method, symbolIndex);
        const pathParts = site ? site.pathParts : [];
        const isDeclInitList = !!site && site.kind === 'declInitList';

        if (site) {
            let resolvedTargetNode = null;
            let resolvedMethod = null;

            // An *external* node is never a jump target: a library node carries no uri and no range
            // (libsymbols.js), and the webview resolves an empty uri against the *active* file — so
            // answering with one lands the user on an arbitrary local line. Its members are real now
            // (the `.tmc` describes them), which is exactly why the guard has to be explicit: before,
            // an empty member list made the lookup fail by accident.
            if (pathParts.length === 1) {
                const instName = pathParts[0];
                const instType = resolvePathType([instName], pou, method, symbolIndex);
                const instNode = instType ? findNode(symbolIndex, instType) : null;
                if (instNode && !instNode.external) {
                    resolvedTargetNode = instNode;
                }
            } else if (pathParts.length > 1) {
                const prefix = pathParts.slice(0, -1);
                const lastPart = pathParts[pathParts.length - 1].toLowerCase();
                const parentType = resolvePathType(prefix, pou, method, symbolIndex);
                const parentNode = parentType ? findNode(symbolIndex, parentType) : null;
                if (parentNode && !parentNode.external) {
                    const matchedMethod = parentNode.methods.find(m => m.name.toLowerCase() === lastPart);
                    if (matchedMethod) {
                        resolvedMethod = matchedMethod;
                        resolvedTargetNode = parentNode;
                    }
                }
            }

            // `inst : FB_Type( ipAxis := x )` — the named arguments are FB_init's parameters, so resolve
            // them against FB_init and not against the FB's own members (an FB may legitimately declare
            // both, e.g. `VAR ipAxis` plus an FB_init `VAR_INPUT ipAxis`). FB_init can be inherited, so
            // navigate to the node that actually declares it.
            if (isDeclInitList && resolvedTargetNode && resolvedTargetNode.type === 'FUNCTION_BLOCK') {
                const found = findMethodOwnerInChain(resolvedTargetNode, 'FB_init', symbolIndex);
                if (found) {
                    const p = (found.method.variables || []).find(x =>
                        x.name.toLowerCase() === targetWordVal.toLowerCase() && isCallParamScope(x.scope));
                    if (p) {
                        return {
                            uri: found.owner.uri,
                            range: convertToLspRange(p.range),
                            componentId: `method_${found.method.name}`,
                            targetWord: targetWordVal
                        };
                    }
                }
                // Not an FB_init parameter (or FB_init/the chain is unresolvable) — fall through to the
                // FB's own members rather than inventing a target.
            }

            if (resolvedMethod && resolvedTargetNode) {
                const v = resolvedMethod.variables.find(x => x.name.toLowerCase() === targetWordVal.toLowerCase());
                if (v) {
                    return {
                        uri: resolvedTargetNode.uri,
                        range: convertToLspRange(v.range),
                        componentId: `method_${resolvedMethod.name}`,
                        targetWord: targetWordVal
                    };
                }
            }

            if (resolvedTargetNode) {
                let currentTarget = resolvedTargetNode;
                while (currentTarget) {
                    const v = currentTarget.variables.find(x => x.name.toLowerCase() === targetWordVal.toLowerCase());
                    if (v) {
                        return { 
                            uri: currentTarget.uri, 
                            range: convertToLspRange(v.range),
                            componentId: 'root',
                            targetWord: targetWordVal
                        };
                    }
                    const base = currentTarget.extends ? findNode(symbolIndex, currentTarget.extends) : null;
                    if (base) {
                        currentTarget = base;
                    } else {
                        break;
                    }
                }
            }
        }
    }

    // 2. Check if part of a dotted path
    const leftText = lineText.substring(0, end);
    const dotMatch = leftText.match(/([a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?)*)$/);

    if (dotMatch) {
        const fullPath = dotMatch[1].replace(/\[[^\]]+\]/g, ''); // strip array indexes
        const parts = fullPath.split('.');
        const lastPart = parts[parts.length - 1];

        const cursorPartIndex = fullPath.substring(0, col - start + fullPath.length - lastPart.length).split('.').length - 1;
        const queryParts = parts.slice(0, cursorPartIndex + 1);
        const resolvedWord = queryParts[queryParts.length - 1];

        if (queryParts.length > 1) {
            const parentParts = queryParts.slice(0, queryParts.length - 1);
            const parentType = resolvePathType(parentParts, pou, method, symbolIndex);

            // External nodes are excluded for the same reason as in the call-site branch above: a
            // library member has no location, so a jump to it would be a jump to the wrong file.
            const parentNode = parentType ? findNode(symbolIndex, parentType) : null;
            if (parentNode && !parentNode.external) {
                // The member may be inherited — `ipAxis.Cyclic()` on an `I_IndraDrive` whose Cyclic
                // is declared by the `I_Axis` it EXTENDS. Searching only the node itself made that
                // ctrl-click resolve to nothing, exactly as the bare-identifier path used to (4b).
                const found = findMemberInChain(parentNode, resolvedWord, symbolIndex);
                if (found) return { ...found, targetWord: resolvedWord };
            }
        }
    }

    const wordLower = targetWord.toLowerCase();

    // 3. Local method variables
    if (method) {
        const v = method.variables.find(x => x.name.toLowerCase() === wordLower);
        if (v) return { uri: fileUri, range: convertToLspRange(v.range), componentId: `method_${method.name}`, targetWord: targetWord };
    }

    // 4. Parent POU variables or sub-elements
    if (pou) {
        const v = pou.variables.find(x => x.name.toLowerCase() === wordLower);
        if (v) return { uri: fileUri, range: convertToLspRange(v.range), componentId: 'root', targetWord: targetWord };

        const m = pou.methods.find(x => x.name.toLowerCase() === wordLower);
        if (m) return { uri: fileUri, range: convertToLspRange(m.nameRange), componentId: `method_${m.name}`, targetWord: targetWord };

        const p = pou.properties.find(x => x.name.toLowerCase() === wordLower);
        if (p) return { uri: fileUri, range: convertToLspRange(p.nameRange), componentId: `prop_${p.name}`, targetWord: targetWord };

        const a = pou.actions.find(x => x.name.toLowerCase() === wordLower);
        if (a) return { uri: fileUri, range: convertToLspRange(a.nameRange), componentId: `action_${a.name}`, targetWord: targetWord };

        // 4b. Inherited members via the EXTENDS chain (bare usage, no fb. prefix).
        // Walk ancestors resolved from the index; stop where the chain breaks.
        const { ancestors } = walkExtendsChain(pou, symbolIndex);
        for (const anc of ancestors) {
            const av = anc.variables.find(x => x.name.toLowerCase() === wordLower);
            if (av) return { uri: anc.uri, range: convertToLspRange(av.range), componentId: 'root', targetWord: targetWord };

            const am = (anc.methods || []).find(x => x.name.toLowerCase() === wordLower);
            if (am) return { uri: anc.uri, range: convertToLspRange(am.nameRange), componentId: `method_${am.name}`, targetWord: targetWord };

            const ap = (anc.properties || []).find(x => x.name.toLowerCase() === wordLower);
            if (ap) return { uri: anc.uri, range: convertToLspRange(ap.nameRange), componentId: `prop_${ap.name}`, targetWord: targetWord };

            const aa = (anc.actions || []).find(x => x.name.toLowerCase() === wordLower);
            if (aa) return { uri: anc.uri, range: convertToLspRange(aa.nameRange), componentId: `action_${aa.name}`, targetWord: targetWord };
        }
    }

    // 5. Global POU / GVL definitions.
    // An *external* match is skipped, not answered: a library symbol (libsymbols.js) is in the index
    // by name only — no uri, no range. Answering with it hands the webview an empty uri, which the
    // webview resolves against the *active* file, so a ctrl-click on a library type would jump to an
    // arbitrary local line. Skipping lets step 6 still find a real symbol of the same name, and
    // failing that the function returns null — no definition, rather than a wrong one.
    const matchedKey = Object.keys(symbolIndex).find(k => k.toLowerCase() === wordLower);
    if (matchedKey && !symbolIndex[matchedKey].external) {
        const node = symbolIndex[matchedKey];
        return { uri: node.uri, range: convertToLspRange(node.nameRange), componentId: 'root', targetWord: targetWord };
    }

    // 6. Global variables inside any GVL
    for (const key of Object.keys(symbolIndex)) {
        const node = symbolIndex[key];
        if (node.type === 'GVL') {
            const v = node.variables.find(x => x.name.toLowerCase() === wordLower);
            if (v) return { uri: node.uri, range: convertToLspRange(v.range), componentId: 'root', targetWord: targetWord };
        }
    }

    return null;
}

/** Identity of a declaration: the file it lives in plus where in that file it starts. */
function defKey(def) {
    return `${normalizeUri(def.uri)}#${def.range.start.line}:${def.range.start.character}`;
}

/**
 * Describes a resolved definition: which POU owns it, and — when the definition *is* one of that
 * POU's declared members — the member's name.
 *
 * The member distinction is what licenses the inheritance relaxation in sameSymbol(): an override
 * and the method it overrides are two declarations that a reader thinks of as one symbol, but two
 * method-local variables that merely share a name are not, even in related POUs.
 * @param {Object} def A definition from definitionAt().
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {{key: string, owner: Object|null, memberName: string|null}}
 */
function describeDef(def, symbolIndex) {
    const scope = findActiveScope(symbolIndex, def.uri, def.range.start.line + 1);
    const owner = scope.pou;
    let memberName = null;

    // A variable declared inside a METHOD belongs to that method, not to the POU. This matters most
    // for the method's PARAMETERS: FB_Axis declares a `bDone` VAR_OUTPUT in Halt, in Stop, in
    // SwitchOff… and they are all different symbols. Without the method in the identity they compare
    // equal, and asking for one lists every one of them — plus every `bDone` in every FB that has a
    // method of the same shape. The method name (not the node) is what is compared, so that an
    // override in a derived FB — FB_Indradrive.Halt over FB_Axis.Halt — still counts as the same
    // symbol, which it is.
    if (scope.method) {
        const own = (scope.method.variables || []).find(v => {
            const r = convertToLspRange(v.range);
            return r.start.line === def.range.start.line && r.start.character === def.range.start.character;
        });
        if (own) {
            return { key: defKey(def), owner, methodName: scope.method.name, memberName: own.name };
        }
    }

    if (owner) {
        const startsAt = (range) => {
            const r = convertToLspRange(range);
            return r.start.line === def.range.start.line && r.start.character === def.range.start.character;
        };
        const v = (owner.variables || []).find(x => startsAt(x.range));
        const m = !v && (owner.methods || []).find(x => startsAt(x.nameRange));
        const p = !v && !m && (owner.properties || []).find(x => startsAt(x.nameRange));
        const a = !v && !m && !p && (owner.actions || []).find(x => startsAt(x.nameRange));
        const decl = v || m || p || a;
        if (decl) memberName = decl.name;
    }

    return { key: defKey(def), owner, memberName };
}

/** The POU's own name plus every ancestor reachable through EXTENDS or IMPLEMENTS. Cycle-safe. */
function inheritanceFamily(node, index) {
    const names = new Set();
    const queue = [node];
    while (queue.length) {
        const cur = queue.shift();
        if (!cur || !cur.name) continue;
        const key = cur.name.toLowerCase();
        if (names.has(key)) continue;
        names.add(key);
        for (const parent of [cur.extends, ...(cur.implements || [])]) {
            if (!parent) continue;
            const n = findNode(index, parent);
            if (n) queue.push(n);
        }
    }
    return names;
}

/** True when one POU derives from the other (either direction), or they are the same POU. */
function pousRelated(a, b, index) {
    if (!a || !b) return false;
    if (a.name.toLowerCase() === b.name.toLowerCase()) return true;
    return inheritanceFamily(a, index).has(b.name.toLowerCase())
        || inheritanceFamily(b, index).has(a.name.toLowerCase());
}

/**
 * Decides whether an occurrence of the word denotes the same symbol as the one under the cursor.
 *
 * The rule is definition identity: `FB_A.Cyclic` and `FB_B.Cyclic` are different symbols because
 * they resolve to different declarations, however alike they read. The two relaxations:
 *
 *   - **Unresolvable ⇒ keep.** If either side cannot be resolved to a declaration (a library symbol,
 *     an undeclared identifier, a chain through a type we have no members for), we have not *proved*
 *     it is a different symbol, so it stays. A missing reference is a worse failure than a spurious
 *     one — the same conservatism the diagnostics are built on, pointed the other way.
 *   - **Overrides and interface implementations are one symbol.** `FB_Derived.Cyclic` overriding
 *     `FB_Base.Cyclic`, or implementing `I_Foo.Cyclic`, is what the reader is looking for when they
 *     ask for references of either — a call through the base dispatches to the override. So a member
 *     of the same name on a POU related by EXTENDS/IMPLEMENTS counts as a hit.
 * @param {Object|null} target describeDef() of the symbol under the cursor; null ⇒ keep everything.
 * @param {Object|null} def The occurrence's resolved definition; null ⇒ keep it.
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {boolean}
 */
function sameSymbol(target, def, symbolIndex) {
    if (!target || !def) return true;
    if (defKey(def) === target.key) return true;

    const occ = describeDef(def, symbolIndex);
    const sameName = !!target.memberName && !!occ.memberName
        && target.memberName.toLowerCase() === occ.memberName.toLowerCase();
    if (!sameName || !pousRelated(target.owner, occ.owner, symbolIndex)) return false;

    // If either side is a variable of a METHOD, both must be — and of the SAME method. FB_Axis
    // declares a `bDone` VAR_OUTPUT in Halt and another in Stop; they share a name and an owning POU
    // but they are two symbols. An override counts as the same method (compared by name), so
    // FB_Indradrive.Halt's `bDone` still matches FB_Axis.Halt's.
    if (target.methodName || occ.methodName) {
        return !!target.methodName && !!occ.methodName
            && target.methodName.toLowerCase() === occ.methodName.toLowerCase();
    }
    return true;
}

/**
 * The method a definition is a PRIVATE local variable of, if it is one.
 *
 * A variable declared in a METHOD's plain `VAR` block exists only inside that method — nothing in
 * another method, POU or file can name it. That is a hard scope rule, and it matters because
 * `sameSymbol` deliberately KEEPS any occurrence whose own definition cannot be resolved (a library
 * symbol, a builtin). That fallback is right in general, but for a method-local target it leaked every
 * unresolvable same-named identifier in the workspace into the results: asking for references of
 * `bDone` inside `FB_Axis.Initialize` listed `bDone`s from completely unrelated code, purely because
 * the resolver could not place them.
 *
 * **`VAR_INPUT` / `VAR_OUTPUT` / `VAR_IN_OUT` are NOT private.** They are the method's *parameters*, so
 * they are named from outside at every call site (`fbAxis.MoveAbsolute(fVelocity := 5)`), often in
 * other files. Confining those to the method body would silently *hide* real references — trading a
 * noisy answer for a wrong one. Only the non-parameter scopes are confined here.
 *
 * @param {Object} def A definition ({ uri, range }).
 * @param {Object} symbolIndex The workspace symbol index.
 * @returns {Object|null} The declaring method, or null if the definition is not private to a method.
 */
function methodLocalScope(def, symbolIndex) {
    if (!def) return null;
    const scope = findActiveScope(symbolIndex, def.uri, def.range.start.line + 1);
    const method = scope && scope.method;
    if (!method || !method.declRange) return null;

    // It must be one of the method's OWN declared variables — not a POU member merely *used* here. An
    // FB's members are reachable from outside through an instance (`fbAxis.bDone`), so they are never
    // confined this way.
    const own = (method.variables || []).find(v => {
        const r = convertToLspRange(v.range);
        return r.start.line === def.range.start.line && r.start.character === def.range.start.character;
    });
    if (!own || isCallParamScope(own.scope)) return null;
    return method;
}

/**
 * True when a definition is declared inside a METHOD at all — any scope, parameters included.
 * @param {Object} def A definition ({ uri, range }).
 * @param {Object} symbolIndex The workspace symbol index.
 * @returns {boolean}
 */
function isMethodScoped(def, symbolIndex) {
    if (!def) return false;
    const scope = findActiveScope(symbolIndex, def.uri, def.range.start.line + 1);
    const method = scope && scope.method;
    if (!method) return false;
    return (method.variables || []).some(v => {
        const r = convertToLspRange(v.range);
        return r.start.line === def.range.start.line && r.start.character === def.range.start.character;
    });
}

/**
 * The callee of a NAMED ARGUMENT occurrence — the `x.y` in `x.y(name := v)` / `x.y(name => v)`.
 *
 * A named argument names the CALLEE's parameter, never the caller's own variable. `Halt`'s `bDone`
 * VAR_OUTPUT and the `bDone` in `SoEReset(tTimeout := …, bDone => bStepDone)` are different symbols:
 * the second belongs to SoEReset. definitionAt cannot say so — the callee is usually a library FB, and
 * it declines on external nodes because they have no location to jump to — so the occurrence came back
 * unresolved and the "keep what I cannot resolve" fallback attached it to whatever `bDone` had been
 * asked about. That is what listed the same `bDone` across six files.
 *
 * @param {Array<Object>} tokens The document's token stream.
 * @param {number} tokIdx Index of the occurrence's token.
 * @param {Object} pou Enclosing POU.
 * @param {Object} method Enclosing method.
 * @param {Object} symbolIndex Workspace symbol index.
 * @returns {Array<string>|null} The callee's dotted path, or null when this is not a named argument.
 */
function namedArgumentCallee(tokens, tokIdx, pou, method, symbolIndex) {
    let j = tokIdx + 1;
    while (j < tokens.length && isSkippable(tokens[j])) j++;
    const next = tokens[j] && tokens[j].value;
    if (next !== ':=' && next !== '=>') return null;   // an assignment statement, not an argument

    const site = classifyCallSite(tokens, tokIdx, pou, method, symbolIndex);
    if (!site || !site.pathParts || !site.pathParts.length) return null;   // not inside a call at all
    return site.pathParts;
}

/**
 * True when an occurrence is a qualified member access — something like `x.name` or `arr[i].name`.
 * Whitespace and newlines may sit between the dot and the name, so scan back over them.
 * @param {string} text The document.
 * @param {Object} range The occurrence range ({ start: { line, character } }).
 * @returns {boolean}
 */
function isQualifiedOccurrence(text, range) {
    const line = text.split('\n')[range.start.line] || '';
    let i = range.start.character - 1;
    while (i >= 0 && /\s/.test(line[i])) i--;
    return i >= 0 && line[i] === '.';
}

/**
 * For a qualified occurrence `a.b.NAME`, the TYPE that owns NAME — i.e. what `a.b` resolves to.
 *
 * This is what decides whether `x.bDone` is *our* `bDone`. Relying on definitionAt instead was the
 * flaw: it declines to answer for external (library) nodes on purpose — a library member has no
 * location to jump to — so `fbSetSlaveState.tTimeout` came back unresolved and was then *kept*, as a
 * reference to whatever `tTimeout` the user had asked about. Resolving the base type answers the
 * question that actually matters (whose member is this?) even when there is nowhere to jump to.
 *
 * @param {string} text The document.
 * @param {Object} range The occurrence range.
 * @param {Object} symbolIndex The workspace symbol index.
 * @param {string} uri The document's uri.
 * @returns {string|null} The owning type's name, or null if the base cannot be resolved.
 */
function qualifiedBaseType(text, range, symbolIndex, uri) {
    const lineText = (text.split('\n')[range.start.line] || '').slice(0, range.start.character);
    const m = lineText.match(/([a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]*\])?(?:\s*\.\s*[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]*\])?)*)\s*\.\s*$/);
    if (!m) return null;

    const parts = m[1].replace(/\[[^\]]*\]/g, '').split('.').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return null;

    const scope = findActiveScope(symbolIndex, uri, range.start.line + 1);
    return resolvePathType(parts, scope.pou, scope.method, symbolIndex);
}

/**
 * Provides Find References.
 *
 * A word match is not a symbol match. Two FBs that each declare a `Cyclic` method share nothing but
 * the spelling, so every occurrence is resolved to the declaration it actually refers to — via the
 * same resolver Go to Definition uses — and only occurrences that land on the cursor's own
 * declaration are reported. See sameSymbol() for the two cases that are deliberately kept anyway.
 * @param {string} code
 * @param {Object} position { line, character }
 * @param {Object} symbolIndex
 * @param {string} fileUri
 * @returns {Array<Object>} LSP Locations
 */
function provideReferences(code, position, symbolIndex, fileUri) {
    const lines = code.split('\n');
    const lineIndex = position.line;
    const lineText = lines[lineIndex] || '';

    // Find the word at the cursor
    const col = position.character;
    let start = col;
    while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1])) {
        start--;
    }
    let end = col;
    while (end < lineText.length && /[a-zA-Z0-9_]/.test(lineText[end])) {
        end++;
    }
    const targetWord = lineText.substring(start, end);
    if (!targetWord) return [];

    let tokens = null;
    try { tokens = tokenize(code); } catch (e) { /* fall back to the plain text scan */ }

    // What the cursor is actually on. When this cannot be resolved (a library symbol, a builtin),
    // `target` stays null and every occurrence is reported — the old, purely textual behaviour.
    const targetDef = tokens ? definitionAt(code, tokens, position, symbolIndex, fileUri) : null;
    const target = targetDef ? describeDef(targetDef, symbolIndex) : null;

    const references = [];
    const visitedUris = new Set();

    // A method-local variable cannot be named outside its method, so the search stops there: the whole
    // workspace pass below is not just wasted, it is what produced the wrong answers (see
    // methodLocalScope). declRange is 1-based; ranges here are 0-based.
    const localTo = methodLocalScope(targetDef, symbolIndex);
    if (localTo) {
        const first = localTo.declRange.startLine - 1;
        const last = (localTo.declRange.endLine || Number.MAX_SAFE_INTEGER) - 1;
        for (const range of findIdentifierOccurrences(code, targetWord, tokens)) {
            if (range.start.line >= first && range.start.line <= last) {
                references.push({ uri: fileUri, range });
            }
        }
        return references;
    }

    // A variable declared inside a METHOD — parameters included — is never reached through a dot.
    // `fbSetSlaveState.tTimeout` is some other type's member; `stParams.eBufferMode` is a struct field.
    // Both used to be reported as references to a method's own `tTimeout` / `eBufferMode`, because the
    // resolver could not place them (the base is often a library type, which has no location by design)
    // and unresolvable occurrences are kept. This needs no resolution: it is syntax.
    //
    // Method PARAMETERS are still searched workspace-wide, because a call site names them —
    // `fbAxis.MoveAbsolute(fVelocity := 5)` — but always after a `(` or a `,`, never after a `.`.
    const targetInMethod = isMethodScoped(targetDef, symbolIndex);

    /** Keeps the occurrences of `targetWord` in one document that refer to the cursor's symbol. */
    const collect = (text, docTokens, uri) => {
        for (const range of findIdentifierOccurrences(text, targetWord, docTokens)) {
            // A named argument belongs to the CALLEE, so it is only our symbol if the callee is the
            // method (or the FB) that declares it.
            if (target && docTokens) {
                const tokIdx = docTokens.findIndex(t =>
                    t.line === range.start.line + 1 && t.col - 1 === range.start.character);
                if (tokIdx !== -1) {
                    const scope = findActiveScope(symbolIndex, uri, range.start.line + 1);
                    const callee = namedArgumentCallee(docTokens, tokIdx, scope.pou, scope.method, symbolIndex);
                    if (callee && callee.length) {
                        const calleeName = callee[callee.length - 1];
                        if (target.methodName) {
                            // The target is a method's parameter: only a call to THAT method names it.
                            // `fbAxis.Halt(bDone => x)` yes; `SoEReset(bDone => x)` no.
                            if (calleeName.toLowerCase() !== target.methodName.toLowerCase()) continue;
                        } else if (target.owner) {
                            // The target is an FB's own input/output: the callee must be an instance of
                            // that FB (or a relative). An unresolvable callee is kept, as ever.
                            const calleeType = resolvePathType(callee, scope.pou, scope.method, symbolIndex);
                            if (calleeType) {
                                const calleeNode = findNode(symbolIndex, calleeType);
                                if (!calleeNode || !pousRelated(calleeNode, target.owner, symbolIndex)) continue;
                            }
                        }
                    }
                }
            }
            if (target && isQualifiedOccurrence(text, range)) {
                // `something.NAME` — so NAME is a member of `something`. If we can work out what that
                // is, it settles the question without needing the occurrence itself to be resolvable.
                if (targetInMethod) continue;   // a method's variable is never reached through a dot

                const baseType = qualifiedBaseType(text, range, symbolIndex, uri);
                if (baseType && target.owner) {
                    const baseNode = findNode(symbolIndex, baseType);
                    // No node for a type we *did* resolve means it is not a workspace object — it is a
                    // library type (those are indexed by name only, on demand, and often not at all).
                    // Either way the member belongs to that type, and the target's owner is always a
                    // real workspace node, so this cannot be the same symbol.
                    if (!baseNode) continue;
                    if (!pousRelated(baseNode, target.owner, symbolIndex)) continue;
                }
                // A base we could not resolve at all stays in: losing a real reference is worse than
                // listing a doubtful one.
            }
            const def = target
                ? definitionAt(text, docTokens, { line: range.start.line, character: range.start.character }, symbolIndex, uri)
                : null;
            if (sameSymbol(target, def, symbolIndex)) references.push({ uri, range });
        }
    };

    // The active document: match against the in-memory unit (most current content).
    // Compare via normalized URIs so an encoded active URI and an unencoded indexed
    // URI for the same file are recognized as identical (avoids skip + double-listing).
    visitedUris.add(normalizeUri(fileUri));
    collect(code, tokens, fileUri);

    // Other indexed documents: served from the mtime-keyed cache, converting TwinCAT XML to ST only on
    // a miss. A file that does not contain the word at all is skipped BEFORE it is tokenized, which is
    // where a search used to spend 38% of its time — a searched identifier appears in a handful of
    // files, not in all of them. The test is case-insensitive because ST is (`fbPump` and `FBPUMP` are
    // the same symbol), and it runs as a regex over the cached text rather than against a lower-cased
    // copy, so nothing extra is allocated or held. It only decides whether a file is worth tokenizing;
    // findIdentifierOccurrences still does the real matching, respecting comments and strings.
    const wordRe = new RegExp(`\\b${targetWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    for (const key of Object.keys(symbolIndex)) {
        const node = symbolIndex[key];
        if (!node.uri || visitedUris.has(normalizeUri(node.uri))) continue;
        visitedUris.add(normalizeUri(node.uri));

        const stText = readStForFile(uriToFsPath(node.uri));
        if (!stText || !wordRe.test(stText)) continue;

        let stTokens;
        try { stTokens = tokenize(stText); } catch (e) { continue; }

        // Re-index this document from its ST, transiently.
        //
        // The index holds two different kinds of node. The ACTIVE document is parsed from the ST unit
        // (server.js does this on every edit), so its method ranges are in ST-unit coordinates and a
        // scope lookup works. Every OTHER document comes from xmlIndexer, whose ranges are *per
        // component* — right for jumping to a definition, meaningless as ST-unit line numbers. So
        // findActiveScope found NO enclosing method for any line in any other file, every method
        // variable there resolved to nothing, and `sameSymbol` keeps what it cannot resolve. That one
        // mismatch produced the overwhelming majority of the wrong references: 1,885 of the 1,893
        // unresolved occurrences measured on the sample were plain identifiers failing exactly here.
        //
        // The node is restored afterwards, because those per-component ranges are what cross-file Go to
        // Definition navigates with — overwriting them for good would fix references and break jumps.
        const restore = snapshotNodesFor(symbolIndex, node.uri);
        try {
            parseAndIndexDocument(stText, node.uri);
            collect(stText, stTokens, node.uri);
        } finally {
            restore();
        }
    }

    return references;
}

/**
 * Captures every index entry belonging to a uri, and returns a function that puts them back exactly as
 * they were — including removing any node that did not exist before.
 * @param {Object} symbolIndex The workspace symbol index.
 * @param {string} uri The document uri.
 * @returns {Function} The restore callback.
 */
function snapshotNodesFor(symbolIndex, uri) {
    const saved = [];
    const keysBefore = new Set(Object.keys(symbolIndex));
    for (const key of keysBefore) {
        const node = symbolIndex[key];
        if (node && node.uri === uri) saved.push([key, node, { ...node }]);
    }
    return () => {
        for (const [key, node, copy] of saved) {
            // parseAndIndexDocument mutates the node in place, so restore its fields onto the same
            // object — other references to it (there are some) must see the original shape.
            for (const k of Object.keys(node)) if (!(k in copy)) delete node[k];
            Object.assign(node, copy);
            symbolIndex[key] = node;
        }
        for (const key of Object.keys(symbolIndex)) {
            if (!keysBefore.has(key) && symbolIndex[key] && symbolIndex[key].uri === uri) {
                delete symbolIndex[key];   // a node parseAndIndexDocument added that was not there before
            }
        }
    };
}

/**
 * Highlights all occurrences in the active document.
 * @param {string} code 
 * @param {Object} position { line, character }
 * @returns {Array<Object>} LSP DocumentHighlights
 */
function provideDocumentHighlights(code, position) {
    const lines = code.split('\n');
    const lineText = lines[position.line] || '';
    const col = position.character;

    let start = col;
    while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1])) {
        start--;
    }
    let end = col;
    while (end < lineText.length && /[a-zA-Z0-9_]/.test(lineText[end])) {
        end++;
    }
    const word = lineText.substring(start, end);
    if (!word) return [];

    const highlights = [];
    const regex = new RegExp(`\\b${word}\\b`, 'g');

    lines.forEach((lineText, lineIdx) => {
        let match;
        while ((match = regex.exec(lineText)) !== null) {
            highlights.push({
                range: {
                    start: { line: lineIdx, character: match.index },
                    end: { line: lineIdx, character: match.index + word.length }
                },
                kind: 1 // Read/Write
            });
        }
    });

    return highlights;
}

/**
 * Runs syntax diagnostics and structural linter inside Node.js.
 * @param {string} code 
 * @param {Object} symbolIndex 
 * @param {string} fileUri 
 * @returns {Array<Object>} LSP Diagnostics
 */
function provideDiagnostics(code, symbolIndex, fileUri) {
    const diagnostics = [];
    const tokens = tokenize(code);

    const blockStack = [];

    // Diagnostic validation checks:
    // 1. Keyword block validation (matching IF/END_IF, CASE/END_CASE, etc.)
    tokens.forEach(tok => {
        if (tok.type !== TokenType.Keyword) return;
        const upper = tok.value.toUpperCase();

        if (['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT'].includes(upper)) {
            blockStack.push({ word: upper, line: tok.line, col: tok.col });
        } else if (upper === 'END_IF') {
            const popped = blockStack.pop();
            if (!popped || popped.word !== 'IF') {
                diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 6, 'Unmatched "END_IF": missing preceding "IF"'));
            }
        } else if (upper === 'END_CASE') {
            const popped = blockStack.pop();
            if (!popped || popped.word !== 'CASE') {
                diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 8, 'Unmatched "END_CASE": missing preceding "CASE"'));
            }
        } else if (upper === 'END_FOR') {
            const popped = blockStack.pop();
            if (!popped || popped.word !== 'FOR') {
                diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 7, 'Unmatched "END_FOR": missing preceding "FOR"'));
            }
        } else if (upper === 'END_WHILE') {
            const popped = blockStack.pop();
            if (!popped || popped.word !== 'WHILE') {
                diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 9, 'Unmatched "END_WHILE": missing preceding "WHILE"'));
            }
        } else if (upper === 'UNTIL') {
            const popped = blockStack.pop();
            if (!popped || popped.word !== 'REPEAT') {
                diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 5, 'Unmatched "UNTIL": missing preceding "REPEAT"'));
            }
        }
    });

    // Report remaining open blocks
    blockStack.forEach(block => {
        diagnostics.push(createDiagnostic(block.line, block.col, block.col + block.word.length, `Unterminated block: missing matching "END_${block.word}"`));
    });

    // 2. Variable Scope definitions and variable usage checks
    const activePou = Object.values(symbolIndex).find(node => node.uri === fileUri);
    if (activePou) {
        // Collect all declared variables in POU scopes
        const declaredNames = new Set(activePou.variables.map(v => v.name.toLowerCase()));
        
        // Add sibling methods, properties, actions
        activePou.methods.forEach(m => declaredNames.add(m.name.toLowerCase()));
        activePou.properties.forEach(p => declaredNames.add(p.name.toLowerCase()));
        activePou.actions.forEach(a => declaredNames.add(a.name.toLowerCase()));

        // Add GVL lists and global variables
        for (const key of Object.keys(symbolIndex)) {
            const node = symbolIndex[key];
            if (node.type === 'GVL') {
                declaredNames.add(key.toLowerCase());
                node.variables.forEach(gv => declaredNames.add(gv.name.toLowerCase()));
            } else {
                declaredNames.add(key.toLowerCase());
            }
        }

        // Inherited members via the EXTENDS chain. Conservative rule: if `extends` is set but the
        // chain is not fully resolvable (some ancestor is external/unindexed), the inherited member
        // set is unknown, so suppress undeclared-identifier flagging entirely for this POU (this also
        // avoids flagging the EXTENDS type name itself). A fully-resolved chain still flags genuine
        // undeclared identifiers.
        let suppressUndeclared = false;
        if (activePou.extends) {
            const { ancestors, fullyResolved } = walkExtendsChain(activePou, symbolIndex);
            if (!fullyResolved) {
                suppressUndeclared = true;
            } else {
                ancestors.forEach(anc => {
                    anc.variables.forEach(v => declaredNames.add(v.name.toLowerCase()));
                    (anc.methods || []).forEach(m => declaredNames.add(m.name.toLowerCase()));
                    (anc.properties || []).forEach(p => declaredNames.add(p.name.toLowerCase()));
                    (anc.actions || []).forEach(a => declaredNames.add(a.name.toLowerCase()));
                });
            }
        }

        // Collect all declaration ranges for the current file to prevent flagging declarations
        const fileDeclRanges = [];
        if (activePou.nameRange) fileDeclRanges.push(activePou.nameRange);
        activePou.variables.forEach(v => fileDeclRanges.push(v.range));
        activePou.methods.forEach(m => {
            if (m.nameRange) fileDeclRanges.push(m.nameRange);
            m.variables.forEach(v => fileDeclRanges.push(v.range));
        });
        activePou.properties.forEach(p => {
            if (p.nameRange) fileDeclRanges.push(p.nameRange);
        });
        activePou.actions.forEach(a => {
            if (a.nameRange) fileDeclRanges.push(a.nameRange);
        });

        // Add method variables context when parsing method blocks
        tokens.forEach((tok, tokIdx) => {
            if (tok.type !== TokenType.Identifier) return;
            const identLower = tok.value.toLowerCase();

            // Ignore all built-ins: keywords, standard types, standard functions/FBs, conversions.
            if (isBuiltin(tok.value)) return;

            // Ignore external library namespace heads (e.g. the `VisuElems` in
            // `VisuElems.VisuElemBase.Visu_Globals.g_ClientManager.BeginIteration()`). Library
            // symbols live in binary .compiled-library archives and are never indexed, so the
            // namespace can never resolve — flagging it would violate the conservative rule.
            // Scoped to the undeclared check: member chains rooted at a namespace are already safe
            // because checkMemberAccess only flags members of a type it could resolve.
            if (isLibraryNamespace(tok.value)) return;

            // If the identifier is a declaration itself, skip
            const isDecl = fileDeclRanges.some(r => 
                r && tok.line === r.startLine && tok.col === r.startCol
            );
            if (isDecl) return;

            // If preceded by a '.' (member access), skip
            let isMemberAccess = false;
            let checkIdx = tokIdx - 1;
            while (checkIdx >= 0) {
                const prev = tokens[checkIdx];
                if (prev.type === TokenType.Whitespace || prev.type === TokenType.Comment) {
                    checkIdx--;
                    continue;
                }
                if (prev.type === TokenType.Punctuation && prev.value === '.') {
                    isMemberAccess = true;
                }
                break;
            }
            if (isMemberAccess) return;

            // If followed by '=>', it is an output parameter in a call, so ignore it
            let isFollowedByOutArrow = false;
            let followIdx = tokIdx + 1;
            while (followIdx < tokens.length) {
                const next = tokens[followIdx];
                if (next.type === TokenType.Whitespace || next.type === TokenType.Comment) {
                    followIdx++;
                    continue;
                }
                if (next.type === TokenType.Operator && next.value === '=>') {
                    isFollowedByOutArrow = true;
                }
                break;
            }
            if (isFollowedByOutArrow) return;

            // If followed by ':=' and preceded by '(' or ',', it is a parameter in a call, so ignore it
            let isFollowedByAssign = false;
            followIdx = tokIdx + 1;
            while (followIdx < tokens.length) {
                const next = tokens[followIdx];
                if (next.type === TokenType.Whitespace || next.type === TokenType.Comment) {
                    followIdx++;
                    continue;
                }
                if (next.type === TokenType.Operator && next.value === ':=') {
                    isFollowedByAssign = true;
                }
                break;
            }

            if (isFollowedByAssign) {
                let isPrecededByCallStart = false;
                let checkIdx = tokIdx - 1;
                while (checkIdx >= 0) {
                    const prev = tokens[checkIdx];
                    if (prev.type === TokenType.Whitespace || prev.type === TokenType.Comment) {
                        checkIdx--;
                        continue;
                    }
                    if (prev.type === TokenType.Punctuation && (prev.value === '(' || prev.value === ',')) {
                        isPrecededByCallStart = true;
                    }
                    break;
                }
                if (isPrecededByCallStart) return;
            }
            
            // Check if identifier is declared in active local method scope
            const { method } = findActiveScope(symbolIndex, fileUri, tok.line);
            const methodVars = method ? method.variables.map(v => v.name.toLowerCase()) : [];
            
            if (!suppressUndeclared && !declaredNames.has(identLower) && !methodVars.includes(identLower)) {
                diagnostics.push(createDiagnostic(
                    tok.line,
                    tok.col,
                    tok.col + tok.value.length,
                    `Identifier "${tok.value}" is not declared in the current scope.`,
                    1 // Error
                ));
            }
        });

        // Phase A — member-access validation.
        if (diagnosticsConfig.memberAccess) {
            checkMemberAccess(tokens, symbolIndex, fileUri, diagnostics);
        }

        // Phase B — call-argument validation.
        if (diagnosticsConfig.callArguments) {
            checkCallArguments(tokens, symbolIndex, fileUri, diagnostics);
        }

        // Phase C — declaration type validation (opt-in).
        if (diagnosticsConfig.declarationTypes) {
            checkDeclarationTypes(activePou, symbolIndex, diagnostics);
        }

        // Phase D — assignment type compatibility.
        if (diagnosticsConfig.typeCompatibility) {
            checkAssignments(tokens, symbolIndex, fileUri, diagnostics);
        }
    }

    return diagnostics;
}

/**
 * Creates an LSP Diagnostic object.
 */
function createDiagnostic(line, startCol, endCol, message, severity = 1) {
    return {
        range: {
            start: { line: line - 1, character: startCol - 1 },
            end: { line: line - 1, character: endCol - 1 }
        },
        severity: severity, // 1 = Error, 2 = Warning, 3 = Information
        source: 'TwinCAT ST Validator',
        message: message
    };
}

/**
 * Converts internal 1-based range to LSP 0-based range.
 */
function convertToLspRange(range) {
    if (!range) return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return {
        start: { line: range.startLine - 1, character: range.startCol - 1 },
        end: { line: range.endLine - 1, character: range.endCol - 1 }
    };
}

module.exports = {
    provideCompletions,
    provideDefinition,
    provideReferences,
    provideDocumentHighlights,
    provideDiagnostics,
    setDiagnosticsConfig,
    clearStFileCache
};
