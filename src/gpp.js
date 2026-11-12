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
const fs = require('fs');
const path = require('path');
const { runChild } = require('./compileCheck');

/** The g++ path setting (package.json `contributes.configuration`). */
const SETTING_GPP_PATH = 'tcToolkit.compiler.gppPath';

/** How long one g++ run may take before it is stopped. */
const DEFAULT_GPP_TIMEOUT_MS = 120000;

/**
 * The flags of the build. `-std=c++17`: the generated VAR_GLOBALs are `inline` variables, which g++
 * older than 7 cannot compile at all and newer ones accept at C++14 only with a warning on each (the
 * build therefore needs g++ 7 or later, GPP_MIN_MAJOR). `-fno-strict-aliasing`: the fork's own builds
 * of generated code pass it (its docs/RUNTIME.md: pointer punning is valid IEC). The last two keep
 * each message on one plain line, so it can be read back.
 */
const GPP_FLAGS = Object.freeze(['-std=c++17', '-fno-strict-aliasing', '-fdiagnostics-color=never', '-fmessage-length=0']);

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
 * A value of the g++ path setting as it is checked: surrounding spaces and quotes dropped.
 * @param {unknown} value
 * @returns {string} '' when not set.
 */
function normalizeGppSetting(value) {
    return typeof value === 'string' ? value.trim().replace(/^"(.*)"$/, '$1').trim() : '';
}

/**
 * Checks a value of the g++ path setting — the one check both the build and "Detect g++" use.
 * Surrounding quotes (Explorer's "Copy as path") and spaces are dropped. A bare command name
 * (`g++`, `x86_64-w64-mingw32-g++`) is looked up on `PATH`; a folder is accepted when it holds g++.
 * @param {unknown} value
 * @param {{platform: string, env: Record<string, string|undefined>, exists: (p: string) => boolean,
 *   isDir?: (p: string) => boolean}} o `exists`: is a FILE there.
 * @returns {{ok: true, path: string} | {ok: false, reason: 'empty'|'not-on-path'|'missing'|'folder', configured: string}}
 *   `not-on-path`: a bare name PATH does not have; `missing`: nothing at that path; `folder`: a
 *   folder with no g++ in it.
 */
function checkConfiguredGpp(value, o) {
    const configured = normalizeGppSetting(value);
    if (!configured) return { ok: false, reason: 'empty', configured: '' };
    const win = o.platform === 'win32';
    const p = win ? path.win32 : path.posix;
    const has = (/** @type {string} */ f) => { try { return !!o.exists(f); } catch (e) { return false; } };
    if (!/[\\/]/.test(configured)) {
        const names = win && !/\.exe$/i.test(configured) ? [configured + '.exe', configured] : [configured];
        for (const dir of pathDirs(o.platform, o.env)) {
            for (const name of names) {
                const candidate = p.join(dir, name);
                if (has(candidate)) return { ok: true, path: candidate };
            }
        }
        return { ok: false, reason: 'not-on-path', configured };
    }
    if (has(configured)) return { ok: true, path: configured };
    let dir;
    try { dir = !!(o.isDir && o.isDir(configured)); } catch (e) { dir = false; }
    if (dir) {
        const inside = p.join(configured, win ? 'g++.exe' : 'g++');
        return has(inside) ? { ok: true, path: inside } : { ok: false, reason: 'folder', configured };
    }
    return { ok: false, reason: 'missing', configured };
}

/**
 * Why a configured g++ path cannot be used, in a few words for a message.
 * @param {'not-on-path'|'missing'|'folder'|string} reason
 * @returns {string}
 */
function describeGppProblem(reason) {
    if (reason === 'not-on-path') return 'no such command on PATH';
    if (reason === 'folder') return 'that folder has no g++ in it';
    return 'that file does not exist';
}

/**
 * Which g++ a run uses: the `tcToolkit.compiler.gppPath` setting when it is set (see
 * `checkConfiguredGpp`), else detection. A set value that does not work is reported, never replaced.
 * @param {{configured: unknown, platform: string, env: Record<string, string|undefined>, exists: (p: string) => boolean,
 *   isDir?: (p: string) => boolean}} o
 * @returns {{ok: true, path: string, source: 'setting'|'path'|'default'} |
 *   {ok: false, reason: 'not-found'|'setting-missing', configured: string, problem?: string}}
 *   `problem`: for `setting-missing`, checkConfiguredGpp's reason.
 */
function resolveGpp(o) {
    const checked = checkConfiguredGpp(o.configured, o);
    if (checked.ok === true) return { ok: true, path: checked.path, source: 'setting' };
    if (checked.reason !== 'empty') return { ok: false, reason: 'setting-missing', configured: checked.configured, problem: checked.reason };
    const hit = detectGpp(o);
    return hit ? { ok: true, path: hit.path, source: hit.source } : { ok: false, reason: 'not-found', configured: '' };
}

/**
 * What the start page shows for the g++ path setting. Reads only: detection here never writes the
 * setting (that is `twincat.detectGpp`), and a set value is checked exactly as a build checks it.
 * @param {unknown} value The `tcToolkit.compiler.gppPath` setting.
 * @param {{platform: string, env: Record<string, string|undefined>, exists: (p: string) => boolean,
 *   isDir?: (p: string) => boolean}} o
 * @returns {{state: 'set'|'invalid'|'detected'|'notFound', configured: string, path: string,
 *   source?: 'path'|'default', problem?: 'not-on-path'|'missing'|'folder'}}
 *   `set`: the value works (`path`: the g++ it runs, which differs for a bare name or a folder);
 *   `invalid`: set but unusable (`problem`); `detected`: empty, and a build would use `path`
 *   (found on `PATH` or in a usual install folder: `source`); `notFound`: empty, and nothing found.
 */
function describeGppSetting(value, o) {
    const checked = checkConfiguredGpp(value, o);
    if (checked.ok === true) return { state: 'set', configured: normalizeGppSetting(value), path: checked.path };
    if (checked.reason !== 'empty') {
        return { state: 'invalid', configured: checked.configured, path: '', problem: /** @type {'not-on-path'|'missing'|'folder'} */ (checked.reason) };
    }
    const hit = detectGpp(o);
    return hit ? { state: 'detected', configured: '', path: hit.path, source: hit.source } : { state: 'notFound', configured: '', path: '' };
}

/**
 * The real platform, environment and file checks, as the functions above take them.
 * @returns {{platform: string, env: Record<string, string|undefined>, exists: (p: string) => boolean, isDir: (p: string) => boolean}}
 */
function thisMachine() {
    return {
        platform: process.platform, env: process.env,
        exists: (/** @type {string} */ p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } },
        isDir: (/** @type {string} */ p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
    };
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
 * @typedef {Object} GppPosition A place g++ names as context of a message.
 * @property {string} file As g++ printed it.
 * @property {number} line
 * @property {number} column 0 when not given.
 * @property {'required'|'include'} kind `required`: an instantiation point (`required from here`,
 *   `required from '…'`); `include`: a line of the `In file included from` chain.
 */

/**
 * @typedef {Object} GppMessage One message of g++'s output.
 * @property {string|null} file As g++ printed it (null for a message that names no file).
 * @property {number} line 1-based; 0 when unknown.
 * @property {number} column 1-based; 0 when unknown.
 * @property {'error'|'warning'} severity
 * @property {string} message
 * @property {Array<{file: string|null, line: number, column: number, message: string}>} notes The
 *   `note:` lines that follow it.
 * @property {GppPosition[]} context The instantiation and include chain g++ printed before it,
 *   innermost first.
 * @property {string} [instantiation] `In instantiation of '…'`, when g++ said so.
 */

/** `file:line:col: severity: message` (column optional; a Windows drive letter is part of `file`). */
const GPP_LINE_RE = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/;
/** `g++: error: …`, `cc1plus: fatal error: …`: a message with no position. */
const GPP_GENERAL_RE = /^([^:\s][^:]*?):\s*(fatal error|error|warning|note):\s*(.*)$/;
/** `file:line:col:   required from here` / `required from '…'` / `required by substitution of '…'`. */
const GPP_REQUIRED_RE = /^(.+?):(\d+):(?:(\d+):)?\s+required (?:from|by substitution of) /;
/** The first line of an include chain, and its continuation lines. */
const GPP_INCLUDED_RE = /^In file included from (.+?):(\d+)(?::(\d+))?[:,]$/;
const GPP_FROM_RE = /^\s+from (.+?):(\d+)(?::(\d+))?[:,]$/;
/** `file: In instantiation of '…':` (and `In function`, `In member function`, …). */
const GPP_IN_RE = /^(.+?): In (instantiation of|[a-z ]*function|constructor|destructor|substitution of) (.*):$/;

/**
 * Reads g++'s messages. Source excerpts and carets are skipped; each `note:` is kept with the
 * message before it; the include chain (`In file included from`) and the instantiation chain
 * (`required from here`) are kept as the message's `context`, so a message g++ raises inside a
 * runtime header can still be placed on the generated line that caused it.
 * @param {string} text g++'s stderr.
 * @returns {GppMessage[]}
 */
function parseGppOutput(text) {
    /** @type {GppMessage[]} */
    const out = [];
    /** @type {GppPosition[]} The instantiation context of the next message. */
    let required = [];
    /** @type {string} */
    let instantiation = '';
    /** @type {GppPosition[]|null} An include chain whose header is not known yet. */
    let pendingInclude = null;
    /** @type {Map<string, GppPosition[]>} Each header's include chain (g++ prints it once per header). */
    const includes = new Map();
    const pos = (/** @type {RegExpExecArray} */ m, /** @type {'required'|'include'} */ kind) =>
        ({ file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : 0, kind });
    const settleInclude = (/** @type {string} */ file) => {
        if (pendingInclude) { includes.set(file, pendingInclude); pendingInclude = null; }
    };
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (!line) continue;
        let c = GPP_INCLUDED_RE.exec(line);
        if (c) { pendingInclude = [pos(c, 'include')]; continue; }
        c = GPP_FROM_RE.exec(line);
        if (c) { if (pendingInclude) pendingInclude.push(pos(c, 'include')); continue; }
        if (/^\s/.test(line)) continue;
        c = GPP_IN_RE.exec(line);
        if (c) {
            settleInclude(c[1]);
            required = [];
            instantiation = c[2] === 'instantiation of' ? c[3] : '';
            continue;
        }
        c = GPP_REQUIRED_RE.exec(line);
        if (c) { required.push(pos(c, 'required')); continue; }
        /** @type {string|null} */
        let file;
        let ln = 0;
        let col = 0;
        let kind;
        let message;
        const m = GPP_LINE_RE.exec(line);
        if (m) {
            file = m[1]; ln = Number(m[2]); col = m[3] ? Number(m[3]) : 0; kind = m[4]; message = m[5];
            settleInclude(file);
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
        /** @type {GppMessage} */
        const msg = { file, line: ln, column: col, severity: kind === 'warning' ? 'warning' : 'error', message, notes: [],
            context: [...required, ...((file && includes.get(file)) || [])] };
        if (instantiation) msg.instantiation = instantiation;
        out.push(msg);
        required = [];
        instantiation = '';
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
 * g++ put it. One anywhere else (a runtime header) goes where its context points into the generated
 * files — the innermost instantiation point (`required from here`) first, then the innermost
 * `#include` — and names the header it was seen in; with no such context, or no file at all, it
 * goes on the `.cpp`'s first line.
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
        const context = m.context || [];
        const at = context.find(c => c.kind === 'required' && resolveFile(c.file))
            || context.find(c => c.kind === 'include' && resolveFile(c.file));
        const where = m.file
            ? ` (in ${p.basename(m.file)}${m.line ? `:${m.line}` : ''}${m.instantiation ? `, in instantiation of ${m.instantiation}` : ''})`
            : '';
        if (at) {
            return { filePath: /** @type {string} */ (resolveFile(at.file)), line: Math.max(at.line, 1), column: Math.max(at.column, 1),
                severity: m.severity, message: m.message + where, notes };
        }
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
    const run = await runChild(spawn, o.gppPath, o.args, { cwd: o.cwd, timeoutMs, onCancel: o.onCancel, env, killTree: true });
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
    windowsGppLocations, gppCandidates, detectGpp, checkConfiguredGpp, describeGppProblem, resolveGpp,
    normalizeGppSetting, describeGppSetting, thisMachine,
    buildGppArgs, parseGppOutput, placeGppMessages, runGpp, summarizeGpp
};
