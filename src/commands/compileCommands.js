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
const { projectDefineArgs } = require('../compilerDefines');

/** The `source` of every diagnostic this command publishes. */
const DIAGNOSTIC_SOURCE = 'TC Toolkit compile';

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
 * Registers Compile Project.
 * @param {vscode.ExtensionContext} context
 * @param {object} deps
 * @param {any} deps.provider The custom editor provider (pane markers, pending edits).
 * @param {() => any} deps.getProjectMap The host's current project partition.
 * @param {() => void} [deps.onSettingsChanged] Called when a `tcToolkit.compiler.*` setting changes.
 * @param {Function} [deps.spawn] Child-process factory, for tests.
 * @param {import('../compileCheck').NodeDiscovery} [deps.nodeDiscovery] Where Node is looked for, for tests.
 * @returns {{isAvailable: () => boolean, problemsFor: (uriStr: string) => StoredProblem[]}}
 */
function registerCompileCommands(context, { provider, getProjectMap, onSettingsChanged, spawn, nodeDiscovery }) {
    const collection = vscode.languages.createDiagnosticCollection('twincat-compile');
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    statusItem.command = 'workbench.actions.view.problems';
    context.subscriptions.push(collection, statusItem);

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
        const diagnostics = entry.problems.map((p) => {
            // Pane coordinates, so Ln/Col in the panel match the pane the user reads.
            const at = paneRange(p);
            const range = new vscode.Range(at.start.line, at.start.character, at.end.line, at.end.character);
            const where = describeLocation(p, memberName);
            const d = new vscode.Diagnostic(range, `${p.message} [${where}]`,
                p.severity === 'error' ? vscode.DiagnosticSeverity.Error
                    : (p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information));
            d.source = DIAGNOSTIC_SOURCE;
            // The entry's code is a link back into this extension: it opens the component, pane and
            // line, which a plain click cannot do for a custom editor.
            d.code = {
                value: where,
                target: vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}${PROBLEM_LINK_PATH}?id=${p.id}`)
            };
            return d;
        });
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
        byFile.clear();
        openTargetUsed.clear();
        statusItem.hide();
    }

    /**
     * Opens the editor on one problem: its component, pane and line.
     * @param {StoredProblem} p
     */
    async function goToProblem(p) {
        await vscode.commands.executeCommand('twincat.openComponent', vscode.Uri.file(p.filePath), p.componentId, selectionOf(p), null);
    }

    /**
     * The `twincat.openComponent` selection of a problem (0-based line and characters).
     * @param {StoredProblem} p
     */
    function selectionOf(p) {
        return {
            pane: p.pane, localLine: p.line - 1,
            start: { character: p.column - 1 },
            end: { character: p.endLine === p.line ? p.endColumn - 1 : p.column - 1 }
        };
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

    /** @param {{errors: number, warnings: number}} counts */
    function showStatus(counts) {
        if (counts.errors === 0 && counts.warnings === 0) {
            statusItem.text = '$(check) Compile: no errors';
        } else {
            statusItem.text = `$(error) ${counts.errors} $(warning) ${counts.warnings} Compile`;
        }
        statusItem.tooltip = 'Result of the last TC Toolkit: Compile Project run. Click to open the Problems panel.';
        statusItem.show();
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
            let key = typeof a.projectKey === 'string' ? a.projectKey : '';
            if (!key) {
                const keys = [...projectMap.keys()];
                if (keys.length === 1) {
                    key = keys[0];
                } else {
                    const items = keys.map(k => ({ label: projectMap.displayName(k), key: k }))
                        .sort((x, y) => x.label.localeCompare(y.label));
                    const picked = await vscode.window.showQuickPick(items, { title: 'Compile Project', placeHolder: 'PLC project to compile' });
                    if (!picked) return { ok: false, reason: 'cancelled' };
                    key = picked.key;
                }
            }
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
                    async (_progress, token) => {
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
                        // The project's compiler defines choose the branches of {IF defined(X)} pragmas.
                        const defines = projectDefineArgs(project.plcprojPath, (p) => {
                            const doc = (vscode.workspace.textDocuments || []).find(d => keyOf(d.uri.toString()) === keyOf(vscode.Uri.file(p).toString()));
                            return doc ? doc.getText() : fs.readFileSync(p, 'utf8');
                        });
                        if (defines.defines.length > 0 || defines.notes.length > 0) {
                            const channel = outputChannel();
                            channel.appendLine(`[${new Date().toISOString()}] ${projectName}: compiler defines ` +
                                (defines.args.length > 0 ? defines.args.join(' ') : '(none used)'));
                            for (const note of defines.notes) channel.appendLine(`  ${note}`);
                        }
                        const result = await runCheck({
                            nodeCommand: setup.nodeCommand,
                            defineArgs: defines.args,
                            nodeEnv: setup.nodeEnv,
                            compilerPath: setup.compilerPath,
                            dialectFile: path.join(context.extensionPath, 'resources', 'dialects', 'twincat3.json'),
                            inputs: library.inputs,
                            extraFiles: library.extraFiles,
                            libraryFilter: library.filter,
                            spawn: /** @type {any} */ (spawn),
                            onCancel: (cancel) => { token.onCancellationRequested(cancel); if (token.isCancellationRequested) cancel(); }
                        });
                        return { result, built, unreadable, library, defines };
                    });

                if (!outcome || (outcome.result && outcome.result.status === 'cancelled')) {
                    return { ok: false, reason: 'cancelled' };
                }
                if (!outcome.result) {
                    vscode.window.showWarningMessage(`Compile Project: ${projectName} has no TwinCAT objects to compile.`);
                    return { ok: false, reason: 'empty' };
                }
                const { result, built, unreadable, library, defines } = outcome;
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
                showStatus({ errors: result.errors, warnings: result.warnings });

                // Diagnostics that name no object cannot be placed; they are shown, never dropped.
                const notes = [];
                if (result.general.length > 0) {
                    notes.push(`${result.general.length} message(s) not tied to an object: ` +
                        result.general.slice(0, 3).map(g => g.message).join('; ') + (result.general.length > 3 ? '; …' : ''));
                }
                const left = unreadable.length + built.unparsed.length;
                if (left > 0) notes.push(`${left} file(s) could not be read as TwinCAT objects and were not compiled`);
                if (built.skipped.length > 0) notes.push(`${built.skipped.length} SFC transition(s) were not compiled`);
                if (result.filteredLibraryDiagnostics > 0) {
                    notes.push(`${result.filteredLibraryDiagnostics} error(s) on library symbols with no declaration available were not shown`);
                }
                if (result.libraryMessages.length > 0) {
                    notes.push(`${result.libraryMessages.length} message(s) about the generated library declarations (not your code) were not shown: ` +
                        result.libraryMessages.slice(0, 2).map(m => m.message).join('; ') + (result.libraryMessages.length > 2 ? '; …' : ''));
                }
                if (defines && defines.notes.length > 0) {
                    notes.push(`${defines.notes.length} note(s) on the project's compiler defines: see the "${OUTPUT_CHANNEL_NAME}" output.`);
                }
                if (library && !library.hasSignatures && library.referencesLibraries && !dumpHintGiven) {
                    dumpHintGiven = true;
                    notes.push('Run "TC Toolkit: Update Library Definitions" to check calls into libraries too.');
                }
                const summary = [summarize(result, projectName), ...notes].join(' ');
                const hasProblems = byFile.size > 0;
                const show = result.errors > 0 ? vscode.window.showErrorMessage
                    : (result.warnings > 0 || notes.length > 0 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage);
                const buttons = hasProblems ? ['Go to Problem…', 'Open Problems'] : [];
                Promise.resolve(show(`Compile Project — ${summary}`, ...buttons)).then((choice) => {
                    if (choice === 'Go to Problem…') vscode.commands.executeCommand(GO_TO_PROBLEM_COMMAND);
                    else if (choice === 'Open Problems') vscode.commands.executeCommand('workbench.actions.view.problems');
                });
                return {
                    ok: true, projectKey: key, errors: result.errors, warnings: result.warnings,
                    filteredPragmaWarnings: result.filteredPragmaWarnings, filteredLibraryDiagnostics: result.filteredLibraryDiagnostics,
                    libraryDeclarations: library ? library.extraFiles.length : 0, durationMs: result.durationMs, summary,
                    defineArgs: defines ? defines.args.slice() : [], defineNotes: defines ? defines.notes.slice() : []
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
            if (e.affectsConfiguration(COMPILER_SECTION) && onSettingsChanged) onSettingsChanged();
        })
    );

    return { isAvailable, problemsFor: (uriStr) => { const e = byFile.get(keyOf(uriStr)); return e ? e.problems.slice() : []; } };
}

module.exports = { registerCompileCommands, DIAGNOSTIC_SOURCE, PROBLEM_LINK_PATH, GO_TO_PROBLEM_COMMAND, OUTPUT_CHANNEL_NAME };
