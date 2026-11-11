/**
 * @file xaeShellDetect.js
 * @description Finds where the TwinCAT XAE Shell of each supported TwinCAT version is installed, for
 * the `tcToolkit.xaeShell.path4024` / `tcToolkit.xaeShell.path4026` settings.
 *
 * Pure: no `vscode`, no `fs` and no `child_process` at module level — the platform, the environment,
 * the file-existence check and the registry query are all passed in, so the whole module is
 * unit-testable off Windows (test/test_xae_shell_detect.js). `createRegQuery` builds the real registry
 * query from an injected `execFile`. Off Windows nothing is detected and nothing is ever spawned.
 *
 * src/xaeShell.js (which drives a shell for Update Library Definitions) keeps its own discovery and
 * asks `resolveShellExe` here to put a configured, existing path ahead of it. Nothing else reads the
 * settings yet (they are for the planned create-through-XAE phase).
 */

'use strict';

/** The configuration section both path settings live in. */
const XAE_SHELL_SECTION = 'tcToolkit.xaeShell';

/** Milliseconds one `reg.exe query` may take before it counts as "not found". */
const REG_TIMEOUT_MS = 3000;

/**
 * The XAE shells the settings cover, oldest first (the order they are shown in).
 *
 * `progId` is the shell's automation object; its COM registration records where the .exe really is.
 * The 4024 shell is a 32-bit process, so its CLSID is registered in the 32-bit view
 * (`HKCR\WOW6432Node\CLSID`); the 4026 shell is 64-bit (`HKCR\CLSID`). `programFilesVar` and
 * `programFilesFallback` give the default install root. The same pairs as
 * scripts/Create sample PLC project/build-sample-solution.ps1.
 * @type {ReadonlyArray<Readonly<{id: string, version: string, key: string, setting: string, label: string,
 *   progId: string, progIdKeys: ReadonlyArray<string>, clsidRoots: ReadonlyArray<string>,
 *   programFilesVar: string, programFilesFallback: string}>>}
 */
const XAE_SHELL_VERSIONS = Object.freeze([
    Object.freeze({
        id: '4024',
        version: '3.1.4024',
        key: 'path4024',
        setting: `${XAE_SHELL_SECTION}.path4024`,
        label: 'XAE Shell for TwinCAT 3.1.4024 (32-bit)',
        progId: 'TcXaeShell.DTE.15.0',
        progIdKeys: Object.freeze(['HKCR\\TcXaeShell.DTE.15.0\\CLSID', 'HKCR\\WOW6432Node\\TcXaeShell.DTE.15.0\\CLSID']),
        clsidRoots: Object.freeze(['HKCR\\WOW6432Node\\CLSID', 'HKCR\\CLSID']),
        programFilesVar: 'ProgramFiles(x86)',
        programFilesFallback: 'C:\\Program Files (x86)'
    }),
    Object.freeze({
        id: '4026',
        version: '3.1.4026',
        key: 'path4026',
        setting: `${XAE_SHELL_SECTION}.path4026`,
        label: 'XAE Shell for TwinCAT 3.1.4026 (64-bit)',
        progId: 'TcXaeShell.DTE.17.0',
        progIdKeys: Object.freeze(['HKCR\\TcXaeShell.DTE.17.0\\CLSID']),
        clsidRoots: Object.freeze(['HKCR\\CLSID']),
        programFilesVar: 'ProgramFiles',
        programFilesFallback: 'C:\\Program Files'
    })
]);

/** The shell's path below a Program Files root. */
const SHELL_RELATIVE_PATH = 'Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe';

/**
 * The default value out of `reg.exe query <key> /ve` output.
 *
 * Anchored on the `REG_SZ` type token, not on the value's name: reg.exe is localized, so the default
 * value prints as "(Default)" on an English Windows and "(Standard)" on a German one.
 * @param {unknown} stdout
 * @returns {string|null} The value, or null when the output holds none.
 */
function parseRegDefaultValue(stdout) {
    if (typeof stdout !== 'string') return null;
    const m = /^\s*\S.*?\s+REG_(?:EXPAND_)?SZ[ \t]+(.+?)\s*$/m.exec(stdout);
    return m ? m[1].trim() || null : null;
}

/**
 * The .exe out of a `LocalServer32` registration, which may be quoted and may carry arguments
 * (`"C:\…\TcXaeShell.exe" /Embedding`, or unquoted with a path that itself contains spaces).
 * @param {unknown} raw
 * @returns {string|null}
 */
function exeFromLocalServer(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;
    const quoted = /^"([^"]+)"/.exec(value);
    if (quoted) return quoted[1].trim() || null;
    // Unquoted: the path ends at the first ".exe" that is followed by a space or the end.
    const exe = /^(.+?\.exe)(?=\s|$)/i.exec(value);
    if (exe) return exe[1];
    return value.replace(/(?:\s+[/-]\S+)+\s*$/, '') || null;
}

/**
 * The default install location of one shell.
 * @param {typeof XAE_SHELL_VERSIONS[number]} shell
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function defaultShellPath(shell, env) {
    // Environment variable names are case-insensitive on Windows; an injected plain object is not.
    const wanted = shell.programFilesVar.toLowerCase();
    const name = Object.keys(env || {}).find(k => k.toLowerCase() === wanted);
    const root = (name && env[name]) || shell.programFilesFallback;
    return String(root).replace(/[\\/]+$/, '') + '\\' + SHELL_RELATIVE_PATH;
}

/**
 * Calls an injected function that must never break detection.
 * @template T
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T|null>} Its result, or null if it threw or rejected.
 */
async function guarded(fn) {
    try {
        return await fn();
    } catch (e) {
        return null;
    }
}

/**
 * Source 1: the shell's path from the COM registration of its automation object.
 * @param {typeof XAE_SHELL_VERSIONS[number]} shell
 * @param {(p: string) => boolean} exists
 * @param {(key: string) => Promise<string|null>|string|null} regQuery `reg.exe query <key> /ve` output, or null.
 * @returns {Promise<string|null>}
 */
async function shellFromRegistry(shell, exists, regQuery) {
    let clsid = null;
    for (const key of shell.progIdKeys) {
        clsid = parseRegDefaultValue(await guarded(() => regQuery(key)));
        if (clsid) break;
    }
    // The CLSID becomes part of the next key: accept nothing but a braced GUID.
    if (!clsid || !/^\{[0-9A-Fa-f-]{36}\}$/.test(clsid)) return null;
    for (const root of shell.clsidRoots) {
        const exe = exeFromLocalServer(parseRegDefaultValue(await guarded(() => regQuery(`${root}\\${clsid}\\LocalServer32`))));
        if (exe && await guarded(() => exists(exe))) return exe;
    }
    return null;
}

/**
 * @typedef {Object} XaeShellHit
 * @property {string} path Absolute path of an existing `TcXaeShell.exe`.
 * @property {'registry'|'default'} source Where it was found.
 */

/**
 * Detects the installed XAE shells. Never throws: any failure of a source means "not found" there.
 * @param {object} deps
 * @param {string} deps.platform `process.platform`.
 * @param {Record<string, string|undefined>} deps.env `process.env`.
 * @param {(p: string) => boolean} deps.exists Whether a file exists.
 * @param {(key: string) => Promise<string|null>|string|null} deps.regQuery See `createRegQuery`.
 * @returns {Promise<Record<string, XaeShellHit|null>>} By version id ('4024', '4026'); every id is
 *   present, null when that shell was not found. Off Windows all are null and `regQuery` is not called.
 */
async function detectXaeShells({ platform, env, exists, regQuery }) {
    /** @type {Record<string, XaeShellHit|null>} */
    const found = {};
    for (const shell of XAE_SHELL_VERSIONS) found[shell.id] = null;
    if (platform !== 'win32') return found;
    for (const shell of XAE_SHELL_VERSIONS) {
        const registered = await shellFromRegistry(shell, exists, regQuery);
        if (registered) {
            found[shell.id] = { path: registered, source: 'registry' };
            continue;
        }
        const fallback = defaultShellPath(shell, env);
        if (await guarded(() => exists(fallback))) found[shell.id] = { path: fallback, source: 'default' };
    }
    return found;
}

/**
 * The real registry query: `reg.exe query <key> /ve`, arguments passed as an array (no shell, no
 * string concatenation), with a short timeout. Resolves with reg.exe's output, or null on any error
 * (key absent, reg.exe missing, timeout) — it never rejects.
 * @param {(file: string, args: string[], options: object, cb: (err: any, stdout: any) => void) => any} execFile
 *   `child_process.execFile`.
 * @returns {(key: string) => Promise<string|null>}
 */
function createRegQuery(execFile) {
    return (key) => new Promise((resolve) => {
        try {
            execFile('reg.exe', ['query', key, '/ve'], { timeout: REG_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
                (err, stdout) => resolve(err || typeof stdout !== 'string' ? null : stdout));
        } catch (e) {
            resolve(null);
        }
    });
}

/**
 * The two settings as the start page shows them.
 * @param {(key: string) => unknown} get Reads one key of the `tcToolkit.xaeShell` section.
 * @param {(p: string) => boolean} exists
 * @returns {Array<{id: string, version: string, path: string, exists: boolean}>} `path` is '' when the
 *   setting is empty; `exists` is whether a non-empty path is a file on disk.
 */
function describeConfiguredShells(get, exists) {
    return XAE_SHELL_VERSIONS.map((shell) => {
        const value = get(shell.key);
        const p = typeof value === 'string' ? value.trim() : '';
        let there = false;
        if (p) {
            try { there = !!exists(p); } catch (e) { there = false; }
        }
        return { id: shell.id, version: shell.version, path: p, exists: there };
    });
}

/**
 * Which .exe to use for one shell: the configured path when it is set and exists, otherwise exactly
 * what discovery did before the settings existed (the default location, then the registry).
 * @param {object} o
 * @param {unknown} o.configured The matching `tcToolkit.xaeShell.path*` setting ('' or absent = not set).
 * @param {string} o.defaultPath The shell's default install location.
 * @param {(p: string) => boolean} o.exists
 * @param {() => string|null} o.fromRegistry Registry lookup; called only when it is needed.
 * @returns {string|null} An existing .exe, or null when the shell is not installed.
 */
function resolveShellExe({ configured, defaultPath, exists, fromRegistry }) {
    const wanted = typeof configured === 'string' ? configured.trim() : '';
    if (wanted && exists(wanted)) return wanted;
    if (exists(defaultPath)) return defaultPath;
    return fromRegistry() || null;
}

module.exports = {
    XAE_SHELL_SECTION, XAE_SHELL_VERSIONS, REG_TIMEOUT_MS,
    parseRegDefaultValue, exeFromLocalServer, defaultShellPath, detectXaeShells, createRegQuery,
    describeConfiguredShells, resolveShellExe
};
