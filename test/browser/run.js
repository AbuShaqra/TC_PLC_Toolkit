/**
 * @file test/browser/run.js
 * @description The automated pass over media/editor.js — builds the harness, serves it, drives a
 * real Chromium through Find References, and asserts what the references peek does.
 *
 * This exists because media/editor.js is the one part of the codebase no Node test can reach, and
 * it is where the peek actually lives. Everything asserted here was found by hand first; encoding
 * it means the next change to the webview does not have to be.
 *
 * NOT part of `npm test`: it needs a browser, and CI has no reason to carry one. Playwright is
 * therefore an OPTIONAL, unsaved dependency — install it only when you want to run this:
 *
 *     npm i --no-save playwright        # the package (browsers usually already present)
 *     npx playwright install chromium   # only if the browser itself is missing
 *     node test/browser/run.js
 *
 * Exit codes: 0 pass, 1 an assertion failed, 2 cannot run (no Playwright / no browser).
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const PORT = Number(process.env.HARNESS_PORT || 8123);
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

(async () => {
    // 1. Build the page for THIS origin. Spawned rather than required so the origin, which is baked
    //    into the generated html, cannot disagree with the port the server ends up on.
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

    // HARNESS_CHROMIUM lets a container point at a preinstalled Chromium (e.g.
    // /opt/pw-browsers/chromium) instead of the build this playwright package wants to
    // download — the download is what fails on an offline or image-based runner.
    const browser = await chromium.launch(
        process.env.HARNESS_CHROMIUM ? { executablePath: process.env.HARNESS_CHROMIUM } : {});
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        await page.goto(served.url, { waitUntil: 'load' });

        // 2. Boot the webview with the sample document, exactly as the extension's `init` does.
        const boot = await page.evaluate(async () => {
            const fixture = await (await fetch('/harness/fixture.json')).json();
            window.__harnessInit(fixture);
            await new Promise(r => setTimeout(r, 800));
            const decl = monaco.editor.getEditors()
                .find(e => e.getModel() && /FUNCTION_BLOCK\s+FB_Cylinder/.test(e.getModel().getLineContent(1)));
            return { expect: fixture.expect, editors: monaco.editor.getEditors().length, declFound: !!decl };
        });
        assert(boot.declFound && boot.editors === 2,
            `the real editor.js boots the sample document into two panes (editors=${boot.editors})`);

        // 3. Find References on the FB's own name — the case that used to show one hit.
        const peek = await page.evaluate(async () => {
            const decl = monaco.editor.getEditors()
                .find(e => e.getModel() && /FUNCTION_BLOCK\s+FB_Cylinder/.test(e.getModel().getLineContent(1)));
            const line = decl.getModel().getLineContent(1);
            decl.focus();
            decl.setPosition({ lineNumber: 1, column: line.indexOf('FB_Cylinder') + 3 });
            decl.trigger('harness', 'editor.action.referenceSearch.trigger', {});
            await new Promise(r => setTimeout(r, 1500));
            const widget = document.querySelector('.reference-zone-widget');
            return {
                widgetPresent: !!widget,
                title: widget ? widget.querySelector('.head .peekview-title').innerText.replace(/\s+/g, ' ').trim() : '',
                rows: Array.from(document.querySelectorAll('.reference-zone-widget .monaco-list-row'))
                    .map(r => r.innerText.replace(/\s+/g, ' ').trim()),
                peekModels: monaco.editor.getModels().filter(m => m.uri.scheme === 'twincat-peek').map(m => m.uri.path)
            };
        });

        assert(peek.widgetPresent, 'the peek widget opens');
        assert(/References \(3\)/.test(peek.title),
            `all three references reach the peek, not just the local one (title: ${JSON.stringify(peek.title)})`);
        assert(peek.rows.some(r => /FB_Station\.TcPOU/.test(r)) && peek.rows.some(r => /GVL_System\.TcGVL/.test(r)),
            `both cross-file hits are listed (rows: ${JSON.stringify(peek.rows)})`);
        // Monaco renders basename prominent + dirname dimmed, so the FILE must come first in a row.
        assert(peek.rows.some(r => /^FB_Station\.TcPOU/.test(r)),
            `a group row leads with the file, not with "root.decl" (rows: ${JSON.stringify(peek.rows)})`);
        // The third reference is in the ACTIVE component, so it must use the live pane — one model
        // per cross-file pane and no more. This is the live-model preference, not just the fallback.
        assert(peek.peekModels.length === 2,
            `exactly the two non-live panes get hidden models (${JSON.stringify(peek.peekModels)})`);

        // 4. Expand the FB_Station group and select its occurrence: the preview must show that
        //    file's real declaration, which is only possible if the hidden model holds its text.
        // Short timeouts on purpose: when the peek regresses, these rows simply are not there, and a
        // 30 s default turns a clear failure into a hang.
        const CLICK = { timeout: 5000 };
        await page.locator(".reference-zone-widget .monaco-list-row:has-text('FB_Station.TcPOU')").click(CLICK);
        const occurrence = ".reference-zone-widget .monaco-list-row:has-text('REFERENCE TO FB_Cylinder;')";
        await page.locator(occurrence).click(CLICK);
        // Monaco paints the preview asynchronously — reading it straight after the click returns an
        // empty editor and fails an assertion the product actually satisfies. Wait for content.
        await page.waitForFunction(() => {
            const p = document.querySelector('.reference-zone-widget .preview .monaco-editor');
            return !!p && p.innerText.trim().length > 0;
        }, null, { timeout: 5000 }).catch(() => { /* fall through: the assertion reports what it saw */ });
        const preview = await page.evaluate(() => {
            const p = document.querySelector('.reference-zone-widget .preview .monaco-editor');
            const t = document.querySelector('.reference-zone-widget .head .peekview-title');
            return {
                text: p ? p.innerText.replace(/\s+/g, ' ').trim() : '',
                title: t ? t.innerText.replace(/\s+/g, ' ').trim() : ''
            };
        });
        assert(/FUNCTION_BLOCK FB_Station/.test(preview.text),
            `the preview renders the OTHER file's declaration (got ${JSON.stringify(preview.text.slice(0, 80))})`);
        assert(/FB_Station\.TcPOU/.test(preview.title), `the preview is titled with that file (${preview.title})`);

        // 5. Opening it must post the exact occurrence, not a word search — and the columns it sends
        //    must actually address that word in the pane text the extension shipped.
        await page.locator(occurrence).dblclick(CLICK);
        const opened = await page.evaluate(() => {
            const msg = window.__harness.sent.filter(m => m.type === 'openFile').pop();
            if (!msg) return { msg: null };
            const pane = window.__harness.fixture.panes.find(p =>
                p.uri === msg.fileUri && p.componentId === msg.componentId && p.pane === msg.range.pane);
            const line = pane ? pane.text.split('\n')[msg.range.localLine] : null;
            return {
                msg,
                word: line === null || line === undefined ? null : line.substring(msg.range.start.character, msg.range.end.character)
            };
        });
        assert(opened.msg && opened.msg.range && opened.msg.range.pane === 'decl',
            `double-clicking a peek entry posts openFile for the right pane (${JSON.stringify(opened.msg && opened.msg.range)})`);
        assert(opened.word === 'FB_Cylinder',
            `the coordinates it sends land on the word itself, not the first same-named one (got ${JSON.stringify(opened.word)})`);

        // 5b. Go to Definition must land on the DECLARATION, not on the first occurrence of the name.
        //
        // User-reported: F12 on an FB's `bDone` jumped into the forty-line header comment above the
        // declarations, which says "…until bDone or bError". The LSP was right the whole time; the
        // webview threw the location away and searched the declaration pane for the word, taking
        // match [0]. The fixture reproduces that shape — build.js splices a comment naming
        // `_bExtended` above the VAR block, so the decoy sits on an earlier line of the same pane —
        // and the payload the stub answers with is what the real host would send for it.
        const gotoDef = await page.evaluate(async () => {
            window.__harness.definitionEnabled = true;
            const live = () => monaco.editor.getEditors().filter(e => e.getModel() && e.getModel().uri.scheme === 'inmemory');
            const decl = live().find(e => /FUNCTION_BLOCK\s+FB_Cylinder/.test(e.getModel().getLineContent(1)));
            const impl = live().find(e => e !== decl);
            // Jump from a usage in the OTHER pane, which is how the bug was hit.
            const implModel = impl.getModel();
            let callLine = 1;
            for (let i = 1; i <= implModel.getLineCount(); i++) {
                if (/Cyclic\(\)/.test(implModel.getLineContent(i))) { callLine = i; break; }
            }
            impl.focus();
            impl.setPosition({ lineNumber: callLine, column: 3 });
            // trigger(), not getAction(): the goto action is a command contribution and getAction
            // does not list it — the same reason closeReferencePeek uses trigger in editor.js.
            impl.trigger('harness', 'editor.action.revealDefinition', {});
            await new Promise(r => setTimeout(r, 1200));
            const sel = decl.getSelection();
            window.__harness.definitionEnabled = false;
            return {
                expect: window.__harness.fixture.expect.definition,
                line: sel ? sel.startLineNumber : null,
                selected: sel ? decl.getModel().getValueInRange(sel) : null,
                lineText: sel ? decl.getModel().getLineContent(sel.startLineNumber) : null
            };
        });
        assert(gotoDef.expect.decoyLine < gotoDef.expect.declarationLine,
            `the fixture really has the bug's shape: ${gotoDef.expect.word} appears in a comment on decl line ` +
            `${gotoDef.expect.decoyLine} and is declared on line ${gotoDef.expect.declarationLine}`);
        assert(gotoDef.line === gotoDef.expect.declarationLine + 1,
            `the jump selects the DECLARATION line ${gotoDef.expect.declarationLine + 1}, not the comment ` +
            `line ${gotoDef.expect.decoyLine + 1} (landed on ${gotoDef.line}: ${JSON.stringify(gotoDef.lineText)})`);
        assert(/^\s*_bExtended\s*,/.test(gotoDef.lineText || ''),
            `and that line is the declaration itself (${JSON.stringify(gotoDef.lineText)})`);
        assert(gotoDef.selected === gotoDef.expect.word,
            `with the symbol selected, not a fragment (${JSON.stringify(gotoDef.selected)})`);

        // 6. A second search that needs only one of the panes must retire the other. Models are
        //    heavy; the whole point of retiring by set difference is that nothing accumulates.
        const retired = await page.evaluate(async () => {
            const before = monaco.editor.getModels().filter(m => m.uri.scheme === 'twincat-peek').map(m => m.uri.path).sort();
            const f = window.__harness.fixture;
            const keep = f.panes.find(p => /GVL_System/.test(p.path));
            window.__harness.fixture = { ...f, references: f.references.filter(r => r.paneKey === keep.key), panes: [keep] };
            const decl = monaco.editor.getEditors()
                .find(e => e.getModel() && e.getModel().uri.scheme === 'inmemory'
                    && /FUNCTION_BLOCK\s+FB_Cylinder/.test(e.getModel().getLineContent(1)));
            decl.focus();
            decl.setPosition({ lineNumber: 1, column: 20 });
            decl.trigger('harness', 'editor.action.referenceSearch.trigger', {});
            await new Promise(r => setTimeout(r, 1500));
            const after = monaco.editor.getModels().filter(m => m.uri.scheme === 'twincat-peek').map(m => m.uri.path).sort();
            return { before, after, total: monaco.editor.getModels().length };
        });
        assert(retired.before.length === 2 && retired.after.length === 1,
            `a pane the new result set does not need is retired (${retired.before.length} -> ${retired.after.length})`);
        assert(/GVL_System/.test(retired.after[0] || ''),
            `and the one still in use survives (kept ${JSON.stringify(retired.after)})`);
        assert(retired.total === 3,
            `no models accumulate: two live panes + one peek (total ${retired.total})`);

        // 7. Switching component with a peek open must DISMISS it (user-reported: "the view lands on
        //    the correct occurrence but the arrow on top of the peek window disappears"). The arrow
        //    is a decoration and loadComponent's setValue resets the model, dropping it; the zone
        //    widget is not a decoration and survived — leaving a peek with no arrow, hovering over
        //    content that had been replaced underneath it. Monaco dismisses a peek itself when a
        //    reference is opened in the same editor, but cannot here: the navigation round-trips
        //    through the extension host, so Monaco never learns it happened.
        const stale = await page.evaluate(async () => {
            const fixture = await (await fetch('/harness/fixture.json')).json();
            window.__harness.fixture = fixture;   // the retirement step above narrowed it
            const decl = monaco.editor.getEditors()
                .find(e => e.getModel() && e.getModel().uri.scheme === 'inmemory'
                    && /FUNCTION_BLOCK\s+FB_Cylinder/.test(e.getModel().getLineContent(1)));
            decl.focus();
            decl.setPosition({ lineNumber: 1, column: decl.getModel().getLineContent(1).indexOf('FB_Cylinder') + 3 });
            decl.trigger('harness', 'editor.action.referenceSearch.trigger', {});
            await new Promise(r => setTimeout(r, 1500));
            const arrowSel = '.monaco-editor .cdr[class*="arrow-decoration"]';
            const before = {
                widget: !!document.querySelector('.zone-widget'),
                arrow: !!document.querySelector(arrowSel)
            };
            // Exactly what the extension sends back after twincat.openComponent for this file.
            window.postMessage({ type: 'selectComponent', id: 'method_Cyclic' }, '*');
            await new Promise(r => setTimeout(r, 900));
            return {
                before,
                after: {
                    widget: !!document.querySelector('.zone-widget'),
                    arrow: !!document.querySelector(arrowSel)
                }
            };
        });
        assert(stale.before.widget && stale.before.arrow,
            `the peek opens with its arrow (${JSON.stringify(stale.before)})`);
        assert(!stale.after.widget,
            `switching component dismisses the peek instead of orphaning it (${JSON.stringify(stale.after)})`);
        assert(!stale.after.arrow,
            'and no arrow decoration is left behind pointing at replaced content');

        // 8. Nothing may have thrown along the way — "Model not found" is the failure this whole
        //    design exists to make unreachable, and it surfaces as a console error.
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
    console.log('\nAll references-peek webview assertions passed.');
})().catch(err => {
    console.error('[FAIL] harness crashed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
