/**
 * @file probe_lib_format.js
 * @description Diagnostic probe (not a test — not wired into `npm test`).
 *
 * Determines the container format of the TwinCAT `.compiled-library` / `.library` files under
 * sample/**\/_Libraries. This gates how library symbols can be indexed:
 *   - ZIP (magic "PK") -> extractable with Node's built-in zlib, no new dependencies.
 *   - OLE2 / proprietary -> deep extraction is expensive and needs re-scoping.
 * It also checks whether known library symbols (TIMESTRUCT, F_WORD, ...) are recoverable as
 * plain strings, which would allow a cheap symbol-name harvest even without a full decoder.
 *
 * See HANDOFF.md — "The main open problem" / pending pipeline step 1.
 *
 * Usage: node scratch/probe_lib_format.js
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample');

if (!fs.existsSync(SAMPLE_DIR)) {
    console.log('sample/ project not present — nothing to probe.');
    process.exit(0);
}

/** Recursively collects every library container file under a directory. */
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.(compiled-library|library)$/i.test(e.name)) out.push(full);
    }
    return out;
}

const files = walk(SAMPLE_DIR);
if (files.length === 0) {
    console.log('No .compiled-library / .library files found under sample/.');
    process.exit(0);
}
console.log(`Found ${files.length} library container file(s).\n`);

// --- 1. Distinct container magics -------------------------------------------------
const magics = new Map();
for (const f of files) {
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    const hex = buf.subarray(0, 4).toString('hex');
    if (!magics.has(hex)) magics.set(hex, []);
    magics.get(hex).push(path.basename(f));
}

console.log('=== distinct 4-byte magics ===');
for (const [hex, names] of magics) {
    const bytes = Buffer.from(hex, 'hex');
    const ascii = [...bytes].map(c => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
    let guess = 'unknown / proprietary';
    if (hex.startsWith('504b')) guess = 'ZIP (PK) -> extractable via node zlib, no new deps';
    else if (hex.startsWith('d0cf11e0')) guess = 'OLE2 compound file -> needs a structured-storage reader';
    else if (hex.startsWith('1f8b')) guess = 'gzip -> node zlib';
    console.log(`  ${hex}  "${ascii}"  x${names.length}  => ${guess}`);
    console.log(`      e.g. ${names.slice(0, 3).join(', ')}`);
}

// --- 2. Are symbol names recoverable as plain strings? -----------------------------
const probe = files.find(f => /tc2_system/i.test(f)) || files[0];
console.log(`\n=== string probe on ${path.basename(probe)} ===`);
const data = fs.readFileSync(probe);

/** Extracts printable ASCII runs of at least minLen characters. */
function printableRuns(buf, minLen) {
    const out = [];
    let cur = '';
    for (const byte of buf) {
        if (byte >= 32 && byte < 127) {
            cur += String.fromCharCode(byte);
        } else {
            if (cur.length >= minLen) out.push(cur);
            cur = '';
        }
    }
    if (cur.length >= minLen) out.push(cur);
    return out;
}

const runs = printableRuns(data, 6);
console.log(`printable ASCII runs (>=6 chars): ${runs.length}`);

// Symbols the real sample project flags as undeclared — if these are recoverable,
// a cheap name-harvest is possible even without decoding the container.
const wanted = ['TIMESTRUCT', 'GETSYSTEMTIME', 'F_WORD', 'FB_FormatString', 'MEMCPY', 'LTIME'];
for (const w of wanted) {
    const hit = runs.some(r => r.toUpperCase().includes(w.toUpperCase()));
    console.log(`  ${hit ? 'FOUND  ' : 'absent '} ${w}`);
}

console.log('\nlongest runs (sample):');
runs.sort((a, b) => b.length - a.length)
    .slice(0, 8)
    .forEach(r => console.log('   ', JSON.stringify(r.slice(0, 90))));
