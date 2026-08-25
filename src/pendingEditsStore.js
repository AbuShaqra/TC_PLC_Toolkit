/**
 * @file pendingEditsStore.js
 * @description Persistence for Manual Sync's unsaved edits — the URI-keyed pending-edit records
 * the webview posts with `updatePendingEdits`, kept somewhere that survives a window reload.
 *
 * In Manual Sync mode the webview never posts `edit`, so the `TextDocument` is never touched and
 * stays CLEAN: VS Code's hot-exit backup never engages, and `retainContextWhenHidden` only covers
 * hide/show. While the host held these records in an in-memory `Map`, a Ctrl+R restarted the
 * extension host and every unsaved Manual-Sync edit was silently lost. They live in
 * `context.workspaceState` instead — per workspace, NOT global: the records are keyed by document
 * URI and mean nothing outside the workspace that holds those files.
 *
 * **Staleness is the risk persistence introduces.** An in-memory map could not outlive the file it
 * described; a persisted one can, and restoring an edit onto a document that changed on disk in
 * the meantime would splice text into the wrong CDATA block. So every entry carries a fingerprint
 * of the document text it was captured against, and a read whose fingerprint does not match
 * discards the entry instead of returning it.
 *
 * The fingerprint is `text.length + ':' + sha1(text)`: `crypto`'s SHA-1 is sub-millisecond on
 * files this size (TwinCAT objects are tens of KB), which matters because `updatePendingEdits`
 * fires on every content change. It is a change detector, not a security boundary — the length
 * prefix is there so that a length change alone decides without trusting the digest.
 *
 * Deliberately vscode-free: the only thing it needs is a `Memento`-shaped object (a synchronous
 * `get(key, default)` and a promise-returning `update(key, value)`), which is what makes
 * `test/test_pending_edits_persistence.js` able to run it under plain Node.
 */

const crypto = require('crypto');

/** The single `workspaceState` key holding every URI's entry. */
const STORAGE_KEY = 'twincat.pendingEdits';

/**
 * @typedef {Object} PendingEditsEntry
 * @property {string} fingerprint Fingerprint of the document text the edits were captured against.
 * @property {Object} edits The webview's `snapshot()` object: `componentId_blockType` ->
 *   `{context, blockType, content}`.
 */

/**
 * Fingerprints a document's text.
 * @param {string} text The document text.
 * @returns {string} `<length>:<sha1 hex>`.
 */
function fingerprintOf(text) {
    const str = typeof text === 'string' ? text : '';
    return `${str.length}:${crypto.createHash('sha1').update(str, 'utf8').digest('hex')}`;
}

/**
 * Creates the persisted pending-edit store over a `Memento`.
 * @param {Object} memento Anything with `get(key, defaultValue)` and `update(key, value)` —
 *   in production `context.workspaceState`.
 * @returns {Object} The store: `get(uriStr, docText)`, `set(uriStr, edits, docText)`,
 *   `delete(uriStr)`.
 */
function createPendingEditsStore(memento) {
    /**
     * Reads the whole stored map. Always returns an object, never the stored reference's contents
     * mutated in place — writers below build a fresh object so a Memento implementation that hands
     * back its own value cannot be edited behind its back.
     * @returns {Object} URI string -> PendingEditsEntry.
     */
    function readAll() {
        const all = memento.get(STORAGE_KEY, {});
        return (all && typeof all === 'object') ? all : {};
    }

    /**
     * Writes the map back, removing the key outright once nothing is pending (VS Code's documented
     * way to drop a Memento value).
     * @param {Object} next URI string -> PendingEditsEntry.
     * @returns {Promise<*>} The Memento update promise.
     */
    function writeAll(next) {
        return Promise.resolve(
            memento.update(STORAGE_KEY, Object.keys(next).length === 0 ? undefined : next));
    }

    /**
     * Removes one URI's entry.
     * @param {string} uriStr Document URI string.
     * @returns {Promise<*>} The Memento update promise (already resolved if there was nothing).
     */
    function remove(uriStr) {
        const all = readAll();
        if (!Object.prototype.hasOwnProperty.call(all, uriStr)) return Promise.resolve();
        const next = {};
        for (const key of Object.keys(all)) {
            if (key !== uriStr) next[key] = all[key];
        }
        return writeAll(next);
    }

    return {
        /**
         * The edits cached for a document, or `{}` if there are none or they are stale.
         *
         * Synchronous on purpose: the `init` message the webview waits for is assembled inline, so
         * there is no point at which an await could be threaded through. A stale entry is cleared
         * fire-and-forget for the same reason — the return value does not depend on the write.
         * @param {string} uriStr Document URI string.
         * @param {string} docText The document's CURRENT text, to check the entry against.
         * @returns {Object} The webview's cached-edits object, or `{}`.
         */
        get(uriStr, docText) {
            const entry = readAll()[uriStr];
            if (!entry || !entry.edits) return {};
            if (entry.fingerprint !== fingerprintOf(docText)) {
                // The file changed underneath the edits (edited elsewhere, reverted, pulled). They
                // no longer describe this document, so drop them rather than splice them in.
                Promise.resolve(remove(uriStr)).catch(() => { /* best effort */ });
                return {};
            }
            return entry.edits;
        },

        /**
         * Stores a document's pending edits, fingerprinted against its current text. An empty edits
         * object is a delete — nothing pending is the absence of an entry, not an empty one.
         * @param {string} uriStr Document URI string.
         * @param {Object} edits The webview's `snapshot()` object.
         * @param {string} docText The document text the edits were captured against.
         * @returns {Promise<*>} The Memento update promise.
         */
        set(uriStr, edits, docText) {
            if (!edits || typeof edits !== 'object' || Object.keys(edits).length === 0) {
                return remove(uriStr);
            }
            const all = readAll();
            const next = {};
            for (const key of Object.keys(all)) next[key] = all[key];
            next[uriStr] = { fingerprint: fingerprintOf(docText), edits: edits };
            return writeAll(next);
        },

        /**
         * Forgets a document's pending edits — called once they have been folded into the document
         * ('sync-pending' / 'save'), at which point the document itself carries them.
         * @param {string} uriStr Document URI string.
         * @returns {Promise<*>} The Memento update promise.
         */
        delete(uriStr) {
            return remove(uriStr);
        }
    };
}

module.exports = { createPendingEditsStore, fingerprintOf, STORAGE_KEY };
