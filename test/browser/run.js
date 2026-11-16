/**
 * @file test/browser/run.js
 * @description The automated pass over media/editor.js — builds the harness, serves it, drives a
 * real Chromium through Find References, and asserts what the references peek does — plus the
 * toolbar's Actions menu (Generate ST and its project picker, Build and its C++ / XAE options, Auto
 * Sync; keyboard, ARIA, the status chips, fitting a narrow webview) and Compile Project's pane
 * markers (owner 'twincat-compile').
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

        // 7b. The Actions menu (user request 2026-11-16): every toolbar action and setting in one
        //     dropdown. A menu button (aria-haspopup="menu") that opens on click, Enter, Space and the
        //     arrows, walks its items with the arrows/Home/End, and closes on Escape (focus back on the
        //     button), Tab and a click outside. Offline it holds Generate ST, Build and Editor.
        await page.addStyleTag({ content: '#actions-group *, .tb-chip { transition: none !important; animation: none !important; }' });
        const menuState = () => page.evaluate(() => {
            const btn = document.getElementById('actions-btn');
            const menu = document.getElementById('actions-menu');
            const a = document.activeElement;
            return { open: !menu.hidden, expanded: btn.getAttribute('aria-expanded'), focus: a ? (a.id || a.className) : '' };
        });
        const openMenu = async () => { if (!(await menuState()).open) await page.click('#actions-btn'); };
        const closeMenu = async () => { if ((await menuState()).open) await page.keyboard.press('Escape'); };
        const btnAria = await page.evaluate(() => {
            const b = document.getElementById('actions-btn');
            const m = document.getElementById('actions-menu');
            return { popup: b.getAttribute('aria-haspopup'), controls: b.getAttribute('aria-controls'), expanded: b.getAttribute('aria-expanded'),
                label: b.getAttribute('aria-label'), glyph: b.querySelectorAll('svg circle').length, text: b.textContent.trim(),
                role: m.getAttribute('role'), labelledby: m.getAttribute('aria-labelledby'), hidden: m.hidden,
                // The header holds two actions: the Build icon button and the "⋯" menu button.
                toolbarButtons: [...document.querySelectorAll('.app-header button')].filter(x => !m.contains(x)).map(x => x.id) };
        });
        assert(btnAria.popup === 'menu' && btnAria.controls === 'actions-menu' && btnAria.expanded === 'false' && btnAria.label === 'Actions'
            && btnAria.glyph === 3 && btnAria.text === ''
            && btnAria.role === 'menu' && btnAria.labelledby === 'actions-btn' && btnAria.hidden && JSON.stringify(btnAria.toolbarButtons) === '["build-btn","actions-btn"]',
        `the header has the "⋯" Actions menu button (aria-label, aria-haspopup=menu, aria-controls, closed) and the Build icon button, nothing else (${JSON.stringify(btnAria)})`);

        // 7a'. The native header (user decision 2026-11-16): breadcrumb PLC project › folders › object,
        //      the type tag in true red, no product title or version pill (the version is the menu's foot).
        const hdr = await page.evaluate(() => {
            const tag = document.getElementById('obj-type');
            const cs = getComputedStyle(tag);
            const header = document.querySelector('.app-header');
            return {
                path: document.getElementById('crumb-path-text').textContent, name: document.getElementById('obj-name').textContent,
                tooltip: document.getElementById('hdr-crumbs').title, tag: tag.textContent, tagColor: cs.color, tagBorder: cs.borderTopColor,
                tagBg: cs.backgroundColor, height: Math.round(header.getBoundingClientRect().height),
                title: !!document.querySelector('.logo-text, .pill'), version: document.getElementById('menu-version').textContent,
                versionInMenu: document.getElementById('actions-menu').contains(document.getElementById('menu-version'))
            };
        });
        assert(hdr.path === 'TcToolkitSample_PLC › POUs › Actuators' && hdr.name === 'FB_Cylinder' && hdr.tooltip === 'TcToolkitSample_PLC › POUs › Actuators › FB_Cylinder.TcPOU',
            `the breadcrumb names the PLC project, the folder and the object; the tooltip is the full location (${JSON.stringify(hdr)})`);
        assert(hdr.tag === 'POU' && hdr.tagColor === 'rgb(226, 0, 26)' && hdr.tagBorder === 'rgb(226, 0, 26)' && hdr.tagBg === 'rgba(0, 0, 0, 0)',
            `the type tag is transparent with a true-red (#E2001A) border and text (${JSON.stringify(hdr)})`);
        assert(!hdr.title && /^TC Toolkit v\d/.test(hdr.version) && hdr.versionInMenu && hdr.height >= 34 && hdr.height <= 40,
            `one slim row (~36px), no product title or version pill; "TC Toolkit vX.Y.Z" is the menu's foot (${JSON.stringify(hdr)})`);
        const hdrStatus = () => page.evaluate(() => {
            const vis = (id) => { const e = document.getElementById(id); return !e.hidden && getComputedStyle(e).display !== 'none'; };
            return { sync: document.getElementById('save-status').textContent, syncShown: vis('save-status-item'), syncIcon: !!document.querySelector('#save-status-item svg'),
                online: vis('online-note'), plc: vis('plc-indicator'), building: vis('build-indicator'), manual: vis('sync-mode-text'),
                pills: [...document.querySelectorAll('.hdr-status .tb-chip')].filter(e => parseFloat(getComputedStyle(e).borderTopWidth) > 0 || getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)').map(e => e.id) };
        });
        const offlineStatus = await hdrStatus();
        assert(offlineStatus.sync === 'Synced' && offlineStatus.syncShown && offlineStatus.syncIcon && !offlineStatus.online && !offlineStatus.plc
            && !offlineStatus.building && !offlineStatus.manual && offlineStatus.pills.length === 0,
            `offline the status is the sync item alone ("Synced" + its icon), no pills (${JSON.stringify(offlineStatus)})`);
        await page.click('#actions-btn');
        let mst = await menuState();
        assert(mst.open && mst.expanded === 'true' && mst.focus === 'generate-st-btn', `a click opens the menu and focuses its first item (${JSON.stringify(mst)})`);
        const structure = await page.evaluate(() => {
            const m = document.getElementById('actions-menu');
            const shown = (el) => !el.closest('[hidden]');
            return {
                headings: [...m.querySelectorAll('.split-menu-title')].filter(shown).map(h => h.textContent),
                items: [...m.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].filter(shown).map(i => i.getAttribute('role') + ':' + i.id),
                groups: [...m.querySelectorAll('[role="group"]')].every(g => g.getAttribute('aria-labelledby') || g.getAttribute('aria-label')),
                separators: [...m.querySelectorAll('[role="separator"]')].filter(shown).length
            };
        });
        assert(JSON.stringify(structure.headings) === '["Generate ST","Build","Editor"]' && structure.groups && structure.separators === 2,
            `offline the menu has three labelled groups with separators: Generate ST, Build, Editor (no PLC) (${JSON.stringify(structure)})`);
        assert(JSON.stringify(structure.items) === JSON.stringify(['menuitem:generate-st-btn', 'menuitem:compile-btn', 'menuitemcheckbox:compile-opt-cpp',
            'menuitemcheckbox:compile-opt-gpp', 'menuitemcheckbox:sync-mode-toggle']),
        `its items in order, with menuitem / menuitemcheckbox roles (${JSON.stringify(structure.items)})`);
        await page.keyboard.press('ArrowDown');
        assert((await menuState()).focus === 'compile-btn', 'ArrowDown moves to the next item (Build)');
        await page.keyboard.press('End');
        assert((await menuState()).focus === 'sync-mode-toggle', 'End goes to the last item (Auto Sync)');
        await page.keyboard.press('ArrowDown');
        assert((await menuState()).focus === 'generate-st-btn', 'ArrowDown on the last item wraps to the first');
        await page.keyboard.press('ArrowUp');
        assert((await menuState()).focus === 'sync-mode-toggle', 'ArrowUp on the first item wraps to the last');
        await page.keyboard.press('Home');
        assert((await menuState()).focus === 'generate-st-btn', 'Home goes to the first item');
        await page.keyboard.press('Escape');
        mst = await menuState();
        assert(!mst.open && mst.expanded === 'false' && mst.focus === 'actions-btn', `Escape closes the menu and returns focus to the button (${JSON.stringify(mst)})`);
        for (const key of ['Enter', 'Space', 'ArrowDown']) {
            await page.focus('#actions-btn');
            await page.keyboard.press(key);
            mst = await menuState();
            assert(mst.open && mst.expanded === 'true' && mst.focus === 'generate-st-btn', `${key} on the button opens the menu at its first item (${JSON.stringify(mst)})`);
            await page.keyboard.press('Escape');
        }
        await page.focus('#actions-btn');
        await page.keyboard.press('ArrowUp');
        mst = await menuState();
        assert(mst.open && mst.focus === 'sync-mode-toggle', `ArrowUp on the button opens it at its last item (${JSON.stringify(mst)})`);
        await page.keyboard.press('Tab');
        assert(!(await menuState()).open, 'Tab out of the menu closes it');
        await openMenu();
        await page.mouse.click(5, page.viewportSize().height - 5);
        assert(!(await menuState()).open, 'a click elsewhere closes the menu');
        await openMenu();
        await page.click('#actions-btn');
        assert(!(await menuState()).open, 'a second click on the button closes it');
        await openMenu();
        await page.click('#menu-title-build');
        assert((await menuState()).open, 'a click on a heading inside the menu keeps it open');
        await closeMenu();

        // 7b'. Generate ST: the first item generates every project; "Choose projects…" shows only with
        //      2+ projects (and the first item then says "all projects").
        const genView = async (projects) => {
            await page.evaluate((p) => window.postMessage({ type: 'projectList', projects: p }, '*'), projects);
            await page.waitForTimeout(50);
            return page.evaluate(() => ({ choose: !document.getElementById('generate-st-caret').hidden,
                label: document.querySelector('#generate-st-btn .btn-label').textContent }));
        };
        const one = await genView([{ key: 'a', label: 'PLC_A' }]);
        assert(!one.choose && one.label === 'Generate ST', `one project: no "Choose projects…", the item reads Generate ST (${JSON.stringify(one)})`);
        const two = await genView([{ key: 'a', label: 'PLC_A' }, { key: 'b', label: 'PLC_B' }]);
        assert(two.choose && two.label === 'Generate ST: all projects', `two projects: "Choose projects…" shows and the item says all projects (${JSON.stringify(two)})`);
        const back = await genView([{ key: 'a', label: 'PLC_A' }]);
        assert(!back.choose && back.label === 'Generate ST', `back to one project: the plain item again (${JSON.stringify(back)})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await openMenu();
        await page.click('#generate-st-btn');
        let genMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'generate-st'));
        assert(genMsgs.length === 1 && genMsgs[0].projectKeys === undefined && !(await menuState()).open,
            `Generate ST posts generate-st with no keys (every project) and closes the menu (${JSON.stringify(genMsgs)})`);
        // By keyboard: Enter on the item runs it and puts focus back on the menu button.
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.focus('#actions-btn');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        genMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'generate-st'));
        mst = await menuState();
        assert(genMsgs.length === 1 && !mst.open && mst.focus === 'actions-btn', `Enter on Generate ST runs it, closes the menu and focus returns to the button (${JSON.stringify(mst)})`);

        // 7c. The menu, with the project picker unfolded, stays inside a narrow webview: no part clipped,
        //     no sideways scrollbar from a long project name, which keeps its full name in a tooltip.
        const viewport = page.viewportSize();
        const menuFit = async (width) => {
            await page.setViewportSize({ width, height: viewport.height });
            await page.evaluate(() => window.postMessage({ type: 'projectList', projects: [
                { key: 'a', label: 'PLC_' + 'VeryLongProjectName_'.repeat(4) + 'A' },
                { key: 'b', label: 'PLC_B' }
            ] }, '*'));
            await page.waitForTimeout(50);
            await openMenu();
            await page.click('#generate-st-caret');
            await page.waitForTimeout(50);
            const r = await page.evaluate(() => {
                const menu = document.getElementById('actions-menu');
                const list = document.getElementById('generate-st-projects');
                const rect = menu.getBoundingClientRect();
                const first = list.querySelector('.split-menu-item');
                return {
                    open: !menu.hidden, picker: !document.getElementById('generate-st-menu').hidden,
                    expanded: document.getElementById('generate-st-caret').getAttribute('aria-expanded'),
                    left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom), height: window.innerHeight,
                    width: window.innerWidth, sideScroll: list.scrollWidth > list.clientWidth || menu.scrollWidth > menu.clientWidth,
                    pageScroll: document.documentElement.scrollWidth > window.innerWidth,
                    tooltip: first ? first.title : ''
                };
            });
            await closeMenu();
            return r;
        };
        for (const width of [320, 360, 560, 1200]) {
            const fit = await menuFit(width);
            assert(fit.open && fit.picker && fit.expanded === 'true' && fit.left >= 0 && fit.right <= fit.width && fit.bottom <= fit.height
                && !fit.sideScroll && !fit.pageScroll && fit.tooltip.length > 40,
            `at ${width}px the open menu with its project picker is fully inside the webview, without a sideways scrollbar, and a cut name keeps its tooltip (${JSON.stringify(fit)})`);
        }
        await page.setViewportSize(viewport);
        assert(await page.evaluate(() => document.getElementById('generate-st-menu').hidden), 'closing the menu folds the project picker away too');

        // 7d. Select all: a tri-state box over the project list. Unticking it clears every project and
        //     disables "Generate selected" (aria-disabled, so a click posts nothing); one project ticked
        //     makes it indeterminate; ticking it again selects all, and the run then posts every key.
        await page.evaluate(() => window.postMessage({ type: 'projectList', projects: [
            { key: 'a', label: 'PLC_A' }, { key: 'b', label: 'PLC_B' }, { key: 'c', label: 'PLC_C' }
        ] }, '*'));
        await page.waitForTimeout(50);
        // Into the picker by keyboard: ArrowDown to "Choose projects…", Enter unfolds it and moves into it.
        await page.focus('#actions-btn');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        mst = await menuState();
        assert(mst.open && mst.focus === 'generate-st-all', `Enter on "Choose projects…" unfolds the picker and focuses Select all (${JSON.stringify(mst)})`);
        await page.keyboard.press('ArrowDown');
        assert((await page.evaluate(() => document.activeElement && document.activeElement.value)) === 'a', 'ArrowDown walks into the project boxes');
        const allState = () => page.evaluate(() => {
            const all = document.getElementById('generate-st-all');
            const boxes = Array.from(document.querySelectorAll('#generate-st-projects input[type="checkbox"]'));
            return {
                all: all.checked, mixed: all.indeterminate,
                ticked: boxes.filter(b => b.checked).length,
                roles: boxes.every(b => b.getAttribute('role') === 'menuitemcheckbox'),
                runDisabled: document.getElementById('generate-st-run').getAttribute('aria-disabled') === 'true'
            };
        });
        const fresh = await allState();
        assert(fresh.all && !fresh.mixed && fresh.ticked === 3 && fresh.roles && !fresh.runDisabled,
            `a fresh project list starts with Select all ticked and every project selected (${JSON.stringify(fresh)})`);
        await page.click('#generate-st-all');
        const none = await allState();
        assert(!none.all && !none.mixed && none.ticked === 0 && none.runDisabled,
            `unticking Select all clears every project and disables Generate selected (${JSON.stringify(none)})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#generate-st-run', { force: true }); // force: Playwright waits out aria-disabled
        assert((await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'generate-st').length)) === 0 && (await menuState()).open,
            'a click on the disabled Generate selected posts nothing and keeps the menu open');
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
        assert(runMsg.length === 1 && JSON.stringify(runMsg[0].projectKeys) === '["a","b","c"]' && !(await menuState()).open,
            `Generate selected then posts every project key and closes the menu (${JSON.stringify(runMsg)})`);

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

        // 7f. Build, in the Actions menu's Build group: a menuitem with its glyph that posts
        //     `compile-project` (the host resolves this file's project). While the host says a run is in
        //     progress it is disabled (aria-disabled: still focusable, its detail line says why) and a
        //     "Building…" chip shows next to the menu button, so the state is visible with the menu shut.
        const compileInfo = await page.evaluate(() => {
            const btn = document.getElementById('compile-btn');
            return {
                present: !!btn, glyph: !!(btn && btn.querySelector('svg.btn-icon path')), role: btn.getAttribute('role'),
                inMenu: document.getElementById('actions-menu').contains(btn),
                text: btn.querySelector('.btn-label').textContent, tooltip: btn.title, describedby: btn.getAttribute('aria-describedby'),
                detail: document.getElementById('compile-btn-detail').textContent,
                genTooltip: document.getElementById('generate-st-btn').title
            };
        });
        assert(compileInfo.present && compileInfo.glyph && compileInfo.role === 'menuitem' && compileInfo.inMenu && compileInfo.text === 'Build'
            && /^Build Project: /.test(compileInfo.tooltip) && compileInfo.describedby === 'compile-btn-detail' && /IEC 61131-3/.test(compileInfo.detail)
            && /Generate ST/.test(compileInfo.genTooltip),
        `the Build item (it runs Build Project) is in the menu with a glyph, the name Build, a tooltip and a detail line (${JSON.stringify(compileInfo)})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await openMenu();
        await page.click('#compile-btn');
        let compileMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'compile-project'));
        assert(compileMsgs.length === 1 && Object.keys(compileMsgs[0]).join() === 'type' && !(await menuState()).open,
            `clicking Build posts compile-project to the host and closes the menu (${JSON.stringify(compileMsgs)})`);
        const chip = (id) => page.evaluate((i) => { const c = document.getElementById(i); return { shown: !c.hidden && getComputedStyle(c).display !== 'none', text: c.textContent }; }, id);
        assert(!(await chip('build-indicator')).shown, 'no Building… chip while nothing runs');
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: true }, '*'));
        await settle(50);
        await openMenu();
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#compile-btn', { force: true });
        compileMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'compile-project'));
        const busy = await page.evaluate(() => {
            const b = document.getElementById('compile-btn');
            return { disabled: b.getAttribute('aria-disabled'), aria: b.getAttribute('aria-busy'), detail: document.getElementById('compile-btn-detail').textContent,
                title: document.getElementById('actions-btn').title };
        });
        const busyChip = await chip('build-indicator');
        assert(busy.disabled === 'true' && busy.aria === 'true' && compileMsgs.length === 0 && busy.detail === 'A build is running.' && (await menuState()).open,
            `while a run is in progress Build is disabled, says why, and a click posts nothing (${JSON.stringify(busy)})`);
        assert(busyChip.shown && busyChip.text === 'Building…' && /Build Project is running/.test(busy.title),
            `and a "Building…" chip shows next to the menu button; the button's tooltip says so too (${JSON.stringify(busyChip)})`);
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowDown'); // Choose projects… (three projects since 7d)
        await page.keyboard.press('ArrowDown');
        assert((await menuState()).focus === 'compile-btn', 'the disabled Build item is still reachable by the arrows (its reason is read out)');
        await closeMenu();
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: false }, '*'));
        await settle(50);
        assert((await page.evaluate(() => document.getElementById('compile-btn').getAttribute('aria-disabled'))) === 'false' && !(await chip('build-indicator')).shown,
            'when the run ends Build is enabled again and the chip goes');

        // 7f''. The header's Build icon button: one click = Build Project; disabled while a build runs.
        const buildBtnInfo = await page.evaluate(() => {
            const b = document.getElementById('build-btn');
            return { title: b.title, label: b.getAttribute('aria-label'), glyph: !!b.querySelector('svg path'), disabled: b.getAttribute('aria-disabled') };
        });
        assert(buildBtnInfo.title === 'Build (check with the IEC 61131-3 compiler)' && buildBtnInfo.label === 'Build' && buildBtnInfo.glyph && buildBtnInfo.disabled !== 'true',
            `the Build icon button has its glyph, its name and the tooltip (${JSON.stringify(buildBtnInfo)})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#build-btn');
        compileMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'compile-project'));
        assert(compileMsgs.length === 1 && Object.keys(compileMsgs[0]).join() === 'type' && !(await menuState()).open,
            `one click on the Build icon button posts compile-project (${JSON.stringify(compileMsgs)})`);
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: true }, '*'));
        await settle(50);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#build-btn', { force: true });
        const buildBusy = await page.evaluate(() => ({ sent: window.__harness.sent.filter(m => m.type === 'compile-project').length,
            disabled: document.getElementById('build-btn').getAttribute('aria-disabled'), title: document.getElementById('build-btn').title,
            reason: document.getElementById('build-btn-busy').textContent }));
        assert(buildBusy.sent === 0 && buildBusy.disabled === 'true' && /running/.test(buildBusy.title) && buildBusy.reason === 'A build is running.',
            `while a build runs the Build icon button is disabled, says why, and a click posts nothing (${JSON.stringify(buildBusy)})`);
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: false }, '*'));
        await settle(50);
        assert((await page.evaluate(() => document.getElementById('build-btn').getAttribute('aria-disabled'))) === 'false', 'and enabled again when it ends');

        // 7f'. The Build options (R13): two checkbox items that show the host's settings and post every
        //      change; the coupling (the g++ build needs the C++) shows at once; settings changed elsewhere
        //      arrive as `compileOptions`; Space and Enter toggle them, and toggling keeps the menu open.
        const opts = () => page.evaluate(() => ({
            open: !document.getElementById('actions-menu').hidden,
            cpp: document.getElementById('compile-opt-cpp').checked, gpp: document.getElementById('compile-opt-gpp').checked,
            focus: document.activeElement ? document.activeElement.id : '',
            detail: document.getElementById('compile-btn-detail').textContent
        }));
        const optionMsgs = () => page.evaluate(() => window.__harness.sent.filter(m => m.type === 'setCompileOption'));
        let o = await opts();
        assert(!o.open && !o.cpp && !o.gpp, `both options start off (the init message's options) (${JSON.stringify(o)})`);
        const optLabels = await page.evaluate(() => ['compile-opt-cpp', 'compile-opt-gpp', 'xae-opt-window', 'sync-mode-toggle']
            .map(id => { const el = document.getElementById(id); return el.getAttribute('role') + ':' + el.closest('label').textContent.trim(); }));
        assert(JSON.stringify(optLabels) === JSON.stringify(['menuitemcheckbox:Generate C++', 'menuitemcheckbox:Build with g++', 'menuitemcheckbox:Show the XAE window', 'menuitemcheckbox:Auto Sync']),
            `the settings are labelled menuitemcheckbox items (${JSON.stringify(optLabels)})`);
        // Build through XAE (R14): its section stays hidden until the host says it is available.
        assert(await page.evaluate(() => document.getElementById('xae-menu-section').hidden), 'R14: the XAE entries are hidden by default (the init message carried no xaeOptions)');
        const btnTitle = () => page.evaluate(() => document.getElementById('compile-btn').title);
        assert(/^Build Project: check this PLC project with the IEC 61131-3 compiler$/.test(await btnTitle()), `with both options off Build's tooltip says it checks (${await btnTitle()})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.focus('#actions-btn');
        await page.keyboard.press('ArrowDown');
        for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown'); // Choose projects…, Build, Generate C++, Build with g++
        assert((await opts()).focus === 'compile-opt-gpp', `the arrows reach Build with g++ (${(await opts()).focus})`);
        await page.keyboard.press('Space');
        o = await opts();
        let om = await optionMsgs();
        assert(o.open && o.gpp && o.cpp && om.length === 1 && om[0].key === 'buildWithGpp' && om[0].value === true,
            `Space ticks Build with g++, which ticks Generate C++ too, posts setCompileOption, and the menu stays open (${JSON.stringify(om)})`);
        assert(/^Build Project: check this PLC project, write it as C\+\+ into its CPP_Files folder, and build that with g\+\+/.test(await btnTitle())
            && /g\+\+/.test(o.detail), `Build's tooltip and detail follow: check, write C++, build with g++ (${await btnTitle()} | ${o.detail})`);
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Enter');
        o = await opts();
        om = await optionMsgs();
        assert(o.open && !o.cpp && !o.gpp && om.length === 2 && om[1].key === 'generateCpp' && om[1].value === false,
            `Enter toggles a checkbox item too: unticking Generate C++ unticks Build with g++ and posts it (${JSON.stringify(om)})`);
        await page.keyboard.press('Escape');
        o = await opts();
        assert(!o.open && o.focus === 'actions-btn', `Escape closes the menu and returns focus to the button (${JSON.stringify(o)})`);
        // The host's answer (or a change made in the Settings editor) is what the boxes show.
        await page.evaluate(() => window.postMessage({ type: 'compileOptions', options: { generateCpp: false, buildWithGpp: true } }, '*'));
        await settle(30);
        o = await opts();
        assert(o.cpp && o.gpp, 'a compileOptions message from the host updates the boxes live (the build shows generation on)');
        await page.evaluate(() => window.postMessage({ type: 'compileOptions', options: { generateCpp: true, buildWithGpp: false } }, '*'));
        await settle(30);
        o = await opts();
        assert(o.cpp && !o.gpp, 'and back: generation only');
        assert(/^Build Project: check this PLC project, then write it as C\+\+ into its CPP_Files folder$/.test(await btnTitle()), `the tooltip follows a host update too: check, then write C++ (${await btnTitle()})`);

        // Build through XAE (R14): the host's xaeOptions shows the section; its items post runXae / setXaeOption.
        await page.evaluate(() => window.postMessage({ type: 'xaeOptions', options: { available: true, showWindow: false, running: false } }, '*'));
        await settle(30);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await openMenu();
        const xaeShown = await page.evaluate(() => {
            const sec = document.getElementById('xae-menu-section');
            const r = document.getElementById('actions-menu').getBoundingClientRect();
            return { shown: !sec.hidden && getComputedStyle(sec).display !== 'none', window: document.getElementById('xae-opt-window').checked,
                buttons: [...sec.querySelectorAll('[role="menuitem"]')].map(b => b.textContent), inside: r.left >= 0 && r.right <= window.innerWidth,
                heading: document.getElementById('xae-menu-title').textContent, busyNote: !document.getElementById('xae-busy-detail').hidden,
                desc: document.getElementById('xae-build').getAttribute('aria-describedby') };
        });
        assert(xaeShown.shown && !xaeShown.window && JSON.stringify(xaeShown.buttons) === '["Build through XAE","Build and Activate through XAE…"]' && xaeShown.inside
            && xaeShown.heading === 'Through XAE' && !xaeShown.busyNote && !xaeShown.desc,
        `R14: available → the Build group shows Build through XAE, Build and Activate through XAE… and an unticked Show the XAE window, inside the webview (${JSON.stringify(xaeShown)})`);
        await page.keyboard.press('End');
        await page.keyboard.press('ArrowUp');
        assert((await opts()).focus === 'xae-opt-window', `R14: the arrows walk through the XAE entries too (${(await opts()).focus})`);
        await page.keyboard.press('ArrowUp');
        assert((await opts()).focus === 'xae-activate', 'R14: … up to Build and Activate through XAE…');
        await page.click('#xae-opt-window');
        await page.click('#xae-build');
        let xm = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'setXaeOption' || m.type === 'runXae'));
        assert(xm.length === 2 && xm[0].type === 'setXaeOption' && xm[0].key === 'showWindow' && xm[0].value === true && xm[1].type === 'runXae' && xm[1].activate === false,
            `R14: the checkbox posts setXaeOption showWindow; Build through XAE posts runXae {activate: false} (${JSON.stringify(xm)})`);
        assert((await opts()).open === false, 'R14: an XAE action closes the menu');
        await openMenu();
        await page.click('#xae-activate');
        xm = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'runXae'));
        assert(xm.length === 2 && xm[1].activate === true, 'R14: Build and Activate through XAE… posts runXae {activate: true}');
        await page.evaluate(() => window.postMessage({ type: 'xaeOptions', options: { available: true, showWindow: true, running: true } }, '*'));
        await settle(30);
        const xaeBusy = await page.evaluate(() => ({ b: document.getElementById('xae-build').getAttribute('aria-disabled'), a: document.getElementById('xae-activate').getAttribute('aria-disabled'),
            w: document.getElementById('xae-opt-window').checked, note: !document.getElementById('xae-busy-detail').hidden,
            desc: document.getElementById('xae-build').getAttribute('aria-describedby') }));
        const xaeChip = await chip('build-indicator');
        assert(xaeBusy.b === 'true' && xaeBusy.a === 'true' && xaeBusy.w && xaeBusy.note && xaeBusy.desc === 'xae-busy-detail' && xaeChip.shown && xaeChip.text === 'XAE build…',
            `R14: while a run is going both actions are disabled with the reason shown, the box follows the setting, and an "XAE build…" chip shows (${JSON.stringify({ xaeBusy, xaeChip })})`);
        await openMenu();
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#xae-build', { force: true });
        assert((await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'runXae').length)) === 0, 'R14: a click on a disabled XAE item posts nothing');
        await closeMenu();
        await page.evaluate(() => window.postMessage({ type: 'xaeOptions', options: { available: false, showWindow: false, running: false } }, '*'));
        await settle(30);
        assert(await page.evaluate(() => document.getElementById('xae-menu-section').hidden) && !(await chip('build-indicator')).shown, 'R14: not available → hidden again, and no chip');

        // 7g. Auto Sync: a checkbox item in the Editor group. Off shows a "Manual Sync" chip next to the
        //     menu button (the toggle's old label; the dev-host runner reads its text) and posts
        //     toggleSyncMode; the host's setSyncMode turns it back.
        const syncView = () => page.evaluate(() => ({ checked: document.getElementById('sync-mode-toggle').checked, chip: !document.getElementById('sync-mode-text').hidden,
            text: document.getElementById('sync-mode-text').textContent, title: document.getElementById('actions-btn').title }));
        let sv = await syncView();
        assert(sv.checked && !sv.chip && sv.text === 'Auto Sync' && /Auto Sync on/.test(sv.title), `Auto Sync starts on, with no chip (${JSON.stringify(sv)})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.focus('#actions-btn');
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Space');
        sv = await syncView();
        let syncMsgs = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'toggleSyncMode'));
        assert(!sv.checked && sv.chip && sv.text === 'Manual Sync' && /Manual Sync/.test(sv.title) && syncMsgs.length === 1 && syncMsgs[0].isAutoSync === false && (await menuState()).open,
            `Space on Auto Sync turns it off: a Manual Sync chip shows, toggleSyncMode posts, the menu stays open (${JSON.stringify(sv)})`);
        await closeMenu();
        await page.evaluate(() => window.postMessage({ type: 'setSyncMode', isAutoSync: true }, '*'));
        await settle(30);
        sv = await syncView();
        assert(sv.checked && !sv.chip && sv.text === 'Auto Sync', `the host's setSyncMode turns it back on and the chip goes (${JSON.stringify(sv)})`);

        if (process.env.HARNESS_TOOLBAR_SHOTS) {
            for (const [name, width] of [['wide', 1200], ['narrow', 400]]) {
                await page.setViewportSize({ width, height: viewport.height });
                await settle(120);
                await page.screenshot({ path: path.join(process.env.HARNESS_TOOLBAR_SHOTS, `actions-offline-closed-${width}.png`), clip: { x: 0, y: 0, width, height: width <= 780 ? 170 : 90 } });
                await openMenu();
                await page.click('#generate-st-caret');
                await settle(80);
                const shot = path.join(process.env.HARNESS_TOOLBAR_SHOTS, `actions-offline-open-${width}.png`);
                await page.screenshot({ path: shot, clip: { x: 0, y: 0, width, height: Math.min(viewport.height, 640) } });
                console.log(`actions menu screenshots written to ${process.env.HARNESS_TOOLBAR_SHOTS} (${name})`);
                await closeMenu();
            }
            await page.setViewportSize(viewport);
        }

        // Narrow editors: the menu button, the component list and the status stay whole and inside the
        // webview; the page never scrolls sideways; the open menu fits.
        await page.evaluate(() => window.postMessage({ type: 'projectList', projects: [{ key: 'a', label: 'PLC_A' }, { key: 'b', label: 'PLC_B' }] }, '*'));
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: true }, '*'));
        const toolbarAt = async (width) => {
            await page.setViewportSize({ width, height: viewport.height });
            await settle(80);
            const closed = await page.evaluate(() => {
                const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), top: Math.round(r.top) }; };
                return {
                    width: window.innerWidth, actions: box('actions-btn'), build: box('build-btn'), select: box('component-select'), status: box('save-status-item'), chip: box('build-indicator'),
                    name: Object.assign(box('obj-name'), { cut: document.getElementById('obj-name').scrollWidth > document.getElementById('obj-name').clientWidth + 1 }),
                    compact: document.querySelector('.app-header').classList.contains('compact'),
                    statusText: getComputedStyle(document.getElementById('save-status')).display !== 'none',
                    // Rows: items whose vertical centres lie within 8px of each other share one.
                    rows: (() => { const cs = [...document.querySelectorAll('.app-header > *')].filter(e => e.getBoundingClientRect().width > 0)
                        .map(e => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; }).sort((a, b) => a - b);
                    return cs.reduce((n, c, i) => n + (i > 0 && c - cs[i - 1] > 8 ? 1 : 0), 1); })(),
                    sideScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
                };
            });
            await openMenu();
            const open = await page.evaluate(() => { const r = document.getElementById('actions-menu').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), h: window.innerHeight }; });
            await closeMenu();
            return Object.assign(closed, { menu: open });
        };
        for (const width of [320, 360, 560, 700, 760, 780, 800, 820, 900, 960, 1100, 1200]) {
            const t = await toolbarAt(width);
            const inside = (b) => b.width > 0 && b.left >= 0 && b.right <= t.width;
            assert(inside(t.actions) && inside(t.build) && inside(t.select) && inside(t.status) && inside(t.chip) && t.actions.width >= 24 && !t.sideScroll
                && t.menu.left >= 0 && t.menu.right <= t.width && t.menu.bottom <= t.menu.h,
            `at ${width}px the "⋯" and Build buttons, the component list, the Building… item and the status are inside the editor, no sideways scroll, and the open menu fits (${JSON.stringify(t)})`);
            // The object name gives way last: while it is cut the status shows dots only; above 420px one row.
            assert((!t.name.cut || t.compact) && (width <= 420 || t.rows === 1) && (t.compact ? !t.statusText : t.statusText),
                `at ${width}px the status collapses to dots before the object name is cut, and above 420px the header is one row (${JSON.stringify({ name: t.name, compact: t.compact, rows: t.rows, statusText: t.statusText })})`);
            if (width >= 1100) assert(!t.compact && !t.name.cut, `at ${width}px nothing is collapsed`);
        }
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: false }, '*'));

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
                for (const [name, width] of [['normal', 1200], ['narrow', 820], ['wrapped', 700], ['phone', 400]]) {
                    await page.setViewportSize({ width, height: viewport.height });
                    await settle(150);
                    const shot = path.join(process.env.HARNESS_TOOLBAR_SHOTS, `toolbar-${theme}-${name}-${width}.png`);
                    await page.screenshot({ path: shot, clip: { x: 0, y: 0, width, height: width <= 780 ? 170 : 120 } });
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
