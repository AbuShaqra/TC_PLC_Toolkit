/**
 * @file test/browser/run_start_page.js
 * @description Drives the start page (roadmap R2) in a real Chromium: renders the page the
 * extension ships (src/startPageHtml.js, media/startPage.{js,css}, media/projectName.js) with its CSP
 * intact, and checks that it loads nothing remote, validates the project name as the user types,
 * posts the right message for every control, shows results the host sends back, limits the recent
 * list to the configured number of rows behind a keyboard-operable "Show all (K)" / "Show fewer" tile,
 * shows the XAE Shell paths (with a warning for a path that is not on disk), enables Compile project
 * only while the compiler file exists (by default the bundled one) and a project is open, shows and
 * posts the Compile dropdown's two C++ switches (R13, keyboard-operable), and has no horizontal
 * scroll at 360 px.
 *
 * Only `acquireVsCodeApi()` is stubbed (through Playwright's init script, which the CSP does not
 * block): it records what the page posts, standing in for the extension host.
 *
 * NOT part of `npm test`: it needs a browser. Playwright is an optional, unsaved dependency.
 *
 *     npm i --no-save playwright        # the package (browsers usually already present)
 *     npx playwright install chromium   # only if the browser itself is missing
 *     node test/browser/run_start_page.js
 *
 * Exit codes: 0 pass, 1 an assertion failed, 2 cannot run (no Playwright / no browser).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
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

const { renderStartPageHtml } = require(path.join(REPO, 'src', 'startPageHtml.js'));
const { TEMPLATE_VERSIONS } = require(path.join(REPO, 'src', 'projectTemplate.js'));

(async () => {
    // 1. The real page, with the webview resource origin played by the harness server.
    const html = renderStartPageHtml({
        cspSource: ORIGIN,
        nonce: 'harnessNonce1',
        styleUri: `${ORIGIN}/media/startPage.css`,
        scriptUri: `${ORIGIN}/media/startPage.js`,
        nameScriptUri: `${ORIGIN}/media/projectName.js`,
        logoUri: `${ORIGIN}/media/marketplace-icon.png`,
        versions: TEMPLATE_VERSIONS
    });
    fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
    fs.writeFileSync(path.join(HERE, 'out', 'start.html'), html);
    // Stand-ins for the two theme colours the warning row uses (a page outside VS Code has none).
    fs.writeFileSync(path.join(HERE, 'out', 'theme.css'),
        ':root { --vscode-inputValidation-warningBorder: rgb(184, 149, 0); --vscode-editorWarning-foreground: rgb(184, 149, 0); }\n');

    const { start } = require('./serve.js');
    let served;
    try {
        served = await start(PORT);
    } catch (e) {
        console.error(`[FAIL] cannot serve on ${PORT} (${e.code}). Set HARNESS_PORT to a free port.`);
        process.exit(1);
    }
    const browser = await chromium.launch(
        process.env.HARNESS_CHROMIUM ? { executablePath: process.env.HARNESS_CHROMIUM } : {});
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addInitScript(() => {
        const w = /** @type {any} */ (window);
        w.__posted = [];
        w.__state = null;
        w.acquireVsCodeApi = () => ({
            postMessage: (m) => { w.__posted.push(m); },
            getState: () => w.__state,
            setState: (s) => { w.__state = s; }
        });
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const foreign = [];
    page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('request', r => { if (!r.url().startsWith(ORIGIN) && !r.url().startsWith('data:')) foreign.push(r.url()); });

    const posted = () => page.evaluate(() => /** @type {any} */ (window).__posted.slice());
    const clearPosted = () => page.evaluate(() => { /** @type {any} */ (window).__posted.length = 0; });
    // postMessage is delivered as a later task: resolve only once the page has had a turn to handle it,
    // or the next read races the handler (seen as a 1-in-4 flake on 'a picked folder replaces the location').
    const send = (m) => page.evaluate((msg) => new Promise((resolve) => {
        window.addEventListener('message', () => setTimeout(resolve, 0), { once: true });
        window.postMessage(msg, '*');
    }), m);
    const text = (sel) => page.$eval(sel, el => el.textContent);
    const visible = (sel) => page.$eval(sel, el => !el.hidden && getComputedStyle(el).display !== 'none');
    const disabled = (sel) => page.$eval(sel, el => /** @type {any} */ (el).disabled);

    try {
        await page.goto(`${ORIGIN}/harness/start.html`, { waitUntil: 'load' });

        // Boot: the page asks the host for its state.
        let msgs = await posted();
        assert(msgs.some(m => m.type === 'ready'), 'the page posts ready on load');
        assert(await disabled('#create-btn'), 'Create starts disabled (no name, no location)');
        assert(!(await visible('#name-error')), 'an untouched empty name shows no error yet');

        await send({
            type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: false,
            recents: [
                { slnPath: 'C:\\Projects\\Line_A\\Line_A.sln', name: 'Line_A' },
                { slnPath: 'D:\\Very\\Long\\Path\\That\\Keeps\\Going\\And\\Going\\For\\A\\While\\Plant_42\\Plant_42.sln', name: 'Plant_42' }
            ]
        });
        assert((await page.$eval('#location', el => /** @type {any} */ (el).value)) === 'C:\\Projects', 'state fills the default location');
        assert((await page.$$('#recent-list li')).length === 2 && !(await visible('#recent-empty')), 'state renders the recent solutions');
        assert(await page.$eval('[data-command="twincat.generateSt"]', el => /** @type {any} */ (el).disabled) && await visible('#no-project'),
            'project actions are disabled while no project is open');
        assert(await disabled('#compile-project'), 'Compile project is disabled');

        // Validation as the user types.
        for (const [bad, why] of [['1abc', /Start with a letter/], ['My Project', /letters, digits/], ['a__b', /two underscores/], ['Line_', /end the name/], ['CON', /reserved/]]) {
            await page.fill('#project-name', bad);
            assert(await visible('#name-error') && why.test(await text('#name-error')) && await disabled('#create-btn'),
                `"${bad}" is refused while typing (${await text('#name-error')})`);
            assert((await page.$eval('#project-name', el => el.getAttribute('aria-invalid'))) === 'true', `"${bad}" marks the field invalid`);
        }
        await page.fill('#project-name', 'Line_B');
        assert(!(await visible('#name-error')) && !(await disabled('#create-btn')), 'a valid name clears the error and enables Create');
        assert((await text('#plc-name')) === 'Line_B_PLC', 'the PLC project name follows the name');
        assert((await text('#target-path')) === 'Creates C:\\Projects\\Line_B\\Line_B.sln', `the target path is shown (${await text('#target-path')})`);

        // Create posts exactly the form.
        await page.selectOption('#tc-version', '3.1.4024');
        await clearPosted();
        await page.click('#create-btn');
        msgs = await posted();
        const create = msgs.find(m => m.type === 'create');
        assert(!!create && create.version === '3.1.4024' && create.name === 'Line_B' && create.location === 'C:\\Projects',
            `Create posts {version, name, location} (${JSON.stringify(create)})`);
        assert(await disabled('#create-btn') && /Creating/.test(await text('#create-btn')), 'Create is disabled while the host works');
        await send({ type: 'createResult', ok: false, error: 'C:\\Projects\\Line_B already contains a TwinCAT solution.' });
        assert(await visible('#create-error') && /already contains/.test(await text('#create-error')), 'a refusal from the host is shown on the page');
        assert(!(await disabled('#create-btn')) && (await text('#create-btn')) === 'Create', 'Create is usable again after a refusal');
        await send({ type: 'createResult', ok: true });
        assert((await page.$eval('#project-name', el => /** @type {any} */ (el).value)) === '' && await disabled('#create-btn'), 'after a successful create the name is cleared');

        // Every other control posts its message.
        await clearPosted();
        await page.click('#browse');
        await page.click('#open-project');
        await page.click('#recent-list li:nth-child(2) .recent-open');
        await page.click('#recent-list li:nth-child(1) .recent-remove');
        await page.click('[data-link="roadmap"]');
        await page.click('[data-link="reportIssue"]');
        await page.click('#settings [data-command="twincat.openSettings"]');
        msgs = await posted();
        const types = msgs.map(m => m.type + (m.id ? ':' + m.id : '') + (m.command ? ':' + m.command : ''));
        assert(JSON.stringify(types) === JSON.stringify(['browseLocation', 'openProject', 'openRecent', 'removeRecent', 'link:roadmap', 'link:reportIssue', 'command:twincat.openSettings']),
            `controls post browse/open/recent/remove/link/settings (${types.join(', ')})`);
        assert(msgs[2].slnPath.endsWith('Plant_42.sln') && msgs[3].slnPath.endsWith('Line_A.sln'), 'recent entries carry their own .sln path');
        await send({ type: 'location', location: 'E:\\Other' });
        assert((await page.$eval('#location', el => /** @type {any} */ (el).value)) === 'E:\\Other', 'a picked folder replaces the location');

        await send({ type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: true, recents: [] });
        await clearPosted();
        await page.click('[data-command="twincat.generateSt"]');
        await page.click('[data-command="twincat.updateLibraryDefinitions"]');
        msgs = await posted();
        assert(msgs.length === 2 && msgs[0].command === 'twincat.generateSt' && msgs[1].command === 'twincat.updateLibraryDefinitions',
            'with a project open the actions run Generate ST and Update Library Definitions');
        assert(await visible('#recent-empty'), 'an empty recent list says so');

        // ── Compile project: enabled while the compiler file exists (by default the bundled one) AND a project is open ──
        assert(await disabled('#compile-project') && /Compiler file not found/.test(await text('#compile-detail')) && await visible('#compile-missing'),
            `with a project but the compiler file missing (compilerReady false), Compile project is disabled and says so (${await text('#compile-detail')})`);
        assert(!/later release/i.test(await page.content()), 'Compile project is no longer "coming in a later release"');
        await send({ type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: false, compilerReady: true, recents: [] });
        assert(await disabled('#compile-project') && !(await visible('#compile-missing')),
            'with the compiler but no project, Compile project is disabled (and not marked missing)');
        await send({ type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: true, compilerReady: true, recents: [] });
        assert(!(await disabled('#compile-project')) && /external IEC 61131-3 compiler/.test(await text('#compile-detail')),
            `with the compiler and a project, Compile project is enabled (${await text('#compile-detail')})`);
        assert(!/STruC\+\+/i.test(await page.content()), 'the page names no compiler product');
        await clearPosted();
        await page.click('#compile-project');
        msgs = await posted();
        assert(msgs.length === 1 && msgs[0].type === 'command' && msgs[0].command === 'twincat.compileProject', 'clicking it runs twincat.compileProject');
        await send({ type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: true, compilerReady: false, recents: [] });
        assert(await disabled('#compile-project') && await visible('#compile-missing'), 'an override path to a missing file disables it again');

        // ── R13: the Compile dropdown (two checkboxes over the C++ settings) ──────────────────────
        const optState = () => page.evaluate(() => ({
            open: !document.getElementById('compile-options').hidden,
            expanded: document.getElementById('compile-options-toggle').getAttribute('aria-expanded'),
            cpp: document.getElementById('opt-generate-cpp').checked, gpp: document.getElementById('opt-build-gpp').checked,
            focus: document.activeElement ? document.activeElement.id : ''
        }));
        let os1 = await optState();
        assert(!os1.open && os1.expanded === 'false' && !os1.cpp && !os1.gpp, `the Compile options start closed and off (${JSON.stringify(os1)})`);
        await send({ type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: true, compilerReady: true, recents: [], compileOptions: { generateCpp: false, buildWithGpp: true } });
        os1 = await optState();
        assert(os1.cpp && os1.gpp, 'the state\'s compileOptions show in the boxes (the build shows generation on)');
        await clearPosted();
        await page.focus('#compile-options-toggle');
        await page.keyboard.press('Enter');
        os1 = await optState();
        assert(os1.open && os1.expanded === 'true' && os1.focus === 'opt-generate-cpp', `Enter on the chevron opens the options and focuses Generate C++ (${JSON.stringify(os1)})`);
        await page.keyboard.press('Space');
        os1 = await optState();
        msgs = await posted();
        assert(!os1.cpp && !os1.gpp && msgs.length === 1 && msgs[0].type === 'setCompileOption' && msgs[0].key === 'generateCpp' && msgs[0].value === false,
            `Space unticks Generate C++, which unticks Build with g++, and posts setCompileOption (${JSON.stringify(msgs)})`);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Space');
        os1 = await optState();
        msgs = await posted();
        assert(os1.cpp && os1.gpp && msgs.length === 2 && msgs[1].key === 'buildWithGpp' && msgs[1].value === true,
            `ArrowDown + Space ticks Build with g++, which ticks Generate C++ (${JSON.stringify(msgs)})`);
        assert(!msgs.some(m => m.type === 'command'), 'changing an option does not start a compile');
        await page.keyboard.press('Escape');
        os1 = await optState();
        assert(!os1.open && os1.expanded === 'false' && os1.focus === 'compile-options-toggle', `Escape closes the options and returns focus to the chevron (${JSON.stringify(os1)})`);
        await send({ type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: true, compilerReady: true, recents: [], compileOptions: { generateCpp: true, buildWithGpp: false } });
        os1 = await optState();
        assert(os1.cpp && !os1.gpp, 'a later state (a setting changed elsewhere) updates the boxes live');
        const toggleLabel = await page.evaluate(() => {
            const t = document.getElementById('compile-options-toggle');
            const opt = document.getElementById('compile-options');
            return { label: t.getAttribute('aria-label'), controls: t.getAttribute('aria-controls'), role: opt.getAttribute('role'),
                labels: [...opt.querySelectorAll('.option-label')].map(e => e.textContent) };
        });
        assert(toggleLabel.label === 'Compile options' && toggleLabel.controls === 'compile-options' && toggleLabel.role === 'group'
            && JSON.stringify(toggleLabel.labels) === '["Generate C++","Build with g++"]', `the chevron is labelled and controls a group of two labelled boxes (${JSON.stringify(toggleLabel)})`);
        await page.click('#compile-options-toggle');
        if (process.env.HARNESS_START_SHOT) {
            await page.mouse.move(0, 0);
            await page.waitForTimeout(300);
            const card = await page.$('#actions');
            await card.screenshot({ path: process.env.HARNESS_START_SHOT });
            console.log('start page actions screenshot written to ' + process.env.HARNESS_START_SHOT);
        }
        await page.click('#compile-options-toggle');

        // ── Recent list: at most `recentsShown` rows, then "Show all (K)" ──────────────────────────
        const eight = Array.from({ length: 8 }, (_, i) => ({ slnPath: `C:\\Projects\\Line_${i + 1}\\Line_${i + 1}.sln`, name: `Line_${i + 1}` }));
        const xaeShells = [
            { id: '4024', version: '3.1.4024', path: 'C:\\Program Files (x86)\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe', exists: true },
            { id: '4026', version: '3.1.4026', path: '', exists: false }
        ];
        const stateWith = (extra) => Object.assign({ type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: true, recents: eight, recentsShown: 5, xaeShells }, extra);
        const rows = () => page.$$eval('#recent-list li:not(.recent-toggle)', els => els.length);
        const toggleText = () => page.$eval('#recent-toggle', el => el.textContent).catch(() => null);
        const expanded = () => page.$eval('#recent-toggle', el => el.getAttribute('aria-expanded'));
        await send(stateWith({}));
        assert((await rows()) === 5 && (await toggleText()) === 'Show all (8)' && (await expanded()) === 'false',
            `8 stored, 5 shown: five rows and a "Show all (8)" tile (${await rows()} rows, "${await toggleText()}")`);
        assert((await text('#recent-list li:not(.recent-toggle) .recent-name')) === 'Line_1', 'the rows shown are the most recent ones');
        const tileStyle = await page.evaluate(() => {
            const pick = (el) => { const c = getComputedStyle(el); return [c.display, c.padding, c.borderRadius, c.borderTopWidth, c.backgroundColor].join('|'); };
            return [pick(document.querySelector('#recent-list li:not(.recent-toggle)')), pick(document.querySelector('#recent-list li.recent-toggle'))];
        });
        assert(tileStyle[0] === tileStyle[1], `the toggle is a tile like the rows above it (${tileStyle[1]})`);
        await page.click('#recent-toggle');
        assert((await rows()) === 8 && (await toggleText()) === 'Show fewer' && (await expanded()) === 'true', 'clicking it expands the list in place and it becomes "Show fewer"');
        assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'recent-toggle'), 'focus stays on the toggle after the list is rebuilt');
        await send(stateWith({}));
        assert((await rows()) === 8, 'a state refresh from the host keeps the list expanded');
        await page.focus('#recent-toggle');
        await page.keyboard.press('Enter');
        assert((await rows()) === 5 && (await toggleText()) === 'Show all (8)', 'Enter on the toggle collapses it again (keyboard operable)');
        await page.keyboard.press('Space');
        assert((await rows()) === 8, 'Space expands it');
        await page.keyboard.press('Space');
        assert(await page.$eval('#recent-toggle', el => el.tagName === 'BUTTON' && /** @type {any} */ (el).tabIndex === 0 && el.getAttribute('aria-controls') === 'recent-list'),
            'the toggle is a focusable button that names the list it controls');
        // Reachable with Tab from the last shown row's remove button.
        await page.focus('#recent-list li:nth-child(5) .recent-remove');
        await page.keyboard.press('Tab');
        assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'recent-toggle'), 'Tab from the last row reaches the toggle');
        await clearPosted();
        await page.click('#recent-toggle');
        assert((await posted()).length === 0, 'expanding is local to the page: nothing is posted to the host');
        await page.click('#recent-list li:nth-child(8) .recent-open');
        msgs = await posted();
        assert(msgs.length === 1 && msgs[0].type === 'openRecent' && msgs[0].slnPath.endsWith('Line_8.sln'), 'a row revealed by "Show all" opens its own solution');

        // The setting changes while the page is open.
        await send(stateWith({ recentsShown: 3 }));
        assert((await rows()) === 8 && (await toggleText()) === 'Show fewer', 'a new limit does not collapse an expanded list');
        await page.click('#recent-toggle');
        assert((await rows()) === 3 && (await toggleText()) === 'Show all (8)', 'collapsed, the new limit applies (3 rows)');
        await send(stateWith({ recentsShown: 10 }));
        assert((await rows()) === 8 && (await toggleText()) === null, 'a limit that covers every stored entry shows them all and no toggle');
        await send(stateWith({ recentsShown: 5, recents: eight.slice(0, 5) }));
        assert((await rows()) === 5 && (await toggleText()) === null, 'exactly as many stored as shown: no toggle');
        await send(stateWith({ recentsShown: 5 }));
        assert((await rows()) === 5 && (await toggleText()) === 'Show all (8)', 'the list starts collapsed again once the toggle had gone');
        await send(stateWith({ recentsShown: 1 }));
        assert((await rows()) === 1 && (await toggleText()) === 'Show all (8)', 'the minimum, 1, shows one row');
        const noLimit = stateWith({});
        delete noLimit.recentsShown;
        await send(stateWith({ recentsShown: 5 }));
        await send(noLimit);
        assert((await rows()) === 5, 'a state without a limit keeps the last one');

        // ── Settings card: the XAE Shell paths ─────────────────────────────────────────────────────
        const xaeRow = (id) => page.$eval(`#xae-list [data-xae="${id}"]`, el => ({ text: el.textContent, cls: el.className }));
        const r24 = await xaeRow('4024');
        let r26 = await xaeRow('4026');
        assert(r24.text === '3.1.4024:C:\\Program Files (x86)\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe' && !/missing|unset/.test(r24.cls),
            `a configured, existing path is shown as "3.1.4024: <path>" (${r24.text})`);
        assert(r26.text === '3.1.4026:not found' && /unset/.test(r26.cls) && !/missing/.test(r26.cls), `an empty setting reads "3.1.4026: not found" (${r26.text})`);
        await send(stateWith({ xaeShells: [xaeShells[0], { id: '4026', version: '3.1.4026', path: 'D:\\Old\\TcXaeShell.exe', exists: false }] }));
        r26 = await xaeRow('4026');
        assert(/missing/.test(r26.cls) && /D:\\Old\\TcXaeShell\.exe/.test(r26.text) && /does not exist/.test(r26.text), `a configured path that is not on disk carries a warning (${r26.text})`);
        assert(await visible('#xae-list [data-xae="4026"] .xae-warning'), 'the warning text is visible');
        // Outside VS Code the theme variables are unset, so the warning colours need stand-ins to be told apart.
        await page.addStyleTag({ url: `${ORIGIN}/harness/theme.css` });
        const themed = await page.evaluate(() => [...document.querySelectorAll('#xae-list li')].map(el => getComputedStyle(el).borderTopColor));
        assert(themed.length === 2 && themed[0] !== themed[1] && themed[1] === 'rgb(184, 149, 0)', `with theme colours the missing row is styled as a warning (${themed.join(' vs ')})`);
        await clearPosted();
        await page.click('#xae-change');
        await page.click('#settings [data-command="twincat.detectXaeShell"]');
        msgs = await posted();
        assert(msgs.length === 2 && msgs[0].type === 'openSettings' && msgs[0].section === 'xaeShell' && msgs[1].type === 'command' && msgs[1].command === 'twincat.detectXaeShell',
            `Change… posts openSettings {section: xaeShell}; Detect again posts the detect command (${JSON.stringify(msgs)})`);
        await send({ type: 'state', location: 'C:\\Projects', sep: '\\', hasProject: true, recents: [] });
        assert((await page.$$('#xae-list li')).length === 0 && await visible('#recent-empty'), 'a state without XAE paths renders no rows and breaks nothing');
        // Leave long content in place for the width checks below: an expanded list and a long, missing path.
        await send(stateWith({
            recents: eight.concat([{ slnPath: 'D:\\Very\\Long\\Path\\That\\Keeps\\Going\\And\\Going\\For\\A\\While\\Plant_42\\Plant_42.sln', name: 'Plant_42' }]),
            xaeShells: [xaeShells[0], { id: '4026', version: '3.1.4026', path: 'D:\\A\\Very\\Long\\Custom\\Install\\Location\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe', exists: false }]
        }));
        await page.click('#recent-toggle');
        assert((await rows()) === 9, 'the width checks below run with the list expanded (9 rows) and a long missing path');

        // Typed values survive the panel being hidden (vscode state).
        await page.fill('#project-name', 'Kept_1');
        const saved = await page.evaluate(() => /** @type {any} */ (window).__state);
        assert(saved && saved.name === 'Kept_1' && saved.location === 'E:\\Other', 'the form is saved to the webview state');

        // Narrow and wide: no horizontal scroll.
        for (const width of [360, 560, 1200]) {
            await page.setViewportSize({ width, height: 800 });
            await page.waitForTimeout(50);
            const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
            assert(m.sw <= m.cw, `no horizontal scroll at ${width} px (scrollWidth ${m.sw}, clientWidth ${m.cw})`);
        }
        const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length);
        assert(cols >= 2, `wide layout uses columns (${cols})`);
        await page.setViewportSize({ width: 360, height: 800 });
        const narrowCols = await page.evaluate(() => getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length);
        assert(narrowCols === 1, `360 px is a single column (${narrowCols})`);

        assert(foreign.length === 0, `no request leaves the page's own origin (${foreign.join(', ') || 'none'})`);
        assert(consoleErrors.length === 0, `the browser reported no errors (${consoleErrors.join(' | ') || 'none'})`);
    } finally {
        await browser.close();
        served.server.close();
    }
    console.log(errors === 0 ? '\nAll start-page browser assertions passed.' : `\n${errors} start-page browser assertion(s) FAILED.`);
    process.exit(errors ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
