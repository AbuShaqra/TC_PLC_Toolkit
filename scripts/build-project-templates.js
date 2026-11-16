/**
 * @file build-project-templates.js
 * @description Derives the two project templates the "Create New Project" command ships
 * (`resources/templates/tc3.1.4024/` and `resources/templates/tc3.1.4026/`) from XAE-authored
 * skeletons. Deterministic and re-runnable: a second run rewrites byte-identical files.
 *
 * Usage:   node scripts/build-project-templates.js          (write both templates)
 *          node scripts/build-project-templates.js --check  (exit 1 if the committed copies differ)
 *
 * Sources (never edited by this script):
 *   - 3.1.4024: `resources/templates/xae-3.1.4024/` — an empty solution XAE 3.1.4024.62 wrote (one
 *     `.tspproj`, no `_Config/`). Its GVL is emptied and renamed to `GVL_Main`.
 *   - 3.1.4026: the XAE 3.1.4026.22 skeleton under `sample/TcToolkitSample/` (`.sln`, `.tsproj`,
 *     `_Config/`, `.plcproj`, `PlcTask.TcTTO`). What `scripts/Create sample PLC project/build-sample-project.js`
 *     injected is stripped — its objects and their `<Compile>`/`<Folder>` entries — and so is what the
 *     sample gained by hand or by building it: the `TwinCat Dynamic Collections` library reference and
 *     the `<None Include="….tmc">` item. The sample's MAIN was overwritten with synthetic code, so the
 *     template's MAIN and GVL take XAE's own object text from the 4024 skeleton (no `ProductVersion`,
 *     because the 4026 `.plcproj` says `WriteProductVersion` false). No `.tmc` is ever written.
 *
 * Names become `TcTemplate` (solution and system project) and `TcTemplate_PLC` (PLC project);
 * `src/projectTemplate.js` reads them back from disk and renames them on create. GUIDs are kept as XAE
 * wrote them, except the two objects this script authors for 4026, whose Ids are derived (SHA-1 of a
 * fixed key) so a re-run cannot churn them. Each template is then checked: every GUID classified, the
 * expected file set, no source name left.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { applyNameMap, decodeText, inventoryGuids, listFiles } = require('../src/projectTemplate');

const REPO = path.resolve(__dirname, '..');
const TEMPLATES = path.join(REPO, 'resources', 'templates');
const XAE_4024 = path.join(TEMPLATES, 'xae-3.1.4024');
const SAMPLE_4026 = path.join(REPO, 'sample', 'TcToolkitSample');
const TEMPLATE_NAME = 'TcTemplate';
const GVL_NAME = 'GVL_Main';
const BOM = '﻿';

/** XAE's own `<Folder>` and library entries in a new standard PLC project (identical in both skeletons). */
const XAE_FOLDERS = ['DUTs', 'GVLs', 'VISUs', 'POUs'];
const XAE_LIBRARIES = ['Tc2_Standard', 'Tc2_System', 'Tc3_Module'];

/**
 * A stable GUID for an object this script authors.
 * @param {string} key
 * @returns {string} lower-case, without braces.
 */
function derivedGuid(key) {
    const h = crypto.createHash('sha1').update(`TcProjectTemplate|${key}`).digest('hex');
    const v = h.slice(0, 12) + '4' + h.slice(13, 16) + ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 32);
    return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/**
 * Replaces exactly one match, failing loudly when the anchor is missing or ambiguous.
 * @param {string} text
 * @param {RegExp} re Non-global.
 * @param {string|((m: string, ...g: string[]) => string)} replacement
 * @param {string} what
 * @returns {string}
 */
function replaceOnce(text, re, replacement, what) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    const count = (text.match(global) || []).length;
    if (count !== 1) throw new Error(`${what}: expected exactly one match, found ${count}`);
    // @ts-ignore — both replacement forms are valid for String.prototype.replace
    return text.replace(re, replacement);
}

/**
 * The 4024 XAE GVL with its sample variable removed: XAE's default GVL text.
 * @param {string} text GVL_Test.TcGVL without its BOM.
 * @param {{name: string, keepProductVersion: boolean, id?: string}} o
 * @returns {string}
 */
function emptyGvl(text, o) {
    let out = replaceOnce(text, /\tHelloWorld\t: STRING;\r\n/, '', 'GVL sample variable');
    out = replaceOnce(out, /<GVL Name="GVL_Test"/, `<GVL Name="${o.name}"`, 'GVL name');
    if (!o.keepProductVersion) out = replaceOnce(out, / ProductVersion="[^"]*"/, '', 'GVL ProductVersion');
    if (o.id) out = replaceOnce(out, /(<GVL [^>]*Id=")\{[^}]+\}/, `$1{${o.id}}`, 'GVL Id');
    return out;
}

/**
 * Removes one `<Tag Include="…">…</Tag>` or `<Tag Include="…" />` item (whole lines).
 * @param {string} text
 * @param {string} tag
 * @param {string} include
 * @returns {string}
 */
function removeItem(text, tag, include) {
    const inc = include.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`[ \\t]*<${tag} Include="${inc}"(?: />|>[\\s\\S]*?</${tag}>)\\r?\\n`);
    return replaceOnce(text, re, '', `${tag} ${include}`);
}

/**
 * Lists the `Include` values of one item kind.
 * @param {string} text
 * @param {string} tag
 * @returns {string[]}
 */
function includes(text, tag) {
    return [...text.matchAll(new RegExp(`<${tag} Include="([^"]+)"`, 'g'))].map(m => m[1]);
}

/**
 * @param {string} dir
 * @returns {Map<string, Buffer>} relative path → bytes
 */
function readTree(dir) {
    const out = new Map();
    for (const rel of listFiles(dir)) out.set(rel, fs.readFileSync(path.join(dir, ...rel.split('/'))));
    return out;
}

/**
 * Builds the 3.1.4024 template in memory.
 * @returns {Map<string, Buffer>}
 */
function build4024() {
    const src = readTree(XAE_4024);
    const nameMap = { TC_Sample_4024: TEMPLATE_NAME, TC_sample_4024_PLC: `${TEMPLATE_NAME}_PLC` };
    const out = new Map();
    for (const [rel, data] of src) {
        if (/README\.md$/i.test(rel)) continue;
        let outRel = applyNameMap(rel, nameMap);
        const ext = path.extname(rel).toLowerCase();
        if (!['.sln', '.tspproj', '.plcproj', '.tcpou', '.tcgvl', '.tctto'].includes(ext)) {
            throw new Error(`unexpected file in the 4024 skeleton: ${rel}`);
        }
        const { bom, text } = decodeText(data);
        let t = applyNameMap(text, nameMap);
        if (ext === '.tcgvl') {
            outRel = outRel.replace(/GVL_Test\.TcGVL$/, `${GVL_NAME}.TcGVL`);
            t = emptyGvl(t, { name: GVL_NAME, keepProductVersion: true });
        }
        if (ext === '.plcproj') {
            t = replaceOnce(t, /GVLs\\GVL_Test\.TcGVL/, `GVLs\\${GVL_NAME}.TcGVL`, '4024 GVL Compile item');
        }
        out.set(outRel, Buffer.from((bom ? BOM : '') + t, 'utf8'));
    }
    return out;
}

/**
 * Builds the 3.1.4026 template in memory.
 * @returns {Map<string, Buffer>}
 */
function build4026() {
    // What build-sample-project.js wrote: every object in its spec. MAIN is XAE's own default object
    // (the script overwrote its content, not its registration), so only its <Compile> survives.
    const { OBJECTS } = require('./Create sample PLC project/build-sample-project');
    const injected = OBJECTS.map(o => `${o.dir.split('/').join('\\')}\\${o.file}`).filter(inc => inc !== 'POUs\\MAIN.TcPOU');

    const nameMap = { TcToolkitSample: TEMPLATE_NAME, TcToolkitSample_PLC: `${TEMPLATE_NAME}_PLC` };
    const wanted = [
        'TcToolkitSample.sln',
        'TcToolkitSample.tsproj',
        '_Config/PLC/TcToolkitSample_PLC.xti',
        '_Config/TcToolkitSample_PLC/TcToolkitSample_PLC Instance.xti',
        '_Config/TcToolkitSample_PLC/TcToolkitSample_PLC Instance.xtv',
        'TcToolkitSample_PLC/TcToolkitSample_PLC.plcproj',
        'TcToolkitSample_PLC/PlcTask.TcTTO'
    ];
    const out = new Map();
    for (const rel of wanted) {
        const { bom, text } = decodeText(fs.readFileSync(path.join(SAMPLE_4026, ...rel.split('/'))));
        let t = applyNameMap(text, nameMap);
        if (rel.endsWith('.plcproj')) {
            for (const inc of injected) t = removeItem(t, 'Compile', inc);
            for (const inc of includes(t, 'Folder')) if (!XAE_FOLDERS.includes(inc)) t = removeItem(t, 'Folder', inc);
            for (const inc of includes(t, 'PlaceholderReference')) {
                if (!XAE_LIBRARIES.includes(inc)) t = removeItem(t, 'PlaceholderReference', inc);
            }
            for (const inc of includes(t, 'None')) if (/\.tmc$/i.test(inc)) t = removeItem(t, 'None', inc);
            t = t.replace(/[ \t]*<ItemGroup>\s*<\/ItemGroup>\r?\n/g, '');
            // The GVL goes first, as XAE sorts <Compile> items (the 4024 skeleton lists GVLs\… first),
            // with the LinkAlways flag XAE gives a GVL.
            t = replaceOnce(t, /([ \t]*)<Compile Include="PlcTask\.TcTTO">/,
                (m, indent) => `${indent}<Compile Include="GVLs\\${GVL_NAME}.TcGVL">\r\n` +
                    `${indent}  <SubType>Code</SubType>\r\n${indent}  <LinkAlways>true</LinkAlways>\r\n` +
                    `${indent}</Compile>\r\n${m}`, '4026 GVL Compile anchor');
            const compiles = includes(t, 'Compile');
            const expected = [`GVLs\\${GVL_NAME}.TcGVL`, 'PlcTask.TcTTO', 'POUs\\MAIN.TcPOU'];
            if (compiles.join('|') !== expected.join('|')) throw new Error(`4026 .plcproj Compile items: ${compiles.join(', ')}`);
            if (includes(t, 'Folder').join('|') !== XAE_FOLDERS.join('|')) throw new Error('4026 .plcproj Folder items differ from XAE defaults');
            if (includes(t, 'PlaceholderReference').join('|') !== XAE_LIBRARIES.join('|')) throw new Error('4026 .plcproj libraries differ from XAE defaults');
        }
        out.set(applyNameMap(rel, nameMap), Buffer.from((bom ? BOM : '') + t, 'utf8'));
    }

    // MAIN and the GVL: XAE's own object text, from the 4024 skeleton, with derived Ids.
    const main = decodeText(fs.readFileSync(path.join(XAE_4024, 'TC_Sample_4024', 'TC_sample_4024_PLC', 'POUs', 'MAIN.TcPOU')));
    const mainText = replaceOnce(main.text, /(<POU Name="MAIN" Id=")\{[^}]+\}/, `$1{${derivedGuid('3.1.4026/MAIN')}}`, 'MAIN Id');
    out.set(`${TEMPLATE_NAME}_PLC/POUs/MAIN.TcPOU`, Buffer.from((main.bom ? BOM : '') + mainText, 'utf8'));
    const gvl = decodeText(fs.readFileSync(path.join(XAE_4024, 'TC_Sample_4024', 'TC_sample_4024_PLC', 'GVLs', 'GVL_Test.TcGVL')));
    const gvlText = emptyGvl(gvl.text, { name: GVL_NAME, keepProductVersion: false, id: derivedGuid(`3.1.4026/${GVL_NAME}`) });
    out.set(`${TEMPLATE_NAME}_PLC/GVLs/${GVL_NAME}.TcGVL`, Buffer.from((gvl.bom ? BOM : '') + gvlText, 'utf8'));
    return out;
}

/**
 * Sanity checks shared by both templates.
 * @param {string} label
 * @param {Map<string, Buffer>} files
 * @param {string[]} sourceNames Names that must be gone.
 */
function verify(label, files, sourceNames) {
    const list = [...files].map(([rel, data]) => ({ rel, data }));
    const inv = inventoryGuids(list);
    if (inv.unclassified.length || inv.conflicts.length) {
        throw new Error(`${label}: unclassified GUIDs ${JSON.stringify(inv.unclassified)} conflicts ${inv.conflicts}`);
    }
    for (const { rel, data } of list) {
        if (/\.tmc$/i.test(rel)) throw new Error(`${label}: a .tmc must never be part of a template (${rel})`);
        const text = data.toString('utf8');
        for (const n of sourceNames) {
            if (rel.includes(n) || text.includes(n)) throw new Error(`${label}: source name "${n}" left in ${rel}`);
        }
        if (/HelloWorld/.test(text)) throw new Error(`${label}: GVL sample variable left in ${rel}`);
    }
}

/**
 * Replaces a template directory with the given files, or compares against it in check mode.
 * @param {string} dir
 * @param {Map<string, Buffer>} files
 * @param {boolean} check
 * @returns {string[]} Differences (check mode) — empty when identical.
 */
function emit(dir, files, check) {
    if (check) {
        const diffs = [];
        const have = fs.existsSync(dir) ? readTree(dir) : new Map();
        for (const [rel, data] of files) if (!have.has(rel) || !have.get(rel).equals(data)) diffs.push(`${path.basename(dir)}/${rel}`);
        for (const rel of have.keys()) if (!files.has(rel)) diffs.push(`${path.basename(dir)}/${rel} (extra)`);
        return diffs;
    }
    // The directory is wholly generated by this script, so it is rebuilt from scratch.
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, data] of files) {
        const abs = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, data);
    }
    return [];
}

if (require.main === module) {
    const check = process.argv.includes('--check');
    const t4024 = build4024();
    verify('tc3.1.4024', t4024, ['TC_Sample_4024', 'TC_sample_4024', 'GVL_Test']);
    const t4026 = build4026();
    verify('tc3.1.4026', t4026, ['TcToolkitSample', 'Dynamic Collections']);
    const diffs = [
        ...emit(path.join(TEMPLATES, 'tc3.1.4024'), t4024, check),
        ...emit(path.join(TEMPLATES, 'tc3.1.4026'), t4026, check)
    ];
    if (check) {
        if (diffs.length) {
            console.error(`Templates are stale — run node scripts/build-project-templates.js:\n  ${diffs.join('\n  ')}`);
            process.exit(1);
        }
        console.log('Templates are up to date.');
    } else {
        console.log(`Wrote resources/templates/tc3.1.4024 (${t4024.size} files) and tc3.1.4026 (${t4026.size} files).`);
    }
}

module.exports = { build4024, build4026, derivedGuid, TEMPLATE_NAME, GVL_NAME };
