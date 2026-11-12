/**
 * @file msys2Detect.js
 * @description Where MSYS2 is installed on Windows, for g++ detection (src/gpp.js, roadmap R13).
 *
 * Two sources: the Windows uninstall registry (HKCU and HKLM, with the 32-bit WOW6432Node view), whose
 * MSYS2 entry names the folder the installer used (`InstallLocation`, else the folder of
 * `UninstallString`), and the usual roots (C:\msys64, D:\msys64, Chocolatey's C:\tools\msys64,
 * %USERPROFILE%\msys64, Scoop's apps\msys2\current). Each root's g++ is looked for in the UCRT64,
 * MINGW64 and CLANG64 environments, then in `usr\bin` (the MSYS environment's own g++).
 *
 * The registry is read with reg.exe (no shell) and is asynchronous, while detection in src/gpp.js is
 * synchronous: `createMsys2RootCache` runs the registry search once per session, and detection reads
 * whatever it has found so far (nothing until it settles). Off Windows nothing is ever spawned.
 *
 * Pure apart from `defaultMsys2RootCache`, which builds the real reg.exe runner on first use:
 * test/test_msys2_detect.js covers it all with fake reg.exe output.
 */

'use strict';

const path = require('path');
const { createRegRunner, exeFromLocalServer, REG_TIMEOUT_MS } = require('./xaeShellDetect');

/**
 * How long a caller waits for the registry search: longer than its two reg.exe phases (the key
 * searches, then the entry reads), each bounded by REG_TIMEOUT_MS, so a slow search still settles.
 */
const MSYS2_REGISTRY_WAIT_MS = 2 * REG_TIMEOUT_MS + 1500;

/** The uninstall keys searched, current user first. */
const UNINSTALL_KEYS = Object.freeze([
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]);

/** The MSYS2 environments whose `bin` may hold a MinGW-w64 g++, in the order they are preferred. */
const MSYS2_ENVIRONMENTS = Object.freeze(['ucrt64', 'mingw64', 'clang64']);

/** The pacman command that installs g++ in the UCRT64 environment. */
const MSYS2_GCC_INSTALL = 'pacman -S mingw-w64-ucrt-x86_64-gcc';

/**
 * A variable of an environment, matched case-insensitively (Windows names are).
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @returns {string}
 */
function envVar(env, name) {
    const key = Object.keys(env || {}).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? String(env[key] || '') : '';
}

/**
 * A root as it is compared and joined: quotes, surrounding spaces and trailing separators dropped.
 * @param {unknown} root
 * @returns {string}
 */
function normalizeRoot(root) {
    return typeof root === 'string' ? root.trim().replace(/^"(.*)"$/, '$1').trim().replace(/[\\/]+$/, '') : '';
}

/**
 * Drops empty and repeated roots, keeping the first spelling (case-blind: Windows paths).
 * @param {unknown[]} roots
 * @returns {string[]}
 */
function uniqueRoots(roots) {
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    for (const r of roots) {
        const root = normalizeRoot(r);
        // A bare drive ("C:") would join to a drive-relative path.
        if (!root || /^[A-Za-z]:$/.test(root) || seen.has(root.toLowerCase())) continue;
        seen.add(root.toLowerCase());
        out.push(root);
    }
    return out;
}

/**
 * The usual MSYS2 roots: the installer's default, a second drive, Chocolatey's tools folder, the
 * user's profile and Scoop. A root built from a variable that is not set is left out.
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
function msys2CommonRoots(env) {
    const profile = normalizeRoot(envVar(env, 'USERPROFILE'));
    const chocoTools = normalizeRoot(envVar(env, 'ChocolateyToolsLocation'));
    const scoop = normalizeRoot(envVar(env, 'SCOOP'));
    return uniqueRoots([
        'C:\\msys64', 'D:\\msys64',
        chocoTools && `${chocoTools}\\msys64`, 'C:\\tools\\msys64',
        profile && `${profile}\\msys64`,
        scoop && `${scoop}\\apps\\msys2\\current`,
        profile && `${profile}\\scoop\\apps\\msys2\\current`
    ]);
}

/**
 * Every MSYS2 root to look in: the registry's first (what is really installed), then the usual ones.
 * @param {{env: Record<string, string|undefined>, msys2Roots?: string[]}} o `msys2Roots`: from the registry.
 * @returns {string[]}
 */
function msys2Roots(o) {
    return uniqueRoots([...(Array.isArray(o.msys2Roots) ? o.msys2Roots : []), ...msys2CommonRoots(o.env)]);
}

/**
 * The g++ of each MinGW-w64 environment of one root, in order (`usr\bin` is not among them).
 * @param {string} root
 * @returns {string[]}
 */
function msys2EnvironmentGpps(root) {
    return MSYS2_ENVIRONMENTS.map(e => `${root}\\${e}\\bin\\g++.exe`);
}

/**
 * The MSYS environment's own g++ of one root.
 * @param {string} root
 * @returns {string}
 */
function msys2UsrGpp(root) {
    return `${root}\\usr\\bin\\g++.exe`;
}

/**
 * Whether an MSYS2 installation is at a root: its runtime DLL, or its launcher, is there.
 * @param {string} root
 * @param {(p: string) => boolean} exists Whether a FILE is there.
 * @returns {boolean}
 */
function isMsys2Root(root, exists) {
    const has = (/** @type {string} */ p) => { try { return !!exists(p); } catch (e) { return false; } };
    return has(`${root}\\usr\\bin\\msys-2.0.dll`) || has(`${root}\\msys2.exe`);
}

/**
 * The first MSYS2 installation that has no g++ in any of its environments (`usr\bin` included), for
 * the message that says which package to install. Null off Windows, or when there is none.
 * @param {{platform: string, env: Record<string, string|undefined>, exists: (p: string) => boolean, msys2Roots?: string[]}} o
 * @returns {string|null}
 */
function findMsys2WithoutGpp(o) {
    if (!o || o.platform !== 'win32') return null;
    const has = (/** @type {string} */ p) => { try { return !!o.exists(p); } catch (e) { return false; } };
    for (const root of msys2Roots(o)) {
        if (!isMsys2Root(root, o.exists)) continue;
        if (![...msys2EnvironmentGpps(root), msys2UsrGpp(root)].some(has)) return root;
    }
    return null;
}

/**
 * The sentence for an MSYS2 installation without g++.
 * @param {string} root
 * @returns {string}
 */
function msys2NoGppText(root) {
    return `MSYS2 is installed at ${root} but has no g++: in the MSYS2 UCRT64 shell run ${MSYS2_GCC_INSTALL}`;
}

/**
 * The REG_SZ / REG_EXPAND_SZ values of reg.exe output, grouped by the key each follows.
 *
 * Anchored on the type token and on `HKEY_` key lines, never on reg.exe's own words: those are
 * localized ("(Default)" / "(Standard)", "End of search" / "Suche beendet"). Value names such as
 * `DisplayName` are the registry's, not reg.exe's, and are the same in every language.
 * @param {unknown} stdout
 * @returns {Array<{key: string, values: Record<string, string>}>}
 */
function parseRegKeys(stdout) {
    /** @type {Array<{key: string, values: Record<string, string>}>} */
    const out = [];
    if (typeof stdout !== 'string') return out;
    /** @type {{key: string, values: Record<string, string>}|null} */
    let current = null;
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (/^HKEY_[A-Z_]+(\\|$)/.test(line)) {
            current = { key: line, values: {} };
            out.push(current);
            continue;
        }
        if (!current) continue;
        const m = /^\s+(\S.*?)\s+REG_(?:EXPAND_)?SZ(?:[ \t]+(.*))?$/.exec(line);
        if (m) current.values[m[1]] = (m[2] || '').trim();
    }
    return out;
}

/**
 * `%NAME%` references expanded from an environment (REG_EXPAND_SZ values); unknown ones stay.
 * @param {string} value
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function expandEnv(value, env) {
    return value.replace(/%([^%]+)%/g, (whole, name) => envVar(env, name) || whole);
}

/**
 * The install folder an uninstall entry names: `InstallLocation`, else the folder of the
 * `UninstallString` program.
 * @param {Record<string, string>} values
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function rootOfEntry(values, env) {
    const loc = normalizeRoot(expandEnv(values.InstallLocation || '', env));
    if (loc) return loc;
    const exe = exeFromLocalServer(expandEnv(values.UninstallString || '', env));
    return exe ? normalizeRoot(path.win32.dirname(exe)) : '';
}

/**
 * MSYS2's install folders from the uninstall registry: each uninstall key is searched for entries
 * whose data mentions MSYS2 (`reg query <key> /s /f MSYS2 /d`), the entries whose `DisplayName`
 * starts with "MSYS2" are read in full (`reg query <entry>`), and their folders are returned.
 * Never rejects; a failed query counts as no entry.
 * @param {(args: string[]) => Promise<string|null>|string|null} run reg.exe with these arguments
 *   (`createRegRunner`): its output, or null.
 * @param {Record<string, string|undefined>} [env] For REG_EXPAND_SZ values.
 * @returns {Promise<string[]>}
 */
async function findMsys2RootsInRegistry(run, env = {}) {
    const ask = async (/** @type {string[]} */ args) => { try { return await run(args); } catch (e) { return null; } };
    const searches = await Promise.all(UNINSTALL_KEYS.map(key => ask(['query', key, '/s', '/f', 'MSYS2', '/d'])));
    /** @type {string[]} */
    const entries = [];
    for (const out of searches) {
        for (const k of parseRegKeys(out)) {
            if (/^msys2/i.test(k.values.DisplayName || '') && !entries.some(e => e.toLowerCase() === k.key.toLowerCase())) entries.push(k.key);
        }
    }
    const full = await Promise.all(entries.map(key => ask(['query', key])));
    /** @type {string[]} */
    const roots = [];
    full.forEach((out) => {
        for (const k of parseRegKeys(out)) {
            if (!/^msys2/i.test(k.values.DisplayName || '')) continue;
            const root = rootOfEntry(k.values, env);
            if (root) roots.push(root);
        }
    });
    return uniqueRoots(roots);
}

/**
 * @typedef {Object} Msys2RootCache The registry search, run once per session.
 * @property {() => Promise<string[]>} load Starts the search on first call; the same promise after.
 *   Never rejects. Resolves at once with [] off Windows, where nothing is spawned.
 * @property {() => string[]} current What the search found, [] until it settles.
 * @property {() => boolean} settled Whether the search has finished (always true off Windows).
 */

/**
 * @param {{platform: string, env: Record<string, string|undefined>,
 *   run: () => ((args: string[]) => Promise<string|null>|string|null)}} deps `run` is called only
 *   when the search starts (on Windows), so off Windows no runner is even built.
 * @returns {Msys2RootCache}
 */
function createMsys2RootCache(deps) {
    /** @type {Promise<string[]>|null} */
    let pending = null;
    /** @type {string[]} */
    let found = [];
    let done = false;
    return {
        load() {
            if (!pending) {
                pending = deps.platform !== 'win32'
                    ? Promise.resolve([])
                    : Promise.resolve().then(() => findMsys2RootsInRegistry(deps.run(), deps.env))
                        .then((roots) => { found = roots; return roots; }, () => []);
                pending.then(() => { done = true; });
            }
            return pending;
        },
        settled: () => done || deps.platform !== 'win32',
        current: () => found.slice()
    };
}

/** @type {Msys2RootCache|null} */
let defaultCache = null;

/**
 * The session's cache for this machine (real platform, environment and reg.exe).
 * @returns {Msys2RootCache}
 */
function defaultMsys2RootCache() {
    if (!defaultCache) {
        defaultCache = createMsys2RootCache({
            platform: process.platform, env: process.env,
            run: () => createRegRunner(/** @type {any} */ (require('child_process').execFile))
        });
    }
    return defaultCache;
}

/**
 * Waits for the session's registry search, but no longer than `ms`: what is known by then.
 * @param {number} [ms]
 * @param {Msys2RootCache} [cache]
 * @returns {Promise<string[]>}
 */
function msys2RootsWithin(ms = MSYS2_REGISTRY_WAIT_MS, cache = defaultMsys2RootCache()) {
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(cache.current()), ms); });
    return /** @type {Promise<string[]>} */ (Promise.race([cache.load(), late])).finally(() => clearTimeout(timer));
}

module.exports = {
    UNINSTALL_KEYS, MSYS2_ENVIRONMENTS, MSYS2_REGISTRY_WAIT_MS, MSYS2_GCC_INSTALL,
    msys2CommonRoots, msys2Roots, msys2EnvironmentGpps, msys2UsrGpp, isMsys2Root, findMsys2WithoutGpp, msys2NoGppText,
    parseRegKeys, findMsys2RootsInRegistry, createMsys2RootCache, defaultMsys2RootCache, msys2RootsWithin
};
