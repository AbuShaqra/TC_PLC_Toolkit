/**
 * @file test_compiler_defines.js
 * @description src/compilerDefines.js: a PLC project's compiler defines read from its `.plcproj`
 * (`<CompilerDefines>` in a `<PropertyGroup>`) and turned into the compiler's `-D` arguments.
 *
 * Pinned: names and `NAME := 'value'` entries, spacing, case kept, duplicates, empty/missing
 * elements, malformed entries skipped with a note, per-object defines ignored, MSBuild's last-wins
 * and `$(CompilerDefines)`, conditional property groups, XML entities, integer values passed as a
 * name only (the compiler would declare a global constant), and an unreadable file.
 */

'use strict';

const { readCompilerDefines, parseDefineList, defineArgs, projectDefineArgs } = require('../src/compilerDefines');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const show = (defines) => defines.map(d => (d.value === null ? d.name : `${d.name}=${JSON.stringify(d.value)}`)).join(' ');
const project = (...groups) => ['<?xml version="1.0" encoding="utf-8"?>',
    '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">', ...groups, '</Project>'].join('\r\n');
const group = (inner, attrs = '') => `  <PropertyGroup${attrs}>\r\n    <Name>P</Name>\r\n${inner}\r\n  </PropertyGroup>`;

// ── The list ─────────────────────────────────────────────────────────────────────────────────────
let r = parseDefineList('SIM');
assert(show(r.defines) === 'SIM' && r.problems.length === 0, 'LIST: one name');
r = parseDefineList("SIM,Mode := 'fast',  TRACE ,X:='a b, c'");
assert(show(r.defines) === 'SIM Mode="fast" TRACE X="a b, c"' && r.problems.length === 0,
    `LIST: names and values, any spacing, a comma inside quotes stays in the value (${show(r.defines)})`);
r = parseDefineList("sim, Sim, SIM");
assert(show(r.defines) === 'sim Sim SIM', 'LIST: names are case-sensitive and kept as written');
r = parseDefineList("A, B := 'x', A, B := 'y'");
assert(show(r.defines) === 'A B="y"', `LIST: a name given twice keeps its last entry (${show(r.defines)})`);
r = parseDefineList("E := ''");
assert(show(r.defines) === 'E=""', 'LIST: an empty quoted value is a value');
r = parseDefineList('  ');
assert(r.defines.length === 0 && r.problems.length === 0, 'LIST: blank text is no define and no problem');
r = parseDefineList('A,,B,');
assert(show(r.defines) === 'A B' && r.problems.length === 0, 'LIST: empty entries are ignored');
r = parseDefineList("1st, a-b, Plain:=x, C = 'v', D := 'v' extra, OK, F := \"v\", G :=");
assert(show(r.defines) === 'OK' && r.problems.length === 7 && r.problems.every(p => /skipped: expected NAME or NAME := 'value'/.test(p)),
    `LIST: malformed entries are skipped, each with a note; the good one stays (${r.problems.length} notes)`);
r = parseDefineList("A, B := 'open");
assert(r.defines.length === 0 && r.problems.length === 1 && /quote is not closed/.test(r.problems[0]), 'LIST: an unclosed quote drops the list with a note');

// ── The .plcproj ─────────────────────────────────────────────────────────────────────────────────
r = readCompilerDefines(project(group("    <CompilerDefines>SIM, Mode := 'fast'</CompilerDefines>")));
assert(show(r.defines) === 'SIM Mode="fast"' && r.problems.length === 0, 'PLCPROJ: <CompilerDefines> in the property group');
r = readCompilerDefines(project(group('')));
assert(r.defines.length === 0 && r.problems.length === 0, 'PLCPROJ: no element, no defines');
r = readCompilerDefines(project(group('    <CompilerDefines />')));
assert(r.defines.length === 0 && r.problems.length === 0, 'PLCPROJ: <CompilerDefines /> is empty');
r = readCompilerDefines(project(group('    <CompilerDefines>\r\n    </CompilerDefines>')));
assert(r.defines.length === 0 && r.problems.length === 0, 'PLCPROJ: whitespace only is empty (the form XAE writes)');
r = readCompilerDefines(project(group('    <CompilerDefines>A</CompilerDefines>'),
    '  <ItemGroup>\r\n    <Compile Include="POUs\\MAIN.TcPOU">\r\n      <SubType>Code</SubType>\r\n      <CompilerDefines>PER_OBJECT</CompilerDefines>\r\n    </Compile>\r\n  </ItemGroup>'));
assert(show(r.defines) === 'A', 'PLCPROJ: a per-object <CompilerDefines> in an item is not a project define');
assert(r.problems.length === 1 && /per-object compiler defines on POUs\\MAIN\.TcPOU \(PER_OBJECT\) are not passed/.test(r.problems[0]),
    `PLCPROJ: a per-object define gets a note naming the object and the list (${r.problems.join(' | ')})`);
r = readCompilerDefines(project(group(''),
    '  <ItemGroup>\r\n    <Compile Include="POUs\\MAIN.TcPOU">\r\n      <CompilerDefines />\r\n    </Compile>\r\n    <Compile Include="POUs\\FB.TcPOU" />\r\n  </ItemGroup>'));
assert(r.defines.length === 0 && r.problems.length === 0, 'PLCPROJ: an empty per-object define and a self-closed item give no note');
r = readCompilerDefines(project(group("    <CompilerDefines>A</CompilerDefines>\r\n    <CompilerDefines Condition=\"'$(Configuration)'=='Debug'\">DBG</CompilerDefines>")));
assert(show(r.defines) === 'A' && r.problems.length === 1 && /conditional <CompilerDefines>/.test(r.problems[0]),
    `PLCPROJ: a Condition on the element itself is not used either, and says so (${show(r.defines)}; ${r.problems.join(' | ')})`);
r = parseDefineList('A, B, A');
assert(show(r.defines) === 'B A', `LIST: a repeated name keeps its last entry at its last place (${show(r.defines)})`);
r = readCompilerDefines(project(group('    <CompilerDefines>ABC</CompilerDefines>\r\n    <CompilerDefines>$(CompilerDefines), backstop, EMLabeling</CompilerDefines>')));
assert(show(r.defines) === 'ABC backstop EMLabeling', `PLCPROJ: MSBuild last-wins with $(CompilerDefines) (${show(r.defines)})`);
r = readCompilerDefines(project(group('    <CompilerDefines>A</CompilerDefines>'), group('    <CompilerDefines>B</CompilerDefines>')));
assert(show(r.defines) === 'B', 'PLCPROJ: a later property group wins');
r = readCompilerDefines(project(group('    <CompilerDefines>A</CompilerDefines>'),
    group('    <CompilerDefines>DBG</CompilerDefines>', " Condition=\" '$(Configuration)' == 'Debug' \"")));
assert(show(r.defines) === 'A' && r.problems.length === 1 && /conditional property group/.test(r.problems[0]),
    'PLCPROJ: a conditional property group is not used, and says so');
r = readCompilerDefines(project(group("    <CompilerDefines>InclSerialCom := &apos;true&apos;, T &amp; X</CompilerDefines>")));
assert(show(r.defines) === 'InclSerialCom="true"' && r.problems.length === 1, `PLCPROJ: XML entities are decoded (${show(r.defines)})`);
r = readCompilerDefines(project('  <!-- <PropertyGroup><CompilerDefines>OLD</CompilerDefines></PropertyGroup> -->', group('    <CompilerDefines>NEW</CompilerDefines>')));
assert(show(r.defines) === 'NEW', 'PLCPROJ: commented-out XML is ignored');
r = readCompilerDefines('not xml at all <CompilerDefines>');
assert(r.defines.length === 0, 'PLCPROJ: garbage gives no defines and does not throw');

// ── The arguments ───────────────────────────────────────────────────────────────────────────────
let a = defineArgs(parseDefineList("SIM, Mode := 'fast', Sp := 'a b', E := ''").defines);
assert(JSON.stringify(a.args) === JSON.stringify(['-D', 'SIM', '-D', 'Mode=fast', '-D', 'Sp=a b', '-D', 'E=']) && a.notes.length === 0,
    `ARGS: NAME → -D NAME, NAME := 'v' → -D NAME=v (${a.args.join(' ')})`);
a = defineArgs(parseDefineList("Axes := '4', Neg := '-1', Lead := '12abc', Ver := 'v2'").defines);
assert(JSON.stringify(a.args) === JSON.stringify(['-D', 'Axes', '-D', 'Neg', '-D', 'Lead', '-D', 'Ver=v2']) && a.notes.length === 3 &&
    a.notes.every(n => /passed as ".*" only: hasvalue/.test(n)),
    `ARGS: a value the compiler would read as an integer constant is passed as a name only, with a note (${a.args.join(' ')})`);
a = defineArgs([]);
assert(a.args.length === 0 && a.notes.length === 0, 'ARGS: no defines, no arguments');

// ── One project ─────────────────────────────────────────────────────────────────────────────────
let p = projectDefineArgs('/x/P.plcproj', () => project(group("    <CompilerDefines>SIM, 2x, N := '7'</CompilerDefines>")));
assert(p.args.join(' ') === '-D SIM -D N' && p.notes.length === 2, `PROJECT: arguments plus the skipped-entry and integer notes (${p.notes.join(' | ')})`);
p = projectDefineArgs('/x/P.plcproj', () => { throw new Error('EACCES'); });
assert(p.args.length === 0 && p.notes.length === 1 && /not read: EACCES/.test(p.notes[0]), 'PROJECT: an unreadable .plcproj gives no defines and a note');
p = projectDefineArgs(null);
assert(p.args.length === 0 && p.notes.length === 0, 'PROJECT: no .plcproj, nothing');

if (errors > 0) {
    console.error(`\n${errors} compiler-define assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll compiler-define assertions passed.');
