/**
 * @file objectKinds.js
 * @description Classifies a TwinCAT object from its ST declaration, and maps each kind to the
 * codicon the TwinCAT Objects tree draws for it. Kept free of any `vscode` dependency so the
 * classification can be exercised by the standalone harnesses (scratch/test_object_kinds.js).
 */

/**
 * Strips what must never decide a kind: block comments, line comments and pragmas. A POU whose
 * header comment says "this replaces the old FUNCTION" must not be classified as a function.
 * @param {string} declaration Raw declaration text.
 * @returns {string} Declaration with comments and pragmas blanked out.
 */
function stripNoise(declaration) {
    return String(declaration || '')
        .replace(/\(\*[\s\S]*?\*\)/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/\{[^}\n]*\}/g, ' ');
}

/**
 * Classifies a `.TcPOU` declaration.
 * @param {string} declaration The POU's declaration text.
 * @returns {'program'|'function'|'functionBlock'} The POU kind; anything unrecognised is a
 * function block, which is what TwinCAT creates by default.
 */
function classifyPou(declaration) {
    const code = stripNoise(declaration);
    if (/\bPROGRAM\b/i.test(code)) return 'program';
    // FUNCTION_BLOCK also starts with FUNCTION, so the block form has to be excluded explicitly.
    if (/\bFUNCTION\b(?!\s*_?\s*BLOCK)/i.test(code)) return 'function';
    return 'functionBlock';
}

/**
 * Classifies a `.TcDUT` declaration.
 * @param {string} declaration The DUT's declaration text.
 * @returns {'struct'|'enum'|'union'|'alias'} The DUT kind.
 */
function classifyDut(declaration) {
    const code = stripNoise(declaration);
    // END_UNION / END_STRUCT cannot match: `_` is a word character, so there is no \b before the
    // keyword inside them.
    if (/\bUNION\b/i.test(code)) return 'union';
    if (/\bSTRUCT\b/i.test(code)) return 'struct';

    // What follows `TYPE <name> :` decides the rest. An enum opens a parenthesised member list —
    // `TYPE E : (a, b); END_TYPE`, or with a base type, `TYPE E : (a, b) UDINT; END_TYPE`. Anything
    // else naming a type is an alias. The body must be tested rather than just searching for a `(`,
    // or `TYPE T : STRING(80); END_TYPE` would read as an enum.
    const body = code.match(/\bTYPE\b[^:]*:\s*([\s\S]*)/i);
    if (body) return body[1].trimStart().startsWith('(') ? 'enum' : 'alias';
    return 'struct';
}

/**
 * Codicon for every kind the Objects tree can show. Distinct glyph per kind is the whole point of
 * this table — if two kinds ever share an icon, the user cannot tell them apart in the tree, which
 * is exactly the bug this replaced. scratch/test_object_kinds.js asserts they stay distinct, and
 * that every id here is a real codicon: an unknown id renders as a *blank* icon, so a typo would
 * fail silently and make the tree worse than before.
 *
 * The property accessors are deliberately not mirrored arrows. `chevron-right`/`chevron-left` were
 * the first attempt and the user could not tell them apart in the tree: they are thin monochrome
 * mirror images of each other. They read as semantics instead — a Get *reads* (`eye`) and a Set
 * *writes* (`edit`, the pencil) — which are unmistakable at a glance and also unmistakably not the
 * property itself (`symbol-property`, the wrench VS Code uses for properties everywhere else).
 *
 * Distinct *names* are not enough: several codicon names are aliases of one glyph. `symbol-function`
 * and `symbol-method` are the same codepoint (60044), so a FUNCTION file and a Method row drew the
 * identical icon — the same bug, one level up. A function therefore uses `symbol-operator`. The
 * harness pins the invariant on codepoints, not names, so the next alias cannot slip through.
 */
const ICONS = {
    // Files
    functionBlock: 'symbol-class',
    program: 'symbol-module',
    function: 'symbol-operator',
    interface: 'symbol-interface',
    gvl: 'symbol-variable',
    struct: 'symbol-struct',
    enum: 'symbol-enum',
    union: 'layers',
    alias: 'symbol-type-parameter',
    stFile: 'file-code',
    folder: 'folder',
    // Components inside a POU or interface
    method: 'symbol-method',
    property: 'symbol-property',
    get: 'eye',
    set: 'edit',
    action: 'symbol-event',
    transition: 'arrow-swap'
};

/**
 * Optional theme colour per kind, applied as the ThemeIcon's colour in the tree.
 *
 * Without one, a codicon renders in the tree's plain foreground colour — which is why the property
 * row and its two accessors read as three grey marks however distinct the glyphs are. A `ThemeColor`
 * on the ThemeIcon is the only way to colour a TreeItem icon.
 *
 * The `charts.*` ids are part of VS Code's standard colour registry (not something a theme has to
 * define), so they resolve everywhere and stay legible in both light and dark themes. An id that did
 * not resolve would fall back to the default foreground — no crash, just no colour.
 *
 * Property/get/set are the trio that sit stacked together in the tree, so they get the strongest
 * separation: the property itself, then green for the getter (it *reads*) and orange for the setter
 * (it *writes*).
 */
const COLORS = {
    property: 'charts.red',
    get: 'charts.green',
    set: 'charts.yellow'
};

/** Human-readable name per kind, used as the tree item's tooltip. */
const LABELS = {
    functionBlock: 'Function Block',
    program: 'Program',
    function: 'Function',
    interface: 'Interface',
    gvl: 'Global Variable List',
    struct: 'Structure',
    enum: 'Enumeration',
    union: 'Union',
    alias: 'Alias',
    stFile: 'Structured Text',
    folder: 'Folder',
    method: 'Method',
    property: 'Property',
    get: 'Get accessor',
    set: 'Set accessor',
    action: 'Action',
    transition: 'Transition'
};

/**
 * Maps a parsed component's `type` (see xmlParser.parseTwinCatXml) to a kind in ICONS/LABELS.
 * @param {string} componentType 'Method' | 'Property' | 'Get' | 'Set' | 'Action' | 'Transition'.
 * @returns {string} The kind key.
 */
function componentKind(componentType) {
    switch (componentType) {
        case 'Property': return 'property';
        case 'Get': return 'get';
        case 'Set': return 'set';
        case 'Action': return 'action';
        case 'Transition': return 'transition';
        default: return 'method';
    }
}

module.exports = { classifyPou, classifyDut, componentKind, ICONS, LABELS, COLORS };
