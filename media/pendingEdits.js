/**
 * @file media/pendingEdits.js
 * @description The pending-edit state machine (Manual Sync's keyed map of not-yet-flushed edits,
 * the status text derived from its size, the init-time restore of cached edits onto the loaded
 * components, and the fold both extension-host consumers of the record shape share) — pulled out
 * of `media/editor.js` and `src/customEditorProvider.js` so it can run under a plain Node
 * harness. Today this logic was verified only by hand in the running webview.
 *
 * Lives in `media/` because the webview loads it with a plain `<script>` tag, but it is written to
 * `require()` cleanly too (see the shim at the bottom) so `test/test_pending_edits.js` can
 * exercise the exact code both sides run. There is no build step in this project, so one file
 * that works both ways is the only way to avoid two copies of this state machine drifting apart.
 *
 * The global here is named `pendingEditsCore`, not `pendingEdits` — `media/editor.js` keeps a
 * local variable named `pendingEdits` today (the keyed map itself) and this module REPLACES it
 * with a store instance the webview names `editsStore`; naming the module the same as the old
 * local would collide.
 */

// Dual-mode shim: `module.exports` under Node, a `pendingEditsCore` global in the webview. The
// cast is for the type-check gate, which reads this file as a module and would otherwise reject
// assigning a new property to `Window` — the branch Node never takes.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.pendingEditsCore = factory();
}(typeof self !== 'undefined' ? /** @type {*} */ (self) : this, function () {
    'use strict';

    /**
     * Creates a pending-edit store: the keyed map of not-yet-flushed edits (Manual Sync mode),
     * today's `pendingEdits` variable (editor.js:35), wrapped so the map itself never leaks out
     * except through `snapshot`/`takeAll`.
     * @param {Object|undefined} initial The cached-edits object from the host's 'init' message
     *   (`message.cachedEdits`), or undefined. Absent -> starts empty.
     * @returns {Object} The store: stash/takeAll/count/snapshot.
     */
    function createStore(initial) {
        const map = initial || {};

        return {
            /**
             * Stashes one edit, keyed by component + block so a later edit to the same block
             * overwrites rather than accumulates (editor.js:220-225).
             * @param {string} componentId
             * @param {string} blockType 'Declaration' or 'ST'.
             * @param {Object} context The component's `xmlContext`, carried verbatim so the host
             *   can find the right CDATA block to replace — THE cross-process edit record shape;
             *   `foldEdits` below is its consumer.
             * @param {string} content The pane's current text.
             */
            stash: function (componentId, blockType, context, content) {
                const key = `${componentId}_${blockType}`;
                map[key] = { context: context, blockType: blockType, content: content };
            },
            /**
             * Returns every stashed record and empties the store — the flush/save payload
             * (editor.js:153,167).
             * @returns {Array<Object>} The stashed records, in no particular order.
             */
            takeAll: function () {
                const edits = Object.values(map);
                for (const key of Object.keys(map)) delete map[key];
                return edits;
            },
            /**
             * @returns {number} How many edits are currently stashed.
             */
            count: function () {
                return Object.keys(map).length;
            },
            /**
             * Returns the raw keyed map itself, for the 'updatePendingEdits' message
             * (editor.js:227-230 sends the map itself).
             * @returns {Object} The keyed map (componentId_blockType -> record).
             */
            snapshot: function () {
                return map;
            }
        };
    }

    /**
     * The status text/className `updateStatusText` derived from the pending-edit count
     * (editor.js:141-150), minus the DOM writes — call sites still own the transient
     * 'Saving...' state, which never comes from here.
     * @param {number} count `editsStore.count()`.
     * @returns {{text: string, className: string}}
     */
    function statusFor(count) {
        if (count > 0) {
            return { text: `Unsaved Changes (${count})`, className: 'status-indicator modified' };
        }
        return { text: 'Synced', className: 'status-indicator' };
    }

    /**
     * The init-restore matcher (editor.js:1482-1498 moved verbatim): for each cached edit, finds
     * the component whose `xmlContext` matches on subType AND subName AND accessorType — the
     * triple disambiguates get/set accessors, which otherwise share subType and subName — and
     * overwrites `comp.declaration` (blockType 'Declaration') or `comp.implementation` (else).
     * Mutates `components` in place; returns nothing, exactly as today.
     * @param {Array<Object>} components The loaded components (each with `.xmlContext`,
     *   `.declaration`, `.implementation`).
     * @param {Object|null|undefined} cachedEdits The keyed map from the host's 'init' message
     *   (`message.cachedEdits`). Null/absent -> no-op.
     */
    function applyCachedEdits(components, cachedEdits) {
        if (!cachedEdits) return;
        for (const edit of Object.values(cachedEdits)) {
            const comp = components.find(c => {
                const ctx = c.xmlContext;
                return ctx.subType === edit.context.subType &&
                    ctx.subName === edit.context.subName &&
                    ctx.accessorType === edit.context.accessorType;
            });
            if (comp) {
                if (edit.blockType === 'Declaration') {
                    comp.declaration = edit.content;
                } else {
                    comp.implementation = edit.content;
                }
            }
        }
    }

    /**
     * Folds a list of pending-edit records into document text, one CDATA replacement per edit.
     * The host-side consumer of the record shape `stash` produces — `src/customEditorProvider.js`
     * calls this identically from its 'sync-pending' loop (:264-272) and its 'save' loop
     * (:288-296), which differed only in which variable held the accumulator.
     * @param {string} text The starting document text.
     * @param {Array<Object>} edits Records `{ context, blockType, content }`, applied in order.
     * @param {function(string, Object, string, string): string} replace Typically
     *   `replaceComponentCdata`; called as `replace(text, context, blockType, content)`.
     * @returns {string} The text after every edit has been folded in, in array order.
     */
    function foldEdits(text, edits, replace) {
        return edits.reduce((t, e) => replace(t, e.context, e.blockType, e.content), text);
    }

    return {
        createStore: createStore,
        statusFor: statusFor,
        applyCachedEdits: applyCachedEdits,
        foldEdits: foldEdits
    };
}));
