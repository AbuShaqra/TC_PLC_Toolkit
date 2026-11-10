/**
 * @file compileCheck.js
 * @description The vscode-free half of Compile Project (roadmap R3.2): find out whether an external
 * IEC 61131-3 compiler can run, turn a PLC project's objects into check units, run the compiler's
 * check-only mode as a CHILD PROCESS, read its JSON report, and map every diagnostic back to a
 * file, component, pane and line.
 *
 * Constraints this module keeps:
 *   - The compiler is a separate program. It is never `require()`d: its licence differs from this
 *     extension's, and it needs a newer Node than the extension host has. It is started with the
 *     Node executable the user names (or `node` on PATH), version-checked first.
 *   - Check only. The units are written to a temporary directory that is deleted when the run ends,
 *     however it ends; nothing is written into the project.
 *   - It cannot hang: every child process has a timeout and the run can be cancelled.
 *   - Nothing is suppressed silently. The one filter (pragma-skipped warnings) is counted and the
 *     count is returned.
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
 * @param {{cwd?: string, timeoutMs: number, onCancel?: (cancel: () => void) => void}} options
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
            child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Whether a compiler is configured and its file exists — the cheap, synchronous part of the setup
 * check, which is all the start page's tile needs.
 * @param {string|undefined|null} compilerPath The `twincat.compiler.path` setting.
 * @param {(p: string) => boolean} [exists]
 * @returns {boolean}
 */
function isCompilerConfigured(compilerPath, exists = (p) => fs.existsSync(p)) {
    const p = String(compilerPath || '').trim();
    if (!p) return false;
    try { return exists(p); } catch (e) { return false; }
}

/**
 * Checks everything Compile Project needs before it starts: the compiler file, and a Node
 * executable new enough to run it. Reports EVERY problem found, each with the setting that fixes
 * it, so the user is not sent round the loop once per problem.
 * @param {{compilerPath?: string, nodePath?: string}} settings
 * @param {{spawn?: SpawnLike, exists?: (p: string) => boolean, timeoutMs?: number}} [deps]
 * @returns {Promise<{ok: boolean, problems: SetupProblem[], nodeCommand: string, nodeVersion: string, compilerPath: string}>}
 */
async function checkSetup(settings, deps = {}) {
    const spawn = deps.spawn || /** @type {SpawnLike} */ (/** @type {any} */ (childProcess.spawn));
    const exists = deps.exists || ((p) => fs.existsSync(p));
    /** @type {SetupProblem[]} */
    const problems = [];

    const compilerPath = String((settings && settings.compilerPath) || '').trim();
    if (!compilerPath) {
        problems.push({
            setting: SETTING_COMPILER_PATH,
            message: `No compiler is installed: the setting "${SETTING_COMPILER_PATH}" is empty. ` +
                'Set it to the path of the compiler\'s bundled command-line file.'
        });
    } else if (!exists(compilerPath)) {
        problems.push({
            setting: SETTING_COMPILER_PATH,
            message: `The compiler file "${compilerPath}" (setting "${SETTING_COMPILER_PATH}") does not exist.`
        });
    }

    const configuredNode = String((settings && settings.nodePath) || '').trim();
    const nodeCommand = configuredNode || 'node';
    const nodeLabel = configuredNode
        ? `"${configuredNode}" (setting "${SETTING_NODE_PATH}")`
        : `"node" on PATH (the setting "${SETTING_NODE_PATH}" is empty)`;
    const fixNode = `Install Node.js ${MIN_NODE_MAJOR} or newer, or set "${SETTING_NODE_PATH}" to a Node.js ${MIN_NODE_MAJOR}+ executable.`;
    let nodeVersion = '';
    if (configuredNode && !exists(configuredNode)) {
        problems.push({ setting: SETTING_NODE_PATH, message: `The Node.js executable ${nodeLabel} does not exist. ${fixNode}` });
    } else {
        const probe = await runChild(spawn, nodeCommand, ['--version'], { timeoutMs: deps.timeoutMs || NODE_PROBE_TIMEOUT_MS });
        const version = probe.outcome === 'exit' && probe.code === 0 ? parseNodeVersion(probe.stdout) : null;
        if (probe.outcome === 'spawn-error') {
            problems.push({ setting: SETTING_NODE_PATH, message: `Node.js could not be started: ${nodeLabel} — ${probe.error}. ${fixNode}` });
        } else if (probe.outcome === 'timeout') {
            problems.push({ setting: SETTING_NODE_PATH, message: `${nodeLabel} did not answer "--version" in time, so it cannot be used as Node.js. ${fixNode}` });
        } else if (!version) {
            problems.push({ setting: SETTING_NODE_PATH, message: `${nodeLabel} is not a Node.js executable (it did not report a version). ${fixNode}` });
        } else if (version.major < MIN_NODE_MAJOR) {
            problems.push({
                setting: SETTING_NODE_PATH,
                message: `Node.js ${version.text} was found at ${nodeLabel}, but the compiler needs Node.js ${MIN_NODE_MAJOR} or newer. ${fixNode}`
            });
        } else {
            nodeVersion = version.text;
        }
    }

    return { ok: problems.length === 0, problems, nodeCommand, nodeVersion, compilerPath };
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
        let parsed = null;
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
 * The compiler's command line for one check (everything after the Node executable).
 * @param {{compilerPath: string, dialectFile: string, inputs: Array<{name: string, unit: {globalListName: string|null}}>}} o
 * @returns {string[]}
 */
function buildCheckArgs(o) {
    const args = [o.compilerPath, '--check', '--json', '--dialect-file', o.dialectFile];
    for (const input of o.inputs) args.push(input.name);
    // A global variable list is addressed by its TwinCAT name (`GVL_Io.bIn`), not by a file stem.
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
    let report = null;
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
 * @returns {{diagnostics: CompileDiagnostic[], general: RawDiagnostic[], filteredPragmaWarnings: number}}
 *   `general` holds diagnostics that name no input file (they cannot be placed, and are still
 *   reported); `filteredPragmaWarnings` counts the pragma-skipped warnings that were dropped.
 */
function mapCheckDiagnostics(diagnostics, inputs) {
    const byName = new Map(inputs.map(i => [i.name, i]));
    /** @type {CompileDiagnostic[]} */
    const mapped = [];
    /** @type {RawDiagnostic[]} */
    const general = [];
    let filteredPragmaWarnings = 0;
    for (const d of diagnostics || []) {
        if (d.severity === 'warning' && PRAGMA_SKIPPED_RE.test(d.message)) { filteredPragmaWarnings++; continue; }
        // The compiler echoes the path it was given; accept a `./` or directory prefix on it.
        const input = d.file ? (byName.get(d.file) || byName.get(path.basename(d.file.replace(/\\/g, '/')))) : null;
        if (!input) { general.push(d); continue; }
        const at = mapUnitPosition(input.unit, d);
        mapped.push({
            filePath: input.filePath, componentId: at.componentId, pane: at.pane, line: at.line, column: at.column,
            endLine: at.endLine, endColumn: at.endColumn, severity: d.severity, message: d.message, exact: at.exact
        });
    }
    return { diagnostics: mapped, general, filteredPragmaWarnings };
}

/**
 * @typedef {Object} CheckResult
 * @property {'done'|'failed'|'cancelled'|'timeout'} status
 * @property {string} message Why the check did not finish (`failed`), else ''.
 * @property {CompileDiagnostic[]} diagnostics
 * @property {RawDiagnostic[]} general
 * @property {number} filteredPragmaWarnings
 * @property {number} errors Errors after mapping (placed + general).
 * @property {number} warnings Warnings after filtering (placed + general).
 * @property {number} durationMs
 */

/**
 * Runs one check: writes the units to a fresh temporary directory, starts the compiler there, reads
 * its report and deletes the directory again — also when the run fails, times out or is cancelled.
 * @param {Object} o
 * @param {string} o.nodeCommand The Node executable (from checkSetup).
 * @param {string} o.compilerPath The compiler's bundled command-line file.
 * @param {string} o.dialectFile The dialect profile to compile under.
 * @param {CheckInput[]} o.inputs
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
        status, message, diagnostics: [], general: [], filteredPragmaWarnings: 0, errors: 0, warnings: 0,
        durationMs: Date.now() - started
    });
    let dir = '';
    try {
        try {
            dir = fs.mkdtempSync(path.join(o.tmpRoot || os.tmpdir(), 'twincat-compile-'));
            for (const input of o.inputs) fs.writeFileSync(path.join(dir, input.name), input.unit.stText + '\n', 'utf8');
        } catch (err) {
            return ended('failed', `The temporary files for the check could not be written: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}`);
        }
        const run = await runChild(spawn, o.nodeCommand, buildCheckArgs({ compilerPath: o.compilerPath, dialectFile: o.dialectFile, inputs: o.inputs }),
            { cwd: dir, timeoutMs: o.timeoutMs || DEFAULT_CHECK_TIMEOUT_MS, onCancel: o.onCancel });
        if (run.outcome === 'cancelled') return ended('cancelled');
        if (run.outcome === 'timeout') return ended('timeout', `The compiler did not finish within ${Math.round((o.timeoutMs || DEFAULT_CHECK_TIMEOUT_MS) / 1000)} seconds and was stopped.`);
        if (run.outcome === 'spawn-error') return ended('failed', `The compiler could not be started: ${run.error}`);
        const parsed = parseCheckOutput(run.stdout, run.code, run.stderr);
        if (parsed.ok === false) return ended('failed', parsed.message);
        const mapped = mapCheckDiagnostics(parsed.diagnostics, o.inputs);
        const all = [...mapped.diagnostics, ...mapped.general];
        return {
            status: 'done', message: '', diagnostics: mapped.diagnostics, general: mapped.general,
            filteredPragmaWarnings: mapped.filteredPragmaWarnings,
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
    isCompilerConfigured,
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
