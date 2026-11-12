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
const { placeXaeErrors, placementSummary, APPROXIMATE_NOTE, severityOf, parseOutputPaneLines } = require('../src/xaeErrorPlacement');
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

// ── Output panes only ───────────────────────────────────────────────────────────────────────────
{
    const fx = readFixture('errors-panes-only');
    const panes = fx.lines.filter(l => l.t === 'outputPane');
    assert(parseOutputPaneLines(panes[0].text).length === 0, 'the pane parser ships empty until real captures exist');
    const r = placeXaeErrors([], panes, deps('pane'));
    assert(r.total === 0 && placementSummary(r, 1, 'TC Toolkit XAE Build') === "XAE reported no error list; see 'TC Toolkit XAE Build'.",
        'exit 1 with nothing placed points at the output channel');
    assert(placementSummary(r, 0, 'x') === '', 'a clean build says nothing about errors');
}

console.log(errors === 0 ? '\nAll XAE error placement tests passed.' : `\n${errors} XAE error placement test(s) FAILED.`);
process.exit(errors === 0 ? 0 : 1);
