/**
 * @file make-social-preview.js
 * @description Generates media/icon.png, the 1280x640 image GitHub shows when the repository is
 * linked (Settings → Social preview; this file is the source to upload there and to embed in the
 * README). It is the marketplace mark from make-icon.js, drawn by the same code, beside the product
 * name and a one-line description. The renderer they share is glyphRaster.js.
 *
 * Run: node scripts/make-social-preview.js
 */

const fs = require('fs');
const path = require('path');
const {
    loadFont, layoutText, measureText, rasterize, Canvas, drawMark, ACCENT
} = require('./glyphRaster');

const W = 1280;
const H = 640;
const FONT_DIR = process.env.ICON_FONT_DIR || 'C:/Windows/Fonts';
const fonts = {
    bold: loadFont(path.join(FONT_DIR, 'segoeuib.ttf')),
    regular: loadFont(path.join(FONT_DIR, 'segoeui.ttf')),
    light: loadFont(path.join(FONT_DIR, 'segoeuil.ttf'))
};

// Background: a diagonal near-black gradient, a shade darker than the plate so the mark still reads
// as an object sitting on it. Fully opaque — GitHub composes the preview over white otherwise.
const BG_A = [0x15, 0x15, 0x17];
const BG_B = [0x0a, 0x0a, 0x0b];
const TITLE = [0xf4, 0xf4, 0xf5];
const BODY = [0xa7, 0xa7, 0xad];
const MUTED = [0x6b, 0x6b, 0x72];

const canvas = new Canvas(W, H);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const t = (x / W + y / H) / 2;
        canvas.blend(y * W + x, [0, 1, 2].map(k => BG_A[k] * (1 - t) + BG_B[k] * t), 1);
    }
}

// Layout: the mark on the left, the text block set against it on the right.
const MARK = 360;
const MARK_X = 112;
const MARK_Y = (H - MARK) / 2;
drawMark(canvas, fonts, MARK_X, MARK_Y, MARK);

const TEXT_X = MARK_X + MARK + 84;
const RIGHT = 80;
const TEXT_W = W - TEXT_X - RIGHT;

/** Fills one line of text at (x, baseline) in `color`. */
function text(font, str, capHeight, x, baseline, color, tracking = 0) {
    canvas.fill(rasterize(layoutText(font, str, capHeight, x, baseline, tracking).polys, W, H), color);
}

/** Greedy word wrap to TEXT_W. */
function wrap(font, str, capHeight) {
    const lines = [];
    let line = '';
    for (const word of str.split(' ')) {
        const probe = line ? `${line} ${word}` : word;
        if (line && measureText(font, probe, capHeight) > TEXT_W) {
            lines.push(line);
            line = word;
        } else {
            line = probe;
        }
    }
    if (line) lines.push(line);
    return lines;
}

// Title: two lines so it stays large. "TwinCAT" carries the mark's white; "PLC Toolkit" its red.
const TITLE_CAP = 66;
const TITLE_LEAD = 92;
let y = MARK_Y + 78;
text(fonts.bold, 'TwinCAT', TITLE_CAP, TEXT_X, y, TITLE);
y += TITLE_LEAD;
text(fonts.bold, 'PLC Toolkit', TITLE_CAP, TEXT_X, y, ACCENT);

// Rule: a short red bar, the same accent, anchoring the description.
y += 46;
for (let yy = y; yy < y + 4; yy++) {
    for (let x = TEXT_X; x < TEXT_X + 72; x++) canvas.blend(yy * W + x, ACCENT, 1);
}

// Description, wrapped. Sized so it sets in three lines; a fourth would run into the footer.
const DESC = 'Edit, navigate and analyse Beckhoff TwinCAT PLC projects in VS Code: a two-pane ' +
    'Structured Text editor, offline IntelliSense and diagnostics, object and library explorers.';
const DESC_CAP = 17;
const DESC_LEAD = 36;
y += 28 + DESC_CAP;
const lines = wrap(fonts.regular, DESC, DESC_CAP);
if (lines.length > 3) throw new Error(`description wraps to ${lines.length} lines; shorten it or the text collides with the footer`);
for (const line of lines) {
    text(fonts.regular, line, DESC_CAP, TEXT_X, y, BODY);
    y += DESC_LEAD;
}

// Footer: the file types the extension owns, and the disclaimer the marketplace listing carries.
// Sits on the mark's bottom edge, or below the description if that ran longer.
const FOOT_CAP = 13;
const footY = Math.max(MARK_Y + MARK - 4, y - DESC_LEAD + 30 + FOOT_CAP);
text(fonts.regular, '.TcPOU   .TcGVL   .TcDUT   .TcIO', FOOT_CAP, TEXT_X, footY, MUTED, 1);
const disclaimer = 'Unofficial; not affiliated with Beckhoff';
text(fonts.light, disclaimer, FOOT_CAP, W - RIGHT - measureText(fonts.light, disclaimer, FOOT_CAP), footY, MUTED);

const png = canvas.toPng();
const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${W}x${H}, ${png.length} bytes)`);
