/**
 * @file features/diagnostics.js
 * @description Structural and semantic diagnostics, plus the diagnostics configuration toggles.
 */

const { tokenize, TokenType, isSkippable } = require('../parser');
const { isBuiltin } = require('../builtins');
const {
    UNKNOWN,
    parseTypeString,
    deref,
    lookupMember,
    resolveSymbolType,
    resolvePath,
    isAssignable,
    isRelatedAssignable,
    findNode,
    getCallParams,
    getInitParams
} = require('../types');
const { inferType } = require('../exprParser');
const { isLibraryNamespace } = require('../libraries');
const {
    prevMeaningful,
    nextMeaningful,
    consumeBalanced,
    lvalueStart,
    findActiveScope,
    createDiagnostic,
    walkExtendsChain
} = require('./core');

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
            if (isLibraryNamespace(tok.value, symbolIndex)) return;

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

module.exports = {
    provideDiagnostics,
    setDiagnosticsConfig
};
