/**
 * @file inlineMonitor.js
 * @description Online monitoring (R15): the live values of ONE editor's visible variables. The host
 * hands it the pane occurrences (src/online/editorPaths.js, instance already filled in); it checks
 * every distinct path against the PLC (`session.resolve`), keeps the scalars whose online type agrees
 * with the declaration, and polls them with sum reads every `intervalMs` (500 ms by default, D8),
 * posting `online/values` to the webview only when something changed.
 *
 *   - Polled, not subscribed: inline values change with every scroll, and ADS notifications are a
 *     scarce per-device resource (550 recommended maximum) that the Watch view needs.
 *   - A path whose online type differs from the declared one is shown as "differs", never with a
 *     value (the code-mismatch guard per symbol).
 *   - Paused while the editor is hidden; a hidden webview cannot take messages anyway.
 *   - At most `maxPaths` distinct paths per editor; past that the rest are left out and `onCapped`
 *     says so once per set.
 */

'use strict';

const { inlineText, typesMatch } = require('./values');

/**
 * @typedef {Object} InlineItem
 * @property {string} componentId
 * @property {'decl'|'impl'} pane
 * @property {number} line
 * @property {number} startColumn
 * @property {number} endColumn
 * @property {boolean} eol
 * @property {string} text The value text (or "differs").
 * @property {'ok'|'differs'|'stopped'|'stale'} state
 * @property {string} path
 */

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('./session').createOnlineSession>} deps.session
 * @param {(msg: Object) => void} deps.post Sends a message to the webview.
 * @param {() => number} [deps.intervalMs]
 * @param {number} [deps.maxPaths]
 * @param {(count: number, max: number) => void} [deps.onCapped]
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers]
 */
function createInlineMonitor(deps) {
    const timers = deps.timers || { setTimeout, clearTimeout };
    const maxPaths = deps.maxPaths || 200;
    const intervalMs = () => Math.max(20, (deps.intervalMs && deps.intervalMs()) || 500);
    /** @type {Array<{occ: import('./editorPaths').PaneOccurrence & {adsPath: string}, resolved: import('./session').Resolved, differs: boolean}>} */
    let entries = [];
    let generation = 0;
    let visible = true;
    let running = false;
    let disposed = false;
    /** @type {any} */
    let timer = null;
    let lastPosted = '';
    let blocked = false;

    /**
     * Replaces what is monitored. Occurrences without a path are ignored.
     * @param {Array<import('./editorPaths').PaneOccurrence & {adsPath: string|null}>} occurrences
     * @param {{blocked?: boolean}} [o] `blocked`: the project differs; show nothing.
     * @returns {Promise<void>} Resolves when the paths are checked against the PLC.
     */
    async function setOccurrences(occurrences, o = {}) {
        const mine = ++generation;
        blocked = !!o.blocked;
        const withPath = blocked ? [] : (occurrences || []).filter(x => x.adsPath);
        const distinct = [...new Set(withPath.map(x => /** @type {string} */ (x.adsPath).toLowerCase()))];
        let keep = withPath;
        if (distinct.length > maxPaths) {
            const allowed = new Set(distinct.slice(0, maxPaths));
            keep = withPath.filter(x => allowed.has(/** @type {string} */ (x.adsPath).toLowerCase()));
            if (deps.onCapped) deps.onCapped(distinct.length, maxPaths);
        }
        const next = [];
        for (const occ of keep) {
            const resolved = await deps.session.resolve(/** @type {string} */ (occ.adsPath));
            if (mine !== generation || disposed) return;
            if (!resolved.ok || !resolved.scalar) continue;
            const differs = typesMatch(occ.localType, /** @type {any} */ (resolved.symbol).type) === false;
            next.push({ occ: /** @type {any} */ (occ), resolved, differs });
        }
        entries = next;
        await tick();
    }

    /** One poll: read, format, post when changed. */
    async function tick() {
        if (disposed || !visible) return;
        if (deps.session.state !== 'online') { postItems([]); return; }
        const mine = generation;
        const readable = entries.filter(e => !e.differs);
        const unique = [...new Map(readable.map(e => [e.resolved.path.toLowerCase(), e.resolved])).values()];
        let values;
        try { values = await deps.session.readMany(unique); } catch (e) { values = new Map(); }
        if (mine !== generation || disposed) return;
        const info = deps.session.info;
        /** @type {'ok'|'stale'|'stopped'} */
        const tone = info.lost ? 'stale' : (info.plcState && info.plcState !== 'Run' ? 'stopped' : 'ok');
        /** @type {Array<InlineItem>} */
        const items = [];
        for (const e of entries) {
            const base = { componentId: e.occ.componentId, pane: e.occ.pane, line: e.occ.line, startColumn: e.occ.startColumn,
                endColumn: e.occ.endColumn, eol: e.occ.eol, path: e.resolved.path };
            if (e.differs) { items.push({ ...base, text: 'type differs', state: 'differs' }); continue; }
            const v = values.get(e.resolved.path);
            if (!v || !v.ok) continue;
            items.push({ ...base, text: inlineText(v.value, e.resolved.dataType), state: tone });
        }
        postItems(items);
    }

    /** @param {Array<InlineItem>} items */
    function postItems(items) {
        const key = JSON.stringify(items);
        if (key === lastPosted) return;
        lastPosted = key;
        deps.post({ type: 'online/values', items });
    }

    function schedule() {
        if (!running || disposed) return;
        timer = timers.setTimeout(async () => {
            timer = null;
            try { await tick(); } catch (e) { /* the next tick tries again */ }
            schedule();
        }, intervalMs());
    }

    return {
        setOccurrences,
        tick,
        /** Starts polling. */
        start() { if (running || disposed) return; running = true; schedule(); },
        /** Stops polling and clears the values in the webview. */
        stop() {
            running = false;
            if (timer) { timers.clearTimeout(timer); timer = null; }
            entries = [];
            generation++;
            postItems([]);
        },
        /** @param {boolean} v Whether the editor is visible; a hidden one is not polled. */
        setVisible(v) { visible = v; if (v) tick().catch(() => {}); },
        dispose() {
            disposed = true;
            running = false;
            if (timer) { timers.clearTimeout(timer); timer = null; }
        },
        /** Entries for the write/watch commands: what sits at a pane position. */
        entries: () => entries,
        get running() { return running; },
        get blocked() { return blocked; }
    };
}

module.exports = { createInlineMonitor };
