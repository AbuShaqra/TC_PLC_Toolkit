/**
 * @file compileCommands.js
 * @description The VS Code half of Compile Project (roadmap R3.2): the `twincat.compileProject`
 * command, and where its results go — the Problems panel, markers in the open panes, a status-bar
 * item and a summary notification.
 *
 * The work itself (setup check, check units, running the compiler as a child process, reading its
 * report, mapping) is the vscode-free src/compileCheck.js; this module only asks, shows and routes.
 *
 * Where a result goes, and why two places:
 *   - **Problems panel** — a DiagnosticCollection on the object's FILE, at the real position of the
 *     text inside the XML document, with the component, pane and pane line in the message. A custom
 *     editor is not handed the position of a clicked Problems entry (VS Code passes it to text
 *     editors only), so exact navigation is offered three ways: each entry's code is a link that
 *     opens that component, pane and line; the notification's "Go to Problem…" lists every problem;
 *     and a file opened fresh (which is what a click on an entry of a closed file does) opens on its
 *     first problem.
 *   - **Pane markers** — the custom editor provider posts them to the webview under their own
 *     marker owner, so the language server's diagnostics and these never erase each other.
 *
 * A component's results are dropped when that component is edited, and all of them when the next
 * run starts. They are never persisted: a compile result describes one moment.
 *
 * C++ generation and the g++ build (roadmap R13), both off by default: with
 * `tcToolkit.compiler.generateCpp` on, a check with no errors is followed by the compiler's compile
 * mode, whose `.cpp` / `.hpp` go into `<project dir>/CPP_Files/` (src/cppGenerate.js, which never
 * touches a file the toolkit did not write); with `tcToolkit.compiler.buildWithGpp` on, g++ then
 * compiles that `.cpp` (src/gpp.js) and its messages go to the Problems panel on the generated files,
 * under their own collection and source. The two switches stay consistent (src/cppSettings.js), and
 * the editor toolbar's and the start page's Compile dropdowns show and write them through
 * `setCompileOption`.
 */

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseTwinCatXml, replaceComponentCdata } = require('../xmlParser');
const { normalizeFileUri } = require('../fileUri');
const { memberName } = require('../componentId');
const pendingEditsCore = require('../../media/pendingEdits');
const {
    COMPILER_SECTION, isCompilerAvailable, checkSetup, buildCheckInputs, runCheck, summarize, describeLocation, paneRange
} = require('../compileCheck');
const { prepareLibraryCheck } = require('../libraryDecls');
const { projectDefineArgs, fileDefineArgs } = require('../compilerDefines');
const { CPP_SECTION, effectiveOptions, couplingWrites, checkboxWrites, readOptionState } = require('../cppSettings');
const {
    cppOutputPaths, cppOwnerId, writeOwnedOutputs, recordOwnedFile, claimOutput, runGenerate, gitignoreNote,
    libraryCoverage, libraryCoverageText, libraryCoverageLines, libraryUndeclaredLines, libraryCoverageHeader, withCoverageHeader, UNKNOWN_LIBRARY
} = require('../cppGenerate');
const { msys2RootsWithin } = require('../msys2Detect');
const { SETTING_GPP_PATH, resolveGpp, describeGppProblem, buildGppArgs, placeGppMessages, runGpp, summarizeGpp, gppTooOldText, gppInstallHint, msys2NoGppText, thisMachine } = require('../gpp');

/** The `source` of every diagnostic this command publishes. */
const DIAGNOSTIC_SOURCE = 'TC Toolkit compile';

/** The `source` of the g++ build's diagnostics (on the generated C++ files). */
const GPP_DIAGNOSTIC_SOURCE = 'TC Toolkit g++';

/** The path of the links the Problems entries carry (`<scheme>://<extension id>/compileProblem?id=N`). */
const PROBLEM_LINK_PATH = '/compileProblem';

/** Internal command: pick one of the current compile problems and go to it. */
const GO_TO_PROBLEM_COMMAND = 'twincat.compile.goToProblem';
/** The output channel for what a run did not show elsewhere (the project's compiler defines). */
const OUTPUT_CHANNEL_NAME = 'TC Toolkit Compile';

/**
 * @typedef {import('../compileCheck').CompileDiagnostic & {id: number}} StoredProblem
 */

/**
 * @typedef {Object} GppOutcome The g++ part of a run.
 * @property {'done'|'failed'|'cancelled'|'timeout'|'missing'|'too-old'|'skipped'} status `done`: g++ ran to its
 *   end (`exitCode` says whether it compiled); `missing`: no g++; `too-old`: a g++ older than 7 (not
 *   run); `skipped`: not run, `message` says why.
 * @property {number|null} [exitCode]
 * @property {string} [gppPath]
 * @property {string} [message]
 * @property {'not-found'|'setting-missing'} [reason] For `missing`.
 * @property {string} [configured] For `missing`: the setting's value.
 * @property {string} [version] For `too-old`: the version g++ reported.
 * @property {'setting'|'path'|'default'} [source] For `too-old`: where that g++ came from.
 * @property {string} [problem] For `missing` with `setting-missing`: why the value does not work (src/gpp.js checkConfiguredGpp).
 * @property {string} [msys2Root] For `missing` and a detected `too-old`: MSYS2 is installed there without g++.
 * @property {import('../gpp').PlacedGppMessage[]} [placed]
 * @property {string} [summary] summarizeGpp's line, for `done`.
 */

/**
 * @typedef {Object} CppOutcome The C++ part of a run (R13).
 * @property {'done'|'failed'|'cancelled'|'timeout'|'skipped'} status `skipped`: the check had errors.
 * @property {string} message Why not done.
 * @property {ReturnType<typeof cppOutputPaths>} [paths]
 * @property {import('../cppGenerate').WriteResult} [written]
 * @property {GppOutcome} [gpp]
 * @property {string} [log] Compiler or g++ output for the output channel.
 * @property {string} [logTitle]
 * @property {import('../cppGenerate').LibraryCoverage[]} [libraries] Library code the C++ does not
 *   cover (empty bodies, declarations only), per library.
 */

/**
 * The `twincat.openComponent` selection of a problem (0-based line and characters).
 * @param {{pane: string, line: number, column: number, endLine: number, endColumn: number}} p
 */
function selectionOf(p) {
    return {
        pane: p.pane, localLine: p.line - 1,
        start: { character: p.column - 1 },
        end: { character: p.endLine === p.line ? p.endColumn - 1 : p.column - 1 }
    };
}

/**
 * Opens the editor on one problem: its component, pane and line. Shared with Build through XAE (R14).
 * @param {{filePath: string, componentId: string, pane: string, line: number, column: number, endLine: number, endColumn: number}} p
 */
async function openProblem(p) {
    await vscode.commands.executeCommand('twincat.openComponent', vscode.Uri.file(p.filePath), p.componentId, selectionOf(p), null);
}

/**
 * The Problems-panel entry of a placed problem: pane coordinates (so Ln/Col match the pane the user
 * reads), the component, pane and line in the message. Shared with Build through XAE (R14).
 * @param {{componentId: string, pane: 'decl'|'impl', line: number, column: number, endLine?: number, endColumn?: number,
 *   severity: string, message: string}} p
 * @param {string} source
 * @param {any} [link] The code's link target; without one the code is the location text alone.
 * @returns {vscode.Diagnostic}
 */
function problemDiagnostic(p, source, link) {
    const at = paneRange(p);
    const range = new vscode.Range(at.start.line, at.start.character, at.end.line, at.end.character);
    const where = describeLocation(p, memberName);
    const d = new vscode.Diagnostic(range, `${p.message} [${where}]`,
        p.severity === 'error' ? vscode.DiagnosticSeverity.Error
            : (p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information));
    d.source = source;
    d.code = link ? { value: where, target: link } : where;
    return d;
}

/**
 * One PLC project of the workspace: the only one, or the user's pick. Shared with Build through XAE.
 * @param {{keys: () => Iterable<string>, displayName: (key: string) => string}} projectMap
 * @param {{title: string, placeHolder: string}} labels
 * @returns {Promise<string>} '' when the user dismissed the pick.
 */
async function pickProjectKey(projectMap, labels) {
    const keys = [...projectMap.keys()];
    if (keys.length === 1) return keys[0];
    const items = keys.map(k => ({ label: projectMap.displayName(k), key: k })).sort((x, y) => x.label.localeCompare(y.label));
    const picked = await vscode.window.showQuickPick(items, labels);
    return picked ? picked.key : '';
}

/**
 * Why the g++ build did not run for want of a g++ (shown once, in the run's summary).
 * @param {{reason?: string, configured?: string, problem?: string, msys2Root?: string}} gpp `msys2Root`:
 *   MSYS2 is installed there without g++ (src/msys2Detect.js).
 * @returns {string}
 */
function gppMissingText(gpp) {
    return gpp.reason === 'setting-missing'
        ? `Not built with g++: the g++ path setting does not work (${gpp.configured}: ${describeGppProblem(gpp.problem || 'missing')}). Fix the path to build it.`
        : (gpp.msys2Root
            ? `Not built with g++: ${msys2NoGppText(gpp.msys2Root)}, then run "Detect g++".`
            : 'Not built with g++: g++ was not found on PATH or in the usual install folders. Set the g++ path, or let "Detect g++" find it.');
}

/**
 * The buttons a missing g++ adds to the run's summary: the setting, and detection only where it can
 * help (detection fills an EMPTY setting, and never replaces a value the user set).
 * @param {{reason?: string}} gpp
 * @returns {string[]}
 */
function gppMissingButtons(gpp) {
    return gpp.reason === 'setting-missing' ? ['Open Setting'] : ['Open Setting', 'Detect g++'];
}

/**
 * Why the g++ build did not run for a g++ that is too old (shown once, in the run's summary). When the
 * setting names it, the hint says to change or clear the setting (detection never replaces it).
 * @param {{version?: string, gppPath?: string, source?: string, msys2Root?: string}} gpp
 * @param {string} [platform]
 * @returns {string}
 */
function gppTooOldNote(gpp, platform = process.platform) {
    const hint = gpp.msys2Root && gpp.source !== 'setting'
        ? `${msys2NoGppText(gpp.msys2Root)}, then run "Detect g++".`
        : gppInstallHint(platform, { fromSetting: gpp.source === 'setting' });
    return `Not built with g++: ${gppTooOldText(gpp.version || '?')} (${gpp.gppPath || 'g++'}) ${hint}`;
}

/**
 * The buttons a too-old g++ adds to the run's summary: "Detect g++" only when the setting is empty,
 * since detection never replaces a set value.
 * @param {{source?: string}} gpp
 * @returns {string[]}
 */
function gppTooOldButtons(gpp) {
    return gpp.source === 'setting' ? ['Open Setting'] : ['Open Setting', 'Detect g++'];
}

/**
 * What a run's C++ part adds to the summary notification.
 * @param {CppOutcome|null} cpp
 * @returns {{notes: string[], failed: boolean, warn: boolean}} `failed`: the notification is an
 *   error; `warn`: at least a warning.
 */
function describeCpp(cpp) {
    /** @type {string[]} */
    const notes = [];
    let failed = false;
    let warn = false;
    if (!cpp) return { notes, failed, warn };
    const names = (/** @type {string[]} */ list) => list.map(p => path.basename(p)).join(', ');
    if (cpp.status === 'skipped') { notes.push(cpp.message); warn = true; return { notes, failed, warn }; }
    if (cpp.status === 'cancelled') { notes.push('The C++ generation was cancelled.'); warn = true; return { notes, failed, warn }; }
    const libraries = cpp.libraries || [];
    if (cpp.status !== 'done' && libraries.some(e => e.undeclared.length > 0)) {
        const missing = libraries.flatMap(e => e.undeclared.map(n => `${n} (${e.library || UNKNOWN_LIBRARY})`));
        notes.push(`C++ could not be generated: there is no declaration the compiler can use for ${missing.length === 1 ? 'the library symbol' : 'these library symbols'} ${missing.join(', ')}` +
            ` (run "TC Toolkit: Update Library Definitions" if the library signatures are missing).${cpp.log ? ` See the "${OUTPUT_CHANNEL_NAME}" output.` : ''}`);
        return { notes, failed: true, warn };
    }
    if (cpp.status !== 'done') {
        notes.push(`C++ generation failed: ${cpp.message}${cpp.log ? ` See the "${OUTPUT_CHANNEL_NAME}" output.` : ''}`);
        return { notes, failed: true, warn };
    }
    const written = cpp.written || { written: [], removed: [], refused: [], gitignore: undefined };
    const where = cpp.paths ? `${path.basename(path.dirname(cpp.paths.dir))}/${path.basename(cpp.paths.dir)}` : 'CPP_Files';
    if (written.written.length > 0) notes.push(`C++ written to ${where}: ${names(written.written)}.`);
    if (written.refused.length > 0) {
        warn = true;
        const one = written.refused.length === 1;
        // The toolkit's .gitignore lists only its own files, so these are not ignored by git (cppGenerate gitignoreText).
        const gi = written.gitignore && ['created', 'updated', 'unchanged'].includes(written.gitignore.status)
            ? ` ${where}/.gitignore does not list ${one ? 'it' : 'them'}, so git sees ${one ? 'it' : 'them'}.` : '';
        notes.push(`Left alone in ${where} (not written by TC Toolkit, or changed since): ${names(written.refused.map(r => r.path))}. Delete or rename ${one ? 'it' : 'them'} to let the C++ be written.${gi}`);
    }
    if (written.removed.length > 0) notes.push(`Removed earlier output: ${names(written.removed)}.`);
    const gpp = cpp.gpp;
    if (libraries.length > 0) {
        warn = true;
        notes.push(libraryCoverageText(libraries, { built: !!gpp && gpp.status === 'done', channel: OUTPUT_CHANNEL_NAME }));
    }
    if (!gpp) return { notes, failed, warn };
    if (gpp.status === 'missing') { warn = true; notes.push(gppMissingText(gpp)); }
    else if (gpp.status === 'too-old') { warn = true; notes.push(gppTooOldNote(gpp)); }
    else if (gpp.status === 'skipped') { warn = true; notes.push(gpp.message || 'g++ was not run.'); }
    else if (gpp.status === 'cancelled') { warn = true; notes.push('The g++ build was cancelled.'); }
    else if (gpp.status === 'done') {
        notes.push(gpp.summary || '');
        if (gpp.exitCode !== 0) {
            failed = true;
            if (!(gpp.placed && gpp.placed.length)) notes.push(`See the "${OUTPUT_CHANNEL_NAME}" output.`);
        }
    } else { failed = true; notes.push(gpp.message || 'g++ did not finish.'); }
    return { notes: notes.filter(Boolean), failed, warn };
}

/**
 * The status-bar text of a run: the check's counts, then what the C++ part did.
 * @param {{errors: number, warnings: number}} counts
 * @param {CppOutcome|null} cpp
 * @param {{errors: number, warnings: number}} gpp The g++ messages placed in the Problems panel.
 * @returns {string}
 */
function compileStatusText(counts, cpp, gpp) {
    let text = counts.errors === 0 && counts.warnings === 0
        ? '$(check) Compile: no errors'
        : `$(error) ${counts.errors} $(warning) ${counts.warnings} Compile`;
    if (!cpp) return text;
    if (cpp.status === 'done' && cpp.written && cpp.written.written.length > 0) text += ' · C++ written';
    else if (cpp.status !== 'skipped') text += ' · C++ not written';
    const g = cpp.gpp;
    if (g) {
        if (g.status === 'done' && g.exitCode === 0) text += ' · g++ $(check)';
        else if (g.status === 'done') text += ` · g++ $(error) ${gpp.errors}`;
        else if (g.status === 'missing') text += ' · g++ not found';
        else if (g.status === 'too-old') text += ' · g++ too old';
        else text += ' · g++ not run';
    }
    return text;
}

/**
 * Registers Compile Project.
 * @param {vscode.ExtensionContext} context
 * @param {object} deps
 * @param {any} deps.provider The custom editor provider (pane markers, pending edits).
 * @param {() => any} deps.getProjectMap The host's current project partition.
 * @param {() => void} [deps.onSettingsChanged] Called when a `tcToolkit.compiler.*` setting changes.
 * @param {Function} [deps.spawn] Child-process factory, for tests.
 * @param {import('../compileCheck').NodeDiscovery} [deps.nodeDiscovery] Where Node is looked for, for tests.
 * @param {{platform: string, env: Record<string, string|undefined>, exists: (p: string) => boolean}} [deps.gppDiscovery]
 *   Where g++ is looked for, for tests (default: this machine).
 * @param {() => Promise<any>} [deps.fillGppPath] Fills an empty g++ path setting (src/commands/gppCommands.js);
 *   called when the g++ build is turned on.
 * @param {() => Promise<unknown>} [deps.gppReady] Waits (bounded) for the MSYS2 registry search before
 *   g++ is resolved (default src/msys2Detect.js msys2RootsWithin); for tests.
 * @returns {{isAvailable: () => boolean, problemsFor: (uriStr: string) => StoredProblem[],
 *   compileOptions: () => {generateCpp: boolean, buildWithGpp: boolean},
 *   setCompileOption: (key: string, value: boolean) => Promise<boolean>}}
 */
function registerCompileCommands(context, { provider, getProjectMap, onSettingsChanged, spawn, nodeDiscovery, gppDiscovery, fillGppPath, gppReady = () => msys2RootsWithin() }) {
    const collection = vscode.languages.createDiagnosticCollection('twincat-compile');
    const gppCollection = vscode.languages.createDiagnosticCollection('twincat-gpp');
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    statusItem.command = 'workbench.actions.view.problems';
    context.subscriptions.push(collection, gppCollection, statusItem);

    /** Normalized file URI → that file's problems of the last run. */
    /** @type {Map<string, {uri: vscode.Uri, problems: StoredProblem[]}>} */
    const byFile = new Map();
    /** Files whose first problem has already been used as the place a fresh editor opens on. */
    const openTargetUsed = new Set();
    let nextProblemId = 1;
    let running = false;
    /** The "no library dump" hint is given once per session, not on every run. */
    let dumpHintGiven = false;
    /** @type {any} Created on first use: only a project with compiler defines writes to it. */
    let output = null;
    const outputChannel = () => {
        if (!output) {
            output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
            context.subscriptions.push(output);
        }
        return output;
    };

    const readSettings = () => {
        const config = vscode.workspace.getConfiguration(COMPILER_SECTION);
        return { compilerPath: String(config.get('path', '') || ''), nodePath: String(config.get('nodePath', '') || '') };
    };
    // ── C++ generation and the g++ build: the two switches (src/cppSettings.js) ────────────────
    const optionState = () => {
        const config = vscode.workspace.getConfiguration(CPP_SECTION);
        if (typeof config.inspect === 'function') return readOptionState(/** @type {any} */ (config));
        return { generateCpp: { global: config.get('generateCpp') }, buildWithGpp: { global: config.get('buildWithGpp') } };
    };
    const compileOptions = () => effectiveOptions(optionState());
    const TARGETS = /** @type {const} */ ({ global: 1, workspace: 2, workspaceFolder: 3 });
    /** True while this module writes the switches itself: the change listener then fixes nothing. */
    let writingOptions = false;
    /**
     * @param {import('../cppSettings').OptionWrite[]} writes
     */
    async function applyOptionWrites(writes) {
        const config = vscode.workspace.getConfiguration(CPP_SECTION);
        const targets = /** @type {any} */ (vscode).ConfigurationTarget || {};
        writingOptions = true;
        try {
            for (const w of writes) {
                const target = w.scope === 'global' ? (targets.Global || TARGETS.global)
                    : (w.scope === 'workspace' ? (targets.Workspace || TARGETS.workspace) : (targets.WorkspaceFolder || TARGETS.workspaceFolder));
                await config.update(w.key, w.value, target);
            }
        } finally {
            writingOptions = false;
        }
    }
    let lastOptionState = optionState();
    let lastOptions = effectiveOptions(lastOptionState);
    /** Tells the editors and the start page what the switches are now; fills the g++ path once the build is turned on. */
    function optionsChanged() {
        const now = compileOptions();
        if (now.buildWithGpp && !lastOptions.buildWithGpp && fillGppPath) fillGppPath();
        lastOptions = now;
        if (provider && typeof provider.setCompileOptions === 'function') provider.setCompileOptions(now);
        if (onSettingsChanged) onSettingsChanged();
    }
    /**
     * A Compile dropdown checkbox was clicked: writes it, with the coupled switch.
     * @param {string} key
     * @param {boolean} value
     * @returns {Promise<boolean>} False for a key that is not one of the two switches.
     */
    async function setCompileOption(key, value) {
        if (key !== 'generateCpp' && key !== 'buildWithGpp') return false;
        const writes = checkboxWrites(key, !!value, optionState());
        try {
            await applyOptionWrites(writes);
        } catch (err) {
            vscode.window.showErrorMessage(`Could not change the setting: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}`);
        }
        lastOptionState = optionState();
        optionsChanged();
        return true;
    }
    if (provider && typeof provider.setCompileOptionsSource === 'function') {
        provider.setCompileOptionsSource({ options: compileOptions, set: setCompileOption });
    }

    // The compiler ships in the extension; the setting only overrides it.
    const isAvailable = () => isCompilerAvailable(readSettings().compilerPath, { extensionRoot: context.extensionPath });
    const keyOf = (/** @type {string} */ uriStr) => normalizeFileUri(uriStr);

    /**
     * A file's current text: the open document when there is one (so unsaved edits count), else the
     * file on disk — with Manual Sync's pending edits folded in, so the check sees what the panes show.
     * @param {string} filePath
     * @returns {Promise<string>}
     */
    async function currentText(filePath) {
        const uri = vscode.Uri.file(filePath);
        const key = keyOf(uri.toString());
        const open = (vscode.workspace.textDocuments || []).find(d => keyOf(d.uri.toString()) === key);
        const text = open ? open.getText() : await fs.promises.readFile(filePath, 'utf8');
        const store = provider && provider.pendingEditsStore;
        if (!store) return text;
        const edits = Object.values(store.get(open ? open.uri.toString() : uri.toString(), text) || {});
        return edits.length ? pendingEditsCore.foldEdits(text, edits, replaceComponentCdata) : text;
    }

    /** Publishes one file's problems to the Problems panel (or clears the file when it has none). */
    function publishFile(/** @type {string} */ key) {
        const entry = byFile.get(key);
        if (!entry || entry.problems.length === 0) {
            if (entry) collection.delete(entry.uri);
            byFile.delete(key);
            return;
        }
        // The entry's code is a link back into this extension: it opens the component, pane and
        // line, which a plain click cannot do for a custom editor.
        const diagnostics = entry.problems.map((p) => problemDiagnostic(p, DIAGNOSTIC_SOURCE,
            vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}${PROBLEM_LINK_PATH}?id=${p.id}`)));
        collection.set(entry.uri, diagnostics);
    }

    /** Pushes the current markers to every open TwinCAT editor. */
    const refreshPanes = () => { if (provider && typeof provider.refreshCompileDiagnostics === 'function') provider.refreshCompileDiagnostics(); };

    function refreshStatus() {
        let errors = 0;
        let warnings = 0;
        for (const entry of byFile.values()) {
            for (const p of entry.problems) {
                if (p.severity === 'error') errors++;
                else if (p.severity === 'warning') warnings++;
            }
        }
        return { errors, warnings };
    }

    function clearAll() {
        collection.clear();
        gppCollection.clear();
        byFile.clear();
        openTargetUsed.clear();
        statusItem.hide();
    }

    /**
     * Opens the editor on one problem: its component, pane and line.
     * @param {StoredProblem} p
     */
    async function goToProblem(p) {
        await openProblem(p);
    }

    const allProblems = () => [...byFile.values()].flatMap(e => e.problems);

    // What the custom editor provider asks this module for.
    if (provider && typeof provider.setCompileSource === 'function') {
        provider.setCompileSource({
            /** The pane markers of one file, in the shape the webview's marker splitter takes. */
            paneDiagnostics: (/** @type {string} */ uriStr) => {
                const entry = byFile.get(keyOf(uriStr));
                return (entry ? entry.problems : []).map(p => ({
                    componentId: p.componentId, pane: p.pane,
                    severity: p.severity === 'error' ? 1 : (p.severity === 'warning' ? 2 : 3),
                    message: p.message,
                    range: { startLineNumber: p.line, startColumn: p.column, endLineNumber: p.endLine, endColumn: p.endColumn }
                }));
            },
            /** A component was edited: its results no longer describe it. */
            onComponentEdited: (/** @type {string} */ uriStr, /** @type {string} */ componentId) => {
                const key = keyOf(uriStr);
                const entry = byFile.get(key);
                if (!entry || !entry.problems.some(p => p.componentId === componentId)) return;
                entry.problems = entry.problems.filter(p => p.componentId !== componentId);
                publishFile(key);
                showStatus(refreshStatus());
            },
            /** Where a freshly opened editor of this file should start: its first problem, once per run. */
            openTarget: (/** @type {string} */ uriStr) => {
                const key = keyOf(uriStr);
                const entry = byFile.get(key);
                if (!entry || entry.problems.length === 0 || openTargetUsed.has(key)) return null;
                openTargetUsed.add(key);
                const first = entry.problems.find(p => p.severity === 'error') || entry.problems[0];
                return { componentId: first.componentId, range: selectionOf(first), targetWord: null };
            }
        });
    }

    /** The C++ part of the last run, kept for the status text when a component edit redraws it. */
    /** @type {{cpp: CppOutcome|null, gpp: {errors: number, warnings: number}}} */
    let lastCppStatus = { cpp: null, gpp: { errors: 0, warnings: 0 } };

    /**
     * @param {{errors: number, warnings: number}} counts
     * @param {CppOutcome|null} [cpp] The C++ part of a new run (omitted: keep the last one's).
     * @param {{errors: number, warnings: number}} [gpp]
     */
    function showStatus(counts, cpp, gpp) {
        if (cpp !== undefined) lastCppStatus = { cpp, gpp: gpp || { errors: 0, warnings: 0 } };
        statusItem.text = compileStatusText(counts, lastCppStatus.cpp, lastCppStatus.gpp);
        statusItem.tooltip = 'Result of the last TC Toolkit: Compile Project run. Click to open the Problems panel.';
        statusItem.show();
    }

    /**
     * Publishes the g++ build's messages on the generated files (or clears them).
     * @param {CppOutcome|null} cpp
     * @returns {{errors: number, warnings: number}}
     */
    function publishGpp(cpp) {
        gppCollection.clear();
        const placed = cpp && cpp.gpp && cpp.gpp.placed ? cpp.gpp.placed : [];
        /** @type {Map<string, {uri: vscode.Uri, list: vscode.Diagnostic[]}>} */
        const byPath = new Map();
        for (const m of placed) {
            if (!byPath.has(m.filePath)) byPath.set(m.filePath, { uri: vscode.Uri.file(m.filePath), list: [] });
            const range = new vscode.Range(m.line - 1, m.column - 1, m.line - 1, m.column - 1);
            const d = new vscode.Diagnostic(range, m.message, m.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
            d.source = GPP_DIAGNOSTIC_SOURCE;
            const Related = /** @type {any} */ (vscode).DiagnosticRelatedInformation;
            const Location = /** @type {any} */ (vscode).Location;
            if (Related && Location && m.notes.length > 0) {
                d.relatedInformation = m.notes.map(n => new Related(
                    new Location(vscode.Uri.file(n.filePath || m.filePath), new vscode.Range(Math.max(n.line, 1) - 1, Math.max(n.column, 1) - 1, Math.max(n.line, 1) - 1, Math.max(n.column, 1) - 1)),
                    n.message));
            }
            /** @type {any} */ (byPath.get(m.filePath)).list.push(d);
        }
        for (const entry of byPath.values()) gppCollection.set(entry.uri, entry.list);
        return {
            errors: placed.filter(m => m.severity === 'error').length,
            warnings: placed.filter(m => m.severity === 'warning').length
        };
    }

    /**
     * Generates one project's C++ into its CPP_Files folder and, when asked, compiles it with g++.
     * Called only after a check with no errors.
     * @param {{project: any, compilerRun: any, build: boolean, progress: {report: (v: {message?: string}) => void},
     *   onCancel: (cancel: () => void) => void, libraries: import('../cppGenerate').LibraryCoverage[]}} o
     *   `libraries`: library code the C++ will not cover (named at the top of the generated files).
     * @returns {Promise<CppOutcome>}
     */
    async function generateAndBuild(o) {
        const stemSource = o.project.plcprojPath ? path.basename(o.project.plcprojPath, path.extname(o.project.plcprojPath)) : (o.project.name || 'project');
        const paths = cppOutputPaths(o.project.dir, stemSource);
        /** @type {string} */
        let plcprojText;
        try { plcprojText = o.project.plcprojPath ? fs.readFileSync(o.project.plcprojPath, 'utf8') : ''; } catch (e) { plcprojText = ''; }
        // The <ProjectGuid> survives a rename, so a renamed project's earlier files are still its own.
        const owner = cppOwnerId(plcprojText, paths.stem);
        o.progress.report({ message: 'Generating C++…' });
        // The same library declarations as the check (user decision 2026-11-12): library blocks
        // become declarations with empty bodies, which the run's summary names.
        const libraries = o.libraries;
        const gen = await runGenerate({ ...o.compilerRun, stem: paths.stem });
        if (gen.status !== 'done') {
            return { status: gen.status, message: gen.message, paths, libraries, log: gen.status === 'failed' ? gen.log : '', logTitle: 'C++ generation failed' };
        }
        const header = libraryCoverageHeader(libraries);
        /** @type {import('../cppGenerate').WriteResult} */
        let written;
        try {
            written = writeOwnedOutputs({ dir: paths.dir, project: owner, files: [
                { name: path.basename(paths.cpp), text: withCoverageHeader(gen.cppText, header) },
                { name: path.basename(paths.hpp), text: withCoverageHeader(gen.hppText, header) }] });
        } catch (err) {
            return { status: 'failed', paths, libraries, message: `The C++ files could not be written: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}` };
        }
        if (!written.ok) return { status: 'failed', paths, libraries, message: written.message };
        /** @type {CppOutcome} */
        const cpp = { status: 'done', paths, written, message: '', libraries };
        if (!o.build) return cpp;
        if (written.refused.length > 0) {
            cpp.gpp = { status: 'skipped', message: 'g++ was not run: the generated files could not all be written.' };
            return cpp;
        }
        // An MSYS2 known only to the registry is found once its search is over (src/msys2Detect.js).
        try { await gppReady(); } catch (e) { /* what is known so far */ }
        const config = vscode.workspace.getConfiguration(CPP_SECTION);
        const found = resolveGpp({ configured: config.get('gppPath', ''), ...(gppDiscovery || thisMachine()) });
        if (found.ok === false) {
            cpp.gpp = { status: 'missing', reason: found.reason, configured: found.configured, problem: found.problem, message: '' };
            if (found.msys2Root) cpp.gpp.msys2Root = found.msys2Root;
            return cpp;
        }
        // g++ < 7 cannot compile the generated C++ (C++17 inline variables): said once, not run.
        if (found.tooOld) {
            cpp.gpp = { status: 'too-old', gppPath: found.path, version: found.version || '', source: found.source, message: '' };
            if (found.msys2Root) cpp.gpp.msys2Root = found.msys2Root;
            return cpp;
        }
        const objName = path.basename(paths.obj);
        const claim = claimOutput(paths.dir, objName);
        if (claim !== 'absent' && claim !== 'owned') {
            cpp.gpp = { status: 'skipped', gppPath: found.path, message: `g++ was not run: ${objName} in CPP_Files was not written by TC Toolkit (or was changed since), and is left alone.` };
            return cpp;
        }
        o.progress.report({ message: 'Building with g++…' });
        const run = await runGpp({
            gppPath: found.path, cwd: paths.dir, onCancel: o.onCancel, spawn: /** @type {any} */ (spawn),
            args: buildGppArgs({ cppFile: paths.cpp, objFile: paths.obj, includeDir: path.join(context.extensionPath, 'resources', 'compiler', 'include'), outDir: paths.dir })
        });
        if (run.status === 'done' && run.exitCode === 0) recordOwnedFile(paths.dir, owner, objName);
        cpp.gpp = {
            status: run.status, exitCode: run.exitCode, gppPath: found.path, message: run.message,
            placed: run.status === 'done' ? placeGppMessages(run.messages, { cwd: paths.dir, cppFile: paths.cpp, hppFile: paths.hpp }) : [],
            summary: run.status === 'done' ? summarizeGpp(run) : ''
        };
        if (run.output && (run.status !== 'done' || run.exitCode !== 0 || run.messages.length > 0)) {
            cpp.log = run.output;
            cpp.logTitle = `g++ (${found.path})`;
        }
        return cpp;
    }

    /**
     * Explains what stops the compiler from running, and offers the settings.
     * @param {Array<{setting: string, message: string}>} problems
     */
    function reportSetupProblems(problems) {
        const text = 'Compile Project cannot run. ' + problems.map(p => p.message).join(' ');
        vscode.window.showErrorMessage(text, 'Open Settings').then((choice) => {
            if (choice === 'Open Settings') vscode.commands.executeCommand('twincat.openSettings', COMPILER_SECTION);
        });
        return text;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.compileProject', async (args) => {
            const a = args && typeof args === 'object' ? args : {};
            if (running) {
                vscode.window.showInformationMessage('Compile Project is already running.');
                return { ok: false, reason: 'running' };
            }
            const projectMap = getProjectMap();
            if (!projectMap || !projectMap.projects || projectMap.projects.size === 0) {
                vscode.window.showWarningMessage('Compile Project needs a TwinCAT PLC project (.plcproj) in the workspace.');
                return { ok: false, reason: 'no-project' };
            }

            // One PLC project per run: each is its own compilation unit.
            const key = typeof a.projectKey === 'string' && a.projectKey
                ? a.projectKey : await pickProjectKey(projectMap, { title: 'Compile Project', placeHolder: 'PLC project to compile' });
            if (!key) return { ok: false, reason: 'cancelled' };
            const project = projectMap.get(key);
            if (!project) return { ok: false, reason: 'no-project' };
            const projectName = projectMap.displayName(key);

            running = true;
            const tellEditors = (/** @type {boolean} */ on) => { if (provider && typeof provider.setCompileRunning === 'function') provider.setCompileRunning(on); };
            tellEditors(true);
            try {
                const setup = await checkSetup(readSettings(), { ...(nodeDiscovery || {}), spawn: /** @type {any} */ (spawn), extensionRoot: context.extensionPath });
                if (!setup.ok) return { ok: false, reason: 'setup', message: reportSetupProblems(setup.problems) };

                const outcome = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Compiling ${projectName}…`, cancellable: true },
                    async (progress, token) => {
                        /** @type {Array<{filePath: string, text: string}>} */
                        const files = [];
                        /** @type {string[]} */
                        const unreadable = [];
                        for (const filePath of project.objectFiles.values()) {
                            if (token.isCancellationRequested) return null;
                            try { files.push({ filePath, text: await currentText(filePath) }); } catch (e) { unreadable.push(filePath); }
                        }
                        const built = buildCheckInputs(files, parseTwinCatXml);
                        if (built.inputs.length === 0) {
                            return { result: null, built, unreadable, library: null, defines: null };
                        }
                        // Library declarations, from this machine's own library files (libraryDecls.js);
                        // they exist only inside runCheck's temporary directory.
                        const library = prepareLibraryCheck({
                            projectDir: project.dir,
                            roots: (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath),
                            inputs: built.inputs,
                            compilerPath: setup.compilerPath
                        });
                        // The project's compiler defines choose the branches of {IF defined(X)} pragmas;
                        // an object's own defines apply to the unit built from that object only.
                        const projectDefines = projectDefineArgs(project.plcprojPath, (p) => {
                            const doc = (vscode.workspace.textDocuments || []).find(d => keyOf(d.uri.toString()) === keyOf(vscode.Uri.file(p).toString()));
                            return doc ? doc.getText() : fs.readFileSync(p, 'utf8');
                        });
                        const perObject = fileDefineArgs(projectDefines.objects, library.inputs, project.plcprojPath);
                        const defines = {
                            defines: projectDefines.defines, objects: projectDefines.objects,
                            args: [...projectDefines.args, ...perObject.args], notes: [...projectDefines.notes, ...perObject.notes]
                        };
                        if (defines.args.length > 0 || defines.notes.length > 0) {
                            const channel = outputChannel();
                            channel.appendLine(`[${new Date().toISOString()}] ${projectName}: compiler defines ` +
                                (defines.args.length > 0 ? defines.args.join(' ') : '(none used)'));
                            for (const note of defines.notes) channel.appendLine(`  ${note}`);
                        }
                        const onCancel = (/** @type {() => void} */ cancel) => { token.onCancellationRequested(cancel); if (token.isCancellationRequested) cancel(); };
                        const compilerRun = {
                            nodeCommand: setup.nodeCommand,
                            defineArgs: defines.args,
                            nodeEnv: setup.nodeEnv,
                            compilerPath: setup.compilerPath,
                            dialectFile: path.join(context.extensionPath, 'resources', 'dialects', 'twincat3.json'),
                            inputs: library.inputs,
                            extraFiles: library.extraFiles,
                            spawn: /** @type {any} */ (spawn),
                            onCancel
                        };
                        const result = await runCheck({ ...compilerRun, libraryFilter: library.filter });
                        // C++ (R13): only after a finished check with no errors, and only when switched on.
                        const options = compileOptions();
                        /** @type {CppOutcome|null} */
                        let cpp = null;
                        if (result.status === 'done' && options.generateCpp && !token.isCancellationRequested) {
                            // Library code the C++ cannot contain: declared blocks, the compiler's own
                            // stand-ins, and names the check's library filter hid (no declaration).
                            const libraries = libraryCoverage({
                                declaredSymbols: library.declaredSymbols, compilerSubstitutes: library.compilerSubstitutes,
                                undeclared: library.undeclaredUses(result.filteredLibrary)
                            });
                            cpp = result.errors > 0
                                ? { status: 'skipped', message: 'C++ was not generated: the project has errors.' }
                                : await generateAndBuild({ project, compilerRun, build: options.buildWithGpp, progress, onCancel, libraries });
                        }
                        return { result, built, unreadable, library, defines, cpp };
                    });

                if (!outcome || (outcome.result && outcome.result.status === 'cancelled')) {
                    return { ok: false, reason: 'cancelled' };
                }
                if (!outcome.result) {
                    vscode.window.showWarningMessage(`Compile Project: ${projectName} has no TwinCAT objects to compile.`);
                    return { ok: false, reason: 'empty' };
                }
                const { result, built, unreadable, library, defines, cpp } = outcome;
                if (result.status !== 'done') {
                    // The previous results stay: a run that did not finish says nothing about the code.
                    vscode.window.showErrorMessage(`Compile Project did not finish. ${result.message}`);
                    return { ok: false, reason: result.status, message: result.message };
                }

                // A finished run replaces everything the previous run reported.
                clearAll();
                for (const d of result.diagnostics) {
                    const uri = vscode.Uri.file(d.filePath);
                    const fileKey = keyOf(uri.toString());
                    if (!byFile.has(fileKey)) byFile.set(fileKey, { uri, problems: [] });
                    /** @type {any} */ (byFile.get(fileKey)).problems.push({ ...d, id: nextProblemId++ });
                }
                for (const fileKey of [...byFile.keys()]) publishFile(fileKey);
                refreshPanes();
                const gppCounts = publishGpp(cpp);
                showStatus({ errors: result.errors, warnings: result.warnings }, cpp, gppCounts);

                // Diagnostics that name no object cannot be placed; they are shown, never dropped.
                const notes = [];
                if (result.general.length > 0) {
                    notes.push(`${result.general.length} message(s) not tied to an object: ` +
                        result.general.slice(0, 3).map(g => g.message).join('; ') + (result.general.length > 3 ? '; …' : '') + '.');
                }
                const left = unreadable.length + built.unparsed.length;
                if (left > 0) notes.push(`${left} file(s) could not be read as TwinCAT objects and were not compiled.`);
                if (built.skipped.length > 0) notes.push(`${built.skipped.length} SFC transition(s) were not compiled.`);
                if (result.filteredLibraryDiagnostics > 0) {
                    notes.push(`${result.filteredLibraryDiagnostics} error(s) on library symbols with no declaration available were not shown.`);
                }
                if (result.libraryMessages.length > 0) {
                    notes.push(`${result.libraryMessages.length} message(s) about the generated library declarations (not your code) were not shown: ` +
                        result.libraryMessages.slice(0, 2).map(m => m.message).join('; ') + (result.libraryMessages.length > 2 ? '; …' : '') + '.');
                }
                if (defines && defines.notes.length > 0) {
                    notes.push(`${defines.notes.length} note(s) on the project's compiler defines: see the "${OUTPUT_CHANNEL_NAME}" output.`);
                }
                if (library && !library.hasSignatures && library.referencesLibraries && !dumpHintGiven) {
                    dumpHintGiven = true;
                    notes.push('Run "TC Toolkit: Update Library Definitions" to check calls into libraries too.');
                }
                const cppNotes = describeCpp(cpp);
                if (cpp && cpp.status === 'done' && cpp.libraries && cpp.libraries.length > 0) {
                    const channel = outputChannel();
                    channel.appendLine(`[${new Date().toISOString()}] ${projectName}: library code the generated C++${cpp.gpp && cpp.gpp.status === 'done' ? ' and the g++ check do' : ' does'} not cover`);
                    for (const line of libraryCoverageLines(cpp.libraries)) channel.appendLine(line);
                } else if (cpp && cpp.status === 'failed' && cpp.libraries && cpp.libraries.some(e => e.undeclared.length > 0)) {
                    // No C++ was written: only the library symbols that stopped it are listed.
                    const channel = outputChannel();
                    channel.appendLine(`[${new Date().toISOString()}] ${projectName}: C++ could not be generated: no declaration the compiler can use for these library symbols`);
                    for (const line of libraryUndeclaredLines(cpp.libraries)) channel.appendLine(line);
                }
                // The CPP_Files/.gitignore is reported in the channel only (it never makes the run a warning).
                const gitNote = cpp && cpp.written ? gitignoreNote(cpp.written.gitignore) : '';
                if (gitNote) outputChannel().appendLine(`[${new Date().toISOString()}] ${projectName}: ${gitNote}`);
                if (cpp && cpp.log) {
                    const channel = outputChannel();
                    channel.appendLine(`[${new Date().toISOString()}] ${projectName}: ${cpp.logTitle || 'C++'}`);
                    for (const line of cpp.log.split(/\r?\n/)) channel.appendLine(`  ${line}`);
                }
                const summary = [summarize(result, projectName), ...notes, ...cppNotes.notes].join(' ');
                const hasProblems = byFile.size > 0 || gppCounts.errors + gppCounts.warnings > 0;
                const show = result.errors > 0 || gppCounts.errors > 0 || cppNotes.failed ? vscode.window.showErrorMessage
                    : (result.warnings > 0 || notes.length > 0 || cppNotes.warn || gppCounts.warnings > 0 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage);
                const buttons = hasProblems ? ['Go to Problem…', 'Open Problems'] : [];
                if (byFile.size === 0 && hasProblems) buttons.shift();
                if (cpp && cpp.status === 'done' && cpp.written && cpp.written.written.length > 0) buttons.push('Open C++');
                // A missing g++ is said once, in this summary, with the buttons that fix it.
                if (cpp && cpp.gpp && cpp.gpp.status === 'missing') buttons.push(...gppMissingButtons(cpp.gpp));
                if (cpp && cpp.gpp && cpp.gpp.status === 'too-old') buttons.push(...gppTooOldButtons(cpp.gpp));
                Promise.resolve(show(`Compile Project — ${summary}`, ...buttons)).then((choice) => {
                    if (choice === 'Go to Problem…') vscode.commands.executeCommand(GO_TO_PROBLEM_COMMAND);
                    else if (choice === 'Open Problems') vscode.commands.executeCommand('workbench.actions.view.problems');
                    else if (choice === 'Open C++' && cpp && cpp.paths) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(cpp.paths.cpp));
                    else if (choice === 'Open Setting') vscode.commands.executeCommand('twincat.openSettings', SETTING_GPP_PATH, { target: 'user' });
                    else if (choice === 'Detect g++') vscode.commands.executeCommand('twincat.detectGpp');
                });
                return {
                    ok: true, projectKey: key, errors: result.errors, warnings: result.warnings,
                    filteredPragmaWarnings: result.filteredPragmaWarnings, filteredLibraryDiagnostics: result.filteredLibraryDiagnostics,
                    libraryDeclarations: library ? library.extraFiles.length : 0, durationMs: result.durationMs, summary,
                    defineArgs: defines ? defines.args.slice() : [], defineNotes: defines ? defines.notes.slice() : [],
                    cpp: cpp ? {
                        status: cpp.status, message: cpp.message || '',
                        libraries: (cpp.libraries || []).map(e => ({ ...e })),
                        written: cpp.written ? cpp.written.written.slice() : [], removed: cpp.written ? cpp.written.removed.slice() : [],
                        refused: cpp.written ? cpp.written.refused.map(r => ({ ...r })) : [],
                        gitignore: cpp.written && cpp.written.gitignore ? { ...cpp.written.gitignore } : null,
                        gpp: cpp.gpp ? { status: cpp.gpp.status, exitCode: cpp.gpp.exitCode === undefined ? null : cpp.gpp.exitCode,
                            gppPath: cpp.gpp.gppPath || '', version: cpp.gpp.version || '', source: cpp.gpp.source || '',
                            errors: gppCounts.errors, warnings: gppCounts.warnings, message: cpp.gpp.message || '' } : null
                    } : null
                };
            } finally {
                running = false;
                tellEditors(false);
            }
        }),

        // Every problem of the last run, to pick from; the pick opens its component, pane and line.
        vscode.commands.registerCommand(GO_TO_PROBLEM_COMMAND, async () => {
            const problems = allProblems().sort((x, y) => (x.severity === y.severity ? 0 : (x.severity === 'error' ? -1 : 1)));
            if (problems.length === 0) {
                vscode.window.showInformationMessage('There are no compile problems. Run TC Toolkit: Compile Project first.');
                return;
            }
            const items = problems.map(p => ({
                label: `${p.severity === 'error' ? '$(error)' : '$(warning)'} ${p.message}`,
                description: path.basename(p.filePath),
                detail: describeLocation(p, memberName),
                problem: p
            }));
            const picked = await vscode.window.showQuickPick(items, { title: 'Compile problems', placeHolder: 'Go to a problem', matchOnDescription: true, matchOnDetail: true });
            if (picked) await goToProblem(picked.problem);
        })
    );

    // The links on the Problems entries come back here.
    if (typeof vscode.window.registerUriHandler === 'function') {
        context.subscriptions.push(vscode.window.registerUriHandler({
            handleUri: async (uri) => {
                if (uri.path !== PROBLEM_LINK_PATH) return;
                const id = Number((/(?:^|&)id=(\d+)(?:&|$)/.exec(uri.query || '') || [])[1]);
                // Only a problem of the current results is opened: the link carries an id, never a path.
                const problem = allProblems().find(p => p.id === id);
                if (problem) await goToProblem(problem);
            }
        }));
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration(COMPILER_SECTION)) return;
            // The two C++ switches stay consistent in the scope the user changed (src/cppSettings.js).
            const now = optionState();
            const writes = writingOptions ? [] : couplingWrites(lastOptionState, now);
            lastOptionState = now;
            if (writes.length > 0) {
                applyOptionWrites(writes).then(() => { lastOptionState = optionState(); optionsChanged(); }, (err) => {
                    console.error('TC Toolkit: could not keep the C++ settings consistent:', err);
                });
            }
            optionsChanged();
        })
    );
    // Build with g++ already on at startup: an empty g++ path setting shows what a run will use.
    if (lastOptions.buildWithGpp && fillGppPath) fillGppPath();

    return {
        isAvailable, compileOptions, setCompileOption,
        problemsFor: (uriStr) => { const e = byFile.get(keyOf(uriStr)); return e ? e.problems.slice() : []; }
    };
}

module.exports = {
    registerCompileCommands, problemDiagnostic, openProblem, selectionOf, pickProjectKey, describeCpp, compileStatusText, gppMissingText, gppMissingButtons, gppTooOldNote, gppTooOldButtons,
    DIAGNOSTIC_SOURCE, GPP_DIAGNOSTIC_SOURCE, PROBLEM_LINK_PATH, GO_TO_PROBLEM_COMMAND, OUTPUT_CHANNEL_NAME
};
