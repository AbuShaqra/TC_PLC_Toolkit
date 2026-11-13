/**
 * @file test_definition_frames.js
 * @description Every symbol range in the index is in ONE frame: lines of the file's assembled Structured
 * Text unit (src/stConverter.js raw mode, the unit the live path maps with). R15 review round 3, #0:
 * xmlIndexer.js used to emit ranges relative to each component's Declaration CDATA, while parser.js (a
 * synced editor) emits unit lines, and livePath.js `mapDefinition` read every range as a unit line. A
 * cross-file Go to Definition into a file whose editor had not synced (and again after every save, when
 * `custom/indexXmlDocument` re-indexes from the XML) landed on another variable's line, or fell back to
 * the first word match in the pane.
 *
 * Pinned here, over BOTH samples (each in its own flat index, since their MAIN / FB_Cylinder collide):
 *   1. every XML-indexed declaration (root variables and enumerators, method variables, method and
 *      property names) maps through `mapDefinition` to its own component, the declaration pane, and a
 *      line that has the name at the range's columns;
 *   2. the XML indexer and the parser (an editor's sync) give each root variable the same range;
 *   3. end to end: Go to Definition on `GVL_X.var` from another POU, for every variable of every GVL,
 *      lands on its declaration before a sync, after one, and after the re-index a save triggers;
 *      a synthetic GVL with 12 variables covers lines far past the unit's 5-line header.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideDefinition } = require('../src/lsp/features');
const { convertToLspRange } = require('../src/lsp/features/core');
const { assembleSt, mapDefinition, createStResolver } = require('../src/livePath');
const { reportCoverage } = require('./_coverage');

const SAMPLES = ['TcToolkitSample', 'TcToolkitSample2'].map(s => path.join(__dirname, '..', 'sample', s));

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const fileUri = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '_Libraries') walk(full, out); } else if (/\.Tc(POU|GVL|DUT|IO)$/i.test(e.name)) out.push(full);
    }
    return out;
}

/** A GVL whose last variables sit far below the unit's header (the review's longdef fixture). */
const LONG_GVL = '﻿<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">\r\n' +
    '  <GVL Name="GVL_Long" Id="{f5f523de-3785-4f7b-a814-dd5df81cfa6b}">\r\n    <Declaration><![CDATA[{attribute \'qualified_only\'}\r\nVAR_GLOBAL\r\n' +
    Array.from({ length: 12 }, (_, i) => `\tnV${i}\t\t: INT;\r\n`).join('') +
    'END_VAR\r\n]]></Declaration>\r\n  </GVL>\r\n</TcPlcObject>';

/**
 * Loads one sample (plus the synthetic GVL) into a fresh index from the XML, as the startup scan does.
 * @returns {{index: Object, files: Map<string, {xml: string, uri: string}>}} files by node name.
 */
function load(sampleDir) {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    const files = new Map();
    const entries = walk(sampleDir).map(f => ({ xml: fs.readFileSync(f, 'utf8'), uri: fileUri(f) }));
    entries.push({ xml: LONG_GVL, uri: fileUri(path.join(sampleDir, 'GVLs', 'GVL_Long.TcGVL')) });
    for (const e of entries) {
        const node = indexXmlObject(index, e.xml, e.uri);
        if (node && node.name) files.set(node.name, e);
    }
    return { index, files };
}

/** Whether `localLine` of the given pane text has `name` at the range's columns. */
function nameAt(paneText, localLine, range, name) {
    const line = (paneText || '').split(/\r?\n/)[localLine];
    if (line === undefined) return false;
    return line.slice(range.start.character, range.end.character).toLowerCase() === String(name).toLowerCase();
}

/** 1. Every XML-indexed declaration maps to its own component, pane and line. */
async function xmlRangesMap(sampleDir) {
    const { index, files } = load(sampleDir);
    let checked = 0;
    const wrong = [];
    for (const [name, e] of files) {
        const node = index[name];
        if (!node || node.uri !== e.uri) continue;
        const comps = parseTwinCatXml(e.xml).components;
        const resolver = createStResolver({ activeUri: 'file:///none', activeUnit: { stText: '', lineMap: {} }, readFile: async () => e.xml });
        const targets = [];
        const root = comps.find(c => c.id === 'root');
        for (const v of node.variables || []) targets.push({ what: `${name}.${v.name}`, word: v.name, range: v.range, comp: root });
        for (const m of node.methods || []) {
            const comp = comps.find(c => c.type === 'Method' && c.name === m.name);
            targets.push({ what: `${name}.${m.name}()`, word: m.name, range: m.nameRange, comp });
            for (const v of m.variables || []) targets.push({ what: `${name}.${m.name}.${v.name}`, word: v.name, range: v.range, comp });
        }
        for (const p of node.properties || []) {
            const comp = comps.find(c => c.type === 'Property' && c.xmlContext && c.xmlContext.subName === p.name);
            targets.push({ what: `${name}.${p.name} (property)`, word: p.name, range: p.nameRange, comp });
        }
        for (const t of targets) {
            if (!t.range || !t.comp) continue;
            const lsp = convertToLspRange(t.range);
            const m = await mapDefinition({ uri: e.uri, range: lsp, componentId: t.comp.id }, resolver);
            checked++;
            const ok = m && m.componentId === t.comp.id && m.pane === 'decl' && nameAt(t.comp.declaration, m.localLine, lsp, t.word);
            if (!ok) wrong.push(`${t.what} -> ${m && m.componentId}/${m && m.pane}:${m && m.localLine}`);
        }
    }
    const label = path.basename(sampleDir);
    assert(checked > 30, `${label}: XML-indexed declarations checked (${checked})`);
    assert(wrong.length === 0, `${label}: every XML-indexed declaration maps to its own name in its own pane (${wrong.length} wrong: ${wrong.slice(0, 5).join('; ')})`);
}

/** 2. The XML indexer and a sync (parser.js over the assembled unit) agree on every root variable. */
function framesAgree(sampleDir) {
    const { index, files } = load(sampleDir);
    let compared = 0;
    const differ = [];
    for (const [name, e] of files) {
        const node = index[name];
        if (!node || node.uri !== e.uri || !/^(PROGRAM|FUNCTION_BLOCK|FUNCTION|GVL)$/.test(node.type)) continue;
        const fromXml = new Map((node.variables || []).map(v => [v.name.toLowerCase(), v.range]));
        const unit = assembleSt(e.xml, null);
        parseAndIndexDocument(unit.stText, e.uri, index);
        const synced = Object.values(index).find(n => n && n.uri === e.uri && n.name.toLowerCase() === name.toLowerCase());
        for (const v of (synced && synced.variables) || []) {
            const x = fromXml.get(v.name.toLowerCase());
            if (!x) continue;
            compared++;
            if (x.startLine !== v.range.startLine || x.startCol !== v.range.startCol) differ.push(`${name}.${v.name} xml ${x.startLine}:${x.startCol} vs sync ${v.range.startLine}:${v.range.startCol}`);
        }
    }
    const label = path.basename(sampleDir);
    assert(compared > 20, `${label}: root variables compared between the XML indexer and a sync (${compared})`);
    assert(differ.length === 0, `${label}: the XML indexer's ranges are unit lines, as a sync's are (${differ.length} differ: ${differ.slice(0, 4).join('; ')})`);
}

/** 3. Go to Definition on GVL_X.var from another POU: before a sync, after one, after a save's re-index. */
async function gvlDefinitions(sampleDir) {
    const { index, files } = load(sampleDir);
    const label = path.basename(sampleDir);
    const gvls = [...files].filter(([name]) => index[name] && index[name].type === 'GVL');
    const wrong = { before: [], synced: [], saved: [] };
    let checked = 0;
    for (const [gvl, e] of gvls) {
        const decl = parseTwinCatXml(e.xml).components.find(c => c.id === 'root').declaration;
        const names = (index[gvl].variables || []).map(v => v.name);
        for (const phase of ['before', 'synced', 'saved']) {
            if (phase === 'synced') parseAndIndexDocument(assembleSt(e.xml, null).stText, e.uri, index);
            if (phase === 'saved') indexXmlObject(index, e.xml, e.uri);
            for (const v of names) {
                const code = `PROGRAM P_Probe\nVAR\nEND_VAR\n${gvl}.${v} := ${gvl}.${v};\nEND_PROGRAM\n`;
                const puri = 'file:///probe/P_Probe.TcPOU';
                parseAndIndexDocument(code, puri, index);
                const def = provideDefinition(code, { line: 3, character: gvl.length + 2 }, index, puri);
                const resolver = createStResolver({ activeUri: puri, activeUnit: { stText: code, lineMap: {} }, readFile: async () => e.xml });
                const m = await mapDefinition(def, resolver);
                checked++;
                const ok = m && m.uri === e.uri && m.componentId === 'root' && m.pane === 'decl' && nameAt(decl, m.localLine, m.range, v);
                if (!ok) wrong[phase].push(`${gvl}.${v} -> ${m && m.pane}:${m && m.localLine}`);
            }
        }
    }
    assert(gvls.some(([n]) => n === 'GVL_Long') && checked > 40, `${label}: GVL definitions checked (${checked}, ${gvls.length} GVLs)`);
    for (const phase of Object.keys(wrong)) {
        assert(wrong[phase].length === 0, `${label}: Go to Definition on a GVL variable lands on its declaration ${phase === 'before' ? 'before the GVL syncs' : phase === 'synced' ? 'after it syncs' : 'after a save re-indexes it from the XML'} (${wrong[phase].length} wrong: ${wrong[phase].slice(0, 4).join('; ')})`);
    }
}

(async () => {
    const present = SAMPLES.filter(s => fs.existsSync(s));
    if (present.length < SAMPLES.length) {
        console.log('SKIP: a sample/ solution is missing: the definition-frame checks did not run.');
        reportCoverage('definition-frames', 'skipped', 'sample/ not present');
        process.exit(0);
    }
    for (const s of SAMPLES) {
        await xmlRangesMap(s);
        framesAgree(s);
        await gvlDefinitions(s);
    }
    reportCoverage('definition-frames', 'ran');
    if (errors) { console.error(`\n${errors} definition-frame assertion(s) failed`); process.exit(1); }
    console.log('\nAll definition-frame checks passed.');
    process.exit(0);
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
