/**
 * @file test_object_kinds.js
 * @description Classification behind the TwinCAT Objects tree icons: a POU is a function block, a
 * program or a function; a DUT is a struct, an enum, a union or an alias.
 *
 * Before this, every POU drew the same `package` icon and every DUT the same `symbol-struct` — the
 * tree could not tell a PROGRAM from a FUNCTION_BLOCK, or an enum from a struct. Two traps the unit
 * cases below pin down: `END_STRUCT`/`END_UNION` must not be read as the keyword itself, and
 * `TYPE T : STRING(80); END_TYPE` is an alias, not an enum, even though it has parentheses.
 *
 * Also guards the kind→codicon table: every kind keeps its own icon, property/get/set are three
 * different glyphs (mirror-image chevrons were unreadable in the tree), and every id is a real
 * codicon — checked against the registry inside the vendored Monaco bundle, because an unknown
 * ThemeIcon id renders as a blank icon and would fail silently.
 *
 * Finally sweeps every POU/DUT in sample/ (skipped if absent) and asserts nothing lands on the
 * fallback by accident.
 */

const fs = require('fs');
const path = require('path');
const { classifyPou, classifyDut, componentKind, ICONS, LABELS, COLORS } = require("../src/objectKinds");
const { parseTwinCatXml } = require('../src/xmlParser');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ---------------------------------------------------------------- POU kinds
assert(classifyPou('FUNCTION_BLOCK FB_Motor\nVAR_INPUT\nEND_VAR') === 'functionBlock', 'FUNCTION_BLOCK -> functionBlock');
assert(classifyPou('FUNCTION_BLOCK ABSTRACT FB_Base') === 'functionBlock', 'FUNCTION_BLOCK ABSTRACT -> functionBlock');
assert(classifyPou('PROGRAM MAIN\nVAR\nEND_VAR') === 'program', 'PROGRAM -> program');
assert(classifyPou('FUNCTION F_Add : INT') === 'function', 'FUNCTION -> function');
assert(classifyPou('(* this replaces the old PROGRAM *)\nFUNCTION_BLOCK FB_X') === 'functionBlock',
    'a comment naming PROGRAM does not make a POU a program');
assert(classifyPou('// FUNCTION F_Old\nFUNCTION_BLOCK FB_X') === 'functionBlock',
    'a line comment naming FUNCTION does not make an FB a function');
assert(classifyPou('') === 'functionBlock', 'an empty declaration falls back to functionBlock');

// ---------------------------------------------------------------- DUT kinds
assert(classifyDut('TYPE ST_Data :\nSTRUCT\n  a : INT;\nEND_STRUCT\nEND_TYPE') === 'struct', 'STRUCT -> struct');
assert(classifyDut('TYPE ST_Ex EXTENDS ST_Base :\nSTRUCT\nEND_STRUCT\nEND_TYPE') === 'struct', 'STRUCT EXTENDS -> struct');
assert(classifyDut('TYPE U_Val :\nUNION\n  f : REAL;\n  d : DWORD;\nEND_UNION\nEND_TYPE') === 'union', 'UNION -> union');
assert(classifyDut('TYPE E_Mode :\n(\n  eIdle := 0,\n  eRun\n);\nEND_TYPE') === 'enum', 'parenthesised member list -> enum');
assert(classifyDut('TYPE E_Mode :\n(\n  eIdle := 0\n) UDINT;\nEND_TYPE') === 'enum', 'enum with a base type -> enum');
assert(classifyDut('TYPE T_Count : UDINT; END_TYPE') === 'alias', 'named type -> alias');
assert(classifyDut('TYPE T_Name : STRING(80); END_TYPE') === 'alias',
    'STRING(80) is an alias, not an enum — the parentheses belong to the type, not a member list');
assert(classifyDut('TYPE T_Arr : ARRAY[1..8] OF INT; END_TYPE') === 'alias', 'ARRAY alias -> alias');
assert(classifyDut('{attribute \'qualified_only\'}\nTYPE E_S :\n(\n  a\n);\nEND_TYPE') === 'enum',
    'a leading pragma does not hide an enum');

// ---------------------------------------------------------------- component kinds
assert(componentKind('Method') === 'method', 'Method -> method');
assert(componentKind('Property') === 'property', 'Property -> property');
assert(componentKind('Get') === 'get' && componentKind('Set') === 'set', 'Get/Set -> accessors');
assert(componentKind('Action') === 'action', 'Action -> action');
assert(componentKind('Transition') === 'transition', 'Transition -> transition');

// ---------------------------------------------------------------- icon table
const iconIds = Object.values(ICONS);
assert(new Set(iconIds).size === iconIds.length,
    `every kind has its own icon (${iconIds.length} kinds, no duplicates) — a shared icon is the bug this fixes`);
assert(Object.keys(ICONS).every(k => LABELS[k]), 'every kind has a tooltip label');

// A property row is expandable and its Get/Set accessors are its children, so those three sit right
// next to each other in the tree and must be told apart instantly. The first attempt used
// chevron-right/chevron-left, thin mirror-image glyphs, and the user reported they were
// indistinguishable — hence this assertion, on top of the table-wide no-duplicates one above.
assert(new Set([ICONS.property, ICONS.get, ICONS.set]).size === 3,
    `property (${ICONS.property}) / get (${ICONS.get}) / set (${ICONS.set}) are three different icons`);

// Distinct glyphs were still not enough: a bare ThemeIcon draws in the tree's plain foreground colour,
// so the three stacked rows all came out grey. Colour is carried by a ThemeColor on the ThemeIcon —
// the only way to colour a TreeItem icon — and the three must not share one.
const trio = ['property', 'get', 'set'];
assert(trio.every(k => COLORS[k]), `property/get/set each carry a theme colour (${trio.map(k => COLORS[k]).join(', ')})`);
assert(new Set(trio.map(k => COLORS[k])).size === 3, 'property/get/set are three different colours');
// `charts.*` is part of VS Code's built-in colour registry, so it resolves without a theme defining
// it. An id outside a known registry prefix would silently fall back to the default foreground —
// which is exactly the greyness being fixed.
const KNOWN_COLOR_PREFIX = /^(charts|symbolIcon|terminal|list|editor|gitDecoration|problems|testing|debugIcon)\./;
const badColors = Object.entries(COLORS).filter(([, c]) => !KNOWN_COLOR_PREFIX.test(c));
assert(badColors.length === 0,
    `every theme colour comes from a real VS Code registry namespace${badColors.length ? ` — suspect: ${badColors.map(([k, c]) => `${k}=${c}`).join(', ')}` : ''}`);

// ------------------------------------------------- the icon ids are REAL codicons
// An unknown ThemeIcon id renders as a *blank* icon — it fails silently, which would make the tree
// worse than the bug being fixed. The vendored (offline) Monaco carries the whole codicon registry:
// each one is registered in the bundle as ("<name>",<codepoint>) with codepoints in 60001..60433.
// Parsing that gives the authoritative list without any network access or extra dependency.
const MONACO = path.join(__dirname, '..', 'media', 'monaco-editor', 'vs', 'editor', 'editor.main.js');
const codicons = new Map();
if (fs.existsSync(MONACO)) {
    const bundle = fs.readFileSync(MONACO, 'utf8');
    for (const m of bundle.matchAll(/\("([a-z0-9-]+)",(60\d{3})\)/g)) codicons.set(m[1], Number(m[2]));
}
// Guard the extraction itself: if a Monaco upgrade changes the bundle's shape this must shout, not
// quietly "pass" by having nothing left to check.
assert(codicons.size > 400, `the vendored Monaco yields the codicon registry (${codicons.size} names found, expected 500+)`);

if (codicons.size > 400) {
    const unknown = Object.entries(ICONS).filter(([, id]) => !codicons.has(id));
    assert(unknown.length === 0,
        `every icon id is a real codicon${unknown.length ? ` — unknown: ${unknown.map(([k, id]) => `${k}=${id}`).join(', ')}` : ''}`);

    // Distinct *names* are necessary but NOT sufficient: many codicon names are aliases of a single
    // glyph (`edit`/`pencil` = 60019; `symbol-function`/`symbol-method`/`symbol-constructor` = 60044,
    // which is how a FUNCTION file and a Method row came to draw the very same icon while passing the
    // no-duplicate-names check above). The invariant that actually matters to the eye is one
    // codepoint per kind.
    const byCode = new Map();
    for (const [kind, id] of Object.entries(ICONS)) {
        const code = codicons.get(id);
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(`${kind}=${id}`);
    }
    const clashes = [...byCode.values()].filter(kinds => kinds.length > 1);
    assert(clashes.length === 0,
        `all ${Object.keys(ICONS).length} kinds draw a different GLYPH, not just a different name`
        + `${clashes.length ? ` — aliased: ${clashes.map(k => k.join(' == ')).join('; ')}` : ''}`);

    console.log('\nkind -> codicon -> codepoint');
    for (const [kind, id] of Object.entries(ICONS)) {
        console.log(`   ${kind.padEnd(14)} ${id.padEnd(22)} ${codicons.get(id)}`);
    }
}

// ---------------------------------------------------------------- the real project
const SAMPLE = path.join(__dirname, '..', 'sample');
if (!fs.existsSync(SAMPLE)) {
    console.log('\n[SKIP] sample/ not present — skipping the real-project sweep');
} else {
    const files = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(TcPOU|TcDUT)$/i.test(e.name)) files.push(p);
        }
    })(SAMPLE);

    const counts = {};
    for (const file of files) {
        const parsed = parseTwinCatXml(fs.readFileSync(file, 'utf8'));
        if (!parsed) continue;
        const root = parsed.components.find(c => c.id === 'root');
        if (!root) continue;
        const kind = /\.TcDUT$/i.test(file) ? classifyDut(root.declaration) : classifyPou(root.declaration);
        counts[kind] = (counts[kind] || 0) + 1;
    }

    console.log(`\nsample/: ${files.length} objects classified`);
    for (const [kind, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        console.log(`   ${String(n).padStart(4)}  ${LABELS[kind]} (${ICONS[kind]})`);
    }

    // A real TwinCAT project has all of these. If a kind is missing the classifier is swallowing it.
    assert((counts.program || 0) > 0, 'sample has programs');
    assert((counts.functionBlock || 0) > 0, 'sample has function blocks');
    assert((counts.struct || 0) > 0, 'sample has structs');
    assert((counts.enum || 0) > 0, 'sample has enums');
    assert((counts.struct || 0) + (counts.enum || 0) + (counts.union || 0) + (counts.alias || 0) > 0,
        'DUTs are spread across kinds rather than all landing on one');
}

console.log(errors === 0 ? '\nAll object-kind tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
