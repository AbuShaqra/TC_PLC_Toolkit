/**
 * @file make-icon.js
 * @description Generates media/icon.png, the extension's marketplace logo.
 *
 * The mark is a "TC" monogram over the word "TOOLKIT", white and red on a near-black plate.
 *
 * The letters are the real thing: this reads Segoe UI Bold from the system font directory, parses
 * its `glyf` outlines and scanline-fills them. An earlier version approximated the letterforms with
 * arcs and line segments and they looked hand-drawn, because that is what they were. Only the
 * rendered pixels end up in the repo — no font file is copied or redistributed.
 *
 * The repo has no image tooling and no build step, so the PNG is encoded by hand (zlib is stdlib).
 *
 * Run: node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;   // marketplace shows 128; rendering at 256 keeps it crisp on HiDPI
const SS = 4;       // supersampling factor per axis

const FONT = process.env.ICON_FONT || 'C:/Windows/Fonts/segoeuib.ttf';

// =================================================================================================
// TrueType: just enough to get outlines for a handful of Latin capitals.
// =================================================================================================

/**
 * Parses the tables this needs out of a TrueType font.
 * @param {Buffer} buf Raw .ttf bytes.
 */
function parseFont(buf) {
    const numTables = buf.readUInt16BE(4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
        const off = 12 + i * 16;
        tables[buf.toString('ascii', off, off + 4)] = {
            offset: buf.readUInt32BE(off + 8),
            length: buf.readUInt32BE(off + 12)
        };
    }

    const head = tables.head.offset;
    const unitsPerEm = buf.readUInt16BE(head + 18);
    const longLoca = buf.readInt16BE(head + 50) === 1;
    const numGlyphs = buf.readUInt16BE(tables.maxp.offset + 4);

    // loca: glyph id -> offset into glyf.
    const loca = new Array(numGlyphs + 1);
    for (let i = 0; i <= numGlyphs; i++) {
        loca[i] = longLoca
            ? buf.readUInt32BE(tables.loca.offset + i * 4)
            : buf.readUInt16BE(tables.loca.offset + i * 2) * 2;
    }

    // hmtx: advance widths (the last entry repeats for every glyph beyond numberOfHMetrics).
    const numHMetrics = buf.readUInt16BE(tables.hhea.offset + 34);
    const advance = (gid) => {
        const i = Math.min(gid, numHMetrics - 1);
        return buf.readUInt16BE(tables.hmtx.offset + i * 4);
    };

    return { buf, tables, unitsPerEm, loca, advance, cmap: parseCmap(buf, tables.cmap.offset) };
}

/** Builds a char-code -> glyph-id map from the font's Windows Unicode (format 4) subtable. */
function parseCmap(buf, cmapOff) {
    const n = buf.readUInt16BE(cmapOff + 2);
    let sub = -1;
    for (let i = 0; i < n; i++) {
        const rec = cmapOff + 4 + i * 8;
        const platform = buf.readUInt16BE(rec);
        const encoding = buf.readUInt16BE(rec + 2);
        if (platform === 3 && (encoding === 1 || encoding === 0)) {
            sub = cmapOff + buf.readUInt32BE(rec + 4);
        }
    }
    if (sub < 0) throw new Error('no Windows Unicode cmap subtable');
    if (buf.readUInt16BE(sub) !== 4) throw new Error('cmap subtable is not format 4');

    const segX2 = buf.readUInt16BE(sub + 6);
    const seg = segX2 / 2;
    const endAt = sub + 14;
    const startAt = endAt + segX2 + 2;
    const deltaAt = startAt + segX2;
    const rangeAt = deltaAt + segX2;

    return (code) => {
        for (let i = 0; i < seg; i++) {
            if (buf.readUInt16BE(endAt + i * 2) < code) continue;
            const start = buf.readUInt16BE(startAt + i * 2);
            if (start > code) return 0;
            const delta = buf.readInt16BE(deltaAt + i * 2);
            const rangeOff = buf.readUInt16BE(rangeAt + i * 2);
            if (rangeOff === 0) return (code + delta) & 0xffff;
            const gi = rangeAt + i * 2 + rangeOff + (code - start) * 2;
            const g = buf.readUInt16BE(gi);
            return g === 0 ? 0 : (g + delta) & 0xffff;
        }
        return 0;
    };
}

/**
 * Reads one simple glyph's contours in font units.
 * @returns {Array<Array<{x: number, y: number, on: boolean}>>} One array of points per contour.
 */
function glyphContours(font, gid) {
    const { buf, tables, loca } = font;
    if (loca[gid] === loca[gid + 1]) return []; // empty glyph (e.g. space)

    let p = tables.glyf.offset + loca[gid];
    const numContours = buf.readInt16BE(p);
    if (numContours < 0) throw new Error(`glyph ${gid} is composite; not supported`);
    p += 10; // skip the bounding box

    const endPts = [];
    for (let i = 0; i < numContours; i++, p += 2) endPts.push(buf.readUInt16BE(p));
    const numPts = endPts[endPts.length - 1] + 1;

    p += 2 + buf.readUInt16BE(p); // skip hinting instructions

    // Flags, with the repeat-count encoding.
    const flags = [];
    while (flags.length < numPts) {
        const f = buf[p++];
        flags.push(f);
        if (f & 8) {
            let r = buf[p++];
            while (r-- > 0) flags.push(f);
        }
    }

    // Coordinates: deltas, each either 1 or 2 bytes depending on the flag bits.
    const readCoords = (shortBit, sameBit) => {
        const out = [];
        let v = 0;
        for (let i = 0; i < numPts; i++) {
            const f = flags[i];
            if (f & shortBit) {
                const d = buf[p++];
                v += (f & sameBit) ? d : -d;
            } else if (!(f & sameBit)) {
                v += buf.readInt16BE(p);
                p += 2;
            }
            out.push(v);
        }
        return out;
    };
    const xs = readCoords(2, 16);
    const ys = readCoords(4, 32);

    const contours = [];
    let start = 0;
    for (const end of endPts) {
        const pts = [];
        for (let i = start; i <= end; i++) {
            pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
        }
        contours.push(pts);
        start = end + 1;
    }
    return contours;
}

/**
 * Flattens a glyph's quadratic contours into polygons, mapping font units to device pixels.
 * TrueType y points up and the page's y points down, hence the flip.
 * @returns {Array<Array<number[]>>} Polygons, each an array of [x, y] device-space points.
 */
function glyphPolygons(font, gid, scale, originX, baselineY) {
    const polys = [];
    const at = (pt) => [originX + pt.x * scale, baselineY - pt.y * scale];

    for (const contour of glyphContours(font, gid)) {
        if (!contour.length) continue;

        // TrueType may start a contour on an off-curve point, and may imply an on-curve point
        // midway between two consecutive off-curve points. Normalise both away first.
        const pts = contour.slice();
        if (!pts[0].on) {
            const last = pts[pts.length - 1];
            pts.unshift(last.on
                ? last
                : { x: (pts[0].x + last.x) / 2, y: (pts[0].y + last.y) / 2, on: true });
        }

        const poly = [at(pts[0])];
        for (let i = 1; i <= pts.length; i++) {
            const cur = pts[i % pts.length];
            if (cur.on) {
                poly.push(at(cur));
                continue;
            }
            let next = pts[(i + 1) % pts.length];
            if (!next.on) {
                next = { x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2, on: true };
            } else {
                i++;
            }
            // Flatten the quadratic. 12 steps is well past the point of visible faceting at 256px.
            const p0 = poly[poly.length - 1];
            const p1 = at(cur);
            const p2 = at(next);
            for (let t = 1; t <= 12; t++) {
                const u = t / 12;
                const iu = 1 - u;
                poly.push([
                    iu * iu * p0[0] + 2 * iu * u * p1[0] + u * u * p2[0],
                    iu * iu * p0[1] + 2 * iu * u * p1[1] + u * u * p2[1]
                ]);
            }
        }
        polys.push(poly);
    }
    return polys;
}

/**
 * Lays out a string and returns its polygons, centred horizontally on the plate.
 * @param {number} capHeight Desired height of a capital letter, in pixels.
 * @param {number} baselineY Device y of the baseline.
 * @param {number} tracking Extra letter spacing, in pixels.
 */
function textPolygons(font, text, capHeight, baselineY, tracking) {
    // Scale from the cap height of "T" rather than unitsPerEm, so the optical size is predictable.
    const capGid = font.cmap('T'.charCodeAt(0));
    let capTop = 0;
    for (const c of glyphContours(font, capGid)) {
        for (const pt of c) capTop = Math.max(capTop, pt.y);
    }
    const scale = capHeight / capTop;

    const gids = [...text].map(ch => font.cmap(ch.charCodeAt(0)));
    const width = gids.reduce((w, g) => w + font.advance(g) * scale + tracking, -tracking);

    let x = (SIZE - width) / 2;
    const polys = [];
    for (const gid of gids) {
        polys.push(...glyphPolygons(font, gid, scale, x, baselineY));
        x += font.advance(gid) * scale + tracking;
    }
    return polys;
}

// =================================================================================================
// Rasterizer: scanline fill with the nonzero winding rule, at SS x SS subsamples per pixel.
// =================================================================================================

/** @returns {Float32Array} Per-pixel coverage in 0..1, length SIZE*SIZE. */
function rasterize(polys) {
    const cov = new Float32Array(SIZE * SIZE);
    const edges = [];
    for (const poly of polys) {
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
        }
    }
    if (!edges.length) return cov;

    const hits = [];
    for (let sy = 0; sy < SIZE * SS; sy++) {
        const y = (sy + 0.5) / SS;
        hits.length = 0;
        for (const [x1, y1, x2, y2] of edges) {
            if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) {
                hits.push([x1 + ((y - y1) / (y2 - y1)) * (x2 - x1), y2 > y1 ? 1 : -1]);
            }
        }
        if (!hits.length) continue;
        hits.sort((a, b) => a[0] - b[0]);

        const row = (sy / SS) | 0;
        let winding = 0;
        for (let i = 0; i < hits.length - 1; i++) {
            winding += hits[i][1];
            if (winding === 0) continue;                    // outside the shape
            const xa = hits[i][0];
            const xb = hits[i + 1][0];
            const sxa = Math.max(0, Math.ceil(xa * SS - 0.5));
            const sxb = Math.min(SIZE * SS - 1, Math.floor(xb * SS - 0.5));
            for (let sx = sxa; sx <= sxb; sx++) {
                cov[row * SIZE + ((sx / SS) | 0)] += 1;
            }
        }
    }

    const n = SS * SS;
    for (let i = 0; i < cov.length; i++) cov[i] = Math.min(1, cov[i] / n);
    return cov;
}

// =================================================================================================
// Compose
// =================================================================================================

/** Distance to a rounded rectangle centred at (cx, cy); negative inside. */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
    const dx = Math.abs(px - cx) - (halfW - r);
    const dy = Math.abs(py - cy) - (halfH - r);
    const ax = Math.max(dx, 0);
    const ay = Math.max(dy, 0);
    return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
}

const BG_TOP = [0x24, 0x24, 0x26];      // near-black, faintly lifted so the plate reads as a solid
const BG_BOTTOM = [0x08, 0x08, 0x09];   // black
const MONO = [0xff, 0xff, 0xff];        // white: the TC monogram
const ACCENT = [0xe1, 0x1b, 0x22];      // red: the TOOLKIT wordmark

const font = parseFont(fs.readFileSync(FONT));
const covTC = rasterize(textPolygons(font, 'TC', 92, 150, 4));
const covWord = rasterize(textPolygons(font, 'TOOLKIT', 34, 208, 6));

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1)); // one filter byte per scanline
let p = 0;
for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
        // Plate: supersampled so the rounded corners stay smooth.
        let plate = 0;
        for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
                const d = sdRoundRect(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, 128, 128, 124, 124, 40);
                plate += Math.max(0, Math.min(1, 0.5 - d));
            }
        }
        plate /= SS * SS;

        const t = y / SIZE;
        const rgb = [
            BG_TOP[0] * (1 - t) + BG_BOTTOM[0] * t,
            BG_TOP[1] * (1 - t) + BG_BOTTOM[1] * t,
            BG_TOP[2] * (1 - t) + BG_BOTTOM[2] * t
        ];

        const i = y * SIZE + x;
        for (const [color, a] of [[MONO, covTC[i]], [ACCENT, covWord[i]]]) {
            if (a <= 0) continue;
            rgb[0] = rgb[0] * (1 - a) + color[0] * a;
            rgb[1] = rgb[1] * (1 - a) + color[1] * a;
            rgb[2] = rgb[2] * (1 - a) + color[2] * a;
        }

        raw[p++] = Math.round(rgb[0]);
        raw[p++] = Math.round(rgb[1]);
        raw[p++] = Math.round(rgb[2]);
        raw[p++] = Math.round(plate * 255);
    }
}

// =================================================================================================
// PNG
// =================================================================================================

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // colour type: RGBA
ihdr[10] = 0;  // deflate
ihdr[11] = 0;  // adaptive filtering
ihdr[12] = 0;  // no interlace

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes) using ${path.basename(FONT)}`);
