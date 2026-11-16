/**
 * @file test/browser/run_online.js
 * @description The browser pass over online monitoring (R15) in media/editor.js: the inline values
 * the host posts are drawn as Monaco injected text in the right pane, at the right place, styled by
 * state, without touching the document; the webview reports what its panes show; an edit clears the
 * values (they belong to the old text) and asks again, and an unchanged answer draws them again; the
 * editor actions post a write or a watch request with the caret's pane position; Write Value… is
 * offered only where the host says the editor may write; the host's answer to `online/visible` (an
 * `online/state`) does not make the webview ask again, so the two never message each other in a
 * loop (R15 review findings #1, #15, #16); the Start/Stop PLC item in the toolbar's Actions menu
 * (its PLC group hidden offline, Start/Stop label and glyph by the host's state, disabled with the
 * reason shown otherwise, a click posts `online/plcControl`) and the PLC state chip next to the menu
 * button; going offline removes everything.
 *
 * Shares build.js / serve.js with run.js. NOT part of `npm test`: it needs a browser.
 *
 *     npm i --no-save playwright
 *     HARNESS_CHROMIUM=/opt/pw-browsers/chromium node test/browser/run_online.js
 *
 * Exit codes: 0 pass, 1 an assertion failed, 2 cannot run (no Playwright / no browser).
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const PORT = Number(process.env.HARNESS_PORT || 8125);
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
    const built = spawnSync(process.execPath, [path.join(HERE, 'build.js')], { env: { ...process.env, HARNESS_ORIGIN: ORIGIN }, encoding: 'utf8' });
    if (built.status !== 0) {
        console.error('[FAIL] harness build failed:\n' + (built.stderr || built.stdout));
        process.exit(1);
    }
    const { start } = require('./serve.js');
    let served;
    try { served = await start(PORT); } catch (e) {
        console.error(`[FAIL] cannot serve on ${PORT} (${e.code}). Set HARNESS_PORT to a free port.`);
        process.exit(1);
    }
    const browser = await chromium.launch(process.env.HARNESS_CHROMIUM ? { executablePath: process.env.HARNESS_CHROMIUM } : {});
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    const settle = (ms) => page.evaluate((t) => new Promise(r => setTimeout(r, t)), ms);

    try {
        await page.goto(served.url, { waitUntil: 'load' });
        const boot = await page.evaluate(async () => {
            const fixture = await (await fetch('/harness/fixture.json')).json();
            window.__harnessInit(fixture);
            await new Promise(r => setTimeout(r, 800));
            const panes = monaco.editor.getEditors().filter(e => e.getModel() && e.getModel().uri.scheme === 'inmemory');
            window.__panes = { decl: panes[0], impl: panes[1] };
            const plcBtn = document.getElementById('plc-run-btn');
            const section = document.getElementById('plc-menu-section');
            const menu = document.getElementById('actions-menu');
            return { editors: panes.length, note: !!document.getElementById('online-note'), noteHidden: document.getElementById('online-note').hidden,
                plc: !!plcBtn, inMenu: menu.contains(plcBtn), role: plcBtn && plcBtn.getAttribute('role'), sectionHidden: section.hidden,
                // The PLC group follows the Build group in the menu.
                afterBuild: !!section.previousElementSibling && section.previousElementSibling.getAttribute('aria-labelledby') === 'menu-title-build',
                chipHidden: document.getElementById('plc-indicator').hidden };
        });
        assert(boot.editors === 2 && boot.note && boot.noteHidden, 'two panes boot; the online note exists and is hidden while offline');
        assert(boot.plc && boot.inMenu && boot.role === 'menuitem' && boot.sectionHidden && boot.afterBuild && boot.chipHidden,
            `the Start/Stop PLC item is in the Actions menu right after the Build group, and its group and the PLC chip are hidden while offline (${JSON.stringify(boot)})`);

        const offlineAction = await page.evaluate(() => {
            const a = window.__panes.impl.getAction('tc.online.write');
            const w = window.__panes.impl.getAction('tc.online.addWatch');
            return { write: !!a, writeSupported: a && a.isSupported(), watch: !!w, watchSupported: w && w.isSupported(), label: a && a.label };
        });
        assert(offlineAction.write && !offlineAction.writeSupported && offlineAction.label === 'Write Value…',
            'the Write Value… action exists but is disabled while offline');
        assert(offlineAction.watch && offlineAction.watchSupported, 'Add to PLC Watch is available (a GVL or PROGRAM path needs no connection)');

        // ── going online: the webview reports its panes ──────────────────────────────────────────
        await page.evaluate(() => { window.__harness.sent.length = 0; window.postMessage({ type: 'online/state', online: true, note: 'Instance: GVL_System.fbCylinder', writable: true }, '*'); });
        await settle(400);
        const visible = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'online/visible'));
        const v = visible[visible.length - 1];
        assert(visible.length >= 1 && v.componentId === 'root' && Array.isArray(v.visible.decl) && Array.isArray(v.visible.impl)
            && v.visible.decl[0].start === 1 && typeof v.decl === 'string' && typeof v.impl === 'string',
            `online/visible carries the component, both panes' texts and their visible line ranges (${JSON.stringify(v && v.visible)})`);
        const note = await page.evaluate(() => { const n = document.getElementById('online-note'); return { hidden: n.hidden, text: n.textContent }; });
        assert(!note.hidden && note.text === 'Online · Instance: GVL_System.fbCylinder', `the toolbar note shows online and the host's note (${note.text})`);
        const onlineAction = await page.evaluate(() => window.__panes.impl.getAction('tc.online.write').isSupported());
        assert(onlineAction, 'Write Value… is enabled while online, in an editor the host says may write');

        // ── Start / Stop PLC (user request 2026-11-16): one toggle that follows the PLC state ─────────
        // The menu is opened for the views so computed styles (display, colour) are real.
        await page.click('#actions-btn');
        const plcView = () => page.evaluate(() => {
            const b = document.getElementById('plc-run-btn');
            const vis = (sel) => getComputedStyle(b.querySelector(sel)).display !== 'none';
            const chip = document.getElementById('plc-indicator');
            return { hidden: b.closest('[hidden]') !== null, display: getComputedStyle(b).display, disabled: b.getAttribute('aria-disabled') === 'true',
                label: b.querySelector('.btn-label').textContent, detail: document.getElementById('plc-run-detail').textContent,
                describedby: b.getAttribute('aria-describedby'), title: b.title, start: vis('.plc-icon-start'), stop: vis('.plc-icon-stop'),
                isStop: b.classList.contains('is-stop'), isStart: b.classList.contains('is-start'), startColor: getComputedStyle(b.querySelector('.plc-icon-start')).color,
                chip: chip.hidden ? null : chip.textContent, chipClass: chip.className, menuTitle: document.getElementById('actions-btn').title };
        });
        let pv = await plcView();
        assert(!pv.hidden && pv.display !== 'none' && pv.disabled && /not known yet/.test(pv.title) && /not known yet/.test(pv.detail)
            && pv.describedby === 'plc-run-detail' && pv.chip === null,
        `online, before the host says the PLC state: the PLC group shows, Start/Stop is disabled with the reason on its detail line, no state chip yet (${JSON.stringify(pv)})`);
        await page.evaluate(() => window.postMessage({ type: 'online/plc', online: true, action: 'stop', plcState: 'Run', busy: false, reason: '' }, '*'));
        await settle(100);
        pv = await plcView();
        assert(!pv.disabled && pv.label === 'Stop PLC' && pv.stop && !pv.start && pv.isStop && /the PLC is in Run/.test(pv.title) && /in Run/.test(pv.detail),
            `the PLC runs: "Stop PLC" with the stop glyph (${JSON.stringify(pv)})`);
        assert(pv.chip === 'PLC Run' && /tb-chip-ok/.test(pv.chipClass) && /PLC Run/.test(pv.menuTitle),
            `a "PLC Run" chip (green) shows next to the menu button, and the button's tooltip names it (${JSON.stringify(pv)})`);
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.click('#plc-run-btn');
        const clicked = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'online/plcControl'));
        assert(clicked.length === 1 && clicked[0].action === 'stop' && await page.evaluate(() => document.getElementById('actions-menu').hidden),
            `a click asks the host to stop and closes the menu (${JSON.stringify(clicked)})`);
        await page.click('#actions-btn');
        await page.evaluate(() => window.postMessage({ type: 'online/plc', online: true, action: null, plcState: 'Run', busy: true, reason: 'A start or stop of the PLC is in progress.' }, '*'));
        await settle(100);
        pv = await plcView();
        const busyClick = await page.evaluate(() => { window.__harness.sent.length = 0; document.getElementById('plc-run-btn').click(); return window.__harness.sent.length; });
        assert(pv.disabled && pv.label === 'Stop PLC' && /in progress/.test(pv.title) && /in progress/.test(pv.detail) && busyClick === 0 && pv.chip === 'PLC Run…',
            `while it runs: disabled with the reason shown, no message on click, the chip reads "PLC Run…" (${JSON.stringify(pv)})`);
        await page.keyboard.press('End');
        await page.keyboard.press('ArrowUp');
        assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'plc-run-btn'), 'the disabled item is still reachable with the arrows (its reason is read out)');
        await page.evaluate(() => window.postMessage({ type: 'online/plc', online: true, action: 'start', plcState: 'Stop', busy: false, reason: '' }, '*'));
        await settle(100);
        pv = await plcView();
        assert(!pv.disabled && pv.label === 'Start PLC' && pv.start && !pv.stop && pv.isStart && /46, 213, 115/.test(pv.startColor) && pv.chip === 'PLC Stop' && /tb-chip-warn/.test(pv.chipClass),
            `the PLC is stopped: "Start PLC" with a green play glyph, and a "PLC Stop" chip (${JSON.stringify(pv)})`);
        // By keyboard: Enter on the focused item asks the host.
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.focus('#plc-run-btn');
        await page.keyboard.press('Enter');
        const startClick = await page.evaluate(() => window.__harness.sent.filter(m => m.type === 'online/plcControl'));
        assert(startClick.length === 1 && startClick[0].action === 'start' && await page.evaluate(() => document.activeElement.id === 'actions-btn'),
            'Enter on Start PLC asks the host to start; focus returns to the menu button');
        await page.click('#actions-btn');
        await page.evaluate(() => window.postMessage({ type: 'online/plc', online: true, action: null, plcState: 'Config', busy: false,
            reason: 'The PLC is in Config: Start and Stop are offered in Stop and Run only.' }, '*'));
        await settle(100);
        pv = await plcView();
        assert(pv.disabled && !pv.hidden && /in Config/.test(pv.title) && /in Config/.test(pv.detail) && pv.chip === 'PLC Config',
            `another state (Config): disabled with the reason on the item and in its tooltip; the chip says Config (${JSON.stringify(pv)})`);
        if (process.env.HARNESS_TOOLBAR_SHOTS) {
            const shot = path.join(process.env.HARNESS_TOOLBAR_SHOTS, 'actions-online-open-config.png');
            await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: page.viewportSize().width, height: 560 } });
            console.log('screenshot written to ' + shot);
        }
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.postMessage({ type: 'online/plc', online: true, action: 'stop', plcState: 'Run', busy: false, reason: '' }, '*'));
        await settle(100);

        // ── #1: an editor of a project the PLC does not run is not offered Write Value… ─────────────
        await page.evaluate(() => window.postMessage({ type: 'online/state', online: true, note: 'This file is not part of the project on the PLC.', writable: false }, '*'));
        await settle(100);
        const notWritable = await page.evaluate(() => ({ write: window.__panes.impl.getAction('tc.online.write').isSupported(),
            watch: window.__panes.impl.getAction('tc.online.addWatch').isSupported() }));
        assert(!notWritable.write && notWritable.watch, `#1 writable:false hides Write Value… (Add to PLC Watch stays) (${JSON.stringify(notWritable)})`);
        await page.evaluate(() => window.postMessage({ type: 'online/state', online: true, note: 'x' }, '*'));
        await settle(100);
        assert(!(await page.evaluate(() => window.__panes.impl.getAction('tc.online.write').isSupported())), '#1 a state without `writable` does not offer it either');
        await page.evaluate(() => window.postMessage({ type: 'online/state', online: true, note: 'Instance: GVL_System.fbCylinder', writable: true }, '*'));
        await settle(100);

        // ── values ───────────────────────────────────────────────────────────────────────────────
        const lines = await page.evaluate(() => ({
            decl: window.__panes.decl.getModel().getLinesContent(),
            impl: window.__panes.impl.getModel().getLinesContent(),
            declText: window.__panes.decl.getValue(), implText: window.__panes.impl.getValue()
        }));
        const declLine = lines.decl.findIndex(l => /:\s*\w/.test(l) && !/FUNCTION_BLOCK/.test(l)) + 1;
        const declLine2 = lines.decl.findIndex((l, i) => i + 1 > declLine && /:\s*\w/.test(l)) + 1;
        const implLine = lines.impl.findIndex(l => /\w/.test(l)) + 1;
        const word = /[A-Za-z_]\w*/.exec(lines.impl[implLine - 1]);
        const implEnd = word.index + word[0].length + 1;
        await page.evaluate((a) => window.postMessage({ type: 'online/values', items: [
            { componentId: 'root', pane: 'decl', line: a.declLine, startColumn: 2, endColumn: 5, eol: true, text: '42', state: 'ok', path: 'X.a' },
            { componentId: 'root', pane: 'decl', line: a.declLine2, startColumn: 2, endColumn: 5, eol: true, text: 'type differs', state: 'differs', path: 'X.b' },
            { componentId: 'root', pane: 'impl', line: a.implLine, startColumn: a.implStart, endColumn: a.implEnd, eol: false, text: 'TRUE', state: 'stopped', path: 'X.c' },
            { componentId: 'method_Other', pane: 'impl', line: 1, startColumn: 1, endColumn: 2, eol: false, text: 'NOPE', state: 'ok', path: 'X.d' },
            { componentId: 'root', pane: 'impl', line: 9999, startColumn: 1, endColumn: 2, eol: false, text: 'GONE', state: 'ok', path: 'X.e' }
        ] }, '*'), { declLine, declLine2, implLine, implStart: word.index + 1, implEnd });
        await settle(300);
        const drawn = await page.evaluate(() => {
            const deco = (ed) => ed.getModel().getAllDecorations().filter(d => d.options.after && /tc-online-value/.test(d.options.after.inlineClassName || ''))
                .map(d => ({ line: d.range.startLineNumber, col: d.range.startColumn, text: d.options.after.content, cls: d.options.after.inlineClassName }));
            const dom = (ed) => [...ed.getDomNode().querySelectorAll('.tc-online-value')].map(e => e.textContent);
            return { decl: deco(window.__panes.decl), impl: deco(window.__panes.impl), domDecl: dom(window.__panes.decl), domImpl: dom(window.__panes.impl),
                declText: window.__panes.decl.getValue(), implText: window.__panes.impl.getValue(),
                declMax: window.__panes.decl.getModel().getLineMaxColumn(1) };
        });
        const d1 = drawn.decl.find(d => d.line === declLine);
        assert(d1 && d1.text === '42' && /tc-online-eol/.test(d1.cls) && /tc-online-ok/.test(d1.cls),
            `a declaration value is drawn at the end of its line (${JSON.stringify(d1)})`);
        const d2 = drawn.decl.find(d => d.line === declLine2);
        assert(d2 && d2.text === 'type differs' && /tc-online-differs/.test(d2.cls), 'a type mismatch is drawn as "type differs", in its own style');
        const i1 = drawn.impl.find(d => d.line === implLine);
        assert(i1 && i1.text === 'TRUE' && i1.col === implEnd && /tc-online-stopped/.test(i1.cls),
            `an implementation value sits right after the variable, dimmed while the PLC is stopped (${JSON.stringify(i1)})`);
        assert(!drawn.impl.some(d => d.text === 'NOPE' || d.text === 'GONE'), 'values of another component, or for a line that no longer exists, are not drawn');
        assert(drawn.domDecl.includes('42') && drawn.domImpl.includes('TRUE'), `the values are on screen (${JSON.stringify([drawn.domDecl, drawn.domImpl])})`);
        assert(drawn.declText === lines.declText && drawn.implText === lines.implText, 'drawing values changes neither pane\'s text (save stays byte-identical)');

        // ── actions ──────────────────────────────────────────────────────────────────────────────
        await page.evaluate((a) => {
            window.__harness.sent.length = 0;
            const ed = window.__panes.impl;
            ed.setPosition({ lineNumber: a.line, column: a.col });
            ed.getAction('tc.online.write').run();
            ed.getAction('tc.online.addWatch').run();
        }, { line: implLine, col: word.index + 2 });
        await settle(100);
        const asked = await page.evaluate(() => window.__harness.sent.filter(m => /^online\/(write|addWatch)$/.test(m.type)));
        assert(asked.length === 2 && asked[0].type === 'online/write' && asked[1].type === 'online/addWatch'
            && asked[0].pane === 'impl' && asked[0].componentId === 'root' && asked[0].position.lineNumber === implLine
            && asked[0].position.column === word.index + 2 && typeof asked[0].impl === 'string' && asked[0].dirty === false,
            `Write Value… and Add to PLC Watch post the caret's pane position, the pane texts and the unsaved flag (${JSON.stringify(asked[0] && { pane: asked[0].pane, position: asked[0].position, dirty: asked[0].dirty })})`);

        // ── an edit makes the values stale ───────────────────────────────────────────────────────
        await page.evaluate(() => { window.__harness.sent.length = 0; });
        await page.evaluate(() => {
            const ed = window.__panes.impl;
            ed.executeEdits('harness', [{ range: new monaco.Range(1, 1, 1, 1), text: ' ' }]);
        });
        await settle(400);
        const afterEdit = await page.evaluate(() => ({
            impl: window.__panes.impl.getModel().getAllDecorations().filter(d => d.options.after && /tc-online-value/.test(d.options.after.inlineClassName || '')).length,
            visible: window.__harness.sent.filter(m => m.type === 'online/visible'),
            writes: window.__harness.sent.filter(m => m.type === 'edit')
        }));
        assert(afterEdit.impl === 0, 'an edit clears the drawn values at once');
        assert(afterEdit.visible.length >= 1 && afterEdit.visible[afterEdit.visible.length - 1].dirty === true,
            'and asks the host again for the new text, flagged as not yet written back (writes stay blocked)');
        // #16: the host answers the new request with the same values (the PLC did not change): drawn again.
        await page.evaluate((a) => window.postMessage({ type: 'online/values', items: [
            { componentId: 'root', pane: 'impl', line: a.implLine, startColumn: a.implStart, endColumn: a.implEnd + 1, eol: false, text: 'TRUE', state: 'ok', path: 'X.c' }] }, '*'),
        { implLine, implStart: word.index + 2, implEnd });
        await settle(200);
        const redrawn = await page.evaluate(() => window.__panes.impl.getModel().getAllDecorations()
            .filter(d => d.options.after && /tc-online-value/.test(d.options.after.inlineClassName || '')).map(d => d.options.after.content));
        assert(redrawn.includes('TRUE'), `#16 after an edit, the host's answer draws the values again (${JSON.stringify(redrawn)})`);
        await page.evaluate(() => { window.__panes.impl.trigger('harness', 'undo'); });
        await settle(400);

        // ── #15: the host's answer to online/visible does not trigger another online/visible ──────────
        const loop = await page.evaluate(async () => {
            const sent = window.__harness.sent;
            sent.length = 0;
            let seen = 0;
            // A host that answers every online/visible with an online/state, as refreshEditor does.
            const echo = setInterval(() => {
                const n = sent.filter(m => m.type === 'online/visible').length;
                if (n > seen) { seen = n; window.postMessage({ type: 'online/state', online: true, note: 'Instance: GVL_System.fbCylinder', writable: true }, '*'); }
            }, 5);
            // One reason to report: an edit (it clears the values and asks once).
            window.__panes.impl.executeEdits('harness', [{ range: new monaco.Range(1, 1, 1, 1), text: ' ' }]);
            await new Promise(r => setTimeout(r, 1500));
            clearInterval(echo);
            window.__panes.impl.trigger('harness', 'undo');
            return sent.filter(m => m.type === 'online/visible').length;
        });
        assert(loop === 1, `#15 one report, answered, stays one report: no host<->webview loop (${loop} online/visible in 1.5 s)`);
        await page.evaluate(() => window.postMessage({ type: 'online/state', online: true, note: 'Instance: GVL_System.fbCylinder', writable: true }, '*'));
        await settle(100);

        // ── component switch and going offline ───────────────────────────────────────────────────
        await page.evaluate((a) => window.postMessage({ type: 'online/values', items: [
            { componentId: 'root', pane: 'decl', line: a, startColumn: 2, endColumn: 5, eol: true, text: '7', state: 'ok', path: 'X.a' }] }, '*'), declLine);
        await settle(200);
        await page.evaluate(() => { window.__harness.sent.length = 0; window.postMessage({ type: 'online/state', online: false, note: '' }, '*'); });
        await settle(300);
        const off = await page.evaluate(() => ({
            decl: window.__panes.decl.getModel().getAllDecorations().filter(d => d.options.after && /tc-online-value/.test(d.options.after.inlineClassName || '')).length,
            noteHidden: document.getElementById('online-note').hidden,
            write: window.__panes.impl.getAction('tc.online.write').isSupported(),
            visible: window.__harness.sent.filter(m => m.type === 'online/visible').length,
            plcHidden: document.getElementById('plc-menu-section').hidden,
            chipHidden: document.getElementById('plc-indicator').hidden
        }));
        assert(off.decl === 0 && off.noteHidden && !off.write && off.visible === 0 && off.plcHidden && off.chipHidden,
            `going offline removes every value, hides the note, the PLC group and its chip, disables Write Value… and stops reporting (${JSON.stringify(off)})`);
        // A late toggle state after going offline does not bring the button back.
        await page.evaluate(() => window.postMessage({ type: 'online/plc', online: true, action: 'stop', plcState: 'Run', busy: false, reason: '' }, '*'));
        await settle(100);
        assert(await page.evaluate(() => document.getElementById('plc-menu-section').hidden && document.getElementById('plc-indicator').hidden),
            'a toggle state arriving while offline keeps the PLC group and its chip hidden');

        // The toolbar with every chip showing (online note, PLC state, Building…) stays inside a
        // narrow editor: nothing pushed off the right edge, no sideways scroll, the open menu fits.
        await page.evaluate(() => {
            window.postMessage({ type: 'online/state', online: true, note: 'Instance: GVL_System.fbCylinder', writable: true }, '*');
            window.postMessage({ type: 'online/plc', online: true, action: 'stop', plcState: 'Run', busy: false, reason: '' }, '*');
            window.postMessage({ type: 'compileRunning', running: true }, '*');
        });
        await settle(150);
        const vp = page.viewportSize();
        for (const width of [360, 560, 760, 800, 900, 1000, 1200]) {
            await page.setViewportSize({ width, height: vp.height });
            await settle(80);
            await page.click('#actions-btn');
            const t = await page.evaluate(() => {
                const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; };
                const m = document.getElementById('actions-menu').getBoundingClientRect();
                return { w: window.innerWidth, actions: box('actions-btn'), plc: box('plc-indicator'), build: box('build-indicator'), status: box('save-status'), note: box('online-note'),
                    menu: { left: Math.round(m.left), right: Math.round(m.right), bottom: Math.round(m.bottom), h: window.innerHeight },
                    sideScroll: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth };
            });
            await page.keyboard.press('Escape');
            const inside = (b) => b.width > 0 && b.left >= 0 && b.right <= t.w;
            assert(inside(t.actions) && inside(t.plc) && inside(t.build) && inside(t.status) && t.note.right <= t.w && !t.sideScroll
                && t.menu.left >= 0 && t.menu.right <= t.w && t.menu.bottom <= t.menu.h,
            `at ${width}px online, every chip and the status are inside the editor, no sideways scroll, and the open menu fits (${JSON.stringify(t)})`);
        }
        await page.setViewportSize(vp);
        await page.evaluate(() => window.postMessage({ type: 'compileRunning', running: false }, '*'));
        await settle(50);

        if (process.env.HARNESS_TOOLBAR_SHOTS) {
            // The toolbar online, PLC in Run: closed (the chips) and open (the PLC group).
            await page.evaluate(() => {
                window.postMessage({ type: 'online/state', online: true, note: 'Instance: GVL_System.fbCylinder', writable: true }, '*');
                window.postMessage({ type: 'online/plc', online: true, action: 'stop', plcState: 'Run', busy: false, reason: '' }, '*');
            });
            await settle(200);
            const w = page.viewportSize().width;
            await page.screenshot({ path: path.join(process.env.HARNESS_TOOLBAR_SHOTS, 'actions-online-closed.png'), clip: { x: 0, y: 0, width: w, height: 90 } });
            await page.click('#actions-btn');
            await settle(80);
            await page.screenshot({ path: path.join(process.env.HARNESS_TOOLBAR_SHOTS, 'actions-online-open.png'), clip: { x: 0, y: 0, width: w, height: 560 } });
            await page.keyboard.press('Escape');
            console.log('online toolbar screenshots written to ' + process.env.HARNESS_TOOLBAR_SHOTS);
        }
        assert(consoleErrors.length === 0, `the browser reported no errors (${consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 3)) : 'none'})`);
        if (process.env.HARNESS_ONLINE_SHOT) {
            await page.evaluate((a) => {
                window.postMessage({ type: 'online/state', online: true, note: 'Instance: GVL_System.fbCylinder', writable: true }, '*');
                window.postMessage({ type: 'online/plc', online: true, action: 'stop', plcState: 'Run', busy: false, reason: '' }, '*');
                window.postMessage({ type: 'online/values', items: [
                    { componentId: 'root', pane: 'decl', line: a.declLine, startColumn: 2, endColumn: 5, eol: true, text: '42', state: 'ok', path: 'X.a' },
                    { componentId: 'root', pane: 'impl', line: a.implLine, startColumn: 1, endColumn: a.implEnd, eol: false, text: 'TRUE', state: 'ok', path: 'X.c' }] }, '*');
            }, { declLine, implLine, implEnd });
            await settle(300);
            await page.screenshot({ path: process.env.HARNESS_ONLINE_SHOT });
            console.log('screenshot written to ' + process.env.HARNESS_ONLINE_SHOT);
        }
    } finally {
        await browser.close();
        served.server.close();
    }
    if (errors) { console.error(`\n${errors} assertion(s) failed`); process.exit(1); }
    console.log('\nAll online-monitoring webview assertions passed.');
})().catch(err => {
    console.error('[FAIL] harness crashed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
