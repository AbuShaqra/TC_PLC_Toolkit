/**
 * @file watchList.js
 * @description Online monitoring (R15): the model behind the "PLC Watch" view. A list of ADS paths
 * the user chose (from the editor, or typed), kept across sessions through injected `load`/`save`
 * (workspaceState in the extension); while online each entry is one on-change ADS notification at
 * `cycleMs` (200 ms by default, D8). Struct, FB and array members are shown from the decoded value of
 * their entry, so expanding a node costs no further notifications.
 *
 * The notification cap (`session.subscribe` refuses past `tcToolkit.online.maxNotifications`) shows
 * here as entries in the `capped` state and one `onCapped` call per online session. A capped entry is
 * tried again, in list order, whenever a slot may have freed: an entry removed, or the limit raised
 * (`retryCapped`, which the command layer calls on a settings change). vscode-free; the tree provider
 * (src/online/watchTree.js) only renders `list()`.
 *
 * Every subscribe in flight owns its slot by a token: when it resolves and the slot is no longer its
 * own (the entry was removed, or removed and added again, or the epoch moved on), it unsubscribes
 * what it got instead of storing it, so no notification is ever held without an owner. A slot that
 * already holds a handle (an Add during Go Online's status phase, then the 'state' event's attachAll;
 * two quick symbol drops) has that handle released before it is taken over, never overwritten.
 */

'use strict';

const { formatValue } = require('./values');

/**
 * @typedef {Object} WatchEntry
 * @property {string} path
 * @property {string|null} localType The declared type when the entry came from the editor.
 */

/**
 * @typedef {Object} WatchRow
 * @property {string} path
 * @property {'offline'|'pending'|'ok'|'missing'|'capped'} state
 * @property {any} value
 * @property {string} text Formatted value, or a state word.
 * @property {string} type The online type, when known.
 * @property {Object|null} dataType
 */

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('./session').createOnlineSession>} deps.session
 * @param {() => Array<WatchEntry>} deps.load
 * @param {(entries: Array<WatchEntry>) => void} deps.save
 * @param {() => number} [deps.cycleMs]
 * @param {() => void} [deps.onChange]
 * @param {(max: number) => void} [deps.onCapped]
 */
function createWatchList(deps) {
    /** @type {Array<WatchEntry>} */
    let entries = (deps.load() || []).filter(e => e && typeof e.path === 'string');
    /** @type {Map<string, {state: WatchRow['state'], token?: object, value?: any, type?: string, dataType?: Object|null, handle?: {unsubscribe: () => Promise<void>}}>} */
    const live = new Map();
    let cappedNoticeShown = false;
    let epoch = 0;
    const changed = () => { if (deps.onChange) deps.onChange(); };
    const key = (/** @type {string} */ p) => p.toLowerCase();

    /**
     * Subscribes one entry (online only).
     * @param {WatchEntry} entry
     * @param {number} mine The epoch the call belongs to.
     */
    async function attach(entry, mine) {
        const k = key(entry.path);
        const token = {};
        const prev = live.get(k);
        live.set(k, { state: 'pending', token });
        changed();
        // The slot is taken over: release the notification it held first (it would have no owner).
        if (prev && prev.handle) await prev.handle.unsubscribe().catch(() => {});
        if (live.get(k) === undefined || /** @type {any} */ (live.get(k)).token !== token) return;
        const res = await deps.session.subscribe(entry.path, (deps.cycleMs && deps.cycleMs()) || 200, (value) => {
            const cur = live.get(k);
            if (!cur || cur.token !== token || mine !== epoch) return;
            cur.state = 'ok';
            cur.value = value;
            changed();
        });
        const slot = live.get(k);
        if (mine !== epoch || !slot || slot.token !== token || !entries.some(e => key(e.path) === k)) {
            // The slot is no longer this call's: removed, re-added (a newer call owns it), or detached.
            if (res.ok) await res.handle.unsubscribe().catch(() => {});
            return;
        }
        if (res.ok) {
            // A value may already have arrived (state 'ok'); keep it.
            live.set(k, { ...slot, state: slot.state === 'ok' ? 'ok' : 'pending', handle: res.handle,
                type: /** @type {any} */ (res.resolved.symbol).type, dataType: res.resolved.dataType });
        } else if (/** @type {any} */ (res).capped) {
            live.set(k, { state: 'capped' });
            if (!cappedNoticeShown && deps.onCapped) {
                cappedNoticeShown = true;
                deps.onCapped(/** @type {number} */ (deps.session.subscriptionCount));
            }
        } else {
            live.set(k, { state: 'missing' });
        }
        changed();
    }

    /** Subscribes every entry, in order (so the cap keeps the first ones). */
    async function attachAll() {
        const mine = ++epoch;
        for (const e of entries.slice()) {
            if (mine !== epoch) return;
            await attach(e, mine);
        }
    }

    /**
     * Subscribes the entries the cap refused, in list order, now that a slot may be free. Stops at the
     * first one still refused, so the order of the list decides who gets a slot.
     */
    async function retryCapped() {
        if (deps.session.state !== 'online') return;
        const mine = epoch;
        for (const e of entries.slice()) {
            if (mine !== epoch) return;
            const cur = live.get(key(e.path));
            if (!cur || cur.state !== 'capped') continue;
            await attach(e, mine);
            const after = live.get(key(e.path));
            if (after && after.state === 'capped') return;
        }
    }

    /** Drops every subscription (the session is going offline, or symbols changed). */
    async function detachAll() {
        epoch++;
        const handles = [...live.values()].map(v => v.handle).filter(Boolean);
        live.clear();
        cappedNoticeShown = false;
        changed();
        await Promise.all(handles.map(h => /** @type {any} */ (h).unsubscribe().catch(() => {})));
    }

    const sub = deps.session.onDidChange(async (what) => {
        if (what === 'state') {
            if (deps.session.state === 'online') await attachAll();
            else if (deps.session.state === 'offline') await detachAll();
        } else if (what === 'symbols' && deps.session.state === 'online') {
            await detachAll();
            await attachAll();
        }
    });

    return {
        /**
         * Adds a path (no duplicates, case-insensitively, as ADS paths are).
         * @param {string} path
         * @param {string|null} [localType]
         * @returns {Promise<boolean>} false when it was already there.
         */
        async add(path, localType) {
            const p = String(path || '').trim();
            if (!p || entries.some(e => key(e.path) === key(p))) return false;
            entries.push({ path: p, localType: localType || null });
            deps.save(entries.slice());
            changed();
            if (deps.session.state === 'online') await attach(entries[entries.length - 1], epoch);
            return true;
        },
        /** @param {string} path */
        async remove(path) {
            const k = key(path);
            const before = entries.length;
            entries = entries.filter(e => key(e.path) !== k);
            if (entries.length === before) return false;
            deps.save(entries.slice());
            const cur = live.get(k);
            live.delete(k);
            changed();
            if (cur && cur.handle) await cur.handle.unsubscribe().catch(() => {});
            await retryCapped();
            return true;
        },
        retryCapped,
        async clear() {
            entries = [];
            deps.save([]);
            await detachAll();
        },
        /** @returns {Array<WatchRow>} */
        list() {
            const online = deps.session.state === 'online';
            return entries.map(e => {
                const cur = live.get(key(e.path));
                /** @type {WatchRow['state']} */
                const state = !online ? 'offline' : (cur ? cur.state : 'pending');
                const text = state === 'ok' ? formatValue(cur && cur.value, cur && cur.dataType)
                    : ({ offline: 'offline', pending: '…', missing: 'not on the PLC', capped: 'notification limit reached' })[state];
                return { path: e.path, state, value: cur ? cur.value : undefined, text: /** @type {string} */ (text),
                    type: (cur && cur.type) || e.localType || '', dataType: (cur && cur.dataType) || null };
            });
        },
        /** @param {string} path @returns {WatchEntry|undefined} */
        entry(path) { return entries.find(e => key(e.path) === key(path)); },
        get size() { return entries.length; },
        dispose() { sub.dispose(); return detachAll(); }
    };
}

/**
 * The children of a decoded struct/FB/array value, as rows for the tree.
 * @param {string} path The parent's path.
 * @param {any} value The parent's decoded value.
 * @param {any} dataType The parent's data type (members' types come from its subItems).
 * @returns {Array<{path: string, label: string, value: any, text: string, type: string, dataType: any, expandable: boolean}>}
 */
function childRows(path, value, dataType) {
    if (value === null || value === undefined || typeof value !== 'object' || value instanceof Date) return [];
    if (value && 'name' in value && 'value' in value && Object.keys(value).length === 2) return []; // an enum
    const subs = (dataType && Array.isArray(dataType.subItems)) ? dataType.subItems : [];
    const isArr = Array.isArray(value);
    const start = isArr && dataType && dataType.arrayInfos && dataType.arrayInfos[0] ? dataType.arrayInfos[0].startIndex : 0;
    const elemType = isArr && dataType ? { ...dataType, arrayInfos: dataType.arrayInfos.slice(1), arrayDimension: Math.max(0, (dataType.arrayDimension || 1) - 1) } : null;
    const keys = isArr ? value.map((/** @type {any} */ _, /** @type {number} */ i) => i) : Object.keys(value);
    return keys.map((/** @type {any} */ k) => {
        const v = value[k];
        const sub = isArr ? elemType : subs.find((/** @type {any} */ s) => s.name === k) || null;
        const label = isArr ? `[${start + k}]` : String(k);
        const childPath = isArr ? `${path}[${start + k}]` : `${path}.${k}`;
        const expandable = v !== null && typeof v === 'object' && !(v instanceof Date)
            && !('name' in v && 'value' in v && Object.keys(v).length === 2);
        return { path: childPath, label, value: v, text: expandable ? (Array.isArray(v) ? `[${v.length}]` : '') : formatValue(v, sub),
            type: sub ? String(sub.type || sub.name || '') : '', dataType: sub, expandable };
    });
}

module.exports = { createWatchList, childRows };
