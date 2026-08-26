/**
 * @file completion/sources.js
 * @description The candidate sources a classified caret is assembled from: scope members, globals,
 * project symbols, type names, enum members, keywords and snippets — plus the keyword vocabularies
 * and sortText prefixes those lists are built with. Requires none of the other completion modules,
 * so there are no import cycles.
 */

const { STANDARD_TYPES, STANDARD_KEYWORDS } = require('../builtins');
const { typeFromNode } = require('../types');
const { getLibraryNamespaces } = require('../libraries');
const { getLibraryNamespaceNames } = require('../libsymbols');
const { walkExtendsChain } = require('../features/core');

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
// The keyword vocabularies a context *offers* (the ones the classifier merely *reads* live with it,
// in completion/context.js, under the banner that explains the pair).
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

module.exports = {
    PARAM_SORT_PREFIX,
    VAR_SECTION_SORT_PREFIX,
    STATEMENT_KEYWORDS,
    VAR_SECTION_KEYWORDS,
    VAR_MODIFIER_KEYWORDS,
    VALUE_KEYWORDS,
    pushScopeMembers,
    pushGlobals,
    pushProjectSymbols,
    pushLibraryNamespaces,
    pushTypeNames,
    pushEnumMembers,
    rankInlineEnumValues,
    pushKeywords,
    pushSnippets,
    pushEverything
};
