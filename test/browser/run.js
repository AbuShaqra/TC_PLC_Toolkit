/**
 * @file test/browser/run.js
 * @description The automated pass over media/editor.js — builds the harness, serves it, drives a
 * real Chromium through Find References, and asserts what the references peek does — plus the
 * Generate ST menu and Compile Project's pane markers (owner 'twincat-compile'), and the Compile
 * dropdown's two C++ switches (R13).
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

        // 3b. The peek must not trip the page's own error overlay. editor.js paints "Webview Runtime
        //     Failure" over both panes (and posts `error` to the host, which toasts it) for ANY
        //     window error event — and Chrome delivers its benign "ResizeObserver loop completed with
        //     undelivered notifications" notice as exactly that when Monaco's automaticLayout
        //     observer reacts to the peek zone opening. Found by the 2026-08-26 screenshot run: every
        //     Find References ended in a red screen. Whether the loop notice fires naturally depends
        //     on layout timing, so after reading what the real peek did, the exact Chrome message is
        //     also dispatched by hand — that probe is the deterministic half of this assertion.
        const overlayProbe = async () => page.evaluate(() => {
            const el = document.getElementById('error-overlay');
            return {
                shown: !!el && el.style.display !== 'none',
                text: el ? el.innerText.replace(/\s+/g, ' ').slice(0, 100) : '',
                errorsPosted: window.__harness.sent.filter(m => m && m.type === 'error').map(m => m.message)
            };
        });
        const afterPeek = await overlayProbe();
        assert(!afterPeek.shown && afterPeek.errorsPosted.length === 0,
            `opening the peek leaves the error overlay hidden and posts no error ` +
            `(overlay: ${JSON.stringify(afterPeek.text)}, posted: ${JSON.stringify(afterPeek.errorsPosted)})`);
        await page.evaluate(() => {
            window.dispatchEvent(new ErrorEvent('error', {
                message: 'ResizeObserver loop completed with undelivered notifications.',
                filename: location.href, lineno: 0, colno: 0
            }));
        });
        const afterNotice = await overlayProbe();
        assert(!afterNotice.shown && afterNotice.errorsPosted.length === 0,
            `Chrome's ResizeObserver loop notice is not treated as a webview failure ` +
            `(overlay: ${JSON.stringify(afterNotice.text)}, posted: ${JSON.stringify(afterNotice.errorsPosted)})`);
        // And a REAL error must still reach both surfaces — the guard is a filter, not a mute.
        await page.evaluate(() => {
            window.dispatchEvent(new ErrorEvent('error', {
                message: 'Uncaught TypeError: harness probe', filename: location.href, lineno: 1, colno: 1
            }));
        });
        const afterReal = await overlayProbe();
        assert(afterReal.shown && afterReal.errorsPosted.some(m => /harness probe/.test(m)),
            `a genuine runtime error still shows the overlay and is posted to the host ` +
            `(shown: ${afterReal.shown}, posted: ${JSON.stringify(afterReal.errorsPosted)})`);
        await page.evaluate(() => { document.getElementById('error-overlay').style.display = 'none'; });

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
                activeChanges: window.__harness.sent
                    .filter(m => m.type === 'activeComponentChanged')
                    .map(m => m.componentId),
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
        assert(stale.activeChanges.includes('method_Cyclic'),
            `loading a component reports its exact id to the extension host (${JSON.stringify(stale.activeChanges)})`);

        // 7b. Generate ST split button (roadmap R1): with one project the caret is hidden, and the main
        //     button must keep its rounded right end; with two or more the caret shows and the inner
        //     corners are squared so the two fuse. The bug was the squaring applying in both cases.
        // .action-btn animates its radius; measure the end state, not a frame mid-transition.
        await page.addStyleTag({ content: '#generate-st-group * { transition: none !important; }' });
        const corners = async (projects) => {
            await page.evaluate((p) => window.postMessage({ type: 'projectList', projects: p }, '*'), projects);
            await page.waitForTimeout(50);
            return page.evaluate(() => {
                const btn = document.getElementById('generate-st-btn');
                const caret = document.getElementById('generate-st-caret');
                const cs = getComputedStyle(btn);
                return { right: cs.borderTopRightRadius, left: cs.borderTopLeftRadius, caretShown: !caret.hidden };
            });
        };
        const one = await corners([{ key: 'a', label: 'PLC_A' }]);
        assert(!one.caretShown && one.right === one.left && one.right !== '0px',
            `one project: caret hidden and Generate ST keeps its rounded right end (${JSON.stringify(one)})`);
        const two = await corners([{ key: 'a', label: 'PLC_A' }, { key: 'b', label: 'PLC_B' }]);
        assert(two.caretShown && two.right === '0px' && two.left !== '0px',
            `two projects: caret shown and the inner corners are squared to fuse with it (${JSON.stringify(two)})`);
        const back = await corners([{ key: 'a', label: 'PLC_A' }]);
        assert(!back.caretShown && back.right === back.left,
            `back to one project: the rounded end returns (${JSON.stringify(back)})`);

        // 7c. The project menu stays inside a narrow webview. It was right-aligned to the caret, so a
        //     narrow editor clipped its left half, and a long project name added a sideways scrollbar.
        const viewport = page.viewportSize();
        const menuFit = async (width) => {
            await page.setViewportSize({ width, height: viewport.height });
            await page.evaluate(() => window.postMessage({ type: 'projectList', projects: [
                { key: 'a', label: 'PLC_' + 'VeryLongProjectName_'.repeat(4) + 'A' },
                { key: 'b', label: 'PLC_B' }
            ] }, '*'));
            await page.waitForTimeout(50);
            await page.click('#generate-st-caret');
            await page.waitForTimeout(50);
            const r = await page.evaluate(() => {
                const menu = document.getElementById('generate-st-menu');
                const list = document.getElementById('generate-st-projects');
                const rect = menu.getBoundingClientRect();
                const first = list.querySelector('.split-menu-item');
                return {
                    open: !menu.hidden, left: Math.round(rect.left), right: Math.round(rect.right),
                    width: window.innerWidth, sideScroll: list.scrollWidth > list.clientWidth,
                    tooltip: first ? first.title : ''
                };
            });
            await page.click('#generate-st-caret'); // close again
            return r;
        };
        for (const width of [360, 560, 1200]) {
            const fit = await menuFit(width);
            assert(fit.open && fit.left >= 0 && fit.right <= fit.width && !fit.sideScroll && fit.tooltip.length > 40,
                `at ${width}px the project menu is fully inside the webview, without a sideways scrollbar, and a cut name keeps its tooltip (${JSON.stringify(fit)})`);
        }
        await page.setViewportSize(viewport);

        // 7d. Select all: a tri-state box over the project list. Unticking it clears every project and
        //     disables "Generate selected"; one project ticked makes it indeterminate; ticking it again
        //     selects all, and the run then posts every project key.
        await page.evaluate(() => window.postMessage({ type: 'projectList', projects: [
            { key: 'a', label: 'PLC_A' }, { key: 'b', label: 'PLC_B' }, { key: 'c', label: 'PLC_C' }
        ] }, '*'));
        await page.waitForTimeout(50);
        await page.click('#generate-st-caret');
        await page.waitForTimeout(50);
        const allState = () => page.evaluate(() => {
            const all = document.getElementById('generate-st-all');
            const boxes = Array.from(document.querySelectorAll('#generate-st-projects input[type="checkbox"]'));
            return {
                all: all.checked, mixed: all.indeterminate,
                ticked: boxes.filter(b => b.checked).length,
                runDisabled: document.getElementById('generate-st-run').disabled
            };
        });
        const fresh = await allState();
        assert(fresh.all && !fresh.mixed && fresh.ticked === 3 && !fresh.runDisabled,
            `a fresh project list starts with Select all ticked and every project selected (${JSON.stringify(fresh)})`);
        await page.click('#generate-st-all');
        const none = await allState();
        assert(!none.all && !none.mixed && none.ticked === 0 && none.runDisabled,
            `unticking Select all clears every project and disables Generate selected (${JSON.stringify(none)})`);
        await page.click('#generate-st-projects .split-menu-item:nth-child(2) input');
        const mixed = await allState();
        assert(mixed.mixed && mixed.ticked === 1 && !mixed.runDisabled,
            `one project ticked makes Select all indeterminate and enables the run (${JSON.stringify(mixed)})`);
        await page.click('#generate-st-all');
        const every = await allState();
        assert(every.all && !every.mixed && every.ticked === 3,
            `ticking Select all from the mixed state selects every project (${JSON.stringify(every)})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#generate-st-run');
        const runMsg = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'generate-st'));
        assert(runMsg.length === 1 && JSON.stringify(runMsg[0].projectKeys) === '["a","b","c"]',
            `Generate selected then posts every project key (${JSON.stringify(runMsg)})`);

        // 7e. Compile Project's markers (R3.2). The host pushes them as `compileDiagnostics`; they live
        //     under their own marker owner, so the language server's 'st-validator' markers and the
        //     compile markers never erase each other — on the shared pane models, across component
        //     switches and diagnostics refreshes. An edit to a component drops ITS compile markers
        //     (the compiler judged the old text) and tells the host, so the Problems panel follows.
        await page.keyboard.press('Escape');
        const markersNow = () => page.evaluate(() => {
            const panes = monaco.editor.getEditors().filter(e => e.getModel() && e.getModel().uri.scheme === 'inmemory');
            const byPane = (owner) => panes.map(e => monaco.editor.getModelMarkers({ owner, resource: e.getModel().uri }).map(m => m.message));
            return {
                first: panes.map(e => e.getModel().getLineContent(1)),
                compile: byPane('twincat-compile'),
                lsp: byPane('st-validator')
            };
        });
        const settle = (ms) => page.evaluate((t) => new Promise(r => setTimeout(r, t)), ms);
        await page.evaluate(() => {
            window.__harness.lspDiagnostics = [{ componentId: 'root', pane: 'decl', severity: 2, message: 'harness LSP warning',
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 15 } }];
            window.postMessage({ type: 'selectComponent', id: 'root' }, '*');
        });
        await settle(700);
        await page.evaluate(() => window.postMessage({ type: 'compileDiagnostics', diagnostics: [
            { componentId: 'root', pane: 'decl', severity: 1, message: 'harness compile error (decl)',
                range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 20 } },
            { componentId: 'root', pane: 'impl', severity: 2, message: 'harness compile warning (impl)',
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 10 } },
            { componentId: 'method_Cyclic', pane: 'impl', severity: 1, message: 'harness compile error (method)',
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 } }
        ] }, '*'));
        await settle(100);
        let mk = await markersNow();
        assert(JSON.stringify(mk.compile) === JSON.stringify([['harness compile error (decl)'], ['harness compile warning (impl)']]),
            `compileDiagnostics puts the active component's markers on its two panes, owner twincat-compile (${JSON.stringify(mk.compile)})`);
        assert(JSON.stringify(mk.lsp[0]) === JSON.stringify(['harness LSP warning']),
            `the language server's st-validator markers survive the compile markers (${JSON.stringify(mk.lsp)})`);
        await page.evaluate(() => window.postMessage({ type: 'refreshDiagnostics' }, '*'));
        await settle(700);
        mk = await markersNow();
        assert(mk.compile[0].length === 1 && mk.compile[1].length === 1 && mk.lsp[0].length === 1,
            `a diagnostics refresh keeps both owners' markers (${JSON.stringify(mk)})`);
        if (process.env.HARNESS_COMPILE_SHOT !== '') {
            const shot = process.env.HARNESS_COMPILE_SHOT || path.join(HERE, 'out', 'compile-markers.png');
            await page.screenshot({ path: shot });
            console.log('pane-marker screenshot written to ' + shot);
        }
        await page.evaluate(() => window.postMessage({ type: 'selectComponent', id: 'method_Cyclic' }, '*'));
        await settle(700);
        mk = await markersNow();
        assert(JSON.stringify(mk.compile) === JSON.stringify([[], ['harness compile error (method)']]),
            `switching component shows that component's compile markers only (${JSON.stringify(mk.compile)})`);
        await page.evaluate(() => window.postMessage({ type: 'selectComponent', id: 'root' }, '*'));
        await settle(700);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.evaluate(() => {
            const decl = monaco.editor.getEditors().find(e => e.getModel() && e.getModel().uri.scheme === 'inmemory'
                && /FUNCTION_BLOCK\s+FB_Cylinder/.test(e.getModel().getLineContent(1)));
            const model = decl.getModel();
            const end = model.getLineMaxColumn(1);
            decl.executeEdits('harness', [{ range: new monaco.Range(1, end, 1, end), text: ' ' }]);
        });
        await settle(700);
        mk = await markersNow();
        const staleMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'compileDiagnosticsStale'));
        assert(mk.compile[0].length === 0 && mk.compile[1].length === 0,
            `an edit drops the edited component's compile markers (${JSON.stringify(mk.compile)})`);
        assert(staleMsgs.length === 1 && staleMsgs[0].componentId === 'root',
            `and posts compileDiagnosticsStale for that component (${JSON.stringify(staleMsgs)})`);
        assert(mk.lsp[0].length === 1, `the st-validator markers are untouched by the edit (${JSON.stringify(mk.lsp)})`);
        await page.evaluate(() => window.postMessage({ type: 'selectComponent', id: 'method_Cyclic' }, '*'));
        await settle(700);
        mk = await markersNow();
        assert(JSON.stringify(mk.compile[1]) === JSON.stringify(['harness compile error (method)']),
            `another component's compile markers survive that edit (${JSON.stringify(mk.compile)})`);
        await page.evaluate(() => { window.__harness.lspDiagnostics = null; });

        // 7f. The toolbar's Compile button (next to Generate ST): present with its glyph, posts
        //     `compile-project` (the host resolves this file's project), is disabled while the host says
        //     a run is in progress, and both buttons stay inside a narrow editor.
        await page.addStyleTag({ content: '#compile-btn, #compile-btn * { transition: none !important; }' });
        const compileInfo = await page.evaluate(() => {
            const btn = document.getElementById('compile-btn');
            const gen = document.getElementById('generate-st-group');
            return {
                present: !!btn, glyph: !!(btn && btn.querySelector('svg.btn-icon path')),
                label: btn ? btn.getAttribute('aria-label') : '', tooltip: btn ? btn.title : '',
                // The Compile split button (R13: the button and its options caret) follows the Generate ST one.
                afterGenerate: !!(btn && gen && gen.nextElementSibling === document.getElementById('compile-group') && btn.parentElement.id === 'compile-group'),
                genTooltip: document.getElementById('generate-st-btn').title
            };
        });
        assert(compileInfo.present && compileInfo.glyph && compileInfo.label === 'Compile Project' && /Compile Project/.test(compileInfo.tooltip) &&
            compileInfo.afterGenerate && /Generate ST/.test(compileInfo.genTooltip),
            `the Compile button sits right after Generate ST, with a glyph, a name and a tooltip (${JSON.stringify(compileInfo)})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#compile-btn');
        let compileMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'compile-project'));
        assert(compileMsgs.length === 1 && Object.keys(compileMsgs[0]).join() === 'type',
            `clicking Compile posts compile-project to the host (${JSON.stringify(compileMsgs)})`);
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: true }, '*'));
        await settle(50);
        await page.evaluate(() => { window.__harness.sent.length = 0; document.getElementById('compile-btn').click(); });
        compileMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'compile-project'));
        const busy = await page.evaluate(() => ({ disabled: document.getElementById('compile-btn').disabled, aria: document.getElementById('compile-btn').getAttribute('aria-busy') }));
        assert(busy.disabled && busy.aria === 'true' && compileMsgs.length === 0, `while a run is in progress the button is disabled and posts nothing (${JSON.stringify(busy)})`);
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: false }, '*'));
        await settle(50);
        assert(!(await page.evaluate(() => document.getElementById('compile-btn').disabled)), 'when the run ends the button is enabled again');

        // 7f. The Compile dropdown (R13): the caret opens two checkboxes that show the host's settings and
        //     post every change; the coupling (the g++ build needs the C++) shows at once; settings changed
        //     elsewhere arrive as `compileOptions`; it is keyboard-operable and closes on Escape / outside click.
        const opts = () => page.evaluate(() => ({
            open: !document.getElementById('compile-menu').hidden,
            expanded: document.getElementById('compile-caret').getAttribute('aria-expanded'),
            cpp: document.getElementById('compile-opt-cpp').checked, gpp: document.getElementById('compile-opt-gpp').checked,
            focus: document.activeElement ? document.activeElement.id : ''
        }));
        const optionMsgs = () => page.evaluate(() => window.__harness.sent.filter(m => m.type === 'setCompileOption'));
        let o = await opts();
        assert(!o.open && o.expanded === 'false' && !o.cpp && !o.gpp, `the Compile dropdown starts closed, both boxes off (the init message's options) (${JSON.stringify(o)})`);
        const caretInfo = await page.evaluate(() => {
            const c = document.getElementById('compile-caret');
            return { label: c.getAttribute('aria-label'), popup: c.getAttribute('aria-haspopup'), controls: c.getAttribute('aria-controls'),
                labels: [...document.querySelectorAll('#compile-menu label')].map(l => l.textContent.trim()) };
        });
        assert(caretInfo.label === 'Compile options' && caretInfo.popup === null && caretInfo.controls === 'compile-menu'
            && JSON.stringify(caretInfo.labels) === '["Generate C++","Build with g++"]',
        `the caret is a disclosure (aria-expanded/aria-controls, no aria-haspopup: its popup is checkboxes, not a menu) with two labelled boxes (${JSON.stringify(caretInfo)})`);
        const btnTitle = () => page.evaluate(() => document.getElementById('compile-btn').title);
        assert(/^Compile Project: check this PLC project with the IEC 61131-3 compiler$/.test(await btnTitle()), `with both options off the button's tooltip says it checks (${await btnTitle()})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#compile-caret');
        o = await opts();
        assert(o.open && o.expanded === 'true' && o.focus === 'compile-opt-cpp', `clicking the caret opens the menu and focuses Generate C++ (${JSON.stringify(o)})`);
        const menuBox = await page.evaluate(() => { const r = document.getElementById('compile-menu').getBoundingClientRect(); return { left: r.left, right: r.right, w: window.innerWidth }; });
        assert(menuBox.left >= 0 && menuBox.right <= menuBox.w, `the open menu stays inside the webview (${JSON.stringify(menuBox)})`);
        await page.keyboard.press('ArrowDown');
        assert((await opts()).focus === 'compile-opt-gpp', 'ArrowDown moves to Build with g++');
        await page.keyboard.press('Space');
        o = await opts();
        let om = await optionMsgs();
        assert(o.gpp && o.cpp && om.length === 1 && om[0].key === 'buildWithGpp' && om[0].value === true,
            `Space ticks Build with g++, which ticks Generate C++ too, and posts setCompileOption (${JSON.stringify(om)})`);
        assert(/write it as C\+\+ into its CPP_Files folder, and build that with g\+\+/.test(await btnTitle()), `the tooltip follows: check, write C++, build with g++ (${await btnTitle()})`);
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Space');
        o = await opts();
        om = await optionMsgs();
        assert(!o.cpp && !o.gpp && om.length === 2 && om[1].key === 'generateCpp' && om[1].value === false,
            `unticking Generate C++ unticks Build with g++ and posts it (${JSON.stringify(om)})`);
        await page.keyboard.press('Escape');
        o = await opts();
        assert(!o.open && o.expanded === 'false' && o.focus === 'compile-caret', `Escape closes the menu and returns focus to the caret (${JSON.stringify(o)})`);
        // The host's answer (or a change made in the Settings editor) is what the boxes show.
        await page.evaluate(() => window.postMessage({ type: 'compileOptions', options: { generateCpp: false, buildWithGpp: true } }, '*'));
        await settle(30);
        o = await opts();
        assert(o.cpp && o.gpp, 'a compileOptions message from the host updates the boxes live (the build shows generation on)');
        await page.evaluate(() => window.postMessage({ type: 'compileOptions', options: { generateCpp: true, buildWithGpp: false } }, '*'));
        await settle(30);
        o = await opts();
        assert(o.cpp && !o.gpp, 'and back: generation only');
        assert(/then write it as C\+\+ into its CPP_Files folder$/.test(await btnTitle()), `the tooltip follows a host update too: check, then write C++ (${await btnTitle()})`);
        await page.click('#compile-caret');
        await page.mouse.click(5, viewport.height - 5);
        assert(!(await opts()).open, 'a click elsewhere closes the menu');
        await page.click('#generate-st-caret');
        await page.click('#compile-caret');
        const both = await page.evaluate(() => ({ gen: !document.getElementById('generate-st-menu').hidden, comp: !document.getElementById('compile-menu').hidden }));
        assert(!both.gen && both.comp, `opening one split menu closes the other (${JSON.stringify(both)})`);
        await page.keyboard.press('Escape');
        await page.evaluate(() => { window.__harness.sent.length = 0; document.getElementById('compile-btn').click(); });
        compileMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'compile-project'));
        assert(compileMsgs.length === 1, 'the Compile button itself still runs Compile Project');
        const caretStyle = await page.evaluate(() => {
            const cs = (id) => getComputedStyle(document.getElementById(id));
            return { btnRight: cs('compile-btn').borderTopRightRadius, caretLeft: cs('compile-caret').borderTopLeftRadius, bg: cs('compile-caret').backgroundImage !== 'none' };
        });
        assert(caretStyle.btnRight === '0px' && caretStyle.caretLeft === '0px' && caretStyle.bg,
            `the button and its caret are fused into one themed split button, like Generate ST (${JSON.stringify(caretStyle)})`);
        if (process.env.HARNESS_TOOLBAR_SHOTS) {
            await page.click('#compile-caret');
            await settle(80);
            const shot = path.join(process.env.HARNESS_TOOLBAR_SHOTS, 'compile-menu-open.png');
            await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: viewport.width, height: 200 } });
            console.log('compile menu screenshot written to ' + shot);
            await page.keyboard.press('Escape');
        }

        // Narrow editors: both buttons stay whole and inside the webview; the page never scrolls sideways.
        await page.evaluate(() => window.postMessage({ type: 'projectList', projects: [{ key: 'a', label: 'PLC_A' }, { key: 'b', label: 'PLC_B' }] }, '*'));
        const toolbarAt = async (width) => {
            await page.setViewportSize({ width, height: viewport.height });
            await settle(80);
            return page.evaluate(() => {
                const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), top: Math.round(r.top) }; };
                const gen = document.getElementById('generate-st-btn');
                const label = document.querySelector('#compile-btn .btn-label');
                return {
                    width: window.innerWidth, gen: box('generate-st-btn'), caret: box('generate-st-caret'), compile: box('compile-btn'), compileCaret: box('compile-caret'),
                    genCut: gen.scrollWidth > gen.clientWidth, labelShown: getComputedStyle(label).display !== 'none',
                    sideScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
                };
            });
        };
        for (const width of [320, 360, 560, 700, 820, 900, 960, 1100, 1200]) {
            const t = await toolbarAt(width);
            const inside = (b) => b.width > 0 && b.left >= 0 && b.right <= t.width;
            assert(inside(t.gen) && inside(t.caret) && inside(t.compile) && inside(t.compileCaret) && t.compile.width >= 28 && t.gen.width >= 40 && !t.sideScroll,
                `at ${width}px Generate ST, its caret, Compile and its caret are all visible inside the editor, with no sideways scroll (${JSON.stringify(t)})`);
            assert(width > 1100 ? t.labelShown : !t.labelShown,
                `at ${width}px the Compile label is ${width > 1100 ? 'shown' : 'dropped to the glyph (name kept in the tooltip)'}`);
        }

        // Screenshots of the toolbar, normal and narrow, dark (the harness default) and light.
        if (process.env.HARNESS_TOOLBAR_SHOTS) {
            const light = {
                '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#333333',
                '--vscode-titleBar-activeBackground': '#dddddd', '--vscode-foreground': '#333333',
                '--vscode-dropdown-background': '#ffffff', '--vscode-dropdown-foreground': '#333333',
                '--vscode-panel-border': 'rgba(128, 128, 128, 0.35)'
            };
            for (const theme of ['dark', 'light']) {
                await page.evaluate(([th, vars]) => {
                    document.body.classList.toggle('vscode-light', th === 'light');
                    document.body.classList.toggle('vscode-dark', th === 'dark');
                    for (const [k, v] of Object.entries(vars)) {
                        if (th === 'light') document.documentElement.style.setProperty(k, v);
                        else document.documentElement.style.removeProperty(k);
                    }
                }, [theme, light]);
                for (const [name, width] of [['normal', 1200], ['narrow', 960], ['wrapped', 820], ['phone', 400]]) {
                    await page.setViewportSize({ width, height: viewport.height });
                    await settle(150);
                    const shot = path.join(process.env.HARNESS_TOOLBAR_SHOTS, `toolbar-${theme}-${name}-${width}.png`);
                    await page.screenshot({ path: shot, clip: { x: 0, y: 0, width, height: width <= 900 ? 170 : 120 } });
                    console.log('toolbar screenshot written to ' + shot);
                }
            }
            await page.evaluate(() => { document.body.classList.remove('vscode-light', 'vscode-dark'); document.documentElement.removeAttribute('style'); });
        }
        await page.setViewportSize(viewport);

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
