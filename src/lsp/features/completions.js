/**
 * @file features/completions.js
 * @description Autocompletion for Structured Text: the orchestrator that walks the caret through
 * pragma → scope → member access → named parameters → context classification, and assembles the
 * list each context accepts. The systems it drives live under src/lsp/completion/ —
 * `pragma.js` (inside `{ … }`), `memberAccess.js` (a dotted caret), `namedParams.js` (an argument
 * name), `context.js` (the caret-context classifier) and `sources.js` (the candidate sources and
 * the vocabularies they are built from). This module stays the single require path for the
 * feature and re-exports the pure pieces the harnesses pin.
 */

const { deref, findNode } = require('../types');
const { inferType } = require('../exprParser');
const { findActiveScope } = require('./core');
const { pragmaCompletions } = require('../completion/pragma');
const { provideMemberAccessCompletions, rankNamespaceSymbol } = require('../completion/memberAccess');
const { provideNamedParamCompletions } = require('../completion/namedParams');
const { classifyCaretContext, enumNodeOfSelector, BLOCK_CONTINUATIONS } = require('../completion/context');
const {
    PARAM_SORT_PREFIX,
    VAR_SECTION_SORT_PREFIX,
    STATEMENT_KEYWORDS,
    VAR_SECTION_KEYWORDS,
    VAR_MODIFIER_KEYWORDS,
    VALUE_KEYWORDS,
    pushScopeMembers,
    pushGlobals,
    pushProjectSymbols,
    pushTypeNames,
    pushEnumMembers,
    rankInlineEnumValues,
    pushKeywords,
    pushSnippets,
    pushEverything
} = require('../completion/sources');

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

    // A caret after a dot is answered entirely by the member-access branch (null = not after one).
    const memberItems = provideMemberAccessCompletions(textBeforeCursor, pou, method, symbolIndex);
    if (memberItems) return memberItems;

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
