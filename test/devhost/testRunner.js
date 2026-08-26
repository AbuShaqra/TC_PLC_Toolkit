/**
 * @file test/devhost/testRunner.js
 * @description The in-host half of the dev-host harness — runs INSIDE a real VS Code extension
 * host (`--extensionTestsPath`), launched by ./run.js. Traces the custom editor's
 * resolve → ready → init chain and the live LSP-client bridge against a real workspace, the two
 * links no headless harness can reach (test/browser/ drives the webview alone; everything else
 * drives the LSP in-process).
 *
 * Wrote for the 2026-08-10 regression: scan-time symbol nodes carried NORMALIZED (lowercased)
 * uris, so every cross-file Go to Definition opened a DUPLICATE, lowercase-titled tab —
 * "definitions are broken" to a user, invisible to every headless gate (the LSP still resolved,
 * the webview still rendered; only real vscode.openWith() exposes uri-casing identity).
 *
 * Contract with run.js (all via environment variables, which the extension host inherits):
 *   TCDEV_WS      — absolute path of the workspace under test (run.js passes a temp COPY).
 *   TCDEV_RESULTS — absolute path of the results JSON this module writes progressively.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..');
const WS = process.env.TCDEV_WS;
const SAMPLE = process.env.TCDEV_SAMPLE || WS;
const RESULTS = process.env.TCDEV_RESULTS;

const out = { steps: [], panels: [], treeReveals: [] };
function log(step, data) {
    out.steps.push({ step, ...data });
    try { fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)); } catch (e) { /* keep going */ }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// The webview test-hook channel (media/devHostTestHook.js, injected only because run.js sets
// TCDEV_TEST=1). It is what turns the P8 G4 checklist — typing, Manual Sync, real Monaco markers,
// peek click-through — from a manual walk into assertions: every request drives the REAL editors
// and every answer is read back off the real page.
// ---------------------------------------------------------------------------------------------

/** Every panel ever resolved, newest last. Closing and reopening a file makes a NEW one. */
const livePanels = [];
/** The extension's real ExtensionContext, captured from the patched provider resolve below. */
let hostContext = null;
/** The extension's real custom-editor provider instance, for the project-aware Generate-ST phase. */
let hostProvider = null;

/**
 * Reads one document's PERSISTED pending-edit entry straight out of the extension's
 * workspaceState — the only carrier of Manual-Sync edits across a window reload, and therefore
 * the only thing that can be asserted about reload survival without reloading the window.
 * @param {string} uriStr Document URI string.
 * @returns {Object|null} `{fingerprint, edits}`, or null when nothing is stored (or unreachable).
 */
function persistedEntry(uriStr) {
    if (!hostContext || !hostContext.workspaceState) return null;
    const all = hostContext.workspaceState.get('twincat.pendingEdits', {}) || {};
    return all[uriStr] || null;
}
/** Replies from the hook, consumed by `ask` and removed as they are matched. */
const hookReplies = [];
let requestSeq = 0;

/**
 * Sends one request to a panel's test hook and waits for the reply carrying the same requestId.
 * @param {Object} panel The webview panel.
 * @param {Object} msg The request (its `type` starts with `test:`).
 * @returns {Promise<Object|null>} The reply, or null after 10 s.
 */
async function ask(panel, msg) {
    if (!panel) return null;
    const requestId = `devhost-${++requestSeq}`;
    panel.webview.postMessage({ ...msg, requestId });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const at = hookReplies.findIndex(r => r.requestId === requestId);
        if (at !== -1) return hookReplies.splice(at, 1)[0];
        await sleep(50);
    }
    return null;
}

/**
 * @param {Object} panel
 * @returns {Promise<Object|null>} The page state the hook reports (see its `readState`).
 */
async function state(panel) {
    const reply = await ask(panel, { type: 'test:state' });
    return (reply && reply.state) || null;
}

/**
 * Polls the page state until it satisfies a predicate. Returns the LAST state either way, so a
 * timeout still logs what the page actually showed rather than just "false".
 * @param {Object} panel
 * @param {Function} predicate Takes the state, returns a boolean.
 * @param {number} [timeoutMs]
 * @returns {Promise<Object|null>}
 */
async function waitFor(panel, predicate, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    let last = null;
    for (;;) {
        last = await state(panel);
        if (last && predicate(last)) return last;
        if (Date.now() >= deadline) return last;
        await sleep(200);
    }
}

// URI comparison is case-insensitive here on purpose: casing identity is what the navigation
// assertions above are for, and a mismatch there must fail as a navigation bug, not by silently
// starving these phases of a panel.
const sameUri = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** @returns {Object|null} The newest live panel for a uri. */
function panelFor(uriStr) {
    for (let i = livePanels.length - 1; i >= 0; i--) {
        if (sameUri(livePanels[i].uri, uriStr)) return livePanels[i].panel;
    }
    return null;
}

/** @returns {Object|null} The newest recorded message log for a uri (`fromWebview`, `captured`). */
function recordFor(uriStr) {
    for (let i = out.panels.length - 1; i >= 0; i--) {
        if (sameUri(out.panels[i].uri, uriStr)) return out.panels[i];
    }
    return null;
}

/**
 * @returns {number} The index of the first differing character, or -1 when the strings are equal.
 */
function firstDiffIndex(a, b) {
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : shared;
}

/** A readable window around a byte difference, so a failure names the construct that moved. */
function diffExcerpt(text, at) {
    if (at < 0) return null;
    return JSON.stringify(text.slice(Math.max(0, at - 60), at + 60));
}

async function run() {
    const vscode = require('vscode');
    try {
        log('start', { ws: WS, folders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.toString()) });

        // Capture the real Objects TreeView's reveal calls before activation creates it. The wrapper
        // still delegates to VS Code, so `ok` proves the provider's getParent chain is accepted—not
        // merely that extension.js attempted to reveal a component-shaped stand-in.
        const origCreateTreeView = vscode.window.createTreeView.bind(vscode.window);
        vscode.window.createTreeView = function (viewId, options) {
            const view = origCreateTreeView(viewId, options);
            if (viewId !== 'twincatExplorer') return view;
            const origReveal = view.reveal.bind(view);
            view.reveal = async (element, revealOptions) => {
                const rec = {
                    uri: element && element.resourceUri && element.resourceUri.toString(),
                    componentId: element && element.componentId,
                    contextValue: element && element.contextValue,
                    parents: []
                };
                let current = element;
                for (let depth = 0; depth < 8 && current; depth++) {
                    current = options.treeDataProvider.getParent(current);
                    if (current) rec.parents.push(current.componentId || current.folderPath || String(current.label));
                }
                out.treeReveals.push(rec);
                try {
                    const result = await origReveal(element, revealOptions);
                    rec.ok = true;
                    return result;
                } catch (e) {
                    rec.ok = false;
                    rec.error = String(e);
                    throw e;
                } finally {
                    try { fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)); } catch (e) { /* keep going */ }
                }
            };
            return view;
        };

        // Patch the provider PROTOTYPE before any custom editor resolves: every future panel's
        // resolve → ready → init chain lands in `panels`. Same module instance as the extension's,
        // because the test shares its extension host and require cache.
        const cep = require(path.join(REPO, 'src', 'customEditorProvider.js'));
        const origResolve = cep.TwinCatCustomEditorProvider.prototype.resolveCustomTextEditor;
        cep.TwinCatCustomEditorProvider.prototype.resolveCustomTextEditor = function (document, panel, token) {
            // `this` is the extension's OWN provider instance, so this is the harness's route to the
            // real ExtensionContext — and therefore to the workspaceState the pending-edit store
            // persists into. Nothing else exposes it (activate() returns no exports).
            hostContext = this.context || hostContext;
            hostProvider = this; // the real provider instance — its generate-ST methods run below.
            const rec = { uri: document.uri.toString(), textLen: document.getText().length, fromWebview: [], toWebview: [], resolveThrew: null };
            out.panels.push(rec);
            // Also keep the panel object itself: the P8 phases below need to post to a SPECIFIC
            // panel, and closing a tab and reopening the file produces a new one for the same uri.
            livePanels.push({ uri: document.uri.toString(), panel: panel });
            try {
                panel.webview.onDidReceiveMessage(m => {
                    const type = m && m.type;
                    // The test hook's replies are harness chatter, not webview behaviour. They are
                    // routed to `hookReplies` and deliberately kept out of `fromWebview` AND out of
                    // the progressive write: `waitFor` polls every 200 ms, and recording each reply
                    // would both drown the real message stream and rewrite a growing JSON per poll.
                    if (typeof type === 'string' && type.startsWith('test:')) { hookReplies.push(m); return; }
                    rec.fromWebview.push(type);
                    // Keep the PAYLOAD of the three edit-carrying messages. The byte-identity
                    // assertions recompute the expected document from these exact records, so what
                    // is compared is the webview's own edit — not a plausible reconstruction of it.
                    if (type === 'sync-pending' || type === 'save' || type === 'edit') {
                        rec.captured = rec.captured || [];
                        rec.captured.push({
                            type: type,
                            edits: m.edits,
                            context: m.context,
                            blockType: m.blockType,
                            content: m.content
                        });
                    }
                    try { fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)); } catch (e) { /* keep going */ }
                });
            } catch (e) { rec.hookErr = String(e); }
            const origPost = panel.webview.postMessage.bind(panel.webview);
            panel.webview.postMessage = (msg) => {
                rec.toWebview.push(msg && msg.type);
                // Keep the payload of an insert: the Objects-tree insert commands are vscode-bound,
                // so this round trip is the only place their whole path (tree node → XML parse →
                // template → panel) can be proven end to end.
                if (msg && msg.type === 'insertText') rec.inserted = (rec.inserted || []).concat(msg.text);
                return origPost(msg);
            };
            try {
                return origResolve.call(this, document, panel, token);
            } catch (e) {
                rec.resolveThrew = String((e && e.stack) || e);
                throw e;
            } finally {
                fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
            }
        };

        // Case-insensitive: VS Code reports the development extensionPath in its own drive-letter
        // casing, which need not match ours.
        const wanted = REPO.replace(/\\/g, '/').toLowerCase();
        const ext = vscode.extensions.all.find(e =>
            path.resolve(e.extensionPath || '').replace(/\\/g, '/').toLowerCase() === wanted);
        if (!ext) { log('no-extension', { paths: vscode.extensions.all.map(e => e.extensionPath).slice(-5) }); return; }
        await ext.activate();
        log('activated', { id: ext.id });

        // Drive the actual VS Code-bound Objects provider over two same-named `.plcproj` copies.
        // The pure formatter has unit coverage, but only this proves the provider renders those labels.
        const { createProjectMap, normalizeProjectPath } = require(path.join(REPO, 'src', 'lsp', 'projectMap.js'));
        const { createSolutionMap } = require(path.join(REPO, 'src', 'solutionMap.js'));
        const { fileUriToFsPath } = require(path.join(REPO, 'src', 'fileUri.js'));
        const { TwinCatTreeDataProvider } = require(path.join(REPO, 'src', 'treeDataProvider.js'));
        const { projectLabel } = require(path.join(REPO, 'src', 'projectStatusBar.js'));
        const projectMap = createProjectMap([WS]);
        const solutionMap = createSolutionMap([WS], projectMap);
        const treeProvider = new TwinCatTreeDataProvider(() => projectMap, () => solutionMap);
        const roots = await treeProvider.getChildren();
        const solutionProjects = {};
        for (const root of roots) {
            if (root.contextValue !== 'solution') continue;
            solutionProjects[String(root.label)] = (await treeProvider.getChildren(root)).map(item => String(item.label));
        }
        const mainA = path.join(SAMPLE, 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
        const mainB = path.join(WS, 'LineB', 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
        const station = path.join(SAMPLE, 'TcToolkitSample_PLC', 'POUs', 'Machine', 'FB_Station.TcPOU');
        const stationProject = projectMap.get(projectMap.projectFor(station));
        log('multi-project-ui', {
            solutionLabels: roots.filter(item => item.contextValue === 'solution').map(item => String(item.label)),
            solutionProjects,
            statusLabels: [projectLabel(projectMap, mainA), projectLabel(projectMap, mainB)],
            indexedStationPath: stationProject && stationProject.objectFiles.get(normalizeProjectPath(station)),
            stationUri: vscode.Uri.file(station).toString()
        });

        const GVL = path.join(SAMPLE, 'TcToolkitSample_PLC', 'GVLs', 'GVL_System.TcGVL');
        const MAIN = path.join(SAMPLE, 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
        const gvlUri = vscode.Uri.file(GVL);

        // 1. Open the GVL as a user would from the Explorer; the chain must complete.
        await vscode.commands.executeCommand('vscode.openWith', gvlUri, 'twincat.xmlViewer');
        await sleep(4000);
        log('after-open', { tabs: vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label)) });

        // 2. The live LSP bridge: definition + references for GVL_System from MAIN, exactly the
        //    params the webview bridge sends. Retries while the server's initial scan finishes.
        const { parseTwinCatXml } = require(path.join(REPO, 'src', 'xmlParser.js'));
        const { convertXmlToSt } = require(path.join(REPO, 'src', 'stConverter.js'));
        const unit = convertXmlToSt(parseTwinCatXml(fs.readFileSync(MAIN, 'utf8')), { raw: true });
        const lines = unit.stText.split('\n');
        const li = lines.findIndex(l => /GVL_System\./.test(l));
        const params = {
            code: unit.stText,
            position: { line: li, character: lines[li].indexOf('GVL_System') + 1 },
            fileUri: vscode.Uri.file(MAIN).toString()
        };
        let def = null;
        for (let attempt = 0; attempt < 12 && !def; attempt++) {
            def = await vscode.commands.executeCommand('twincat.lsp.queryDefinition', params);
            if (!def) await sleep(5000);
        }
        const refs = await vscode.commands.executeCommand('twincat.lsp.queryReferences', params);
        log('lsp', {
            definition: def,
            refCount: Array.isArray(refs) ? refs.length : String(refs),
            referenceUris: Array.isArray(refs) ? [...new Set(refs.map(r => r.uri))] : [],
            referenceFsPaths: Array.isArray(refs)
                ? [...new Set(refs.map(r => fileUriToFsPath(r.uri)))]
                : []
        });

        // 3. Navigate with the uri the definition returned — the openFile flow. The GVL is already
        //    open, so a correctly-spelled uri must REUSE that tab, not add a lowercase twin.
        if (def && def.uri) {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(def.uri), 'twincat.xmlViewer');
            await sleep(3000);
            log('after-def-nav', { tabs: vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label)) });
        }

        // 3b. Navigation must leave the Objects tree on the component the webview actually loaded,
        // including virtual-folder members and both property accessors. The first open also emits a
        // root reveal during file activation; activeComponentChanged must win with the exact id.
        const stationUri = vscode.Uri.file(station);
        const componentTargets = [
            'method_Cyclic',
            'prop_State',
            'prop_State_get',
            'prop_State_set',
            'action_Act_Home'
        ];
        for (const componentId of componentTargets) {
            await vscode.commands.executeCommand('twincat.openComponent', stationUri, componentId);
            await sleep(900);
        }
        log('component-tree-reveal', {
            requested: componentTargets,
            reveals: out.treeReveals.filter(r => r.uri === stationUri.toString())
        });

        // A retained webview does not call loadComponent when its tab is reactivated. The host must
        // remember the last activeComponentChanged id or this round trip would reveal the file root.
        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'method_Cyclic');
        await sleep(900);
        const retainedStart = out.treeReveals.length;
        await vscode.commands.executeCommand('vscode.openWith', gvlUri, 'twincat.xmlViewer');
        await sleep(900);
        await vscode.commands.executeCommand('vscode.openWith', stationUri, 'twincat.xmlViewer');
        await sleep(900);
        log('retained-component-tree-reveal', {
            reveals: out.treeReveals.slice(retainedStart).filter(r => r.uri === stationUri.toString())
        });

        // 4. The Objects-tree insert commands. Their module is vscode-bound (like the drag-and-drop
        //    and clipboard controllers), so only a real host can show that a context-menu invocation
        //    reaches the webview's caret. The node stands in for the tree item VS Code would pass.
        // Located by search, not by a hardcoded path: the sample's folder layout is the generator's
        // business, and a stale path here fails as a silent skip rather than a red assertion.
        const findFile = (dir, name) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
                else if (e.name.toLowerCase() === name.toLowerCase()) return p;
            }
            return null;
        };
        const FB = findFile(SAMPLE, 'FB_Cylinder.TcPOU');
        if (FB) {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(FB), 'twincat.xmlViewer');
            await sleep(3000);
            const fileNode = { resourceUri: vscode.Uri.file(FB), contextValue: 'pouFile', label: 'FB_Cylinder.TcPOU' };
            await vscode.commands.executeCommand('twincat.insertObjectAtCursor', fileNode);
            await sleep(700);
            await vscode.commands.executeCommand('twincat.insertObjectDefinitionAtCursor',
                { resourceUri: vscode.Uri.file(FB), contextValue: 'component', label: 'FB_init' });
            await sleep(700);
            const panel = out.panels.filter(p => /FB_Cylinder\.TcPOU$/i.test(p.uri)).pop();
            log('object-insert', { inserted: (panel && panel.inserted) || [] });
        } else {
            log('object-insert', { skipped: 'FB_Cylinder.TcPOU not found', inserted: [] });
        }

        // ------------------------------------------------------------------------------------
        // 5. The P8 / G4 webview checklist (docs/superpowers/plans/2026-08-22-deepen-08-g4-
        //    checklist.md items 2-7), driven through media/devHostTestHook.js. Everything here
        //    goes through the real Monaco editors and the real message bus: typing fires
        //    onDidChangeModelContent, so editor.js's own Auto/Manual branch runs, and the
        //    documents, saves and file bytes are the real ones. The unique `devhost-*` marker
        //    comments are valid ST comments and are unique in the fixture, so a later phase can
        //    prove which edit reached disk.
        // ------------------------------------------------------------------------------------
        // The two dual-mode modules the HOST uses for the very writes under test, required here so
        // the expected bytes are computed by the production code rather than a restatement of it.
        const pendingEditsCore = require(path.join(REPO, 'media', 'pendingEdits.js'));
        const { replaceComponentCdata } = require(path.join(REPO, 'src', 'xmlParser.js'));

        const stationUriStr = stationUri.toString();
        const stationDoc = () =>
            vscode.workspace.textDocuments.find(d => sameUri(d.uri.toString(), stationUriStr)) || null;

        // --- Phase p8-manual (checklist 3 + 2): Manual Sync accounting, and the cross-PROCESS
        //     round trip of the pending-edit record shape. Closing the tab is the whole point:
        //     webviews are retained when hidden, so only a dispose/re-resolve makes the host's
        //     `pendingEditsStore` the sole carrier of the edits ('updatePendingEdits' ->
        //     workspaceState -> 'init' cachedEdits -> applyCachedEdits). The persisted entry is
        //     read back here too: after a window RELOAD it is all that is left, so it must exist
        //     while edits are pending and be gone once the flush folded them into the file.
        await vscode.commands.executeCommand('vscode.openWith', stationUri, 'twincat.xmlViewer');
        await sleep(2000);
        let stationPanel = panelFor(stationUriStr);
        let st = await waitFor(stationPanel, s => s.ready, 30000);

        const startedInAuto = !!(st && st.toggleChecked);
        if (startedInAuto) {
            await ask(stationPanel, { type: 'test:toggleSync' });
            st = await waitFor(stationPanel, s => s.syncText === 'Manual Sync', 10000);
        }
        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'root');
        st = await waitFor(stationPanel, s => s.selectValue === 'root', 10000);

        // The pristine bytes every later byte-identity comparison is computed from.
        const stationBefore = fs.readFileSync(station, 'utf8');

        await ask(stationPanel, { type: 'test:typeText', pane: 'decl', text: '\n(* devhost-m-decl *)' });
        const statusAfterDecl = (await waitFor(stationPanel, s => s.status === 'Unsaved Changes (1)', 10000) || {}).status;
        await ask(stationPanel, { type: 'test:typeText', pane: 'impl', text: '\n(* devhost-m-impl *)' });
        const statusAfterImpl = (await waitFor(stationPanel, s => s.status === 'Unsaved Changes (2)', 10000) || {}).status;
        // A second edit to the SAME pane must overwrite its record, not add one — the store is
        // keyed `componentId_blockType`, and the count is the user-visible proof of it.
        await ask(stationPanel, { type: 'test:typeText', pane: 'impl', text: '\n(* devhost-m-impl2 *)' });
        await sleep(1200);
        const statusAfterReEdit = ((await state(stationPanel)) || {}).status;

        // A property Get edit while the same-named Set exists: the restore matches on the
        // xmlContext TRIPLE (subType + subName + accessorType), and only real components can show
        // that the accessor half of it carries.
        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'prop_State_get');
        await waitFor(stationPanel, s => s.selectValue === 'prop_State_get', 10000);
        await ask(stationPanel, { type: 'test:typeText', pane: 'impl', text: '\n(* devhost-get-edit *)' });
        const statusAfterGetEdit = (await waitFor(stationPanel, s => s.status === 'Unsaved Changes (3)', 10000) || {}).status;

        // Close the tab (the document is CLEAN in Manual mode, so nothing prompts) and reopen.
        await vscode.commands.executeCommand('vscode.openWith', stationUri, 'twincat.xmlViewer');
        await sleep(1000);
        // With three edits pending the persisted entry must exist and be fingerprinted: after a
        // Ctrl+R the host's memory is gone and this entry is all `init` has to restore from.
        const persistedPending = persistedEntry(stationUriStr);
        const panelsBeforeReopen = livePanels.length;
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await sleep(2000);
        await vscode.commands.executeCommand('vscode.openWith', stationUri, 'twincat.xmlViewer');
        for (let i = 0; i < 60 && livePanels.length === panelsBeforeReopen; i++) await sleep(250);
        const reopened = livePanels.length > panelsBeforeReopen;
        stationPanel = panelFor(stationUriStr);
        const reopenState = await waitFor(stationPanel,
            s => s.ready && s.status === 'Unsaved Changes (3)', 30000);

        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'root');
        const rootState = await waitFor(stationPanel,
            s => s.selectValue === 'root' && !!s.declValue && !!s.implValue, 10000);
        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'prop_State_get');
        const getState = await waitFor(stationPanel, s => s.selectValue === 'prop_State_get', 10000);
        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'prop_State_set');
        const setState = await waitFor(stationPanel, s => s.selectValue === 'prop_State_set', 10000);

        log('p8-manual', {
            startedInAuto: startedInAuto,
            syncText: (reopenState && reopenState.syncText) || null,
            statusAfterDecl: statusAfterDecl || null,
            statusAfterImpl: statusAfterImpl || null,
            statusAfterReEdit: statusAfterReEdit || null,
            statusAfterGetEdit: statusAfterGetEdit || null,
            reopened: reopened,
            statusAfterReopen: (reopenState && reopenState.status) || null,
            rootDeclRestored: !!(rootState && rootState.declValue && rootState.declValue.includes('devhost-m-decl')),
            rootImplRestored: !!(rootState && rootState.implValue && rootState.implValue.includes('devhost-m-impl2')),
            getRestored: !!(getState && getState.implValue && getState.implValue.includes('devhost-get-edit')),
            setContaminated: !!(setState && setState.implValue && setState.implValue.includes('devhost-get-edit')),
            workspaceStateReachable: !!(hostContext && hostContext.workspaceState),
            persistedEditCount: persistedPending ? Object.keys(persistedPending.edits || {}).length : -1,
            persistedFingerprinted: !!(persistedPending && typeof persistedPending.fingerprint === 'string' &&
                persistedPending.fingerprint.length > 0)
        });

        // --- Phase p8-sync (checklist 3, the save half): Manual -> Auto flushes, and the file it
        //     writes must equal `foldEdits` over the edits the webview actually posted — i.e.
        //     everything outside the edited CDATA blocks byte-identical, stated as an equality
        //     over the WHOLE file rather than an eyeballed `git diff`.
        await ask(stationPanel, { type: 'test:toggleSync' });
        let syncState = null;
        let stationAfter = '';
        const syncDeadline = Date.now() + 15000;
        for (;;) {
            syncState = await state(stationPanel);
            const doc = stationDoc();
            stationAfter = fs.readFileSync(station, 'utf8');
            const settled = syncState && syncState.status === 'Synced' &&
                (!doc || !doc.isDirty) && stationAfter.includes('devhost-m-decl');
            if (settled || Date.now() >= syncDeadline) break;
            await sleep(500);
        }
        const stationRec = recordFor(stationUriStr);
        const syncCaptured = ((stationRec && stationRec.captured) || []).filter(c => c.type === 'sync-pending').pop();
        const syncExpected = syncCaptured
            ? pendingEditsCore.foldEdits(stationBefore, syncCaptured.edits, replaceComponentCdata)
            : null;
        const syncDiffAt = syncExpected === null ? -2 : firstDiffIndex(stationAfter, syncExpected);
        log('p8-sync', {
            status: (syncState && syncState.status) || null,
            // The edits now live in the file, so the persisted entry must be gone — otherwise a
            // later reload would re-apply edits that are already on disk.
            persistedAfterFlush: !!persistedEntry(stationUriStr),
            documentDirty: !!(stationDoc() && stationDoc().isDirty),
            editCount: syncCaptured ? syncCaptured.edits.length : 0,
            byteIdentical: syncDiffAt === -1,
            afterLen: stationAfter.length,
            expectedLen: syncExpected === null ? null : syncExpected.length,
            firstDiffIndex: syncDiffAt,
            afterExcerpt: syncDiffAt >= 0 ? diffExcerpt(stationAfter, syncDiffAt) : null,
            expectedExcerpt: syncDiffAt >= 0 && syncExpected !== null ? diffExcerpt(syncExpected, syncDiffAt) : null
        });

        // --- Phase p8-flush (checklist 4): the flush-vs-save asymmetry. With ZERO pending edits,
        //     Ctrl+S must still post 'save' and run the native save — `takeAll` is symmetric, so
        //     only the two call sites keep this true and nothing else covers it.
        await ask(stationPanel, { type: 'test:toggleSync' });
        const manualAgain = await waitFor(stationPanel,
            s => s.syncText === 'Manual Sync' && s.status === 'Synced', 10000);
        const bytesBeforeSave = fs.readFileSync(station, 'utf8');
        await ask(stationPanel, { type: 'test:manualSave' });
        await sleep(2500);
        const flushFrom = (stationRec && stationRec.fromWebview) || [];
        const flushSave = ((stationRec && stationRec.captured) || []).filter(c => c.type === 'save').pop();
        log('p8-flush', {
            syncText: (manualAgain && manualAgain.syncText) || null,
            statusBeforeSave: (manualAgain && manualAgain.status) || null,
            savePostedAfterSync: flushFrom.includes('sync-pending') &&
                flushFrom.lastIndexOf('save') > flushFrom.indexOf('sync-pending'),
            saveEditCount: flushSave && Array.isArray(flushSave.edits) ? flushSave.edits.length : null,
            documentDirty: !!(stationDoc() && stationDoc().isDirty),
            bytesUnchanged: fs.readFileSync(station, 'utf8') === bytesBeforeSave
        });

        // --- Phase p8-auto (checklist 7): ordinary Auto-mode typing still round-trips a per-edit
        //     'edit' message, and the file the host writes from it is byte-identical to
        //     replaceComponentCdata over the same record.
        await ask(stationPanel, { type: 'test:toggleSync' });
        await waitFor(stationPanel, s => s.syncText === 'Auto Sync', 10000);
        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'root');
        await waitFor(stationPanel, s => s.selectValue === 'root', 10000);
        const stationBefore2 = fs.readFileSync(station, 'utf8');
        await ask(stationPanel, { type: 'test:typeText', pane: 'impl', text: '\n(* devhost-auto *)' });
        let autoDisk = '';
        const autoDeadline = Date.now() + 15000;
        for (;;) {
            autoDisk = fs.readFileSync(station, 'utf8');
            if (autoDisk.includes('devhost-auto') || Date.now() >= autoDeadline) break;
            await sleep(500); // 200 ms edit debounce + WorkspaceEdit + document.save()
        }
        const autoEdit = ((stationRec && stationRec.captured) || []).filter(c => c.type === 'edit').pop();
        const autoExpected = autoEdit
            ? replaceComponentCdata(stationBefore2, autoEdit.context, autoEdit.blockType, autoEdit.content)
            : null;
        const autoDiffAt = autoExpected === null ? -2 : firstDiffIndex(autoDisk, autoExpected);
        log('p8-auto', {
            saved: autoDisk.includes('devhost-auto'),
            blockType: autoEdit ? autoEdit.blockType : null,
            byteIdentical: autoDiffAt === -1,
            firstDiffIndex: autoDiffAt,
            diskExcerpt: autoDiffAt >= 0 ? diffExcerpt(autoDisk, autoDiffAt) : null,
            expectedExcerpt: autoDiffAt >= 0 && autoExpected !== null ? diffExcerpt(autoExpected, autoDiffAt) : null
        });

        // --- Phase p8-diag (checklist 6): real markers, with REAL monaco.MarkerSeverity values
        //     (the browser harness injects sentinels), in the right pane — and the collapsed-decl
        //     case, where an Action hides the declaration pane and the `display !== 'none'` guards
        //     in editor.js are all that stop setModelMarkers from throwing. Manual mode first, so
        //     the deliberately broken lines never reach disk.
        await ask(stationPanel, { type: 'test:toggleSync' });
        await waitFor(stationPanel, s => s.syncText === 'Manual Sync', 10000);
        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'root');
        await waitFor(stationPanel, s => s.selectValue === 'root', 10000);
        await ask(stationPanel, { type: 'test:typeText', pane: 'impl', text: '\nundeclared_devhost_var := 1;' });
        const rootDiagState = await waitFor(stationPanel,
            s => s.markers.some(m => m.pane === 'impl' && m.severity === s.markerSeverityError), 20000);

        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'action_Act_Home');
        await waitFor(stationPanel, s => s.selectValue === 'action_Act_Home' && !s.declVisible, 10000);
        await ask(stationPanel, { type: 'test:typeText', pane: 'impl', text: '\nundeclared_devhost_var2 := 2;' });
        const actionDiagState = await waitFor(stationPanel,
            s => s.markers.some(m => m.pane === 'impl' && m.severity === s.markerSeverityError), 20000);
        log('p8-diag', {
            markerSeverityError: (rootDiagState && rootDiagState.markerSeverityError) || null,
            rootMarkers: (rootDiagState && rootDiagState.markers) || [],
            actionMarkers: (actionDiagState && actionDiagState.markers) || [],
            actionDeclVisible: actionDiagState ? actionDiagState.declVisible : null,
            errors: (actionDiagState && actionDiagState.errors) || []
        });

        // --- Phase p8-goto (checklist 5a): Go to Definition onto a symbol defined in ANOTHER file
        //     must select that exact word there — not the first same-named occurrence, which is
        //     what the 0.6.3 bug did. The member is read from the live pane text rather than
        //     hardcoded; MAIN's implementation is the generator's business, not this harness's.
        const mainUri = vscode.Uri.file(MAIN);
        const mainUriStr = mainUri.toString();
        await vscode.commands.executeCommand('vscode.openWith', mainUri, 'twincat.xmlViewer');
        await sleep(2000);
        const mainPanel = panelFor(mainUriStr);
        let mainState = await waitFor(mainPanel, s => s.ready && !!s.implValue, 30000);
        await vscode.commands.executeCommand('twincat.openComponent', mainUri, 'root');
        mainState = await waitFor(mainPanel, s => s.selectValue === 'root' && !!s.implValue, 10000);

        const implLines = String((mainState && mainState.implValue) || '').split(/\r?\n/);
        let member = null;
        let memberLine = 0;
        let memberColumn = 0;
        for (let i = 0; i < implLines.length; i++) {
            const hit = /GVL_System\.(\w+)/.exec(implLines[i]);
            if (!hit) continue;
            member = hit[1];
            memberLine = i + 1;
            // Monaco columns are 1-based; aim at the middle of the member word so neither
            // boundary can make the word-at-position lookup ambiguous.
            memberColumn = hit.index + 'GVL_System.'.length + 1 + Math.floor(member.length / 2);
            break;
        }

        let gotoSelection = null;
        let selectionApplied = false;
        if (member) {
            const gvlRec = recordFor(gvlUri.toString());
            const gvlFromLen = ((gvlRec && gvlRec.fromWebview) || []).length;
            await ask(mainPanel, { type: 'test:setPosition', pane: 'impl', line: memberLine, column: memberColumn });
            await ask(mainPanel, { type: 'test:trigger', pane: 'impl', actionId: 'editor.action.revealDefinition' });
            const gotoDeadline = Date.now() + 15000;
            for (;;) {
                const gvlPanel = panelFor(gvlUri.toString());
                const gvlState = gvlPanel ? await state(gvlPanel) : null;
                gotoSelection = (gvlState && gvlState.selection) || gotoSelection;
                selectionApplied = ((gvlRec && gvlRec.fromWebview) || []).slice(gvlFromLen).includes('selectionApplied');
                const landed = gotoSelection && String(gotoSelection.text).toLowerCase() === member.toLowerCase();
                if ((landed && selectionApplied) || Date.now() >= gotoDeadline) break;
                await sleep(500);
            }
        }
        log('p8-goto', {
            member: member,
            line: memberLine,
            column: memberColumn,
            selectionText: gotoSelection ? gotoSelection.text : null,
            selection: gotoSelection,
            selectionApplied: selectionApplied
        });

        // --- Phase p8-peek (checklist 5b): a peek entry from ANOTHER file. The click drives
        //     `peekOpenMessage`'s 'openFile' body through the real host, and the origin webview's
        //     peek must end up dismissed — Monaco cannot dismiss it itself, because the navigation
        //     leaves through the extension host and it never learns the reference was opened.
        await vscode.commands.executeCommand('vscode.openWith', mainUri, 'twincat.xmlViewer');
        await sleep(1500);
        await ask(mainPanel, { type: 'test:setPosition', pane: 'impl', line: memberLine, column: memberColumn });
        const mainRec = recordFor(mainUriStr);
        const preTriggerLen = ((mainRec && mainRec.fromWebview) || []).length;
        await ask(mainPanel, { type: 'test:trigger', pane: 'impl', actionId: 'editor.action.referenceSearch.trigger' });
        const peekState = await waitFor(mainPanel, s => s.peekOpen, 15000);
        const peekFromLen = ((mainRec && mainRec.fromWebview) || []).length;
        // The peek opens with only the group holding the focused reference expanded — here that is
        // MAIN's own hit — and the list is virtualized, so FB_Station's reference row is not in
        // the DOM yet. Expand its file group first; the tree loads children asynchronously, hence
        // the settle before the rows are re-read.
        const expanded = await ask(mainPanel, { type: 'test:expandPeekFile', matchText: 'FB_Station' });
        await sleep(1500);
        // Matched by FILE, not by preview text: a reference row's label is Monaco's own trimmed
        // preview of the line (`GVL_System.fbCylinder;`, not the whole statement), which is not a
        // stable thing to match on — and the same text appears under MAIN's own group. The hook
        // steps from the matched file row to that group's first reference row. GVL_System is the
        // fallback for a fixture whose reference set has moved; either is a DIFFERENT file.
        let click = null;
        let peekRows = [];
        for (const matchText of ['FB_Station', 'GVL_System']) {
            click = await ask(mainPanel, { type: 'test:clickPeekRow', matchText: matchText });
            if (click && click.rows) peekRows = click.rows;
            if (click && click.found) break;
        }
        let openFilePosted = false;
        let peekDismissed = false;
        const peekDeadline = Date.now() + 15000;
        for (;;) {
            openFilePosted = ((mainRec && mainRec.fromWebview) || []).slice(peekFromLen).includes('openFile');
            const s = await state(mainPanel);
            peekDismissed = !!s && !s.peekOpen;
            if ((openFilePosted && peekDismissed) || Date.now() >= peekDeadline) break;
            await sleep(500);
        }
        log('p8-peek', {
            peekOpened: !!(peekState && peekState.peekOpen),
            fileGroupExpanded: !!(expanded && expanded.found),
            expandedRowText: (expanded && expanded.rowText) || null,
            rowFound: !!(click && click.found),
            rowText: (click && click.rowText) || null,
            matchedFileRow: !!(click && click.matchedFileRow),
            rows: peekRows,
            openFilePosted: openFilePosted,
            peekDismissed: peekDismissed,
            // editor.js's global error listener posts `error` to the host (and paints its overlay)
            // for any window error event; opening the peek used to trip it via Chrome's benign
            // ResizeObserver loop notice. Counted from the moment the search was triggered.
            errorPosted: ((mainRec && mainRec.fromWebview) || []).slice(preTriggerLen).includes('error')
        });

        // 6. The .tctleo watcher family (HANDOFF "probable bug"): the startup scan indexes the
        //    injected .TcTLEO (baseline), and an EXTERNAL on-disk edit — what a git checkout or
        //    XAE does — must reach the live index via the change watcher, the path
        //    TWINCAT_WATCH_EXTS gates. The probe is a definition query in exactly the shape the
        //    webview bridge sends, overlaying MAIN with a declaration that uses the enum type.
        const TLEO = path.join(SAMPLE, 'TcToolkitSample_PLC', 'DUTs', 'E_TleoState.TcTLEO');
        const probeTleo = (typeName) => {
            const code = `PROGRAM P_TleoProbe\nVAR\n\teProbe : ${typeName};\nEND_VAR\n`;
            return vscode.commands.executeCommand('twincat.lsp.queryDefinition', {
                code,
                position: { line: 2, character: code.split('\n')[2].indexOf(typeName) + 1 },
                fileUri: vscode.Uri.file(MAIN).toString()
            });
        };
        const tleoBaseline = await probeTleo('E_TleoState');
        fs.writeFileSync(TLEO, fs.readFileSync(TLEO, 'utf8').replace(/E_TleoState/g, 'E_TleoRenamed'));
        await sleep(6000); // change watcher -> custom/indexXmlDocument round trip
        const tleoRenamed = await probeTleo('E_TleoRenamed');
        log('tctleo-watch', {
            baselineUri: (tleoBaseline && tleoBaseline.uri) || null,
            renamedUri: (tleoRenamed && tleoRenamed.uri) || null
        });

        // --- Phase generate-st: project-aware ST export over the three-project fixture. Proves the
        //     real provider lists the projects for the webview picker and writes each project's
        //     objects under its OWN ST_Files subtree — so LineA and LineB's identical MAIN paths do
        //     not collide (the bug the old flat mirror had).
        try {
            const projectsForPicker = hostProvider ? hostProvider.listProjects() : [];
            await hostProvider.generateAllStFiles(); // no keys → every project
            await sleep(1500);
            const stRoot = path.join(WS, 'ST_Files');
            const exists = (rel) => fs.existsSync(path.join(stRoot, ...rel.split('/')));
            log('generate-st', {
                pickerLabels: projectsForPicker.map(p => p.label).sort(),
                // Same relative object path in two different projects, kept apart by project folder:
                lineAMain: exists('LineA/TcToolkitSample_PLC/POUs/MAIN.st'),
                lineBMain: exists('LineB/TcToolkitSample_PLC/POUs/MAIN.st'),
                auxMain: exists('LineA/TcToolkitSample_Aux/POUs/MAIN.st'),
                stationNested: exists('LineA/TcToolkitSample_PLC/POUs/Machine/FB_Station.st'),
                // A subset export writes only the chosen project.
                subset: null
            });
            // Subset: regenerate just the Aux project into a clean dir and confirm scoping.
            fs.rmSync(stRoot, { recursive: true, force: true });
            const auxKey = projectsForPicker.find(p => /_Aux/.test(p.label));
            if (auxKey) {
                await hostProvider.generateAllStFiles([auxKey.key]);
                await sleep(1000);
                const s = out.steps.find(x => x.step === 'generate-st');
                if (s) s.subset = {
                    auxWritten: exists('LineA/TcToolkitSample_Aux/POUs/MAIN.st'),
                    plcSkipped: !exists('LineA/TcToolkitSample_PLC/POUs/MAIN.st')
                };
                fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
            }
        } catch (e) {
            log('generate-st', { error: String((e && e.stack) || e) });
        }

        log('done', {});
    } catch (e) {
        log('CRASH', { error: String((e && e.stack) || e) });
    } finally {
        fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
        setTimeout(() => require('vscode').commands.executeCommand('workbench.action.closeWindow'), 1500);
        await sleep(3000);
    }
}

module.exports = { run };
