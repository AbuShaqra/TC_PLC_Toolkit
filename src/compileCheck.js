/**
 * @file compileCheck.js
 * @description The vscode-free half of Compile Project (roadmap R3.2): find out whether an external
 * IEC 61131-3 compiler can run, turn a PLC project's objects into check units, run the compiler's
 * check-only mode as a CHILD PROCESS, read its JSON report, and map every diagnostic back to a
 * file, component, pane and line.
 *
 * Constraints this module keeps:
 *   - The compiler is a separate program. It is never `require()`d: its licence differs from this
 *     extension's, and it needs Node 22+, which the extension host may not be. It is started with
 *     a Node.js 22+ executable that is found (see nodeCandidates) or named by the user,
 *     version-checked first. The compiler itself ships with the extension (resources/compiler/,
 *     written by scripts/vendor-compiler.js); the `twincat.compiler.path` setting overrides it.
 *   - Check only. The units are written to a temporary directory that is deleted when the run ends,
 *     however it ends; nothing is written into the project.
 *   - It cannot hang: every child process has a timeout and the run can be cancelled.
 *   - Nothing is suppressed silently. Both filters are counted and the counts are returned: the
 *     pragma-skipped warnings, and the library filter of src/libraryDecls.js (an error that a
 *     symbol is undeclared, when that symbol is a known library name the project does not declare).
 *   - Library declarations (src/libraryDecls.js) are extra inputs written into the SAME temporary
 *     directory, so they are deleted with it; their own messages are returned apart, never placed
 *     on the user's code.
 *
 * Everything that touches the outside (spawn, the file system, the temp directory) is injected, so
 * test/test_compile_check.js drives the same code with a fake child process.
 */

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCheckUnit, mapUnitPosition } = require('./checkUnit');

/** The oldest Node major version the compiler runs on. */
const MIN_NODE_MAJOR = 22;

/** How long `node --version` may take before the executable is treated as unusable. */
const NODE_PROBE_TIMEOUT_MS = 10000;

/** How long one check may run before it is stopped. */
const DEFAULT_CHECK_TIMEOUT_MS = 120000;

/** The settings section and keys (package.json `contributes.configuration`). */
const COMPILER_SECTION = 'twincat.compiler';
const SETTING_COMPILER_PATH = 'twincat.compiler.path';
const SETTING_NODE_PATH = 'twincat.compiler.nodePath';

/**
 * Warnings the compiler prints for every pragma it skips (`{attribute '…'}`, `{region}` …). A
 * TwinCAT project carries one on most objects, so they are noise here; they are filtered and counted.
 */
const PRAGMA_SKIPPED_RE = /^Pragma ignored:/;

/**
 * @typedef {Object} ChildLike The part of a ChildProcess this module uses.
 * @property {{on: (event: string, cb: (chunk: any) => void) => any}|null} stdout
 * @property {{on: (event: string, cb: (chunk: any) => void) => any}|null} stderr
 * @property {(event: string, cb: (...args: any[]) => void) => any} on
 * @property {(signal?: any) => any} kill
 */

/**
 * @typedef {(command: string, args: string[], options: Object) => ChildLike} SpawnLike
 */

/**
 * Reads a `node --version` answer.
 * @param {string} text e.g. `v22.11.0`.
 * @returns {{major: number, text: string}|null}
 */
function parseNodeVersion(text) {
    const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
    return m ? { major: Number(m[1]), text: `${m[1]}.${m[2]}.${m[3]}` } : null;
}

/**
 * Runs a child process to its end, collecting its output. Never rejects and never hangs: a spawn
 * failure, a timeout and a cancellation each resolve with their own `outcome`.
 * @param {SpawnLike} spawn
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Object<string, string|undefined>, timeoutMs: number, onCancel?: (cancel: () => void) => void}} options
 *   `env` replaces the inherited environment; omitted, the child inherits this process's.
 * @returns {Promise<{outcome: 'exit'|'spawn-error'|'timeout'|'cancelled', code: number|null,
 *   stdout: string, stderr: string, error: string}>}
 */
function runChild(spawn, command, args, options) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        /** @type {any} */
        let timer = null;
        /** @type {ChildLike|null} */
        let child = null;
        const finish = (/** @type {'exit'|'spawn-error'|'timeout'|'cancelled'} */ outcome, /** @type {number|null} */ code, error = '') => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ outcome, code, stdout, stderr, error });
        };
        const stop = (/** @type {'timeout'|'cancelled'} */ outcome) => {
            if (settled) return;
            try { if (child) child.kill(); } catch (e) { /* already gone */ }
            finish(outcome, null);
        };
        try {
            /** @type {Object} */
            const spawnOptions = { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
            if (options.env) /** @type {any} */ (spawnOptions).env = options.env;
            child = spawn(command, args, spawnOptions);
        } catch (err) {
            finish('spawn-error', null, err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err));
            return;
        }
        if (child.stdout) child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        if (child.stderr) child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (err) => finish('spawn-error', null, err && err.message ? err.message : String(err)));
        child.on('close', (code) => finish('exit', typeof code === 'number' ? code : null));
        timer = setTimeout(() => stop('timeout'), options.timeoutMs);
        if (options.onCancel) options.onCancel(() => stop('cancelled'));
    });
}

/**
 * @typedef {Object} SetupProblem One thing that stops the compiler from running.
 * @property {string} setting The setting that fixes it.
 * @property {string} message What is wrong and what to do, as shown to the user.
 */

/** The extension's root directory (this file is `src/compileCheck.js`). */
const EXTENSION_ROOT = path.join(__dirname, '..');

/** The bundled compiler, relative to the extension root (written by scripts/vendor-compiler.js). */
const BUNDLED_COMPILER = path.join('resources', 'compiler', 'compiler.cjs');

/**
 * Where the compiler that ships with the extension sits.
 * @param {string} [extensionRoot]
 * @returns {string}
 */
function bundledCompilerPath(extensionRoot = EXTENSION_ROOT) {
    return path.join(extensionRoot, BUNDLED_COMPILER);
}

/**
 * The compiler a run uses: the `twincat.compiler.path` setting when it is set (an override), else
 * the bundled one.
 * @param {string|undefined|null} settingValue
 * @param {string} [extensionRoot]
 * @returns {{path: string, bundled: boolean}}
 */
function resolveCompilerPath(settingValue, extensionRoot) {
    const p = String(settingValue || '').trim();
    return p ? { path: p, bundled: false } : { path: bundledCompilerPath(extensionRoot), bundled: true };
}

/**
 * Whether the compiler a run would use exists — the cheap, synchronous part of the setup check,
 * which is all the start page's tile needs. With the setting empty that is the bundled compiler, so
 * this is false only for an override that points at a missing file (or a damaged installation).
 * @param {string|undefined|null} compilerSetting The `twincat.compiler.path` setting.
 * @param {{exists?: (p: string) => boolean, extensionRoot?: string}} [deps]
 * @returns {boolean}
 */
function isCompilerAvailable(compilerSetting, deps = {}) {
    const exists = deps.exists || ((p) => fs.existsSync(p));
    try { return exists(resolveCompilerPath(compilerSetting, deps.extensionRoot).path); } catch (e) { return false; }
}

/**
 * @typedef {Object} NodeCandidate One place a Node.js executable may be.
 * @property {string} command What is started.
 * @property {string} label How messages name it.
 * @property {boolean} mustExist It is a file path, checked before it is run (`node` on PATH is not).
 * @property {boolean} explicit It is the `twincat.compiler.nodePath` setting.
 * @property {Object<string, string>} [env] Variables added to the inherited environment.
 */

/**
 * @typedef {Object} NodeDiscovery What Node discovery looks at; injected by tests.
 * @property {string} [platform] `process.platform`.
 * @property {Object<string, string|undefined>} [env] `process.env`.
 * @property {{execPath: string, nodeVersion: string}|null} [runtime] The editor's own runtime
 *   (`process.execPath`, `process.versions.node`); `null` leaves it out.
 */

/**
 * Where to look for Node.js, in order. The `twincat.compiler.nodePath` setting, when set, is the
 * ONLY candidate: a configured path that does not work is reported, never silently replaced.
 * Otherwise: `node` on PATH; on Windows the usual install locations (the Node.js installer,
 * nvm-windows, Volta, fnm), which an editor started from the Start menu may not have on its PATH;
 * last, the editor's own runtime run as Node (`ELECTRON_RUN_AS_NODE=1`), only when it is Node 22+.
 * @param {string} configuredNode The setting, trimmed.
 * @param {NodeDiscovery} discovery
 * @returns {NodeCandidate[]}
 */
function nodeCandidates(configuredNode, discovery) {
    if (configuredNode) {
        return [{ command: configuredNode, label: `"${configuredNode}" (setting "${SETTING_NODE_PATH}")`, mustExist: true, explicit: true }];
    }
    const platform = discovery.platform || process.platform;
    const env = discovery.env || process.env;
    /** @type {NodeCandidate[]} */
    const list = [{ command: 'node', label: `"node" on PATH (the setting "${SETTING_NODE_PATH}" is empty)`, mustExist: false, explicit: false }];
    if (platform === 'win32') {
        const win = path.win32;
        /** @type {Array<[string|undefined, string[], string]>} [base dir, rest of the path, where it comes from] */
        const places = [
            [env.ProgramFiles, ['nodejs', 'node.exe'], 'the Node.js installer'],
            [env.ProgramW6432, ['nodejs', 'node.exe'], 'the Node.js installer'],
            [env['ProgramFiles(x86)'], ['nodejs', 'node.exe'], 'the Node.js installer'],
            [env.NVM_SYMLINK, ['node.exe'], 'nvm-windows'],
            [env.VOLTA_HOME, ['bin', 'node.exe'], 'Volta'],
            [env.LOCALAPPDATA, ['Volta', 'bin', 'node.exe'], 'Volta'],
            [env.ProgramFiles, ['Volta', 'node.exe'], 'Volta'],
            [env.FNM_DIR, ['aliases', 'default', 'node.exe'], 'fnm'],
            [env.APPDATA, ['fnm', 'aliases', 'default', 'node.exe'], 'fnm']
        ];
        for (const [base, rest, source] of places) {
            if (base && String(base).trim()) {
                const file = win.join(String(base).trim(), ...rest);
                list.push({ command: file, label: `"${file}" (${source})`, mustExist: true, explicit: false });
            }
        }
    }
    const runtime = discovery.runtime === undefined
        ? { execPath: process.execPath, nodeVersion: process.versions.node } : discovery.runtime;
    const runtimeVersion = runtime ? parseNodeVersion(runtime.nodeVersion) : null;
    if (runtime && runtime.execPath && runtimeVersion && runtimeVersion.major >= MIN_NODE_MAJOR) {
        list.push({ command: runtime.execPath, label: 'the editor\'s own runtime', mustExist: false, explicit: false, env: { ELECTRON_RUN_AS_NODE: '1' } });
    }
    // One probe per executable (Windows paths compare without case).
    const seen = new Set();
    return list.filter((c) => {
        const key = platform === 'win32' ? c.command.toLowerCase() : c.command;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Finds a Node.js new enough to run the compiler: tries each candidate in order and takes the
 * first whose `--version` is Node 22 or newer.
 * @param {string} configuredNode The `twincat.compiler.nodePath` setting, trimmed.
 * @param {{spawn: SpawnLike, exists: (p: string) => boolean, timeoutMs?: number} & NodeDiscovery} deps
 * @returns {Promise<{ok: true, command: string, env: Object<string, string>|undefined, version: string, label: string}
 *   | {ok: false, problem: SetupProblem}>}
 */
async function findNode(configuredNode, deps) {
    const fixNode = `Install Node.js ${MIN_NODE_MAJOR} or newer, or set "${SETTING_NODE_PATH}" to a Node.js ${MIN_NODE_MAJOR}+ executable.`;
    /** @type {string[]} */
    const tried = [];
    let skippedAbsent = 0;
    for (const c of nodeCandidates(configuredNode, deps)) {
        if (c.mustExist) {
            let present;
            try { present = deps.exists(c.command); } catch (e) { present = false; }
            if (!present) {
                if (c.explicit) tried.push(`The Node.js executable ${c.label} does not exist.`);
                else skippedAbsent++;
                continue;
            }
        }
        const env = c.env ? { ...(deps.env || process.env), ...c.env } : undefined;
        const probe = await runChild(deps.spawn, c.command, ['--version'], { timeoutMs: deps.timeoutMs || NODE_PROBE_TIMEOUT_MS, env });
        const version = probe.outcome === 'exit' && probe.code === 0 ? parseNodeVersion(probe.stdout) : null;
        if (probe.outcome === 'spawn-error') {
            tried.push(`Node.js could not be started: ${c.label} — ${probe.error}.`);
        } else if (probe.outcome === 'timeout') {
            tried.push(`${c.label} did not answer "--version" in time, so it cannot be used as Node.js.`);
        } else if (!version) {
            tried.push(`${c.label} is not a Node.js executable (it did not report a version).`);
        } else if (version.major < MIN_NODE_MAJOR) {
            tried.push(`Node.js ${version.text} was found at ${c.label}, but the compiler needs Node.js ${MIN_NODE_MAJOR} or newer.`);
        } else {
            return { ok: true, command: c.command, env: c.env, version: version.text, label: c.label };
        }
    }
    const lead = tried.length > 1 || skippedAbsent > 0 ? `No Node.js ${MIN_NODE_MAJOR} or newer was found to run the compiler. ` : '';
    const absent = skippedAbsent > 0 ? ' The usual install locations (Node.js installer, nvm-windows, Volta, fnm) hold no Node.js.' : '';
    return { ok: false, problem: { setting: SETTING_NODE_PATH, message: `${lead}${tried.join(' ')}${absent} ${fixNode}` } };
}

/**
 * Checks everything Compile Project needs before it starts: the compiler file (the bundled one,
 * unless the setting overrides it), and a Node executable new enough to run it. Reports EVERY
 * problem found, each with the setting that fixes it, so the user is not sent round the loop once
 * per problem.
 * @param {{compilerPath?: string, nodePath?: string}} settings
 * @param {{spawn?: SpawnLike, exists?: (p: string) => boolean, timeoutMs?: number, extensionRoot?: string} & NodeDiscovery} [deps]
 * @returns {Promise<{ok: boolean, problems: SetupProblem[], nodeCommand: string, nodeEnv: Object<string, string>|undefined,
 *   nodeVersion: string, nodeLabel: string, compilerPath: string, compilerBundled: boolean}>}
 */
async function checkSetup(settings, deps = {}) {
    const spawn = deps.spawn || /** @type {SpawnLike} */ (/** @type {any} */ (childProcess.spawn));
    const exists = deps.exists || ((p) => fs.existsSync(p));
    /** @type {SetupProblem[]} */
    const problems = [];

    const compiler = resolveCompilerPath(settings && settings.compilerPath, deps.extensionRoot);
    let compilerPresent;
    try { compilerPresent = exists(compiler.path); } catch (e) { compilerPresent = false; }
    if (!compilerPresent) {
        problems.push({
            setting: SETTING_COMPILER_PATH,
            message: compiler.bundled
                ? `The compiler that ships with the extension is missing ("${compiler.path}"). Reinstall the extension, or set "${SETTING_COMPILER_PATH}" to a compiler's command-line file.`
                : `The compiler file "${compiler.path}" (setting "${SETTING_COMPILER_PATH}") does not exist. Correct the path, or clear the setting to use the compiler that ships with the extension.`
        });
    }

    const node = await findNode(String((settings && settings.nodePath) || '').trim(), { ...deps, spawn, exists });
    if (node.ok === false) problems.push(node.problem);

    return {
        ok: problems.length === 0, problems,
        nodeCommand: node.ok ? node.command : '', nodeEnv: node.ok ? node.env : undefined,
        nodeVersion: node.ok ? node.version : '', nodeLabel: node.ok ? node.label : '',
        compilerPath: compiler.path, compilerBundled: compiler.bundled
    };
}

/**
 * @typedef {Object} CheckInput One object of the project, as the check sees it.
 * @property {string} filePath The object's file on disk.
 * @property {string} name The unit's file name in the temporary directory (`1.st`, `2.st` …).
 * @property {import('./checkUnit').CheckUnit} unit
 * @property {any} parsed The parsed object the unit was built from.
 */

/**
 * Builds the check units of a project.
 * @param {Array<{filePath: string, text: string}>} files Each object's file and CURRENT text (with
 *   unsaved edits applied by the caller).
 * @param {(xmlText: string) => any} parse `parseTwinCatXml`, injected to keep this module's
 *   dependency on the XML layer explicit.
 * @returns {{inputs: CheckInput[], unparsed: string[], skipped: string[]}} `unparsed` lists files
 *   that are not TwinCAT objects the converter understands; `skipped` lists members left out.
 */
function buildCheckInputs(files, parse) {
    /** @type {CheckInput[]} */
    const inputs = [];
    /** @type {string[]} */
    const unparsed = [];
    /** @type {string[]} */
    const skipped = [];
    for (const file of files || []) {
        let parsed;
        try { parsed = parse(file.text); } catch (e) { parsed = null; }
        const unit = parsed ? buildCheckUnit(parsed) : null;
        if (!unit) { unparsed.push(file.filePath); continue; }
        // Short numbered names: the compiler reports the file as given on the command line, two
        // objects may share a basename, and a long project must still fit a Windows command line.
        inputs.push({ filePath: file.filePath, name: `${inputs.length + 1}.st`, unit, parsed });
        skipped.push(...unit.skipped);
    }
    return { inputs, unparsed, skipped };
}

/**
 * @typedef {Object} ExtraInput A generated input that is not a project object (library
 *   declarations, src/libraryDecls.js).
 * @property {string} name File name in the temporary directory; must not be `<n>.st`.
 * @property {string} text
 * @property {string|null} globalListName
 */

/**
 * The compiler's command line for one check (everything after the Node executable).
 * @param {{compilerPath: string, dialectFile: string, inputs: Array<{name: string, unit: {globalListName: string|null}}>,
 *   extraFiles?: ExtraInput[]}} o
 * @returns {string[]}
 */
function buildCheckArgs(o) {
    const args = [o.compilerPath, '--check', '--json', '--dialect-file', o.dialectFile];
    const extra = o.extraFiles || [];
    for (const file of extra) args.push(file.name);
    for (const input of o.inputs) args.push(input.name);
    // A global variable list is addressed by its TwinCAT name (`GVL_Io.bIn`), not by a file stem.
    for (const file of extra) {
        if (file.globalListName) args.push('--global-list', `${file.name}=${file.globalListName}`);
    }
    for (const input of o.inputs) {
        if (input.unit.globalListName) args.push('--global-list', `${input.name}=${input.unit.globalListName}`);
    }
    return args;
}

/**
 * @typedef {Object} RawDiagnostic One entry of the compiler's report.
 * @property {string|null} file
 * @property {number} line
 * @property {number} column
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {number} [endLine]
 * @property {number} [endColumn]
 * @property {string} [code]
 */

/**
 * Reads the compiler's `--check --json` output.
 * @param {string} stdout What the compiler printed on stdout.
 * @param {number|null} exitCode 0 = no errors, 1 = errors, 2 = the check could not run.
 * @param {string} [stderr]
 * @returns {{ok: true, diagnostics: RawDiagnostic[], dialect: string|null} | {ok: false, message: string}}
 */
function parseCheckOutput(stdout, exitCode, stderr = '') {
    const tail = (/** @type {string} */ text) => String(text || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
    /** @type {any} */
    let report;
    try { report = JSON.parse(String(stdout || '')); } catch (e) { report = null; }
    const shaped = report && typeof report === 'object' && Array.isArray(report.diagnostics);
    if (exitCode === 2) {
        const first = shaped ? report.diagnostics.find((/** @type {any} */ d) => d && typeof d.message === 'string') : null;
        return { ok: false, message: `The compiler could not run the check: ${first ? first.message : (tail(stderr) || 'no reason given')}` };
    }
    if (exitCode !== 0 && exitCode !== 1) {
        return { ok: false, message: `The compiler stopped unexpectedly (exit code ${exitCode === null ? 'none' : exitCode})` + (tail(stderr) ? `: ${tail(stderr)}` : '.') };
    }
    if (!shaped) {
        return { ok: false, message: 'The compiler\'s output could not be read (it is not the expected JSON report)' + (tail(stderr) ? `: ${tail(stderr)}` : '.') };
    }
    /** @type {RawDiagnostic[]} */
    const diagnostics = [];
    for (const d of report.diagnostics) {
        if (!d || typeof d !== 'object' || typeof d.message !== 'string') continue;
        diagnostics.push({
            file: typeof d.file === 'string' ? d.file : null,
            line: Number(d.line) || 0,
            column: Number(d.column) || 0,
            // Anything that is not plainly a warning or a note counts as an error: an unknown
            // severity must not make a problem look milder than it is.
            severity: d.severity === 'warning' ? 'warning' : (d.severity === 'info' ? 'info' : 'error'),
            message: d.message,
            endLine: Number(d.endLine) || undefined,
            endColumn: Number(d.endColumn) || undefined,
            code: typeof d.code === 'string' ? d.code : undefined
        });
    }
    // Exit code 1 says "errors"; a report that shows none is not a clean result.
    if (exitCode === 1 && !diagnostics.some(d => d.severity === 'error')) {
        return { ok: false, message: 'The compiler reported errors (exit code 1) but its report lists none.' };
    }
    return { ok: true, diagnostics, dialect: typeof report.dialect === 'string' ? report.dialect : null };
}

/**
 * @typedef {Object} CompileDiagnostic A compiler diagnostic placed in a pane.
 * @property {string} filePath The TwinCAT object file.
 * @property {string} componentId
 * @property {'decl'|'impl'} pane
 * @property {number} line 1-based pane line.
 * @property {number} column 1-based.
 * @property {number} endLine
 * @property {number} endColumn
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {boolean} exact False when the position is an approximation (see mapUnitPosition).
 */

/**
 * Places the compiler's diagnostics in the panes.
 * @param {RawDiagnostic[]} diagnostics
 * @param {CheckInput[]} inputs The inputs of the same run.
 * @param {{extraFiles?: ExtraInput[], libraryFilter?: {select: (d: RawDiagnostic[]) => Set<any>}}} [options]
 * @returns {{diagnostics: CompileDiagnostic[], general: RawDiagnostic[], filteredPragmaWarnings: number,
 *   filteredLibraryDiagnostics: number, libraryMessages: RawDiagnostic[]}}
 *   `general` holds diagnostics that name no input file (they cannot be placed, and are still
 *   reported); `filteredPragmaWarnings` counts the pragma-skipped warnings that were dropped;
 *   `filteredLibraryDiagnostics` the errors the library filter dropped; `libraryMessages` are the
 *   compiler's messages about the generated library declarations themselves.
 */
function mapCheckDiagnostics(diagnostics, inputs, options = {}) {
    const byName = new Map(inputs.map(i => [i.name, i]));
    const extraNames = new Set((options.extraFiles || []).map(f => f.name));
    const fileOf = (/** @type {RawDiagnostic} */ d) => (d.file ? path.basename(d.file.replace(/\\/g, '/')) : '');
    /** @type {CompileDiagnostic[]} */
    const mapped = [];
    /** @type {RawDiagnostic[]} */
    const general = [];
    /** @type {RawDiagnostic[]} */
    const libraryMessages = [];
    let filteredPragmaWarnings = 0;
    let filteredLibraryDiagnostics = 0;
    // The library filter looks at the user's diagnostics only, all together (see libraryDecls.js).
    const onUserCode = (diagnostics || []).filter(d => d.file && (byName.has(d.file) || byName.has(fileOf(d))));
    const dropped = options.libraryFilter ? options.libraryFilter.select(onUserCode) : new Set();
    for (const d of diagnostics || []) {
        if (d.severity === 'warning' && PRAGMA_SKIPPED_RE.test(d.message)) { filteredPragmaWarnings++; continue; }
        if (d.file && extraNames.has(fileOf(d))) { libraryMessages.push(d); continue; }
        if (dropped.has(d)) { filteredLibraryDiagnostics++; continue; }
        // The compiler echoes the path it was given; accept a `./` or directory prefix on it.
        const input = d.file ? (byName.get(d.file) || byName.get(fileOf(d))) : null;
        if (!input) { general.push(d); continue; }
        const at = mapUnitPosition(input.unit, d);
        mapped.push({
            filePath: input.filePath, componentId: at.componentId, pane: at.pane, line: at.line, column: at.column,
            endLine: at.endLine, endColumn: at.endColumn, severity: d.severity, message: d.message, exact: at.exact
        });
    }
    return { diagnostics: mapped, general, filteredPragmaWarnings, filteredLibraryDiagnostics, libraryMessages };
}

/**
 * @typedef {Object} CheckResult
 * @property {'done'|'failed'|'cancelled'|'timeout'} status
 * @property {string} message Why the check did not finish (`failed`), else ''.
 * @property {CompileDiagnostic[]} diagnostics
 * @property {RawDiagnostic[]} general
 * @property {number} filteredPragmaWarnings
 * @property {number} filteredLibraryDiagnostics Errors on library symbols the filter dropped.
 * @property {RawDiagnostic[]} libraryMessages The compiler's messages about the generated library
 *   declarations (not the user's code; not counted as errors or warnings).
 * @property {number} errors Errors after mapping (placed + general).
 * @property {number} warnings Warnings after filtering (placed + general).
 * @property {number} durationMs
 */

/**
 * Runs one check: writes the units to a fresh temporary directory, starts the compiler there, reads
 * its report and deletes the directory again — also when the run fails, times out or is cancelled.
 * @param {Object} o
 * @param {string} o.nodeCommand The Node executable (from checkSetup).
 * @param {Object<string, string>} [o.nodeEnv] Variables the Node executable needs (from checkSetup).
 * @param {string} o.compilerPath The compiler's bundled command-line file.
 * @param {string} o.dialectFile The dialect profile to compile under.
 * @param {CheckInput[]} o.inputs
 * @param {ExtraInput[]} [o.extraFiles] Generated library declarations: written into the same
 *   temporary directory as the units, and deleted with it.
 * @param {{select: (d: RawDiagnostic[]) => Set<any>}} [o.libraryFilter] The library filter.
 * @param {number} [o.timeoutMs]
 * @param {(cancel: () => void) => void} [o.onCancel] Receives the function that stops the run.
 * @param {SpawnLike} [o.spawn]
 * @param {string} [o.tmpRoot] Where the temporary directory is created (default: the OS's).
 * @returns {Promise<CheckResult>}
 */
async function runCheck(o) {
    const spawn = o.spawn || /** @type {SpawnLike} */ (/** @type {any} */ (childProcess.spawn));
    const started = Date.now();
    /** @type {(status: CheckResult['status'], message?: string) => CheckResult} */
    const ended = (status, message = '') => ({
        status, message, diagnostics: [], general: [], filteredPragmaWarnings: 0, filteredLibraryDiagnostics: 0,
        libraryMessages: [], errors: 0, warnings: 0,
        durationMs: Date.now() - started
    });
    let dir = '';
    try {
        try {
            dir = fs.mkdtempSync(path.join(o.tmpRoot || os.tmpdir(), 'twincat-compile-'));
            for (const file of o.extraFiles || []) fs.writeFileSync(path.join(dir, file.name), file.text, 'utf8');
            for (const input of o.inputs) fs.writeFileSync(path.join(dir, input.name), input.unit.stText + '\n', 'utf8');
        } catch (err) {
            return ended('failed', `The temporary files for the check could not be written: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}`);
        }
        const run = await runChild(spawn, o.nodeCommand, buildCheckArgs({ compilerPath: o.compilerPath, dialectFile: o.dialectFile, inputs: o.inputs, extraFiles: o.extraFiles }),
            { cwd: dir, timeoutMs: o.timeoutMs || DEFAULT_CHECK_TIMEOUT_MS, onCancel: o.onCancel, env: o.nodeEnv ? { ...process.env, ...o.nodeEnv } : undefined });
        if (run.outcome === 'cancelled') return ended('cancelled');
        if (run.outcome === 'timeout') return ended('timeout', `The compiler did not finish within ${Math.round((o.timeoutMs || DEFAULT_CHECK_TIMEOUT_MS) / 1000)} seconds and was stopped.`);
        if (run.outcome === 'spawn-error') return ended('failed', `The compiler could not be started: ${run.error}`);
        const parsed = parseCheckOutput(run.stdout, run.code, run.stderr);
        if (parsed.ok === false) return ended('failed', parsed.message);
        const mapped = mapCheckDiagnostics(parsed.diagnostics, o.inputs, { extraFiles: o.extraFiles, libraryFilter: o.libraryFilter });
        const all = [...mapped.diagnostics, ...mapped.general];
        return {
            status: 'done', message: '', diagnostics: mapped.diagnostics, general: mapped.general,
            filteredPragmaWarnings: mapped.filteredPragmaWarnings,
            filteredLibraryDiagnostics: mapped.filteredLibraryDiagnostics,
            libraryMessages: mapped.libraryMessages,
            errors: all.filter(d => d.severity === 'error').length,
            warnings: all.filter(d => d.severity === 'warning').length,
            durationMs: Date.now() - started
        };
    } finally {
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
    }
}

/**
 * The one-line result of a check, for the notification and the status bar.
 * @param {{errors: number, warnings: number}} counts
 * @param {string} projectName
 * @returns {string}
 */
function summarize(counts, projectName) {
    const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (counts.errors === 0 && counts.warnings === 0) return `${projectName}: no errors.`;
    if (counts.errors === 0) return `${projectName}: no errors, ${plural(counts.warnings, 'warning')}.`;
    return `${projectName}: ${plural(counts.errors, 'error')}, ${plural(counts.warnings, 'warning')}.`;
}

/** Pane ids → the names the editor shows. */
const PANE_LABELS = Object.freeze({ decl: 'declaration', impl: 'implementation' });

/**
 * A short, human name for where a diagnostic sits: `Extend, implementation line 2`.
 * @param {{componentId: string, pane: 'decl'|'impl', line: number}} d
 * @param {(componentId: string) => string} memberName `memberName` from componentId.js.
 * @returns {string}
 */
function describeLocation(d, memberName) {
    const where = `${PANE_LABELS[d.pane]} line ${d.line}`;
    return d.componentId === 'root' ? where : `${memberName(d.componentId)}, ${where}`;
}

/**
 * The Problems-panel range of a compile diagnostic: the PANE's line and column, 0-based. The
 * panel shows `Ln/Col` from this range, and the user reads the pane, not the XML around it, so the
 * numbers must be the ones the pane's gutter shows (a range inside the XML read as e.g. Ln 23 for
 * implementation line 2). The pane is named in the message, which the panel cannot express.
 * @param {{line: number, column: number, endLine?: number, endColumn?: number}} at 1-based pane position.
 * @returns {{start: {line: number, character: number}, end: {line: number, character: number}}}
 */
function paneRange(at) {
    const line = Math.max(at.line || 1, 1);
    const column = Math.max(at.column || 1, 1);
    let endLine = Math.max(at.endLine || line, 1);
    let endColumn = Math.max(at.endColumn || column, 1);
    if (endLine < line || (endLine === line && endColumn < column)) { endLine = line; endColumn = column; }
    return { start: { line: line - 1, character: column - 1 }, end: { line: endLine - 1, character: endColumn - 1 } };
}

module.exports = {
    MIN_NODE_MAJOR,
    DEFAULT_CHECK_TIMEOUT_MS,
    COMPILER_SECTION,
    SETTING_COMPILER_PATH,
    SETTING_NODE_PATH,
    PANE_LABELS,
    parseNodeVersion,
    runChild,
    BUNDLED_COMPILER,
    bundledCompilerPath,
    resolveCompilerPath,
    isCompilerAvailable,
    nodeCandidates,
    findNode,
    checkSetup,
    buildCheckInputs,
    buildCheckArgs,
    parseCheckOutput,
    mapCheckDiagnostics,
    runCheck,
    summarize,
    describeLocation,
    paneRange
};
