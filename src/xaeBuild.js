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
 *   - **Activation installs the boot project** (user decision 2026-11-16): every PLC project goes onto
 *     the target as a boot project with autostart (`bootProject`, then each PLC's state `plcState`).
 *     A missing or failed boot project never fails the activation, and never passes silently either:
 *     the result is a warning saying the PLC must be started from XAE (`describeBootProject`).
 *   - Parsing never throws: a line that is not a well-formed event of this protocol is a log line.
 *
 * test/test_xae_build.js covers all of it; test/test_xae_driver_contract.js checks the ps1 against it.
 */

'use strict';

const { StringDecoder } = require('string_decoder');
const { countBySeverity, isEmptyItem } = require('./xaeErrorPlacement');
const { XAE_SHELL_VERSIONS } = require('./xaeShellDetect');
const { adsDllHint, isNativeDllMissing } = require('./adsDllSettings');

/** The prefix of every machine line the driver writes (`-Json`). */
const PREFIX = '@@TCTK ';

/** The protocol version every event carries as `v`. */
const PROTOCOL = 1;

/** The driver's exit codes. */
const EXIT = Object.freeze({ OK: 0, COMPILE: 1, HARNESS: 2, ACTIVATION: 3, CANCELLED: 4 });

/** Every event type the driver emits and `reduce` handles (test_xae_driver_contract.js checks both ways). */
const EVENT_TYPES = Object.freeze([
    'hello', 'plan', 'shell', 'phase', 'ui', 'warning', 'fatal', 'buildResult', 'errorItem',
    'outputPane', 'errorDetails', 'target', 'activation', 'bootProject', 'plcState', 'targets', 'done'
]);

/**
 * Phases that are never interrupted. `activate`/`boot`/`restart`/`verify` could leave the runtime in CONFIG;
 * `target` is where the driver disarms its cancel file (right before activation), so a cancel there
 * would be ignored by the driver and could only end in a force stop at the edge of `activate`.
 */
const UNINTERRUPTIBLE_PHASES = Object.freeze(['target', 'activate', 'boot', 'restart', 'verify']);

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
 * @property {string} [adsDllDir] The folder holding TcAdsDll.dll (tcToolkit.adsDll.nativeDllFolder);
 *   '' = the driver searches. Every mode: `-ListTargets` reads ADS too (the AmsNetId confirmation).
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
    if (o.adsDllDir) args.push('-AdsDllDir', o.adsDllDir);
    if (mode === 'listTargets') {
        args.push('-ListTargets');
        return args;
    }
    // Another XAE Shell than the project's upgrades the project and usually asks questions: always shown.
    if (o.showWindow === true || o.shellOverride) args.push('-ShowWindow');
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
 * @property {{progId: string, build: string, name: string}|null} offer The newest installed shell of a
 *   NEWER build than the project's, to offer (a build only); null when there is nothing to offer. An
 *   older shell is never offered: it would open a project saved with a newer TwinCAT.
 * @property {string} question The modal's text (only with `offer`).
 * @property {string} confirmLabel The modal's confirm button (only with `offer`).
 * @property {string} text The error to show when nothing is offered or the offer is declined: which
 *   shell to install.
 */

/**
 * The project's XAE Shell is not installed: whether another installed one can be offered, and the
 * texts. Fed either by the driver's `progid-not-registered` fatal (`{progId, build, projectVersion,
 * installed}`) or by the command layer's pre-check, which knows the same facts.
 *
 * Only a NEWER shell is offered (XAE may then upgrade the project files); when only older ones are
 * installed there is no offer, and the text names the shell to install and why the older one is not
 * used. When `projectVersion` names another build than `progId`/`build`, the run was already on a
 * confirmed substitute and THAT shell is not registered: the text says so, and offers nothing.
 * @param {{build?: unknown, progId?: unknown, projectVersion?: unknown, installed?: unknown}} facts
 * @param {{mode: 'build'|'activate', solutionName: string}} o
 * @returns {MissingShell}
 */
function missingShell(facts, o) {
    const f = facts && typeof facts === 'object' ? facts : {};
    const missing = shellByProgId(f.progId) || XAE_SHELL_VERSIONS.find(v => v.id === String(f.build || '')) || null;
    const build = missing ? missing.id : String(f.build || '?');
    const missingName = missing ? shellName(missing) : `XAE Shell (${build})`;
    const savedBuild = (/^3\.1\.(\d+)/.exec(typeof f.projectVersion === 'string' ? f.projectVersion : '') || [])[1] || '';
    if (savedBuild && savedBuild !== build) {
        // A run with -TcVersion <a substitute>: the substitute is what is not registered.
        const own = XAE_SHELL_VERSIONS.find(v => v.id === savedBuild);
        const ownName = own ? shellName(own) : `XAE Shell (${savedBuild})`;
        return {
            offer: null, question: '', confirmLabel: '',
            text: `${o.solutionName} was saved with TwinCAT 3.1.${savedBuild}, and ${missingName}${missing ? ` (${missing.progId})` : ''}, ` +
                `chosen in place of its ${ownName}, is not registered with COM either (a broken or partial install). ` +
                `Repair ${missingName}, or install ${ownName}${own ? ` (${own.progId})` : ''}, to build it on this machine.`
        };
    }
    // PS 5.1 may hand a one-element array over as a bare string.
    const listed = Array.isArray(f.installed) ? f.installed : (typeof f.installed === 'string' ? [f.installed] : []);
    const installedOthers = XAE_SHELL_VERSIONS.filter(v => v !== missing && listed.some(p => shellByProgId(p) === v))
        .slice().sort((a, b) => Number(b.id) - Number(a.id));
    // Never an older shell: it would open a project saved with a newer TwinCAT.
    const others = missing ? installedOthers.filter(v => Number(v.id) > Number(missing.id)) : [];
    const older = missing ? installedOthers.filter(v => Number(v.id) < Number(missing.id)) : [];
    const newest = others[0];
    const saved = `${o.solutionName} was saved with TwinCAT 3.1.${build}`;
    const install = `Install ${missingName}${missing ? ` (${missing.progId})` : ''} to build it on this machine.`;
    if (!newest) {
        const olderNote = older.length
            ? ` ${older.map(shellName).join(' and ')} ${older.length === 1 ? 'is' : 'are'} installed, but an older XAE Shell cannot open a project saved with a newer TwinCAT.`
            : '';
        return { offer: null, question: '', confirmLabel: '', text: `${saved} and its ${missingName} is not installed.${olderNote} ${install}` };
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
        question: `${saved} and its ${missingName} is not installed. Build with ${name} instead? XAE will upgrade the project files (it rewrites the .tspproj/.tsproj and .plcproj). The XAE window stays open for this build so you can answer its dialogs.`,
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
 * @typedef {{netId: string, name: string, kind: string, platform: string|null, provenance: string|null, netIdSource?: string|null}} LocalRuntime
 *   A runtime of this PC whose AmsNetId is known: an activation (and retarget) candidate. `netIdSource`
 *   is how the driver trusted a user-mode runtime's NetId: 'file-time' (its configuration file is no
 *   newer than the running instance), 'ads' (the runtime answered at it over ADS), null otherwise.
 */

/**
 * @typedef {Object} UnknownRuntime A user-mode runtime of this PC whose AmsNetId could not be trusted.
 * @property {string} name The runtime's folder name (the name XAE shows, e.g. UmRT_Default).
 * @property {string} kind
 * @property {string|null} platform
 * @property {string} status The driver's netIdStatus: 'not-running', 'rewritten' or 'unverifiable'.
 * @property {string} reason In words, e.g. "this runtime is not running".
 * @property {string|null} fileNetId What its TcRegistry.xml names: NOT a target, only for messages.
 */

/**
 * @typedef {Object} BootProjectEntry One PLC project's boot project, as the driver installed it.
 * @property {string} name The PLC project's name.
 * @property {string|null} node Which tree item answered ITcPlcProject: 'root' or 'nested'.
 * @property {boolean|null} wasAutostart BootProjectAutostart before this run (false: set for this run, not saved).
 * @property {boolean|null} autostart BootProjectAutostart as read back after setting it.
 * @property {boolean} installed GenerateBootProject(true) returned.
 * @property {string|null} error Why not, when it was not installed.
 */

/**
 * @typedef {Object} BootProjectReport The driver's `bootProject` event.
 * @property {'installed'|'partial'|'failed'|'none'|string} outcome
 * @property {string|null} error A failure before any project (the PLC node could not be read).
 * @property {BootProjectEntry[]} projects
 */

/**
 * @typedef {{name: string, port: number|null, adsState: number|null, stateName: string|null}} PlcState
 *   One installed PLC's ADS state after the restart (`plcState`); 5 is RUN.
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
 * @property {{errorItems: number|null, outputPanes: number|null, reasons: string[], route: 'typed'|'late-bound'|'none'|null}|null} errorDetails
 *   What the driver could read of a failed build's error details, a one-line reason for each step that
 *   gave nothing (`errorDetails`; on 4026 the late-bound error list and Output window gave nothing,
 *   shown or hidden), and which route worked: the typed EnvDTE reader, the late-bound reads, or none
 *   (null from a driver older than the field).
 * @property {number|null} failedProjects
 * @property {{netId: string, local: boolean, platform: string|null}|null} target
 * @property {boolean} targetMismatch The driver's target readback differs from the confirmed pick.
 * @property {string|null} expectedNetId The NetId the user confirmed (activation only).
 * @property {{netId: string, adsState: number|null, stateName: string|null, outcome: string, dllProblem: string|null}|null} activation
 *   `dllProblem`: why ADS could not be read at all (TcAdsDll.dll not found), with an unreadable state.
 * @property {BootProjectReport|null} bootProject
 * @property {PlcState[]} plcStates
 * @property {{local: LocalRuntime[], unknown: UnknownRuntime[], projectNetId: string|null}|null} targets
 *   This PC's runtimes from `-ListTargets`: `local` (a known AmsNetId: the only ones ever offered) and
 *   `unknown` (a user-mode runtime whose AmsNetId could not be trusted; listed, never offered).
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
        errorItems: [], panes: [], errorDetails: null, failedProjects: null, target: null, targetMismatch: false,
        expectedNetId: o.expectedNetId || null, activation: null, bootProject: null, plcStates: [], targets: null, fatal: null, done: null, log: [],
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
        case 'errorDetails': {
            // PS 5.1 may hand a one-element array over as a bare string.
            const reasons = Array.isArray(e.reasons) ? e.reasons : (typeof e.reasons === 'string' ? [e.reasons] : []);
            state.errorDetails = {
                errorItems: numOrNull(e.errorItems), outputPanes: numOrNull(e.outputPanes),
                reasons: reasons.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim()),
                route: e.route === 'typed' || e.route === 'late-bound' || e.route === 'none' ? e.route : null
            };
            break;
        }
        case 'target':
            state.target = { netId: String(e.netId || ''), local: e.local === true, platform: strOrNull(e.platform) };
            if (state.expectedNetId && state.target.netId !== state.expectedNetId) state.targetMismatch = true;
            break;
        case 'activation':
            state.activation = {
                netId: String(e.netId || ''), adsState: numOrNull(e.adsState), stateName: strOrNull(e.stateName),
                outcome: String(e.outcome || ''), dllProblem: strOrNull(e.dllProblem)
            };
            break;
        case 'bootProject': {
            // PS 5.1 may hand a one-element array over as a bare object.
            const list = Array.isArray(e.projects) ? e.projects : (e.projects && typeof e.projects === 'object' ? [e.projects] : []);
            state.bootProject = {
                outcome: String(e.outcome || ''), error: strOrNull(e.error),
                projects: list.filter(p => p && typeof p === 'object').map(p => ({
                    name: String(p.name || ''), node: strOrNull(p.node), wasAutostart: boolOrNull(p.wasAutostart),
                    autostart: boolOrNull(p.autostart), installed: p.installed === true, error: strOrNull(p.error)
                }))
            };
            break;
        }
        case 'plcState':
            state.plcStates.push({ name: String(e.name || ''), port: numOrNull(e.port), adsState: numOrNull(e.adsState), stateName: strOrNull(e.stateName) });
            break;
        case 'targets':
            state.targets = { ...runtimeEntries(e.local), projectNetId: strOrNull(e.projectNetId) };
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
 * @param {{error?: string, stderr?: string[], solutionName?: string, errorCount?: number, retargetProblem?: string, adsDllConfigured?: boolean}} [extra] `error`: the spawn error text; `stderr`:
 *   PowerShell's error lines; `solutionName`: names the solution when the project's XAE Shell is missing or its
 *   target is not a runtime on this PC; `retargetProblem`: why that target cannot be changed here ('' when it can);
 *   `adsDllConfigured`: tcToolkit.adsDll.nativeDllFolder is set (the hint for a missing TcAdsDll.dll says to correct it).
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
    // The placed, de-duplicated count when the caller has one; else the raw list's (empty items and
    // build-failed summaries are not counted either way).
    const errorCount = typeof extra.errorCount === 'number' ? extra.errorCount : countBySeverity(state.errorItems).errors;
    switch (code) {
        case EXIT.OK: {
            const a = state.activation;
            const boot = describeBootProject(state);
            const bootSentence = boot ? ` ${boot.sentence}` : '';
            if (state.mode === 'activate' && a && a.outcome === 'incomplete') {
                // No ADS DLL: say which and the setting that points at it (the command adds "Open Setting").
                const dll = a.dllProblem ? ` ${a.dllProblem.replace(/\.?$/, '.')} ${adsDllHint('native', { configured: extra.adsDllConfigured === true })}` : '';
                return {
                    ok: false, severity: 'warning',
                    title: `Built and activated on ${a.netId}, but its run state could not be read: check the target.${dll}${bootSentence}`,
                    detail: missing.trim()
                };
            }
            if (state.mode === 'activate' && a && a.outcome === 'run') {
                // A boot project that is missing or did not start is a warning, never a silent pass.
                const ok = !boot || boot.ok;
                return {
                    ok, severity: ok ? 'info' : 'warning',
                    title: `Built, activated and restarted TwinCAT on ${a.netId}: it is in RUN.${bootSentence}`, detail: missing.trim()
                };
            }
            return { ok: true, severity: 'info', title: 'Build through XAE succeeded.', detail: missing.trim() };
        }
        case EXIT.COMPILE:
            return {
                ok: false, severity: 'error',
                title: errorCount > 0 ? `Build through XAE failed: ${errorCount} error${errorCount === 1 ? '' : 's'}.` : 'Build through XAE failed.',
                detail: missing.trim()
            };
        case EXIT.HARNESS: {
            if (state.fatal && state.fatal.code === 'progid-not-registered' && extra.solutionName) {
                // Says which shell to install (and, for activation, that another shell cannot stand in).
                const m = missingShell(state.fatal.data, { mode: state.mode === 'activate' ? 'activate' : 'build', solutionName: extra.solutionName });
                return { ok: false, severity: 'error', title: `The XAE build could not run: ${m.text}`, detail: missing.trim() };
            }
            const refused = extra.solutionName ? refusedTarget(state) : null;
            if (refused) {
                // The solution targets a runtime that is not on this PC: name this PC's runtimes.
                return {
                    ok: false, severity: 'error',
                    title: `The XAE build could not run: ${retargetRefusalText(refused, extra.solutionName || '', extra.retargetProblem || '')}`,
                    detail: missing.trim()
                };
            }
            // The whole refusal is in the title (joined onto one line), so the detail never repeats it.
            const why = state.fatal ? oneLine(state.fatal.text) : '';
            return {
                ok: false, severity: 'error',
                title: `The XAE build could not run${why ? `: ${why}` : '.'}`,
                detail: missing.trim()
            };
        }
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

/** What to do about a PLC without a boot project: the state an activation left it in before 2026-11-16. */
const START_FROM_XAE = 'log in from XAE and download and start the PLC there';

/**
 * What an activation did about the boot project (user decision 2026-11-16: every Build and Activate
 * installs each PLC project as a boot project with autostart). `sentence` goes into the summary,
 * `lines` into the channel; `ok` is false when a PLC project got no boot project, or a PLC read after
 * the restart is not in RUN. A failure here never fails the activation (exit code 0 stays 0): it is
 * reported as a warning. `null` when there is nothing to say: no activation, a refused one, or one
 * that failed before the boot step (its own failure says enough).
 * @param {RunState} state
 * @returns {{ok: boolean, sentence: string, lines: string[]}|null}
 */
function describeBootProject(state) {
    const a = state.activation;
    if (state.mode !== 'activate' || !a || a.outcome === 'refused') return null;
    const b = state.bootProject;
    if (!b) {
        if (a.outcome !== 'run' && a.outcome !== 'incomplete') return null;
        return { ok: false, sentence: `The driver reported no boot project, so the PLC may have no program: ${START_FROM_XAE}.`, lines: [] };
    }
    const lines = [];
    if (b.error) lines.push(`Boot project: none installed: ${oneLine(b.error)}`);
    for (const p of b.projects) {
        if (p.installed) {
            lines.push(`Boot project: ${p.name} installed on the target with autostart` +
                (p.wasAutostart === false ? ' (autostart set for this run; the solution is not saved, so XAE still shows it off).' : '.'));
        } else {
            lines.push(`Boot project: ${p.name} NOT installed${p.error ? `: ${oneLine(p.error)}` : '.'}`);
        }
    }
    for (const st of state.plcStates) {
        lines.push(`PLC ${st.name}${st.port !== null ? ` (port ${st.port})` : ''}: ${st.stateName || 'state unreadable'}` +
            (st.adsState === 5 ? '.' : ', not RUN: its boot project may not have loaded.'));
    }
    if (b.outcome === 'none') {
        return { ok: true, sentence: 'The solution has no PLC project, so no boot project was installed.', lines };
    }
    const missingNames = b.projects.filter(p => !p.installed).map(p => p.name);
    if (b.outcome !== 'installed' || missingNames.length > 0 || b.projects.length === 0) {
        const which = missingNames.length > 0 ? `for ${missingNames.join(', ')} ` : '';
        return {
            ok: false,
            sentence: `But the boot project ${which}could not be installed, so that PLC has no program: ${START_FROM_XAE}. See the output for why.`,
            lines
        };
    }
    const notRun = state.plcStates.filter(st => st.adsState !== 5);
    if (notRun.length > 0) {
        return {
            ok: false,
            sentence: `The boot project was installed with autostart, but ${notRun.map(st => `PLC ${st.name} is ${st.stateName || 'unreadable'}`).join(', ')}, not RUN: check it in XAE.`,
            lines
        };
    }
    return {
        ok: true,
        sentence: 'The PLC program is installed as a boot project with autostart: the PLC starts on activation and after every runtime restart.',
        lines
    };
}

/**
 * A driver message as one sentence-ended line for a notification. The driver's refusals wrap and
 * indent their own continuation lines (gate 4: "... activation target <NetId>," / "which runs ..."),
 * so they are joined, never cut at the first line break.
 * @param {string} s
 * @returns {string}
 */
function oneLine(s) {
    const line = String(s).replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!line) return '';
    return /[.!?]$/.test(line) ? line : line.replace(/[,;:]$/, '') + '.';
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
 * `vscode.QuickPickItemKind.Separator`: a QuickPick row that cannot be picked. This module does not
 * load `vscode`, so the value is spelled out (it is fixed by the API).
 */
const QUICK_PICK_SEPARATOR = -1;

/**
 * Where to read a user-mode runtime's real AmsNetId when the driver could not trust it.
 */
const UNKNOWN_NETID_HINT = 'Read the AmsNetId in that runtime\'s console window ("AmsNetId: …") or use XAE\'s Choose Target System.';

/**
 * The runtimes of a driver list (`-ListTargets`' `local`, the `target-refused` fatal's `local`),
 * split by whether their AmsNetId is known. A user-mode runtime's AmsNetId is trusted only for a
 * running instance that wrote it (the driver's Resolve-UserModeNetIdTrust); any `netIdStatus` other
 * than `trusted` puts the entry in `unknown`, whatever its `netId` says, so an unknown NetId is never
 * offered, preselected or treated as local (fail closed). An entry with neither a well-formed NetId
 * nor a status (a malformed one, or an older driver's) is dropped, as before. Each NetId, and each
 * unknown runtime name, once; `exclude` (the solution's own target) is never in `local`.
 * PS 5.1 may hand a one-element array over as a bare object.
 * @param {any} raw
 * @param {string|null} [exclude]
 * @returns {{local: LocalRuntime[], unknown: UnknownRuntime[]}}
 */
function runtimeEntries(raw, exclude) {
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
    /** @type {LocalRuntime[]} */
    const local = [];
    /** @type {UnknownRuntime[]} */
    const unknown = [];
    for (const t of list) {
        if (!t || typeof t !== 'object') continue;
        const status = strOrNull(t.netIdStatus);
        if (status && status !== 'trusted') {
            const name = String(t.name || 'user-mode runtime');
            if (unknown.some(u => u.name === name)) continue;
            unknown.push({
                name, kind: String(t.kind || ''), platform: strOrNull(t.platform), status,
                reason: strOrNull(t.reason) || 'its AmsNetId could not be confirmed',
                fileNetId: isValidNetId(t.fileNetId) ? t.fileNetId : null
            });
            continue;
        }
        if (!isValidNetId(t.netId) || t.netId === exclude || local.some(l => l.netId === t.netId)) continue;
        local.push({ netId: t.netId, name: String(t.name || t.netId), kind: String(t.kind || ''), platform: strOrNull(t.platform), provenance: strOrNull(t.provenance),
            netIdSource: strOrNull(t.netIdSource) });
    }
    return { local, unknown };
}

/**
 * One sentence naming the runtimes whose AmsNetId is unknown, why, and where to read it; '' for none.
 * When a reason is a missing TcAdsDll.dll (the ADS confirmation could not run), the setting that
 * points at it is named too (`unknownNeedsAdsDll` tells the caller to offer "Open Setting").
 * @param {UnknownRuntime[]|undefined} unknown
 * @param {{adsDllConfigured?: boolean}} [o] Whether tcToolkit.adsDll.nativeDllFolder is set.
 * @returns {string}
 */
function unknownRuntimesText(unknown, o = {}) {
    if (!unknown || unknown.length === 0) return '';
    const named = unknown.map(u => `${u.name} (${u.kind === 'user-mode' ? 'user-mode runtime' : 'runtime'}): ${u.reason}`);
    const dll = unknownNeedsAdsDll(unknown) ? ` ${adsDllHint('native', { configured: o.adsDllConfigured === true })}` : '';
    return `Not offered, AmsNetId unknown: ${named.join('; ')}. ${UNKNOWN_NETID_HINT}${dll}`;
}

/**
 * Whether a runtime was not offered because TcAdsDll.dll was not found (its AmsNetId could not be
 * confirmed over ADS).
 * @param {UnknownRuntime[]|undefined} unknown
 * @returns {boolean}
 */
function unknownNeedsAdsDll(unknown) {
    return !!unknown && unknown.some(u => isNativeDllMissing(u.reason));
}

/**
 * The activation-target QuickPick items: this machine's runtimes, the project's own NetId marked,
 * the last pick first and preselected. Nothing is stored as a setting; `preselect` is a convenience.
 * Runtimes whose AmsNetId is unknown follow as separator rows (`kind` QUICK_PICK_SEPARATOR): shown
 * with the reason, never pickable, never preselected, and without a `netId`.
 * @param {RunState['targets']|{local: LocalRuntime[], unknown?: UnknownRuntime[], projectNetId: string|null}} targets
 * @param {{preselect?: string}} [o]
 * @returns {Array<{label: string, description?: string, detail?: string, netId?: string, name?: string, picked?: boolean, kind?: number}>}
 */
function targetPickItems(targets, o = {}) {
    if (!targets) return [];
    /** @type {Array<{label: string, description?: string, detail?: string, netId?: string, name?: string, picked?: boolean, kind?: number}>} */
    const items = targets.local.map(t => ({
        label: t.name,
        description: t.netId + (targets.projectNetId === t.netId ? ' (project)' : ''),
        detail: `${t.kind === 'real-time' ? 'Real-time runtime' : (t.kind === 'user-mode' ? 'User-mode runtime' : 'Runtime')}` +
            ` on this machine; platform ${t.platform || 'unknown'}${t.netIdSource === 'ads' ? '; AmsNetId confirmed over ADS' : ''}`,
        netId: t.netId, name: t.name, picked: !!o.preselect && o.preselect === t.netId
    }));
    items.sort((a, b) => Number(b.picked) - Number(a.picked));
    for (const u of targets.unknown || []) {
        items.push({ label: `${u.name}: AmsNetId unknown, not offered (${u.reason})`, kind: QUICK_PICK_SEPARATOR });
    }
    return items;
}

/** The buttons of the platform-switch confirmation (user, 2026-11-13; XAE asks the same on download). */
const SWITCH_FOR_RUN = 'Switch for this run';
const SWITCH_AND_REMEMBER = 'Switch and remember';

/**
 * The modal confirmation before an activation, and its confirm button (which names the target).
 * With `platformSwitch` (the target runs another platform the solution declares, see
 * `activationPlatform`) it is still ONE modal: it first asks to switch, and its buttons are
 * `Switch for this run` / `Switch and remember` (the confirmation itself is either of them).
 * @param {{netId: string, name: string}} target
 * @param {string} solutionName
 * @param {{from: string, to: string, configuration: string, provenance?: string|null}} [platformSwitch]
 * @returns {{message: string, confirmLabel: string, rememberLabel?: string}}
 */
function confirmationText(target, solutionName, platformSwitch) {
    const where = `${target.name} (${target.netId})`;
    const tail = 'The running PLC on that target stops. The XAE window opens during activation - answer any dialog there.';
    if (!platformSwitch) {
        return {
            message: `Build ${solutionName}, activate the configuration on ${where}, install its PLC program there as a boot project with autostart, and restart TwinCAT there? ${tail}`,
            confirmLabel: `Activate on ${where}`
        };
    }
    const inferred = platformSwitch.provenance && platformSwitch.provenance !== 'read'
        ? ' (inferred, not read from that runtime, so it can be wrong)' : '';
    return {
        message: `${where} runs ${platformSwitch.to}${inferred}, but ${platformSwitch.from} is set. Switch to ${platformSwitch.to}? ` +
            `Then ${solutionName} is built as ${platformSwitch.configuration}|${platformSwitch.to}, activated on ${where}, its PLC program installed there as a boot project with autostart, and TwinCAT there restarted. ${tail}`,
        confirmLabel: SWITCH_FOR_RUN,
        rememberLabel: SWITCH_AND_REMEMBER
    };
}

/** The button on a refusal whose solution targets a runtime that is not on this PC (user, 2026-11-16). */
const RETARGET_BUTTON = 'Change the solution\'s target…';

/**
 * @typedef {Object} RefusedTarget
 * @property {string} projectNetId The TargetNetId the solution names (not a runtime on this PC).
 * @property {string|null} tsproj The system project the driver read it from.
 * @property {LocalRuntime[]} local
 *   This PC's runtimes with a known AmsNetId, as the driver found them (well-formed NetIds only, each once).
 * @property {UnknownRuntime[]} unknown This PC's runtimes whose AmsNetId is unknown: named, never offered.
 */

/**
 * The facts of a gate-3 refusal ("this solution names TargetNetId X, which is not a runtime on this
 * PC"), from the driver's `target-refused` fatal; null for any other result. A driver older than
 * this field sends only `{gate}`, which is null here too: the plain refusal is shown.
 * @param {RunState} state
 * @returns {RefusedTarget|null}
 */
function refusedTarget(state) {
    const f = state && state.fatal;
    if (!f || f.code !== 'target-refused' || !f.data || typeof f.data !== 'object') return null;
    const d = f.data;
    const projectNetId = strOrNull(d.projectNetId);
    if (numOrNull(d.gate) !== 3 || !projectNetId) return null;
    const { local, unknown } = runtimeEntries(d.local, projectNetId);
    return { projectNetId, tsproj: strOrNull(d.tsproj), local, unknown };
}

/**
 * One runtime of this PC, for a sentence: `UmRT_Default (10.0.0.5.1.1, user-mode runtime)`.
 * @param {{netId: string, name: string, kind: string}} t
 * @returns {string}
 */
function runtimeLabel(t) {
    return t.kind === 'user-mode' ? `${t.name} (${t.netId}, user-mode runtime)` : `${t.name} (${t.netId})`;
}

/**
 * The refusal of an activation whose solution targets a runtime that is not on this PC: what was
 * refused, the runtimes this PC has, and the way forward. `problem` (from checkSolutionTarget) is
 * why the target cannot be changed here; '' when it can (then the button is offered).
 * @param {RefusedTarget} info
 * @param {string} solutionName
 * @param {string} problem
 * @returns {string}
 */
function retargetRefusalText(info, solutionName, problem) {
    const head = `${solutionName} targets ${info.projectNetId}, which is not a runtime on this PC. ` +
        'Activation is local-only, so it was refused before XAE started.';
    const unknown = info.unknown || [];
    // The measured case: the solution names the NetId a runtime's configuration file holds, but no
    // running instance of that runtime is known to use it.
    const stale = unknown.filter(u => u.fileNetId === info.projectNetId)
        .map(u => ` ${info.projectNetId} is the AmsNetId ${u.name}'s configuration file names, which no running instance of it is known to use.`).join('');
    const tail = (stale ? stale : '') + (unknown.length > 0 ? ` ${unknownRuntimesText(unknown)}` : '');
    if (info.local.length === 0) {
        if (unknown.length > 0) {
            return `${head}${tail} No runtime with a known AmsNetId was found on this PC, so there is none to change the target to here.`;
        }
        return `${head} No runtime was found on this PC, so there is none to change the target to: ` +
            'set the target in XAE (Choose Target System) once this PC has a runtime.';
    }
    const list = ` Runtimes on this PC: ${info.local.map(runtimeLabel).join(', ')}.`;
    if (problem) return `${head}${list}${tail} The target cannot be changed here: ${problem}. Change it in XAE (Choose Target System).`;
    return `${head}${list}${tail} Change the solution's target to one of them (here, or in XAE with Choose Target System).`;
}

/**
 * The modal confirmation before the solution's target is changed. It names the file and both NetIds.
 * @param {{solutionName: string, tsprojPath: string, from: string, to: {netId: string, name: string, kind: string}, title: string, sameTarget: boolean}} o
 *   `sameTarget`: the new target is the runtime this activation was already confirmed for (then the
 *   re-run activates without asking again; otherwise it asks for the target again).
 * @returns {{message: string, confirmLabel: string}}
 */
function retargetConfirmText(o) {
    return {
        message: `Change the target of ${o.solutionName} from ${o.from} to ${runtimeLabel(o.to)}? ` +
            `This rewrites TargetNetId="${o.from}" to TargetNetId="${o.to.netId}" in ${o.tsprojPath}, the setting XAE's Choose Target System changes; ` +
            `nothing else in the file changes. Then ${o.title} runs again` +
            (o.sameTarget ? ` and activates on ${o.to.name} (${o.to.netId}), as confirmed.` : ', and asks for the activation target again.'),
        confirmLabel: 'Change target'
    };
}

/**
 * The configuration|platform pairs a solution declares (its `SolutionConfigurationPlatforms`
 * section), read exactly as the driver reads them; empty when the section is absent or unreadable.
 * @param {string} slnText
 * @returns {string[]}
 */
function declaredPairs(slnText) {
    const section = /^\s*GlobalSection\(SolutionConfigurationPlatforms\)[\s\S]*?^\s*EndGlobalSection/m.exec(String(slnText || ''));
    if (!section) return [];
    return [...section[0].matchAll(/^\s*([^=\r\n]+?)\s*=/gm)].map(m => m[1]).filter(p => !/^GlobalSection/.test(p) && p.includes('|'));
}

/**
 * Which platform an activation onto `target` builds. The driver refuses to activate a platform that
 * is not the target's (gate 4 of Resolve-ActivationTarget, which reads the platform from the same
 * runtime records `-ListTargets` reports; PowerShell compares case-insensitively, so this does too):
 *   - `pair-not-declared` the platform it would build (the configured one) is the target's or the
 *                    target's is unknown, but the solution declares pairs and not
 *                    `<configuration>|<platform>`: the driver would stop with `config-not-declared`
 *                    after the confirmation, so refuse before it;
 *   - `same`         the target's platform is the configured one, or unknown (the driver warns and
 *                    the XAE Shell checks it during activation);
 *   - `switch`       another platform, and the solution declares `<configuration>|<it>`: offer it
 *                    (`platform` is the solution's spelling);
 *   - `not-declared` another platform the solution does not declare: refuse before XAE starts;
 *   - `unknown`      another platform, but the solution's pairs could not be read: nothing is
 *                    switched, and the driver's refusal explains.
 * @param {{configuration: string, platform: string, targetPlatform: string|null|undefined, declared: string[]}} o
 * @returns {{kind: 'same'|'switch'|'not-declared'|'pair-not-declared'|'unknown', platform: string}}
 */
function activationPlatform(o) {
    const tp = typeof o.targetPlatform === 'string' ? o.targetPlatform.trim() : '';
    if (!tp || tp.toLowerCase() === String(o.platform).toLowerCase()) {
        const own = `${o.configuration}|${o.platform}`.toLowerCase();
        if (o.declared && o.declared.length > 0 && !o.declared.some(d => d.toLowerCase() === own)) {
            return { kind: 'pair-not-declared', platform: o.platform };
        }
        return { kind: 'same', platform: o.platform };
    }
    if (!o.declared || o.declared.length === 0) return { kind: 'unknown', platform: o.platform };
    const want = `${o.configuration}|${tp}`.toLowerCase();
    const pair = o.declared.find(d => d.toLowerCase() === want);
    if (!pair) return { kind: 'not-declared', platform: tp };
    return { kind: 'switch', platform: pair.slice(pair.indexOf('|') + 1) };
}

/**
 * The refusal when the target runs a platform the solution does not declare (nothing is started).
 * @param {{netId: string, name: string}} target
 * @param {string} targetPlatform
 * @param {string} configuration
 * @param {string} solutionName
 * @returns {string}
 */
function platformNotDeclaredText(target, targetPlatform, configuration, solutionName) {
    return `${target.name} (${target.netId}) runs ${targetPlatform}, but ${solutionName} does not declare ` +
        `'${configuration}|${targetPlatform}', so it cannot be built and activated there. Add the solution platform ` +
        `'${targetPlatform}' in XAE's Configuration Manager, save the solution and run again.`;
}

/**
 * The refusal when the configured configuration|platform pair is not one the solution declares (an
 * activation; nothing is started, and the confirmation is not asked).
 * @param {string} configuration
 * @param {string} platform
 * @param {string} solutionName
 * @param {string[]} declared
 * @returns {string}
 */
function pairNotDeclaredText(configuration, platform, solutionName, declared) {
    return `${solutionName} does not declare '${configuration}|${platform}', so it cannot be built and activated. ` +
        `It declares ${declared.map(d => `'${d}'`).join(', ')}. Set tcToolkit.xaeBuild.configuration and ` +
        `tcToolkit.xaeBuild.platform to one of them (Build through XAE also offers the pick), or add '${platform}' ` +
        `to the solution in XAE's Configuration Manager (a target that runs '${platform}', such as a user-mode ` +
        `runtime for 'TwinCAT OS (x64)', needs it), then run again.`;
}

/** The button that re-runs a failed headless build with the window shown (this run only). */
const RERUN_WINDOW_SHOWN = 'Build again with the window shown';

/**
 * A failed build that brought back no error details at all: no error-list item and no Output pane
 * text. Measured headless on 4026 (2026-11-13): the error list was empty and the Output window null.
 * Whether the same build with the window shown brings them back is NOT known yet, so the text never
 * claims it; it only offers the re-run.
 * @param {number|null} code
 * @param {'exit'|'timeout'|'spawn-error'|'killed'} outcome
 * @param {RunState} state
 * @returns {{text: string, reasons: string[], offerRerun: boolean}|null} Null when there are details,
 *   or the run was not a confirmed compile failure.
 */
function noErrorDetails(code, outcome, state) {
    if (outcome !== 'exit' || code !== EXIT.COMPILE || !compileFailureConfirmed(state)) return null;
    // Empty items (headless 4026 returns them) are no details.
    if (state.errorItems.some(it => !isEmptyItem(it)) || state.panes.some(p => p.text.trim())) return null;
    const reasons = state.errorDetails && state.errorDetails.reasons.length
        ? state.errorDetails.reasons : ['the driver reported none'];
    const requested = state.done && state.done.ui && state.done.ui.requested;
    const headless = requested ? requested !== 'visible' : state.showWindow !== true;
    return {
        text: `XAE returned no error details: ${reasons.join('; ')}.`,
        reasons,
        offerRerun: headless
    };
}

/**
 * Whether TC Toolkit's own compile check stands in for XAE's error details: a confirmed compile
 * failure (exit 1) that ended with nothing placed in Problems, whether XAE returned no details at all
 * or only details that name no placeable file and line (user decision 2026-11-13).
 * @param {number|null} code
 * @param {'exit'|'timeout'|'spawn-error'|'killed'} outcome
 * @param {RunState} state
 * @param {number} placed How many problems the placement put in Problems.
 * @returns {boolean}
 */
function needsCompileFallback(code, outcome, state, placed) {
    return outcome === 'exit' && code === EXIT.COMPILE && compileFailureConfirmed(state) && placed === 0;
}

/**
 * What the failure message and the channel say before TC Toolkit's own check stands in for the error
 * details XAE did not return (user decision 2026-11-13).
 */
const FALLBACK_INTRO = "Running TC Toolkit's own compile check instead: its errors come from TC Toolkit's check, not from XAE, and can differ from XAE's.";

/**
 * @typedef {Object} FallbackResult One project of the fallback, as `twincat.compileProject` returned it.
 * @property {string} name The project's display name.
 * @property {boolean} ok The check finished.
 * @property {string} [reason] Why not: 'setup' (no usable compiler), 'running', 'cancelled', ...
 * @property {string} [message]
 * @property {number} [errors]
 * @property {number} [warnings]
 */

/**
 * The one sentence that reports the fallback: per project, its counts or why it did not run; a
 * missing compiler is said once, as such ("skipped").
 * @param {FallbackResult[]} results
 * @param {string} compileSource The Problems source of TC Toolkit's check ('TC Toolkit compile').
 * @returns {{text: string, ran: number, skipped: boolean}}
 */
function compileFallbackText(results, compileSource) {
    const setup = results.find(r => !r.ok && r.reason === 'setup');
    if (setup) {
        return {
            text: `TC Toolkit's own compile check was skipped: no compiler is configured for it (${String(setup.message || '').trim() || 'see the Build Project settings'}).`,
            ran: 0, skipped: true
        };
    }
    const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const parts = results.map((r) => {
        if (r.ok) {
            const e = r.errors || 0;
            const w = r.warnings || 0;
            return `${r.name}: ${e === 0 && w === 0 ? 'no errors' : [e ? plural(e, 'error') : '', w ? plural(w, 'warning') : ''].filter(Boolean).join(', ')}`;
        }
        if (r.reason === 'running') return `${r.name}: not checked (Build Project is already running)`;
        if (r.reason === 'cancelled') return `${r.name}: cancelled`;
        return `${r.name}: not checked${r.message ? ` (${r.message})` : ''}`;
    });
    const ran = results.filter(r => r.ok).length;
    return {
        text: `TC Toolkit's own compile check (not XAE's; it can differ from XAE's): ${parts.join('; ') || 'no PLC project to check'}.` +
            (ran > 0 ? ` Its problems are in Problems as '${compileSource}'.` : ''),
        ran, skipped: false
    };
}

module.exports = {
    PREFIX, PROTOCOL, EXIT, EVENT_TYPES, UNINTERRUPTIBLE_PHASES, SWITCH_FOR_RUN, SWITCH_AND_REMEMBER, RERUN_WINDOW_SHOWN, FALLBACK_INTRO, compileFallbackText,
    RETARGET_BUTTON, refusedTarget, runtimeLabel, retargetRefusalText, retargetConfirmText,
    QUICK_PICK_SEPARATOR, UNKNOWN_NETID_HINT, runtimeEntries, unknownRuntimesText,
    isValidNetId, unknownNeedsAdsDll, buildDriverArgs, shellByProgId, missingShell, createLineSplitter, parseLine, createRunState, reduce,
    compileFailureConfirmed, reachedBuildResult, describeExit, describeBootProject, START_FROM_XAE, describeUiMode, buildPhaseUi, canCancel, isStalled, targetPickItems, confirmationText,
    declaredPairs, activationPlatform, platformNotDeclaredText, pairNotDeclaredText, noErrorDetails, needsCompileFallback, oneLine
};
