/**
 * @file test/browser/run_start_page.js
 * @description Drives the TwinCAT start page (roadmap R2) in a real Chromium: renders the page the
 * extension ships (src/startPageHtml.js, media/startPage.{js,css}, media/projectName.js) with its CSP
 * intact, and checks that it loads nothing remote, validates the project name as the user types,
 * posts the right message for every control, shows results the host sends back, and has no
 * horizontal scroll at 360 px.
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
        assert(await disabled('#strucpp-check'), 'Check with STruC++ is disabled');

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
