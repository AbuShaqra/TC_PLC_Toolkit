/**
 * @file test_st_strings.js
 * @description Guards the ST string rules in ALL THREE places that have to agree: the lexer
 * (`src/lsp/parser.js`), the webview's Monarch tokenizer (`media/editor.js`) and the TextMate
 * grammar VS Code's own editor uses for loose `.st` files (`syntaxes/twincat-st.tmLanguage.json`).
 *
 * In IEC 61131-3 the string escape character is the DOLLAR SIGN. A backslash carries no meaning at
 * all — it is an ordinary character, which matters because Windows paths are written in ST every
 * day. Both grammars were seeded from Monaco's C-like sample, so both treated `\` as an escape:
 *
 *     sDir : T_MaxString := 'C:\Temp\tc_json_append_test\';
 *
 * ended with `\'`, the "escaped" quote was swallowed, and the literal ran on for the rest of the
 * declaration — in the user's file it finally terminated on the apostrophe in `FB's`, inside a `//`
 * comment 16 lines below, painting everything between them as string. The lexer was already right
 * (`test_lexer_literals.js` pins it); these are the two that were not, and neither is reachable from
 * a running lexer test, so they are asserted from their source here.
 *
 * The other half of the invariant is TERMINATION. A Monarch state that can match zero characters
 * hangs the tokenizer, so the simulation below fails the run if any rule matches empty or if no rule
 * matches at all — a lone `$`, a `$` immediately before the closing quote and a `$` at end of line
 * are each exercised for that reason.
 */

const fs = require('fs');
const path = require('path');
const { tokenize, TokenType } = require('../src/lsp/parser');

const ROOT = path.join(__dirname, '..');
let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// The two lines from the user's report, byte for byte (tabs included). The declaration below the
// path is the one the runaway string used to reach: its comment holds an apostrophe.
const PATH_LINE = "\tsDir\t\t: T_MaxString := 'C:\\Temp\\tc_json_append_test\\';";
const COMMENT_LINE = "\tbTriggerOld\t: BOOL;\t\t// forces one full scan with bExecute FALSE between " +
    "operations, so the FB's rising edge always fires";

// =============================================================================================
// 1. The lexer — already correct, asserted here so all three stay in step
// =============================================================================================
{
    const toks = tokenize(PATH_LINE + '\n' + COMMENT_LINE);
    const strings = toks.filter(t => t.type === TokenType.String);
    assert(strings.length === 1 && strings[0].value === "'C:\\Temp\\tc_json_append_test\\'",
        `lexer: the Windows path is ONE string ending at its own quote (got ${JSON.stringify(strings.map(s => s.value))})`);
    assert(toks.some(t => t.type === TokenType.Identifier && t.value === 'bTriggerOld'),
        'lexer: the declaration under it is still an identifier, not string content');
    assert(toks.some(t => t.type === TokenType.Comment && /FB's rising edge/.test(t.value)),
        "lexer: the // comment holding `FB's` is a comment, and its apostrophe closes nothing");
}

// =============================================================================================
// 2. Monarch (the webview) — rebuilt from source and run as Monaco would run it
// =============================================================================================
const editorJs = fs.readFileSync(path.join(ROOT, 'media', 'editor.js'), 'utf8');

const escapesMatch = editorJs.match(/\n[ \t]*escapes:[ \t]*\/(.+)\/,/);
assert(!!escapesMatch, 'media/editor.js declares an `escapes` regex for the string states');
const escapesSrc = escapesMatch ? escapesMatch[1] : '(?!)';

assert(!escapesSrc.startsWith('\\\\'),
    `Monarch: \`escapes\` does not start at a BACKSLASH — the ST escape is $ (got /${escapesSrc}/)`);
{
    const re = new RegExp('^(?:' + escapesSrc + ')');
    for (const [text, why] of [["$'", 'an escaped apostrophe'], ['$$', 'a literal dollar'],
        ['$N', 'newline'], ['$t', 'tab, lower case'], ['$0D', 'a hex byte'], ['$"', 'an escaped double quote']]) {
        assert(re.test(text), `Monarch: \`escapes\` recognises ${text} (${why})`);
    }
    assert(!re.test('\\n') && !re.test("\\'"),
        'Monarch: `escapes` recognises NO backslash form — a backslash is an ordinary ST character');
}

/**
 * Pulls one Monarch state's rule list out of media/editor.js. The states cannot be required (the
 * file only runs inside a webview), so they are read from the source and re-run here — the same
 * approach test_pragmas.js takes for the pragma rules.
 * @param {string} name State name, e.g. 'string'.
 * @returns {Array<{re: RegExp, action: string}>|null} Rules in declaration order, or null.
 */
function monarchState(name) {
    // Indentation is matched with [ \t]* rather than \s*: the file is CRLF, and a greedy \s* happily
    // swallows the blank line above the state, which then makes the \1 backreference on the closing
    // bracket unmatchable.
    const block = editorJs.match(new RegExp('\\n([ \\t]*)' + name + ':[ \\t]*\\[\\r?\\n([\\s\\S]*?)\\r?\\n\\1\\],'));
    if (!block) return null;
    const rules = [];
    for (const line of block[2].split('\n')) {
        const m = line.match(/^\s*\[\/(.+?)\/,\s*(.+?)\],?\s*$/);
        if (!m) continue;
        // Function replacement, not a string: the escape pattern itself contains `$'`, which String
        // .replace would expand as "everything after the match" and quietly corrupt the rule.
        const src = m[1].replace(/@escapes/g, () => '(?:' + escapesSrc + ')');
        rules.push({ re: new RegExp('^(?:' + src + ')'), action: m[2] });
    }
    return rules;
}

/**
 * Runs a string state over one line the way Monaco does — first rule that matches at the cursor
 * wins — and reports where the literal closed. Also the termination check: a rule that matches
 * zero characters, or a character no rule matches, would stall the real tokenizer.
 * @param {Array} rules From monarchState().
 * @param {string} line Text starting just AFTER the opening quote.
 * @returns {Object} { closedAt, stalled } — closedAt is the index of the closing quote, or -1.
 */
function runStringState(rules, line) {
    let i = 0;
    while (i < line.length) {
        let matched = null;
        for (const rule of rules) {
            const m = line.substring(i).match(rule.re);
            if (m) { matched = { rule, len: m[0].length }; break; }
        }
        if (!matched || matched.len === 0) return { closedAt: -1, stalled: true, at: i };
        if (/@pop/.test(matched.rule.action)) return { closedAt: i, stalled: false };
        i += matched.len;
    }
    return { closedAt: -1, stalled: false };
}

for (const state of ['string', 'wstring']) {
    const quote = state === 'string' ? "'" : '"';
    const rules = monarchState(state);
    assert(!!rules && rules.length > 0, `Monarch: the @${state} state exists (${quote}…${quote} literals are tokenized)`);
    if (!rules) continue;

    // Plain substring tests, not regexes over regexes: '\\\\.' is the two-character backslash
    // escape rule and '[^\\\\' is the bulk rule that used to stop dead at a backslash.
    const sources = rules.map(r => r.re.source);
    assert(!sources.some(s => s.includes('\\\\.')),
        `Monarch @${state}: no backslash-escape rule survives — that is what ate the trailing backslash`);
    assert(!sources.some(s => s.includes('[^\\\\')),
        `Monarch @${state}: the bulk rule no longer stops at a backslash either`);

    // The reported line. Body = everything between the quotes; a correct state closes on the LAST
    // character, after the trailing backslash.
    const body = state === 'string'
        ? "C:\\Temp\\tc_json_append_test\\';"
        : 'C:\\Temp\\tc_json_append_test\\";';
    const run = runStringState(rules, body);
    assert(!run.stalled, `Monarch @${state}: the state consumes every character (no stall)`);
    assert(run.closedAt === body.length - 2,
        `Monarch @${state}: a Windows path closes at its own quote, index ${body.length - 2} (got ${run.closedAt})`);

    // $' still escapes a quote — the fix must not throw the real escape away with the fake one.
    const escaped = state === 'string' ? "It$'s done'; x := 1;" : 'It$"s done"; x := 1;';
    const escRun = runStringState(rules, escaped);
    assert(escRun.closedAt === escaped.indexOf(' done') + ' done'.length,
        `Monarch @${state}: $${quote} still escapes the quote, so the literal closes after "done" (got ${escRun.closedAt})`);

    // Termination corner cases. Each must consume and move on rather than stall.
    for (const [body2, why] of [
        ['$', 'a lone $ at end of line'],
        ['$' + quote, 'a $ immediately before the closing quote'],
        ['a$', 'a $ as the very last character'],
        ['$Z' + quote, 'a $ before a character that is not an escape']
    ]) {
        assert(!runStringState(rules, body2).stalled, `Monarch @${state}: ${why} does not stall the tokenizer`);
    }
}

// The root state must actually enter those states, or the rules above are dead code.
assert(/\[\/'\/,\s*\{\s*token:\s*'string\.quote'[^}]*next:\s*'@string'/.test(editorJs),
    "Monarch: a ' in code opens the @string state");
assert(/\[\/"\/,\s*\{\s*token:\s*'string\.quote'[^}]*next:\s*'@wstring'/.test(editorJs),
    'Monarch: a " in code opens the @wstring state (WSTRING literals)');

// =============================================================================================
// 3. TextMate (VS Code's own editor, for loose .st files)
// =============================================================================================
const grammarText = fs.readFileSync(path.join(ROOT, 'syntaxes', 'twincat-st.tmLanguage.json'), 'utf8');
const grammar = JSON.parse(grammarText);

assert(!/"match":\s*"\\\\\\\\\."/.test(grammarText),
    'TextMate: no `\\\\.` escape pattern survives anywhere in the grammar');

/** Resolves a `{ include: '#name' }` entry against the grammar's repository, as a TextMate engine does. */
const resolveInclude = p => (p && typeof p.include === 'string' && p.include.startsWith('#'))
    ? grammar.repository[p.include.slice(1)] : p;

for (const [key, quote] of [['single', "'"], ['double', '"']]) {
    const rule = grammar.repository.strings.patterns.find(p => p.name.includes('.' + key + '.'));
    assert(!!rule, `TextMate: the ${key}-quoted string rule exists`);
    if (!rule) continue;
    const escapes = (rule.patterns || []).map(resolveInclude).filter(p => p && /escape/.test(p.name || ''));
    assert(escapes.length > 0, `TextMate: the ${key}-quoted rule declares an escape pattern`);
    for (const esc of escapes) {
        assert(!esc.match.startsWith('\\\\'),
            `TextMate ${key}: the escape pattern does not start at a backslash (got ${JSON.stringify(esc.match)})`);
    }

    // Run begin/patterns/end the way a TextMate engine does: inside the literal, the inner patterns
    // are tried before `end`, so an escape that matched the quote would stop it closing.
    const escRes = escapes.map(e => new RegExp('^(?:' + e.match + ')'));
    const endRe = new RegExp('^(?:' + rule.end + ')');
    const scan = (body) => {
        let i = 0;
        while (i < body.length) {
            const esc = escRes.map(r => body.substring(i).match(r)).find(m => m && m[0].length > 0);
            if (esc) { i += esc[0].length; continue; }
            if (endRe.test(body.substring(i))) return i;
            i++;
        }
        return -1;
    };
    const body = 'C:\\Temp\\tc_json_append_test\\' + quote + ';';
    assert(scan(body) === body.length - 2,
        `TextMate ${key}: a Windows path closes at its own quote, index ${body.length - 2} (got ${scan(body)})`);
    const escaped = 'It$' + quote + 's done' + quote + '; x := 1;';
    assert(scan(escaped) === escaped.indexOf(' done') + ' done'.length,
        `TextMate ${key}: $${quote} still escapes the quote (got ${scan(escaped)})`);
}

console.log(errors === 0 ? '\nAll ST string tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
