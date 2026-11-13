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
 *      a synthetic GVL with 12 variables covers lines far past the unit's 5-line header;
 *   4. every range the XML indexer emits (root, method, property and action names, method and property
 *      declRanges, variables) has the shape and position a sync gives it, over both samples and over
 *      synthetic objects the samples lack (R15 review round 4): declarations headed by `//`, `(* *)` and
 *      `{attribute}` lines, doc comments that mention the member's own name, an enum whose members are
 *      named in comments, names whose case differs from the XML `Name`, and actions. Check 1 runs over
 *      those objects too, and only accepts a name that is code (not inside a comment, pragma or string);
 *   5. end to end on those objects: Go to Definition before the file syncs lands on the declaration.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject, buildNodeFromXml } = require('../src/lsp/xmlIndexer');
const { blankComments } = require('../src/stComments');
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

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">\n';
const cdata = (tag, text, indent) => `${indent}<${tag}><![CDATA[${text}]]></${tag}>\n`;
const impl = (text, indent) => `${indent}<Implementation>\n${cdata('ST', text, indent + '  ')}${indent}</Implementation>\n`;
const method = (name, decl, body = '') => `    <Method Name="${name}" Id="{2}">\n${cdata('Declaration', decl, '      ')}${impl(body, '      ')}    </Method>\n`;
const itfMethod = (name, decl) => `    <Method Name="${name}" Id="{2}">\n${cdata('Declaration', decl, '      ')}    </Method>\n`;
const property = (name, decl, body) => `    <Property Name="${name}" Id="{3}">\n${cdata('Declaration', decl, '      ')}` +
    `      <Get Name="Get" Id="{4}">\n${cdata('Declaration', 'VAR\nEND_VAR\n', '        ')}${impl(body, '        ')}      </Get>\n    </Property>\n`;
const action = (name, body) => `    <Action Name="${name}" Id="{5}">\n${impl(body, '      ')}    </Action>\n`;
const pou = (name, decl, body, members) =>
    XML_HEAD + `  <POU Name="${name}" Id="{1}" SpecialFunc="None">\n${cdata('Declaration', decl, '    ')}${impl(body, '    ')}${members}  </POU>\n</TcPlcObject>`;

/**
 * Objects the samples lack (R15 review round 4): before it, the XML indexer took the first textual
 * match of a name, comments included and case-sensitively, and gave actions a (1,1) stub, so every
 * name below (but the plain ones) landed on a comment line or on no pane at all.
 */
const DOC_FB = pou('FB_Doc',
    "// FB_Doc: counts cycles\n(* FB_Doc keeps nCount *)\n{attribute 'reflection'}\nFUNCTION_BLOCK FB_Doc\nVAR\n\tnCount : INT; // nCount\nEND_VAR\n",
    'nCount := nCount + 1;\nAct_Reset();',
    method('Run', "// Run: starts the cycle\n{attribute 'Run'}\nMETHOD Run : BOOL\nVAR_INPUT\n\tbRun : BOOL; // bRun\nEND_VAR\n", 'Run := bRun;') +
    property('Val', "(* Val is the value; Val never wraps *)\nPROPERTY PUBLIC Val : INT\n", 'Val := nCount;') +
    action('Act_Reset', 'nCount := 0;'));
const SYNTHETIC = {
    'FB_Doc': DOC_FB,
    'FB_DocCrlf': DOC_FB.replace(/FB_Doc\b/g, 'FB_DocCrlf').replace(/\r?\n/g, '\r\n'),
    'FB_Case': pou('FB_Case', 'FUNCTION_BLOCK fb_case\nVAR\n\tx : INT;\nEND_VAR\n', 'act_go();',
        method('DoIt', '// DoIt\nMETHOD doit : BOOL\nVAR\nEND_VAR\n') +
        property('Speed', 'PROPERTY speed : LREAL\n', 'speed := 0;') +
        action('Act_Go', 'x := 1;')),
    'I_Doc': XML_HEAD + '  <Itf Name="I_Doc" Id="{1}">\n' +
        cdata('Declaration', "// I_Doc: the interface\n{attribute 'I_Doc'}\nINTERFACE I_Doc\n", '    ') +
        itfMethod('Go', '(* Go: go *)\nMETHOD Go : BOOL\nVAR_INPUT\n\tn : INT;\nEND_VAR\n') + '  </Itf>\n</TcPlcObject>',
    'F_Doc': pou('F_Doc', '// F_Doc returns F_Doc\nFUNCTION F_Doc : INT\nVAR_INPUT\n\ta : INT;\nEND_VAR\n', 'F_Doc := a;', ''),
    'E_Doc': XML_HEAD + '  <DUT Name="E_Doc" Id="{1}">\n' + cdata('Declaration',
        "// E_Doc: Alpha first, then Beta\n{attribute 'qualified_only'}\nTYPE E_Doc :\n(\n\tAlpha := 0, // Beta follows Alpha\n\tBeta, (* not Gamma *)\n\tGamma := Beta + 1\n) INT;\nEND_TYPE\n",
        '    ') + '  </DUT>\n</TcPlcObject>'
};

/**
 * Loads the synthetic objects into a fresh index from the XML.
 * @returns {{index: Object, files: Map<string, {xml: string, uri: string}>}} files by node name.
 */
function loadSynthetic() {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    const files = new Map();
    for (const [name, xml] of Object.entries(SYNTHETIC)) {
        const e = { xml, uri: `file:///synthetic/${name}.${/^E_/.test(name) ? 'TcDUT' : /^I_/.test(name) ? 'TcIO' : 'TcPOU'}` };
        const node = indexXmlObject(index, e.xml, e.uri);
        if (node && node.name) files.set(node.name, e);
    }
    return { index, files };
}

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

/**
 * Whether `localLine` of the given pane text has `name` at the range's columns, as code: a mention of
 * the name in a comment, pragma or string does not count.
 */
function nameAt(paneText, localLine, range, name) {
    const line = blankComments(paneText || '', { pragmas: true, strings: true }).split(/\r?\n/)[localLine];
    if (line === undefined) return false;
    return line.slice(range.start.character, range.end.character).toLowerCase() === String(name).toLowerCase();
}

/**
 * 1. Every XML-indexed declaration maps to its own component, pane and line.
 * @param {string} label Report label.
 * @param {{index: Object, files: Map}} loaded `load(...)` or `loadSynthetic()`.
 * @param {number} min The fewest declarations the run must check.
 */
async function xmlRangesMap(label, loaded, min) {
    const { index, files } = loaded;
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
            const comp = comps.find(c => c.type === 'Method' && c.name.toLowerCase() === m.name.toLowerCase());
            targets.push({ what: `${name}.${m.name}()`, word: m.name, range: m.nameRange, comp });
            for (const v of m.variables || []) targets.push({ what: `${name}.${m.name}.${v.name}`, word: v.name, range: v.range, comp });
        }
        for (const p of node.properties || []) {
            const comp = comps.find(c => c.type === 'Property' && c.xmlContext && c.xmlContext.subName === p.name);
            targets.push({ what: `${name}.${p.name} (property)`, word: p.name, range: p.nameRange, comp });
        }
        // An action has no Declaration CDATA: its pane line 0 is the `ACTION <name>` line the unit
        // synthesises, so the name is checked against that line.
        for (const a of node.actions || []) {
            const comp = comps.find(c => c.type === 'Action' && c.name.toLowerCase() === a.name.toLowerCase());
            targets.push({ what: `${name}.${a.name} (action)`, word: a.name, range: a.nameRange, comp, pane: comp && `ACTION ${comp.name}` });
        }
        for (const t of targets) {
            if (!t.range || !t.comp) continue;
            const lsp = convertToLspRange(t.range);
            const m = await mapDefinition({ uri: e.uri, range: lsp, componentId: t.comp.id }, resolver);
            checked++;
            const paneText = t.pane !== undefined ? t.pane : t.comp.declaration;
            const ok = m && m.componentId === t.comp.id && m.pane === 'decl' && nameAt(paneText, m.localLine, lsp, t.word);
            if (!ok) wrong.push(`${t.what} -> ${m && m.componentId}/${m && m.pane}:${m && m.localLine}`);
        }
    }
    assert(checked >= min, `${label}: XML-indexed declarations checked (${checked})`);
    assert(wrong.length === 0, `${label}: every XML-indexed declaration maps to its own name in its own pane (${wrong.length} wrong: ${wrong.slice(0, 5).join('; ')})`);
}

/** `startLine:startCol-endLine:endCol`, for a readable difference. */
const rk = (r) => r ? `${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}` : String(r);

/**
 * 2. The XML indexer and a sync (parser.js over the assembled unit) agree on every root variable's
 * start (the original check, over the samples).
 */
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

/**
 * Every range difference between a node the XML indexer built and the node a sync builds from the
 * same file: root name, root/method variables (range, typeRange), method name and declRange,
 * property name and declRange, action name. A member only one of them has is a difference too.
 * @param {string} xml The object's XML.
 * @param {string} uri Its URI.
 * @returns {{diffs: string[], ranges: number}} The differences and how many ranges were compared.
 */
function shapeDiffs(xml, uri) {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    const x = buildNodeFromXml(xml, uri);
    if (!x) return { diffs: ['no XML node'], ranges: 0 };
    index[x.name] = JSON.parse(JSON.stringify(x));
    parseAndIndexDocument(assembleSt(xml, null).stText, uri, index);
    const p = Object.values(index).find(n => n && n.uri === uri && n.name.toLowerCase() === x.name.toLowerCase());
    const diffs = [];
    let ranges = 0;
    const same = (what, a, b) => { ranges++; if (rk(a) !== rk(b)) diffs.push(`${what}: xml ${rk(a)} sync ${rk(b)}`); };
    const byName = (list) => new Map((list || []).map(m => [m.name.toLowerCase(), m]));
    const vars = (tag, xs, ps) => {
        const pm = byName(ps);
        for (const v of xs || []) {
            const q = pm.get(v.name.toLowerCase());
            if (!q) { diffs.push(`${tag}.${v.name}: only in xml`); continue; }
            same(`${tag}.${v.name}.range`, v.range, q.range);
            if (v.typeRange || q.typeRange) same(`${tag}.${v.name}.typeRange`, v.typeRange, q.typeRange);
        }
        const xm = byName(xs);
        for (const v of ps || []) if (!xm.has(v.name.toLowerCase())) diffs.push(`${tag}.${v.name}: only in sync`);
    };
    same(`${x.name}.nameRange`, x.nameRange, p.nameRange);
    vars(x.name, x.variables, p.variables);
    for (const [kind, keys] of [['methods', ['nameRange', 'declRange']], ['properties', ['nameRange', 'declRange']], ['actions', ['nameRange']]]) {
        const pm = byName(p[kind]);
        for (const m of x[kind] || []) {
            const q = pm.get(m.name.toLowerCase());
            if (!q) { diffs.push(`${kind} ${m.name}: only in xml`); continue; }
            for (const k of keys) same(`${x.name}.${m.name}.${k}`, m[k], q[k]);
            if (kind === 'methods') vars(`${x.name}.${m.name}`, m.variables, q.variables);
        }
        const xm = byName(x[kind]);
        for (const m of p[kind] || []) if (!xm.has(m.name.toLowerCase())) diffs.push(`${kind} ${m.name}: only in sync`);
    }
    return { diffs, ranges };
}

/**
 * 4. Every range of every POU, interface and GVL has the same position and shape from both indexers.
 * DUTs are left out: a sync never re-indexes one (parser.js's STRUCT pass is attach-only), so check 1
 * covers their members instead.
 * @param {string} label Report label.
 * @param {Array<{xml: string, uri: string}>} entries The objects.
 * @param {number} min The fewest ranges the run must compare.
 */
function shapesAgree(label, entries, min) {
    let ranges = 0;
    const differ = [];
    for (const e of entries) {
        const root = parseTwinCatXml(e.xml);
        if (!root || !/^(POU|Itf|GVL)$/.test(root.rootType)) continue;
        const r = shapeDiffs(e.xml, e.uri);
        ranges += r.ranges;
        differ.push(...r.diffs);
    }
    assert(ranges >= min, `${label}: ranges compared between the XML indexer and a sync (${ranges})`);
    assert(differ.length === 0, `${label}: every range has the same position and shape from both indexers (${differ.length} differ: ${differ.slice(0, 6).join('; ')})`);
}

/**
 * 5. End to end on the synthetic objects, before any of them syncs: Go to Definition from another POU
 * lands on the declaration's own line, not on a comment that mentions the name and not on no pane.
 */
async function syntheticDefinitions() {
    const { index, files } = loadSynthetic();
    const code = 'PROGRAM P_Probe\nVAR\n\tfbDoc : FB_Doc;\n\tfbCase : FB_Case;\n\teMode : E_Doc;\n\tiDoc : I_Doc;\nEND_VAR\n' +
        'fbDoc.Run(bRun := TRUE);\nfbDoc.Act_Reset();\neMode := fbDoc.Val;\neMode := E_Doc.Alpha;\neMode := E_Doc.Beta;\n' +
        'fbCase.DoIt();\nfbCase.Act_Go();\nfbCase.Speed := 1;\niDoc.Go(n := 1);\neMode := F_Doc(a := 1);\nEND_PROGRAM\n';
    const puri = 'file:///probe/P_Probe.TcPOU';
    parseAndIndexDocument(code, puri, index);
    const lines = code.split('\n');
    const probes = [
        ['fbDoc.Run', 'FB_Doc', 'method_Run', 'Run'], ['fbDoc.Act_Reset', 'FB_Doc', 'action_Act_Reset', 'Act_Reset'],
        ['fbDoc.Val', 'FB_Doc', null, 'Val'], ['E_Doc.Alpha', 'E_Doc', 'root', 'Alpha'], ['E_Doc.Beta', 'E_Doc', 'root', 'Beta'],
        ['fbCase.DoIt', 'FB_Case', 'method_DoIt', 'DoIt'], ['fbCase.Act_Go', 'FB_Case', 'action_Act_Go', 'Act_Go'],
        ['fbCase.Speed', 'FB_Case', null, 'Speed'], ['iDoc.Go', 'I_Doc', 'method_Go', 'Go'], ['F_Doc(', 'F_Doc', 'root', 'F_Doc']
    ];
    const wrong = [];
    for (const [needle, target, compId, word] of probes) {
        const line = lines.findIndex(l => l.includes(needle));
        const character = lines[line].indexOf(needle) + needle.indexOf(word);
        const e = files.get(target);
        const def = provideDefinition(code, { line, character }, index, puri);
        const resolver = createStResolver({ activeUri: puri, activeUnit: { stText: code, lineMap: {} }, readFile: async () => e.xml });
        const m = await mapDefinition(def, resolver);
        const comps = parseTwinCatXml(e.xml).components;
        const comp = comps.find(c => compId ? c.id === compId : (c.type === 'Property' && c.xmlContext.subName === word));
        const paneText = comp && comp.type === 'Action' ? `ACTION ${comp.name}` : comp && comp.declaration;
        const ok = m && m.uri === e.uri && comp && m.componentId === comp.id && m.pane === 'decl' && nameAt(paneText, m.localLine, m.range, word);
        if (!ok) wrong.push(`${needle} -> ${m && m.componentId}/${m && m.pane}:${m && m.localLine}`);
    }
    assert(wrong.length === 0, `synthetic: Go to Definition before a sync lands on the declaration for all ${probes.length} probes (${wrong.length} wrong: ${wrong.join('; ')})`);
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
        await xmlRangesMap(path.basename(s), load(s), 30);
        framesAgree(s);
        shapesAgree(path.basename(s), walk(s).map(f => ({ xml: fs.readFileSync(f, 'utf8'), uri: fileUri(f) })), 40);
        await gvlDefinitions(s);
    }
    await xmlRangesMap('synthetic', loadSynthetic(), 18);
    shapesAgree('synthetic', Object.entries(SYNTHETIC).map(([n, xml]) => ({ xml, uri: `file:///synthetic/${n}.TcPOU` })), 30);
    await syntheticDefinitions();
    reportCoverage('definition-frames', 'ran');
    if (errors) { console.error(`\n${errors} definition-frame assertion(s) failed`); process.exit(1); }
    console.log('\nAll definition-frame checks passed.');
    process.exit(0);
})().catch(e => { console.error('[FAIL] crashed: ' + (e && e.stack || e)); process.exit(1); });
