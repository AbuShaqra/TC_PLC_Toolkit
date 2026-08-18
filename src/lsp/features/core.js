/**
 * @file features/core.js
 * @description Shared LSP feature helpers used by two or more feature modules: URI/range
 * conversion, meaningful-token scanning, scope lookup, EXTENDS-chain walking, dotted-path and type
 * resolution, and diagnostic construction. Requires none of the feature modules, so there are no
 * import cycles.
 */

const { TokenType, isSkippable } = require('../parser');
const { findNode, parentNames } = require('../types');
const { fileUriToFsPath, normalizeFileUri } = require('../../fileUri');

/**
 * Converts a file URI to a platform-correct filesystem path. Bare paths pass through unchanged.
 * @param {string} uri File URI.
 * @returns {string} Filesystem path.
 */
function uriToFsPath(uri) {
    return fileUriToFsPath(uri);
}

/**
 * Normalizes a URI for identity comparison so that percent-encoded and unencoded
 * forms of the same path (and case differences on Windows) compare equal.
 * @param {string} uri File URI.
 * @returns {string} Normalized key.
 */
function normalizeUri(uri) {
    return normalizeFileUri(uri);
}

/** Keywords that introduce a named return/alias type: `METHOD m : ▮`, `FUNCTION f : ▮`, `TYPE t : ▮`. */
const TYPED_HEADER_KEYWORDS = new Set(['METHOD', 'FUNCTION', 'PROPERTY', 'TYPE']);

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
    uriToFsPath,
    normalizeUri,
    nextMeaningful,
    prevMeaningful,
    consumeBalanced,
    lvalueStart,
    isHeaderColon,
    walkExtendsChain,
    findMemberInChain,
    findVarInChain,
    findActiveScope,
    cleanTypeName,
    resolvePathType,
    isBareTypeName,
    isCallParamScope,
    classifyCallSite,
    convertToLspRange,
    createDiagnostic
};
