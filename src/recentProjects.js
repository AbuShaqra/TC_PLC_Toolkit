/**
 * @file recentProjects.js
 * @description The start page's list of recently opened or created TwinCAT solutions: most recent
 * first, at most ten, one entry per solution, entries whose `.sln` is gone pruned on read.
 *
 * Pure list logic (no `vscode`, no `fs` — existence is passed in), so it is unit-testable; the
 * extension keeps the list in `globalState` under `RECENTS_KEY` through the small adapter at the end.
 */

'use strict';

const path = require('path');

/** `globalState` key. Global, not per workspace: the list exists to get from one project to another. */
const RECENTS_KEY = 'twincat.recentSolutions';

/** Most entries kept. */
const MAX_RECENTS = 10;

/**
 * @typedef {Object} RecentSolution
 * @property {string} slnPath Absolute path of the `.sln`.
 * @property {string} name The solution's name (its file name without `.sln`).
 * @property {number} at When it was last opened or created (ms since epoch).
 */

/**
 * Identity of a path for de-duplication. Windows paths are case-insensitive and may use either
 * separator; comparing them raw would list the same solution twice.
 * @param {string} p
 * @returns {string}
 */
function pathKey(p) {
    const n = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:\//.test(n) || process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * Keeps only well-formed entries (globalState is user-writable storage; never trust its shape).
 * @param {unknown} list
 * @returns {RecentSolution[]}
 */
function sanitize(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(e => e && typeof e.slnPath === 'string' && e.slnPath && /\.sln$/i.test(e.slnPath))
        .map(e => ({
            slnPath: e.slnPath,
            name: typeof e.name === 'string' && e.name ? e.name : path.basename(e.slnPath).replace(/\.sln$/i, ''),
            at: typeof e.at === 'number' ? e.at : 0
        }));
}

/**
 * Adds (or moves to the top) one solution.
 * @param {unknown} list Current list.
 * @param {string} slnPath
 * @param {number} [now]
 * @returns {RecentSolution[]} A new list, most recent first, at most MAX_RECENTS long.
 */
function addRecent(list, slnPath, now = Date.now()) {
    const key = pathKey(slnPath);
    const entry = { slnPath, name: path.basename(slnPath).replace(/\.sln$/i, ''), at: now };
    return [entry, ...sanitize(list).filter(e => pathKey(e.slnPath) !== key)].slice(0, MAX_RECENTS);
}

/**
 * Removes one solution.
 * @param {unknown} list
 * @param {string} slnPath
 * @returns {RecentSolution[]}
 */
function removeRecent(list, slnPath) {
    const key = pathKey(slnPath);
    return sanitize(list).filter(e => pathKey(e.slnPath) !== key);
}

/**
 * Drops entries whose `.sln` no longer exists, de-duplicates, and caps the length.
 * @param {unknown} list
 * @param {(p: string) => boolean} exists
 * @returns {RecentSolution[]}
 */
function pruneRecents(list, exists) {
    const seen = new Set();
    const out = [];
    for (const e of sanitize(list)) {
        const key = pathKey(e.slnPath);
        if (seen.has(key) || !exists(e.slnPath)) continue;
        seen.add(key);
        out.push(e);
    }
    return out.slice(0, MAX_RECENTS);
}

/**
 * Adapter over a `vscode.Memento` (`context.globalState`).
 * @param {{get: (key: string, fallback?: any) => any, update: (key: string, value: any) => Thenable<void>}} memento
 * @param {(p: string) => boolean} exists
 */
function createRecentStore(memento, exists) {
    return {
        /** @returns {RecentSolution[]} The pruned list; writes the pruned form back when it shrank. */
        list() {
            const raw = memento.get(RECENTS_KEY, []);
            const pruned = pruneRecents(raw, exists);
            if (!Array.isArray(raw) || pruned.length !== raw.length) memento.update(RECENTS_KEY, pruned);
            return pruned;
        },
        /** @param {string} slnPath */
        add(slnPath) {
            return memento.update(RECENTS_KEY, addRecent(memento.get(RECENTS_KEY, []), slnPath));
        },
        /** @param {string} slnPath */
        remove(slnPath) {
            return memento.update(RECENTS_KEY, removeRecent(memento.get(RECENTS_KEY, []), slnPath));
        }
    };
}

module.exports = { RECENTS_KEY, MAX_RECENTS, addRecent, removeRecent, pruneRecents, createRecentStore, pathKey };
