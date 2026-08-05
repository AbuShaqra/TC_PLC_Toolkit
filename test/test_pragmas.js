/**
 * @file test_pragmas.js
 * @description Pragma classification, the two catalogs, `{region}` folding, and the highlighting rules
 * in the two grammars.
 *
 * The load-bearing property here is the split between SHAPE and CATALOG. Shape decides the category
 * and therefore the colour; the catalog only enriches (completion, canonical spelling, doc link). If
 * that ever inverts, an uncatalogued attribute starts looking wrong in the editor — and user-defined
 * attributes are a documented TwinCAT feature, so it would look wrong on correct code. Several cases
 * below exist purely to pin that down.
 *
 * Three declarations of the `{region}` folding markers cannot `require()` each other —
 * `language-configuration.json` is data VS Code reads, and `media/editor.js` runs in the webview — so
 * the sync between them is asserted here instead. Same for the two grammars' pragma rules: the whole
 * point of consuming a brace span whole is that a `'` inside it cannot open a string, and both the
 * Monarch tokenizer and the TextMate grammar must keep doing that. The Monarch side has guarded it
 * since the apostrophe in `{region "Motion FB's"}` killed IntelliSense for a whole VAR block; the
 * TextMate grammar had no pragma rule at all and carried the same latent bug for `.st` files.
 *
 * `test_region_pragmas.js` is the sibling harness: it guards the *symptom* that started all this —
 * declarations under a half-typed `{region` disappearing from the symbol table and flashing red.
 */

const fs = require('fs');
const path = require('path');
const {
    PragmaKind,
    REGION_MARKER_START,
    REGION_MARKER_END,
    classifyPragma,
    isRegionStart,
    isRegionEnd,
    regionLabel,
    listAttributes,
    lookupAttribute,
    lookupDirective
} = require('../src/lsp/pragmas');
const { pragmaCompletions } = require('../src/lsp/features/completions');
const { tokenize, TokenType } = require('../src/lsp/parser');

const ROOT = path.join(__dirname, '..');
let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ------------------------------------------------------------------ shape: the five categories
const shape = [
    ["{attribute 'qualified_only'}", PragmaKind.Attribute],
    ["{attribute 'object_name' := 'M_StateMachine'}", PragmaKind.Attribute],
    ['{region "Alarms and status"}', PragmaKind.Region],
    ['{endregion}', PragmaKind.EndRegion],
    ['{IF defined (Variant1)}', PragmaKind.Conditional],
    ['{ELSIF defined (Variant2)}', PragmaKind.Conditional],
    ['{ELSE}', PragmaKind.Conditional],
    ['{END_IF}', PragmaKind.Conditional],
    ["{define variantA '123'}", PragmaKind.Conditional],
    ['{undefine variantA}', PragmaKind.Conditional],
    ["{text 'Part xy compiled'}", PragmaKind.Message],
    ["{info 'TODO: rename'}", PragmaKind.Message],
    ["{error 'not supported here'}", PragmaKind.Message],
    ['{warning disable C0371}', PragmaKind.WarningSuppression],
    ['{warning restore C0371}', PragmaKind.WarningSuppression]
];
for (const [text, kind] of shape) {
    assert(classifyPragma(text).kind === kind, `${text} -> ${kind}`);
}

// `{warning …}` is two different pragmas sharing one head. Only the next word tells them apart, and
// getting it backwards would file a message pragma under warning suppression.
assert(classifyPragma("{warning 'Add property implementation'}").kind === PragmaKind.Message,
    "{warning '<text>'} is a MESSAGE pragma, not warning suppression");
assert(classifyPragma('{warning disable}').kind === PragmaKind.WarningSuppression,
    '{warning disable} is warning suppression, not a message');

// ------------------------------------------------------------------ shape: names and values
assert(classifyPragma("{attribute 'qualified_only'}").name === 'qualified_only', 'attribute name is extracted');
assert(classifyPragma("{attribute 'object_name' := 'M_StateMachine'}").value === 'M_StateMachine',
    "the := '<value>' payload is extracted");
assert(classifyPragma("{attribute 'qualified_only'}").value === null, 'an attribute without a value has none');
assert(classifyPragma('{region "Alarms and status"}').name === 'Alarms and status', 'region label is extracted');
assert(classifyPragma("{region 'single quoted'}").name === 'single quoted', 'a single-quoted region label works too');

// ------------------------------------------------------------------ shape survives what real files contain
assert(classifyPragma('{ attribute  \'hide\' }').kind === PragmaKind.Attribute, 'spaces inside the braces are tolerated');
assert(classifyPragma("attribute 'hide'").kind === PragmaKind.Attribute, 'braces are optional — callers hand over both forms');
assert(classifyPragma('{REGION "Shouty"}').kind === PragmaKind.Region,
    'classification is case-insensitive: highlighting must still recognise it (folding is stricter, below)');
assert(classifyPragma('{region "Motion FB\'s"}').kind === PragmaKind.Region,
    "an apostrophe inside a region label does not derail classification");

// A half-typed pragma must still classify. This is what keeps completion alive while it is typed —
// the same failure mode that once switched IntelliSense off for everything below a `{region`.
const partial = classifyPragma('{region "Inputs"');
assert(partial.kind === PragmaKind.Region && partial.complete === false, 'an unterminated pragma classifies, flagged incomplete');
assert(classifyPragma("{attribute 'qua").kind === PragmaKind.Attribute, 'a half-typed attribute is still an attribute pragma');

// Things that are not pragmas at all must fall to Unknown without throwing. The last one is real:
// a LaTeX formula inside a comment in a customer project produces `{a_0 + a_1 T}`.
for (const junk of ['{}', '{   }', '{6f9dac99-1d2e-4a5b-8c3d-0e1f2a3b4c5d}', '{a_0 + a_1 T}', '', null, undefined]) {
    assert(classifyPragma(junk).kind === PragmaKind.Unknown, `${JSON.stringify(junk)} -> unknown, no throw`);
}

// ------------------------------------------------------------------ catalog enriches, never decides
const userDefined = classifyPragma("{attribute 'MyCompany_SomethingNew'}");
assert(userDefined.kind === PragmaKind.Attribute, 'an uncatalogued attribute is still an attribute pragma');
assert(userDefined.known === false && userDefined.tier === null, 'and it is simply reported as not catalogued');
assert(classifyPragma("{attribute 'qualified_only'}").tier === 'documented', "qualified_only is documented on Infosys");
assert(classifyPragma("{attribute 'TcGenerated'}").tier === 'observed',
    'TcGenerated is real but undocumented — the reason pragmaCatalogExtra.json exists');
assert(/infosys\.beckhoff\.com/.test(classifyPragma("{attribute 'hide'}").doc || ''), 'a documented attribute carries its Infosys link');
assert(classifyPragma("{attribute 'TcGenerated'}").doc === null, 'an observed attribute carries no documentation link');

// Case-insensitive lookup returning the CANONICAL spelling is what makes completion usable.
assert(lookupAttribute('QUALIFIED_ONLY').name === 'qualified_only', 'lookup is case-insensitive and returns canonical spelling');
assert(lookupAttribute('no_such_attribute_anywhere') === null, 'an unknown name looks up to null');
assert(lookupDirective('endregion').doc.includes('3525631371'), 'directives carry their category page');

// ------------------------------------------------------------------ catalog integrity
const documented = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lsp', 'pragmaCatalog.json'), 'utf8'));
const observed = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lsp', 'pragmaCatalogExtra.json'), 'utf8'));

assert(documented.attributes.length >= 60, `documented catalog has ${documented.attributes.length} attributes (>= 60)`);
assert(documented.attributes.every(a => /^\d+$/.test(String(a.doc))), 'every documented attribute has an Infosys node id');
assert(documented.directives.length >= 14, `documented catalog has ${documented.directives.length} directives (>= 14)`);

const dupes = names => names.filter((n, i) => names.findIndex(m => m.toLowerCase() === n.toLowerCase()) !== i);
assert(dupes(documented.attributes.map(a => a.name)).length === 0, 'no duplicate names in the generated catalog');
assert(dupes(observed.attributes.map(a => a.name)).length === 0, 'no duplicate names in the curated catalog');

// The curated file exists only for names Infosys does NOT have. An entry that became documented is
// dead weight that would shadow a real doc link, so it must be pruned rather than left.
const documentedNames = new Set(documented.attributes.map(a => a.name.toLowerCase()));
const overlap = observed.attributes.map(a => a.name).filter(n => documentedNames.has(n.toLowerCase()));
assert(overlap.length === 0, `curated catalog holds nothing Infosys documents (overlap: ${overlap.join(', ') || 'none'})`);

// Every curated entry claims to have been measured, not remembered.
assert(observed.attributes.every(a => Number.isInteger(a.archives) && Number.isInteger(a.sources)),
    'every curated entry carries its measured archive and source counts');
assert(observed.attributes.every(a => a.archives > 0 || a.sources > 0),
    'every curated entry was actually observed somewhere');

// The names that motivated the whole two-tier design, pinned by name.
for (const name of ['TcGenerated', 'object_name', 'no-analysis', 'message_guid']) {
    assert(lookupAttribute(name) !== null, `${name} is known (real, and on no Infosys page)`);
}
// And a sample of the documented set, so a broken scrape cannot quietly empty it.
for (const name of ['qualified_only', 'to_string', 'monitoring', 'strict', 'pack_mode', 'no_explicit_call', 'TcLinkTo']) {
    assert(lookupAttribute(name) && lookupAttribute(name).tier === 'documented', `${name} is documented`);
}

const all = listAttributes();
assert(all.length === documented.attributes.length + observed.attributes.length, 'listAttributes returns both tiers');
const firstObserved = all.findIndex(a => a.tier === 'observed');
assert(all.slice(0, firstObserved).every(a => a.tier === 'documented'), 'listAttributes puts documented names first');

// ------------------------------------------------------------------ folding markers
assert(isRegionStart('{region "Inputs"}'), 'a region line opens a fold');
assert(isRegionStart('        {region "Inputs"}'), 'indentation does not stop it');
assert(isRegionStart('{ region "Inputs"}'), 'a space after the brace does not stop it');
assert(isRegionEnd('    {endregion}'), 'an endregion line closes a fold');
assert(!isRegionStart('{endregion}'), '{endregion} must not also OPEN a fold — it would nest forever');
assert(!isRegionEnd('{region "x"}'), '{region} must not also close a fold');
assert(!isRegionStart('nCount := nCount + 1; // see {region "x"}'),
    'a region mentioned mid-line does not open a fold — the marker is anchored to the line start');
assert(!isRegionStart('{REGION "Shouty"}'),
    'folding is case-SENSITIVE on purpose: TwinCAT folds {region}, so folding {REGION} would fold what the real IDE does not');
assert(regionLabel('  {region "Alarms and status"}') === 'Alarms and status', 'the fold carries the region label');
assert(regionLabel('{endregion}') === null, 'endregion has no label');

// The three declarations that cannot import each other.
const langConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'language-configuration.json'), 'utf8'));
assert(langConfig.folding && langConfig.folding.markers, 'language-configuration.json declares folding markers');
assert(langConfig.folding.markers.start === REGION_MARKER_START,
    'language-configuration.json start marker matches pragmas.js');
assert(langConfig.folding.markers.end === REGION_MARKER_END,
    'language-configuration.json end marker matches pragmas.js');

const editorJs = fs.readFileSync(path.join(ROOT, 'media', 'editor.js'), 'utf8');
// In the webview the markers are RegExp literals, so compare the sources rather than the text.
const markerBlock = editorJs.match(/folding:\s*\{\s*markers:\s*\{\s*start:\s*(\/.*?\/)[a-z]*\s*,\s*end:\s*(\/.*?\/)[a-z]*\s*\}/s);
assert(!!markerBlock, 'media/editor.js declares folding markers on the iecst language configuration');
if (markerBlock) {
    assert(markerBlock[1].slice(1, -1) === REGION_MARKER_START, 'media/editor.js start marker matches pragmas.js');
    assert(markerBlock[2].slice(1, -1) === REGION_MARKER_END, 'media/editor.js end marker matches pragmas.js');
}

// ------------------------------------------------------------------ the lexer still consumes spans whole
// This is the invariant every highlighting rule below mirrors. An unterminated `{` used to swallow the
// rest of the file, so every declaration under a half-typed `{region` vanished from the symbol table.
const lexed = tokenize("VAR\n{region \"Motion FB's\"}\n  bDone : BOOL;\nEND_VAR");
const pragmaTokens = lexed.filter(t => t.type === TokenType.Pragma);
assert(pragmaTokens.length === 1, 'the region pragma lexes as exactly one token');
assert(pragmaTokens[0].value === '{region "Motion FB\'s"}', 'and it holds the whole span, apostrophe included');
assert(lexed.some(t => t.type === TokenType.Identifier && t.value === 'bDone'),
    'the declaration BELOW the region is still visible — the apostrophe did not open a string');

const halfTyped = tokenize('VAR\n{region "Inputs"\n  bDone : BOOL;\nEND_VAR');
assert(halfTyped.filter(t => t.type === TokenType.Pragma)[0].value === '{region "Inputs"',
    'an unterminated pragma stops at end of line');
assert(halfTyped.some(t => t.type === TokenType.Identifier && t.value === 'bDone'),
    'and the declarations below it survive');

// ------------------------------------------------------------------ highlighting: Monarch (the webview)
// Rebuild the rule list from the source and run it the way Monaco would: first rule that matches at
// position 0 wins. That checks ORDER as well as the patterns — the catch-all must stay last, or every
// pragma would be scoped 'annotation' and the categories would be dead code.
const monarchRules = [...editorJs.matchAll(/\[\/(\\\{[^\n]*?)\/,\s*'(annotation[^']*)'\]/g)]
    .map(m => ({ re: new RegExp('^(?:' + m[1] + ')', 'i'), scope: m[2], src: m[1] }));
assert(monarchRules.length === 8, `Monarch declares 8 pragma rules (found ${monarchRules.length})`);
assert(monarchRules[monarchRules.length - 1].scope === 'annotation',
    'the catch-all is LAST, so an unknown or future pragma still highlights');

const monarchScope = text => {
    for (const rule of monarchRules) {
        const m = text.match(rule.re);
        if (m) return { scope: rule.scope, consumed: m[0] };
    }
    return null;
};
const monarchCases = [
    ['{region "Motion FB\'s"}', 'annotation.region'],
    ['{endregion}', 'annotation.region'],
    ['{IF defined (X)}', 'annotation.conditional'],
    ['{END_IF}', 'annotation.conditional'],
    ["{define variantA '1'}", 'annotation.conditional'],
    ["{info 'TODO'}", 'annotation.message'],
    ["{warning 'careful'}", 'annotation.message'],
    ["{attribute 'qualified_only'}", 'annotation'],
    ["{attribute 'MyCompany_Unknown'}", 'annotation'],
    ['{something_nobody_has_written_yet}', 'annotation']
];
for (const [text, scope] of monarchCases) {
    const got = monarchScope(text);
    assert(got && got.scope === scope, `Monarch: ${text} -> ${scope} (got ${got ? got.scope : 'no match'})`);
    assert(got && got.consumed === text, `Monarch: ${text} is consumed WHOLE — a ' inside it can never open a string`);
}
// An uncatalogued attribute must be indistinguishable from a documented one. Colour comes from shape.
assert(monarchScope("{attribute 'qualified_only'}").scope === monarchScope("{attribute 'MyCompany_Unknown'}").scope,
    'Monarch: a user-defined attribute is scoped exactly like a documented one');
// And a half-typed pragma still stops at end of line rather than running on.
assert(monarchScope('{region "Inputs"').consumed === '{region "Inputs"', 'Monarch: a half-typed pragma is consumed to end of line');
assert(monarchScope("{attribute 'qua").scope === 'annotation', 'Monarch: a half-typed attribute still scopes as a pragma');

// ------------------------------------------------------------------ highlighting: TextMate (VS Code's editor)
const grammar = JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes', 'twincat-st.tmLanguage.json'), 'utf8'));
const topLevel = grammar.patterns.map(p => p.include);
assert(topLevel.includes('#pragmas'), 'the grammar has a pragma rule at all');
assert(topLevel.indexOf('#pragmas') < topLevel.indexOf('#strings'),
    "#pragmas is ordered BEFORE #strings — otherwise the ' in {region \"Motion FB's\"} opens a string that runs on");

// Oniguruma's `(?i)` is not JS, but JS is what we can execute here; strip it and use the flag.
const tmRules = grammar.repository.pragmas.patterns.map(p => ({
    scope: p.name,
    re: new RegExp('^(?:' + p.match.replace(/^\(\?i\)/, '') + ')', p.match.startsWith('(?i)') ? 'i' : '')
}));
const tmScope = text => {
    for (const rule of tmRules) {
        const m = text.match(rule.re);
        if (m) return { scope: rule.scope, consumed: m[0] };
    }
    return null;
};
const tmCases = [
    ['{region "Motion FB\'s"}', 'keyword.control.directive.region.twincat-st'],
    ['{endregion}', 'keyword.control.directive.region.twincat-st'],
    ['{IF defined (X)}', 'keyword.control.directive.conditional.twincat-st'],
    ["{info 'TODO'}", 'keyword.control.directive.message.twincat-st'],
    ["{attribute 'qualified_only'}", 'storage.modifier.attribute.twincat-st'],
    ["{attribute 'MyCompany_Unknown'}", 'storage.modifier.attribute.twincat-st'],
    ['{something_nobody_has_written_yet}', 'storage.modifier.attribute.twincat-st']
];
for (const [text, scope] of tmCases) {
    const got = tmScope(text);
    assert(got && got.scope === scope, `TextMate: ${text} -> ${scope} (got ${got ? got.scope : 'no match'})`);
    assert(got && got.consumed === text, `TextMate: ${text} is consumed WHOLE`);
}
assert(tmRules.every(r => !/\[\^\}\]\*/.test(r.re.source) || /\[\^\}\\n\]\*/.test(r.re.source)),
    'no TextMate pragma rule can run past the end of its line');

// ------------------------------------------------------------------ completion inside a pragma
assert(pragmaCompletions('  nCount := nCount + 1;') === null, 'ordinary code is not a pragma caret');
assert(pragmaCompletions("{attribute 'qualified_only'} ") === null, 'a CLOSED pragma is not a pragma caret');

const heads = pragmaCompletions('{');
assert(heads && heads.some(i => i.label === 'attribute'), '{▮ offers the pragma heads');
assert(heads.some(i => i.label === 'region') && heads.some(i => i.label === 'IF'), '… including region and IF');
assert(pragmaCompletions('    {reg').some(i => i.label === 'region'), 'a partially typed head still offers heads');

const inQuotes = pragmaCompletions("{attribute '");
assert(inQuotes && inQuotes.length === listAttributes().length, "{attribute '▮ offers every catalogued attribute");
assert(inQuotes.some(i => i.label === 'qualified_only'), '… including documented ones');
assert(inQuotes.some(i => i.label === 'TcGenerated'), '… and observed ones');
assert(inQuotes.every(i => i.insertText === undefined || !i.insertText.includes("'")),
    'inside the quotes the name is inserted bare — the quotes are already there');
assert(inQuotes.find(i => i.label === 'qualified_only').sortText <
    inQuotes.find(i => i.label === 'TcGenerated').sortText,
    'documented attributes rank above merely observed ones');

const beforeQuotes = pragmaCompletions('{attribute ');
assert(beforeQuotes && beforeQuotes.every(i => /^'.*'$/.test(i.insertText)),
    'with no quotes typed yet, the name is inserted WITH them');

assert(pragmaCompletions("{attribute 'quali").some(i => i.label === 'qualified_only'),
    'a partially typed attribute name still offers the full list — Monaco filters it');

console.log(errors === 0 ? '\nAll pragma tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
