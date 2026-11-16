/**
 * @file test_check_unit.js
 * @description The check unit behind Compile Project (`src/checkUnit.js`): one Structured Text unit
 * per TwinCAT object, shaped for an external IEC 61131-3 compiler, with a per-line map back to the
 * panes. No compiler is needed here — the real-compiler gate is test/test_compile_real.js.
 *
 * Invariants pinned:
 *   - every emitted line has exactly one origin (`origins.length === lines.length`);
 *   - every line of every emitted pane appears in the unit exactly once, verbatim, in pane order —
 *     so a line and column the compiler reports ARE the pane's line and column;
 *   - a generated line (`END_METHOD`, `GET`, `ACTION x` …) is anchored on an existing line of the
 *     component that owns it;
 *   - members come BEFORE the POU body (the compiler accepts them only there);
 *   - pane text is never rewritten: `REFERENCE TO`, `REF=` and pragmas survive (the export's
 *     rewrites would change what is being checked);
 *   - every file of the committed sample round-trips.
 */

const fs = require('fs');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const { buildCheckUnit, mapUnitPosition, paneLines } = require('../src/checkUnit');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const CRLF = '\r\n';
const cdata = (text) => `<![CDATA[${text}]]>`;
const block = (decl, impl) => `<Declaration>${cdata(decl)}</Declaration>` +
    (impl === undefined ? '' : `<Implementation><ST>${cdata(impl)}</ST></Implementation>`);
const wrap = (inner) => `<?xml version="1.0" encoding="utf-8"?>${CRLF}<TcPlcObject Version="1.1.0.1">${CRLF}${inner}${CRLF}</TcPlcObject>`;

/**
 * Checks the structural invariants of one unit against the parsed object it was built from.
 * @returns {boolean}
 */
function invariantsHold(parsed, unit, label) {
    let ok = true;
    const fail = (msg) => { ok = false; console.error(`    ${label}: ${msg}`); };
    if (unit.origins.length !== unit.lines.length) fail('origins and lines differ in length');
    if (unit.stText !== unit.lines.join('\n')) fail('stText is not the joined lines');
    const isItf = parsed.rootType === 'Itf';
    // What each pane must contribute, in order.
    const expected = new Map();
    for (const comp of parsed.components) {
        if (comp.type === 'Transition') continue;
        expected.set(`${comp.id}:decl`, paneLines(comp.declaration));
        const hasBody = typeof comp.implementation === 'string' && !(isItf && comp.id !== 'root');
        if (hasBody && !(isItf)) expected.set(`${comp.id}:impl`, paneLines(comp.implementation));
    }
    const seen = new Map();
    unit.origins.forEach((o, i) => {
        if (o.pane !== 'decl' && o.pane !== 'impl') fail(`line ${i + 1} has pane ${o.pane}`);
        if (!Number.isInteger(o.line) || o.line < 1) fail(`line ${i + 1} has origin line ${o.line}`);
        const key = `${o.componentId}:${o.pane}`;
        if (!parsed.components.some(c => c.id === o.componentId)) fail(`line ${i + 1} names unknown component ${o.componentId}`);
        if (o.generated) {
            const count = (expected.get(key) || []).length;
            if (o.line > Math.max(1, count)) fail(`generated line ${i + 1} is anchored past its pane (${key}:${o.line} > ${count})`);
            return;
        }
        const list = seen.get(key) || [];
        list.push({ line: o.line, text: unit.lines[i] });
        seen.set(key, list);
    });
    for (const [key, lines] of expected) {
        const got = seen.get(key) || [];
        if (got.length !== lines.length) { fail(`${key}: ${got.length} of ${lines.length} pane lines emitted`); continue; }
        got.forEach((g, i) => {
            if (g.line !== i + 1) fail(`${key}: emitted out of order at ${i + 1}`);
            if (g.text !== lines[i]) fail(`${key}:${i + 1} is not verbatim`);
        });
    }
    for (const key of seen.keys()) if (!expected.has(key)) fail(`${key} was emitted but is not a pane of the object`);
    return ok;
}

// ── A function block with every member kind ──────────────────────────────────────────────────────
const fbXml = wrap([
    '  <POU Name="FB_Axis" Id="{a}" SpecialFunc="None">',
    '    ' + block(
        `{attribute 'reflection'}${CRLF}FUNCTION_BLOCK FB_Axis${CRLF}VAR${CRLF}\trefOut : REFERENCE TO BOOL;${CRLF}\tn : INT;${CRLF}END_VAR`,
        `n := n + 1;${CRLF}refOut REF= bLocal;`),
    '    <Method Name="Reset" Id="{b}">',
    '      ' + block(`METHOD Reset : BOOL${CRLF}VAR_INPUT${CRLF}\tbHard : BOOL;${CRLF}END_VAR`, `n := 0;${CRLF}Reset := TRUE;`),
    '    </Method>',
    '    <Property Name="Count" Id="{c}">',
    '      <Declaration>' + cdata('PROPERTY Count : INT') + '</Declaration>',
    '      <Get Name="Get" Id="{d}">',
    '        ' + block(`VAR${CRLF}END_VAR`, 'Count := n;'),
    '      </Get>',
    '      <Set Name="Set" Id="{e}">',
    '        ' + block('', 'n := Count;'),
    '      </Set>',
    '    </Property>',
    '    <Action Name="Stop" Id="{f}">',
    '      <Implementation><ST>' + cdata(`n := -1;`) + '</ST></Implementation>',
    '    </Action>',
    '    <Transition Name="T_Done" Id="{g}">',
    '      <Implementation><ST>' + cdata('n > 3') + '</ST></Implementation>',
    '    </Transition>',
    '  </POU>'
].join(CRLF));

const fbParsed = parseTwinCatXml(fbXml);
const fb = buildCheckUnit(fbParsed);
assert(!!fb && invariantsHold(fbParsed, fb, 'FB_Axis'), 'FB: every pane line is emitted once, verbatim and in order; every line has one origin');

const idx = (text) => fb.lines.indexOf(text);
assert(idx('METHOD Reset : BOOL') > idx('END_VAR') && idx('END_METHOD') < idx('n := n + 1;'),
    'FB: the method comes after the root declaration and BEFORE the body');
assert(idx('END_ACTION') < idx('n := n + 1;') && idx('END_PROPERTY') < idx('n := n + 1;'),
    'FB: properties and actions come before the body too');
assert(fb.lines[fb.lines.length - 1] === 'END_FUNCTION_BLOCK' && fb.lines[fb.lines.length - 2] === 'refOut REF= bLocal;',
    'FB: the body is last, closed by END_FUNCTION_BLOCK');
assert(fb.stText.includes('REFERENCE TO BOOL') && fb.stText.includes('REF= bLocal') && fb.lines[0] === "{attribute 'reflection'}",
    'FB: REFERENCE TO, REF= and pragmas are untouched (the export rewrites must not reach the check)');
assert(!fb.stText.includes('// ='), 'FB: no header or separator comment lines');
assert(['GET', 'END_GET', 'SET', 'END_SET', 'END_PROPERTY', 'ACTION Stop', 'END_ACTION', 'END_METHOD']
    .every(k => fb.lines.includes(k)), 'FB: the generated keywords are all present');
assert(fb.skipped.length === 1 && /T_Done/.test(fb.skipped[0]) && !fb.stText.includes('n > 3'),
    'FB: an SFC transition is left out and named in `skipped`');
assert(fb.globalListName === null && fb.rootType === 'POU' && fb.rootName === 'FB_Axis', 'FB: unit metadata');

const originOf = (text) => fb.origins[idx(text)];
assert(JSON.stringify(originOf('n := 0;')) === JSON.stringify({ componentId: 'method_Reset', pane: 'impl', line: 1, generated: false }),
    'MAP: a method body line maps to that method, implementation pane, line 1');
assert(originOf('\tbHard : BOOL;').componentId === 'method_Reset' && originOf('\tbHard : BOOL;').pane === 'decl' && originOf('\tbHard : BOOL;').line === 3,
    'MAP: a method declaration line maps to the declaration pane');
assert(originOf('Count := n;').componentId === 'prop_Count_get' && originOf('n := Count;').componentId === 'prop_Count_set',
    'MAP: accessor lines map to their own accessor');
assert(originOf('n := -1;').componentId === 'action_Stop' && originOf('n := -1;').pane === 'impl', 'MAP: an action line maps to the action');
assert(originOf('refOut REF= bLocal;').componentId === 'root' && originOf('refOut REF= bLocal;').line === 2, 'MAP: the body maps to the root implementation');
const endMethod = originOf('END_METHOD');
assert(endMethod.generated && endMethod.componentId === 'method_Reset' && endMethod.pane === 'impl' && endMethod.line === 2,
    'MAP: END_METHOD is anchored on the last line of the method body');
assert(originOf('GET').componentId === 'prop_Count_get' && originOf('GET').pane === 'decl' && originOf('GET').line === 1,
    'MAP: GET is anchored on the accessor declaration when it has one');
assert(originOf('SET').componentId === 'prop_Count_set' && originOf('SET').pane === 'impl',
    'MAP: SET is anchored on the body when the accessor has no declaration text');
assert(originOf('END_PROPERTY').componentId === 'prop_Count' && originOf('END_FUNCTION_BLOCK').componentId === 'root' && originOf('END_FUNCTION_BLOCK').line === 2,
    'MAP: END_PROPERTY belongs to the property signature, END_FUNCTION_BLOCK to the end of the body');

// mapUnitPosition: the compiler's 1-based line/column → a pane position.
const bodyLine = idx('refOut REF= bLocal;') + 1;
let loc = mapUnitPosition(fb, { line: bodyLine, column: 8 });
assert(loc.exact && loc.componentId === 'root' && loc.pane === 'impl' && loc.line === 2 && loc.column === 8 && loc.endLine === 2 && loc.endColumn === 20,
    'POS: a position without an end runs to the end of its line');
loc = mapUnitPosition(fb, { line: bodyLine, column: 8, endLine: bodyLine, endColumn: 12 });
assert(loc.column === 8 && loc.endColumn === 12, 'POS: an end on the same line is kept');
loc = mapUnitPosition(fb, { line: bodyLine - 1, column: 1, endLine: bodyLine, endColumn: 4 });
assert(loc.line === 1 && loc.endLine === 2 && loc.endColumn === 4, 'POS: a range inside one pane keeps both lines');
loc = mapUnitPosition(fb, { line: idx('n := 0;') + 1, column: 1, endLine: bodyLine, endColumn: 4 });
assert(loc.componentId === 'method_Reset' && loc.endLine === 1 && loc.endColumn === 8,
    'POS: a range that would run into another component stops at the end of its own line');
loc = mapUnitPosition(fb, { line: idx('END_METHOD') + 1, column: 3 });
assert(!loc.exact && loc.componentId === 'method_Reset' && loc.pane === 'impl' && loc.line === 2,
    'POS: a position on a generated line lands on its anchor and is marked inexact');
for (const bad of [{ line: 0, column: 0 }, { line: 9999, column: 1 }, {}, { line: 'x' }]) {
    loc = mapUnitPosition(fb, bad);
    assert(!loc.exact && loc.componentId === 'root' && loc.pane === 'decl' && loc.line === 1,
        `POS: an unplaceable position (${JSON.stringify(bad)}) falls back to the root declaration, inexact`);
}
loc = mapUnitPosition(fb, { line: bodyLine, column: 500 });
assert(loc.column === 20 && loc.endColumn === 20, 'POS: a column past the line is clamped to its end');

// ── Program, function, GVL, DUT, interface ───────────────────────────────────────────────────────
const prgParsed = parseTwinCatXml(wrap('  <POU Name="MAIN" Id="{a}" SpecialFunc="None">' +
    block(`PROGRAM MAIN // FUNCTION_BLOCK in a comment${CRLF}VAR${CRLF}END_VAR`, 'x := 1;') + '</POU>'));
const prg = buildCheckUnit(prgParsed);
assert(invariantsHold(prgParsed, prg, 'MAIN') && prg.lines[prg.lines.length - 1] === 'END_PROGRAM',
    'PRG: a PROGRAM closes with END_PROGRAM even when a comment names another POU kind');

const fnParsed = parseTwinCatXml(wrap('  <POU Name="F_Add" Id="{a}" SpecialFunc="None">' +
    block(`FUNCTION F_Add : INT${CRLF}VAR_INPUT${CRLF}\ta : INT;${CRLF}END_VAR${CRLF}`, 'F_Add := a;') + '</POU>'));
const fn = buildCheckUnit(fnParsed);
assert(invariantsHold(fnParsed, fn, 'F_Add') && fn.lines[fn.lines.length - 1] === 'END_FUNCTION' && fn.lines[4] === '',
    'FN: a FUNCTION closes with END_FUNCTION; a trailing empty pane line is kept (the pane shows it)');

const emptyBodyParsed = parseTwinCatXml(wrap('  <POU Name="FB_E" Id="{a}" SpecialFunc="None">' + block('FUNCTION_BLOCK FB_E', '') + '</POU>'));
const emptyBody = buildCheckUnit(emptyBodyParsed);
assert(invariantsHold(emptyBodyParsed, emptyBody, 'FB_E') && emptyBody.lines.join('|') === 'FUNCTION_BLOCK FB_E|END_FUNCTION_BLOCK' &&
    emptyBody.origins[1].pane === 'impl' && emptyBody.origins[1].line === 1,
    'EMPTY: an empty body adds no line; the closing keyword is anchored on line 1 of the (empty) body pane');

const gvlParsed = parseTwinCatXml(wrap('  <GVL Name="GVL_Io" Id="{a}">' +
    block(`{attribute 'qualified_only'}${CRLF}VAR_GLOBAL${CRLF}\tbIn : BOOL;${CRLF}END_VAR`) + '</GVL>'));
const gvl = buildCheckUnit(gvlParsed);
assert(invariantsHold(gvlParsed, gvl, 'GVL_Io') && gvl.globalListName === 'GVL_Io' && gvl.lines.length === 4 && gvl.origins.every(o => !o.generated),
    'GVL: the declaration alone, verbatim, and the list name for the compiler');

const dutParsed = parseTwinCatXml(wrap('  <DUT Name="E_State" Id="{a}">' +
    block(`TYPE E_State :${CRLF}(${CRLF}\tIdle := 0,${CRLF}\tRun${CRLF}) DINT;${CRLF}END_TYPE`) + '</DUT>'));
const dut = buildCheckUnit(dutParsed);
assert(invariantsHold(dutParsed, dut, 'E_State') && dut.lines[4] === ') DINT;' && dut.globalListName === null,
    'DUT: the declaration alone; the postfix enum base type is NOT rewritten (the dialect profile accepts it)');

const itfParsed = parseTwinCatXml(wrap([
    '  <Itf Name="I_Axis" Id="{a}">',
    '    <Declaration>' + cdata('INTERFACE I_Axis') + '</Declaration>',
    '    <Method Name="Home" Id="{b}">',
    '      <Declaration>' + cdata(`METHOD Home : BOOL${CRLF}VAR_INPUT${CRLF}END_VAR`) + '</Declaration>',
    '    </Method>',
    '    <Property Name="Pos" Id="{c}">',
    '      <Declaration>' + cdata('PROPERTY Pos : LREAL') + '</Declaration>',
    '      <Get Name="Get" Id="{d}"><Declaration>' + cdata('') + '</Declaration></Get>',
    '    </Property>',
    '  </Itf>'
].join(CRLF)));
const itf = buildCheckUnit(itfParsed);
assert(invariantsHold(itfParsed, itf, 'I_Axis') &&
    itf.lines.join('|') === 'INTERFACE I_Axis|METHOD Home : BOOL|VAR_INPUT|END_VAR|END_METHOD|PROPERTY Pos : LREAL|GET|END_GET|END_PROPERTY|END_INTERFACE',
    `ITF: signatures only, each closed, then END_INTERFACE (${itf.lines.join('|')})`);
assert(itf.origins[6].componentId === 'prop_Pos' && itf.origins[6].generated && itf.origins[9].componentId === 'root',
    'ITF: generated lines belong to the property signature and to the interface');

assert(buildCheckUnit(null) === null && buildCheckUnit({ rootType: 'POU', components: [] }) === null,
    'GUARD: nothing parsed, or no root component → no unit');

// ── Every file of the committed sample round-trips ───────────────────────────────────────────────
const sampleDir = path.join(__dirname, '..', 'sample');
if (!fs.existsSync(sampleDir)) {
    console.log('[SKIP] sample/ is absent — the sample round-trip did not run');
} else {
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) { if (e.name !== '_Libraries') walk(path.join(dir, e.name)); }
            else if (/\.(tcpou|tcgvl|tcdut|tcio|tctleo)$/i.test(e.name)) files.push(path.join(dir, e.name));
        }
    };
    walk(sampleDir);
    let checkedLines = 0;
    let bad = 0;
    for (const file of files) {
        const parsed = parseTwinCatXml(fs.readFileSync(file, 'utf8'));
        const unit = parsed && buildCheckUnit(parsed);
        if (!unit || !invariantsHold(parsed, unit, path.basename(file))) { bad++; continue; }
        // Each emitted line maps to exactly one source position, and that position holds its text.
        unit.lines.forEach((text, i) => {
            const at = mapUnitPosition(unit, { line: i + 1, column: 1 });
            const comp = parsed.components.find(c => c.id === at.componentId);
            const pane = comp && paneLines(at.pane === 'decl' ? comp.declaration : comp.implementation);
            if (!comp) bad++;
            else if (at.exact && pane[at.line - 1] !== text) bad++;
            else if (!at.exact && at.line > Math.max(1, pane.length)) bad++;
            checkedLines++;
        });
    }
    assert(files.length >= 19 && bad === 0, `SAMPLE: all ${files.length} sample objects round-trip (${checkedLines} emitted lines, ${bad} problem(s))`);
}

if (errors > 0) {
    console.error(`\n${errors} check-unit assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll check-unit assertions passed.');
