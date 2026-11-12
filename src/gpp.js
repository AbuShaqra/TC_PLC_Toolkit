/**
 * @file gpp.js
 * @description The vscode-free half of the optional g++ build of generated C++ (roadmap R13): find
 * g++, build its command line, run it as a child process, and read its messages back.
 *
 * The build is a COMPILE CHECK only: `g++ -c` turns `CPP_Files/<project>.cpp` into `<project>.o`
 * against the compiler's C++ runtime headers (`resources/compiler/include/`, vendored by
 * scripts/vendor-compiler.js); nothing is linked or run.
 *
 * Detection is pure — the platform, the environment and the file-existence check are passed in —
 * so test/test_gpp.js covers the Windows locations off Windows. The order: `PATH`, then (Windows
 * only) the usual install folders of MSYS2, MinGW, WinLibs, w64devkit and Chocolatey's mingw.
 */

'use strict';

const childProcess = require('child_process');
const path = require('path');
const { runChild } = require('./compileCheck');

/** The g++ path setting (package.json `contributes.configuration`). */
const SETTING_GPP_PATH = 'tcToolkit.compiler.gppPath';

/** How long one g++ run may take before it is stopped. */
const DEFAULT_GPP_TIMEOUT_MS = 120000;

/**
 * The flags of the build, after `-std=c++14`. The fork's own builds of generated code pass
 * `-fno-strict-aliasing` (its docs/RUNTIME.md: pointer punning is valid IEC), and its tests pass
 * `-Wno-c++17-extensions` because the generated VAR_GLOBALs are `inline` variables, a C++17
 * extension g++ accepts at C++14 with a warning on every one of them. The last two keep each message
 * on one plain line, so it can be read back.
 */
const GPP_FLAGS = Object.freeze(['-std=c++14', '-fno-strict-aliasing', '-Wno-c++17-extensions', '-fdiagnostics-color=never', '-fmessage-length=0']);

/**
 * The places g++ is looked for on Windows after `PATH`, as absolute paths. Environment variables
 * give the roots where they exist; the usual defaults otherwise.
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
function windowsGppLocations(env) {
    const get = (/** @type {string} */ name, /** @type {string} */ fallback) => {
        const key = Object.keys(env || {}).find(k => k.toLowerCase() === name.toLowerCase());
        return String((key && env[key]) || fallback).replace(/[\\/]+$/, '');
    };
    const programFiles = get('ProgramFiles', 'C:\\Program Files');
    const choco = get('ChocolateyInstall', 'C:\\ProgramData\\chocolatey');
    const roots = [
        'C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin', 'C:\\msys64\\clang64\\bin',
        'C:\\MinGW\\bin', 'C:\\mingw64\\bin',
        `${programFiles}\\mingw64\\bin`, `${programFiles}\\WinLibs\\mingw64\\bin`, 'C:\\WinLibs\\mingw64\\bin',
        `${programFiles}\\w64devkit\\bin`, 'C:\\w64devkit\\bin',
        `${choco}\\lib\\mingw\\tools\\install\\mingw64\\bin`
    ];
    return roots.map(r => `${r}\\g++.exe`);
}

/**
 * The `PATH` directories, in order.
 * @param {string} platform
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
function pathDirs(platform, env) {
    // Windows spells it `Path`; environment names are case-insensitive there.
    const key = Object.keys(env || {}).find(k => k.toLowerCase() === 'path');
    const value = key ? String(env[key] || '') : '';
    return value.split(platform === 'win32' ? ';' : ':').map(d => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

/**
 * Every place g++ is looked for, in order, with where each comes from.
 * @param {{platform: string, env: Record<string, string|undefined>}} o
 * @returns {Array<{path: string, source: 'path'|'default'}>}
 */
function gppCandidates({ platform, env }) {
    const win = platform === 'win32';
    const exe = win ? 'g++.exe' : 'g++';
    const join = (/** @type {string} */ dir) => (win ? path.win32.join(dir, exe) : path.posix.join(dir, exe));
    /** @type {Array<{path: string, source: 'path'|'default'}>} */
    const out = pathDirs(platform, env).map(d => ({ path: join(d), source: /** @type {'path'} */ ('path') }));
    if (win) out.push(...windowsGppLocations(env).map(p => ({ path: p, source: /** @type {'default'} */ ('default') })));
    const seen = new Set();
    return out.filter(c => {
        const k = win ? c.path.toLowerCase() : c.path;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/**
 * Finds g++ on this machine. Never throws.
 * @param {{platform: string, env: Record<string, string|undefined>, exists: (p: string) => boolean}} o
 * @returns {{path: string, source: 'path'|'default'}|null}
 */
function detectGpp(o) {
    for (const c of gppCandidates(o)) {
        try { if (o.exists(c.path)) return c; } catch (e) { /* not there */ }
    }
    return null;
}

/**
 * Which g++ a run uses: the `tcToolkit.compiler.gppPath` setting when it is set, else detection.
 * A setting that is a bare command name (`g++`, `x86_64-w64-mingw32-g++`) is looked up on `PATH`.
 * @param {{configured: unknown, platform: string, env: Record<string, string|undefined>, exists: (p: string) => boolean}} o
 * @returns {{ok: true, path: string, source: 'setting'|'path'|'default'} | {ok: false, reason: 'not-found'|'setting-missing', configured: string}}
 */
function resolveGpp(o) {
    const configured = typeof o.configured === 'string' ? o.configured.trim().replace(/^"(.*)"$/, '$1') : '';
    if (configured) {
        if (!/[\\/]/.test(configured)) {
            const win = o.platform === 'win32';
            const names = win && !/\.exe$/i.test(configured) ? [configured + '.exe', configured] : [configured];
            for (const dir of pathDirs(o.platform, o.env)) {
                for (const name of names) {
                    const p = win ? path.win32.join(dir, name) : path.posix.join(dir, name);
                    try { if (o.exists(p)) return { ok: true, path: p, source: 'setting' }; } catch (e) { /* next */ }
                }
            }
            return { ok: false, reason: 'setting-missing', configured };
        }
        let there;
        try { there = !!o.exists(configured); } catch (e) { there = false; }
        return there ? { ok: true, path: configured, source: 'setting' } : { ok: false, reason: 'setting-missing', configured };
    }
    const hit = detectGpp(o);
    return hit ? { ok: true, path: hit.path, source: hit.source } : { ok: false, reason: 'not-found', configured: '' };
}

/**
 * g++'s command line for the build of one project.
 * @param {{cppFile: string, objFile: string, includeDir: string, outDir: string}} o `includeDir`: the
 *   runtime headers; `outDir`: the folder of the generated `.hpp` the `.cpp` includes.
 * @returns {string[]}
 */
function buildGppArgs(o) {
    return [...GPP_FLAGS, '-c', o.cppFile, '-I', o.includeDir, '-I', o.outDir, '-o', o.objFile];
}

/**
 * @typedef {Object} GppMessage One message of g++'s output.
 * @property {string|null} file As g++ printed it (null for a message that names no file).
 * @property {number} line 1-based; 0 when unknown.
 * @property {number} column 1-based; 0 when unknown.
 * @property {'error'|'warning'} severity
 * @property {string} message
 * @property {Array<{file: string|null, line: number, column: number, message: string}>} notes The
 *   `note:` lines that follow it.
 */

/** `file:line:col: severity: message` (column optional; a Windows drive letter is part of `file`). */
const GPP_LINE_RE = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/;
/** `g++: error: …`, `cc1plus: fatal error: …`: a message with no position. */
const GPP_GENERAL_RE = /^([^:\s][^:]*?):\s*(fatal error|error|warning|note):\s*(.*)$/;

/**
 * Reads g++'s messages. Context lines (`In file included from`, `required from here`, source
 * excerpts and carets) are skipped; each `note:` is kept with the message before it.
 * @param {string} text g++'s stderr.
 * @returns {GppMessage[]}
 */
function parseGppOutput(text) {
    /** @type {GppMessage[]} */
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (!line || /^\s/.test(line)) continue;
        /** @type {string|null} */
        let file;
        let ln = 0;
        let col = 0;
        let kind;
        let message;
        const m = GPP_LINE_RE.exec(line);
        if (m) {
            file = m[1]; ln = Number(m[2]); col = m[3] ? Number(m[3]) : 0; kind = m[4]; message = m[5];
        } else {
            const g = GPP_GENERAL_RE.exec(line);
            if (!g) continue;
            // `cc1plus: fatal error: x.cpp: No such file` names a program, not a file.
            file = null; kind = g[2]; message = g[3];
        }
        if (kind === 'note') {
            const last = out[out.length - 1];
            if (last) last.notes.push({ file, line: ln, column: col, message });
            continue;
        }
        out.push({ file, line: ln, column: col, severity: kind === 'warning' ? 'warning' : 'error', message, notes: [] });
    }
    return out;
}

/**
 * @typedef {Object} PlacedGppMessage A g++ message placed on a generated file.
 * @property {string} filePath The generated `.cpp` or `.hpp` it is shown on.
 * @property {number} line 1-based.
 * @property {number} column 1-based.
 * @property {'error'|'warning'} severity
 * @property {string} message
 * @property {Array<{filePath: string|null, line: number, column: number, message: string}>} notes
 */

/**
 * Places g++'s messages on the generated files: a message in the `.cpp` or the `.hpp` stays where
 * g++ put it; one anywhere else (a runtime header, a system header) or in no file goes on the
 * `.cpp`'s first line and names where g++ saw it.
 * @param {GppMessage[]} messages
 * @param {{cwd: string, cppFile: string, hppFile: string, platform?: string}} o `cwd`: where g++ ran
 *   (relative paths in its output are relative to it).
 * @returns {PlacedGppMessage[]}
 */
function placeGppMessages(messages, o) {
    const win = (o.platform || process.platform) === 'win32';
    const p = win ? path.win32 : path;
    const norm = (/** @type {string} */ f) => { const r = p.resolve(o.cwd, f); return win ? r.toLowerCase() : r; };
    const own = new Map([[norm(o.cppFile), o.cppFile], [norm(o.hppFile), o.hppFile]]);
    const resolveFile = (/** @type {string|null} */ f) => (f ? own.get(norm(f)) || null : null);
    return messages.map((m) => {
        const target = resolveFile(m.file);
        const notes = m.notes.map(n => ({ filePath: resolveFile(n.file), line: n.line, column: n.column, message: n.message }));
        if (target) {
            return { filePath: target, line: Math.max(m.line, 1), column: Math.max(m.column, 1), severity: m.severity, message: m.message, notes };
        }
        const where = m.file ? ` (in ${p.basename(m.file)}${m.line ? `:${m.line}` : ''})` : '';
        return { filePath: o.cppFile, line: 1, column: 1, severity: m.severity, message: m.message + where, notes };
    });
}

/**
 * @typedef {Object} GppResult
 * @property {'done'|'failed'|'cancelled'|'timeout'} status `done`: g++ ran to its end (`exitCode`
 *   says whether it compiled); `failed`: it could not be started.
 * @property {number|null} exitCode
 * @property {string} message Why not done.
 * @property {GppMessage[]} messages
 * @property {string} output g++'s stderr and stdout, for the output channel.
 * @property {number} durationMs
 */

/**
 * Runs g++ once. Never rejects; a timeout or a cancellation stops it.
 * @param {{gppPath: string, args: string[], cwd: string, timeoutMs?: number,
 *   onCancel?: (cancel: () => void) => void, spawn?: import('./compileCheck').SpawnLike,
 *   env?: Record<string, string|undefined>}} o
 * @returns {Promise<GppResult>}
 */
async function runGpp(o) {
    const spawn = o.spawn || /** @type {any} */ (childProcess.spawn);
    const started = Date.now();
    const timeoutMs = o.timeoutMs || DEFAULT_GPP_TIMEOUT_MS;
    // A MinGW g++ finds its helpers relative to itself, but its DLLs only on PATH: put its folder first.
    const baseEnv = o.env || process.env;
    const pathKey = Object.keys(baseEnv).find(k => k.toLowerCase() === 'path') || 'PATH';
    const dir = path.dirname(o.gppPath);
    const env = dir && dir !== '.' ? { ...baseEnv, [pathKey]: [dir, baseEnv[pathKey]].filter(Boolean).join(path.delimiter) } : { ...baseEnv };
    const run = await runChild(spawn, o.gppPath, o.args, { cwd: o.cwd, timeoutMs, onCancel: o.onCancel, env });
    const output = [run.stderr, run.stdout].filter(Boolean).join('\n').trim();
    const base = { exitCode: run.code, messages: parseGppOutput(run.stderr), output, durationMs: Date.now() - started };
    if (run.outcome === 'cancelled') return { ...base, status: 'cancelled', message: '' };
    if (run.outcome === 'timeout') return { ...base, status: 'timeout', message: `g++ did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.` };
    if (run.outcome === 'spawn-error') return { ...base, status: 'failed', message: `g++ could not be started: ${run.error}` };
    return { ...base, status: 'done', message: '' };
}

/**
 * The one-line result of a g++ build.
 * @param {{exitCode: number|null, messages: Array<{severity: string}>}} r
 * @returns {string}
 */
function summarizeGpp(r) {
    const errors = r.messages.filter(m => m.severity === 'error').length;
    const warnings = r.messages.filter(m => m.severity === 'warning').length;
    const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    if (r.exitCode === 0) return warnings ? `g++ compiled it, ${plural(warnings, 'warning')}.` : 'g++ compiled it without errors.';
    if (errors === 0) return `g++ failed (exit code ${r.exitCode === null ? 'none' : r.exitCode}).`;
    return `g++: ${plural(errors, 'error')}${warnings ? `, ${plural(warnings, 'warning')}` : ''}.`;
}

module.exports = {
    SETTING_GPP_PATH, DEFAULT_GPP_TIMEOUT_MS, GPP_FLAGS,
    windowsGppLocations, gppCandidates, detectGpp, resolveGpp,
    buildGppArgs, parseGppOutput, placeGppMessages, runGpp, summarizeGpp
};
