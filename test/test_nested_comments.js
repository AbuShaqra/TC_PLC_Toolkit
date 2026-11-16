/**
 * @file test_nested_comments.js
 * @description Nested `(* … *)` comments, in EVERY place that scans Structured Text.
 *
 * TwinCAT nests them — Infosys "ST comments" documents `(* a:=fbTest.out; (* 1.Kommentar *) b:=b+1; *)`
 * as a "nested" comment — so the first `*)` only closes the innermost one. Before this, every scanner
 * here ended the comment at that first `*)` and read the rest of the outer comment as code: the lexer
 * reported its words as undeclared identifiers, folding saw its `IF` as a block, and the panes painted
 * it as code. `/* … *\/` is not documented for TwinCAT and keeps its non-nesting behaviour.
 *
 * Seven implementations must agree, and only two of them can share code:
 *   1. the LSP lexer (`src/lsp/parser.js` tokenize);
 *   2. `src/stComments.js` (object kinds, DUT kinds, check-unit/st-converter POU keyword, library decls);
 *   3. the fold scanner (`media/stFolding.js`, dual-loaded in the webview);
 *   4. the webview's Monarch tokenizer (`media/editor.js`, read from source and re-run here — the real
 *      tokenizer is checked in test/browser/run_pragmas.js);
 *   5. the TextMate grammar (`syntaxes/twincat-st.tmLanguage.json`, read and simulated here);
 *   plus the consumers that go through 1 and 2: diagnostics, definition and the live-path line map.
 */

const fs = require('fs');
const path = require('path');
const { tokenize, TokenType, parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideDiagnostics, provideDefinition } = require('../src/lsp/features');
const { blankComments, blockCommentEnd } = require('../src/stComments');
const stFolding = require('../media/stFolding');
const { classifyPou } = require('../src/objectKinds');
const { dutKindFromDecl, extractEnumMembers } = require('../src/lsp/xmlIndexer');
const { buildCheckUnit } = require('../src/checkUnit');
const { parseTwinCatXml } = require('../src/xmlParser');
const { assembleSt, localToAbsolute, absoluteToLocal } = require('../src/livePath');

const ROOT = path.join(__dirname, '..');
let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// The cases every scanner is run over. `closesAt` is the index just past the comment that opens at 0
// (text.length when it never closes).
const CASES = [
    { name: 'Infosys example', text: '(* a:=fbTest.out; (* 1.Kommentar *)\nb:=b+1; (* 2.Kommentar *)*) x', closesAt: 63 },
    { name: '*)-looking text in the inner level', text: '(* outer (* inner *) still comment *) code', closesAt: 37 },
    { name: 'three levels', text: '(* 1 (* 2 (* 3 *) 2 *) 1 *)x', closesAt: 27 },
    { name: 'a quote inside is comment text', text: "(* it's (* x *) *) y", closesAt: 18 },
    { name: '// inside does not hide the *)', text: '(* // *) z', closesAt: 8 },
    { name: 'a slash-star inside is text', text: '(* /* *) w', closesAt: 8 },
    { name: 'unterminated nested comment', text: '(* a (* b *) c\nIF x THEN', closesAt: 24 },
    { name: '(*) is an opener plus a parenthesis', text: '(*) still *) v', closesAt: 12 }
];
for (const c of CASES) {
    if (c.closesAt !== c.text.length && c.text.slice(c.closesAt - 2, c.closesAt) !== '*)') {
        throw new Error(`fixture "${c.name}": closesAt ${c.closesAt} is not just past a *)`);
    }
}

// =============================================================================================
// 1. The lexer
// =============================================================================================
for (const c of CASES) {
    const toks = tokenize(c.text);
    const first = toks[0];
    assert(first.type === TokenType.Comment && first.end === c.closesAt,
        `lexer [${c.name}]: one comment token ending at ${c.closesAt} (got ${first.type} ending at ${first.end})`);
}
{
    const toks = tokenize('(* outer (* inner *) still comment *) code');
    assert(!toks.some(t => t.type === TokenType.Identifier && /still|comment/.test(t.value)),
        'lexer: no word of the outer comment after the inner *) becomes an identifier');
    assert(toks.some(t => t.type === TokenType.Identifier && t.value === 'code'), 'lexer: the code after the outer *) is code');

    const unterminated = tokenize('(* a (* b *) c\nIF x THEN');
    assert(unterminated.length === 1, `lexer: an unterminated nested comment runs to the end of the text (${unterminated.length} token(s))`);

    // Comment markers inside strings belong to the string.
    const inString = tokenize("s := '(* not a comment'; nAfter := 1; w := \"*) nor this\"; nLast := 2;");
    assert(inString.filter(t => t.type === TokenType.String).length === 2, 'lexer: (* and *) inside STRING and WSTRING literals stay string text');
    assert(['nAfter', 'nLast'].every(n => inString.some(t => t.type === TokenType.Identifier && t.value === n)),
        'lexer: and the code after each literal is still code');

    // A // line comment hides an opener completely.
    const lineHides = tokenize('// (* not opened\nnReal := 1;');
    assert(lineHides.some(t => t.type === TokenType.Identifier && t.value === 'nReal'), 'lexer: (* inside a // comment opens nothing');

    // Slash-star comments do not nest: the first */ ends it.
    const slash = tokenize('/* a /* b */ nSlash := 1;');
    assert(slash.some(t => t.type === TokenType.Identifier && t.value === 'nSlash'), 'lexer: a slash-star comment still ends at its first */');

    // Positions after a multi-line nested comment.
    const pos = tokenize('(* l1\n (* l2 *)\nl3 *) nVar');
    const v = pos.find(t => t.value === 'nVar');
    assert(v && v.line === 3 && v.col === 7, `lexer: the token after a 3-line nested comment is at line 3 col 7 (got ${v && v.line}:${v && v.col})`);
}

// =============================================================================================
// 2. stComments.js (and the helpers built on it)
// =============================================================================================
for (const c of CASES) {
    assert(blockCommentEnd(c.text, 0) === c.closesAt, `stComments [${c.name}]: blockCommentEnd = ${c.closesAt} (got ${blockCommentEnd(c.text, 0)})`);
    const blanked = blankComments(c.text);
    assert(blanked.length === c.text.length && blanked.slice(0, c.closesAt).trim() === '' &&
        blanked.split('\n').length === c.text.split('\n').length,
        `stComments [${c.name}]: blankComments keeps length and line breaks and blanks the whole comment`);
}
{
    const s = "x := '(* kept *)'; (* gone (* gone *) gone *) {attribute 'a'} y";
    assert(blankComments(s).includes("'(* kept *)'") && !/gone/.test(blankComments(s)) && blankComments(s).includes("{attribute 'a'}"),
        'stComments: strings and pragmas survive by default; nested comments do not');
    assert(!blankComments(s, { pragmas: true }).includes('attribute'), 'stComments: { pragmas: true } blanks pragmas');
    assert(!blankComments(s, { strings: true }).includes('kept'), 'stComments: { strings: true } blanks strings');

    assert(classifyPou('(* was a (* nested *) FUNCTION once *)\nFUNCTION_BLOCK FB_X\nVAR\nEND_VAR') === 'functionBlock',
        'objectKinds: a keyword after the inner *) of a header comment does not decide the POU kind');
    assert(dutKindFromDecl('(* old (* x *) STRUCT *)\nTYPE T_H : DWORD;\nEND_TYPE') === 'alias',
        'xmlIndexer: a STRUCT in the outer part of a nested comment does not make an alias a struct');
    const members = extractEnumMembers('TYPE E_X :\n(\n    eA := 0, (* a (* b *) ( c *)\n    eB\n);\nEND_TYPE');
    assert(members.map(m => m.name).join(',') === 'eA,eB', `xmlIndexer: enum members around a nested comment holding "(" (got ${members.map(m => m.name)})`);
}

// =============================================================================================
// 3. The fold scanner
// =============================================================================================
{
    const lines = ['(* disabled:', '   (* inner note *)', '   IF bX THEN', '      y := 1;', '   END_IF', '*)', 'IF bY THEN', '   z := 1;', 'END_IF'];
    const scanned = stFolding.scanLines(lines);
    assert(scanned.slice(0, 6).every(l => l.code.trim() === ''), 'stFolding: every line of the nested comment is blanked, including the IF after the inner *)');
    const ranges = stFolding.computeFoldingRanges(lines);
    // Ranges are 1-based: the commented-out IF is line 3, the real one line 7.
    assert(!ranges.some(r => r.start === 3), `stFolding: the commented-out IF offers no fold (ranges ${JSON.stringify(ranges)})`);
    assert(ranges.some(r => r.start === 7), 'stFolding: the real IF below still folds');
    assert(stFolding.scanLines(['/* (* */ nA := 1;'])[0].code.includes('nA'), 'stFolding: a slash-star comment is not made to nest');
}

// =============================================================================================
// 4. Monarch (the webview), rebuilt from source
// =============================================================================================
const editorJs = fs.readFileSync(path.join(ROOT, 'media', 'editor.js'), 'utf8');
function monarchState(name) {
    const block = editorJs.match(new RegExp('\\n([ \\t]*)' + name + ':[ \\t]*\\[\\r?\\n([\\s\\S]*?)\\r?\\n\\1\\],'));
    if (!block) return null;
    const rules = [];
    for (const line of block[2].split('\n')) {
        const m = line.match(/^\s*\[\/(.+?)\/,\s*(.+?)\],?\s*$/);
        if (m) rules.push({ re: new RegExp('^(?:' + m[1] + ')'), action: m[2] });
    }
    return rules;
}
{
    const rules = monarchState('comment_block1');
    assert(!!rules && rules.some(r => /@push/.test(r.action)), 'Monarch: @comment_block1 pushes itself on an inner (*');
    if (rules) {
        for (const c of CASES) {
            // Monaco's loop: first matching rule wins; @push/@pop move the state stack.
            let depth = 1;
            let i = 2;
            let stalled = false;
            while (i < c.text.length && depth > 0) {
                const rest = c.text.substring(i);
                const hit = rules.map(r => ({ r, m: rest.match(r.re) })).find(x => x.m);
                if (!hit || hit.m[0].length === 0) { stalled = true; break; }
                if (/@push/.test(hit.r.action)) depth++;
                if (/@pop/.test(hit.r.action)) depth--;
                i += hit.m[0].length;
            }
            const end = depth === 0 ? i : c.text.length;
            assert(!stalled && end === c.closesAt, `Monarch [${c.name}]: the comment ends at ${c.closesAt} (got ${end}${stalled ? ', STALLED' : ''})`);
        }
    }
}

// =============================================================================================
// 5. TextMate (VS Code's own editor, loose .st files)
// =============================================================================================
{
    const grammar = JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes', 'twincat-st.tmLanguage.json'), 'utf8'));
    const rule = grammar.repository['comment-block-paren'];
    assert(!!rule && (rule.patterns || []).some(p => p.include === '#comment-block-paren'),
        'TextMate: the (* *) rule includes itself, so an inner (* opens another level');
    assert(grammar.repository.comments.patterns.some(p => p.include === '#comment-block-paren'), 'TextMate: #comments uses that rule');
    if (rule) {
        const begin = new RegExp('^(?:' + rule.begin + ')');
        const endRe = new RegExp('^(?:' + rule.end + ')');
        for (const c of CASES) {
            let depth = 1;
            let i = 2;
            while (i < c.text.length && depth > 0) {
                const rest = c.text.substring(i);
                const b = rest.match(begin);
                const e = rest.match(endRe);
                if (b) { depth++; i += b[0].length; } else if (e) { depth--; i += e[0].length; } else i++;
            }
            const end = depth === 0 ? i : c.text.length;
            assert(end === c.closesAt, `TextMate [${c.name}]: the comment ends at ${c.closesAt} (got ${end})`);
        }
    }
}

// =============================================================================================
// 6. Language features: diagnostics, definition and the live-path line map
// =============================================================================================
const XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_Nested" Id="{dddddddd-dddd-dddd-dddd-dddddddddddd}" SpecialFunc="None">
    <Declaration><![CDATA[(* Header (* nested note *) FUNCTION
   bGhost : BOOL; *)
FUNCTION_BLOCK FB_Nested
VAR
    (* (* *) nNotAVar : INT; *)
    nCount : INT;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[(* disabled:
   (* old *) nUndeclared := 1;
*)
nCount := nCount + 1;]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>`;
{
    const unit = assembleSt(XML, null);
    assert(!!unit && !!unit.lineMap.root, 'live path: the POU assembles into a unit');
    const uri = 'file:///nested/FB_Nested.TcPOU';
    clearWorkspaceIndex();
    parseAndIndexDocument(unit.stText, uri);
    const index = getWorkspaceSymbolIndex();

    const diags = provideDiagnostics(unit.stText, index, uri);
    assert(diags.length === 0, `diagnostics: nothing inside a nested comment is checked (got ${JSON.stringify(diags.map(d => d.message))})`);

    const node = Object.values(index).find(n => n.uri === uri);
    const varNames = node ? (node.variables || []).map(v => v.name) : [];
    assert(varNames.includes('nCount') && !varNames.includes('nNotAVar') && !varNames.includes('bGhost'),
        `parser: only the real variable is declared (got ${JSON.stringify(varNames)})`);

    // Go to Definition from `nCount` on impl line 4, col 1, through the same mapping the bridge uses.
    const abs = localToAbsolute(unit.lineMap, 'root', 'impl', 4, 1);
    const def = abs && provideDefinition(unit.stText, abs, index, uri);
    const target = def && def.range ? absoluteToLocal(unit.lineMap, def.range.start.line) : null;
    assert(!!target && target.pane === 'decl' && target.localLine0 === 5 && def.range.start.character === 4,
        `definition: nCount after the nested comments resolves to decl line 6 col 5 (got ${JSON.stringify(target)} char ${def && def.range && def.range.start.character})`);

    const checkUnit = buildCheckUnit(parseTwinCatXml(XML));
    assert(!!checkUnit && /END_FUNCTION_BLOCK/.test(checkUnit.stText) && !/END_FUNCTION\s*$/m.test(checkUnit.stText.replace(/END_FUNCTION_BLOCK/g, '')),
        'checkUnit: the FUNCTION word in the outer part of the header comment does not decide the closing keyword');
}

console.log(errors === 0 ? '\nAll nested-comment tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
