/**
 * @file make-icon.js
 * @description Generates media/marketplace-icon.png, the extension's marketplace logo (the square
 * one `package.json` points at). The 1280x640 GitHub social preview, media/icon.png, is the same
 * mark drawn by make-social-preview.js; the renderer they share is glyphRaster.js.
 *
 * The mark is a "TC" monogram over the word "TOOLKIT", white and red on a near-black plate, set in
 * Segoe UI Bold read from the system font directory (only the rendered pixels end up in the repo).
 *
 * Run: node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const { loadFont, Canvas, drawMark } = require('./glyphRaster');

const SIZE = 256;   // marketplace shows 128; rendering at 256 keeps it crisp on HiDPI
const FONT = process.env.ICON_FONT || 'C:/Windows/Fonts/segoeuib.ttf';

const canvas = new Canvas(SIZE, SIZE);
drawMark(canvas, { bold: loadFont(FONT) }, 0, 0, SIZE);

const png = canvas.toPng();
const out = path.join(__dirname, '..', 'media', 'marketplace-icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes) using ${path.basename(FONT)}`);
