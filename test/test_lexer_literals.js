/**
 * @file test_lexer_literals.js
 * @description Guards the ST lexer against the literal-form gaps found by cross-checking the CODESYS
 * programming reference: the '$' string escape (not '\'), REAL exponent notation, and '_' digit
 * separators. Each of these, when mis-lexed, either swallows real code (an escaped quote / trailing
 * backslash ending a string early or late) or emits a spurious identifier that becomes a false
 * "not declared" diagnostic (`1.5E-3` -> `E`, `1_000` -> `_000`).
 */

const { tokenize, TokenType } = require('../src/lsp/parser');

let failures = 0;
function check(desc, cond) {
    if (cond) {
        console.log(`[PASS] ${desc}`);
    } else {
        console.log(`[FAIL] ${desc}`);
        failures++;
    }
}

// Meaningful (non-skippable) tokens only.
function meaningful(code) {
    return tokenize(code).filter(t =>
        t.type !== TokenType.Whitespace && t.type !== TokenType.Comment && t.type !== TokenType.Pragma);
}
function tokensOfType(code, type) {
    return meaningful(code).filter(t => t.type === type);
}

console.log('\n--- String escape: $ is the escape char, not backslash ---');

// `'It$'s'` is ONE string (the $' is an escaped apostrophe), then a ';'.
{
    const toks = meaningful("x := 'It$'s'; y := 1;");
    const strs = toks.filter(t => t.type === TokenType.String);
    check("an escaped apostrophe ($') does not end the string — exactly one string literal",
        strs.length === 1 && strs[0].value === "'It$'s'");
    // The code after the string must still be seen: identifiers x and y both present.
    const idents = toks.filter(t => t.type === TokenType.Identifier).map(t => t.value);
    check("code after the $'-bearing string is not swallowed (x and y both lexed)",
        idents.includes('x') && idents.includes('y'));
}

// A trailing backslash is an ordinary character in ST; the string ends at its real closing quote.
{
    const toks = meaningful("sPath := 'C:\\Temp\\'; nAfter := 5;");
    const strs = toks.filter(t => t.type === TokenType.String);
    check("a trailing backslash does NOT escape the closing quote — one string, ends correctly",
        strs.length === 1 && strs[0].value === "'C:\\Temp\\'");
    const idents = toks.filter(t => t.type === TokenType.Identifier).map(t => t.value);
    check("code after a backslash-terminated string is not swallowed (nAfter lexed)",
        idents.includes('sPath') && idents.includes('nAfter'));
}

// $N, $T, $$ escapes: single string token, nothing leaks.
{
    const toks = meaningful("sMsg := 'Line1$NLine2$TTabbed$$Done';");
    const strs = toks.filter(t => t.type === TokenType.String);
    check("$N / $T / $$ inside a string stay inside one string literal",
        strs.length === 1 && strs[0].value === "'Line1$NLine2$TTabbed$$Done'");
}

// WSTRING uses double quotes; $" is an escaped double-quote and must not end the literal.
{
    const toks = meaningful('ws := "a$"b";');
    const strs = toks.filter(t => t.type === TokenType.String);
    check('$" inside a double-quoted WSTRING literal does not end it early',
        strs.length === 1 && strs[0].value === '"a$"b"');
}

console.log('\n--- REAL/LREAL exponent notation ---');
for (const [src, label] of [
    ['1.5E-3', 'negative exponent'],
    ['1.64e+009', 'lowercase e, +sign, leading zeros'],
    ['1.0E-44', 'REAL min'],
    ['3.402823E38', 'no sign'],
    ['1E9', 'exponent with no decimal point'],
]) {
    const nums = tokensOfType(`r := ${src};`, TokenType.Number);
    check(`${src} (${label}) lexes as a single number token`,
        nums.length === 1 && nums[0].value === src);
    const idents = tokensOfType(`r := ${src};`, TokenType.Identifier).map(t => t.value);
    check(`...and emits no spurious 'E'/'e' identifier`, !idents.includes('E') && !idents.includes('e'));
}

console.log('\n--- Underscore digit separators ---');
for (const src of ['1_000_000', '16#FFFF_FFFF', '2#1001_0011', '1_234.567_8', '1_000e1_0']) {
    const nums = tokensOfType(`n := ${src};`, TokenType.Number);
    check(`${src} lexes as a single number token`, nums.length === 1 && nums[0].value === src);
    const idents = tokensOfType(`n := ${src};`, TokenType.Identifier).map(t => t.value);
    check(`...and emits no spurious '_'-prefixed identifier`, idents.length === 1 && idents[0] === 'n');
}

console.log('\n--- Regressions: existing forms must be unchanged ---');

// Typed/time literals still one token.
for (const src of ['T#5s', 'WORD#16#FF', 'DINT#-5', 'TOD#12:00:00', '16#1E5']) {
    const nums = tokensOfType(`v := ${src};`, TokenType.Number);
    check(`${src} still lexes as a single number token`, nums.length === 1 && nums[0].value === src);
}

// ARRAY range `1..3` must remain three tokens: number '1', '.', '.', number '3'.
{
    const toks = meaningful('a : ARRAY[1..3] OF INT;');
    const nums = toks.filter(t => t.type === TokenType.Number).map(t => t.value);
    const dots = toks.filter(t => t.type === TokenType.Punctuation && t.value === '.').length;
    check("ARRAY[1..3] keeps 1 and 3 as separate numbers with two '.' between them",
        nums.includes('1') && nums.includes('3') && !nums.some(v => v.includes('.')) && dots === 2);
}

// '&' is an operator (AND alias), not Unknown.
{
    const toks = meaningful('b := x & y;');
    const amp = toks.find(t => t.value === '&');
    check("'&' is classified as an operator, not Unknown", amp && amp.type === TokenType.Operator);
    check("no Unknown tokens remain in `x & y`", !toks.some(t => t.type === TokenType.Unknown));
}

// A plain string and a plain real still work.
{
    const toks = meaningful("s := 'hello'; f := 3.14;");
    const strs = toks.filter(t => t.type === TokenType.String);
    const nums = toks.filter(t => t.type === TokenType.Number).map(t => t.value);
    check("a plain single-quoted string is one token", strs.length === 1 && strs[0].value === "'hello'");
    check("a plain real 3.14 is one number token", nums.includes('3.14'));
}

console.log(`\n--- LEXER LITERAL TESTS COMPLETE with ${failures} error(s) ---`);
if (failures > 0) process.exit(1);
