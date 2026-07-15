/**
 * @file features/definition.js
 * @description Go to Definition. definitionAt is also used by references.js to resolve each
 * occurrence to the declaration it refers to.
 */

const { tokenize, TokenType } = require('../parser');
const { findNode, findMethodOwnerInChain } = require('../types');
const {
    findActiveScope,
    classifyCallSite,
    resolvePathType,
    isCallParamScope,
    convertToLspRange,
    findMemberInChain,
    walkExtendsChain
} = require('./core');

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

module.exports = {
    provideDefinition,
    definitionAt
};
