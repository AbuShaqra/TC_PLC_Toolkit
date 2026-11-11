/**
 * @file test_compiler_defines.js
 * @description src/compilerDefines.js: a PLC project's compiler defines read from its `.plcproj`
 * (`<CompilerDefines>` in a `<PropertyGroup>`) and turned into the compiler's `-D` arguments.
 *
 * Pinned: names and `NAME := 'value'` entries, spacing, case kept, duplicates, empty/missing
 * elements, malformed entries skipped with a note, per-object defines ignored, MSBuild's last-wins
 * and `$(CompilerDefines)`, MSBuild `Condition`s evaluated for Debug|TwinCAT RT (x64) on property groups
 * and elements (the spellings real `.plcproj` files use; undecidable ones left out with a note), XML
 * entities, integer values passed as a name only (the compiler would declare a global constant), and
 * an unreadable file.
 */

'use strict';

const { readCompilerDefines, parseDefineList, defineArgs, projectDefineArgs, evaluateCondition, CHECK_CONFIGURATION } = require('../src/compilerDefines');

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
r = parseDefineList('A, B, A');
assert(show(r.defines) === 'B A', `LIST: a repeated name keeps its last entry at its last place (${show(r.defines)})`);
r = readCompilerDefines(project(group('    <CompilerDefines>ABC</CompilerDefines>\r\n    <CompilerDefines>$(CompilerDefines), backstop, EMLabeling</CompilerDefines>')));
assert(show(r.defines) === 'ABC backstop EMLabeling', `PLCPROJ: MSBuild last-wins with $(CompilerDefines) (${show(r.defines)})`);
r = readCompilerDefines(project(group('    <CompilerDefines>A</CompilerDefines>'), group('    <CompilerDefines>B</CompilerDefines>')));
assert(show(r.defines) === 'B', 'PLCPROJ: a later property group wins');
r = readCompilerDefines(project(group("    <CompilerDefines>InclSerialCom := &apos;true&apos;, T &amp; X</CompilerDefines>")));
assert(show(r.defines) === 'InclSerialCom="true"' && r.problems.length === 1, `PLCPROJ: XML entities are decoded (${show(r.defines)})`);
r = readCompilerDefines(project('  <!-- <PropertyGroup><CompilerDefines>OLD</CompilerDefines></PropertyGroup> -->', group('    <CompilerDefines>NEW</CompilerDefines>')));
assert(show(r.defines) === 'NEW', 'PLCPROJ: commented-out XML is ignored');
r = readCompilerDefines('not xml at all <CompilerDefines>');
assert(r.defines.length === 0, 'PLCPROJ: garbage gives no defines and does not throw');

// ── Conditions (evaluated for Debug | TwinCAT RT (x64)) ──────────────────────────────────────────
assert(CHECK_CONFIGURATION.configuration === 'Debug' && CHECK_CONFIGURATION.platform === 'TwinCAT RT (x64)' && Object.isFrozen(CHECK_CONFIGURATION),
    'COND: the check configuration is Debug | TwinCAT RT (x64), in one frozen constant');
const debugProps = new Map([['configuration', 'Debug'], ['platform', 'TwinCAT RT (x64)'], ['flavour', 'Sim']]);
const cases = [
    // The spellings XAE writes (public .plcproj files on GitHub: Beckhoff/TF6310_Samples, Beckhoff/TF6300_Samples, …)
    [" '$(Configuration)' == 'Debug' ", true], [" '$(Configuration)' == 'Release' ", false], [" '$(Configuration)' == ''", false],
    [" '$(Configuration)' == 'CE' ", false],
    // Visual Studio's configuration|platform form, and hand-edited variants
    [" '$(Configuration)|$(Platform)' == 'Debug|TwinCAT RT (x64)' ", true], ["'$(Configuration)|$(Platform)'=='Release|TwinCAT RT (x64)'", false],
    ["'$(Configuration)|$(Platform)' == 'Debug|TwinCAT RT (x86)'", false], ["'$(Platform)' == 'TwinCAT RT (x64)'", true],
    ["'$(Configuration)' == 'debug'", true], ["'$(CONFIGURATION)' == 'DEBUG'", true], ["'$(Configuration)' != 'Release'", true],
    ["'$(Configuration)' != 'Debug'", false], ["'Debug' == '$(Configuration)'", true], ["\t'$(Configuration)'  ==\r\n 'Debug'", true],
    ["$(Configuration) == Debug", true],
    ["'$(Configuration)' == 'Debug' And '$(Platform)' == 'TwinCAT RT (x64)'", true], ["'$(Configuration)' == 'Debug' and '$(Platform)' == 'x86'", false],
    ["'$(Configuration)' == 'Release' OR '$(Configuration)' == 'Debug'", true], ["'$(Configuration)' == 'Release' or '$(Platform)' == 'x86'", false],
    ["('$(Configuration)' == 'Release' Or '$(Configuration)' == 'Debug') And ('$(Platform)' == 'TwinCAT RT (x64)')", true],
    ["!('$(Configuration)' == 'Release')", true], ["false", false], ["true", true], ["'1.0' == '1'", true],
    // Other properties: from earlier groups, else ''
    ["'$(Flavour)' == 'sim'", true], ["'$(Undefined)' == ''", true], ["'$(Undefined)' != ''", false],
    // Undecidable, unreadable
    ["Exists('C:\\x.props')", null], ["Exists('x') And '$(Configuration)' == 'Debug'", null], ["Exists('x') And '$(Configuration)' == 'Release'", false],
    ["Exists('x') Or '$(Configuration)' == 'Debug'", true], ["HasTrailingSlash('$(OutputPath)')", null],
    ["'$(Configuration)' > 'A'", null], ["'$(Configuration)' == 'Debug", null], ["'$(Configuration)' ==", null], ["", null], ["Debug", null],
    ["('$(Configuration)' == 'Debug'", null], ["'$([System.DateTime]::Now.Year)' == '2026'", null], ["'@(Compile)' == ''", null],
    ["'$(Configuration)' == 'Debug' Xor true", null],
];
for (const [cond, want] of cases) {
    let got;
    try { got = evaluateCondition(cond, debugProps); } catch (e) { got = `threw ${e.message}`; }
    assert(got === want, `COND: ${JSON.stringify(cond)} → ${want} (${got})`);
}

const debugGroup = " Condition=\" '$(Configuration)' == 'Debug' \"";
const releaseGroup = " Condition=\" '$(Configuration)' == 'Release' \"";
r = readCompilerDefines(project(group('    <CompilerDefines>A</CompilerDefines>'), group('    <CompilerDefines>$(CompilerDefines), DBG</CompilerDefines>', debugGroup),
    group('    <CompilerDefines>REL</CompilerDefines>', releaseGroup)));
assert(show(r.defines) === 'A DBG' && r.problems.length === 0,
    `PLCPROJ: a Debug group applies in document order with $(CompilerDefines); a Release group is skipped without a note (${show(r.defines)}; ${r.problems.join(' | ')})`);
r = readCompilerDefines(project(group('    <CompilerDefines>A</CompilerDefines>'), group('    <CompilerDefines>DBG</CompilerDefines>', debugGroup)));
assert(show(r.defines) === 'DBG' && r.problems.length === 0, 'PLCPROJ: a later Debug group wins (MSBuild last-wins)');
r = readCompilerDefines(project(group('    <CompilerDefines>REL</CompilerDefines>', releaseGroup), group('    <CompilerDefines>A</CompilerDefines>')));
assert(show(r.defines) === 'A' && r.problems.length === 0, 'PLCPROJ: a Release group before the unconditioned one changes nothing');
r = readCompilerDefines(project(group("    <CompilerDefines>A</CompilerDefines>\r\n    <CompilerDefines Condition=\"'$(Configuration)'=='Debug'\">$(CompilerDefines),DBG</CompilerDefines>\r\n" +
    "    <CompilerDefines Condition=\"'$(Configuration)'=='Release'\">REL</CompilerDefines>")));
assert(show(r.defines) === 'A DBG' && r.problems.length === 0, `PLCPROJ: a Condition on the element itself: Debug applied, Release skipped (${show(r.defines)})`);
r = readCompilerDefines(project(group('    <CompilerDefines>X64</CompilerDefines>', " Condition=\"'$(Configuration)|$(Platform)'=='Debug|TwinCAT RT (x64)'\""),
    group('    <CompilerDefines>X86</CompilerDefines>', " Condition=\"'$(Configuration)|$(Platform)'=='Debug|TwinCAT RT (x86)'\"")));
assert(show(r.defines) === 'X64' && r.problems.length === 0, `PLCPROJ: a platform mismatch is skipped (${show(r.defines)})`);
r = readCompilerDefines(project(group('    <CompilerDefines>A</CompilerDefines>'), group('    <CompilerDefines>EX</CompilerDefines>', " Condition=\"Exists('local.props')\""),
    group("    <CompilerDefines Condition=\"'$(Configuration)' &gt; 'A'\">GT</CompilerDefines>")));
assert(show(r.defines) === 'A' && r.problems.length === 2 &&
    /property group whose Condition="Exists\('local\.props'\)" cannot be evaluated for Debug\|TwinCAT RT \(x64\) was not used/.test(r.problems[0]) &&
    /<CompilerDefines Condition="'\$\(Configuration\)' > 'A'"> that cannot be evaluated for Debug\|TwinCAT RT \(x64\) was not used/.test(r.problems[1]),
    `PLCPROJ: an undecidable group or element condition is left out with a note naming it (${r.problems.join(' | ')})`);
r = readCompilerDefines(project(group('    <OutputPath>bin</OutputPath>', " Condition=\"Exists('x')\"")));
assert(r.defines.length === 0 && r.problems.length === 0, 'PLCPROJ: an undecidable group without <CompilerDefines> gives no note');
r = readCompilerDefines(project(group('    <Flavour>Sim</Flavour>'), group('    <CompilerDefines>SIMBUILD</CompilerDefines>', " Condition=\"'$(Flavour)' == 'sim'\""),
    group('    <CompilerDefines>$(CompilerDefines), NEVER</CompilerDefines>', " Condition=\"'$(Later)' == 'x'\""), group('    <Later>x</Later>')));
assert(show(r.defines) === 'SIMBUILD' && r.problems.length === 0, `PLCPROJ: another property comes from an earlier group; one set only later is '' (${show(r.defines)})`);
r = readCompilerDefines(project(group('    <Stamp>$([System.DateTime]::Now)</Stamp>'), group('    <CompilerDefines>S</CompilerDefines>', " Condition=\"'$(Stamp)' == ''\"")));
assert(r.defines.length === 0 && r.problems.length === 1, 'PLCPROJ: a condition on a property whose value is not readable is not decided');
r = readCompilerDefines(project(group("    <Configuration Condition=\" '$(Configuration)' == ''\">Release</Configuration>\r\n    <Platform>x86</Platform>"),
    group('    <CompilerDefines>DBG</CompilerDefines>', debugGroup)));
assert(show(r.defines) === 'DBG', 'PLCPROJ: the project\'s own <Configuration>/<Platform> defaults do not override the check configuration');
r = readCompilerDefines(project(group('    <CompilerDefines>A</CompilerDefines>'), group('    <CompilerDefines>R</CompilerDefines>', releaseGroup)),
    { configuration: 'Release', platform: 'TwinCAT RT (x64)' });
assert(show(r.defines) === 'R', 'PLCPROJ: the configuration is a parameter (a later setting can change it)');
// The shape XAE writes (Beckhoff/TF6300_Samples FileUpload.plcProj, abridged): defaults, empty defines, Debug/Release groups.
r = readCompilerDefines(project("  <PropertyGroup>\r\n    <Configuration Condition=\" '$(Configuration)' == '' \">Debug</Configuration>\r\n    <CompilerDefines />\r\n  </PropertyGroup>",
    "  <PropertyGroup Condition=\" '$(Configuration)' == 'Debug' \">\r\n    <DebugSymbols>true</DebugSymbols>\r\n    <OutputPath>bin\\Debug\\</OutputPath>\r\n  </PropertyGroup>",
    "  <PropertyGroup Condition=\" '$(Configuration)' == 'Release' \">\r\n    <OutputPath>bin\\Release\\</OutputPath>\r\n  </PropertyGroup>",
    "  <PropertyGroup Condition=\" '$(Configuration)' == 'Debug' \" />"));
assert(r.defines.length === 0 && r.problems.length === 0, 'PLCPROJ: the shape XAE writes gives no defines and no note');

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
