/**
 * @file scratch/peek_harness/run_pragmas.js
 * @description The browser pass over pragma handling in media/editor.js: `{region}` folding and the
 * Monarch pragma rules, driven through a real Monaco in Chromium.
 *
 * Shares `build.js` / `serve.js` with `run.js` (the references-peek pass) — the directory name is
 * historical; it is the webview's browser harness generally.
 *
 * Two things here cannot be checked from Node, and both fail silently if they are wrong:
 *
 *   1. **Folding works by declaration, not by code.** The panes get `folding.markers` on the `iecst`
 *      language configuration and nothing else. That relies on Monaco falling back to its indentation
 *      range provider — which honours markers — because no FoldingRangeProvider is registered for the
 *      language. If that assumption is ever wrong, every unit test still passes and no region folds.
 *      The fixture below is deliberately written with NO indentation inside the VAR block, so an
 *      indentation-derived range cannot account for the fold: if lines collapse, the marker did it.
 *
 *   2. **Monaco's own tokenizer agrees with the rules we wrote.** `test_pragmas.js` re-implements the
 *      Monarch matcher to check rule order; this runs the actual tokenizer. It is the direct test of
 *      the invariant the rules exist for — the apostrophe in `{region "Motion FB's"}` must not open a
 *      string that swallows the declarations below it.
 *
 * NOT part of `npm test`: it needs a browser. Playwright is an optional, unsaved dependency.
 *
 *     npm i --no-save playwright        # the package (browsers usually already present)
 *     npx playwright install chromium   # only if the browser itself is missing
 *     node scratch/peek_harness/run_pragmas.js
 *
 * Exit codes: 0 pass, 1 an assertion failed, 2 cannot run (no Playwright / no browser).
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const PORT = Number(process.env.HARNESS_PORT || 8124);
const ORIGIN = `http://localhost:${PORT}`;

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch (e) {
    console.error('[SKIP] playwright is not installed — this harness needs a browser.');
    console.error('       npm i --no-save playwright && npx playwright install chromium');
    process.exit(2);
}

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// Flat on purpose — see the header. Line numbers are 1-based and referenced by the assertions.
//  1 FUNCTION_BLOCK FB_Fold
//  2 VAR
//  3 {region "Inputs"}
//  4 bStart : BOOL;
//  5 bStop : BOOL;
//  6 {endregion}
//  7 bOutside : BOOL;
//  8 END_VAR
const DECL = [
    'FUNCTION_BLOCK FB_Fold',
    'VAR',
    '{region "Inputs"}',
    'bStart : BOOL;',
    'bStop : BOOL;',
    '{endregion}',
    'bOutside : BOOL;',
    'END_VAR'
].join('\n');

// Nested regions are documented as supported ("Region pragmas can be nested"), and marker folding
// stacks them. Folding the OUTER one must take the inner block with it.
//  1 VAR
//  2 {region "Outer"}
//  3 bA : BOOL;
//  4 {region "Inner"}
//  5 bB : BOOL;
//  6 {endregion}
//  7 bC : BOOL;
//  8 {endregion}
//  9 bD : BOOL;
// 10 END_VAR
const NESTED = [
    'VAR',
    '{region "Outer"}',
    'bA : BOOL;',
    '{region "Inner"}',
    'bB : BOOL;',
    '{endregion}',
    'bC : BOOL;',
    '{endregion}',
    'bD : BOOL;',
    'END_VAR'
].join('\n');

(async () => {
    const built = spawnSync(process.execPath, [path.join(HERE, 'build.js')], {
        env: { ...process.env, HARNESS_ORIGIN: ORIGIN },
        encoding: 'utf8'
    });
    if (built.status !== 0) {
        console.error('[FAIL] harness build failed:\n' + (built.stderr || built.stdout));
        process.exit(1);
    }
    console.log(built.stdout.trim());

    const { start } = require('./serve.js');
    let served;
    try {
        served = await start(PORT);
    } catch (e) {
        console.error(`[FAIL] cannot serve on ${PORT} (${e.code}). Set HARNESS_PORT to a free port.`);
        process.exit(1);
    }

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        await page.goto(served.url, { waitUntil: 'load' });

        const boot = await page.evaluate(async () => {
            const fixture = await (await fetch('/harness/fixture.json')).json();
            window.__harnessInit(fixture);
            await new Promise(r => setTimeout(r, 800));
            return { editors: monaco.editor.getEditors().length };
        });
        assert(boot.editors === 2, `the real editor.js boots two panes (editors=${boot.editors})`);

        // ---------------------------------------------------------------- the language configuration
        const config = await page.evaluate(() => {
            // Monaco keeps no public getter for a language configuration, so read back what folding
            // actually does instead — see the fold assertions below. What CAN be read here is that
            // no FoldingRangeProvider was registered for iecst, which is the precondition for marker
            // folding to be reachable at all.
            const reg = monaco.languages;
            return { hasFoldingProviderApi: typeof reg.registerFoldingRangeProvider === 'function' };
        });
        assert(config.hasFoldingProviderApi, 'Monaco exposes the folding API this feature depends on');

        // ---------------------------------------------------------------- 1. a region folds
        const folded = await page.evaluate(async (decl) => {
            const ed = monaco.editor.getEditors()[0];
            ed.getModel().setValue(decl);
            await new Promise(r => setTimeout(r, 500));   // folding ranges are computed asynchronously
            const rendered = () => ed.getDomNode().querySelector('.view-lines').innerText;
            const before = rendered();
            ed.setPosition({ lineNumber: 3, column: 1 });
            await ed.getAction('editor.fold').run();
            await new Promise(r => setTimeout(r, 300));
            return { before, after: rendered() };
        }, DECL);

        assert(/bStart/.test(folded.before) && /bStop/.test(folded.before), 'the variables render before folding');
        assert(!/bStart/.test(folded.after) && !/bStop/.test(folded.after),
            `folding at the {region} line hides the variables inside it (after: ${JSON.stringify(folded.after)})`);
        assert(/region/.test(folded.after), 'the {region} line itself stays visible — it is the fold header');
        assert(/bOutside/.test(folded.after), 'a variable AFTER {endregion} is not swallowed by the fold');
        assert(/END_VAR/.test(folded.after), 'and END_VAR still renders');

        // ---------------------------------------------------------------- 2. nesting
        const nested = await page.evaluate(async (text) => {
            const ed = monaco.editor.getEditors()[0];
            ed.getModel().setValue(text);
            await new Promise(r => setTimeout(r, 500));
            const rendered = () => ed.getDomNode().querySelector('.view-lines').innerText;
            ed.setPosition({ lineNumber: 4, column: 1 });          // the INNER region
            await ed.getAction('editor.fold').run();
            await new Promise(r => setTimeout(r, 300));
            const inner = rendered();
            ed.setPosition({ lineNumber: 2, column: 1 });          // the OUTER region
            await ed.getAction('editor.fold').run();
            await new Promise(r => setTimeout(r, 300));
            return { inner, outer: rendered() };
        }, NESTED);

        assert(!/bB/.test(nested.inner) && /bA/.test(nested.inner) && /bC/.test(nested.inner),
            `folding the inner region hides only its own lines (${JSON.stringify(nested.inner)})`);
        assert(!/bA/.test(nested.outer) && !/bB/.test(nested.outer) && !/bC/.test(nested.outer),
            `folding the outer region takes the nested one with it (${JSON.stringify(nested.outer)})`);
        assert(/bD/.test(nested.outer), 'and stops at its own {endregion}');

        // ---------------------------------------------------------------- 3. the real tokenizer
        const tokens = await page.evaluate(() => {
            const scopes = (text) => monaco.editor.tokenize(text, 'iecst')
                .map(line => line.map(t => ({ offset: t.offset, type: t.type })));
            return {
                region: scopes('{region "Motion FB\'s"}\nbDone : BOOL;'),
                endregion: scopes('{endregion}'),
                conditional: scopes('{IF defined (Variant1)}'),
                message: scopes("{info 'TODO: rename'}"),
                documented: scopes("{attribute 'qualified_only'}"),
                userDefined: scopes("{attribute 'MyCompany_Unknown'}"),
                halfTyped: scopes('{region "Inputs"\nbDone : BOOL;')
            };
        });

        const only = lineTokens => lineTokens.length === 1 ? lineTokens[0].type : lineTokens.map(t => t.type).join('+');
        assert(only(tokens.region[0]) === 'annotation.region.iecst',
            `Monaco scopes a region pragma as annotation.region (got ${only(tokens.region[0])})`);
        assert(only(tokens.endregion[0]) === 'annotation.region.iecst',
            `…and {endregion} the same (got ${only(tokens.endregion[0])})`);
        assert(only(tokens.conditional[0]) === 'annotation.conditional.iecst',
            `{IF …} scopes as annotation.conditional (got ${only(tokens.conditional[0])})`);
        assert(only(tokens.message[0]) === 'annotation.message.iecst',
            `{info …} scopes as annotation.message (got ${only(tokens.message[0])})`);
        assert(only(tokens.documented[0]) === 'annotation.iecst',
            `an attribute pragma scopes as annotation (got ${only(tokens.documented[0])})`);
        assert(only(tokens.userDefined[0]) === only(tokens.documented[0]),
            'a user-defined attribute is scoped identically to a documented one — colour comes from shape, not the catalog');

        // The invariant the whole rule set exists for, checked against the real tokenizer: the
        // apostrophe in `Motion FB's` must not put the NEXT line into a string state.
        assert(!tokens.region[1].some(t => /string/.test(t.type)),
            `the line below a region with an apostrophe is not string-scoped (got ${JSON.stringify(tokens.region[1])})`);
        assert(!tokens.halfTyped[1].some(t => /string/.test(t.type)),
            `nor is the line below a HALF-TYPED region (got ${JSON.stringify(tokens.halfTyped[1])})`);
        assert(only(tokens.halfTyped[0]) === 'annotation.region.iecst',
            `a half-typed region still scopes as a pragma (got ${only(tokens.halfTyped[0])})`);

        // ---------------------------------------------------------------- 4. nothing threw
        assert(consoleErrors.length === 0,
            `the browser reported no errors (${consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 3)) : 'none'})`);

        if (process.env.HARNESS_SHOT) {
            await page.screenshot({ path: process.env.HARNESS_SHOT });
            console.log('screenshot written to ' + process.env.HARNESS_SHOT);
        }
    } finally {
        await browser.close();
        served.server.close();
    }

    if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
    console.log('\nAll pragma webview assertions passed.');
})().catch(err => {
    console.error('[FAIL] harness crashed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
