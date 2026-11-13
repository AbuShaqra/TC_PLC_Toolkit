/**
 * @file test_xae_error_placement.js
 * @description Where the XAE build's errors land (src/xaeErrorPlacement.js, roadmap R14), against the
 * committed sample's real objects. What an ErrorItem's line counts is not known before a Windows
 * capture, so both line bases are pinned, plus the approximate marker, the file-known-line-unknown
 * fallback, `general`, and the summary sentence.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { placeXaeErrors, placementSummary, APPROXIMATE_NOTE, severityOf, parseOutputPaneLines, splitFileSuffix, isEmptyItem, isSummaryItem, PANE_LINE_BASE } = require('../src/xaeErrorPlacement');
const { assembleSt, localToAbsolute } = require('../src/livePath');
const { readFixture } = require('./_fakeXaeDriver');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const SLN_DIR = path.join(__dirname, '..', 'sample', 'TcToolkitSample');
const FB = path.join(SLN_DIR, 'TcToolkitSample_PLC', 'POUs', 'Machine', 'FB_Station.TcPOU');
if (!fs.existsSync(FB)) {
    console.log('SKIP: sample/TcToolkitSample is missing.');
    process.exit(0);
}
const deps = (lineBase) => ({ readFile: (p) => fs.readFileSync(p, 'utf8'), exists: (p) => fs.existsSync(p), slnDir: SLN_DIR, lineBase });
const item = (o) => ({ file: null, line: null, column: null, description: '', project: null, level: 'vsBuildErrorLevelHigh', ...o });

// ── The fixture's error list, line base 'pane' (the default) ────────────────────────────────────
{
    const fx = readFixture('errors-errorlist');
    const items = fx.lines.filter(l => l.t === 'errorItem').map(l => ({ ...l }));
    const r = placeXaeErrors(items, [], deps(undefined));
    const list = r.byFile.get(FB) || [];
    assert(r.total === 3 && r.placed === 2 && r.general.length === 1 && r.general[0].description === 'Build aborted', '2 placed on FB_Station (relative to the .sln, Windows separators), 1 general');
    const [a, b] = list;
    assert(a.componentId === 'root' && a.pane === 'impl' && a.line === 3 && a.column === 2 && a.exact && !a.message.endsWith(APPROXIMATE_NOTE),
        'a section marker ("Implementation") makes it exact');
    assert(b.componentId === 'root' && b.pane === 'impl' && b.line === 2 && b.column === 1 && !b.exact && b.message.endsWith(APPROXIMATE_NOTE),
        'no marker → implementation pane, exact:false, "(location approximate)", column 1 when absent');
    assert(a.severity === 'error' && a.endLine === a.line, 'the R13 problem shape');
    assert(placementSummary(r, 1, 'TC Toolkit XAE Build') === '3 errors (2 placed in Problems).', 'summary counts placed and total');
}

// ── A member named in the description; the declaration marker ───────────────────────────────────
{
    const r = placeXaeErrors([item({ file: FB, line: 2, description: "FB_Station.Cyclic (Declaration): C0035: unexpected 'x'" })], [], deps('pane'));
    const p = (r.byFile.get(FB) || [])[0];
    assert(p && p.componentId !== 'root' && /Cyclic/.test(p.componentId) && p.pane === 'decl' && p.exact, 'an absolute path, <POU>.<Method> names the method, Declaration → decl, exact');
}

// ── Line base 'file': a line of the whole object as one unit ────────────────────────────────────
{
    const unit = assembleSt(fs.readFileSync(FB, 'utf8'), null);
    const parsedMethodId = Object.keys(unit.lineMap).find(k => /Cyclic/.test(k));
    const abs = localToAbsolute(unit.lineMap, parsedMethodId, 'impl', 3, 1);
    const r = placeXaeErrors([item({ file: FB, line: abs.line + 1, description: 'C0046: x' })], [], deps('file'));
    const p = (r.byFile.get(FB) || [])[0];
    assert(p && p.componentId === parsedMethodId && p.pane === 'impl' && p.line === 3 && p.exact, "lineBase 'file' maps a unit line back through the raw lineMap");
    const beyond = placeXaeErrors([item({ file: FB, line: 100000, description: 'far' })], [], deps('file'));
    const q = (beyond.byFile.get(FB) || [])[0];
    assert(q && q.line === 1 && !q.exact, "lineBase 'file': a line outside every pane falls back to line 1, not exact");
}

// ── Fallbacks ───────────────────────────────────────────────────────────────────────────────────
{
    const r = placeXaeErrors([
        item({ file: FB, line: null, description: 'no line', level: 'vsBuildErrorLevelMedium' }),
        item({ file: path.join(SLN_DIR, 'Missing.TcPOU'), line: 3, description: 'missing file' }),
        item({ file: path.join(SLN_DIR, 'TcToolkitSample.tsproj'), line: 3, description: 'not an object file' })
    ], [], deps('pane'));
    const p = (r.byFile.get(FB) || [])[0];
    assert(p && p.line === 1 && !p.exact && p.severity === 'warning', 'a known file without a line: line 1, not exact (Medium → warning)');
    assert(r.general.length === 2, 'a missing file and a non-object file are general');
    assert(severityOf('vsBuildErrorLevelLow') === 'info' && severityOf(null) === 'error', 'severity levels');
}

// ── The user's Windows runs (4026.28, 2026-11-13): sample 1's MAIN with `h;` planted at implementation
// line 14, so END_FOR moves to 15. Headless the list items are empty and only the "Build" pane names the
// errors (21/22 = 7 declaration lines + 14/15); with the window shown the list items are filled, their
// file carries a " (Impl)" suffix and their line is a pane line. Both must give the same two problems.
const MAIN = path.join(SLN_DIR, 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
const plantedMain = fs.readFileSync(MAIN, 'utf8').replace(/END_FOR\]\]>/, 'h;\r\nEND_FOR]]>');
const plantedDeps = { ...deps(undefined), readFile: (p) => (p === MAIN ? plantedMain : fs.readFileSync(p, 'utf8')) };
{
    const impl = plantedMain.split('<ST><![CDATA[')[1].split(']]>')[0].split(/\r\n/);
    assert(impl[13] === 'h;' && impl[14] === 'END_FOR', 'the planted MAIN: h; at implementation line 14, END_FOR at 15');
    assert(PANE_LINE_BASE === 'object', "the Build pane's line base is 'object' (confirmed on Windows)");
}
for (const name of ['errors-pane-planted-headless', 'errors-pane-planted-visible']) {
    const fx = readFixture(name);
    const items = fx.lines.filter(l => l.t === 'errorItem').map(l => ({ ...l }));
    const panes = fx.lines.filter(l => l.t === 'outputPane');
    const r = placeXaeErrors(items, panes, plantedDeps);
    const list = (r.byFile.get(MAIN) || []).slice().sort((a, b) => a.line - b.line);
    const [warn, err] = list;
    assert(r.byFile.size === 1 && list.length === 2 && r.placed === 2 && r.total === 2 && r.general.length === 0,
        `${name}: two problems on MAIN (a generic Windows root mapped onto the workspace), each once`);
    assert(err && err.componentId === 'root' && err.pane === 'impl' && err.line === 15 && err.exact && err.severity === 'error'
        && err.code === 'C0189' && err.message === "C0189: ';' expected instead of 'END_FOR'",
        `${name}: C0189 on MAIN's implementation line 15 (END_FOR), exact, an error with its code`);
    assert(warn && warn.componentId === 'root' && warn.pane === 'impl' && warn.line === 14 && warn.exact && warn.severity === 'warning'
        && warn.code === 'C0139' && /^C0139: The code 'h; ?' has no effect\. Is this the intent\?$/.test(warn.message.replace(/\r?\n/g, '')),
        `${name}: C0139 on the h; line (14), a warning, the wrapped message joined (${warn && warn.message})`);
    assert(r.errors === 1 && r.warnings === 1 && r.infos === 0 && placementSummary(r, 1, 'ch') === '1 error, 1 warning (2 placed in Problems).',
        `${name}: counted from the de-duplicated set: 1 error, 1 warning (${placementSummary(r, 1, 'ch')})`);
    assert(r.notes.length === 1 && /build for platform 'TwinCAT OS \(x64\)' failed\.$/.test(r.notes[0].description),
        `${name}: the project-failed item is one note, not a problem or a count`);
}
{
    const fx = readFixture('errors-pane-planted-headless');
    const items = fx.lines.filter(l => l.t === 'errorItem');
    assert(items.filter(isEmptyItem).length === 2 && items.filter(isSummaryItem).length === 1, 'headless: two empty items and one summary item');
    const onlyList = placeXaeErrors(items, [], plantedDeps);
    assert(onlyList.total === 0 && onlyList.placed === 0 && onlyList.general.length === 0 && onlyList.notes.length === 1,
        'empty items are dropped (no blank "not placed" line), the summary is a note');
    const parsed = parseOutputPaneLines(fx.lines.find(l => l.t === 'outputPane').text);
    assert(parsed.length === 2 && parsed.every(p => p.lineBase === 'object' && /MAIN\.TcPOU$/.test(p.file)) && !parsed.some(p => /E_FAIL|Unbekannter/.test(p.description)),
        'the pane gives two messages; the solution-level "Fehler: Unbekannter Fehler (E_FAIL)" is not one');
    // Without the planted line, line 22 lies past MAIN's implementation: line 1, approximate.
    const plain = placeXaeErrors([], fx.lines.filter(l => l.t === 'outputPane'), deps(undefined));
    const beyond = (plain.byFile.get(MAIN) || []).find(p => p.code === 'C0189');
    assert(beyond && beyond.line === 1 && !beyond.exact && beyond.message.endsWith(APPROXIMATE_NOTE), "a pane line past the object's text: line 1, approximate");
}

// ── The pane parser: German level words, spacing, a wrapped message, stop lines ─────────────────
{
    const text = [
        'C:\\x\\POUs\\MAIN.TcPOU (3)  :  Fehler :  C0032: Typ erwartet',
        'C:\\x\\POUs\\MAIN.TcPOU(4,7) : Warnung: C0373: Unbenutzte Variable',
        '  zweite Zeile der Meldung',
        'C:\\x\\GVLs\\GVL_Hmi.TcGVL(2) : info: C0999: a message',
        'Build complete -- 1 errors, 1 warnings',
        'Fehler: Unbekannter Fehler (Ausnahme von HRESULT: 0x80004005 (E_FAIL))'
    ].join('\r\n');
    const p = parseOutputPaneLines(text);
    assert(p.length === 3 && severityOf(p[0].level) === 'error' && severityOf(p[1].level) === 'warning' && severityOf(p[2].level) === 'info',
        'Fehler / Warnung / info map to error / warning / info');
    assert(p[0].line === 3 && p[0].code === 'C0032' && p[0].description === 'C0032: Typ erwartet' && p[1].column === 7,
        'free spacing, an optional column');
    assert(p[1].description === 'C0373: Unbenutzte Variable zweite Zeile der Meldung', 'a wrapped message runs on to the next recognised line');
    assert(p[2].description === 'C0999: a message', 'a summary line ends a message');
}

// ── Error-list file suffixes: pane and component ─────────────────────────────────────────────────
{
    const s1 = splitFileSuffix('C:\\x\\MAIN.TcPOU (Impl)');
    const s2 = splitFileSuffix('C:\\x\\FB_Station.TcPOU (FB_Station.Cyclic Decl)');
    const s3 = splitFileSuffix('C:\\x\\FB_Station.TcPOU');
    assert(s1.file === 'C:\\x\\MAIN.TcPOU' && s1.pane === 'impl' && s1.component === null, '"<path> (Impl)": the path and the implementation pane');
    assert(s2.pane === 'decl' && s2.component === 'FB_Station.Cyclic' && s3.pane === null && s3.file === 'C:\\x\\FB_Station.TcPOU', 'a component in the suffix; no suffix');
    const r = placeXaeErrors([
        item({ file: `${FB} (Cyclic Impl)`, line: 2, description: 'C0046: x' }),
        item({ file: `${FB} (State Get Impl)`, line: 1, description: 'C0046: y' }),
        item({ file: `${FB} (Nope Impl)`, line: 1, description: 'C0046: z' })
    ], [], deps(undefined));
    const [a, b, c] = r.byFile.get(FB) || [];
    assert(a && /Cyclic/.test(a.componentId) && a.pane === 'impl' && a.line === 2 && a.exact, 'a method named in the suffix, its pane line, exact');
    assert(b && b.componentId === 'prop_State_get' && b.exact, 'a property accessor named in the suffix');
    assert(c && c.componentId === 'root' && !c.exact, 'an unknown component in the suffix: root, approximate');
    // An 'object' line in a POU with child components may be a child's: approximate until confirmed.
    const o = placeXaeErrors([], [{ name: 'Build', text: `${FB}(2) : error: C0046: x` }], deps(undefined));
    const q = (o.byFile.get(FB) || [])[0];
    assert(q && q.componentId === 'root' && q.pane === 'decl' && q.line === 2 && !q.exact, "an 'object' line in a POU with methods: approximate");
    // canonical: the file system's own spelling of the path.
    const k = placeXaeErrors([], [{ name: 'Build', text: `${MAIN}(1) : error: C1: x` }], { ...plantedDeps, canonical: (p) => p + '#canon', readFile: (p) => plantedDeps.readFile(p.replace(/#canon$/, '')) });
    assert(k.byFile.has(MAIN + '#canon'), 'the resolved path is the canonical one');
}

// ── Output panes only ───────────────────────────────────────────────────────────────────────────
{
    const fx = readFixture('errors-panes-only');
    const panes = fx.lines.filter(l => l.t === 'outputPane');
    assert(parseOutputPaneLines(panes[0].text).length === 0, 'a pane line without a file and line is not a message');
    const r = placeXaeErrors([], panes, deps('pane'));
    assert(r.total === 0 && placementSummary(r, 1, 'TC Toolkit XAE Build') === "XAE named no error with a file and line; see 'TC Toolkit XAE Build'.",
        'exit 1 with nothing placed points at the output channel');
    assert(placementSummary(r, 0, 'x') === '', 'a clean build says nothing about errors');
}

console.log(errors === 0 ? '\nAll XAE error placement tests passed.' : `\n${errors} XAE error placement test(s) FAILED.`);
process.exit(errors === 0 ? 0 : 1);
