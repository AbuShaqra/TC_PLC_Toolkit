/**
 * @file test_ads_paths.js
 * @description Online monitoring (R15): which ADS path each variable occurrence in a pane stands for.
 * Drives the LSP's `provideOnlinePaths` (src/lsp/features/onlinePaths.js) over the sample project's
 * assembled units, exactly as the host sends them, and over synthetic units for the shapes the sample
 * does not contain. The host-side mapping back to pane positions and the instance substitution are
 * covered too (src/online/editorPaths.js), so a position in a pane is followed all the way to the
 * path the session reads.
 *
 * The rule under test is the conservative one: a path is produced only where the declaration is
 * certain, and the shapes that have no ADS symbol of their own (method locals, VAR_TEMP, VAR_IN_OUT,
 * a FUNCTION's variables) say so with a reason instead of a path.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseAndIndexDocument, clearWorkspaceIndex, getWorkspaceSymbolIndex } = require('../src/lsp/parser');
const { indexXmlObject } = require('../src/lsp/xmlIndexer');
const { provideOnlinePaths } = require('../src/lsp/features');
const { assembleSt } = require('../src/livePath');
const { paneRanges, mapOccurrences, substituteInstance } = require('../src/online/editorPaths');
const { reportCoverage } = require('./_coverage');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const SAMPLE = path.join(__dirname, '..', 'sample', 'TcToolkitSample', 'TcToolkitSample_PLC');

/** @param {string} dir @param {string[]} [out] @returns {string[]} */
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '_Libraries') walk(full, out); }
        else if (/\.(TcPOU|TcGVL|TcDUT)$/i.test(e.name)) out.push(full);
    }
    return out;
}

/** Every occurrence of an object, all components, as the host would ask for them. */
function occurrencesOf(byName, name) {
    const entry = byName[name];
    const unit = assembleSt(entry.xml, null);
    parseAndIndexDocument(unit.stText, entry.uri);
    const ranges = paneRanges(unit.lineMap, null);
    const result = provideOnlinePaths(unit.stText, ranges, getWorkspaceSymbolIndex(), entry.uri);
    return { unit, result, mapped: mapOccurrences(result.occurrences, unit.lineMap) };
}

// --- 1. The sample, through the same assemble -> LSP -> pane mapping as the editor ------------------
if (!fs.existsSync(SAMPLE)) {
    console.log('sample/ not present: skipping the sample half of the online-path test.');
    reportCoverage('ads-paths-sample', 'skipped', 'sample/ not present');
} else {
    clearWorkspaceIndex();
    const idx = getWorkspaceSymbolIndex();
    const byName = {};
    for (const f of walk(SAMPLE)) {
        const xml = fs.readFileSync(f, 'utf8');
        const uri = 'file:///' + f.replace(/\\/g, '/').replace(/^\//, '');
        const node = indexXmlObject(idx, xml, uri);
        if (node) byName[node.name] = { uri, xml };
    }

    const main = occurrencesOf(byName, 'MAIN');
    const find = (m, componentId, pane, text) => m.mapped.find(o => o.componentId === componentId && o.pane === pane && o.text === text);
    assert(main.result.owner && main.result.owner.kind === 'PROGRAM', 'MAIN is answered as a PROGRAM');
    const declCount = find(main, 'root', 'decl', 'nCycleCount');
    assert(declCount && declCount.path === 'MAIN.nCycleCount' && declCount.localType === 'UDINT',
        `a PROGRAM's declaration line maps to MAIN.<name> with its declared type (${JSON.stringify(declCount)})`);
    assert(declCount && declCount.line === 3 && declCount.eol === true,
        'the declaration occurrence sits on its pane-local line (1-based) and is shown at the end of the line');
    const qualified = find(main, 'root', 'impl', 'GVL_Hmi.bEnable');
    assert(qualified && qualified.path === 'GVL_Hmi.bEnable' && qualified.localType === 'BOOL',
        `a qualified global maps to GVL.var (${JSON.stringify(qualified)})`);
    assert(qualified && qualified.line === 7 && qualified.startColumn === 1 && qualified.endColumn === 16,
        `its pane position is 1-based Monaco columns around the whole chain (${qualified && [qualified.line, qualified.startColumn, qualified.endColumn]})`);
    const nested = find(main, 'root', 'impl', 'GVL_System.fbStation.State');
    assert(nested && nested.path === 'GVL_System.fbStation.State', 'a chain through an FB instance keeps every member');
    assert(!main.mapped.some(o => /F_Scale|fValue|fMin|E_StationState|Cyclic/.test(o.text)),
        'calls, named call arguments, enum literals and method calls produce no occurrence');
    assert(!main.mapped.some(o => /arValues/.test(o.text)), 'an index that is not an integer literal produces no occurrence for the element');
    assert(main.mapped.filter(o => o.text === 'nIdx' && o.pane === 'impl').length === 2,
        'the index variable itself is still monitored (FOR and subscript)');

    const station = occurrencesOf(byName, 'FB_Station');
    assert(station.result.owner && station.result.owner.kind === 'FUNCTION_BLOCK'
        && station.result.owner.derived.includes('FB_StationDerived'),
        `an FB answers its derived FBs so their instances can be offered (${JSON.stringify(station.result.owner)})`);
    const member = find(station, 'method_Cyclic', 'impl', '_stStatus.bError');
    assert(member && member.path === '{instance}._stStatus.bError' && member.localType === 'BOOL',
        `an FB member used in a method maps to {instance}.<chain> (${JSON.stringify(member)})`);
    const local = find(station, 'method_Cyclic', 'impl', 'bExtended');
    assert(local && local.path === null && local.reason === 'method-local', 'a method local has no path, with the reason');
    const localDecl = find(station, 'method_Cyclic', 'decl', 'bExtended');
    assert(localDecl && localDecl.path === null && localDecl.reason === 'method-local', 'so has its declaration');
    const arr = find(station, 'method_Cyclic', 'impl', '_stRecipe.aSteps[1]');
    assert(arr && arr.path === '{instance}._stRecipe.aSteps[1]' && arr.localType === 'INT',
        `a constant array index is part of the path and the element type is followed (${JSON.stringify(arr)})`);
    assert(!station.mapped.some(o => o.componentId.startsWith('prop_')),
        'property accessor bodies produce nothing (their locals are not indexed)');
    const action = find(station, 'action_Act_Home', 'impl', '_eState');
    assert(action && action.path === '{instance}._eState', 'an action body sees its FB\'s members');
    const retVar = find(station, 'method_Execute', 'impl', 'Execute');
    assert(retVar && retVar.path === null && retVar.reason === 'method-local', 'a method\'s return variable is a method local');

    const gvl = occurrencesOf(byName, 'GVL_System');
    const fbInit = find(gvl, 'root', 'decl', 'fbCylinder');
    assert(fbInit && fbInit.path === 'GVL_System.fbCylinder' && fbInit.localType === 'FB_Cylinder',
        `a GVL declaration with FB_init arguments has the bare FB type (${JSON.stringify(fbInit)})`);
    assert(!gvl.mapped.some(o => /bExtendOut/.test(o.text)), 'initializer expressions in a declaration produce nothing');

    // Restricting the ranges to one component and a few lines (what the visible-range message does).
    const stationUnit = station.unit;
    const only = paneRanges(stationUnit.lineMap, { componentId: 'method_Cyclic', decl: null, impl: [{ start: 25, end: 26 }] });
    const sliced = mapOccurrences(provideOnlinePaths(stationUnit.stText, only, getWorkspaceSymbolIndex(), byName.FB_Station.uri).occurrences, stationUnit.lineMap);
    assert(sliced.length > 0 && sliced.every(o => o.componentId === 'method_Cyclic' && o.pane === 'impl' && o.line >= 25 && o.line <= 26),
        `visible-line ranges restrict the answer to those pane lines (${sliced.map(o => o.line + ':' + o.text).join(', ')})`);
    reportCoverage('ads-paths-sample', 'ran');
}

// --- 2. Synthetic shapes --------------------------------------------------------------------------
clearWorkspaceIndex();
/** Indexes a synthetic object the way the scan does: from its TwinCAT XML. */
function indexSynthetic(kind, name, decl, impl) {
    const body = impl === undefined ? '' : `<Implementation><ST><![CDATA[${impl}]]></ST></Implementation>`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<TcPlcObject Version="1.1.0.1">\n<${kind} Name="${name}" Id="{00000000-0000-0000-0000-000000000000}">` +
        `<Declaration><![CDATA[${decl}]]></Declaration>${body}</${kind}>\n</TcPlcObject>`;
    indexXmlObject(getWorkspaceSymbolIndex(), xml, `file:///syn/${name}.Tc${kind === 'POU' ? 'POU' : kind}`);
}
indexSynthetic('GVL', 'GVL_A', 'VAR_GLOBAL\n\tgShared : INT;\n\tgOnlyA : BOOL;\n\tpArr : ARRAY[1..3, 0..1] OF REAL;\nEND_VAR\n');
indexSynthetic('GVL', 'GVL_B', 'VAR_GLOBAL\n\tgShared : INT;\nEND_VAR\n');
indexSynthetic('DUT', 'ST_P', 'TYPE ST_P :\nSTRUCT\n\tx : LREAL;\n\tname : STRING(20);\nEND_STRUCT\nEND_TYPE\n');

const fbCode = [
    'FUNCTION_BLOCK FB_T',               // 0
    'VAR_INPUT',                         // 1
    '\tbIn : BOOL;',                     // 2
    'END_VAR',                           // 3
    'VAR_IN_OUT',                        // 4
    '\tio : INT;',                       // 5
    'END_VAR',                           // 6
    'VAR',                               // 7
    '\tst : ST_P;',                      // 8
    '\tp : POINTER TO ST_P;',            // 9
    '\tn : INT := 5;',                   // 10
    'END_VAR',                           // 11
    'VAR_TEMP',                          // 12
    '\ttmp : INT;',                      // 13
    'END_VAR',                           // 14
    '',                                  // 15
    'THIS^.n := io + tmp;',              // 16
    'p^.x := st.x;',                     // 17
    'n := F_Add(a := n);',               // 18
    'gShared := gOnlyA;',                // 19
    'st.name := GVL_A.pArr[2, 1];',      // 20
    'GVL_A.pArr[2] := 0;',               // 21
    'END_FUNCTION_BLOCK'                 // 22
].join('\n');
const fbUri = 'file:///syn/FB_T.TcPOU';
parseAndIndexDocument(fbCode, fbUri);
const syn = provideOnlinePaths(fbCode, [{ start: 0, end: 14, pane: 'decl' }, { start: 15, end: 21, pane: 'impl' }],
    getWorkspaceSymbolIndex(), fbUri).occurrences;
const at = (line, text) => syn.find(o => o.line === line && o.text === text);
assert(at(16, 'THIS^.n') && at(16, 'THIS^.n').path === '{instance}.n', 'THIS^.member maps to the instance member');
assert(at(16, 'io') && at(16, 'io').path === null && at(16, 'io').reason === 'in-out', 'VAR_IN_OUT has no symbol of its own');
assert(at(16, 'tmp') && at(16, 'tmp').reason === 'temp', 'VAR_TEMP has no symbol');
assert(at(5, 'io') && at(5, 'io').reason === 'in-out' && at(13, 'tmp') && at(13, 'tmp').reason === 'temp',
    'and their declaration lines say the same');
assert(!syn.some(o => o.line === 17 && /^p/.test(o.text)), 'a pointer dereference produces nothing');
assert(at(17, 'st.x') && at(17, 'st.x').path === '{instance}.st.x' && at(17, 'st.x').localType === 'LREAL',
    'a struct member after it does');
assert(!syn.some(o => o.line === 18 && o.text === 'a'), 'a named argument NAME produces nothing');
assert(syn.filter(o => o.line === 18 && o.text === 'n').length === 2, 'the assigned variable and the argument VALUE both do');
assert(!syn.some(o => o.line === 19 && o.text === 'gShared'), 'an unqualified global declared by two GVLs is ambiguous and produces nothing');
assert(at(19, 'gOnlyA') && at(19, 'gOnlyA').path === 'GVL_A.gOnlyA', 'an unqualified global declared by one GVL maps to that GVL');
const multi = at(20, 'GVL_A.pArr[2,1]') || syn.find(o => o.line === 20 && /pArr/.test(o.text));
assert(multi && multi.path === 'GVL_A.pArr[2,1]' && multi.localType === 'REAL',
    `a multi-dimensional constant index keeps both subscripts and resolves the element (${JSON.stringify(multi)})`);
const partial = syn.find(o => o.line === 21 && /pArr/.test(o.text));
assert(partial && partial.path === 'GVL_A.pArr[2]' && partial.localType === null,
    'an index with the wrong number of subscripts keeps the path for the PLC to judge but has no local type');
assert(at(20, 'st.name') && at(20, 'st.name').localType === 'STRING(20)', 'a STRING length is kept in the local type');
assert(at(10, 'n') && at(10, 'n').localType === 'INT', 'a declaration initializer is not part of the type');

const fnUri = 'file:///syn/F_Add.TcPOU';
const fnCode = 'FUNCTION F_Add : INT\nVAR_INPUT\n\ta : INT;\nEND_VAR\nVAR\n\tt : INT;\nEND_VAR\nt := a;\nF_Add := t + gOnlyA;\nEND_FUNCTION\n';
parseAndIndexDocument(fnCode, fnUri);
const fn = provideOnlinePaths(fnCode, [{ start: 0, end: 6, pane: 'decl' }, { start: 7, end: 8, pane: 'impl' }],
    getWorkspaceSymbolIndex(), fnUri).occurrences;
assert(fn.filter(o => o.text === 't' || o.text === 'a').every(o => o.path === null && o.reason === 'function-local')
    && fn.filter(o => o.text === 't' || o.text === 'a').length === 5, "a FUNCTION's variables have no symbol");
assert(fn.some(o => o.text === 'gOnlyA' && o.path === 'GVL_A.gOnlyA'), 'a global used inside a FUNCTION still maps');

// --- 3. Instance substitution ----------------------------------------------------------------------
assert(substituteInstance('{instance}._eState', 'MAIN.fbA') === 'MAIN.fbA._eState', 'the instance placeholder takes the chosen instance');
assert(substituteInstance('{instance}._eState', null) === null, 'without an instance there is no path');
assert(substituteInstance('GVL.x', null) === 'GVL.x', 'a path without the placeholder is unchanged');

if (errors) { console.error(`\n${errors} online-path assertion(s) failed`); process.exit(1); }
console.log('\nAll online-path assertions passed.');
