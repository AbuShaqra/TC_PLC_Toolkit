/**
 * @file make-icon.js
 * @description Generates media/marketplace-icon.png, the extension's marketplace logo (the square
 * one `package.json` points at), from its SVG source scripts/logo/tc-toolkit-mark.svg (2026-11-16,
 * the "native" redesign: a flat tile, a geometric "TC", one true-red #E2001A square). The SVG is
 * rendered by Chromium through Playwright at 256x256 (the marketplace shows 128; 256 keeps it
 * crisp on HiDPI), so the PNG is exactly what a browser draws from the committed source.
 *
 * Playwright is not a dependency of the extension: install it next to the repo (or globally) and
 * point PLAYWRIGHT_BROWSERS_PATH at a Chromium, as for test/browser/.
 *
 * The 1280x640 GitHub social preview (media/icon.png, scripts/make-social-preview.js) is still drawn
 * by glyphRaster.js with the earlier mark.
 *
 * Run: node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');

const SIZE = 256;
const SOURCE = path.join(__dirname, 'logo', 'tc-toolkit-mark.svg');
const OUT = path.join(__dirname, '..', 'media', 'marketplace-icon.png');

(async () => {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (e) {
        console.error('make-icon.js needs Playwright: npm i --no-save playwright && npx playwright install chromium');
        process.exit(1);
    }
    const svg = fs.readFileSync(SOURCE, 'utf8');
    const browser = await chromium.launch(process.env.HARNESS_CHROMIUM ? { executablePath: process.env.HARNESS_CHROMIUM } : {});
    try {
        const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
        await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:transparent">` +
            `<img id="mark" width="${SIZE}" height="${SIZE}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
        await page.waitForFunction('document.getElementById("mark").complete');
        const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
        fs.writeFileSync(OUT, png);
        console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes) from ${path.relative(process.cwd(), SOURCE)}`);
    } finally {
        await browser.close();
    }
})();
