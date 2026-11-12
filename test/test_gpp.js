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
    assert(eq(g.resolveGpp({ configured: 'D:\\nope\\g++.exe', platform: 'win32', env: winEnv, exists }), { ok: false, reason: 'setting-missing', configured: 'D:\\nope\\g++.exe' }),
        'SETTING: a configured path that does not exist is reported, NOT replaced by detection');
    assert(eq(g.resolveGpp({ configured: 'x86_64-w64-mingw32-g++', platform: 'win32', env: winEnv, exists }),
        { ok: true, path: 'C:\\Tools\\bin\\x86_64-w64-mingw32-g++.exe', source: 'setting' }), 'SETTING: a bare command name is looked up on PATH (.exe added on Windows)');
    assert(eq(g.resolveGpp({ configured: '', platform: 'win32', env: winEnv, exists }), { ok: true, path: 'C:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default' }),
        'SETTING: empty = detection');
    assert(eq(g.resolveGpp({ configured: undefined, platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), { ok: false, reason: 'not-found', configured: '' }),
        'SETTING: empty and nothing detected → not-found');

    // ── Command line ──────────────────────────────────────────────────────────────────────────
    const args = g.buildGppArgs({ cppFile: '/p/CPP_Files/P.cpp', objFile: '/p/CPP_Files/P.o', includeDir: '/ext/resources/compiler/include', outDir: '/p/CPP_Files' });
    assert(eq(args, ['-std=c++14', '-fno-strict-aliasing', '-Wno-c++17-extensions', '-fdiagnostics-color=never', '-fmessage-length=0',
        '-c', '/p/CPP_Files/P.cpp', '-I', '/ext/resources/compiler/include', '-I', '/p/CPP_Files', '-o', '/p/CPP_Files/P.o']),
    `ARGS: C++14, compile only (-c), the runtime headers and the output folder on the include path, the object file named (${args.join(' ')})`);
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
    assert(eq(msgs[0], { file: 'C:\\p\\CPP_Files\\P.hpp', line: 175, column: 1, severity: 'warning', message: 'something odd [-Wfoo]', notes: [] }),
        'PARSE: a Windows path with its drive letter, line, column and severity');
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

    if (errors > 0) {
        console.error(`\n${errors} g++ assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll g++ assertions passed.');
})().catch((e) => { console.error(e); process.exit(1); });
