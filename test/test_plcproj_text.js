/**
 * @file test_plcproj_text.js
 * @description The in-place `.plcproj` rewrite a rename makes (src/plcProjText.js).
 *
 * The rename used to unregister the old entry and register a new one: the entry moved to the end of
 * its ItemGroup and was rebuilt from a template, losing children such as `<LinkAlways>true</LinkAlways>`.
 * What is pinned here: only the Include value of the renamed entry (or of a renamed directory's entries)
 * changes, every other byte stays, and nothing that merely starts with the same text is touched. Runs
 * against both committed sample projects as well as a hand-written one.
 */

const fs = require('fs');
const path = require('path');
const { renamePlcProjEntries } = require('../src/plcProjText');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Every byte outside the changed attribute values is identical: a char-by-char diff of two texts. */
function diffSpans(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    let ja = a.length;
    let jb = b.length;
    while (ja > i && jb > i && a[ja - 1] === b[jb - 1]) { ja--; jb--; }
    return { start: i, oldPart: a.slice(i, ja), newPart: b.slice(i, jb) };
}

const CRLF = '\r\n';
const proj = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <ItemGroup>',
    '    <Compile Include="GVLs\\GVL_Main.TcGVL">',
    '      <SubType>Code</SubType>',
    '      <LinkAlways>true</LinkAlways>',
    '    </Compile>',
    '    <Compile Include="POUs\\FB_A.TcPOU">',
    '      <SubType>Code</SubType>',
    '      <ExcludeFromBuild>true</ExcludeFromBuild>',
    '    </Compile>',
    '    <Compile Include="POUs\\FB_AB.TcPOU">',
    '      <SubType>Code</SubType>',
    '    </Compile>',
    '    <Compile Include="POUs\\Sub\\FB_S.TcPOU">',
    '      <SubType>Code</SubType>',
    '    </Compile>',
    '    <Compile Include="POUs\\Sub\\Deep\\FB_T.TcPOU">',
    '      <SubType>Code</SubType>',
    '    </Compile>',
    '    <Compile Include="POUs\\SubX\\FB_U.TcPOU">',
    '      <SubType>Code</SubType>',
    '    </Compile>',
    '    <Compile Include="R&amp;D\\FB_R.TcPOU">',
    '      <SubType>Code</SubType>',
    '    </Compile>',
    '  </ItemGroup>',
    '  <ItemGroup>',
    '    <Folder Include="GVLs" />',
    '    <Folder Include="POUs" />',
    '    <Folder Include="POUs\\Sub" />',
    '    <Folder Include="POUs\\Sub\\Deep" />',
    '    <Folder Include="POUs\\SubX" />',
    '    <Folder Include="R&amp;D" />',
    '  </ItemGroup>',
    '  <ItemGroup>',
    '    <PlaceholderReference Include="POUs">',
    '      <DefaultResolution>Tc2_Standard, * (Beckhoff Automation GmbH)</DefaultResolution>',
    '    </PlaceholderReference>',
    '  </ItemGroup>',
    '</Project>',
    ''
].join(CRLF);

// --- a file rename ---
{
    const r = renamePlcProjEntries(proj, 'POUs\\FB_A.TcPOU', 'POUs\\FB_Axis.TcPOU', false);
    assert(r.count === 1, `file: one entry rewritten (got ${r.count})`);
    const d = diffSpans(proj, r.text);
    assert(d.oldPart === '' && d.newPart === 'xis',
        `file: the only change is inside the Include value (old "${d.oldPart}", new "${d.newPart}")`);
    assert(r.text.includes('<Compile Include="POUs\\FB_Axis.TcPOU">\r\n      <SubType>Code</SubType>\r\n      <ExcludeFromBuild>true</ExcludeFromBuild>'),
        'file: the entry keeps its place, its children and its CRLF line ends');
    assert(r.text.includes('<Compile Include="POUs\\FB_AB.TcPOU">'), 'file: a longer name with the same prefix is untouched');
    assert(r.text.length === proj.length + 3, 'file: length grows by exactly the name difference');
}
{
    const r = renamePlcProjEntries(proj, 'pous\\fb_a.tcpou', 'POUs\\FB_B.TcPOU', false);
    assert(r.count === 1 && r.text.includes('Include="POUs\\FB_B.TcPOU"'), 'file: matched case-insensitively (TwinCAT is Windows-only)');
}
{
    const r = renamePlcProjEntries(proj, 'POUs\\FB_A.TcPOU', 'POUs\\fb_a.TcPOU', false);
    assert(r.count === 1 && r.text.includes('Include="POUs\\fb_a.TcPOU"'), 'file: a case-only rename is written');
}
{
    const r = renamePlcProjEntries(proj, 'GVLs\\GVL_Main.TcGVL', 'GVLs\\GVL_Plant.TcGVL', false);
    assert(r.text.includes('<Compile Include="GVLs\\GVL_Plant.TcGVL">\r\n      <SubType>Code</SubType>\r\n      <LinkAlways>true</LinkAlways>'),
        'file: <LinkAlways> survives (the old unregister + register dropped it)');
}
{
    const r = renamePlcProjEntries(proj, 'POUs\\FB_Missing.TcPOU', 'POUs\\FB_New.TcPOU', false);
    assert(r.count === 0 && r.text === proj, 'file: an entry the project does not have changes nothing (and adds nothing)');
}
{
    const r = renamePlcProjEntries(proj, 'POUs\\FB_A.TcPOU', 'POUs\\FB_A.TcPOU', false);
    assert(r.count === 0 && r.text === proj, 'file: renaming to itself is a no-op');
}
{
    const r = renamePlcProjEntries(proj, 'R&D\\FB_R.TcPOU', 'R&D\\FB_Q.TcPOU', false);
    assert(r.count === 1 && r.text.includes('Include="R&amp;D\\FB_Q.TcPOU"'), 'file: XML entities are decoded to compare and re-encoded to write');
}

// --- a directory rename ---
{
    const r = renamePlcProjEntries(proj, 'POUs\\Sub', 'POUs\\Motion', true);
    assert(r.count === 4, `folder: its Folder entry, a nested Folder and two Compile entries rewritten (got ${r.count})`);
    for (const s of ['<Folder Include="POUs\\Motion" />', '<Folder Include="POUs\\Motion\\Deep" />',
        '<Compile Include="POUs\\Motion\\FB_S.TcPOU">', '<Compile Include="POUs\\Motion\\Deep\\FB_T.TcPOU">']) {
        assert(r.text.includes(s), `folder: ${s}`);
    }
    assert(r.text.includes('<Folder Include="POUs\\SubX" />') && r.text.includes('Include="POUs\\SubX\\FB_U.TcPOU"'),
        'folder: a sibling folder sharing the prefix (SubX) is untouched');
    assert(r.text.includes('<Folder Include="POUs" />'), 'folder: the parent is untouched');
    const back = renamePlcProjEntries(r.text, 'POUs\\Motion', 'POUs\\Sub', true);
    assert(back.text === proj, 'folder: renaming back restores the original byte for byte');
}
{
    const r = renamePlcProjEntries(proj, 'POUs', 'Code', true);
    assert(r.text.includes('<PlaceholderReference Include="POUs">'), 'folder: a library reference that happens to share the name is never touched');
    assert(!/Include="POUs[\\"]/.test(r.text.replace('<PlaceholderReference Include="POUs">', '')), 'folder: every POUs entry moved to Code');
}
{
    const r = renamePlcProjEntries(proj, 'POUs\\FB_A.TcPOU', 'POUs\\FB_Z.TcPOU', true);
    assert(r.count === 1, 'folder mode on a file path still matches the exact entry');
}

// --- the committed samples: byte identity outside the one value ---
const samples = [];
(function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.plcproj$/i.test(e.name)) samples.push(p);
    }
})(path.join(__dirname, '..', 'sample'));
assert(samples.length >= 2, `found the committed sample .plcproj files (got ${samples.length})`);
for (const file of samples) {
    const text = fs.readFileSync(file, 'utf8');
    const m = /<Compile Include="([^"]+\.TcPOU)"/.exec(text);
    if (!m) continue;
    const oldRel = m[1];
    const newRel = oldRel.replace(/([^\\]+)\.TcPOU$/, '$1_Renamed.TcPOU');
    const r = renamePlcProjEntries(text, oldRel, newRel, false);
    const d = diffSpans(text, r.text);
    assert(r.count === 1 && d.oldPart === '' && d.newPart === '_Renamed',
        `${path.basename(file)}: renaming ${oldRel} inserts only "_Renamed" (old "${d.oldPart}", new "${d.newPart}")`);
    assert(renamePlcProjEntries(r.text, newRel, oldRel, false).text === text, `${path.basename(file)}: and renaming back is byte-identical`);
}

console.log(errors === 0 ? '\nAll .plcproj rename-text checks passed.' : `\n${errors} failure(s)`);
process.exit(errors > 0 ? 1 : 0);
