/**
 * @file test_gpp.js
 * @description The optional g++ build of generated C++ (src/gpp.js, roadmap R13) without a real g++:
 * detection over a mocked file system and PATH (Windows and Linux), the path setting (full path,
 * bare command name, missing), the command line, reading g++'s messages (Windows paths, notes,
 * context lines, messages with no position), placing them on the generated files, and running g++
 * through a fake child process (exit codes, a missing executable, the timeout, cancellation).
 * The real g++ run is test/test_cpp_real.js.
 */

'use strict';

const path = require('path');
const g = require('../src/gpp');
const { createFakeSpawn } = require('./_fakeChild');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const existsIn = (list) => (p) => list.some(x => x.toLowerCase() === p.toLowerCase());

(async () => {
    // ── Detection ─────────────────────────────────────────────────────────────────────────────
    const winEnv = { Path: 'C:\\Windows\\system32;"C:\\Tools\\bin";C:\\Users\\me\\bin', ProgramFiles: 'D:\\Programs', ChocolateyInstall: 'E:\\choco' };
    const cands = g.gppCandidates({ platform: 'win32', env: winEnv }).map(c => c.path);
    assert(cands[0] === 'C:\\Windows\\system32\\g++.exe' && cands[1] === 'C:\\Tools\\bin\\g++.exe' && cands[2] === 'C:\\Users\\me\\bin\\g++.exe',
        `WIN: PATH comes first, in order, quoted entries unquoted, g++.exe (${cands.slice(0, 3).join(' | ')})`);
    for (const want of ['C:\\msys64\\ucrt64\\bin\\g++.exe', 'C:\\msys64\\mingw64\\bin\\g++.exe', 'C:\\msys64\\clang64\\bin\\g++.exe', 'C:\\MinGW\\bin\\g++.exe',
        'D:\\Programs\\mingw64\\bin\\g++.exe', 'D:\\Programs\\WinLibs\\mingw64\\bin\\g++.exe', 'D:\\Programs\\w64devkit\\bin\\g++.exe', 'C:\\w64devkit\\bin\\g++.exe',
        'E:\\choco\\lib\\mingw\\tools\\install\\mingw64\\bin\\g++.exe']) {
        assert(cands.includes(want), `WIN: looks in ${want}`);
    }
    assert(g.windowsGppLocations({}).includes('C:\\Program Files\\mingw64\\bin\\g++.exe')
        && g.windowsGppLocations({}).includes('C:\\ProgramData\\chocolatey\\lib\\mingw\\tools\\install\\mingw64\\bin\\g++.exe'),
    'WIN: without the variables, the default Program Files and Chocolatey roots');
    assert(eq(g.detectGpp({ platform: 'win32', env: winEnv, exists: existsIn(['C:\\msys64\\ucrt64\\bin\\g++.exe']) }),
        { path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default' }), 'WIN: MSYS2 ucrt64 is found when PATH has none');
    assert(eq(g.detectGpp({ platform: 'win32', env: winEnv, exists: existsIn(['C:\\msys64\\ucrt64\\bin\\g++.exe', 'c:\\tools\\bin\\G++.EXE']) }),
        { path: 'C:\\Tools\\bin\\g++.exe', source: 'path' }), 'WIN: PATH wins over the install folders');
    assert(g.detectGpp({ platform: 'win32', env: { PATH: 'C:\\x;C:\\x' }, exists: () => false }) === null, 'WIN: nothing found → null');
    assert(g.detectGpp({ platform: 'win32', env: winEnv, exists: () => { throw new Error('EACCES'); } }) === null, 'DETECT: a throwing check counts as absent');
    const linux = g.gppCandidates({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' } }).map(c => c.path);
    assert(eq(linux, ['/usr/local/bin/g++', '/usr/bin/g++']), `LINUX: PATH only, no Windows folders (${linux.join(' ')})`);

    // ── The path setting ──────────────────────────────────────────────────────────────────────
    const exists = existsIn(['C:\\msys64\\ucrt64\\bin\\g++.exe', 'D:\\gcc\\bin\\g++.exe', 'C:\\Tools\\bin\\x86_64-w64-mingw32-g++.exe']);
    assert(eq(g.resolveGpp({ configured: 'D:\\gcc\\bin\\g++.exe', platform: 'win32', env: winEnv, exists }), { ok: true, path: 'D:\\gcc\\bin\\g++.exe', source: 'setting' }),
        'SETTING: a configured existing path is used as is');
    assert(eq(g.resolveGpp({ configured: ' "D:\\gcc\\bin\\g++.exe" ', platform: 'win32', env: winEnv, exists }), { ok: true, path: 'D:\\gcc\\bin\\g++.exe', source: 'setting' }),
        'SETTING: surrounding quotes and spaces are tolerated');
    assert(eq(g.resolveGpp({ configured: 'D:\\nope\\g++.exe', platform: 'win32', env: winEnv, exists }), { ok: false, reason: 'setting-missing', configured: 'D:\\nope\\g++.exe', problem: 'missing' }),
        'SETTING: a configured path that does not exist is reported, NOT replaced by detection');
    const isDir = existsIn(['D:\\gcc\\bin', 'D:\\empty']);
    assert(eq(g.resolveGpp({ configured: 'D:\\gcc\\bin', platform: 'win32', env: winEnv, exists, isDir }), { ok: true, path: 'D:\\gcc\\bin\\g++.exe', source: 'setting' }),
        'SETTING: a folder that holds g++.exe is accepted (its g++.exe is used)');
    assert(eq(g.resolveGpp({ configured: 'D:\\empty', platform: 'win32', env: winEnv, exists, isDir }), { ok: false, reason: 'setting-missing', configured: 'D:\\empty', problem: 'folder' })
        && g.describeGppProblem('folder') === 'that folder has no g++ in it', 'SETTING: a folder without g++ is reported as a folder, not as "does not exist"');
    assert(eq(g.resolveGpp({ configured: 'nope-g++', platform: 'win32', env: winEnv, exists }), { ok: false, reason: 'setting-missing', configured: 'nope-g++', problem: 'not-on-path' })
        && g.describeGppProblem('not-on-path') === 'no such command on PATH', 'SETTING: a bare name PATH does not have says so');
    // One check for the build and for "Detect g++" (src/commands/gppCommands.js): they cannot disagree.
    assert(eq(g.checkConfiguredGpp(' "D:\\gcc\\bin\\g++.exe" ', { platform: 'win32', env: winEnv, exists }), { ok: true, path: 'D:\\gcc\\bin\\g++.exe' })
        && eq(g.checkConfiguredGpp('', { platform: 'win32', env: winEnv, exists }), { ok: false, reason: 'empty', configured: '' }),
    'CHECK: quotes are dropped; empty is its own answer');
    assert(eq(g.resolveGpp({ configured: 'x86_64-w64-mingw32-g++', platform: 'win32', env: winEnv, exists }),
        { ok: true, path: 'C:\\Tools\\bin\\x86_64-w64-mingw32-g++.exe', source: 'setting' }), 'SETTING: a bare command name is looked up on PATH (.exe added on Windows)');
    assert(eq(g.resolveGpp({ configured: '', platform: 'win32', env: winEnv, exists }), { ok: true, path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default' }),
        'SETTING: empty = detection');
    assert(eq(g.resolveGpp({ configured: undefined, platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), { ok: false, reason: 'not-found', configured: '' }),
        'SETTING: empty and nothing detected → not-found');

    // ── What the start page shows (describeGppSetting): never writes, same check as the build ─────
    const d = (v, more) => g.describeGppSetting(v, Object.assign({ platform: 'win32', env: winEnv, exists, isDir }, more));
    assert(eq(d(' "D:\\gcc\\bin\\g++.exe" '), { state: 'set', configured: 'D:\\gcc\\bin\\g++.exe', path: 'D:\\gcc\\bin\\g++.exe' }),
        'START: a set, existing path is shown as set (quotes dropped)');
    assert(eq(d('x86_64-w64-mingw32-g++'), { state: 'set', configured: 'x86_64-w64-mingw32-g++', path: 'C:\\Tools\\bin\\x86_64-w64-mingw32-g++.exe' }),
        'START: a bare name is shown as set, with the g++ it runs');
    assert(eq(d('D:\\nope\\g++.exe'), { state: 'invalid', configured: 'D:\\nope\\g++.exe', path: '', problem: 'missing' })
        && eq(d('D:\\empty'), { state: 'invalid', configured: 'D:\\empty', path: '', problem: 'folder' })
        && eq(d('nope-g++'), { state: 'invalid', configured: 'nope-g++', path: '', problem: 'not-on-path' }),
    'START: an unusable set value is invalid with checkConfiguredGpp\'s reason, and is NOT replaced by detection');
    assert(eq(d(''), { state: 'detected', configured: '', path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default' })
        && eq(d(undefined, { exists: existsIn(['C:\\Tools\\bin\\g++.exe']) }), { state: 'detected', configured: '', path: 'C:\\Tools\\bin\\g++.exe', source: 'path' }),
    'START: empty → what detection would use, and where it was found');
    assert(eq(d('', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), { state: 'notFound', configured: '', path: '' }),
        'START: empty and nothing found → notFound');
    const real = g.thisMachine();
    assert(real.platform === process.platform && real.exists(__filename) === true && real.exists(__dirname) === false && real.isDir(__dirname) === true
        && real.exists(path.join(__dirname, 'no-such-file')) === false, 'MACHINE: thisMachine checks files and folders on disk');

    // ── The g++ version (g++ 7+: the generated C++ uses C++17 inline variables) ───────────────
    assert(eq(g.parseGppVersion('13.3.0\n'), { version: '13.3.0', major: 13 }) && eq(g.parseGppVersion('6.3.0'), { version: '6.3.0', major: 6 })
        && eq(g.parseGppVersion('7'), { version: '7', major: 7 }) && eq(g.parseGppVersion('12.2.0-win32'), { version: '12.2.0', major: 12 })
        && g.parseGppVersion('') === null && g.parseGppVersion('gcc version x') === null && g.parseGppVersion(undefined) === null,
    'VERSION: -dumpfullversion/-dumpversion output is read; anything else is unknown');
    assert(g.GPP_MIN_MAJOR === 7 && g.isGppTooOld({ version: '6.3.0', major: 6 }) && !g.isGppTooOld({ version: '7.1.0', major: 7 }) && !g.isGppTooOld(null),
        'VERSION: below 7 is too old; unknown is not');
    assert(g.gppTooOldText('6.3.0') === 'g++ 6.3.0 is too old: the generated C++ needs g++ 7 or later.'
        && /MinGW-w64/.test(g.gppInstallHint('win32')) && /MSYS2's UCRT64/.test(g.gppInstallHint('win32')) && !/MSYS2/.test(g.gppInstallHint('linux'))
        && /run "Detect g\+\+"/.test(g.gppInstallHint('win32')) && !/Detect g\+\+/.test(g.gppInstallHint('win32', { fromSetting: true }))
        && /clear that setting/.test(g.gppInstallHint('linux', { fromSetting: true })) && /tcToolkit\.compiler\.gppPath/.test(g.gppInstallHint('win32', { fromSetting: true })),
    'VERSION: the warning text, and the MSYS2 UCRT64 hint on Windows');
    // A fake g++: answers per flag, records what it was asked.
    const fakeRun = (answers) => { const asked = []; return { asked, run: (file, a) => { asked.push(a[0]); const r = answers[a[0]]; if (r instanceof Error) throw r; return r || { status: 1, stdout: '' }; } }; };
    let fr = fakeRun({ '-dumpfullversion': { status: 0, stdout: '13.3.0\n' } });
    assert(eq(g.queryGppVersion('g++', fr.run), { version: '13.3.0', major: 13 }) && eq(fr.asked, ['-dumpfullversion']), 'VERSION: g++ 7+ answers -dumpfullversion');
    fr = fakeRun({ '-dumpfullversion': { status: 1, stdout: '' }, '-dumpversion': { status: 0, stdout: '6.3.0\n' }, '--version': { status: 0, stdout: 'g++.exe (MinGW.org GCC-6.3.0-1) 6.3.0\n' } });
    assert(eq(g.queryGppVersion('g++', fr.run), { version: '6.3.0', major: 6 }) && eq(fr.asked, ['-dumpfullversion', '-dumpversion', '--version']),
        'VERSION: g++ 6 rejects -dumpfullversion; -dumpversion gives 6.3.0, confirmed by --version');
    fr = fakeRun({ '-dumpversion': { status: 0, stdout: '4.2.1\n' }, '--version': { status: 0, stdout: 'Apple clang version 15.0.0\n' } });
    assert(g.queryGppVersion('g++', fr.run) === null, 'VERSION: clang pretending to be GCC 4.2.1 is unknown (the build runs)');
    assert(g.queryGppVersion('g++', fakeRun({ '-dumpfullversion': new Error('ENOENT'), '-dumpversion': new Error('ENOENT') }).run) === null
        && g.queryGppVersion('g++', fakeRun({ '-dumpfullversion': { status: 0, stdout: 'garbage' } }).run) === null, 'VERSION: a g++ that cannot be asked, or answers nonsense, is unknown');
    let stat = { size: 10, mtimeMs: 1 };
    fr = fakeRun({ '-dumpfullversion': { status: 0, stdout: '13.3.0' } });
    const cacheDeps = { run: fr.run, stat: () => stat };
    const cachedPath = path.join(__dirname, 'fake-gpp-for-cache');
    g.gppVersionOf(cachedPath, cacheDeps); g.gppVersionOf(cachedPath, cacheDeps);
    assert(fr.asked.length === 1, 'VERSION: cached per path, size and mtime (asked once for two reads)');
    stat = { size: 10, mtimeMs: 2 };
    g.gppVersionOf(cachedPath, cacheDeps);
    assert(fr.asked.length === 2, 'VERSION: a g++ replaced in place (new mtime) is asked again');
    assert(g.gppVersionOf(cachedPath, { run: fr.run, stat: () => { throw new Error('ENOENT'); } }) === null && fr.asked.length === 2,
        'VERSION: a path that cannot be read is unknown, and g++ is not run');
    assert(typeof g.thisMachine().version === 'function', 'VERSION: thisMachine carries the real version reader');

    // Detection prefers a g++ 7+; an older one only when nothing newer exists.
    const versions = { 'C:\\MinGW\\bin\\g++.exe': { version: '6.3.0', major: 6 }, 'C:\\msys64\\ucrt64\\bin\\g++.exe': { version: '13.2.0', major: 13 } };
    const verOf = (p) => versions[p] || null;
    const both = existsIn(['C:\\MinGW\\bin\\g++.exe', 'C:\\msys64\\ucrt64\\bin\\g++.exe']);
    const oldOnPath = { Path: 'C:\\MinGW\\bin' };
    assert(eq(g.detectGpp({ platform: 'win32', env: oldOnPath, exists: both, version: verOf }), { path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default', version: '13.2.0' }),
        'DETECT: an old MinGW g++ 6 first on PATH loses to MSYS2 g++ 13 in its install folder');
    assert(eq(g.detectGpp({ platform: 'win32', env: oldOnPath, exists: existsIn(['C:\\MinGW\\bin\\g++.exe']), version: verOf }), { path: 'C:\\MinGW\\bin\\g++.exe', source: 'path', version: '6.3.0', tooOld: true }),
        'DETECT: only a g++ 6 exists → it is used, marked tooOld');
    assert(eq(g.detectGpp({ platform: 'win32', env: oldOnPath, exists: existsIn(['C:\\MinGW\\bin\\g++.exe', 'C:\\Tools\\x\\g++.exe']), version: () => { throw new Error('x'); } }),
        { path: 'C:\\MinGW\\bin\\g++.exe', source: 'path' }), 'DETECT: a version reader that throws counts as unknown (first candidate, no version)');
    assert(eq(g.resolveGpp({ configured: 'C:\\MinGW\\bin\\g++.exe', platform: 'win32', env: oldOnPath, exists: both, version: verOf }),
        { ok: true, path: 'C:\\MinGW\\bin\\g++.exe', source: 'setting', version: '6.3.0', tooOld: true }), 'SETTING: a set g++ 6 is kept, and marked tooOld (never replaced)');
    assert(eq(g.resolveGpp({ configured: '', platform: 'win32', env: oldOnPath, exists: both, version: verOf }),
        { ok: true, path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default', version: '13.2.0' }), 'SETTING: empty → the newer detected g++');
    const dv = (v, ex) => g.describeGppSetting(v, { platform: 'win32', env: oldOnPath, exists: ex || both, version: verOf });
    assert(eq(dv('C:\\MinGW\\bin\\g++.exe'), { state: 'set', configured: 'C:\\MinGW\\bin\\g++.exe', path: 'C:\\MinGW\\bin\\g++.exe', version: '6.3.0', tooOld: true })
        && eq(dv(''), { state: 'detected', configured: '', path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default', version: '13.2.0' })
        && eq(dv('', existsIn(['C:\\MinGW\\bin\\g++.exe'])), { state: 'detected', configured: '', path: 'C:\\MinGW\\bin\\g++.exe', source: 'path', version: '6.3.0', tooOld: true }),
    'START: a set or detected g++ 6 is tooOld; with a newer one present, detection shows the newer one');

    // ── Command line ──────────────────────────────────────────────────────────────────────────
    const args = g.buildGppArgs({ cppFile: '/p/CPP_Files/P.cpp', objFile: '/p/CPP_Files/P.o', includeDir: '/ext/resources/compiler/include', outDir: '/p/CPP_Files' });
    assert(eq(args, ['-std=c++17', '-fno-strict-aliasing', '-fdiagnostics-color=never', '-fmessage-length=0',
        '-c', '/p/CPP_Files/P.cpp', '-I', '/ext/resources/compiler/include', '-I', '/p/CPP_Files', '-o', '/p/CPP_Files/P.o']),
    `ARGS: C++17 (inline variables), no -Wno-c++17-extensions (GCC 12+ only), compile only (-c), the runtime headers and the output folder on the include path, the object file named (${args.join(' ')})`);
    assert(!args.some(a => /^-l|^-L|\.exe$/.test(a)) && !args.includes('-shared'), 'ARGS: nothing is linked');

    // ── Reading g++'s messages ────────────────────────────────────────────────────────────────
    const out = [
        'In file included from C:\\p\\CPP_Files\\P.cpp:4:',
        'C:\\p\\CPP_Files\\P.hpp:175:1: warning: something odd [-Wfoo]',
        '  175 | inline IEC_BOOL X{};',
        '      | ^~~~~~',
        'C:\\p\\CPP_Files\\P.cpp: In member function \'virtual void strucpp::Program_MAIN::run()\':',
        'C:\\p\\CPP_Files\\P.cpp:49:26: error: \'class FB_STATION\' has no member named \'STATE\'; did you mean \'_ESTATE\'?',
        '   49 |     BENABLE = (FBSTATION.STATE == E_STATIONSTATE::RUNNING);',
        'C:\\p\\CPP_Files\\P.hpp:80:5: note: \'_ESTATE\' declared here',
        'C:\\ext\\include\\iec_var.hpp:12: error: no column here',
        'cc1plus: fatal error: P.cpp: No such file or directory',
        'compilation terminated.'
    ].join('\r\n');
    const msgs = g.parseGppOutput(out);
    assert(msgs.length === 4, `PARSE: two errors, one warning, one positionless fatal error (context, excerpts and carets skipped) (${msgs.length})`);
    assert(eq(msgs[0], { file: 'C:\\p\\CPP_Files\\P.hpp', line: 175, column: 1, severity: 'warning', message: 'something odd [-Wfoo]', notes: [],
        context: [{ file: 'C:\\p\\CPP_Files\\P.cpp', line: 4, column: 0, kind: 'include' }] }),
    'PARSE: a Windows path with its drive letter, line, column and severity; the include chain before it is its context');
    assert(msgs[1].file === 'C:\\p\\CPP_Files\\P.cpp' && msgs[1].line === 49 && msgs[1].column === 26 && msgs[1].severity === 'error'
        && /has no member named 'STATE'/.test(msgs[1].message) && msgs[1].notes.length === 1 && msgs[1].notes[0].line === 80,
    'PARSE: the note after an error stays with it');
    assert(msgs[2].line === 12 && msgs[2].column === 0, 'PARSE: a message with a line and no column');
    assert(msgs[3].file === null && msgs[3].severity === 'error' && /No such file/.test(msgs[3].message), 'PARSE: `cc1plus: fatal error:` names no file');
    assert(g.parseGppOutput('/p/CPP_Files/P.cpp:3:7: error: x\n').length === 1, 'PARSE: a POSIX path');

    // ── Placing them on the generated files ───────────────────────────────────────────────────
    const placed = g.placeGppMessages(msgs, { cwd: 'C:\\p\\CPP_Files', cppFile: 'C:\\p\\CPP_Files\\P.cpp', hppFile: 'C:\\p\\CPP_Files\\P.hpp', platform: 'win32' });
    assert(placed[0].filePath === 'C:\\p\\CPP_Files\\P.hpp' && placed[0].line === 175 && placed[0].column === 1, 'PLACE: a message in the .hpp stays on the .hpp');
    assert(placed[1].filePath === 'C:\\p\\CPP_Files\\P.cpp' && placed[1].line === 49 && placed[1].column === 26 && placed[1].notes[0].filePath === 'C:\\p\\CPP_Files\\P.hpp',
        'PLACE: a message in the .cpp stays at its line and column; its note points at the .hpp');
    assert(placed[2].filePath === 'C:\\p\\CPP_Files\\P.cpp' && placed[2].line === 1 && placed[2].message === 'no column here (in iec_var.hpp:12)',
        `PLACE: a message in a runtime header goes on the .cpp's first line and names the header (${placed[2].message})`);
    assert(placed[3].filePath === 'C:\\p\\CPP_Files\\P.cpp' && placed[3].line === 1, 'PLACE: a message with no file goes on the .cpp');
    const rel = g.placeGppMessages(g.parseGppOutput('p.CPP:2:3: error: y'), { cwd: 'C:\\p\\CPP_Files', cppFile: 'C:\\p\\CPP_Files\\P.cpp', hppFile: 'C:\\p\\CPP_Files\\P.hpp', platform: 'win32' });
    assert(rel[0].filePath === 'C:\\p\\CPP_Files\\P.cpp' && rel[0].line === 2, 'PLACE: a relative path resolves against where g++ ran (case-insensitively on Windows)');
    const posix = g.placeGppMessages(g.parseGppOutput('/p/CPP_Files/P.cpp:9:1: error: z'), { cwd: '/p/CPP_Files', cppFile: '/p/CPP_Files/P.cpp', hppFile: '/p/CPP_Files/P.hpp', platform: 'linux' });
    assert(posix[0].filePath === '/p/CPP_Files/P.cpp' && posix[0].line === 9, 'PLACE: POSIX paths');

    // A real g++ 13.3 run: an error raised inside a runtime header while instantiating a template for
    // the generated .cpp, with the include chain printed first (captured; paths shortened).
    const inst = [
        'In file included from /ext/include/w.hpp:1,',
        '                 from /p/CPP_Files/P.hpp:2,',
        '                 from /p/CPP_Files/P.cpp:1:',
        "/ext/include/h.hpp: In instantiation of 'void f(T) [with T = A]':",
        "/ext/include/h.hpp:2:38:   required from 'void g(T) [with T = A]'",
        '/p/CPP_Files/P.cpp:4:4:   required from here',
        "/ext/include/h.hpp:1:39: error: 'struct A' has no member named 'nope'",
        '    1 | template <typename T> void f(T t) { t.nope(); }',
        '      |                                     ~~^~~~',
        "/ext/include/h.hpp:1:41: error: second error in the same header, no chain repeated",
        "/ext/include/other.hpp:7:1: error: a header with no chain at all"
    ].join('\n');
    const instMsgs = g.parseGppOutput(inst);
    assert(instMsgs.length === 3 && instMsgs[0].instantiation === "'void f(T) [with T = A]'"
        && eq(instMsgs[0].context.map(c => `${c.kind}:${path.basename(c.file)}:${c.line}`), ['required:h.hpp:2', 'required:P.cpp:4', 'include:w.hpp:1', 'include:P.hpp:2', 'include:P.cpp:1']),
    `PARSE: the instantiation chain (required from) and the include chain are kept as context (${JSON.stringify(instMsgs[0].context)})`);
    const instPlaced = g.placeGppMessages(instMsgs, { cwd: '/p/CPP_Files', cppFile: '/p/CPP_Files/P.cpp', hppFile: '/p/CPP_Files/P.hpp', platform: 'linux' });
    assert(instPlaced[0].filePath === '/p/CPP_Files/P.cpp' && instPlaced[0].line === 4 && instPlaced[0].column === 4
        && instPlaced[0].message === "'struct A' has no member named 'nope' (in h.hpp:1, in instantiation of 'void f(T) [with T = A]')",
    `PLACE: an error in a runtime header goes on the generated line g++ names as "required from here", and keeps the header and the instantiation (${JSON.stringify(instPlaced[0])})`);
    assert(instPlaced[1].filePath === '/p/CPP_Files/P.hpp' && instPlaced[1].line === 2,
        `PLACE: a later error in the same header, with no instantiation chain, goes on the generated #include of it (${instPlaced[1].filePath}:${instPlaced[1].line})`);
    assert(instPlaced[2].filePath === '/p/CPP_Files/P.cpp' && instPlaced[2].line === 1 && /\(in other\.hpp:7\)$/.test(instPlaced[2].message),
        'PLACE: with no context into the generated files, the .cpp\'s first line');

    // ── Summary ───────────────────────────────────────────────────────────────────────────────
    assert(g.summarizeGpp({ exitCode: 0, messages: [] }) === 'g++ compiled it without errors.', 'SUMMARY: clean');
    assert(g.summarizeGpp({ exitCode: 0, messages: [{ severity: 'warning' }] }) === 'g++ compiled it, 1 warning.', 'SUMMARY: warnings');
    assert(g.summarizeGpp({ exitCode: 1, messages: [{ severity: 'error' }, { severity: 'error' }, { severity: 'warning' }] }) === 'g++: 2 errors, 1 warning.', 'SUMMARY: errors');
    assert(g.summarizeGpp({ exitCode: 4, messages: [] }) === 'g++ failed (exit code 4).', 'SUMMARY: a failure with no readable message');

    // ── Running it (fake child process) ───────────────────────────────────────────────────────
    let answer = { code: 0 };
    const fake = createFakeSpawn(() => answer);
    let r = await g.runGpp({ gppPath: '/opt/gcc/bin/g++', args: ['-c', 'a.cpp'], cwd: '/p', spawn: fake.spawn, env: { PATH: '/usr/bin' } });
    const call = fake.calls[0];
    assert(r.status === 'done' && r.exitCode === 0 && call.command === '/opt/gcc/bin/g++' && eq(call.args, ['-c', 'a.cpp']) && call.options.cwd === '/p'
        && call.options.shell === false, 'RUN: g++ is started directly (no shell) with the arguments, in the output folder');
    assert(call.options.env.PATH.split(path.delimiter)[0] === '/opt/gcc/bin', "RUN: g++'s own folder goes first on PATH (MinGW finds its DLLs there)");
    answer = { code: 1, stderr: 'P.cpp:3:1: error: bad\n' };
    r = await g.runGpp({ gppPath: 'g++', args: [], cwd: '/p', spawn: fake.spawn });
    assert(r.status === 'done' && r.exitCode === 1 && r.messages.length === 1 && r.output.includes('error: bad'), 'RUN: a failed compile is done with exit code 1 and its messages');
    answer = { error: 'spawn g++ ENOENT' };
    r = await g.runGpp({ gppPath: 'g++', args: [], cwd: '/p', spawn: fake.spawn });
    assert(r.status === 'failed' && /could not be started/.test(r.message), 'RUN: a missing executable is a failure with a reason');
    answer = { hang: true };
    r = await g.runGpp({ gppPath: 'g++', args: [], cwd: '/p', spawn: fake.spawn, timeoutMs: 30 });
    assert(r.status === 'timeout' && fake.calls[fake.calls.length - 1].killed, 'RUN: a hung g++ is stopped at the timeout');
    let cancel = null;
    const pending = g.runGpp({ gppPath: 'g++', args: [], cwd: '/p', spawn: fake.spawn, onCancel: (c) => { cancel = c; } });
    setTimeout(() => cancel(), 10);
    r = await pending;
    assert(r.status === 'cancelled' && fake.calls[fake.calls.length - 1].killed, 'RUN: cancelling stops g++');

    // ── Stopping the whole process tree (g++ runs cc1plus and as) ─────────────────────────────
    const { killProcessTree, runChild } = require('../src/compileCheck');
    const sig = [];
    let killedChild = false;
    const child = { pid: 4242, kill: () => { killedChild = true; } };
    assert(killProcessTree(child, { platform: 'linux', processKill: (pid, s) => sig.push([pid, s]) }) === 'tree' && eq(sig, [[-4242, 'SIGTERM']]) && !killedChild,
        'TREE: on POSIX the child\'s process group gets SIGTERM');
    const execs = [];
    assert(killProcessTree(child, { platform: 'win32', execFile: (f, a, o, cb) => { execs.push([f, ...a]); cb(null); } }) === 'tree'
        && eq(execs, [['taskkill', '/PID', '4242', '/T', '/F']]), 'TREE: on Windows taskkill /T /F ends the tree');
    killedChild = false;
    killProcessTree(child, { platform: 'win32', execFile: (f, a, o, cb) => cb(new Error('no taskkill')) });
    assert(killedChild, 'TREE: when taskkill fails, the child alone is killed');
    killedChild = false;
    assert(killProcessTree(child, { platform: 'linux', processKill: () => { throw new Error('ESRCH'); } }) === 'child' && killedChild,
        'TREE: no such group → the child alone');
    killedChild = false;
    assert(killProcessTree({ kill: () => { killedChild = true; } }, { platform: 'linux' }) === 'child' && killedChild, 'TREE: no pid → the child alone');
    if (process.platform !== 'win32') {
        // Real processes: a shell that starts a grandchild, stopped at the timeout — the grandchild must go too.
        const os = require('os');
        const fsx = require('fs');
        const marker = path.join(fsx.mkdtempSync(path.join(os.tmpdir(), 'tc_tree_')), 'grandchild.pid');
        const t = await runChild(require('child_process').spawn, 'sh', ['-c', `sleep 30 & echo $! > "${marker}"; wait`], { timeoutMs: 400, killTree: true });
        await new Promise(res => setTimeout(res, 200));
        const gpid = Number(fsx.readFileSync(marker, 'utf8').trim());
        let alive = true;
        try { process.kill(gpid, 0); } catch (e) { alive = false; }
        // A killed process the container's init does not reap stays a zombie: it is not running.
        try { if (alive && /^\d+ \(.*\) Z/.test(fsx.readFileSync(`/proc/${gpid}/stat`, 'utf8'))) alive = false; } catch (e) { /* no /proc */ }
        if (alive) { try { process.kill(gpid, 'SIGKILL'); } catch (e) { /* gone */ } }
        assert(t.outcome === 'timeout' && gpid > 0 && !alive, `TREE: a real timed-out run leaves no grandchild running (pid ${gpid}, alive ${alive})`);
        fsx.rmSync(path.dirname(marker), { recursive: true, force: true });
    }

    if (errors > 0) {
        console.error(`\n${errors} g++ assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll g++ assertions passed.');
})().catch((e) => { console.error(e); process.exit(1); });
