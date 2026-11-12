/**
 * @file test_conditional_pragmas.js
 * @description R12 — the built-in language server and TwinCAT conditional pragmas
 * (`{IF}` / `{ELSIF}` / `{ELSE}` / `{END_IF}`, `{define}` / `{undefine}`).
 *
 * The LSP never evaluates a condition (src/lsp/conditionals.js): every branch combination is treated
 * as possible, so a diagnostic is only raised when it holds under every one. This harness pins:
 *   - the grouping itself (nesting, segments, boundaries, directives in comments/strings, unbalanced
 *     segments) as unit tests;
 *   - ZERO diagnostics on valid conditional code — the known false positive (an IF head picked per
 *     branch), ELSIF chains, nested groups, blocks split across branches and groups, declarations that
 *     differ per branch (also when used outside a group), names declared only in a branch, guards on
 *     `defined(variable:…)` / `defined(pou:…)`, a mid-expression group, a conditional EXTENDS head, a
 *     conditional VAR section header, a half-typed `{IF`;
 *   - that code OUTSIDE groups keeps every check (a missing END_FOR, a stray END_WHILE, an undeclared
 *     name, a type mismatch), and the selection cap;
 *   - that a unit without conditional pragmas is matched byte-identically to the old matcher (over every
 *     sample unit), and per-segment matching equals whole-unit matching there;
 *   - completion and references over both branches.
 *
 * Each case runs the server's path: XML → livePath.assembleSt (raw unit + lineMap) → indexXmlObject →
 * syncDocument → provideDiagnostics. Standalone: no fixture is required (the sample snapshot is skipped,
 * not failed, without sample/ — it is covered by the FULL/REDUCED banner via the other harnesses).
 */

const fs = require('fs');
const path = require('path');
const { tokenize, clearWorkspaceIndex, getWorkspaceSymbolIndex, parseAndIndexDocument } = require('../src/lsp/parser');
const { indexXmlObject, buildNodeFromXml } = require('../src/lsp/xmlIndexer');
const { provideDiagnostics, provideCompletions, provideReferences } = require('../src/lsp/features');
const { structuralDiagnostics } = require('../src/lsp/features/diagnostics');
const { createDiagnostic } = require('../src/lsp/features/core');
const cond = require('../src/lsp/conditionals');
const { pickVar, AMBIGUOUS, resolveSymbolType } = require('../src/lsp/types');
const { assembleSt, mapDiagnosticsToLocal } = require('../src/livePath');
const { syncDocument } = require('./_baseline');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');

let errors = 0;
function assert(ok, msg) {
    if (ok) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const section = (t) => console.log(`\n--- ${t} ---`);

let guidN = 0;
const guid = () => `{00000000-0000-0000-0000-${String(++guidN).padStart(12, '0')}}`;
const lf = (s) => s.replace(/\r?\n/g, '\r\n');

/**
 * A .TcPOU with optional methods.
 * @param {string} name
 * @param {string} decl
 * @param {string} impl
 * @param {Array<{name: string, decl: string, impl: string}>} [methods]
 */
function pou(name, decl, impl, methods = []) {
    const m = methods.map(x =>
        `    <Method Name="${x.name}" Id="${guid()}">\r\n      <Declaration><![CDATA[${lf(x.decl)}]]></Declaration>\r\n` +
        `      <Implementation>\r\n        <ST><![CDATA[${lf(x.impl)}]]></ST>\r\n      </Implementation>\r\n    </Method>\r\n`).join('');
    return `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <POU Name="${name}" Id="${guid()}" SpecialFunc="None">\r\n` +
        `    <Declaration><![CDATA[${lf(decl)}]]></Declaration>\r\n    <Implementation>\r\n      <ST><![CDATA[${lf(impl)}]]></ST>\r\n    </Implementation>\r\n` +
        `${m}  </POU>\r\n</TcPlcObject>`;
}

/**
 * Runs the server's diagnostics path on `xml` (with `others` indexed first).
 * @returns {{diags: Array<Object>, stText: string, lineMap: Object, mapped: Array<Object>, index: Object, uri: string}}
 */
function run(xml, others = [], overlay = null) {
    clearWorkspaceIndex();
    const index = getWorkspaceSymbolIndex();
    others.forEach((o, i) => indexXmlObject(index, o, `file:///tmp/r12/Other${i}.TcPOU`));
    const uri = 'file:///tmp/r12/Unit.TcPOU';
    indexXmlObject(index, xml, uri);
    const { stText, lineMap } = assembleSt(xml, overlay);
    syncDocument(index, stText, uri);
    const diags = provideDiagnostics(stText, index, uri);
    return { diags, stText, lineMap, mapped: mapDiagnosticsToLocal(diags, lineMap), index, uri };
}

const show = (r) => r.diags.map(d => `L${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message} >> ${(r.stText.split('\n')[d.range.start.line] || '').trim()}`).join(' | ');
const VARS = 'PROGRAM P\nVAR\n\tx : INT;\n\ty : INT;\n\tc : BOOL;\n\ts1 : STRING;\nEND_VAR';
/**
 * Asserts 0 diagnostics. Unless `expectUnbalanced`, it also asserts every segment is balanced, so a
 * zero never comes from the "unbalanced → silent" rule by accident (that would be a vacuous pass).
 */
const zero = (title, xml, others, expectUnbalanced = false) => {
    const r = run(xml, others);
    const c = tokenize(r.stText).conditionals;
    const unbalanced = c ? c.unbalancedSegments.length : 0;
    assert(r.diags.length === 0 && (expectUnbalanced ? unbalanced > 0 : unbalanced === 0),
        `${title}: 0 diagnostics${expectUnbalanced ? ' (unbalanced segment)' : ', every segment balanced'}` +
        `${r.diags.length ? ' (got ' + show(r) + ')' : ''}${unbalanced && !expectUnbalanced ? ` (${unbalanced} unbalanced segment(s))` : ''}`);
    return r;
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
section('UNIT: grouping, segments and boundaries');
{
    const t = tokenize('x := 1;\n{IF defined(A)}\nIF c THEN\n{IF defined(B)}\ny := 1;\n{ELSE}\ny := 2;\n{END_IF}\n{ELSIF defined(C)}\nWHILE c DO\n{ELSE}\nx := 3;\n{END_IF}\n');
    const c = t.conditionals;
    assert(!!c && c.groups.length === 2 && c.segments.length === 1 && c.unbalancedSegments.length === 0, 'two groups (one nested) in one balanced segment');
    const outer = c.groups[0], inner = c.groups[1];
    assert(outer.branches.length === 3 && outer.hasElse && inner.parent === outer && inner.branches.length === 2, 'the outer group has IF/ELSIF/ELSE branches; the inner one is its child');
    const yTok = t.find(k => k.value === 'y');
    assert(yTok.cond && yTok.cond.group === inner.id && yTok.cond.branch === 0, 'a token carries its innermost group and branch');
    const xFirst = t.find(k => k.value === 'x');
    assert(!xFirst.cond, 'a token outside every group carries no cond');
    const dirs = t.filter(k => k.condDirective).map(k => k.condDirective).join(',');
    assert(dirs === 'if,if,else,end_if,elsif,else,end_if', `directives are tagged in order (${dirs})`);
    assert(!t.find(k => k.value === '{IF defined(A)}').cond && !!t.find(k => k.value === '{IF defined(B)}').cond, 'an outermost {IF} has no cond; a nested one sits in its parent branch');

    const plain = tokenize('{attribute \'hide\'}\n{define X}\nx := 1;\n{undefine X}');
    assert(!plain.conditionals, '{define}/{undefine}/attributes are plain pragmas: no annotation at all');
    const hidden = tokenize("(* {IF defined(A)} *)\n// {END_IF}\ns := '{ELSE}';\nx := 1;");
    assert(!hidden.conditionals, 'directives inside (* *), // and strings are ignored');

    const rs = tokenize('{IF defined(A)}\n\tfbRS.SET := TRUE;\n{ELSE}\n\tfbRS.RESET1 := TRUE;\n{END_IF}');
    assert(rs.conditionals.segments.length === 1 && rs.conditionals.unbalancedSegments.length === 0,
        '`fbRS.SET := TRUE;` inside a group is NOT a segment boundary (the group stays balanced)');

    const unit = 'METHOD A\n{IF defined(X)}\nx := 1;\n{END_IF}\nEND_METHOD\nMETHOD B\n{IF defined(Y)}\ny := 1;\n{END_IF}\nEND_METHOD\n';
    const u = tokenize(unit).conditionals;
    assert(u.segments.length === 4 && u.groups.length === 2 && u.unbalancedSegments.length === 0,
        `METHOD/END_METHOD at line start split the unit into segments (${u.segments.length})`);
}

section('UNIT: unbalanced segments mark only themselves');
{
    const cases = {
        'a stray {END_IF}': 'x := 1;\n{END_IF}',
        'a second {ELSE}': '{IF defined(A)}\nx := 1;\n{ELSE}\nx := 2;\n{ELSE}\nx := 3;\n{END_IF}',
        'an {ELSIF} after {ELSE}': '{IF defined(A)}\nx := 1;\n{ELSE}\nx := 2;\n{ELSIF defined(B)}\nx := 3;\n{END_IF}',
        'an {IF} left open': '{IF defined(A)}\nx := 1;'
    };
    for (const [title, body] of Object.entries(cases)) {
        const t = tokenize(`METHOD A\n${body}\nEND_METHOD\nMETHOD B\n{IF defined(Z)}\ny := 1;\n{END_IF}\nEND_METHOD\n`);
        const c = t.conditionals;
        const bad = c.segments.filter(s => s.unbalanced);
        const yTok = t.find(k => k.value === 'y');
        assert(bad.length === 1 && bad[0].start === 0 && yTok.cond && yTok.cond.group >= 0,
            `${title}: only its own segment is unbalanced; the next method's group is intact`);
        const xTok = t.find(k => k.value === 'x');
        assert(xTok.cond && xTok.cond.group === -1, `${title}: every token of the unbalanced segment counts as conditional`);
    }
}

section('UNIT: selections, cap and suppression spans');
{
    const t = tokenize('{IF defined(A)}\nIF c THEN\n{ELSE}\nIF NOT c THEN\n{END_IF}\nx := 1;\nEND_IF');
    const seg = t.conditionals.segments[0];
    const sels = cond.blockSelections(seg, () => false);
    assert(sels.length === 2 && sels.every(s => s.length === 2), `E: two selections of two keywords each (${sels.map(s => s.length)})`);
    const many = tokenize(Array.from({ length: 7 }, (_, i) => `{IF defined(G${i})}\nIF c THEN\n{END_IF}`).join('\n'));
    assert(cond.blockSelections(many.conditionals.segments[0], () => false) === null, '7 groups without ELSE = 128 selections: above the cap of 64 → null');
    const neutral = tokenize('{IF defined(A)}\nIF c THEN x := 1; END_IF\n{ELSE}\nWHILE c DO x := 2; END_WHILE\n{END_IF}');
    const ns = cond.blockSelections(neutral.conditionals.segments[0], (seq) => seq.length % 2 === 0);
    assert(ns.length === 1 && ns[0].length === 0, 'a neutral group (each branch balanced alone) is dropped from the selections');

    const mid = tokenize('x := 1;\ny := {IF defined(A)}1{ELSE}2{END_IF};\nx := 2;');
    const spans = cond.suppressionSpans(mid);
    assert(spans.length === 1 && spans[0].startLine === 2 && spans[0].startCol === 1 && spans[0].endLine === 2,
        `a mid-expression group's span widens back to the statement start and forward through its ';' (${JSON.stringify(spans)})`);
    assert(cond.isSuppressed(spans, 2, 1) && !cond.isSuppressed(spans, 1, 1) && !cond.isSuppressed(spans, 3, 1), 'isSuppressed holds inside the span only');
    const stmt = tokenize('x := 1;\n{IF defined(A)}\ny := 1;\n{END_IF}\nx := 2;');
    const s2 = cond.suppressionSpans(stmt);
    assert(s2.length === 1 && s2[0].startLine === 2 && s2[0].endLine === 4, `a statement-level group's span is exactly the group (${JSON.stringify(s2)})`);
}

section('UNIT: declarations, pickVar and paramSetFromVars');
{
    clearWorkspaceIndex();
    const idx = getWorkspaceSymbolIndex();
    parseAndIndexDocument('PROGRAM P\nVAR\n{IF defined(SIM)}\n\ts : STRING;\n\tk : INT;\n{ELSE}\n\ts : INT;\n\tk : INT := 4;\n{END_IF}\n\tz : {IF defined(SIM)}INT{ELSE}REAL{END_IF};\n\tw : BOOL;\nEND_VAR\nEND_PROGRAM', 'file:///tmp/r12/p.st');
    const vars = idx.P.variables;
    assert(vars.filter(v => v.name === 's').every(v => v.conditional) && !vars.find(v => v.name === 'w').conditional, 'variables inside a group are conditional; one outside is not');
    assert(!('conditional' in vars.find(v => v.name === 'w')), 'a plain variable keeps its exact shape (no new key)');
    assert(pickVar(vars, 's') === AMBIGUOUS, 'pickVar: same name, different types per branch → AMBIGUOUS');
    assert(pickVar(vars, 'k') && pickVar(vars, 'k') !== AMBIGUOUS && pickVar(vars, 'k').type === 'INT', 'pickVar: same type, different initialisers → the first declaration');
    assert(pickVar(vars, 'z') === AMBIGUOUS, 'pickVar: a directive inside the type → AMBIGUOUS');
    assert(resolveSymbolType('s', { pou: idx.P, method: null }, idx).kind === 'unknown', 'resolveSymbolType maps AMBIGUOUS to unknown');

    const hdr = buildNodeFromXml(pou('FB_H', 'FUNCTION_BLOCK FB_H\n{IF defined(SIM)}\nVAR\n{ELSE}\nVAR_INPUT\n{END_IF}\n\tx : INT;\nEND_VAR', ''), 'file:///tmp/r12/h.TcPOU');
    const hx = hdr.variables.find(v => v.name === 'x');
    assert(hx && hx.scopeUncertain === true && hx.conditional === true, 'a variable under a conditional section header is scopeUncertain');

    const inh = buildNodeFromXml(pou('FB_C', 'FUNCTION_BLOCK FB_C {IF defined(SIM)} EXTENDS FB_A {ELSE} EXTENDS FB_B {END_IF}\nVAR\n\tq : INT;\nEND_VAR', ''), 'file:///tmp/r12/c.TcPOU');
    assert(inh.inheritanceUncertain === true, 'xmlIndexer: a conditional EXTENDS head sets inheritanceUncertain');
    clearWorkspaceIndex();
    parseAndIndexDocument('FUNCTION_BLOCK FB_C {IF defined(SIM)} EXTENDS FB_A {ELSE} EXTENDS FB_B {END_IF}\nVAR\nEND_VAR\nEND_FUNCTION_BLOCK', 'file:///tmp/r12/c.st');
    assert(getWorkspaceSymbolIndex().FB_C.inheritanceUncertain === true, 'parser: a conditional EXTENDS head sets inheritanceUncertain');
    const plainNode = buildNodeFromXml(pou('FB_N', 'FUNCTION_BLOCK FB_N EXTENDS FB_A\nVAR\n{IF defined(SIM)}\n\tq : INT;\n{END_IF}\nEND_VAR', ''), 'file:///tmp/r12/n.TcPOU');
    assert(!('inheritanceUncertain' in plainNode), 'a conditional inside VAR does not make the head uncertain');
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section('MUST GIVE 0: probe cases A–I');
{
    const P = (decl, impl) => pou('P', decl, impl);
    zero('A body, both branches declared', P(VARS, '{IF defined(SIM)}\nx := 1;\n{ELSE}\ny := 2;\n{END_IF}'));
    zero('B duplicate declaration in branches', P('PROGRAM P\nVAR\n{IF defined(SIM)}\n\tx : INT := 1;\n{ELSE}\n\tx : INT := 2;\n{END_IF}\nEND_VAR', 'x := x + 1;'));
    zero('C different types per branch', P('PROGRAM P\nVAR\n{IF defined(SIM)}\n\tv : BOOL;\n{ELSE}\n\tv : INT;\n{END_IF}\n\tb : BOOL;\nEND_VAR', '{IF defined(SIM)}\nb := v;\n{ELSE}\nv := 5;\n{END_IF}'));
    zero('D name only in a branch', P('PROGRAM P\nVAR\n{IF defined(SIM)}\n\tsimOnly : INT;\n{END_IF}\nEND_VAR', '{IF defined(SIM)}\nsimOnly := 1;\n{END_IF}'));
    zero('E (the reported false positive) IF head per branch', P(VARS, '{IF defined(SIM)}\nIF c THEN\n{ELSE}\nIF NOT c THEN\n{END_IF}\n\tx := 1;\nEND_IF'));
    zero('F {define}/{undefine}, hasvalue, project_defined', P(VARS, "{define LOCAL_FLAG}\n{IF hasvalue(MODE, 'fast') AND NOT defined(LOCAL_FLAG)}\nx := 1;\n{ELSIF project_defined(X)}\nx := 2;\n{END_IF}\n{undefine LOCAL_FLAG}"));
    zero('G STRING/INT per branch', P('PROGRAM P\nVAR\n{IF defined(SIM)}\n\ts : STRING;\n{ELSE}\n\ts : INT;\n{END_IF}\nEND_VAR', "{IF defined(SIM)}\ns := 'abc';\n{ELSE}\ns := 5;\n{END_IF}"));
    zero('H INT/STRING per branch', P('PROGRAM P\nVAR\n{IF defined(SIM)}\n\ts : INT;\n{ELSE}\n\ts : STRING;\n{END_IF}\nEND_VAR', "{IF defined(SIM)}\ns := 5;\n{ELSE}\ns := 'abc';\n{END_IF}"));
    zero('I WHILE/FOR split across two groups', P(VARS, '{IF defined(SIM)}\nWHILE c DO\n{ELSE}\nFOR x := 1 TO 2 DO\n{END_IF}\n\tx := 1;\n{IF defined(SIM)}\nEND_WHILE\n{ELSE}\nEND_FOR\n{END_IF}'));
}

section('MUST GIVE 0: TwinCAT-style variants');
{
    const P = (impl, decl = VARS) => pou('P', decl, impl);
    zero('E with an {ELSIF} third head', P('{IF defined(A)}\nIF c THEN\n{ELSIF defined(B)}\nIF NOT c THEN\n{ELSE}\nIF x > 0 THEN\n{END_IF}\n\tx := 1;\nEND_IF'));
    zero('nested groups', P('{IF defined(A)}\n{IF defined(B)}\nIF c THEN\n{ELSE}\nIF NOT c THEN\n{END_IF}\n{ELSE}\nIF x > 1 THEN\n{END_IF}\n\tx := 1;\nEND_IF'));
    zero('IF in one group, END_IF in a second group with the same condition, no ELSE', P('{IF defined(SIM)}\nIF c THEN\n{END_IF}\n\tx := 1;\n{IF defined(SIM)}\nEND_IF\n{END_IF}'));
    zero('REPEAT/UNTIL split across branches', P('{IF defined(SIM)}\nREPEAT\n{ELSE}\nWHILE c DO\n{END_IF}\n\tx := x + 1;\n{IF defined(SIM)}\nUNTIL x > 3\nEND_REPEAT\n{ELSE}\nEND_WHILE\n{END_IF}'));
    zero('CASE split across branches', P('{IF defined(SIM)}\nCASE x OF\n{ELSE}\nCASE y OF\n{END_IF}\n1: c := TRUE;\nEND_CASE'));
    zero('defined(variable:nope) guarding nope := 1', P('{IF defined(variable:nope)}\nnope := 1;\n{END_IF}'));
    zero('defined(pou:F_X) guarding a call to F_X()', P('{IF defined(pou:F_X)}\nx := F_X(1);\nF_X(nIn := 2);\n{END_IF}'));
    zero("G's s used OUTSIDE the group (pickVar)", P("s := 'abc';\ns := 5;", 'PROGRAM P\nVAR\n{IF defined(SIM)}\n\ts : STRING;\n{ELSE}\n\ts : INT;\n{END_IF}\nEND_VAR'));
    zero('a mid-expression group with mismatched branch types', P("x := {IF defined(SIM)}'abc'{ELSE}5{END_IF};\ns1 := {IF defined(SIM)}'a'{ELSE}7{END_IF};"));
    zero('a declaration whose type holds a directive', P("z := 'abc';\nz := 5;", 'PROGRAM P\nVAR\n\tz : {IF defined(SIM)}STRING{ELSE}INT{END_IF};\nEND_VAR'));
    zero('a half-typed `{IF defined(X)` with no closing brace', P('{IF defined(X)\nIF c THEN\nx := 1;'), [], true);
    zero('a {define}d name used in a branch only', P('{define LOCAL}\n{IF defined(LOCAL)}\nlocalOnly := 1;\n{END_IF}\n{undefine LOCAL}'));

    // Conditional EXTENDS: the members used come from the base each branch names. The chain then counts
    // as unresolved, so the undeclared-identifier check is off for this POU — even for a name neither
    // base declares (the price of never guessing which base is compiled).
    const fbA = pou('FB_A', 'FUNCTION_BLOCK FB_A\nVAR\n\tnA : INT;\nEND_VAR', '');
    const fbB = pou('FB_B', 'FUNCTION_BLOCK FB_B\nVAR\n\tnB : INT;\nEND_VAR', '');
    zero('a conditional EXTENDS head', pou('FB_C', 'FUNCTION_BLOCK FB_C\n{IF defined(SIM)}\nEXTENDS FB_A\n{ELSE}\nEXTENDS FB_B\n{END_IF}\nVAR\nEND_VAR',
        '{IF defined(SIM)}\nnA := 1;\n{ELSE}\nnB := 1;\n{END_IF}\nnInNeitherBase := 1;'), [fbA, fbB]);
    const fbC1 = pou('FB_C1', 'FUNCTION_BLOCK FB_C1 {IF defined(SIM)} EXTENDS FB_A {END_IF}\nVAR\nEND_VAR', 'nA := 1;');
    zero('an EXTENDS that only exists under a define, inherited member used outside the group', fbC1, [fbA]);

    // A VAR section header that depends on a define: x may be a VAR or a VAR_INPUT.
    const fbH = pou('FB_H', 'FUNCTION_BLOCK FB_H\nVAR\n\tk : INT;\nEND_VAR\n{IF defined(SIM)}\nVAR\n{ELSE}\nVAR_INPUT\n{END_IF}\n\tx : INT;\nEND_VAR', '');
    zero('a conditional VAR/VAR_INPUT header with a named call fb(x := 1)', pou('P', 'PROGRAM P\nVAR\n\tfb : FB_H;\nEND_VAR', 'fb(x := 1);'), [fbH]);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section('MUST STILL REPORT: code outside groups');
{
    const E = '{IF defined(SIM)}\nIF c THEN\n{ELSE}\nIF NOT c THEN\n{END_IF}\n\tx := 1;\nEND_IF';
    let r = run(pou('P', VARS, `FOR x := 1 TO 3 DO\n${E}`));
    const forLine = r.lineMap.root.impl.start;
    assert(r.diags.length === 1 && r.diags[0].range.start.line + 1 === forLine && /END_FOR/.test(r.diags[0].message),
        `an unterminated FOR outside groups next to E: exactly 1 error, at the FOR (${show(r)})`);
    r = run(pou('P', VARS, `${E}\nEND_WHILE`));
    assert(r.diags.length === 1 && /Unmatched "END_WHILE"/.test(r.diags[0].message), `an unmatched END_WHILE outside groups is reported (${show(r)})`);
    r = run(pou('P', VARS, `${E}\nnUndeclared := 1;\ns1 := 5;`));
    const msgs = r.diags.map(d => d.message);
    assert(r.diags.length === 2 && msgs.some(m => /nUndeclared/.test(m)) && msgs.some(m => /Type mismatch/.test(m)),
        `an undeclared name and a type mismatch outside groups are reported in a unit holding a group (${show(r)})`);
    r = run(pou('P', VARS, '{IF defined(SIM)}\nIF c THEN\n{ELSE}\nIF NOT c THEN\n{END_IF}\n\tx := 1;'));
    const ifLine = r.lineMap.root.impl.start;
    assert(r.diags.length === 1 && /Unterminated block/.test(r.diags[0].message) && r.diags[0].range.start.line + 1 === ifLine &&
        r.diags[0].range.start.character === 0,
        `both branches open an IF that nothing closes: 1 error, anchored on the group's {IF} (outside the branches) (${show(r)})`);
    r = run(pou('P', VARS, '{IF defined(SIM)}\nx := 1;', [{ name: 'M', decl: 'METHOD M : BOOL\nVAR\nEND_VAR', impl: 'nMissing := 1;' }]));
    assert(r.mapped.length === 1 && r.mapped[0].componentId !== 'root' && /nMissing/.test(r.mapped[0].message),
        `a method after an unclosed {IF} still gets its own undeclared-identifier error (${show(r)})`);

    const groups = Array.from({ length: 7 }, (_, i) => `{IF defined(G${i})}\nIF c THEN\n{END_IF}`).join('\n');
    r = run(pou('P', VARS, `${groups}\nx := 1;\nEND_WHILE`, [{ name: 'M', decl: 'METHOD M : BOOL\nVAR\nEND_VAR', impl: 'FOR x := 1 TO 2 DO\n\tx := 1;' }]));
    assert(r.mapped.length === 1 && r.mapped[0].componentId !== 'root' && /END_FOR/.test(r.mapped[0].message),
        `the cap: a 7-group segment (128 selections) reports nothing structural, the next segment still does (${show(r)})`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section('NO GROUP: byte-identical to the old matcher; per-segment = whole unit (sample units)');
{
    /** The block matcher as it was before R12 (features/diagnostics.js), kept as the reference. */
    const legacy = (tokens) => {
        const diagnostics = [];
        const blockStack = [];
        tokens.forEach(tok => {
            if (tok.type !== 'keyword') return;
            const upper = tok.value.toUpperCase();
            if (['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT'].includes(upper)) blockStack.push({ word: upper, line: tok.line, col: tok.col });
            else if (upper === 'END_IF') { const p = blockStack.pop(); if (!p || p.word !== 'IF') diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 6, 'Unmatched "END_IF": missing preceding "IF"')); }
            else if (upper === 'END_CASE') { const p = blockStack.pop(); if (!p || p.word !== 'CASE') diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 8, 'Unmatched "END_CASE": missing preceding "CASE"')); }
            else if (upper === 'END_FOR') { const p = blockStack.pop(); if (!p || p.word !== 'FOR') diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 7, 'Unmatched "END_FOR": missing preceding "FOR"')); }
            else if (upper === 'END_WHILE') { const p = blockStack.pop(); if (!p || p.word !== 'WHILE') diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 9, 'Unmatched "END_WHILE": missing preceding "WHILE"')); }
            else if (upper === 'UNTIL') { const p = blockStack.pop(); if (!p || p.word !== 'REPEAT') diagnostics.push(createDiagnostic(tok.line, tok.col, tok.col + 5, 'Unmatched "UNTIL": missing preceding "REPEAT"')); }
        });
        blockStack.forEach(b => diagnostics.push(createDiagnostic(b.line, b.col, b.col + b.word.length, `Unterminated block: missing matching "END_${b.word}"`)));
        return diagnostics;
    };
    const sampleDir = path.join(__dirname, '..', 'sample');
    const units = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== '_Libraries') walk(full); }
            else if (/\.(TcPOU|TcGVL|TcDUT|TcIO)$/i.test(e.name)) units.push(full);
        }
    };
    if (fs.existsSync(sampleDir)) walk(sampleDir);
    // Synthetic broken units too, so the comparison covers real errors, not only empty lists.
    const synthetic = ['IF a THEN\nWHILE b DO\nEND_IF\nEND_FOR\nUNTIL x\nCASE y OF\nEND_CASE\nREPEAT\n',
        'METHOD A\nWHILE c DO\nEND_METHOD\nMETHOD B\nEND_WHILE\nEND_METHOD\n'];
    let compared = 0, identical = 0, segEqual = 0, withConditionals = 0;
    const texts = units.map(f => convertXmlToSt(parseTwinCatXml(fs.readFileSync(f, 'utf8')), { raw: true }).stText).concat(synthetic);
    for (const text of texts) {
        const tokens = tokenize(text);
        if (tokens.conditionals) { withConditionals++; continue; }
        compared++;
        if (JSON.stringify(legacy(tokens)) === JSON.stringify(structuralDiagnostics(tokens))) identical++;
        const forced = cond.annotateConditionals(tokenize(text));
        const a = JSON.stringify(structuralDiagnostics(tokens));
        const b = JSON.stringify(structuralDiagnostics(forced));
        if (a === b) segEqual++;
        else if (text === synthetic[1]) segEqual++; // a WHILE in A closed by B's END_WHILE: per segment is stricter by design
    }
    assert(withConditionals === 0, 'no sample unit holds a conditional pragma (the sample takes the fast path)');
    assert(compared === identical && compared > 2, `a unit with no group: structural diagnostics byte-identical to the old matcher (${identical}/${compared} units${units.length ? '' : '; sample/ absent — synthetic only'})`);
    assert(compared === segEqual, `per-segment matching equals whole-unit matching on every unit with balanced wrappers (${segEqual}/${compared})`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section('FEATURES: completion and references over both branches');
{
    const xml = pou('P', 'PROGRAM P\nVAR\n{IF defined(SIM)}\n\tsimA : INT;\n{ELSE}\n\trealB : INT;\n{END_IF}\n\tx : INT;\nEND_VAR',
        '{IF defined(SIM)}\nx := simA;\n{ELSE}\nx := realB;\n{END_IF}\nx := x + 1;');
    const r = run(xml);
    const lines = r.stText.split('\n');
    const at = r.lineMap.root.impl.start + 5; // 1-based line of "x := x + 1;"
    const items = provideCompletions(r.stText, { line: at - 1, character: 0 }, r.index, r.uri);
    const labels = items.map(c => c.label);
    assert(labels.includes('simA') && labels.includes('realB'), 'completion lists the declarations from both branches');
    const xLine = lines.findIndex(l => /^x := simA;/.test(l));
    const refs = provideReferences(r.stText, { line: xLine, character: 0 }, r.index, r.uri);
    const refLines = new Set(refs.map(x => x.range.start.line));
    const inSim = lines.findIndex(l => /^x := simA;/.test(l));
    const inElse = lines.findIndex(l => /^x := realB;/.test(l));
    assert(refLines.has(inSim) && refLines.has(inElse), `references find x in both branches (${refs.length} reference(s))`);
}

console.log(`\n--- CONDITIONAL PRAGMA TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors > 0 ? 1 : 0);
