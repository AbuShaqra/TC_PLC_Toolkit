/**
 * @file onlineCommands.js
 * @description The VS Code half of online monitoring over ADS (roadmap R15): Go Online / Go Offline,
 * the status-bar item, the inline values in the two-pane editor, Write value…, and the "PLC Watch"
 * view. Everything that talks ADS lives in src/online/ (vscode-free, driven by the harnesses against
 * test/_fakeAds.js); this module only wires it to the UI.
 *
 * Rules (user decisions D1-D9, 2026-11-13; DEVELOPMENT.md "Online monitoring (R15)"):
 *   - The webview never talks ADS. It reports what its panes show (`online/visible`) and asks for a
 *     write or a watch at a pane position; the host resolves the position through the live path and
 *     the LSP's `custom/onlinePaths`, checks the path against the PLC's symbols, and posts values back.
 *   - The local AMS router first; direct mode only when `tcToolkit.online.connectionMode` says so,
 *     never as a fallback. Routes are never created here, and no credential is stored.
 *   - Go Online is cancellable (the progress notification's Cancel), and `dispose()` (extension
 *     deactivation) closes the connection, every notification and every poll.
 *   - Writes: src/online/writeGuard.js; enabled per online connection (its identity), reset on Go
 *     Offline. `tcToolkit.online.allowWrites` is read from the USER settings only (the setting is
 *     application-scoped), so a workspace's `.vscode/settings.json` cannot turn writes on. Only an
 *     editor of the project the PLC runs may write: the others are told (`writable: false`, the
 *     webview then hides Write Value…) and a write from them is refused before any dialog.
 *   - The write path never acts on a code check that is still running or was superseded: it waits
 *     for the newest one, and a check in flight counts as "not checked" (blocks).
 *   - Unsaved edits: any dirty TwinCAT document, any Manual Sync stash (open editor or not), and an
 *     Auto Sync edit an open editor has not written back yet.
 *   - The code-mismatch guard (src/online/codeIdentity.js) checks the project NAME the runtime
 *     reports (`_AppInfo.ProjectName`), the variable LAYOUT against the last build's `.tmc`, and
 *     source EDITS since that build. A different or unreadable name hides the inline values; any
 *     check that fails or cannot run blocks writes. It cannot detect a change to code bodies alone,
 *     and the status bar says what it checked, never "same code".
 *   - A FUNCTION_BLOCK's values need an instance: found in the PLC's symbol upload; with several the
 *     first is used and the user is told once, with a way to choose (`twincat.online.selectInstance`).
 */

'use strict';

const vscode = require('vscode');
const { createOnlineSession } = require('../online/session');
const { createAdsClient } = require('../online/adsClient');
const { describeConnectError } = require('../online/connectErrors');
const { createInlineMonitor } = require('../online/inlineMonitor');
const { createWatchList } = require('../online/watchList');
const { performWrite, enableWritesFor, targetName } = require('../online/writeGuard');
const { sameIdentity } = require('../online/session');
const fs = require('fs');
const { paneRanges, mapOccurrences, substituteInstance, REASON_TEXT } = require('../online/editorPaths');
const { assembleSt } = require('../livePath');
const { isValidNetId } = require('../xaeBuild');
const { checkCode } = require('../online/codeIdentity');

/** The output channel every connection event and every write is logged to. */
const OUTPUT_CHANNEL_NAME = 'TC Toolkit Online';
/** Settings section. */
const SECTION = 'tcToolkit.online';
/** workspaceState: the watched paths. */
const WATCH_KEY = 'twincat.online.watch';
/** workspaceState: recently used targets (a convenience; never a credential). */
const RECENT_TARGETS_KEY = 'twincat.online.recentTargets';
/** The quick-pick entry for the local runtime. */
const LOCAL_TARGET = { label: 'Local runtime', netId: 'localhost' };

/**
 * @param {vscode.ExtensionContext} context
 * @param {Object} deps
 * @param {any} deps.provider The custom editor provider (src/customEditorProvider.js).
 * @param {() => any} [deps.getProjectMap] The host's project map (names and file ownership).
 * @param {(o: import('../online/adsClient').ConnectOptions) => import('../online/adsClient').AdsPort} [deps.createClient]
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] The inline monitors' timers (the harnesses count them).
 * @returns {{session: ReturnType<typeof createOnlineSession>, watch: ReturnType<typeof createWatchList>,
 *   dispose: () => Promise<void>, refreshEditors: () => Promise<void>, refreshCodeCheck: () => Promise<void>,
 *   codeCheck: () => any}}
 */
function registerOnlineCommands(context, deps) {
    const provider = deps.provider;
    const cfg = () => vscode.workspace.getConfiguration(SECTION);
    const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    const log = (/** @type {string} */ line) => channel.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
    const session = createOnlineSession({
        createClient: deps.createClient || ((o) => createAdsClient(o)),
        log,
        maxNotifications: () => clampInt(cfg().get('maxNotifications', 100), 1, 400, 100)
    });
    /** @type {{enabled: boolean, identity: import('../online/session').SessionIdentity|null}} */
    const sessionWrites = { enabled: false, identity: null };
    const resetWrites = () => { sessionWrites.enabled = false; sessionWrites.identity = null; };
    /**
     * `tcToolkit.online.allowWrites` from the user's own settings only. The setting is
     * application-scoped (VS Code ignores a workspace value); reading `globalValue` keeps that true
     * even where a host would not.
     * @returns {boolean}
     */
    const allowWrites = () => {
        const c = cfg();
        if (typeof c.inspect === 'function') {
            const i = c.inspect('allowWrites');
            return !!(i && i.globalValue === true);
        }
        return false;
    };
    /** @type {Map<string, string>} FB name (lower case) -> chosen instance path, per online session. */
    const instances = new Map();
    /** @type {Set<string>} FBs whose "several instances" note was shown this session. */
    const instanceNoted = new Set();
    /**
     * One entry per open editor that asked for values.
     * @type {Map<string, {monitor: ReturnType<typeof createInlineMonitor>, last: any, document: any, owner: any}>}
     */
    const editors = new Map();

    // ── Status bar ────────────────────────────────────────────────────────────────────────────────
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    status.command = 'twincat.online.statusMenu';
    const renderStatus = () => {
        const s = session.state;
        if (s === 'offline') { status.hide(); return; }
        const t = session.target ? session.target.label : '';
        if (s === 'connecting') {
            status.text = `$(sync~spin) Going online: ${t}`;
            status.tooltip = 'Connecting over ADS. Use the notification\'s Cancel to stop.';
            status.backgroundColor = undefined;
            status.show();
            return;
        }
        const info = session.info;
        const project = projectState();
        const c = code;
        const forces = info.forces && (info.forces.plc || info.forces.io);
        let word = info.lost ? 'Reconnecting' : (info.plcState || 'Unknown');
        if (project === 'differs') word += ' · Code differs';
        else if (project === 'unknown') word += ' · Code not checked';
        if (forces) word += ' · Forces active';
        status.text = `${forces || project !== 'match' ? '$(warning)' : '$(plug)'} Online: ${t} · ${word}`;
        status.tooltip = [
            `Target: ${t}${session.target && session.target.mode === 'direct' ? ' (direct)' : ' (through the local router)'}`,
            `PLC state: ${info.plcState || 'unknown'}`,
            `Project on the PLC: ${info.projectName || 'not reported'}`,
            `Code check (project name, variable layout against the last build's .tmc, edits since that build; ` +
                `a change to code bodies alone is not detected): ${project === 'match' ? 'passed' : (project === 'differs' ? 'DIFFERS' : 'not possible')}` +
                (c && project !== 'match' ? ` - ${c.reason}${c.showValues ? '' : ' Values hidden.'} Writes blocked.` : ''),
            `Forces: ${info.forces ? (forces ? `active (${[info.forces.plc ? 'PLC' : '', info.forces.io ? 'I/O' : ''].filter(Boolean).join(' and ')}), set from XAE` : 'none') : 'not reported by this runtime (TwinCAT 3.1.4026.21 or later reports them)'}`,
            `Writes: ${!allowWrites() ? 'off (tcToolkit.online.allowWrites)' : (sessionWrites.enabled && sameIdentity(sessionWrites.identity, session.identity) ? 'enabled for this session' : 'not yet enabled for this session')}`,
            `Notifications: ${session.subscriptionCount} of ${clampInt(cfg().get('maxNotifications', 100), 1, 400, 100)}`
        ].join('\n');
        status.backgroundColor = forces || project !== 'match' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        status.show();
    };

    // ── The code-mismatch guard ──────────────────────────────────────────────────────────────────
    /** @returns {Array<{key: string, name: string, dir?: string, files?: string[]}>} */
    const localProjects = () => {
        const map = deps.getProjectMap ? deps.getProjectMap() : null;
        if (!map || !map.projects) return [];
        return [...map.projects.entries()].map(([key, p]) => ({ key, name: p.name, dir: p.dir,
            files: p.objectFiles instanceof Map ? [...p.objectFiles.values()] : undefined }));
    };
    /**
     * The last code check (src/online/codeIdentity.js); null until the first one after going online.
     * @type {(import('../online/codeIdentity').CodeCheck & {project: any, identity?: any})|null}
     */
    let code = null;
    let codeRun = 0;
    /** @type {Promise<void>|null} The newest code check while it runs; null when none is running. */
    let codeChecking = null;
    /** Runs the code check again; logs it when its outcome changes. */
    function refreshCodeCheck() {
        if (session.state !== 'online') { code = null; return Promise.resolve(); }
        const p = runCodeCheck(++codeRun);
        codeChecking = p;
        const clear = () => { if (codeChecking === p) codeChecking = null; };
        p.then(clear, clear);
        return p;
    }
    /**
     * Waits until no code check is running: the newest one, and any started while waiting.
     * @returns {Promise<void>}
     */
    async function codeCheckSettled() {
        while (codeChecking) await codeChecking.catch(() => {});
    }
    /** @param {number} mine */
    async function runCodeCheck(mine) {
        const id = session.identity;
        const next = await checkCode({ projectName: session.info.projectName, projects: localProjects(), onlineSymbols: () => session.onlineSymbols() })
            .catch(e => ({ state: /** @type {'unknown'} */ ('unknown'), name: /** @type {'unknown'} */ ('unknown'), layout: /** @type {'unknown'} */ ('unknown'),
                edits: /** @type {'unknown'} */ ('unknown'), showValues: false, project: null, reason: `The code check failed: ${e && e.message}`, details: [] }));
        if (mine !== codeRun || session.state !== 'online' || !sameIdentity(id, session.identity)) return;
        // The bound project counts: a download of another workspace project to the same runtime keeps
        // the state and the reason text, but changes which editors may write and show values.
        const keyOf = (/** @type {any} */ c) => (c && c.project ? c.project.key : null);
        const changed = !code || code.state !== next.state || code.reason !== next.reason || code.showValues !== next.showValues
            || keyOf(code) !== keyOf(next);
        code = { ...next, identity: id };
        if (changed) {
            log(`Code check: ${next.state === 'match' ? 'passed' : next.state}${next.project ? ` (project ${next.project.name})` : ''} - ${next.reason}`);
            for (const d of next.details) log(`  ${d}`);
            if (session.info.appTimestamp) log(`  _AppInfo.AppTimestamp on the PLC: ${session.info.appTimestamp} (logged for comparison only; not checked)`);
            renderStatus();
            await refreshEditors();
        }
    }
    /** @returns {'match'|'differs'|'unknown'} */
    function projectState() {
        if (session.state !== 'online' || !code) return 'unknown';
        return code.state;
    }
    /**
     * The code check as the write guard sees it: 'unknown' (blocks) while a check runs, or when the
     * last result belongs to another connection.
     * @returns {'match'|'differs'|'unknown'}
     */
    function writeProjectState() {
        if (codeChecking || !code || !sameIdentity(code.identity, session.identity)) return 'unknown';
        return projectState();
    }
    /** @param {string} fsPath @returns {boolean} Whether a file belongs to the project the PLC runs. */
    const inBoundProject = (fsPath) => {
        const bound = code && code.project;
        const map = deps.getProjectMap ? deps.getProjectMap() : null;
        if (!bound || !map || typeof map.ownersOf !== 'function') return false;
        return (map.ownersOf(fsPath) || []).includes(bound.key);
    };
    /**
     * Any TwinCAT document with unsaved edits: dirty in VS Code, stashed by Manual Sync (whether its
     * editor is open or closed: the stash outlives the tab), or reported dirty by an open editor.
     * @returns {boolean}
     */
    const anyUnsaved = () => {
        const docs = vscode.workspace.textDocuments || [];
        if (docs.some(d => d.isDirty && /\.Tc(POU|GVL|DUT|IO)$/i.test(d.uri.fsPath || ''))) return true;
        for (const e of editors.values()) if (e.last && e.last.dirty) return true;
        const store = provider.pendingEditsStore;
        if (!store) return false;
        const uris = typeof store.uris === 'function' ? store.uris() : [...editors.keys()];
        for (const uriStr of uris) {
            // peek() checks the stash against the document's current text and never deletes it: a
            // stash that no longer matches is still the user's unsaved work, so it blocks (fail closed).
            let text;
            const open = editors.get(uriStr);
            const doc = open && open.document ? open.document : docs.find(d => d.uri && d.uri.toString() === uriStr);
            if (doc) text = doc.getText();
            else {
                try { text = fs.readFileSync(vscode.Uri.parse(uriStr).fsPath, 'utf8'); } catch (e) { return true; } // unreadable: assume unsaved
            }
            if (typeof store.peek !== 'function') return true;
            const seen = store.peek(uriStr, text);
            if (seen.stale || Object.keys(seen.edits || {}).length > 0) return true;
        }
        return false;
    };

    // ── Watch view ───────────────────────────────────────────────────────────────────────────────
    const watch = createWatchList({
        session,
        load: () => context.workspaceState.get(WATCH_KEY, []),
        save: (entries) => { context.workspaceState.update(WATCH_KEY, entries); },
        cycleMs: () => clampInt(cfg().get('watchCycleTime', 200), 50, 10000, 200),
        onChange: () => { if (tree) tree.refresh(); renderStatus(); },
        onCapped: (n) => {
            vscode.window.showWarningMessage(`PLC Watch: the notification limit (${n}, tcToolkit.online.maxNotifications) is reached; ` +
                'the remaining watched variables show no value. Remove some, or raise the limit (Beckhoff recommends at most 550 per device).');
        }
    });
    /** @type {any} */
    let tree = null;
    try {
        const { WatchTreeProvider } = require('../online/watchTree');
        tree = new WatchTreeProvider(watch);
        context.subscriptions.push(vscode.window.registerTreeDataProvider('twincatWatch', tree));
    } catch (e) { tree = null; }

    // ── Editors ──────────────────────────────────────────────────────────────────────────────────
    /**
     * The instance a FUNCTION_BLOCK's values are read from; null when the PLC has none.
     * @param {{name: string, kind: string, derived: string[]}} owner
     * @returns {Promise<string|null>}
     */
    async function instanceFor(owner) {
        const key = owner.name.toLowerCase();
        if (instances.has(key)) return /** @type {string} */ (instances.get(key));
        const found = await session.findInstances([owner.name, ...(owner.derived || [])]);
        if (found.length === 0) return null;
        instances.set(key, found[0].path);
        if (found.length > 1 && !instanceNoted.has(key)) {
            instanceNoted.add(key);
            vscode.window.showInformationMessage(`${owner.name} has ${found.length} instances on the PLC; showing ${found[0].path}.`, 'Choose Instance…')
                .then(pick => { if (pick) vscode.commands.executeCommand('twincat.online.selectInstance', { fbName: owner.name }); });
        }
        return found[0].path;
    }

    /**
     * The pane occurrences of the lines a message names, with the instance filled in.
     * @param {any} document
     * @param {any} msg { componentId, decl, impl, fileUri, visible? }
     * @param {Array<{start: number, end: number, pane: 'decl'|'impl'}>|null} [ranges] Unit ranges; default: msg.visible.
     */
    async function occurrencesFor(document, msg, ranges) {
        const ctx = assembleSt(document.getText(), msg);
        if (!ctx) return { occurrences: [], owner: null };
        const r = ranges || paneRanges(ctx.lineMap, { componentId: msg.componentId,
            decl: msg.visible && msg.visible.decl, impl: msg.visible && msg.visible.impl });
        /** @type {any} */
        const res = await vscode.commands.executeCommand('twincat.lsp.queryOnlinePaths', { code: ctx.stText, ranges: r, fileUri: msg.fileUri });
        const owner = res && res.owner;
        let instance = null;
        if (owner && owner.kind === 'FUNCTION_BLOCK' && session.state === 'online') instance = await instanceFor(owner);
        const occurrences = mapOccurrences((res && res.occurrences) || [], ctx.lineMap)
            .map(o => ({ ...o, adsPath: substituteInstance(o.path, instance) }));
        return { occurrences, owner, instance, lineMap: ctx.lineMap };
    }

    /**
     * Re-resolves one editor's visible variables and (re)starts its poll.
     * @param {string} uriStr
     */
    async function refreshEditor(uriStr) {
        const e = editors.get(uriStr);
        if (!e || !e.last || session.state !== 'online') return;
        const { occurrences, owner, instance } = await occurrencesFor(e.document, e.last);
        if (!editors.has(uriStr) || session.state !== 'online') return;
        e.owner = owner;
        const bound = inBoundProject(e.document.uri.fsPath);
        const blocked = !code || !code.showValues || !bound;
        let note = '';
        if (!code) note = 'Checking the code on the PLC…';
        else if (!code.showValues) note = code.name === 'differs' ? `The PLC runs ${session.info.projectName}: no values for this project.` : 'The PLC\'s project cannot be checked: no values.';
        else if (blocked) note = 'This file is not part of the project on the PLC.';
        else {
            if (owner && owner.kind === 'FUNCTION_BLOCK') note = instance ? `Instance: ${instance}` : `No instance of ${owner.name} on the PLC.`;
            if (code.state !== 'match') note = (note ? note + ' · ' : '') + (code.state === 'differs' ? 'Code differs: writes blocked' : 'Code not checked: writes blocked');
        }
        // `writable`: the webview offers Write Value… only in an editor of the project the PLC runs.
        post(uriStr, { type: 'online/state', online: true, note, writable: !!code && bound });
        await e.monitor.setOccurrences(occurrences, { blocked });
        // A Go Offline (or the panel closing) during that wait stopped the monitor: do not restart it.
        if (editors.get(uriStr) !== e || session.state !== 'online') return;
        e.monitor.start();
    }

    const refreshEditors = async () => { for (const uriStr of [...editors.keys()]) await refreshEditor(uriStr).catch(err => log(`Inline values: ${err && err.message}`)); };

    /** @param {string} uriStr @param {Object} msg */
    function post(uriStr, msg) {
        const panel = provider.activePanels && provider.activePanels.get(uriStr);
        if (panel) panel.webview.postMessage(msg);
    }

    /** Ends every editor's poll and clears its values. */
    function stopEditors() {
        for (const [uriStr, e] of editors) {
            e.monitor.stop();
            post(uriStr, { type: 'online/state', online: false, note: '' });
        }
    }

    /**
     * What sits at a pane position: the occurrence whose chain (impl) or declaration line (decl) holds it.
     * @param {any} document
     * @param {any} msg { componentId, pane, position, decl, impl, fileUri }
     */
    async function occurrenceAt(document, msg) {
        const ctx = assembleSt(document.getText(), msg);
        if (!ctx) return null;
        const line = msg.position.lineNumber;
        const ranges = paneRanges(ctx.lineMap, { componentId: msg.componentId,
            decl: msg.pane === 'decl' ? [{ start: line, end: line }] : null, impl: msg.pane === 'impl' ? [{ start: line, end: line }] : null });
        const { occurrences } = await occurrencesFor(document, msg, ranges);
        const col = msg.position.column;
        const onLine = occurrences.filter(o => o.pane === msg.pane && o.line === line);
        return onLine.find(o => col >= o.startColumn && col <= o.endColumn) || (msg.pane === 'decl' && onLine.length === 1 ? onLine[0] : null);
    }

    /** @type {import('../online/writeGuard').WriteDeps} */
    const writeDeps = {
        session, sessionWrites,
        allowWrites,
        projectState: writeProjectState,
        projectReason: () => (code ? code.reason : 'The code on the PLC has not been checked yet.'),
        hasUnsavedEdits: anyUnsaved,
        input: async (o) => vscode.window.showInputBox({ prompt: o.prompt, value: o.value, ignoreFocusOut: true,
            validateInput: (s) => o.validate(s) || undefined }),
        // The code check runs again after every dialog, so the guard that follows it sees the files as
        // they are now; it waits for the NEWEST check, not only its own (a newer one may supersede it).
        confirm: async (o) => {
            const ok = (await vscode.window.showWarningMessage(o.message, { modal: true, detail: o.detail }, o.button)) === o.button;
            refreshCodeCheck();
            await codeCheckSettled();
            return ok;
        },
        log
    };
    /** @returns {string|null} The key of the project the PLC runs, as the last code check found it. */
    const boundKey = () => (code && code.project ? code.project.key : null);
    /**
     * Runs one write. The project the PLC runs is pinned once the newest code check has settled: a
     * download of another project (same connection) before the write lands refuses it (writeGuard
     * re-checks `stillValid` with every guard, the last one included).
     * @param {import('../online/writeGuard').WriteRequest} req
     */
    async function runWrite(req) {
        refreshCodeCheck();
        await codeCheckSettled();
        const pinned = boundKey();
        const own = req.stillValid;
        req = { ...req, stillValid: () => (boundKey() !== pinned
            ? 'The PLC now runs another project than when this write started (a download). Start the write again.'
            : (own ? own() : null)) };
        const r = await performWrite(req, writeDeps);
        if (r.status === 'refused') {
            const actions = /tcToolkit\.online\.allowWrites/.test(r.message) ? ['Open Setting'] : [];
            const pick = await vscode.window.showWarningMessage(r.message, ...actions);
            if (pick === 'Open Setting') vscode.commands.executeCommand('workbench.action.openSettings', 'tcToolkit.online.allowWrites');
        } else if (r.status === 'failed') {
            vscode.window.showErrorMessage(r.message);
        } else if (r.status === 'written') {
            vscode.window.setStatusBarMessage(r.message, 4000);
        }
        renderStatus();
        return r;
    }

    provider.onlineSource = {
        /** @returns {boolean} */
        isOnline: () => session.state === 'online',
        /**
         * The webview reported what its panes show.
         * @param {string} uriStr @param {any} document @param {any} msg
         */
        visible: async (uriStr, document, msg) => {
            if (session.state !== 'online') return;
            let e = editors.get(uriStr);
            if (!e) {
                e = { document, last: null, owner: null, monitor: createInlineMonitor({
                    session, post: (m) => post(uriStr, m), timers: deps.timers,
                    intervalMs: () => clampInt(cfg().get('inlinePollInterval', 500), 100, 10000, 500),
                    onCapped: (n, max) => log(`Inline values: ${n} variables are visible; only the first ${max} are monitored.`)
                }) };
                editors.set(uriStr, e);
            }
            e.document = document;
            e.last = msg;
            await refreshEditor(uriStr).catch(err => log(`Inline values: ${err && err.message}`));
        },
        /** @param {string} uriStr @param {boolean} visible */
        panelVisible: (uriStr, visible) => { const e = editors.get(uriStr); if (e) e.monitor.setVisible(visible); },
        /** @param {string} uriStr */
        panelClosed: (uriStr) => { const e = editors.get(uriStr); if (e) { e.monitor.dispose(); editors.delete(uriStr); } },
        /** @param {string} uriStr @param {any} document @param {any} msg */
        write: async (uriStr, document, msg) => {
            const refuseClick = (/** @type {string} */ message) => {
                log(`Write refused: ${message}`);
                vscode.window.showWarningMessage(message);
                return { status: 'refused', message };
            };
            // A click delivered while not online (a Go Online still connecting, or already offline) is
            // refused: the editor's Write Value… belonged to a connection that is not the current one.
            if (session.state !== 'online') return refuseClick('Not online. Use "Go Online" first.');
            const fsPath = document.uri.fsPath;
            if (!inBoundProject(fsPath)) return refuseClick('This file is not part of the project the PLC runs: values cannot be written from it.');
            // The project this editor was checked against; re-checked with every guard of the write.
            const pinned = boundKey();
            const stillValid = () => (session.state === 'online' && boundKey() === pinned && inBoundProject(fsPath)
                ? null : 'This file is no longer part of the project the PLC runs (a download?): values cannot be written from it.');
            const occ = await occurrenceAt(document, msg);
            if (!occ) { vscode.window.showWarningMessage('No PLC variable at the cursor.'); return null; }
            const dirty = !!msg.dirty || document.isDirty;
            return runWrite({ path: occ.adsPath, reason: occ.path ? (occ.adsPath ? null : 'unsupported') : occ.reason,
                localType: occ.localType, source: 'editor', stillValid }).then(r => { if (dirty) log('(the editor reported unsaved edits)'); return r; });
        },
        /** @param {string} uriStr @param {any} document @param {any} msg */
        addWatch: async (uriStr, document, msg) => {
            const occ = await occurrenceAt(document, msg);
            if (!occ) { vscode.window.showWarningMessage('No PLC variable at the cursor.'); return false; }
            if (!occ.path) { vscode.window.showWarningMessage(REASON_TEXT[/** @type {keyof typeof REASON_TEXT} */ (occ.reason || 'unsupported')] || REASON_TEXT.unsupported); return false; }
            if (!occ.adsPath) {
                vscode.window.showWarningMessage(session.state === 'online'
                    ? 'This variable belongs to a function block with no instance on the PLC.'
                    : 'Go Online first: a function block\'s variables are watched through one of its instances on the PLC.');
                return false;
            }
            const added = await watch.add(occ.adsPath, occ.localType);
            if (added) vscode.commands.executeCommand('twincatWatch.focus').then(undefined, () => {});
            return added;
        }
    };

    // ── Go Online / Go Offline ───────────────────────────────────────────────────────────────────
    /**
     * Asks which target to go online to: the local runtime, a recent target, or one typed in.
     * @returns {Promise<{netId: string, port: number, label: string}|undefined>}
     */
    async function pickTarget() {
        const port = clampInt(cfg().get('adsPort', 851), 1, 65535, 851);
        const recent = /** @type {Array<{netId: string, port: number, label: string}>} */ (context.workspaceState.get(RECENT_TARGETS_KEY, []));
        const direct = String(cfg().get('connectionMode', 'router')) === 'direct';
        const items = [];
        if (!direct) items.push({ label: LOCAL_TARGET.label, description: `ADS port ${port}`, detail: 'The PLC runtime on this PC, through the local router', netId: 'localhost', port });
        for (const r of recent) {
            if (r.netId === 'localhost' && !direct) continue;
            items.push({ label: r.label || r.netId, description: `${r.netId}:${r.port}`, detail: 'Used before', netId: r.netId, port: r.port });
        }
        items.push({ label: 'Enter AMS Net ID…', description: '', detail: direct ? 'The PLC\'s AMS Net ID (direct mode)' : 'A target the local router has a route to (set up in XAE)', netId: '', port });
        const pick = /** @type {any} */ (await vscode.window.showQuickPick(items, { title: 'Go Online', placeHolder: direct ? 'Direct mode: pick the PLC' : 'Pick the target (routes are set up in XAE)' }));
        if (!pick) return undefined;
        if (pick.netId) return { netId: pick.netId, port: pick.port, label: pick.label === LOCAL_TARGET.label ? LOCAL_TARGET.label : pick.description };
        const typed = await vscode.window.showInputBox({
            title: 'Go Online', prompt: 'AMS Net ID, optionally with :port (for example 5.12.34.56.1.1:851)', ignoreFocusOut: true,
            validateInput: (s) => (parseTarget(s, port) ? undefined : 'Six numbers 0-255 separated by dots, optionally :port')
        });
        const t = typed === undefined ? null : parseTarget(typed, port);
        return t ? { ...t, label: `${t.netId}:${t.port}` } : undefined;
    }

    /** @param {any} [args] `{ netId, port }` skips the picker (for tests and keybindings). */
    async function goOnline(args) {
        const t = args && args.netId ? { netId: String(args.netId), port: Number(args.port) || clampInt(cfg().get('adsPort', 851), 1, 65535, 851),
            label: args.label || String(args.netId) } : await pickTarget();
        if (!t) return { status: 'cancelled' };
        const mode = String(cfg().get('connectionMode', 'router')) === 'direct' ? 'direct' : 'router';
        /** @type {import('../online/adsClient').ConnectOptions & {label: string}} */
        const options = mode === 'direct'
            ? { mode, targetAmsNetId: t.netId, targetAdsPort: t.port, label: t.label, routerAddress: String(cfg().get('direct.plcAddress', '') || ''),
                localAmsNetId: String(cfg().get('direct.localAmsNetId', '') || ''), localAdsPort: clampInt(cfg().get('direct.localAdsPort', 32750), 1, 65535, 32750) }
            : { mode, targetAmsNetId: t.netId, targetAdsPort: t.port, label: t.label, routerAddress: String(cfg().get('routerAddress', '127.0.0.1') || '127.0.0.1') };
        resetWrites();
        log(`Going online: ${t.label} (${t.netId}:${t.port}, ${mode === 'direct' ? `direct to ${options.routerAddress}` : `router at ${options.routerAddress}`}).`);
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Going online: ${t.label}`, cancellable: true },
                (_progress, token) => session.connect(options, token));
        } catch (err) {
            const f = describeConnectError(err, options);
            log(`Go Online failed (${f.kind}): ${f.raw}`);
            if (f.kind === 'cancelled') return { status: 'cancelled' };
            const pick = await vscode.window.showErrorMessage(`${f.message}${f.hint ? ' ' + f.hint : ''}`, 'Show Log');
            if (pick === 'Show Log') channel.show(true);
            return { status: 'failed', failure: f };
        }
        const recent = /** @type {Array<any>} */ (context.workspaceState.get(RECENT_TARGETS_KEY, [])).filter(r => !(r.netId === t.netId && r.port === t.port));
        await context.workspaceState.update(RECENT_TARGETS_KEY, [{ netId: t.netId, port: t.port, label: t.label }, ...recent].slice(0, 5));
        await refreshCodeCheck();
        if (code && code.state !== 'match') {
            const msg = `Online. ${code.reason}${code.showValues ? '' : ' No inline values.'} Writes are blocked.`;
            vscode.window.showWarningMessage(msg);
        }
        return { status: 'online' };
    }

    async function goOffline() {
        await session.disconnect();
        return { status: 'offline' };
    }

    let lastProjectName = /** @type {string|null} */ (null);
    session.onDidChange(async (what) => {
        if (what === 'state') {
            vscode.commands.executeCommand('setContext', 'twincat.online', session.state === 'online');
            vscode.commands.executeCommand('setContext', 'twincat.onlineConnecting', session.state === 'connecting');
            if (session.state === 'offline') {
                code = null;
                codeRun++;
                lastProjectName = null;
                resetWrites();
                instances.clear();
                instanceNoted.clear();
                stopEditors();
            }
            if (provider.broadcastOnlineState) provider.broadcastOnlineState(session.state === 'online');
        }
        if (what === 'symbols') { instances.clear(); await refreshCodeCheck(); await refreshEditors(); }
        if (what === 'info' && session.state === 'online' && session.info.projectName !== lastProjectName) {
            // A new project name (first read, a download of another project): check the code again.
            lastProjectName = session.info.projectName;
            await refreshCodeCheck();
        }
        if (tree) tree.refresh();
        renderStatus();
    });

    // ── Commands ─────────────────────────────────────────────────────────────────────────────────
    context.subscriptions.push(
        status, channel,
        vscode.commands.registerCommand('twincat.goOnline', goOnline),
        vscode.commands.registerCommand('twincat.goOffline', goOffline),
        vscode.commands.registerCommand('twincat.online.showLog', () => channel.show(true)),
        vscode.commands.registerCommand('twincat.online.enableWrites', async () => {
            if (session.state !== 'online') { vscode.window.showWarningMessage('Not online. Use "Go Online" first.'); return false; }
            if (!allowWrites()) {
                const pick = await vscode.window.showWarningMessage('Writing values is off. Turn on the setting tcToolkit.online.allowWrites to allow it.', 'Open Setting');
                if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'tcToolkit.online.allowWrites');
                return false;
            }
            const id = session.identity;
            if (!id) return false;
            const ok = await writeDeps.confirm({ message: `Enable writes to ${targetName(id)} for this online session?`,
                detail: 'Each write still asks for confirmation. Writes turn off again when you go offline.', button: 'Enable writes' });
            // Only for the connection the user was asked about: a Go Online elsewhere meanwhile enables nothing.
            const enabled = ok && sameIdentity(id, session.identity);
            if (enabled) { enableWritesFor(sessionWrites, id); log(`Writes enabled for this online session (${targetName(id)}).`); }
            renderStatus();
            return enabled;
        }),
        vscode.commands.registerCommand('twincat.online.selectInstance', async (args) => {
            if (session.state !== 'online') { vscode.window.showWarningMessage('Not online. Use "Go Online" first.'); return undefined; }
            const owners = [...editors.values()].map(e => e.owner).filter(o => o && o.kind === 'FUNCTION_BLOCK');
            const owner = (args && args.fbName && owners.find(o => o.name.toLowerCase() === String(args.fbName).toLowerCase())) || owners[0];
            if (!owner) { vscode.window.showInformationMessage('Open a function block in the editor first.'); return undefined; }
            const found = await session.findInstances([owner.name, ...(owner.derived || [])]);
            if (!found.length) { vscode.window.showWarningMessage(`${owner.name} has no instance on the PLC.`); return undefined; }
            const pick = /** @type {any} */ (await vscode.window.showQuickPick(found.map(f => ({ label: f.path, description: f.type })),
                { title: `Instance of ${owner.name} for online values` }));
            if (!pick) return undefined;
            instances.set(owner.name.toLowerCase(), pick.label);
            log(`Online values of ${owner.name}: ${pick.label}.`);
            await refreshEditors();
            return pick.label;
        }),
        vscode.commands.registerCommand('twincat.online.statusMenu', async () => {
            const items = [
                { label: '$(debug-disconnect) Go Offline', id: 'twincat.goOffline' },
                { label: '$(pencil) Enable Writes for This Online Session', id: 'twincat.online.enableWrites' },
                { label: '$(symbol-class) Select FB Instance for Online Values…', id: 'twincat.online.selectInstance' },
                { label: '$(output) Show Online Log', id: 'twincat.online.showLog' }
            ];
            const pick = /** @type {any} */ (await vscode.window.showQuickPick(items, { title: 'Online' }));
            if (pick) vscode.commands.executeCommand(pick.id);
        }),
        vscode.commands.registerCommand('twincat.watch.add', async (args) => {
            const p = args && args.path ? String(args.path) : await vscode.window.showInputBox({ title: 'Add to PLC Watch',
                prompt: 'ADS symbol path, for example MAIN.fbStation.nState or GVL_Io.bStart', ignoreFocusOut: true });
            if (!p) return false;
            return watch.add(p, null);
        }),
        vscode.commands.registerCommand('twincat.watch.remove', async (item) => (item && item.path ? watch.remove(item.path) : false)),
        vscode.commands.registerCommand('twincat.watch.clear', async () => { await watch.clear(); return true; }),
        vscode.commands.registerCommand('twincat.watch.copyPath', async (item) => {
            if (item && item.path) await vscode.env.clipboard.writeText(item.path);
        }),
        vscode.commands.registerCommand('twincat.watch.write', async (item) => {
            if (!item || !item.path) return null;
            const entry = watch.entry(item.path);
            return runWrite({ path: item.path, localType: entry ? entry.localType : null, source: 'watch' });
        }),
        // A saved source file or a new .tmc (an XAE build) can change the code check's outcome.
        vscode.workspace.onDidSaveTextDocument
            ? vscode.workspace.onDidSaveTextDocument((d) => { if (/\.Tc(POU|GVL|DUT|IO)$/i.test(d.uri.fsPath || '')) refreshCodeCheck(); })
            : { dispose() {} },
        ...(vscode.workspace.createFileSystemWatcher ? [(() => {
            const w = vscode.workspace.createFileSystemWatcher('**/*.tmc');
            const again = () => { refreshCodeCheck(); };
            w.onDidChange(again); w.onDidCreate(again); w.onDidDelete(again);
            return w;
        })()] : []),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration(SECTION)) return;
            renderStatus();
            // A raised notification limit gives the capped watch entries their slots.
            if (e.affectsConfiguration(`${SECTION}.maxNotifications`)) watch.retryCapped().catch(() => {});
        })
    );

    /** Closes everything: called on deactivation. */
    async function dispose() {
        for (const e of editors.values()) e.monitor.dispose();
        editors.clear();
        await watch.dispose();
        await session.disconnect();
    }
    vscode.commands.executeCommand('setContext', 'twincat.online', false);
    return { session, watch, dispose, refreshEditors, refreshCodeCheck, codeCheck: () => code };
}

/**
 * An AMS Net ID with an optional `:port`.
 * @param {string} s
 * @param {number} defaultPort
 * @returns {{netId: string, port: number}|null}
 */
function parseTarget(s, defaultPort) {
    const m = /^\s*([0-9.]+)\s*(?::\s*(\d{1,5}))?\s*$/.exec(String(s || ''));
    if (!m || !isValidNetId(m[1])) return null;
    const port = m[2] ? Number(m[2]) : defaultPort;
    if (port < 1 || port > 65535) return null;
    return { netId: m[1], port };
}

/**
 * A setting as an integer within bounds.
 * @param {unknown} v @param {number} min @param {number} max @param {number} fallback
 * @returns {number}
 */
function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = { registerOnlineCommands, parseTarget, OUTPUT_CHANNEL_NAME, WATCH_KEY };
