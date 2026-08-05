/**
 * @file test_folding.js
 * @description Folding ranges for Structured Text (`media/stFolding.js`).
 *
 * This module exists because Monaco's default — indentation folding — is the wrong model for ST, and
 * two user-reported bugs came directly out of that. Both are pinned below by name, because both are
 * the kind that a plausible-looking refactor reintroduces:
 *
 *   1. **An unmatched `{endregion}` truncated the enclosing `VAR` fold.** Monaco scans bottom-up and
 *      pushes an `{indent:-2}` sentinel for an end marker it has not yet matched; only a *matching
 *      start marker* pops it, so a lone `{endregion}` was a permanent barrier. Here an unmatched
 *      closer is ignored outright.
 *   2. **`{attribute 'TcLinkTo' := ''}` at column 0 under an indented VAR body grew its own fold
 *      arrow.** That was never about pragmas — an unindented line followed by indented ones simply
 *      *is* an indentation region. Here a fold exists only where ST says a block does.
 *
 * The subtlest requirement is the third one, and it has no bug report because it was designed for
 * rather than discovered: `{IF defined(X)}` is a **conditional pragma**, not an `IF` block. Counting
 * it would leave an unclosed `IF` on the stack and eat every fold below it — and real TwinCAT
 * projects are full of them.
 *
 * `test_pragmas.js` covers classification and highlighting; `scratch/peek_harness/run_pragmas.js`
 * proves the ranges actually collapse lines in a real Monaco.
 */

const { computeFoldingRanges, scanLines, CLOSES } = require('../media/stFolding');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Folds for a block of text written as an array of lines. */
const fold = lines => computeFoldingRanges(lines);
/** Compact `start-end:kind` form, so an assertion reads like the thing it checks. */
const shape = ranges => ranges.map(r => `${r.start}-${r.end}:${r.kind}`).join(' ');

// ------------------------------------------------------------------ the two reported bugs
// 1  FUNCTION_BLOCK FB_X
// 2  VAR
// 3      a : BOOL;
// 4      {endregion}          <- no {region} anywhere
// 5      b : BOOL;
// 6  END_VAR
const strayEnd = fold(['FUNCTION_BLOCK FB_X', 'VAR', '    a : BOOL;', '    {endregion}', '    b : BOOL;', 'END_VAR']);
assert(shape(strayEnd) === '2-5:block',
    `an unmatched {endregion} is ignored and VAR folds to END_VAR (got ${shape(strayEnd) || 'nothing'})`);

// 1  FUNCTION_BLOCK FB_X
// 2  VAR
// 3  {attribute 'TcLinkTo' := ''}     <- column 0, body below it indented
// 4      a : BOOL;
// 5      b : BOOL;
// 6  END_VAR
const unindentedAttr = fold(['FUNCTION_BLOCK FB_X', 'VAR', "{attribute 'TcLinkTo' := ''}", '    a : BOOL;', '    b : BOOL;', 'END_VAR']);
assert(shape(unindentedAttr) === '2-5:block',
    `an unindented attribute under VAR gets no fold of its own (got ${shape(unindentedAttr)})`);
assert(!unindentedAttr.some(r => r.start === 3), 'and specifically no range starts on the attribute line');

// An attribute is not a fold header wherever it sits.
assert(!fold(['VAR', "    {attribute 'hide'}", '    a : BOOL;', 'END_VAR']).some(r => r.start === 2),
    'nor when it is indented with the rest of the body');

// ------------------------------------------------------------------ pragmas are not code
// `{IF defined(X)}` / `{END_IF}` are conditional pragmas. Reading them as an IF block would leave the
// stack unbalanced and swallow every fold after them.
const condPragma = fold(['VAR', '{IF defined(Variant1)}', 'a : BOOL;', '{END_IF}', 'b : BOOL;', 'END_VAR']);
assert(shape(condPragma) === '1-5:block',
    `a conditional pragma is not an IF block — VAR still folds whole (got ${shape(condPragma)})`);
assert(!condPragma.some(r => r.start === 2), 'and {IF …} opens no range');

const messagePragma = fold(['VAR', "{warning 'careful'}", 'a : BOOL;', 'END_VAR']);
assert(shape(messagePragma) === '1-3:block', 'a message pragma does not disturb the enclosing block');

// ------------------------------------------------------------------ keywords must be code
assert(shape(fold(['VAR', '  // END_VAR', '  a : BOOL;', 'END_VAR'])) === '1-3:block',
    'END_VAR in a line comment does not close the block');
assert(shape(fold(['VAR', "  s : STRING := 'END_VAR';", '  a : BOOL;', 'END_VAR'])) === '1-3:block',
    'END_VAR inside a string literal does not close the block');
assert(shape(fold(['VAR', '  (* END_VAR', '     still a comment *)', '  a : BOOL;', 'END_VAR'])) === '1-4:block',
    'END_VAR inside a multi-line (* *) comment does not close the block');
assert(shape(fold(['VAR', '  /* END_VAR */', '  a : BOOL;', 'END_VAR'])) === '1-3:block',
    'END_VAR inside a /* */ comment does not close the block');
assert(shape(fold(['VAR', "  s : STRING := 'it$'s END_VAR';", '  a : BOOL;', 'END_VAR'])) === '1-3:block',
    "a $-escaped quote does not end the string early (ST escapes with $, not \\)");
assert(shape(fold(['IF x THEN', '  y := axis.Case;', '  z := 1;', 'END_IF'])) === '1-3:block',
    'a member named like a keyword (axis.Case) is not a block opener');

// ------------------------------------------------------------------ regions
const nested = fold(['VAR', '{region "Outer"}', 'a : BOOL;', '{region "Inner"}', 'b : BOOL;',
    '{endregion}', 'c : BOOL;', '{endregion}', 'd : BOOL;', 'END_VAR']);
assert(shape(nested) === '1-9:block 2-8:region 4-6:region',
    `regions nest, and nest inside the VAR block (got ${shape(nested)})`);

// A region hides its own {endregion}; a keyword block leaves its closer visible. Both match what
// these panes did before the provider existed, so nothing a user is used to moves.
assert(fold(['{region "x"}', 'a;', '{endregion}'])[0].end === 3, 'a region range covers its {endregion} line');
assert(fold(['VAR', 'a : BOOL;', 'END_VAR'])[0].end === 2, 'a block range stops before its END_VAR line');

assert(shape(fold(['{ region "spaced" }', 'a;', '{ endregion }'])) === '1-3:region', 'spaces inside the braces are fine');
assert(fold(['{REGION "Shouty"}', 'a;', '{ENDREGION}']).length === 0,
    'region folding is case-SENSITIVE, matching TwinCAT and the folding markers in pragmas.js');
assert(fold(['x := 1; {region "no"}', 'a;', '{endregion}']).length === 0,
    'a region must start the line — one mid-expression opens nothing');
assert(fold(['(* {region "in a comment"} *)', 'a;', '{endregion}']).length === 0,
    'a region inside a comment is not a region');

// Separate stacks: a stray {endregion} inside a VAR block must not cost the VAR fold, and a stray
// END_VAR must not cost the region. This is why regions and keyword blocks do not share one stack.
const crossed = fold(['{region "R"}', 'VAR', 'a : BOOL;', 'END_VAR', '{endregion}']);
assert(shape(crossed) === '1-5:region 2-3:block', `region and block ranges survive each other (got ${shape(crossed)})`);

// ------------------------------------------------------------------ keyword blocks
assert(shape(fold(['IF a THEN', '  b();', 'END_IF'])) === '1-2:block', 'IF … END_IF');
assert(shape(fold(['CASE n OF', '  1: b();', 'END_CASE'])) === '1-2:block', 'CASE … END_CASE');
assert(shape(fold(['FOR i := 1 TO 10 DO', '  b();', 'END_FOR'])) === '1-2:block', 'FOR … END_FOR');
assert(shape(fold(['WHILE a DO', '  b();', 'END_WHILE'])) === '1-2:block', 'WHILE … END_WHILE');
assert(shape(fold(['REPEAT', '  b();', 'UNTIL a', 'END_REPEAT'])) === '1-3:block', 'REPEAT … END_REPEAT');
assert(shape(fold(['TYPE ST_X :', 'STRUCT', '  a : INT;', 'END_STRUCT', 'END_TYPE'])) === '1-4:block 2-3:block',
    'TYPE and STRUCT nest');
assert(shape(fold(['VAR_INPUT', '  a : BOOL;', 'END_VAR'])) === '1-2:block', 'VAR_INPUT is one keyword, not VAR + INPUT');
for (const kw of ['VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_STAT', 'VAR_EXTERNAL', 'VAR_INST']) {
    assert(shape(fold([kw, '  a : BOOL;', 'END_VAR'])) === '1-2:block', `${kw} … END_VAR`);
}
assert(shape(fold(['var_input', '  a : BOOL;', 'end_var'])) === '1-2:block', 'keywords are case-insensitive, as ST is');
assert(shape(fold(['VAR_GLOBAL CONSTANT', '  c : INT := 1;', 'END_VAR'])) === '1-2:block', 'VAR_GLOBAL CONSTANT still folds');

const deep = fold(['IF a THEN', '  CASE n OF', '    1: b();', '  END_CASE', 'END_IF']);
assert(shape(deep) === '1-4:block 2-3:block', `nested keyword blocks both fold (got ${shape(deep)})`);

// ------------------------------------------------------------------ nothing to fold
assert(fold(['IF x THEN y := 1; END_IF;']).length === 0, 'a one-line IF has nothing to hide');
assert(fold(['VAR', 'END_VAR']).length === 0, 'an empty VAR block has nothing to hide');
assert(fold(['END_VAR']).length === 0, 'a lone END_VAR opens nothing');
assert(fold(['{endregion}']).length === 0, 'a lone {endregion} opens nothing');
assert(fold([]).length === 0, 'no lines, no ranges');
assert(fold(['VAR', 'a : BOOL;']).length === 0, 'an unclosed VAR block yields no range');

// Malformed input must degrade, never throw — this runs on every keystroke.
for (const junk of [null, undefined, [null], [undefined], ['{'], ["'"], ['(*'], ['{region "x"']]) {
    let threw = false;
    try { computeFoldingRanges(junk); } catch (e) { threw = true; }
    assert(!threw, `computeFoldingRanges(${JSON.stringify(junk)}) does not throw`);
}

// ------------------------------------------------------------------ the scanner underneath
const scanSource = ['VAR', "  {attribute 'x'} a : STRING := 'END_VAR'; // END_VAR", 'END_VAR'];
const scanned = scanLines(scanSource);
assert(scanned[1].pragmas.length === 1 && scanned[1].pragmas[0].text === "{attribute 'x'}",
    'the scanner hands back the pragma span it blanked');
assert(!/END_VAR/.test(scanned[1].code), 'and the string and comment are blanked out of the code');
// Blanking with spaces rather than deleting is what keeps a pragma's `start` a real column, which
// the region anchoring ("nothing but whitespace before it") relies on.
assert(scanned.every((s, i) => s.code.length === scanSource[i].length), 'blanking preserves line length');
assert(scanned[1].code.slice(scanned[1].pragmas[0].start, scanned[1].pragmas[0].start + 15) === ' '.repeat(15),
    'a pragma reports the column it was blanked at');
assert(scanLines(['(* a', 'b *) VAR'])[1].code.includes('VAR'), 'code after a closing block comment is code again');
assert(!scanLines(['(* a', 'b'])[1].code.trim(), 'an unterminated block comment keeps swallowing lines');
assert(scanLines(['{region "x"', 'VAR'])[1].code.includes('VAR'),
    'an unterminated pragma stops at end of line — it must never swallow the file');

// ------------------------------------------------------------------ real sample objects
// Ranges must be well-formed on genuine TwinCAT code, not just on hand-written cases.
const fs = require('fs');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const sampleDir = path.join(__dirname, '..', 'sample');
if (!fs.existsSync(sampleDir)) {
    console.log('\n[SKIP] sample/ is absent — skipping the real-object sweep.');
} else {
    const files = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(TcPOU|TcGVL|TcDUT|TcIO)$/i.test(e.name)) files.push(p);
        }
    })(sampleDir);

    let panes = 0;
    let withRanges = 0;
    let bad = 0;
    for (const file of files) {
        const parsed = parseTwinCatXml(fs.readFileSync(file, 'utf8'));
        for (const c of parsed.components || []) {
            for (const text of [c.declaration, c.implementation]) {
                if (typeof text !== 'string' || !text.length) continue;
                panes++;
                const ranges = computeFoldingRanges(text.split(/\r?\n/));
                if (ranges.length) withRanges++;
                const lineCount = text.split(/\r?\n/).length;
                for (const r of ranges) {
                    if (!(r.start >= 1 && r.end > r.start && r.end <= lineCount)) bad++;
                }
            }
        }
    }
    console.log(`\nsample/: ${files.length} objects, ${panes} panes, ${withRanges} with folds`);
    assert(bad === 0, `every range on the sample is in-bounds and non-empty (${bad} bad)`);
    assert(withRanges > 0, 'real objects do produce folds (a VAR block is universal)');
}

// The opener table must stay self-consistent: nothing may be both an opener and a closer, or the
// stack logic would pop the entry it just pushed.
const closers = new Set(Object.values(CLOSES));
assert(Object.keys(CLOSES).every(k => !closers.has(k)), 'no keyword is both an opener and a closer');

console.log(errors === 0 ? '\nAll folding tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
