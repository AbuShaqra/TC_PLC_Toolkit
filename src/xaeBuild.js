/**
 * @file xaeBuild.js
 * @description The vscode-free half of "Build through XAE" (roadmap R14): the PowerShell driver's
 * argument list, its machine-readable output (JSON lines prefixed `@@TCTK `), the run state those
 * lines build up, and every text the command layer shows about a run.
 *
 * The driver is resources/xae/build-plc-project.ps1, an additive copy of the proven headless builder
 * in `scripts/Build PLC project/`. It drives the TwinCAT XAE Shell over its Automation Interface (COM),
 * which Node cannot do itself (STA thread, message filter), so it runs as a child process:
 *
 *     extension host ─spawn→ powershell.exe -STA -File build-plc-project.ps1 -Json …
 *                                 └─DCOM→ TcXaeShell.exe (NOT a child of powershell.exe)
 *
 * Rules this module keeps:
 *   - **The exit code decides the result** (0 built, 1 compile errors, 2 harness/COM error,
 *     3 built but activation failed or refused, 4 cancelled). Events only explain it; a run whose
 *     events are missing or garbled is still judged by its code.
 *   - **Headless unless asked**: `-ShowWindow` is passed only for `showWindow === true`. The driver
 *     always shows the window during activation, whatever this says (a licence or full-download
 *     dialog under SuppressUI is an invisible hang).
 *   - **A version override only after the user said so, and only for a build**: by default no
 *     `-TcVersion` / `-AllowVersionMismatch`, and the driver picks the shell from the project's own
 *     `.tsproj` / `.tspproj`. The one exception is `shellOverride`: when the project's XAE Shell is not
 *     installed but another is, the command layer asks (one modal, build only) and, on yes, passes
 *     exactly `-TcVersion <that ProgId> -AllowVersionMismatch`. Activation never gets an override.
 *   - **Activation names its target**: `-ActivateConfiguration` only with a well-formed AmsNetId the
 *     user confirmed; the driver still refuses anything that is not a runtime of this machine.
 *   - Parsing never throws: a line that is not a well-formed event of this protocol is a log line.
 *
 * test/test_xae_build.js covers all of it; test/test_xae_driver_contract.js checks the ps1 against it.
 */

'use strict';

const { StringDecoder } = require('string_decoder');
const { countBySeverity } = require('./xaeErrorPlacement');
const { XAE_SHELL_VERSIONS } = require('./xaeShellDetect');

/** The prefix of every machine line the driver writes (`-Json`). */
const PREFIX = '@@TCTK ';

/** The protocol version every event carries as `v`. */
const PROTOCOL = 1;

/** The driver's exit codes. */
const EXIT = Object.freeze({ OK: 0, COMPILE: 1, HARNESS: 2, ACTIVATION: 3, CANCELLED: 4 });

/** Every event type the driver emits and `reduce` handles (test_xae_driver_contract.js checks both ways). */
const EVENT_TYPES = Object.freeze([
    'hello', 'plan', 'shell', 'phase', 'ui', 'warning', 'fatal', 'buildResult', 'errorItem',
    'outputPane', 'target', 'activation', 'targets', 'done'
]);

/**
 * Phases that are never interrupted. `activate`/`restart`/`verify` could leave the runtime in CONFIG;
 * `target` is where the driver disarms its cancel file (right before activation), so a cancel there
 * would be ignored by the driver and could only end in a force stop at the edge of `activate`.
 */
const UNINTERRUPTIBLE_PHASES = Object.freeze(['target', 'activate', 'restart', 'verify']);

/** An AmsNetId: six dot-separated octets. */
const NETID_RE = /^\d{1,3}(\.\d{1,3}){5}$/;

/**
 * Whether a string is a well-formed AmsNetId (six octets, each 0-255).
 * @param {unknown} s
 * @returns {boolean}
 */
function isValidNetId(s) {
    if (typeof s !== 'string' || !NETID_RE.test(s)) return false;
    return s.split('.').every(o => Number(o) <= 255);
}

/**
 * @typedef {Object} DriverArgsOptions
 * @property {string} scriptPath The driver script (resources/xae/build-plc-project.ps1).
 * @property {string} [slnPath] The solution; required except for `listTargets`.
 * @property {'build'|'activate'|'listTargets'} [mode] Default `build`.
 * @property {boolean} [showWindow] Only `true` adds `-ShowWindow`; anything else is headless.
 * @property {string} [configuration]
 * @property {string} [platform]
 * @property {string} [targetNetId] Required for `activate`.
 * @property {string} [cancelFile] The file whose existence asks the driver to stop (exit 4).
 * @property {string} [shellOverride] A known XAE Shell ProgId the user confirmed building with instead
 *   of the project's own (see `missingShell`); `build` mode only.
 */

/**
 * The `powershell.exe` arguments for one run.
 * @param {DriverArgsOptions} o
 * @returns {string[]}
 * @throws {Error} For `activate` without a well-formed NetId, a build without a solution, or a
 *   `shellOverride` that is not a known ProgId or not on a build.
 */
function buildDriverArgs(o) {
    const mode = o.mode || 'build';
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', o.scriptPath];
    if (o.slnPath) args.push('-SlnPath', o.slnPath);
    else if (mode !== 'listTargets') throw new Error('A build through XAE needs a solution (.sln).');
    args.push('-Json');
    if (mode === 'listTargets') {
        args.push('-ListTargets');
        return args;
    }
    if (o.showWindow === true) args.push('-ShowWindow');
    if (o.configuration) args.push('-Configuration', o.configuration);
    if (o.platform) args.push('-Platform', o.platform);
    if (o.shellOverride) {
        if (mode !== 'build') throw new Error('Only a build may run on another XAE Shell than the project\'s.');
        if (!shellByProgId(o.shellOverride)) throw new Error(`Unknown XAE Shell ProgId ${JSON.stringify(o.shellOverride)}.`);
        // A ProgId names a build family: the driver keeps the project's revision and pins the newest
        // installed version of that build. -AllowVersionMismatch is what lets the build differ.
        args.push('-TcVersion', o.shellOverride, '-AllowVersionMismatch');
    }
    if (mode === 'activate') {
        if (!isValidNetId(o.targetNetId)) {
            throw new Error(`Activation needs a valid AmsNetId (got ${JSON.stringify(o.targetNetId || '')}).`);
        }
        args.push('-ActivateConfiguration', '-TargetNetId', /** @type {string} */ (o.targetNetId));
    }
    if (o.cancelFile) args.push('-CancelFile', o.cancelFile);
    return args;
}

/**
 * The shell a ProgId names, from the same table the settings use (test_xae_driver_contract.js pins it
 * to the driver's `$ProgIdByBuild`).
 * @param {unknown} progId
 * @returns {typeof XAE_SHELL_VERSIONS[number]|null}
 */
function shellByProgId(progId) {
    return XAE_SHELL_VERSIONS.find(v => typeof progId === 'string' && v.progId.toLowerCase() === progId.toLowerCase()) || null;
}

/**
 * How a shell is named to the user: 'XAE Shell (4024)', 'XAE Shell 64 (4026)'.
 * @param {typeof XAE_SHELL_VERSIONS[number]} shell
 * @returns {string}
 */
function shellName(shell) {
    return `${shell.name} (${shell.id})`;
}

/**
 * @typedef {Object} MissingShell What to do when the project's XAE Shell is not installed.
 * @property {{progId: string, build: string, name: string}|null} offer The newest installed other
 *   shell to offer (a build only); null when there is nothing to offer.
 * @property {string} question The modal's text (only with `offer`).
 * @property {string} confirmLabel The modal's confirm button (only with `offer`).
 * @property {string} text The error to show when nothing is offered or the offer is declined: which
 *   shell to install.
 */

/**
 * The project's XAE Shell is not installed: whether another installed one can be offered, and the
 * texts. Fed either by the driver's `progid-not-registered` fatal (`{progId, build, projectVersion,
 * installed}`) or by the command layer's pre-check, which knows the same facts.
 * @param {{build?: unknown, progId?: unknown, projectVersion?: unknown, installed?: unknown}} facts
 * @param {{mode: 'build'|'activate', solutionName: string}} o
 * @returns {MissingShell}
 */
function missingShell(facts, o) {
    const f = facts && typeof facts === 'object' ? facts : {};
    const missing = shellByProgId(f.progId) || XAE_SHELL_VERSIONS.find(v => v.id === String(f.build || '')) || null;
    const build = missing ? missing.id : String(f.build || '?');
    const missingName = missing ? shellName(missing) : `XAE Shell (${build})`;
    // PS 5.1 may hand a one-element array over as a bare string.
    const listed = Array.isArray(f.installed) ? f.installed : (typeof f.installed === 'string' ? [f.installed] : []);
    const others = XAE_SHELL_VERSIONS.filter(v => v !== missing && listed.some(p => shellByProgId(p) === v))
        .slice().sort((a, b) => Number(b.id) - Number(a.id));
    const newest = others[0];
    const saved = `${o.solutionName} was saved with TwinCAT 3.1.${build}`;
    const install = `Install ${missingName}${missing ? ` (${missing.progId})` : ''} to build it on this machine.`;
    if (!newest) {
        return { offer: null, question: '', confirmLabel: '', text: `${saved} and its ${missingName} is not installed. ${install}` };
    }
    if (o.mode !== 'build') {
        return {
            offer: null, question: '', confirmLabel: '',
            text: `${saved} and its ${missingName} is not installed. Activation needs the project's own XAE Shell: ${install}`
        };
    }
    const name = shellName(newest);
    return {
        offer: { progId: newest.progId, build: newest.id, name },
        question: `${saved} and its ${missingName} is not installed. Build with ${name} instead? XAE may upgrade the project files.`,
        confirmLabel: `Build with ${newest.name}`,
        text: `${saved} and its ${missingName} is not installed. ${install}`
    };
}

/**
 * Splits a byte stream into lines: UTF-8 decoded across chunk boundaries, `\n` or `\r\n` ends a
 * line, and `end()` delivers a last line that has no newline.
 * @param {(line: string) => void} onLine
 * @returns {{push: (chunk: Buffer|string) => void, end: () => void}}
 */
function createLineSplitter(onLine) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const drain = () => {
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() || '';
        for (const line of parts) onLine(line);
    };
    return {
        push(chunk) {
            pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
            drain();
        },
        end() {
            pending += decoder.end();
            drain();
            const last = pending.replace(/\r$/, '');
            pending = '';
            if (last) onLine(last);
        }
    };
}

/**
 * @typedef {{kind: 'event', event: Object<string, any>}|{kind: 'log', text: string, protocolError?: string}} ParsedLine
 */

/**
 * One output line: a protocol event, or a plain log line. Never throws. A prefixed line that is not
 * a JSON object of this protocol version is returned as a log line with `protocolError` set.
 * @param {string} line
 * @returns {ParsedLine}
 */
function parseLine(line) {
    const text = String(line === undefined || line === null ? '' : line);
    if (!text.startsWith(PREFIX)) return { kind: 'log', text };
    /** @type {any} */
    let event;
    try { event = JSON.parse(text.slice(PREFIX.length)); } catch (e) {
        return { kind: 'log', text, protocolError: 'not JSON' };
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { kind: 'log', text, protocolError: 'not an object' };
    if (event.v !== PROTOCOL) return { kind: 'log', text, protocolError: `protocol version ${JSON.stringify(event.v)}` };
    if (typeof event.t !== 'string') return { kind: 'log', text, protocolError: 'no event type' };
    return { kind: 'event', event };
}

/**
 * @typedef {Object} UiSample The UI state read back from DTE at one point of the run.
 * @property {'headless'|'visible'} requested
 * @property {boolean|null} suppressUI
 * @property {boolean|null} mainWindowVisible
 * @property {string} reason headless | requested | version-switch | build | activation | after-activation
 */

/**
 * @typedef {Object} RunState What one run's output has said so far.
 * @property {string|null} mode build | activate | listTargets (from `hello`).
 * @property {boolean|null} showWindow As the driver understood it (from `hello`).
 * @property {string|null} phase The last `phase` event's name.
 * @property {Object<string, any>|null} plan
 * @property {{pid: number|null, ours: boolean, preexisting: number[]}|null} shell
 * @property {UiSample[]} ui
 * @property {string[]} warnings
 * @property {number} protocolWarnings Prefixed lines that were not events of this protocol.
 * @property {Array<{file: string|null, line: number|null, column: number|null, description: string,
 *   project: string|null, level: string|null}>} errorItems
 * @property {Array<{name: string, text: string, truncated: boolean}>} panes
 * @property {number|null} failedProjects
 * @property {{netId: string, local: boolean, platform: string|null}|null} target
 * @property {boolean} targetMismatch The driver's target readback differs from the confirmed pick.
 * @property {string|null} expectedNetId The NetId the user confirmed (activation only).
 * @property {{netId: string, adsState: number|null, stateName: string|null, outcome: string}|null} activation
 * @property {{local: Array<{netId: string, name: string, kind: string, platform: string|null}>, projectNetId: string|null}|null} targets
 * @property {{code: string, text: string, data?: any}|null} fatal
 * @property {{exitCode: number, ui: any}|null} done
 * @property {string[]} log Plain lines, in order.
 * @property {number|null} lastEventAt `now` of the last line of any kind (the stall watchdog).
 */

/**
 * A fresh run state.
 * @param {{expectedNetId?: string}} [o]
 * @returns {RunState}
 */
function createRunState(o = {}) {
    return {
        mode: null, showWindow: null, phase: null, plan: null, shell: null, ui: [], warnings: [], protocolWarnings: 0,
        errorItems: [], panes: [], failedProjects: null, target: null, targetMismatch: false,
        expectedNetId: o.expectedNetId || null, activation: null, targets: null, fatal: null, done: null, log: [],
        lastEventAt: null
    };
}

/** @param {unknown} v @returns {boolean|null} */
const boolOrNull = (v) => (v === true || v === false ? v : null);
/** @param {unknown} v @returns {string|null} */
const strOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);
/** @param {unknown} v @returns {number|null} */
const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null));

/**
 * Folds one parsed line into the state (mutates and returns it). Unknown event types are ignored.
 * @param {RunState} state
 * @param {ParsedLine} item
 * @param {number} [now] Default `Date.now()`.
 * @returns {RunState}
 */
function reduce(state, item, now = Date.now()) {
    state.lastEventAt = now;
    if (item.kind === 'log') {
        if (item.protocolError) state.protocolWarnings++;
        state.log.push(item.text);
        return state;
    }
    const e = item.event;
    switch (e.t) {
        case 'hello':
            state.mode = strOrNull(e.mode);
            state.showWindow = boolOrNull(e.showWindow);
            break;
        case 'plan':
            state.plan = { ...e };
            delete state.plan.v;
            delete state.plan.t;
            break;
        case 'shell':
            state.shell = {
                pid: numOrNull(e.pid), ours: e.ours === true,
                preexisting: Array.isArray(e.preexisting) ? e.preexisting.map(numOrNull).filter(n => n !== null) : []
            };
            break;
        case 'phase':
            if (typeof e.name === 'string') state.phase = e.name;
            break;
        case 'ui':
            state.ui.push({
                requested: e.requested === 'visible' ? 'visible' : 'headless',
                suppressUI: boolOrNull(e.suppressUI), mainWindowVisible: boolOrNull(e.mainWindowVisible),
                reason: String(e.reason || '')
            });
            break;
        case 'warning':
            if (e.text) state.warnings.push(String(e.text));
            break;
        case 'fatal':
            state.fatal = { code: String(e.code || 'unknown'), text: String(e.text || ''), data: e.data };
            break;
        case 'buildResult':
            state.failedProjects = numOrNull(e.failedProjects);
            break;
        case 'errorItem':
            state.errorItems.push({
                file: strOrNull(e.file), line: numOrNull(e.line), column: numOrNull(e.column),
                description: String(e.description || ''), project: strOrNull(e.project), level: strOrNull(e.level)
            });
            break;
        case 'outputPane':
            state.panes.push({ name: String(e.name || ''), text: String(e.text || ''), truncated: e.truncated === true });
            break;
        case 'target':
            state.target = { netId: String(e.netId || ''), local: e.local === true, platform: strOrNull(e.platform) };
            if (state.expectedNetId && state.target.netId !== state.expectedNetId) state.targetMismatch = true;
            break;
        case 'activation':
            state.activation = {
                netId: String(e.netId || ''), adsState: numOrNull(e.adsState), stateName: strOrNull(e.stateName),
                outcome: String(e.outcome || '')
            };
            break;
        case 'targets':
            state.targets = {
                local: (Array.isArray(e.local) ? e.local : []).filter(t => t && isValidNetId(t.netId)).map(t => ({
                    netId: t.netId, name: String(t.name || t.netId), kind: String(t.kind || ''), platform: strOrNull(t.platform)
                })),
                projectNetId: strOrNull(e.projectNetId)
            };
            break;
        case 'done':
            state.done = { exitCode: numOrNull(e.exitCode), ui: e.ui && typeof e.ui === 'object' ? e.ui : null };
            break;
        default:
            break;
    }
    return state;
}

/**
 * @typedef {Object} ExitDescription
 * @property {boolean} ok The build is good (activation, if asked, too).
 * @property {'info'|'warning'|'error'} severity
 * @property {string} title One sentence for the notification.
 * @property {string} detail More, for the output channel ('' when nothing to add).
 */

/**
 * Whether exit code 1 really is the driver's "compile errors". `powershell.exe -File` also exits 1
 * when the script never ran (an execution policy set by Group Policy, a parameter-binding error), on a
 * throw outside the driver's own handler, or when PowerShell was killed from outside. Only the
 * driver's own report makes it a build result: its `done` with exit code 1, or a failed build count.
 * @param {RunState} state
 * @returns {boolean}
 */
function compileFailureConfirmed(state) {
    return (state.done !== null && state.done.exitCode === EXIT.COMPILE)
        || (typeof state.failedProjects === 'number' && state.failedProjects > 0);
}

/**
 * Whether a finished run reached a build result, so its error list replaces the previous one.
 * A run that stopped earlier says nothing about the code, and the previous problems stay.
 * @param {number|null} code
 * @param {'exit'|'timeout'|'spawn-error'|'killed'} outcome
 * @param {RunState} state
 * @returns {boolean}
 */
function reachedBuildResult(code, outcome, state) {
    if (outcome !== 'exit') return false;
    if (code === EXIT.COMPILE) return compileFailureConfirmed(state);
    return code === EXIT.OK || code === EXIT.ACTIVATION;
}

/**
 * What a finished run means. The exit code decides; the state only explains (and, for exit code 1,
 * confirms: see `compileFailureConfirmed`).
 * @param {number|null} code The driver's exit code (null when it did not exit by itself).
 * @param {'exit'|'timeout'|'spawn-error'|'killed'} outcome How the child ended.
 * @param {RunState} state
 * @param {{error?: string, stderr?: string[], solutionName?: string}} [extra] `error`: the spawn error text; `stderr`:
 *   PowerShell's error lines; `solutionName`: names the solution when the project's XAE Shell is missing.
 * @returns {ExitDescription}
 */
function describeExit(code, outcome, state, extra = {}) {
    if (outcome === 'spawn-error') {
        return { ok: false, severity: 'error', title: 'Could not start PowerShell for the XAE build.', detail: extra.error || '' };
    }
    if (outcome === 'timeout') {
        return { ok: false, severity: 'error', title: 'The XAE build timed out and was stopped.', detail: phaseNote(state) };
    }
    if (outcome === 'killed') {
        return { ok: false, severity: 'warning', title: 'The XAE build was stopped.', detail: phaseNote(state) };
    }
    const known = typeof code === 'number' && code >= 0 && code <= 4;
    if (!known) {
        return {
            ok: false, severity: 'error',
            title: `The XAE build was interrupted before it finished${typeof code === 'number' ? ` (exit code ${code})` : ''}.`,
            detail: phaseNote(state)
        };
    }
    const missing = state.done ? '' : ' The driver\'s final report is missing; the exit code alone decided this result.';
    if (code === EXIT.COMPILE && !compileFailureConfirmed(state)) {
        const stderr = (extra.stderr || []).filter(l => l.trim());
        const lastLog = state.log.filter(l => l.trim()).pop();
        const why = stderr.length ? stderr[stderr.length - 1].trim() : (lastLog ? lastLog.trim() : '');
        return {
            ok: false, severity: 'error',
            title: 'The XAE build was interrupted before it finished (exit code 1).',
            detail: [why, phaseNote(state)].filter(Boolean).join(' ')
        };
    }
    const errorCount = countBySeverity(state.errorItems).errors;
    switch (code) {
        case EXIT.OK: {
            const a = state.activation;
            if (state.mode === 'activate' && a && a.outcome === 'incomplete') {
                return {
                    ok: false, severity: 'warning',
                    title: `Built and activated on ${a.netId}, but its run state could not be read: check the target.`,
                    detail: missing.trim()
                };
            }
            if (state.mode === 'activate' && a && a.outcome === 'run') {
                return { ok: true, severity: 'info', title: `Built, activated and restarted TwinCAT on ${a.netId}: it is in RUN.`, detail: missing.trim() };
            }
            return { ok: true, severity: 'info', title: 'Build through XAE succeeded.', detail: missing.trim() };
        }
        case EXIT.COMPILE:
            return {
                ok: false, severity: 'error',
                title: errorCount > 0 ? `Build through XAE failed: ${errorCount} error${errorCount === 1 ? '' : 's'}.` : 'Build through XAE failed.',
                detail: missing.trim()
            };
        case EXIT.HARNESS:
            if (state.fatal && state.fatal.code === 'progid-not-registered' && extra.solutionName) {
                // Says which shell to install (and, for activation, that another shell cannot stand in).
                const m = missingShell(state.fatal.data, { mode: state.mode === 'activate' ? 'activate' : 'build', solutionName: extra.solutionName });
                return { ok: false, severity: 'error', title: `The XAE build could not run: ${m.text}`, detail: missing.trim() };
            }
            return {
                ok: false, severity: 'error',
                title: `The XAE build could not run${state.fatal && state.fatal.text ? `: ${firstLine(state.fatal.text)}` : '.'}`,
                detail: ((state.fatal && state.fatal.text.includes('\n') ? state.fatal.text : '') + missing).trim()
            };
        case EXIT.ACTIVATION: {
            const a = state.activation;
            const why = a && a.outcome === 'refused' ? 'the target was refused' : (a && a.stateName ? `the target is in ${a.stateName}, not RUN` : 'activation failed');
            return {
                ok: false, severity: 'error',
                title: `The build succeeded, but activation did not: ${why}.`,
                detail: ((state.warnings.length ? state.warnings[state.warnings.length - 1] : '') + missing).trim()
            };
        }
        case EXIT.CANCELLED:
        default:
            return { ok: false, severity: 'warning', title: 'The XAE build was cancelled.', detail: '' };
    }
}

/** @param {string} s @returns {string} */
function firstLine(s) {
    const line = String(s).split(/\r?\n/)[0].trim();
    return /[.!?]$/.test(line) ? line : line + '.';
}

/** @param {RunState} state @returns {string} */
function phaseNote(state) {
    return state.phase ? `Last phase: ${state.phase}.` : '';
}

/** @param {boolean|null|undefined} b @returns {string} */
const psBool = (b) => (b === true ? 'True' : (b === false ? 'False' : 'unreadable'));

/**
 * The UI sample of the build itself: `done.ui.buildPhase`, else the `ui` event with reason `build`.
 * @param {RunState} state
 * @returns {{suppressUI: boolean|null, mainWindowVisible: boolean|null}|null}
 */
function buildPhaseUi(state) {
    const fromDone = state.done && state.done.ui && state.done.ui.buildPhase;
    if (fromDone && typeof fromDone === 'object') {
        return { suppressUI: boolOrNull(fromDone.suppressUI), mainWindowVisible: boolOrNull(fromDone.mainWindowVisible) };
    }
    const sample = state.ui.find(u => u.reason === 'build');
    return sample ? { suppressUI: sample.suppressUI, mainWindowVisible: sample.mainWindowVisible } : null;
}

/**
 * One line saying which UI mode actually ran during the build, from the values read back from DTE.
 * This is how a user verifies on Windows that headless works.
 * @param {RunState} state
 * @returns {string}
 */
function describeUiMode(state) {
    const lead = 'XAE window during the build';
    const requested = state.done && state.done.ui && state.done.ui.requested
        ? state.done.ui.requested
        : (state.showWindow === true ? 'visible' : (state.ui.length ? state.ui[0].requested : 'headless'));
    const sample = buildPhaseUi(state);
    if (!sample || (sample.suppressUI === null && sample.mainWindowVisible === null)) return `${lead}: UI state unreadable.`;
    const values = `(SuppressUI=${psBool(sample.suppressUI)}, MainWindow.Visible=${psBool(sample.mainWindowVisible)})`;
    const keptVisible = !!(state.done && state.done.ui && state.done.ui.versionSwitchKeptVisible)
        || state.ui.some(u => u.reason === 'version-switch');
    const activation = state.done && state.done.ui && state.done.ui.activationShown
        ? ' The window was shown for activation, as it always is.' : '';
    if (sample.mainWindowVisible === null) {
        // MainWindow.Visible is unreadable on the 4026 shell whether the window is shown or not
        // (measured 2026-11-13): report the requested mode and what SuppressUI says, never a guess.
        const unread = `(SuppressUI=${psBool(sample.suppressUI)}; window visibility not readable)`;
        if (requested === 'visible') return `${lead}: visible as requested ${unread}.${activation}`;
        if (keptVisible) return `${lead}: kept visible after a version switch ${unread}.${activation}`;
        if (sample.suppressUI === true) return `${lead}: headless ${unread}.${activation}`;
        return `${lead}: unknown ${unread}.${activation}`;
    }
    if (requested === 'visible') {
        return `${lead}: ${sample.mainWindowVisible === false ? 'hidden although visible was requested' : 'visible (requested)'} ${values}.${activation}`;
    }
    if (sample.mainWindowVisible === false) return `${lead}: hidden ${values} - headless.${activation}`;
    if (sample.mainWindowVisible === true && keptVisible) return `${lead}: visible ${values} - kept visible after a version switch.${activation}`;
    if (sample.mainWindowVisible === true) {
        return `Headless requested but the window was visible during the build ${values}; see HANDOFF Windows check.${activation}`;
    }
    return `${lead}: ${values}.${activation}`;
}

/**
 * Whether a cancel may be sent now: never while the driver activates, restarts or verifies.
 * @param {RunState} state
 * @returns {boolean}
 */
function canCancel(state) {
    return !UNINTERRUPTIBLE_PHASES.includes(state.phase || '');
}

/**
 * Whether a headless run looks stuck: no output for `stallMs`, outside the build itself (which is
 * one blocking COM call) and outside activation (the window is shown then). Never with the window shown.
 * @param {RunState} state
 * @param {number} now
 * @param {{showWindow?: boolean, stallMs: number}} o
 * @returns {boolean}
 */
function isStalled(state, now, o) {
    if (o.showWindow === true) return false;
    if (state.phase === 'build' || UNINTERRUPTIBLE_PHASES.includes(state.phase || '')) return false;
    if (state.lastEventAt === null || state.done) return false;
    return now - state.lastEventAt >= o.stallMs;
}

/**
 * The activation-target QuickPick items: this machine's runtimes, the project's own NetId marked,
 * the last pick first and preselected. Nothing is stored as a setting; `preselect` is a convenience.
 * @param {RunState['targets']} targets
 * @param {{preselect?: string}} [o]
 * @returns {Array<{label: string, description: string, detail: string, netId: string, name: string, picked: boolean}>}
 */
function targetPickItems(targets, o = {}) {
    if (!targets) return [];
    const items = targets.local.map(t => ({
        label: t.name,
        description: t.netId + (targets.projectNetId === t.netId ? ' (project)' : ''),
        detail: `${t.kind === 'real-time' ? 'Real-time runtime' : (t.kind === 'user-mode' ? 'User-mode runtime' : 'Runtime')}` +
            ` on this machine; platform ${t.platform || 'unknown'}`,
        netId: t.netId, name: t.name, picked: !!o.preselect && o.preselect === t.netId
    }));
    items.sort((a, b) => Number(b.picked) - Number(a.picked));
    return items;
}

/**
 * The modal confirmation before an activation, and its confirm button (which names the target).
 * @param {{netId: string, name: string}} target
 * @param {string} solutionName
 * @returns {{message: string, confirmLabel: string}}
 */
function confirmationText(target, solutionName) {
    const where = `${target.name} (${target.netId})`;
    return {
        message: `Build ${solutionName}, activate the configuration on ${where} and restart TwinCAT there? ` +
            'The running PLC on that target stops. The XAE window opens during activation - answer any dialog there.',
        confirmLabel: `Activate on ${where}`
    };
}

module.exports = {
    PREFIX, PROTOCOL, EXIT, EVENT_TYPES, UNINTERRUPTIBLE_PHASES,
    isValidNetId, buildDriverArgs, shellByProgId, missingShell, createLineSplitter, parseLine, createRunState, reduce,
    compileFailureConfirmed, reachedBuildResult, describeExit, describeUiMode, buildPhaseUi, canCancel, isStalled, targetPickItems, confirmationText
};
