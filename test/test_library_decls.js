/**
 * @file test_library_decls.js
 * @description Library declarations for Compile Project (R3.4, src/libraryDecls.js) — no compiler
 * runs here (test_compile_real.js runs the real one). Every library name and signature is
 * SYNTHETIC (test/_synthLibProject.js).
 *
 * Pinned:
 *   - the `.tmc` model: library-owned types only (the project's own and interfaces skipped), the
 *     kind of each, no comment or string text read;
 *   - gathering: dump + `.tmc` + archive names + namespaces, a dump library the project does not
 *     reference kept out of the top level, the no-dump case;
 *   - declarations: function, function block (methods, properties, actions), struct (EXTENDS),
 *     enumeration (values, base), alias, global list (constants with numeric values), the dump's
 *     enumeration; interface text only, no library comment or string;
 *   - conflicts: names the compiler provides (TON, CONCAT) and names the project declares are not
 *     redeclared; a declaration with a type that resolves to nothing is dropped;
 *   - qualifiers blanked with every column kept; members, comments, strings and user names untouched;
 *   - the filter, positive and negative (a user typo is still reported);
 *   - temp-dir lifetime: the declarations exist only inside the run's temporary directory, which
 *     is gone when the run ends, also when it fails; the project and workspace are untouched.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ld = require('../src/libraryDecls');
const cc = require('../src/compileCheck');
const { parseTwinCatXml } = require('../src/xmlParser');
const { parseLibrarySignaturesXml } = require('../src/lsp/librarySignatures');
const { createFakeSpawn } = require('./_fakeChild');
const { buildSynthLibProject, TMC, SIGNATURES, LEAK_MARKER } = require('./_synthLibProject');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_libdecls_'));
const BUNDLED = path.join(__dirname, '..', 'resources', 'compiler', 'compiler.cjs');

/** Every file under a directory, relative, sorted. */
function listTree(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p) + ':' + fs.statSync(p).size);
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out.sort();
}

/** The check inputs of a fixture project. */
function inputsOf(project) {
    return cc.buildCheckInputs(project.files.map(f => ({ filePath: f, text: fs.readFileSync(f, 'utf8') })), parseTwinCatXml).inputs;
}

(async () => {
    // ── The .tmc model ─────────────────────────────────────────────────────────────────────────
    {
        const model = ld.parseTmcDeclarations(TMC);
        const by = new Map(model.decls.map(d => [d.name, d]));
        assert(by.get('ST_SynPos').kind === 'struct' && by.get('ST_SynPos').members.map(m => m.type).join() === 'LREAL,LREAL,ARRAY [0..3] OF BYTE',
            'TMC: a struct with its fields, an array field rebuilt from ArrayInfo');
        assert(by.get('ST_SynPose').extendsType === 'ST_SynPos', 'TMC: a struct base read with a Namespace attribute on ExtendsType');
        assert(by.get('E_SynState').kind === 'enum' && by.get('E_SynState').values.map(v => `${v.name}=${v.value}`).join() === 'eSynIdle=0,eSynMoving=1,eSynFault=9' && by.get('E_SynState').baseType === 'INT',
            'TMC: an enumeration with its values and base type');
        assert(by.get('T_SynName').kind === 'alias' && by.get('T_SynName').baseType === 'STRING(31)', 'TMC: an alias with its base type');
        const gvl = by.get('GVL_SynConst');
        assert(gvl.kind === 'gvl' && gvl.members.map(m => `${m.name}=${m.value}`).join() === 'cSynMax=15,cSynGain=2.5,sSynBanner=',
            'TMC: a global list with numeric initial values; a STRING value is not taken');
        const fb = by.get('FB_SynAxis');
        assert(fb.kind === 'fb' && fb.io.length === 6 && fb.io.every(m => m.scope) && fb.methods.map(m => m.name).join() === 'MSynReset' &&
            fb.properties.map(p => `${p.name}:${p.type}:${p.get}:${p.set}`).join() === 'nSynCount:DINT:true:false' && fb.actions.join() === 'ActSynHome',
            'TMC: a function block: parameters (ItemType), a method, a property from its __get accessor, an action; its local is not a parameter');
        assert(!by.has('FB_UserOwn'), 'TMC: the project\'s own type (no Namespace attribute) is not a library declaration');
        assert(!by.has('I_SynItf') && model.names.includes('I_SynItf'), 'TMC: an interface is not declared, but its name is known');
        assert(!JSON.stringify(model).includes(LEAK_MARKER), 'TMC: no comment or string text is read into the model');
    }

    // ── Types ──────────────────────────────────────────────────────────────────────────────────
    {
        const ns = new Set(['synmotion']);
        const t = (s) => { const r = ld.readType(s, ns); return r ? `${r.text}|${r.deps.join(',')}` : null; };
        assert(t('SynMotion.ST_SynPos') === 'ST_SynPos|st_synpos', 'TYPE: a namespace qualifier is stripped');
        assert(t('ARRAY [0 .. 9, 1..2] OF REFERENCE TO ST_SynPos') === 'ARRAY [0..9, 1..2] OF REFERENCE TO ST_SynPos|st_synpos', 'TYPE: arrays and references');
        assert(t('string[80]') === 'STRING(80)|' && t('WSTRING') === 'WSTRING|' && t('dint') === 'DINT|', 'TYPE: strings and elementary types');
        assert(t('ARRAY [0..cMax] OF INT') === null && t('STRING(MAX_LEN)') === null && t('Other.T_X') === null && t('') === null,
            'TYPE: a constant bound or length, a foreign qualifier, nothing — refused, never guessed');
        assert(t('LTIME') === 'LTIME|ltime', 'TYPE: a type the compiler lacks stays a dependency, which then resolves to nothing');
    }

    // ── The compiler's own names ───────────────────────────────────────────────────────────────
    {
        const names = ld.compilerProvidedNames(BUNDLED);
        assert(['TON', 'R_TRIG', 'CTU', 'CONCAT', 'LIMIT', 'DINT'].every(n => names.has(n)) && !names.has('F_SYNADD'),
            'COMPILER: the bundled libraries\' function blocks and functions are read from their manifests');
        const fallback = ld.compilerProvidedNames(path.join(SCRATCH, 'nowhere', 'c.cjs'));
        assert(fallback.has('TON') && fallback.has('CONCAT'), 'COMPILER: without readable manifests the IEC list is the fallback');
        assert(ld.isConversionName('INT_TO_REAL') && ld.isConversionName('TO_DINT') && ld.isConversionName('TRUNC_INT') && !ld.isConversionName('F_TO_X'),
            'COMPILER: conversion functions are the compiler\'s');
    }

    // ── Gathering and declarations, from the synthetic project ─────────────────────────────────
    const project = buildSynthLibProject({ root: SCRATCH });
    const inputs = inputsOf(project);
    const knowledge = ld.gatherLibraryKnowledge({ projectDir: project.projectDir, roots: [project.ws] });
    assert(knowledge.hasSignatures && knowledge.stats.archives === 1 && knowledge.stats.tmcFiles === 1 && knowledge.namespaces.has('synmotion'),
        'GATHER: the dump at the workspace root, the archive, the .tmc and the namespace are read');
    assert(['t_synopaque', 'i_synitf', 'f_synarchiveonly', 'f_synotheronly', 'esynforward', 'csynmax'].every(n => knowledge.knownNames.has(n)),
        'GATHER: names come from the dump (types, interfaces, constants), the archive and the .tmc');
    assert(knowledge.decls.get('f_synotheronly').topLevel === false && knowledge.decls.get('f_synadd').topLevel === true,
        'GATHER: a dump library the project does not reference is not top-level');
    assert(knowledge.decls.get('fb_synaxis').ioComplete === true && knowledge.decls.get('fb_synaxis').methods.length === 1,
        'GATHER: a function block merges the dump\'s parameters (complete) with the .tmc\'s methods');

    const prep = ld.prepareLibraryCheck({ projectDir: project.projectDir, roots: [project.ws], inputs, compilerPath: BUNDLED });
    const text = prep.extraFiles.map(f => f.text).join('\n');
    const fileOf = (head) => prep.extraFiles.find(f => f.text.startsWith(head));
    assert(!!fileOf('FUNCTION F_SynAdd : DINT\nVAR_INPUT\n\tnA : DINT;\n\tnB : DINT;\nEND_VAR\nEND_FUNCTION'), 'DECL: a function with its inputs and return type, no body');
    assert(!!fileOf('FUNCTION F_SynDistance : LREAL\nVAR_INPUT\n\tstFrom : ST_SynPos;\n\tstTo : ST_SynPos;\nEND_VAR\nVAR_OUTPUT\n\tbValid : BOOL;\nEND_VAR'),
        'DECL: a function\'s further output is a VAR_OUTPUT, and a qualified parameter type is stripped');
    const axis = fileOf('FUNCTION_BLOCK FB_SynAxis') || { text: '' };
    assert(/VAR_INPUT\n\tbExecute : BOOL;\n\tfTarget : LREAL;\n\tsAxisName : T_SynName;\nEND_VAR\nVAR_OUTPUT\n\tbDone : BOOL;\n\teState : E_SynState;\nEND_VAR\nVAR_IN_OUT\n\tstPos : ST_SynPos;\nEND_VAR/.test(axis.text) &&
        /METHOD MSynReset : BOOL\nVAR_INPUT\n\tbHard : BOOL;\nEND_VAR\nEND_METHOD/.test(axis.text) && /PROPERTY nSynCount : DINT\nGET\nEND_GET\nEND_PROPERTY/.test(axis.text) &&
        /ACTION ActSynHome\nEND_ACTION/.test(axis.text) && !/nInternal/.test(axis.text),
        'DECL: a function block with its parameters, a method, a property and an action — interface only, no local');
    assert(!!fileOf('TYPE ST_SynPose EXTENDS ST_SynPos :\nSTRUCT\n\tfAngle : LREAL;\nEND_STRUCT\nEND_TYPE'), 'DECL: a struct with EXTENDS');
    assert(!!fileOf('TYPE E_SynState :\n(eSynIdle := 0, eSynMoving := 1, eSynFault := 9) INT;\nEND_TYPE'), 'DECL: an enumeration with values and base type');
    assert(!!fileOf('TYPE E_SynDir :\n(eSynForward, eSynBackward);\nEND_TYPE'), 'DECL: the dump\'s enumeration (a self-typed global list)');
    assert(!!fileOf('TYPE T_SynName : STRING(31);\nEND_TYPE'), 'DECL: an alias');
    const gvlFile = prep.extraFiles.find(f => f.globalListName === 'GVL_SynConst');
    assert(!!gvlFile && gvlFile.text === 'VAR_GLOBAL CONSTANT\n\tcSynMax : DINT := 15;\n\tcSynGain : LREAL := 2.5;\nEND_VAR\nVAR_GLOBAL\n\tsSynBanner : STRING(20);\nEND_VAR\n',
        'DECL: a global list, named by its own name: the dump\'s constants with the .tmc\'s numeric values; a string value is not copied');
    assert(!text.includes(LEAK_MARKER) && !/\(\*|\/\/|'/.test(text), 'DECL: no library comment, documentation or string text in any declaration');
    assert(!/FUNCTION_BLOCK TON|FUNCTION CONCAT/.test(text) && prep.stats.skippedCompiler >= 1, 'CONFLICT: TON and CONCAT are the compiler\'s own — not redeclared');
    assert(!/FB_UserOwnName/.test(text) && prep.stats.skippedUser >= 1, 'CONFLICT: a name the project declares is not redeclared — the user\'s own wins');
    assert(!/F_SynLongTime|F_SynBounded|T_SynOpaque|I_SynItf|F_SynOtherOnly/.test(text) && prep.stats.unresolved >= 2,
        'DECL: an LTIME parameter, a constant array bound, an opaque type, an interface, an unreferenced library — nothing is guessed');
    assert(prep.extraFiles.every(f => /^lib-\d+\.st$/.test(f.name)) && new Set(prep.extraFiles.map(f => f.name)).size === prep.extraFiles.length,
        'DECL: one file per declaration, named so no stem can be a project identifier');

    // Dependencies only: an unreferenced library's type is declared when a declared one needs it.
    {
        const k = { ...knowledge, decls: new Map(knowledge.decls) };
        k.decls.set('fb_synneedsother', { kind: 'fb', name: 'FB_SynNeedsOther', origin: 'sig', topLevel: true, ioComplete: true, io: [{ name: 'stO', type: 'ST_SynOtherOnly', scope: 'VAR_INPUT' }] });
        k.decls.set('st_synotheronly', { kind: 'struct', name: 'ST_SynOtherOnly', origin: 'sig', topLevel: false, members: [{ name: 'n', type: 'INT' }] });
        const set = ld.buildDeclarations(k, { texts: ['x : FB_SynNeedsOther; y : ST_SynOtherOnly;'], userNames: new Set(), compilerNames: ld.compilerProvidedNames(BUNDLED) });
        assert(set.declared.has('fb_synneedsother') && set.declared.has('st_synotheronly'), 'DECL: a type another declaration needs is declared with it');
        const alone = ld.buildDeclarations(k, { texts: ['y : ST_SynOtherOnly;'], userNames: new Set(), compilerNames: new Set() });
        assert(!alone.declared.has('st_synotheronly'), 'DECL: the same type, referenced on its own, is not (its library is not the project\'s)');
        const conflicted = ld.buildDeclarations(k, { texts: ['x : FB_SynNeedsOther;'], userNames: new Set(['st_synotheronly']), compilerNames: new Set() });
        assert(!conflicted.declared.has('fb_synneedsother'), 'CONFLICT: a declaration that needs a type the project redefines is dropped');
        const shadow = ld.buildDeclarations(knowledge, { texts: ['GVL_SynConst'], userNames: new Set(['csyngain']), compilerNames: new Set() });
        const list = shadow.files.find(f => f.globalListName === 'GVL_SynConst');
        assert(!!list && /cSynMax/.test(list.text) && !/cSynGain/.test(list.text), 'CONFLICT: a global the project declares itself is left out of a library list');
    }

    // Many declarations: grouped so the command line stays short; every one still written.
    {
        const decls = new Map();
        const names = [];
        for (let i = 0; i < 700; i++) {
            const name = `ST_SynMany${i}`;
            names.push(name);
            decls.set(name.toLowerCase(), { kind: 'struct', name, origin: 'tmc', topLevel: true, members: [{ name: 'n', type: 'INT' }] });
        }
        const set = ld.buildDeclarations({ ...knowledge, decls }, { texts: [names.join(' ')], userNames: new Set(), compilerNames: new Set() });
        const all = set.files.map(f => f.text).join('\n');
        assert(set.files.length <= ld.MAX_DECLARATION_FILES && set.declared.size === 700 && names.every(n => all.includes(`TYPE ${n} :`)),
            `DECL: 700 declarations go into ${set.files.length} file(s) (at most ${ld.MAX_DECLARATION_FILES}), none lost`);
    }

    // ── Qualifiers ─────────────────────────────────────────────────────────────────────────────
    {
        const ns = new Set(['synmotion', 'tc2_standard']);
        const src = "a : SynMotion.FB_X; b := SynMotion . F_Y(1); c := s.SynMotion.z; (* SynMotion.T *) d := 'SynMotion.Q'; e : Tc2_Standard.TON; f := SynMotion..x;";
        const out = ld.stripQualifiers(src, ns, new Set());
        assert(out.text.length === src.length && out.count === 3, `QUAL: three qualifiers blanked, length kept (${out.count})`);
        assert(out.text.includes('a :           FB_X;') && out.text.includes('b :=             F_Y(1);') && out.text.includes('e :              TON;'),
            'QUAL: `Ns.X` becomes spaces + `X` — every column after it is unchanged');
        assert(out.text.includes('s.SynMotion.z') && out.text.includes('(* SynMotion.T *)') && out.text.includes("'SynMotion.Q'") && out.text.includes('SynMotion..x'),
            'QUAL: a member access, a comment, a string and a range are left alone');
        assert(ld.stripQualifiers(src, ns, new Set(['synmotion'])).text.includes('a : SynMotion.FB_X'), 'QUAL: a head the project declares itself is not a qualifier');
        const main = prep.inputs.find(i => /MAIN/.test(i.filePath));
        const orig = inputs.find(i => /MAIN/.test(i.filePath));
        assert(main.unit !== orig.unit && orig.unit.stText.includes('SynMotion.FB_SynAxis') && !main.unit.stText.includes('SynMotion.') &&
            main.unit.lines.length === orig.unit.lines.length && main.unit.lines.every((l, i) => l.length === orig.unit.lines[i].length),
            'QUAL: the run gets a blanked copy of the unit (same lines, same lengths); the original is unchanged');
    }

    // ── The filter ─────────────────────────────────────────────────────────────────────────────
    {
        const f = ld.createLibraryFilter({
            knownNames: new Set(['f_synadd', 't_synopaque', 'csynmax', 'nsyncount', 'ftarget', 'fb_userownname']),
            userNames: new Set(['fb_userownname']), owners: new Set(['fb_synaxis']), globalLists: new Set(['gvl_synconst']), partialIo: new Set(['fb_synaxis'])
        });
        const e = (message, severity = 'error') => ({ severity, message });
        const cases = [
            [e("Undeclared function 'F_SYNADD'"), true, 'an undeclared library function'],
            [e("Undeclared variable 'CSYNMAX'"), true, 'an undeclared library constant'],
            [e("Undefined type 'T_SYNOPAQUE' in PROGRAM 'P'"), true, 'an undefined library type'],
            [e("The bounds of an ARRAY must be integer constants: 'CSYNMAX' is not a constant"), true, 'a library constant with no value in an array bound'],
            [e("Function block 'FB_SYNAXIS' has no member 'NSYNCOUNT'"), true, 'a known member missing from a library FB declared partially'],
            [e("Function block 'FB_SYNAXIS' has no method 'NSYNCOUNT'"), true, 'a known method missing likewise'],
            [e('FB_SYNAXIS has no input or output named FTARGET'), true, 'a known parameter missing from a .tmc-only parameter list'],
            [e("'CSYNMAX' is not a variable of global variable list 'GVL_SynConst'"), true, 'a known global missing from a library list'],
            [e("Undeclared variable 'NSUMM'"), false, 'a user typo (no library knows the name)'],
            [e("Undeclared function 'F_SYNADDD'"), false, 'a typo of a library function'],
            [e("Undefined type 'FB_USEROWNNAME' in PROGRAM 'P'"), false, 'a name the project declares, even if a library knows it'],
            [e("Undeclared variable 'CSYNMAX'", 'warning'), false, 'a warning'],
            [e("Function block 'FB_SYNAXIS' has no member 'BTYPO'"), false, 'an unknown member of a library FB'],
            [e("Function block 'FB_USER' has no member 'NSYNCOUNT'"), false, 'a member of a type this run did not declare'],
            [e("'CSYNMAX' is not a variable of global variable list 'GVL_User'"), false, 'a global of the user\'s list'],
            [e("Cannot assign ST_B to parameter 'A' of type ST_A"), false, 'a type error']
        ];
        const all = cases.map(c => c[0]);
        const dropped = f.select(all);
        for (const [d, want, label] of cases) assert(dropped.has(d) === want, `FILTER: ${want ? 'drops' : 'keeps'} ${label}`);
        const cascade = e('CASE selector must be an integer, bit, or enum type, got T_SYNOPAQUE');
        assert(f.select([cascade]).size === 0 && f.select([e("Undefined type 'T_SYNOPAQUE' in PROGRAM 'P'"), cascade]).has(cascade),
            'FILTER: a "got X" cascade is dropped only together with the dropped error it follows from');
    }

    // ── Temp-dir lifetime: the declarations live only in the run's temporary directory ──────────
    {
        const tmpRoot = fs.mkdtempSync(path.join(SCRATCH, 'tmproot-'));
        const wsBefore = listTree(project.ws);
        const repoSample = path.join(__dirname, '..', 'sample');
        const sampleBefore = listTree(repoSample);
        /** @type {any} */
        let seen = null;
        const fake = createFakeSpawn((call) => {
            const dir = call.options.cwd;
            seen = { dir, files: fs.readdirSync(dir).sort(), libText: prep.extraFiles.map(x => fs.readFileSync(path.join(dir, x.name), 'utf8')) };
            return { stdout: JSON.stringify({ dialect: 'twincat3', files: [], diagnostics: [
                { file: '1.st', line: 1, column: 1, severity: 'error', message: "Undeclared function 'F_SYNLONGTIME'" },
                { file: 'lib-1.st', line: 1, column: 1, severity: 'error', message: 'a message about a generated declaration' }
            ], summary: {} }), code: 1 };
        });
        const r = await cc.runCheck({ nodeCommand: 'node', compilerPath: BUNDLED, dialectFile: 'd.json', inputs: prep.inputs, extraFiles: prep.extraFiles, libraryFilter: prep.filter, spawn: fake.spawn, tmpRoot });
        assert(!!seen && path.dirname(seen.dir) === tmpRoot && prep.extraFiles.every(x => seen.files.includes(x.name)) &&
            seen.libText.join('') === prep.extraFiles.map(x => x.text).join(''),
            'TEMP: while the compiler runs, the declarations are files inside the run\'s own temporary directory');
        const args = fake.calls[0].args;
        assert(args.indexOf('lib-1.st') > 0 && args.indexOf('lib-1.st') < args.indexOf('1.st') && args.join(' ').includes(`--global-list ${gvlFile && gvlFile.name}=GVL_SynConst`),
            'TEMP: they are passed before the units, a global list under its own name');
        assert(!fs.existsSync(seen.dir) && fs.readdirSync(tmpRoot).length === 0, 'TEMP: after the run the directory and everything in it is gone');
        assert(JSON.stringify(listTree(project.ws)) === JSON.stringify(wsBefore) && JSON.stringify(listTree(repoSample)) === JSON.stringify(sampleBefore),
            'TEMP: nothing was written into the project, the workspace or sample/');
        assert(r.filteredLibraryDiagnostics === 1 && r.errors === 0 && r.libraryMessages.length === 1 && r.general.length === 0,
            'TEMP: a filtered error is counted, a message about a generated declaration is kept apart (not an error on the user\'s code)');
        const failing = createFakeSpawn((call) => { seen = { dir: call.options.cwd }; return { error: 'spawn failed' }; });
        const r2 = await cc.runCheck({ nodeCommand: 'node', compilerPath: BUNDLED, dialectFile: 'd.json', inputs: prep.inputs, extraFiles: prep.extraFiles, spawn: failing.spawn, tmpRoot });
        assert(r2.status === 'failed' && !fs.existsSync(seen.dir) && fs.readdirSync(tmpRoot).length === 0, 'TEMP: a failed run deletes them too');
    }

    // ── No dump: the .tmc and the archive names still give types and the filter ───────────────
    {
        const noDump = buildSynthLibProject({ root: SCRATCH, withDump: false });
        const p = ld.prepareLibraryCheck({ projectDir: noDump.projectDir, roots: [noDump.ws], inputs: inputsOf(noDump), compilerPath: BUNDLED });
        const t = p.extraFiles.map(f => f.text).join('\n');
        assert(!p.hasSignatures && p.referencesLibraries, 'NO DUMP: reported as such, for the one-time hint');
        assert(/TYPE ST_SynPos/.test(t) && /FUNCTION_BLOCK FB_SynAxis/.test(t) && !/FUNCTION F_SynAdd/.test(t), 'NO DUMP: the .tmc\'s types are declared; functions are not (no signatures)');
        const dropped = p.filter.select([{ severity: 'error', message: "Undeclared function 'F_SYNADD'" }, { severity: 'error', message: "Undeclared function 'F_SYNADDD'" }]);
        assert(dropped.size === 1, 'NO DUMP: an archive name is filtered, a typo is not');
        noDump.cleanup();
    }

    // ── The dump parser keeps every function output ───────────────────────────────────────────
    {
        const parsed = parseLibrarySignaturesXml(SIGNATURES);
        const fn = parsed.libraries[0].functions.find(x => x.name === 'F_SynDistance');
        assert(fn.returnType === 'LREAL' && fn.outputs.map(o => o.name).join() === 'F_SynDistance,bValid', 'DUMP: a function keeps all its outputs');
    }

    project.cleanup();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    if (errors > 0) {
        console.error(`\n${errors} library-declaration assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll library-declaration assertions passed.');
})().catch((err) => { console.error(err); process.exit(1); });
