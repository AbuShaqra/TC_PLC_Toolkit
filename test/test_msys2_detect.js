/**
 * @file test_msys2_detect.js
 * @description MSYS2 discovery for g++ detection (src/msys2Detect.js, R13) with a faked reg.exe and
 * file system: the uninstall-registry search (English and German reg.exe output, HKCU/HKLM and
 * WOW6432Node, InstallLocation and the UninstallString fallback, REG_EXPAND_SZ), the usual roots
 * (C:\msys64, D:\msys64, Chocolatey, the user profile, Scoop), the candidate order g++ detection
 * uses (src/gpp.js), an MSYS2 without its gcc package, and the once-per-session cache (never on
 * Linux, never rejecting, bounded wait).
 */

'use strict';

const m = require('../src/msys2Detect');
const g = require('../src/gpp');
const { createRegRunner } = require('../src/xaeShellDetect');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const existsIn = (list) => (p) => list.some(x => x.toLowerCase() === p.toLowerCase());
const UN = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const HKCU = `HKEY_CURRENT_USER\\${UN}`;
const HKLM = `HKEY_LOCAL_MACHINE\\${UN}`;
const HKLM32 = `HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;

/** reg.exe's search output (`/s /f MSYS2 /d`) for some entries, in English or German. */
function searchOut(entries, lang = 'en') {
    const body = entries.map(([key, name]) => `\r\n${key}\r\n    DisplayName    REG_SZ    ${name}\r\n`).join('');
    const end = lang === 'de' ? `Suche beendet: ${entries.length} Übereinstimmung(en) gefunden.` : `End of search: ${entries.length} match(es) found.`;
    return `${body}\r\n${end}\r\n`;
}
/** reg.exe's output for one whole key. */
function keyOut(key, values) {
    return `\r\n${key}\r\n` + Object.entries(values).map(([n, [t, v]]) => `    ${n}    ${t}    ${v}`).join('\r\n') + '\r\n\r\n';
}

/**
 * A fake reg.exe: `searches` maps an uninstall key (as passed, HKCU\…) to its search output, `keys` maps
 * an entry key to its full output. Records every call.
 */
function fakeReg({ searches = {}, keys = {} }) {
    const calls = [];
    const run = async (args) => {
        calls.push(args);
        if (args.includes('/f')) return Object.prototype.hasOwnProperty.call(searches, args[1]) ? searches[args[1]] : null;
        return Object.prototype.hasOwnProperty.call(keys, args[1]) ? keys[args[1]] : null;
    };
    return { run, calls };
}

(async () => {
    // ── Parsing reg.exe output: anchored on HKEY_ and REG_SZ, never on localized words ──────────
    const parsed = m.parseRegKeys(searchOut([[`${HKCU}\\{abc}`, 'MSYS2'], [`${HKLM}\\Other`, 'Not MSYS2 related']], 'de'));
    assert(parsed.length === 2 && parsed[0].key === `${HKCU}\\{abc}` && parsed[0].values.DisplayName === 'MSYS2' && parsed[1].values.DisplayName === 'Not MSYS2 related',
        `PARSE: German search output gives each key and its DisplayName (${JSON.stringify(parsed)})`);
    const full = m.parseRegKeys(keyOut(`${HKCU}\\{abc}`, {
        DisplayName: ['REG_SZ', 'MSYS2 64bit'], InstallLocation: ['REG_SZ', 'E:\\Dev\\msys64'], EstimatedSize: ['REG_DWORD', '0x1'], Empty: ['REG_SZ', '']
    }));
    assert(full.length === 1 && full[0].values.InstallLocation === 'E:\\Dev\\msys64' && !('EstimatedSize' in full[0].values) && full[0].values.Empty === '',
        `PARSE: string values are read, a DWORD is not, an empty string stays empty (${JSON.stringify(full)})`);
    assert(eq(m.parseRegKeys(null), []) && eq(m.parseRegKeys('ERROR: The system was unable to find the specified registry key or value.'), []),
        'PARSE: no output, or an error text, gives no keys');

    // ── The registry search ───────────────────────────────────────────────────────────────────
    let reg = fakeReg({
        searches: {
            [m.UNINSTALL_KEYS[0]]: searchOut([[`${HKCU}\\{a1}`, 'MSYS2'], [`${HKCU}\\{zz}`, 'Some tool (needs MSYS2)']]),
            [m.UNINSTALL_KEYS[2]]: searchOut([[`${HKLM}\\{b2}`, 'MSYS2 64bit']], 'de'),
            [m.UNINSTALL_KEYS[3]]: searchOut([[`${HKLM32}\\{c3}`, 'msys2 32bit']])
        },
        keys: {
            [`${HKCU}\\{a1}`]: keyOut(`${HKCU}\\{a1}`, { DisplayName: ['REG_SZ', 'MSYS2'], InstallLocation: ['REG_SZ', 'E:\\Dev\\msys64\\'] }),
            [`${HKLM}\\{b2}`]: keyOut(`${HKLM}\\{b2}`, { DisplayName: ['REG_SZ', 'MSYS2 64bit'], UninstallString: ['REG_SZ', '"F:\\Apps\\MSYS2\\uninstall.exe" --uninstall'] }),
            [`${HKLM32}\\{c3}`]: keyOut(`${HKLM32}\\{c3}`, { DisplayName: ['REG_SZ', 'msys2 32bit'], InstallLocation: ['REG_EXPAND_SZ', '%SystemDrive%\\msys32'] })
        }
    });
    let roots = await m.findMsys2RootsInRegistry(reg.run, { SystemDrive: 'C:' });
    assert(eq(roots, ['E:\\Dev\\msys64', 'F:\\Apps\\MSYS2', 'C:\\msys32']),
        `REGISTRY: HKCU, HKLM and WOW6432Node entries named MSYS2*, from InstallLocation, the UninstallString folder and an expanded REG_EXPAND_SZ (${roots.join(' | ')})`);
    assert(reg.calls.filter(a => a.includes('/f')).length === 4 && m.UNINSTALL_KEYS.every(k => reg.calls.some(a => a[1] === k && eq(a.slice(2), ['/s', '/f', 'MSYS2', '/d']))),
        'REGISTRY: every uninstall key (HKCU, HKLM, both WOW6432Node views) is searched for MSYS2 in the data');
    assert(!reg.calls.some(a => a[1] === `${HKCU}\\{zz}`), 'REGISTRY: an entry whose DisplayName only mentions MSYS2 is not read');
    reg = fakeReg({
        searches: { [m.UNINSTALL_KEYS[0]]: searchOut([[`${HKCU}\\{a1}`, 'MSYS2']]), [m.UNINSTALL_KEYS[2]]: searchOut([[`${HKCU}\\{a1}`, 'MSYS2']]) },
        keys: { [`${HKCU}\\{a1}`]: keyOut(`${HKCU}\\{a1}`, { DisplayName: ['REG_SZ', 'MSYS2'], InstallLocation: ['REG_SZ', 'C:\\msys64'] }) }
    });
    roots = await m.findMsys2RootsInRegistry(reg.run);
    assert(eq(roots, ['C:\\msys64']) && reg.calls.filter(a => !a.includes('/f')).length === 1, 'REGISTRY: one entry found twice is read once');
    roots = await m.findMsys2RootsInRegistry(async () => { throw new Error('reg.exe missing'); });
    assert(eq(roots, []), 'REGISTRY: a reg.exe that fails gives no roots, and does not reject');
    roots = await m.findMsys2RootsInRegistry(fakeReg({
        searches: { [m.UNINSTALL_KEYS[0]]: searchOut([[`${HKCU}\\{a1}`, 'MSYS2']]) },
        keys: { [`${HKCU}\\{a1}`]: keyOut(`${HKCU}\\{a1}`, { DisplayName: ['REG_SZ', 'MSYS2'] }) }
    }).run);
    assert(eq(roots, []), 'REGISTRY: an entry with neither InstallLocation nor UninstallString gives no root');

    // The real runner: reg.exe with an argument array, no shell, a timeout, never rejecting.
    const execCalls = [];
    const runner = createRegRunner((file, args, options, cb) => { execCalls.push({ file, args, options }); cb(null, 'out'); });
    assert((await runner(['query', 'HKCU\\X', '/s'])) === 'out' && execCalls[0].file === 'reg.exe' && eq(execCalls[0].args, ['query', 'HKCU\\X', '/s'])
        && execCalls[0].options.timeout > 0 && !execCalls[0].options.shell, 'RUNNER: reg.exe, arguments as an array, a timeout, no shell');
    assert((await createRegRunner((f, a, o, cb) => cb(new Error('exit 1')))(['x'])) === null
        && (await createRegRunner(() => { throw new Error('spawn'); })(['x'])) === null, 'RUNNER: an error or a throw resolves null');

    // ── The usual roots ──────────────────────────────────────────────────────────────────────
    const env = { USERPROFILE: 'C:\\Users\\me', Path: '' };
    assert(eq(m.msys2CommonRoots(env), ['C:\\msys64', 'D:\\msys64', 'C:\\tools\\msys64', 'C:\\Users\\me\\msys64', 'C:\\Users\\me\\scoop\\apps\\msys2\\current']),
        `ROOTS: C:\\msys64, D:\\msys64, Chocolatey's C:\\tools, the profile, Scoop (${m.msys2CommonRoots(env).join(' | ')})`);
    assert(eq(m.msys2CommonRoots({}), ['C:\\msys64', 'D:\\msys64', 'C:\\tools\\msys64']), 'ROOTS: no USERPROFILE → no profile or Scoop roots');
    assert(m.msys2CommonRoots({ userprofile: 'C:\\Users\\me', ChocolateyToolsLocation: 'T:\\tools\\', SCOOP: 'S:\\scoop' }).join('|')
        === 'C:\\msys64|D:\\msys64|T:\\tools\\msys64|C:\\tools\\msys64|C:\\Users\\me\\msys64|S:\\scoop\\apps\\msys2\\current|C:\\Users\\me\\scoop\\apps\\msys2\\current',
    'ROOTS: case-blind variables; ChocolateyToolsLocation and SCOOP are honoured');
    assert(eq(m.msys2Roots({ env, msys2Roots: ['c:\\MSYS64\\', 'E:\\Dev\\msys64'] }).slice(0, 3), ['c:\\MSYS64', 'E:\\Dev\\msys64', 'D:\\msys64']),
        'ROOTS: registry roots first; a usual root the registry already named is not repeated (case-blind)');

    // ── The order g++ detection looks in (src/gpp.js) ────────────────────────────────────────
    const cands = g.gppCandidates({ platform: 'win32', env: { Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\me' }, msys2Roots: ['E:\\Dev\\msys64'] }).map(c => c.path);
    const at = (p) => cands.findIndex(c => c.toLowerCase() === p.toLowerCase());
    assert(at('C:\\bin\\g++.exe') === 0, 'ORDER: PATH first');
    assert(at('E:\\Dev\\msys64\\ucrt64\\bin\\g++.exe') === 1 && at('E:\\Dev\\msys64\\mingw64\\bin\\g++.exe') === 2 && at('E:\\Dev\\msys64\\clang64\\bin\\g++.exe') === 3,
        'ORDER: then the registry root\'s ucrt64, mingw64, clang64');
    assert(at('C:\\msys64\\ucrt64\\bin\\g++.exe') === 4 && at('D:\\msys64\\ucrt64\\bin\\g++.exe') > 4 && at('C:\\tools\\msys64\\ucrt64\\bin\\g++.exe') > 0
        && at('C:\\Users\\me\\scoop\\apps\\msys2\\current\\ucrt64\\bin\\g++.exe') > 0, 'ORDER: then the usual roots\' environments');
    const mingw = at('C:\\MinGW\\bin\\g++.exe');
    const firstUsr = cands.findIndex(c => /\\usr\\bin\\g\+\+\.exe$/i.test(c));
    assert(mingw > at('C:\\Users\\me\\scoop\\apps\\msys2\\current\\clang64\\bin\\g++.exe') && firstUsr > mingw
        && at('E:\\Dev\\msys64\\usr\\bin\\g++.exe') === firstUsr && cands.slice(firstUsr).every(c => /\\usr\\bin\\g\+\+\.exe$/i.test(c)),
    'ORDER: every MSYS2 environment before C:\\MinGW, and the MSYS usr\\bin g++ of each root last');
    const dup = g.gppCandidates({ platform: 'win32', env: { Path: 'C:\\msys64\\UCRT64\\bin;c:\\msys64\\ucrt64\\bin' } }).map(c => c.path.toLowerCase());
    assert(dup.filter(p => p === 'c:\\msys64\\ucrt64\\bin\\g++.exe').length === 1 && dup[0] === 'c:\\msys64\\ucrt64\\bin\\g++.exe',
        'ORDER: a folder on PATH and in the MSYS2 list is tried once, at its PATH place (case-blind)');
    assert(eq(g.gppCandidates({ platform: 'linux', env: { PATH: '/usr/bin' }, msys2Roots: ['C:\\msys64'] }).map(c => c.path), ['/usr/bin/g++']),
        'ORDER: off Windows, MSYS2 roots are ignored');

    // The user report: an old C:\MinGW g++ 6.3 and an MSYS2 at a non-standard place, known only to the registry.
    const old = 'C:\\MinGW\\bin\\g++.exe';
    const msysGpp = 'E:\\Dev\\msys64\\ucrt64\\bin\\g++.exe';
    const version = (p) => (p.toLowerCase() === old.toLowerCase() ? { version: '6.3.0', major: 6 } : { version: '14.2.0', major: 14 });
    const winEnv = { Path: 'C:\\MinGW\\bin', USERPROFILE: 'C:\\Users\\me' };
    assert(eq(g.detectGpp({ platform: 'win32', env: winEnv, exists: existsIn([old, msysGpp]), version }), { path: old, source: 'path', version: '6.3.0', tooOld: true }),
        'USER: before the registry settles, only the old MinGW g++ is found (marked too old)');
    assert(eq(g.detectGpp({ platform: 'win32', env: winEnv, exists: existsIn([old, msysGpp]), version, msys2Roots: ['E:\\Dev\\msys64'] }),
        { path: msysGpp, source: 'default', version: '14.2.0' }), 'USER: with the registry root, the MSYS2 g++ 14 wins over the PATH g++ 6');
    const usrOnly = 'C:\\msys64\\usr\\bin\\g++.exe';
    assert(eq(g.detectGpp({ platform: 'win32', env: winEnv, exists: existsIn([old, usrOnly]), version }), { path: usrOnly, source: 'default', version: '14.2.0' }),
        'USER: the MSYS usr\\bin g++ is used when it is the only new-enough one');

    // ── MSYS2 without its gcc package ────────────────────────────────────────────────────────
    const dll = (root) => `${root}\\usr\\bin\\msys-2.0.dll`;
    const machine = (files, more) => Object.assign({ platform: 'win32', env: winEnv, exists: existsIn(files) }, more);
    assert(m.findMsys2WithoutGpp(machine([dll('C:\\msys64')])) === 'C:\\msys64', 'NO-GCC: an MSYS2 root with no g++ in any environment is named');
    assert(m.findMsys2WithoutGpp(machine(['E:\\Dev\\msys64\\msys2.exe'], { msys2Roots: ['E:\\Dev\\msys64'] })) === 'E:\\Dev\\msys64',
        'NO-GCC: a registry root counts when its launcher is there');
    assert(m.findMsys2WithoutGpp(machine([dll('C:\\msys64'), 'C:\\msys64\\mingw64\\bin\\g++.exe'])) === null, 'NO-GCC: a root with g++ in any environment is not named');
    assert(m.findMsys2WithoutGpp(machine([dll('C:\\msys64'), usrOnly])) === null, 'NO-GCC: nor one with only the MSYS usr\\bin g++');
    assert(m.findMsys2WithoutGpp(machine([], { msys2Roots: ['E:\\Gone'] })) === null, 'NO-GCC: a registry root whose folder is gone is not named');
    assert(m.findMsys2WithoutGpp({ platform: 'linux', env: {}, exists: () => true }) === null, 'NO-GCC: never off Windows');
    assert(m.findMsys2WithoutGpp(machine([dll('C:\\msys64')], { exists: () => { throw new Error('EACCES'); } })) === null, 'NO-GCC: a throwing check counts as absent');
    assert(m.msys2NoGppText('C:\\msys64') === 'MSYS2 is installed at C:\\msys64 but has no g++: in the MSYS2 UCRT64 shell run pacman -S mingw-w64-ucrt-x86_64-gcc',
        'NO-GCC: the sentence names the root and the pacman command');
    const noGcc = machine([dll('D:\\msys64')]);
    assert(eq(g.describeGppSetting('', noGcc), { state: 'notFound', configured: '', path: '', msys2Root: 'D:\\msys64' }), 'START: "not found" carries the MSYS2 root without g++');
    assert(eq(g.resolveGpp({ configured: '', ...noGcc }), { ok: false, reason: 'not-found', configured: '', msys2Root: 'D:\\msys64' }), 'BUILD: not-found carries it too');
    const oldToo = machine([dll('D:\\msys64'), old], { version });
    assert(eq(g.describeGppSetting('', oldToo), { state: 'detected', configured: '', path: old, source: 'path', version: '6.3.0', tooOld: true, msys2Root: 'D:\\msys64' }),
        'START: only a too-old g++ found: it carries the MSYS2 root as well');
    assert(eq(g.describeGppSetting('', machine([dll('D:\\msys64'), 'D:\\msys64\\ucrt64\\bin\\g++.exe'], { version })),
        { state: 'detected', configured: '', path: 'D:\\msys64\\ucrt64\\bin\\g++.exe', source: 'default', version: '14.2.0' }), 'START: a usable g++ carries no MSYS2 note');

    // ── The once-per-session cache ───────────────────────────────────────────────────────────
    let built = 0;
    const linuxCache = m.createMsys2RootCache({ platform: 'linux', env: {}, run: () => { built++; return async () => 'x'; } });
    assert(eq(await linuxCache.load(), []) && built === 0 && eq(linuxCache.current(), []), 'CACHE: off Windows, nothing is run and no runner is built');
    assert(m.createMsys2RootCache({ platform: 'linux', env: {}, run: () => { throw new Error('never'); } }).settled() === true, 'CACHE: off Windows it counts as settled before it is loaded');
    let regCalls = 0;
    let release;
    const gate = new Promise(r => { release = r; });
    const winCache = m.createMsys2RootCache({
        platform: 'win32', env: {},
        run: () => async (args) => {
            regCalls++;
            await gate;
            if (args.includes('/f')) return args[1] === m.UNINSTALL_KEYS[0] ? searchOut([[`${HKCU}\\{a1}`, 'MSYS2']]) : null;
            return keyOut(`${HKCU}\\{a1}`, { DisplayName: ['REG_SZ', 'MSYS2'], InstallLocation: ['REG_SZ', 'E:\\Dev\\msys64'] });
        }
    });
    assert(winCache.settled() === false, 'CACHE: not settled before it starts');
    const first = winCache.load();
    assert(eq(winCache.current(), []) && winCache.load() === first && winCache.settled() === false, 'CACHE: nothing known until it settles; one search per session');
    const early = await m.msys2RootsWithin(20, winCache);
    assert(eq(early, []), 'CACHE: a bounded wait returns what is known when it runs out');
    release();
    assert(eq(await first, ['E:\\Dev\\msys64']) && eq(winCache.current(), ['E:\\Dev\\msys64']), 'CACHE: then it holds the registry roots');
    await new Promise(r => setImmediate(r));
    assert(winCache.settled() === true, 'CACHE: settled once the search is over');
    const { REG_TIMEOUT_MS } = require('../src/xaeShellDetect');
    assert(m.MSYS2_REGISTRY_WAIT_MS > 2 * REG_TIMEOUT_MS,
        `CACHE: the default wait outlasts both reg.exe phases, each up to ${REG_TIMEOUT_MS} ms (${m.MSYS2_REGISTRY_WAIT_MS})`);
    const callsAfter = regCalls;
    assert(eq(await m.msys2RootsWithin(1000, winCache), ['E:\\Dev\\msys64']) && regCalls === callsAfter, 'CACHE: a later wait does not query again');
    const failing = m.createMsys2RootCache({ platform: 'win32', env: {}, run: () => { throw new Error('no reg.exe'); } });
    assert(eq(await failing.load(), []), 'CACHE: a runner that cannot be built gives no roots, and does not reject');

    if (errors) { console.error(`\n${errors} failure(s)`); process.exit(1); }
    console.log('\nAll MSYS2 detection checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
