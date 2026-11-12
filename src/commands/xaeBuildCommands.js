/**
 * @file xaeBuildCommands.js
 * @description The VS Code half of "Build through XAE" (roadmap R14): the commands
 * `twincat.xaeBuild`, `twincat.xaeBuildAndActivate`, `twincat.xaeShowTargets` and the internal
 * `twincat.xaeBuild.goToProblem`, and where a run's results go.
 *
 * A run spawns resources/xae/build-plc-project.ps1 (`powershell.exe -STA -File … -Json`) with the
 * vscode-free helpers of src/xaeBuild.js, reads its event lines as they arrive, and shows:
 *   - the **"TC Toolkit XAE Build"** output channel: the driver's own lines, a header that states the
 *     requested UI mode, and after the run the mode that actually ran (read back from DTE) — which is
 *     how a user verifies on Windows that headless works;
 *   - the **Problems panel**, in its own DiagnosticCollection `twincat-xae` (source "TC Toolkit XAE
 *     build"), apart from Compile Project's `twincat-compile` and `twincat-gpp`, and the pane markers
 *     through the editor provider under the key `xae` (src/xaeErrorPlacement.js places them);
 *   - a status-bar item, a cancellable progress notification and a summary notification.
 *
 * Rules (DEVELOPMENT.md "XAE build (R14)"):
 *   - Windows only; elsewhere the commands refuse and the dropdown entries are hidden.
 *   - Headless unless `tcToolkit.xaeBuild.showWindow` is on. Activation always shows the window
 *     (the driver's rule, not this module's).
 *   - Activation: the targets are listed (`-ListTargets`), one is picked, and a MODAL confirmation
 *     naming it is answered on every run; nothing is spawned before that. No target is stored as a
 *     setting — the last pick is only preselected (workspaceState).
 *   - Cancel and timeout: the cancel file first (the driver closes the solution and quits only the
 *     shell it started, exit 4), then after a grace period a force stop — PowerShell's process tree
 *     and, only when the driver reported `ours: true`, the XAE Shell's PID (it is DCOM-launched, so it
 *     is NOT in PowerShell's tree). Never during activate/restart/verify: a stop there could leave the
 *     runtime in CONFIG. A shell this run did not start is never killed.
 *   - One run at a time; the context key `twincat.xaeRunning` says when one is in progress.
 */

'use strict';

const vscode = require('vscode');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runChild, killProcessTree, describeLocation } = require('../compileCheck');
const {
    EXIT, buildDriverArgs, createLineSplitter, parseLine, createRunState, reduce, describeExit, describeUiMode,
    canCancel, isStalled, targetPickItems, confirmationText
} = require('../xaeBuild');
const { placeXaeErrors, placementSummary } = require('../xaeErrorPlacement');
const { XAE_BUILD_SECTION, readXaeBuildSettings } = require('../xaeBuildSettings');
const { XAE_SHELL_SECTION, XAE_SHELL_VERSIONS, describeConfiguredShells } = require('../xaeShellDetect');
const { normalizeFileUri } = require('../fileUri');
const { memberName } = require('../componentId');
const { problemDiagnostic, openProblem, pickProjectKey } = require('./compileCommands');

/** The output channel of every XAE build run. */
const OUTPUT_CHANNEL_NAME = 'TC Toolkit XAE Build';
/** The `source` of every diagnostic this module publishes. */
const DIAGNOSTIC_SOURCE = 'TC Toolkit XAE build';
/** The DiagnosticCollection's name. */
const COLLECTION_NAME = 'twincat-xae';
/** Internal command: pick one of the current XAE build problems and go to it. */
const GO_TO_PROBLEM_COMMAND = 'twincat.xaeBuild.goToProblem';
/** The context key that is true while a run is in progress. */
const RUNNING_CONTEXT_KEY = 'twincat.xaeRunning';
/** workspaceState key of the last activation target picked (a preselection only, never a setting). */
const LAST_TARGET_KEY = 'twincat.xaeBuild.lastTargetNetId';
/** What a cancel during activation says. */
const CANCEL_REFUSED_TEXT = 'The XAE build is activating the target; cancelling now could leave the runtime in CONFIG. It will finish on its own.';
/** The refusal off Windows. */
const PLATFORM_TEXT = 'Building through XAE needs Windows with TwinCAT XAE installed.';
/** The stall offer's buttons. */
const STALL_RERUN = 'Cancel and re-run with the window shown';
const STALL_WAIT = 'Keep waiting';

/**
 * @typedef {import('../xaeErrorPlacement').XaeProblem & {id: number}} StoredXaeProblem
 */

/**
 * @typedef {Object} DriverRun What one driver run ended with.
 * @property {number|null} code
 * @property {'exit'|'timeout'|'spawn-error'|'killed'|'cancelled'} outcome
 * @property {import('../xaeBuild').RunState} state
 * @property {string} error
 * @property {boolean} rerunVisible The user asked (stall offer) to re-run with the window shown.
 * @property {boolean} shellKilled The XAE Shell this run started was force-stopped.
 * @property {boolean} activationTimedOut The timeout fired during activation (nothing was killed).
 */

/**
 * The project's TwinCAT build number, from the `.tsproj` the solution references.
 * @param {string} slnPath
 * @param {{readFileSync: (p: string, enc: 'utf8') => string}} fsx
 * @returns {string|null} e.g. '4026'.
 */
function projectTcBuild(slnPath, fsx) {
    try {
        const sln = fsx.readFileSync(slnPath, 'utf8');
        const m = /"([^"]+\.tsproj)"/i.exec(sln);
        if (!m) return null;
        const tsproj = path.join(path.dirname(slnPath), ...m[1].split(/[\\/]/));
        const v = /TcVersion="3\.1\.(\d+)\.\d+"/.exec(fsx.readFileSync(tsproj, 'utf8'));
        return v ? v[1] : null;
    } catch (e) {
        return null;
    }
}

/**
 * Registers the XAE build commands.
 * @param {vscode.ExtensionContext} context
 * @param {Object} deps
 * @param {any} [deps.provider] The custom editor provider (pane markers, the dropdown).
 * @param {() => any} deps.getProjectMap
 * @param {() => any} deps.getSolutionMap
 * @param {() => void} [deps.onSettingsChanged] Redraws the start page.
 * @param {Function} [deps.spawn] Default child_process.spawn.
 * @param {string} [deps.platform] Default process.platform.
 * @param {Function} [deps.execFile] Default child_process.execFile (taskkill).
 * @param {string} [deps.scriptPath] Default resources/xae/build-plc-project.ps1.
 * @param {number} [deps.minuteMs] A minute, for the timeout and stall settings (tests shrink it).
 * @param {number} [deps.graceMs] How long a cancel waits for exit 4 before the force stop (60 s).
 * @param {number} [deps.stallCheckMs] How often the stall watchdog looks (30 s).
 * @param {number} [deps.listTimeoutMs] The `-ListTargets` run's timeout (60 s).
 * @param {string} [deps.tmpDir] Where cancel files are created.
 * @returns {{xaeOptions: () => {available: boolean, showWindow: boolean, running: boolean, configuration: string, platform: string},
 *   setXaeOption: (key: string, value: boolean) => Promise<boolean>, problems: () => StoredXaeProblem[], isRunning: () => boolean}}
 */
function registerXaeBuildCommands(context, deps) {
    const spawn = deps.spawn || childProcess.spawn;
    const platform = deps.platform || process.platform;
    const execFile = deps.execFile || childProcess.execFile;
    const scriptPath = deps.scriptPath || path.join(context.extensionPath, 'resources', 'xae', 'build-plc-project.ps1');
    const minuteMs = deps.minuteMs || 60000;
    const graceMs = deps.graceMs === undefined ? 60000 : deps.graceMs;
    const stallCheckMs = deps.stallCheckMs || 30000;
    const listTimeoutMs = deps.listTimeoutMs || 60000;
    const tmpDir = deps.tmpDir || os.tmpdir();

    const collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    statusItem.command = 'workbench.actions.view.problems';
    context.subscriptions.push(collection, statusItem);
    /** @type {any} */
    let output = null;
    const channel = () => {
        if (!output) {
            output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
            context.subscriptions.push(output);
        }
        return output;
    };
    const stamp = () => `[${new Date().toISOString()}]`;

    let running = false;
    let cancelSeq = 0;
    let nextProblemId = 1;
    /** Normalized file URI → that file's problems of the last finished run. */
    /** @type {Map<string, {uri: vscode.Uri, problems: StoredXaeProblem[]}>} */
    const byFile = new Map();
    const keyOf = (/** @type {string} */ uriStr) => normalizeFileUri(uriStr);
    const allProblems = () => [...byFile.values()].flatMap(e => e.problems);

    // ── Settings and the dropdown ──────────────────────────────────────────────────────────────
    const config = () => vscode.workspace.getConfiguration(XAE_BUILD_SECTION);
    const readSettings = () => { const c = config(); return readXaeBuildSettings((k) => c.get(k)); };
    const xaeOptions = () => {
        const s = readSettings();
        return { available: platform === 'win32', showWindow: s.showWindow, running, configuration: s.configuration, platform: s.platform };
    };
    function optionsChanged() {
        const o = xaeOptions();
        if (deps.provider && typeof deps.provider.setXaeOptions === 'function') deps.provider.setXaeOptions({ available: o.available, showWindow: o.showWindow, running: o.running });
        if (deps.onSettingsChanged) deps.onSettingsChanged();
    }
    /**
     * The dropdown's "Show the XAE window" checkbox: writes `tcToolkit.xaeBuild.showWindow` in the
     * scope that decides it (the workspace when it has a value there, else the user settings).
     * @param {string} key
     * @param {boolean} value
     * @returns {Promise<boolean>} False for any other key.
     */
    async function setXaeOption(key, value) {
        if (key !== 'showWindow' || typeof value !== 'boolean') return false;
        const c = config();
        const inspected = typeof c.inspect === 'function' ? c.inspect('showWindow') : null;
        const targets = /** @type {any} */ (vscode).ConfigurationTarget || {};
        const target = inspected && inspected.workspaceValue !== undefined ? (targets.Workspace || 2) : (targets.Global || 1);
        try {
            await c.update('showWindow', value, target);
        } catch (err) {
            vscode.window.showErrorMessage(`Could not change the setting: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}`);
        }
        optionsChanged();
        return true;
    }
    const setRunning = (/** @type {boolean} */ on) => {
        running = on;
        Promise.resolve(vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, on)).catch(() => { /* no context in tests */ });
        optionsChanged();
    };

    // ── Problems and pane markers ──────────────────────────────────────────────────────────────
    function clearProblems() {
        collection.clear();
        byFile.clear();
    }
    /**
     * @param {Map<string, import('../xaeErrorPlacement').XaeProblem[]>} placed
     */
    function publishProblems(placed) {
        clearProblems();
        for (const [filePath, problems] of placed) {
            const uri = vscode.Uri.file(filePath);
            const stored = problems.map(p => ({ ...p, id: nextProblemId++ }));
            byFile.set(keyOf(uri.toString()), { uri, problems: stored });
            collection.set(uri, stored.map(p => problemDiagnostic(p, DIAGNOSTIC_SOURCE)));
        }
        if (deps.provider && typeof deps.provider.refreshCompileDiagnostics === 'function') deps.provider.refreshCompileDiagnostics();
    }
    if (deps.provider && typeof deps.provider.setCompileSource === 'function') {
        deps.provider.setCompileSource({
            paneDiagnostics: (/** @type {string} */ uriStr) => {
                const entry = byFile.get(keyOf(uriStr));
                return (entry ? entry.problems : []).map(p => ({
                    componentId: p.componentId, pane: p.pane,
                    severity: p.severity === 'error' ? 1 : (p.severity === 'warning' ? 2 : 3),
                    message: p.message,
                    range: { startLineNumber: p.line, startColumn: p.column, endLineNumber: p.endLine, endColumn: p.endColumn }
                }));
            },
            onComponentEdited: (/** @type {string} */ uriStr, /** @type {string} */ componentId) => {
                const entry = byFile.get(keyOf(uriStr));
                if (!entry || !entry.problems.some(p => p.componentId === componentId)) return;
                entry.problems = entry.problems.filter(p => p.componentId !== componentId);
                if (entry.problems.length === 0) { collection.delete(entry.uri); byFile.delete(keyOf(uriStr)); }
                else collection.set(entry.uri, entry.problems.map(p => problemDiagnostic(p, DIAGNOSTIC_SOURCE)));
            },
            openTarget: () => null
        }, 'xae');
    }

    // ── One driver run ─────────────────────────────────────────────────────────────────────────
    /**
     * Spawns the driver and follows it to its end: progress, cancel, timeout, stall.
     * @param {{mode: 'build'|'activate'|'listTargets', slnPath?: string, showWindow?: boolean, configuration?: string,
     *   platform?: string, targetNetId?: string, timeoutMs: number, stallMs?: number,
     *   token?: {isCancellationRequested: boolean, onCancellationRequested: (fn: () => void) => any},
     *   progress?: {report: (v: {message?: string}) => void}}} o
     * @returns {Promise<DriverRun>}
     */
    async function runDriver(o) {
        const state = createRunState({ expectedNetId: o.targetNetId });
        const cancelFile = o.mode === 'listTargets' ? '' : path.join(tmpDir, `tc-toolkit-xae-cancel-${process.pid}-${Date.now()}-${++cancelSeq}`);
        if (cancelFile) { try { fs.unlinkSync(cancelFile); } catch (e) { /* not there: good */ } }
        const args = buildDriverArgs({
            scriptPath, slnPath: o.slnPath, mode: o.mode, showWindow: o.showWindow, configuration: o.configuration,
            platform: o.platform, targetNetId: o.targetNetId, cancelFile
        });
        const ch = channel();
        /** @type {any} */
        let child = null;
        const spawnCapture = (/** @type {string} */ c, /** @type {string[]} */ a, /** @type {Object} */ opt) => { child = spawn(c, a, opt); return child; };
        let lastPhase = '';
        const splitter = createLineSplitter((line) => {
            const item = parseLine(line);
            reduce(state, item, Date.now());
            if (item.kind === 'log') {
                if (item.text.trim()) ch.appendLine(item.text);
            } else if (item.event.t === 'phase' && state.phase !== lastPhase) {
                lastPhase = state.phase || '';
                if (o.progress) o.progress.report({ message: lastPhase });
            }
        });
        /** @type {(() => void)|null} */
        let forceResolve = null;
        let exited = false;
        let stopping = false;
        let timedOut = false;
        let shellKilled = false;
        let rerunVisible = false;
        let activationTimedOut = false;
        let extended = false;
        /** @type {any[]} */
        const timers = [];
        const finished = runChild(/** @type {any} */ (spawnCapture), 'powershell.exe', args, {
            // The real timeout is handled below (graceful first); this is only a backstop.
            timeoutMs: 2147483647,
            onStdout: (chunk) => splitter.push(chunk),
            onStderr: (chunk) => { for (const l of String(chunk).split(/\r?\n/)) if (l.trim()) ch.appendLine(l); },
            onCancel: (cancel) => { forceResolve = cancel; }
        }).then((r) => { exited = true; return r; });

        const delay = (/** @type {number} */ ms) => new Promise((resolve) => { timers.push(setTimeout(resolve, ms)); });
        function forceStop() {
            if (child) killProcessTree(child, { platform, execFile: /** @type {any} */ (execFile) });
            const sh = state.shell;
            if (sh && sh.ours && sh.pid) {
                shellKilled = true;
                execFile('taskkill', ['/PID', String(sh.pid), '/T', '/F'], { windowsHide: true }, () => { /* gone or already gone */ });
                ch.appendLine(`${stamp()} Force-stopped the XAE Shell this run started (PID ${sh.pid}).`);
            } else if (sh && sh.pid === null) {
                ch.appendLine(`${stamp()} The XAE Shell could not be identified as this run's, so it was left running; close it yourself.`);
            }
            if (forceResolve) forceResolve();
        }
        /**
         * Cancel file, grace period, then the force stop — never once activation has begun.
         * @returns {Promise<'stopped'|'refused'>}
         */
        async function requestStop() {
            if (stopping || exited) return 'stopped';
            if (!canCancel(state)) return 'refused';
            stopping = true;
            if (cancelFile) {
                try { fs.writeFileSync(cancelFile, 'cancel'); } catch (e) { ch.appendLine(`${stamp()} Could not write the cancel file: ${e}`); }
                ch.appendLine(`${stamp()} Cancel requested; waiting up to ${Math.round(graceMs / 1000)} s for the driver to close the XAE Shell.`);
                await Promise.race([finished, delay(graceMs)]);
            }
            if (exited) return 'stopped';
            if (!canCancel(state)) {
                // It entered activation during the grace period: let it finish.
                stopping = false;
                ch.appendLine(`${stamp()} ${CANCEL_REFUSED_TEXT}`);
                return 'refused';
            }
            forceStop();
            return 'stopped';
        }
        if (o.token) {
            o.token.onCancellationRequested(() => {
                requestStop().then((r) => {
                    if (r === 'refused') vscode.window.showWarningMessage(CANCEL_REFUSED_TEXT);
                });
            });
        }
        const onTimeout = () => {
            if (exited) return;
            if (canCancel(state)) {
                timedOut = true;
                ch.appendLine(`${stamp()} The run timed out; stopping it.`);
                requestStop();
            } else if (!extended) {
                extended = true;
                ch.appendLine(`${stamp()} The timeout fell during activation; waiting 5 more minutes.`);
                timers.push(setTimeout(onTimeout, 5 * minuteMs));
            } else {
                activationTimedOut = true;
                ch.appendLine(`${stamp()} Timed out during activation; check the target. The run was not stopped.`);
                vscode.window.showWarningMessage('The XAE build timed out during activation; check the target. It was not stopped.');
            }
        };
        timers.push(setTimeout(onTimeout, o.timeoutMs));
        if (o.stallMs && o.mode !== 'listTargets') {
            let offered = false;
            const watch = setInterval(() => {
                if (offered || exited || !isStalled(state, Date.now(), { showWindow: o.showWindow, stallMs: /** @type {number} */ (o.stallMs) })) return;
                offered = true;
                const minutes = Math.round(/** @type {number} */ (o.stallMs) / minuteMs);
                ch.appendLine(`${stamp()} No output from the headless XAE build for ${minutes} minute(s) (phase: ${state.phase || 'starting'}).`);
                Promise.resolve(vscode.window.showWarningMessage(
                    `The headless XAE build has shown no progress for ${minutes} minute(s); it may be waiting on a dialog nobody can see.`,
                    STALL_RERUN, STALL_WAIT)).then((choice) => {
                    if (choice === STALL_RERUN) {
                        rerunVisible = true;
                        requestStop();
                    } else {
                        state.lastEventAt = Date.now();
                        offered = false;
                    }
                });
            }, stallCheckMs);
            timers.push({ interval: watch });
        }

        const r = await finished;
        splitter.end();
        for (const t of timers) { if (t && t.interval) clearInterval(t.interval); else clearTimeout(t); }
        if (cancelFile) { try { fs.unlinkSync(cancelFile); } catch (e) { /* never written */ } }
        /** @type {DriverRun['outcome']} */
        let outcome = r.outcome;
        if (r.outcome === 'cancelled') outcome = timedOut ? 'timeout' : 'killed';
        // A timeout that the driver honoured through the cancel file (exit 4) is still a timeout.
        if (timedOut && r.outcome === 'exit' && r.code === EXIT.CANCELLED) outcome = 'timeout';
        return { code: r.code, outcome, state, error: r.error, rerunVisible, shellKilled, activationTimedOut };
    }

    // ── Shared steps of a command ──────────────────────────────────────────────────────────────
    /**
     * The project and its solution, or null with the reason already shown.
     * @param {any} a The command's arguments ({projectKey?, fsPath?}).
     * @param {string} title
     * @returns {Promise<{key: string, projectName: string, slnPath: string}|{reason: string}>}
     */
    async function resolveSolution(a, title) {
        const projectMap = deps.getProjectMap();
        if (!projectMap || !projectMap.projects || projectMap.projects.size === 0) {
            vscode.window.showWarningMessage(`${title} needs a TwinCAT PLC project (.plcproj) in the workspace.`);
            return { reason: 'no-project' };
        }
        let key = typeof a.projectKey === 'string' ? a.projectKey : '';
        if (!key && typeof a.fsPath === 'string' && typeof projectMap.ownersOf === 'function') {
            const owners = projectMap.ownersOf(a.fsPath);
            if (owners.length === 1) key = owners[0];
        }
        if (!key) key = await pickProjectKey(projectMap, { title, placeHolder: 'PLC project whose solution to build' });
        if (!key) return { reason: 'cancelled' };
        const projectName = projectMap.displayName(key);
        const solutionMap = deps.getSolutionMap();
        const solution = solutionMap && typeof solutionMap.solutionForProject === 'function' ? solutionMap.solutionForProject(key) : null;
        if (!solution || !solution.slnPath) {
            vscode.window.showErrorMessage(`No solution found for ${projectName}.`);
            return { reason: 'no-solution' };
        }
        return { key, projectName, slnPath: solution.slnPath };
    }

    /**
     * Warns when no XAE Shell of the project's TwinCAT build is configured; true to go on.
     * @param {string} slnPath
     * @returns {Promise<boolean>}
     */
    async function shellCheck(slnPath) {
        const build = projectTcBuild(slnPath, fs);
        if (!build) return true;
        const shell = XAE_SHELL_VERSIONS.find(v => v.id === build);
        const xaeConfig = vscode.workspace.getConfiguration(XAE_SHELL_SECTION);
        const configured = shell ? describeConfiguredShells((k) => xaeConfig.get(k), (p) => fs.existsSync(p)).find(s => s.id === build) : null;
        if (configured && configured.path && configured.exists) return true;
        const text = shell
            ? `No XAE Shell for TwinCAT ${shell.version} was found on this machine (setting ${shell.setting}); the solution was saved with it.`
            : `The solution was saved with TwinCAT 3.1.${build}, for which no XAE Shell is known here.`;
        const choice = await vscode.window.showWarningMessage(text, 'Run anyway');
        return choice === 'Run anyway';
    }

    /**
     * Lists the targets (`-ListTargets`, no COM).
     * @param {string} [slnPath]
     * @returns {Promise<DriverRun>}
     */
    function listTargets(slnPath) {
        return runDriver({ mode: 'listTargets', slnPath, timeoutMs: listTimeoutMs });
    }

    /**
     * A finished build or activation run: the channel, Problems, the status bar and the summary.
     * @param {DriverRun} run
     * @param {string} slnPath
     * @returns {{ok: boolean, exitCode: number|null, outcome: string, title: string, uiMode: string, placed: number, total: number,
     *   targetMismatch: boolean}}
     */
    function report(run, slnPath) {
        const ch = channel();
        const { state } = run;
        const d = describeExit(run.code, run.outcome, state, { error: run.error });
        const uiMode = describeUiMode(state);
        if (state.mode) ch.appendLine(`${stamp()} ${uiMode}`);
        if (state.protocolWarnings > 0) ch.appendLine(`${stamp()} ${state.protocolWarnings} driver line(s) were not readable events of this version.`);
        // A run that did not get to a build result says nothing about the code: the previous problems stay.
        const built = run.outcome === 'exit' && (run.code === EXIT.OK || run.code === EXIT.COMPILE || run.code === EXIT.ACTIVATION);
        const placement = placeXaeErrors(state.errorItems, state.panes, {
            readFile: (p) => fs.readFileSync(p, 'utf8'), exists: (p) => fs.existsSync(p), slnDir: path.dirname(slnPath)
        });
        if (built) publishProblems(placement.byFile);
        for (const g of placement.general) ch.appendLine(`  error (not placed): ${g.description}${g.file ? ` [${g.file}${g.line ? `:${g.line}` : ''}]` : ''}`);
        const errorsLine = run.outcome === 'exit' ? placementSummary(placement, run.code === null ? -1 : run.code, OUTPUT_CHANNEL_NAME) : '';
        let title = d.title;
        let severity = d.severity;
        if (state.targetMismatch) {
            title = `The driver activated ${state.target ? state.target.netId : 'another target'}, not the confirmed ${state.expectedNetId}. ${title}`;
            severity = 'error';
        }
        if (run.activationTimedOut) title = `Timed out during activation; check the target. ${title}`;
        ch.appendLine(`${stamp()} ${title}${errorsLine ? ' ' + errorsLine : ''}`);
        if (d.detail) ch.appendLine(`  ${d.detail}`);
        if (state.shell && !state.shell.ours && run.outcome !== 'exit') {
            ch.appendLine('  The XAE Shell was not started by this run (or could not be identified), so it was left running.');
        }
        statusItem.text = d.ok ? '$(check) XAE build' : (run.code === EXIT.COMPILE ? `$(error) XAE build: ${placement.total || 'failed'}` : '$(warning) XAE build');
        statusItem.tooltip = 'Result of the last Build through XAE run. Click to open the Problems panel.';
        statusItem.show();
        const show = severity === 'error' ? vscode.window.showErrorMessage
            : (severity === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage);
        const buttons = ['Show Output'];
        if (byFile.size > 0 && built) buttons.unshift('Go to Problem…');
        Promise.resolve(show(`${title}${errorsLine ? ' ' + errorsLine : ''}`, ...buttons)).then((choice) => {
            if (choice === 'Show Output') ch.show(true);
            else if (choice === 'Go to Problem…') vscode.commands.executeCommand(GO_TO_PROBLEM_COMMAND);
        });
        return {
            ok: d.ok && !state.targetMismatch, exitCode: run.code, outcome: run.outcome, title, uiMode,
            placed: placement.placed, total: placement.total, targetMismatch: state.targetMismatch
        };
    }

    /**
     * The whole flow of `twincat.xaeBuild` and `twincat.xaeBuildAndActivate`.
     * @param {any} args
     * @param {boolean} activate
     * @returns {Promise<any>}
     */
    async function buildCommand(args, activate) {
        const a = args && typeof args === 'object' ? args : {};
        const title = activate ? 'Build and Activate through XAE' : 'Build through XAE';
        if (platform !== 'win32') {
            vscode.window.showErrorMessage(PLATFORM_TEXT);
            return { ok: false, reason: 'platform' };
        }
        if (running) {
            vscode.window.showInformationMessage('A build through XAE is already running.');
            return { ok: false, reason: 'running' };
        }
        running = true;
        try {
            const resolved = await resolveSolution(a, title);
            if (!('slnPath' in resolved)) return { ok: false, reason: resolved.reason };
            const { slnPath } = resolved;
            const solutionName = path.basename(slnPath, path.extname(slnPath));
            if (!(await shellCheck(slnPath))) return { ok: false, reason: 'cancelled' };
            const settings = readSettings();
            const configuration = typeof a.configuration === 'string' ? a.configuration : settings.configuration;
            const pform = typeof a.platform === 'string' ? a.platform : settings.platform;
            const showWindow = a.showWindow === true ? true : settings.showWindow;

            /** @type {{netId: string, name: string}|null} */
            let target = null;
            if (activate) {
                setRunning(true);
                const listed = await listTargets(slnPath);
                const items = targetPickItems(listed.state.targets, { preselect: context.workspaceState.get(LAST_TARGET_KEY) });
                if (items.length === 0) {
                    vscode.window.showErrorMessage('No runtime of this machine was found to activate on. ' +
                        (listed.state.fatal ? listed.state.fatal.text : describeExit(listed.code, listed.outcome, listed.state).title));
                    return { ok: false, reason: 'no-targets' };
                }
                const picked = await vscode.window.showQuickPick(items, { title: `${title}: activation target`, placeHolder: 'Runtime of this machine to activate on' });
                if (!picked) return { ok: false, reason: 'cancelled' };
                const c = confirmationText(picked, solutionName);
                const answer = await vscode.window.showWarningMessage(c.message, { modal: true }, c.confirmLabel);
                if (answer !== c.confirmLabel) return { ok: false, reason: 'cancelled' };
                target = { netId: picked.netId, name: picked.name };
                await context.workspaceState.update(LAST_TARGET_KEY, picked.netId);
            }

            const ch = channel();
            ch.appendLine(`${stamp()} ${title}: ${slnPath} - ${configuration} | ${pform}` +
                (target ? ` - target ${target.name} (${target.netId})` : ''));
            ch.appendLine(`  Requested: ${showWindow ? 'XAE window shown for the whole run (tcToolkit.xaeBuild.showWindow)' : 'headless (XAE window hidden, UI suppressed)'}` +
                (activate ? '; the window is shown during activation in either case.' : '.'));
            setRunning(true);
            const run = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `${title}: ${solutionName}`, cancellable: true },
                (progress, token) => runDriver({
                    mode: activate ? 'activate' : 'build', slnPath, showWindow, configuration, platform: pform,
                    targetNetId: target ? target.netId : undefined, timeoutMs: settings.timeoutMinutes * minuteMs,
                    stallMs: settings.stallMinutes * minuteMs, token, progress
                }));
            const result = report(run, slnPath);

            // The stall offer: the same run again with the window shown (this run only).
            if (run.rerunVisible) {
                running = false;
                setRunning(false);
                return buildCommand({ ...a, projectKey: resolved.key, showWindow: true, configuration, platform: pform }, activate);
            }
            // A configuration the solution does not declare: pick one of its own.
            if (run.code === EXIT.HARNESS && run.state.fatal && run.state.fatal.code === 'config-not-declared'
                && run.state.fatal.data && Array.isArray(run.state.fatal.data.declared) && run.state.fatal.data.declared.length > 0) {
                /** @type {any} */
                const pair = await vscode.window.showQuickPick(run.state.fatal.data.declared.map((/** @type {string} */ d) => ({ label: d })),
                    { title: `'${configuration}|${pform}' is not declared by ${solutionName}`, placeHolder: 'Configuration | platform to build' });
                if (pair) {
                    /** @type {any} */
                    const how = await vscode.window.showQuickPick([{ label: 'Run once' }, { label: 'Run and use for this workspace' }],
                        { title: pair.label, placeHolder: 'Use this configuration for this run only, or keep it for this workspace' });
                    if (how) {
                        const bar = pair.label.indexOf('|');
                        const cfg = pair.label.slice(0, bar);
                        const plat = pair.label.slice(bar + 1);
                        if (how.label === 'Run and use for this workspace') {
                            const targets = /** @type {any} */ (vscode).ConfigurationTarget || {};
                            await config().update('configuration', cfg, targets.Workspace || 2);
                            await config().update('platform', plat, targets.Workspace || 2);
                        }
                        running = false;
                        setRunning(false);
                        return buildCommand({ ...a, projectKey: resolved.key, configuration: cfg, platform: plat }, activate);
                    }
                }
            }
            return { ...result, projectKey: resolved.key, slnPath, targetNetId: target ? target.netId : null };
        } finally {
            if (running) setRunning(false);
            running = false;
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.xaeBuild', (args) => buildCommand(args, false)),
        vscode.commands.registerCommand('twincat.xaeBuildAndActivate', (args) => buildCommand(args, true)),
        vscode.commands.registerCommand('twincat.xaeShowTargets', async (args) => {
            if (platform !== 'win32') {
                vscode.window.showErrorMessage(PLATFORM_TEXT);
                return { ok: false, reason: 'platform' };
            }
            const a = args && typeof args === 'object' ? args : {};
            let slnPath;
            const projectMap = deps.getProjectMap();
            if (projectMap && projectMap.projects && projectMap.projects.size > 0) {
                const resolved = await resolveSolution(a, 'Show Activation Targets');
                if ('slnPath' in resolved) slnPath = resolved.slnPath;
            }
            const ch = channel();
            ch.appendLine(`${stamp()} Activation targets (runtimes of this machine; read-only)${slnPath ? ` for ${slnPath}` : ''}:`);
            const run = await listTargets(slnPath);
            const t = run.state.targets;
            if (t && t.local.length > 0) {
                for (const r of t.local) {
                    ch.appendLine(`  ${r.netId.padEnd(20)} ${r.kind.padEnd(10)} ${r.name}  ${r.platform || 'platform unknown'}${t.projectNetId === r.netId ? '  (project)' : ''}`);
                }
            } else {
                ch.appendLine(`  none found. ${describeExit(run.code, run.outcome, run.state).title}`);
            }
            if (t && t.projectNetId && !t.local.some(r => r.netId === t.projectNetId)) {
                ch.appendLine(`  The project names ${t.projectNetId}, which is not a runtime of this machine: activation onto it is refused.`);
            }
            ch.show(true);
            return { ok: !!t, targets: t ? t.local.slice() : [], projectNetId: t ? t.projectNetId : null };
        }),
        vscode.commands.registerCommand('twincat.xaeBuild.goToProblem', async () => {
            const problems = allProblems().sort((x, y) => (x.severity === y.severity ? 0 : (x.severity === 'error' ? -1 : 1)));
            if (problems.length === 0) {
                vscode.window.showInformationMessage('There are no XAE build problems. Run TC Toolkit: Build through XAE first.');
                return;
            }
            const picked = await vscode.window.showQuickPick(problems.map(p => ({
                label: `${p.severity === 'error' ? '$(error)' : '$(warning)'} ${p.message}`,
                description: path.basename(p.filePath), detail: describeLocation(p, memberName), problem: p
            })), { title: 'XAE build problems', placeHolder: 'Go to a problem', matchOnDescription: true, matchOnDetail: true });
            if (picked) await openProblem(picked.problem);
        }),
        vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(XAE_BUILD_SECTION)) optionsChanged(); })
    );

    if (deps.provider && typeof deps.provider.setXaeSource === 'function') {
        deps.provider.setXaeSource({
            options: () => { const o = xaeOptions(); return { available: o.available, showWindow: o.showWindow, running: o.running }; },
            set: setXaeOption,
            run: (/** @type {boolean} */ activate, /** @type {string} */ fsPath) =>
                Promise.resolve(vscode.commands.executeCommand(activate ? 'twincat.xaeBuildAndActivate' : 'twincat.xaeBuild', { fsPath }))
        });
    }
    Promise.resolve(vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, false)).catch(() => { /* no context in tests */ });

    return { xaeOptions, setXaeOption, problems: allProblems, isRunning: () => running };
}

module.exports = {
    registerXaeBuildCommands, projectTcBuild,
    OUTPUT_CHANNEL_NAME, DIAGNOSTIC_SOURCE, COLLECTION_NAME, GO_TO_PROBLEM_COMMAND, RUNNING_CONTEXT_KEY, LAST_TARGET_KEY,
    CANCEL_REFUSED_TEXT, PLATFORM_TEXT, STALL_RERUN, STALL_WAIT
};
