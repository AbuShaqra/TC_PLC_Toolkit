/**
 * @file test_region_pragmas.js
 * @description Region pragmas in a VAR block are metadata, and must stay metadata.
 *
 * The reported symptom was declarations inside `{region "..."}` going red with no IntelliSense. Two
 * separate defects produced it, and only one of them is here:
 *
 *   - The **webview's** Monarch tokenizer had no pragma rule, so the apostrophe in a real TwinCAT
 *     label like `{region "Motion FB's"}` opened a string state that ran to the next quote in the
 *     document — and Monaco switches quick suggestions off inside strings. Fixed in media/editor.js.
 *     That half is no longer untested: `test_pragmas.js` replays the tokenizer's rules (and asserts
 *     their ORDER, which is what makes the categories reachable), and
 *     `scratch/peek_harness/run_pragmas.js` runs Monaco's own tokenizer in a browser.
 *
 *   - The **lexer** scanned `{` to the next `}` *anywhere in the file*, newlines included. While the
 *     user typed `{region "Inputs"` — `{` is not auto-closed — the rest of the VAR block was
 *     swallowed into one Pragma token, every declaration below it disappeared from the symbol table,
 *     and each 300 ms re-diagnose flashed them red as "is not declared". That is what this guards.
 *
 * Classification, the pragma catalogs, folding and the two grammars live in `test_pragmas.js`.
 */

const { tokenize, TokenType, parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { provideDiagnostics, provideCompletions } = require('../src/lsp/features');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Indexes a POU and returns its variable names plus its diagnostics. */
function analyze(code) {
    clearWorkspaceIndex();
    const uri = 'file:///x/FB_Example.st';
    parseAndIndexDocument(code, uri);
    const index = getWorkspaceSymbolIndex();
    const node = index['FB_Example'] || { variables: [] };
    return {
        vars: node.variables.map(v => v.name),
        diags: provideDiagnostics(code, index, uri),
        index,
        uri
    };
}

const body = `END_VAR
bStart := TRUE;
nCount := 1;
bDone := FALSE;
`;

// TwinCAT writes region labels in double quotes, single quotes, or with an apostrophe inside — the
// last is what broke the webview, and it must not disturb the lexer either.
const LABELS = ['{region "Inputs"}', "{region 'Inputs'}", `{region "Motion FB's"}`, '{region}', '{IF defined(X)}'];

console.log('--- a region pragma leaves the declarations around it alone ---');
for (const label of LABELS) {
    const { vars, diags } = analyze(`FUNCTION_BLOCK FB_Example
VAR
    ${label}
    bStart : BOOL;
    nCount : INT;
    {endregion}
    bDone : BOOL;
${body}`);
    assert(vars.join(',') === 'bStart,nCount,bDone' && diags.length === 0,
        `${label.padEnd(24)} -> vars [${vars.join(', ')}], ${diags.length} diagnostics`);
}

console.log('\n--- an unterminated "{" must not swallow the block below it ---');

// Mid-typing: `{` is not auto-closed, so this is what the buffer looks like for as long as it takes
// the user to type the label. It must not delete their declarations.
const halfTyped = analyze(`FUNCTION_BLOCK FB_Example
VAR
    {region "Inputs"
    bStart : BOOL;
    nCount : INT;
    {endregion}
    bDone : BOOL;
${body}`);
assert(halfTyped.vars.join(',') === 'bStart,nCount,bDone',
    `a half-typed pragma keeps every declaration (got [${halfTyped.vars.join(', ')}])`);
assert(halfTyped.diags.length === 0,
    `...and raises no "is not declared" (got ${halfTyped.diags.length}: ${halfTyped.diags.map(d => d.message).join(' | ')})`);

const toks = tokenize(`VAR
    {region "Inputs"
    bStart : BOOL;
END_VAR`).filter(t => t.type === TokenType.Pragma);
assert(toks.length === 1 && !toks[0].value.includes('\n'),
    `the pragma token stops at the end of its line (got ${JSON.stringify(toks.map(t => t.value))})`);

console.log('\n--- completion still works at a caret inside a region ---');
const { index, uri } = analyze(`FUNCTION_BLOCK FB_Example
VAR
    {region "Motion FB's"}
    bStart : BOOL;
    nCount : INT;
    {endregion}
    bDone : BOOL;
${body}`);
const items = provideCompletions(`FUNCTION_BLOCK FB_Example
VAR
    {region "Motion FB's"}
    bStart : BOOL;
    nCount : IN
    {endregion}
END_VAR
`, { line: 4, character: 15 }, index, uri);
assert(items.some(i => i.label === 'INT'),
    `a type caret inside a region completes types (got ${items.length} items)`);

console.log(`\n--- REGION PRAGMA TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
