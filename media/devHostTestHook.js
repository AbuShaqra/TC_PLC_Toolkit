/**
 * @file media/devHostTestHook.js
 * @description Dev-host-only test instrumentation for the webview. Loaded by
 * `src/customEditorProvider.js` ONLY when the extension host runs with `TCDEV_TEST=1`, which only
 * `test/devhost/run.js` sets — production never emits the script tag, and the file is
 * `.vscodeignore`d so it is not even in the VSIX. Nothing in `media/editor.js` knows it exists.
 *
 * What it buys: the P8 G4 checklist (docs/superpowers/plans/2026-08-22-deepen-08-g4-checklist.md)
 * is a list of typing/Manual-Sync/diagnostics interactions that were only ever verifiable by a
 * human sitting in front of an Extension Development Host — the browser harness drives Monaco but
 * stubs the host, and every Node harness drives the host but has no Monaco. This hook gives
 * `test/devhost/testRunner.js` a message vocabulary for driving the REAL Monaco editors (through
 * their real `onDidChangeModelContent` pipeline, not by poking editor.js internals) and for
 * reading back what the page actually shows.
 *
 * Why it wraps `acquireVsCodeApi`: VS Code's webview bridge throws if that function is called
 * twice, and `media/editor.js` calls it at line 2 and keeps the instance in its IIFE closure. So
 * this file must load BEFORE editor.js and memoize the single instance, leaving editor.js's own
 * unmodified call returning the same object. That ordering is also why the script tag sits
 * immediately before editor.js's rather than anywhere else.
 *
 * Everything here is observation plus real user-level input. It registers no Monaco provider,
 * mutates no editor.js state, and answers only messages whose type starts with `test:` — types the
 * production host has no case for and ignores.
 */
(function () {
    'use strict';

    // Memoize the bridge: editor.js's own `acquireVsCodeApi()` must return this same instance,
    // because the second real call throws and would leave the whole webview dead at load.
    const originalAcquire = window.acquireVsCodeApi;
    let sharedApi = null;
    window.acquireVsCodeApi = function () {
        if (!sharedApi) sharedApi = originalAcquire();
        return sharedApi;
    };
    const vscode = window.acquireVsCodeApi();

    // Recorded rather than swallowed: checklist item 6 asserts that a diagnostic in a component
    // whose declaration pane is collapsed throws NOTHING, and "nothing was thrown" is only
    // evidence if something was listening.
    const errors = [];
    window.addEventListener('error', event => {
        errors.push(`error: ${event.message} @ ${event.filename}:${event.lineno}`);
    });
    window.addEventListener('unhandledrejection', event => {
        errors.push(`unhandledrejection: ${String(event.reason && (event.reason.stack || event.reason))}`);
    });

    /**
     * Resolves the Monaco editor rendered inside a pane, by DOM containment. The panes are the
     * stable identity here — editor.js's `declEditor`/`implEditor` live in its closure, and the
     * creation order of `monaco.editor.getEditors()` is not a contract.
     * @param {string} paneId 'pane-decl' or 'pane-impl'.
     * @returns {Object|null} The editor, or null when Monaco has not loaded / the pane has none.
     */
    function editorInPane(paneId) {
        const pane = document.getElementById(paneId);
        if (!pane || !window.monaco || !monaco.editor || typeof monaco.editor.getEditors !== 'function') return null;
        for (const ed of monaco.editor.getEditors()) {
            const node = ed.getDomNode && ed.getDomNode();
            if (node && pane.contains(node)) return ed;
        }
        return null;
    }

    /**
     * @param {string} pane 'decl' or 'impl'.
     * @returns {Object|null} The editor for that pane.
     */
    function editorFor(pane) {
        return editorInPane(pane === 'decl' ? 'pane-decl' : 'pane-impl');
    }

    /**
     * @param {Object|null} el
     * @returns {boolean} Whether the element is laid out (the panes are hidden with
     *   `display: none` — an Action has no declaration, a DUT no implementation).
     */
    function isVisible(el) {
        return !!el && el.style.display !== 'none';
    }

    /**
     * The name of the pane a marker's model belongs to. Markers are global to Monaco, and the
     * hidden models the references peek builds are models too, so anything that is not one of the
     * two live panes is reported as 'other' rather than silently attributed to a pane.
     * @param {Object} resource The marker's `resource` (a monaco.Uri).
     * @param {Object|null} decl
     * @param {Object|null} impl
     * @returns {string} 'decl', 'impl' or 'other'.
     */
    function paneOfResource(resource, decl, impl) {
        const key = resource && resource.toString();
        const uriOf = (ed) => {
            const model = ed && ed.getModel();
            return model ? model.uri.toString() : null;
        };
        if (key && key === uriOf(decl)) return 'decl';
        if (key && key === uriOf(impl)) return 'impl';
        return 'other';
    }

    /**
     * Everything the runner asserts on, in one round trip: a poll loop that needed several
     * requests per tick would race the very transitions it is watching (the 200 ms edit debounce,
     * the 300 ms diagnostics debounce, a peek opening).
     * @returns {Object} The page state.
     */
    function readState() {
        const decl = editorFor('decl');
        const impl = editorFor('impl');
        const paneDecl = document.getElementById('pane-decl');
        const paneImpl = document.getElementById('pane-impl');
        const statusEl = document.getElementById('save-status');
        const toggleEl = /** @type {*} */ (document.getElementById('sync-mode-toggle'));
        const selectEl = /** @type {*} */ (document.getElementById('component-select'));
        const syncTextEl = document.getElementById('sync-mode-text');

        const markers = [];
        if (window.monaco && monaco.editor) {
            for (const marker of monaco.editor.getModelMarkers({})) {
                markers.push({
                    pane: paneOfResource(marker.resource, decl, impl),
                    severity: marker.severity,
                    message: marker.message,
                    startLineNumber: marker.startLineNumber,
                    startColumn: marker.startColumn,
                    owner: marker.owner
                });
            }
        }

        // The focused pane first: a Go to Definition lands the caret in whichever pane holds the
        // target, and the implementation pane is the fallback because that is where code lives.
        let selectionEditor = null;
        for (const ed of [decl, impl]) {
            if (ed && ed.hasTextFocus && ed.hasTextFocus()) { selectionEditor = ed; break; }
        }
        if (!selectionEditor) selectionEditor = impl || decl;
        let selection = null;
        if (selectionEditor && selectionEditor.getModel()) {
            const sel = selectionEditor.getSelection();
            if (sel) {
                selection = {
                    text: selectionEditor.getModel().getValueInRange(sel),
                    startLineNumber: sel.startLineNumber,
                    startColumn: sel.startColumn,
                    endLineNumber: sel.endLineNumber,
                    endColumn: sel.endColumn
                };
            }
        }

        return {
            // An Action hides the declaration pane and a DUT the implementation pane, so "ready"
            // cannot demand both — it demands Monaco plus whatever the component actually shows.
            ready: !!(window.monaco && (decl || impl)),
            status: statusEl ? statusEl.textContent : null,
            statusClass: statusEl ? statusEl.className : null,
            syncText: syncTextEl ? syncTextEl.textContent : null,
            toggleChecked: toggleEl ? !!toggleEl.checked : null,
            selectValue: selectEl ? selectEl.value : null,
            declVisible: isVisible(paneDecl),
            implVisible: isVisible(paneImpl),
            declValue: decl && decl.getModel() ? decl.getValue() : null,
            implValue: impl && impl.getModel() ? impl.getValue() : null,
            markers: markers,
            selection: selection,
            peekOpen: !!document.querySelector('.zone-widget, .peekview-widget'),
            errors: errors.slice(),
            // Reported, never assumed: checklist item 6 is specifically that the panes carry REAL
            // MarkerSeverity values, so the expected value has to come from the same Monaco build.
            markerSeverityError: (window.monaco && monaco.MarkerSeverity) ? monaco.MarkerSeverity.Error : null
        };
    }

    /**
     * Places the caret, defaulting to the end of the model.
     * @param {Object} ed The editor.
     * @param {number|undefined} line 1-based Monaco line.
     * @param {number|undefined} column 1-based Monaco column.
     */
    function positionIn(ed, line, column) {
        const model = ed.getModel();
        if (typeof line === 'number' && typeof column === 'number') {
            return { lineNumber: line, column: column };
        }
        const end = model.getFullModelRange().getEndPosition();
        return { lineNumber: end.lineNumber, column: end.column };
    }

    const handlers = {
        /** The whole page state (above). */
        'test:state': function (message) {
            return { type: 'test:stateResponse', requestId: message.requestId, state: readState() };
        },

        /**
         * Types text the way a user does: `trigger('devhost', 'type', ...)` goes through Monaco's
         * core type command, so the model's `onDidChangeModelContent` fires and editor.js's
         * `onEditorChange` runs its real Auto/Manual branch. Nothing here calls editor.js.
         */
        'test:typeText': function (message) {
            const ed = editorFor(message.pane);
            if (!ed) throw new Error(`no editor in pane ${message.pane}`);
            ed.focus();
            ed.setPosition(positionIn(ed, message.line, message.column));
            // The trigger SOURCE matters: Monaco only runs its auto-closing/auto-indent
            // interceptors for source 'keyboard', so 'devhost' inserts the text verbatim. What it
            // does not normalize is the newline, and these files are CRLF — inserting a bare LF
            // would leave a mixed-EOL line inside the CDATA the test is about to byte-compare.
            const text = String(message.text).replace(/\r?\n/g, ed.getModel().getEOL());
            ed.trigger('devhost', 'type', { text: text });
            return { type: 'test:done', requestId: message.requestId };
        },

        'test:setPosition': function (message) {
            const ed = editorFor(message.pane);
            if (!ed) throw new Error(`no editor in pane ${message.pane}`);
            const position = { lineNumber: message.line, column: message.column };
            ed.focus();
            ed.setPosition(position);
            ed.revealPositionInCenter(position);
            return { type: 'test:done', requestId: message.requestId };
        },

        /** Clicks the real checkbox, so its own 'change' listener runs the flush/status branch. */
        'test:toggleSync': function (message) {
            const toggleEl = /** @type {*} */ (document.getElementById('sync-mode-toggle'));
            if (!toggleEl) throw new Error('no sync-mode-toggle element');
            toggleEl.click();
            return { type: 'test:done', requestId: message.requestId };
        },

        /**
         * There is no Sync button: a manual save is Ctrl+S, caught by editor.js's window keydown
         * listener. Synthesizing the event is the only way to reach `triggerManualSave` without
         * reaching into its closure.
         */
        'test:manualSave': function (message) {
            window.dispatchEvent(new KeyboardEvent('keydown', {
                key: 's', ctrlKey: true, cancelable: true, bubbles: true
            }));
            return { type: 'test:done', requestId: message.requestId };
        },

        /** Runs a Monaco action/command by id in a pane (revealDefinition, referenceSearch...). */
        'test:trigger': function (message) {
            const ed = editorFor(message.pane);
            if (!ed) throw new Error(`no editor in pane ${message.pane}`);
            ed.focus();
            ed.trigger('devhost', message.actionId, {});
            return { type: 'test:done', requestId: message.requestId };
        },

        /**
         * Expands a FILE group in the open references peek.
         *
         * The peek opens with only the group holding the focused reference expanded, and its list
         * is virtualized: the reference rows of every other file do not exist in the DOM at all
         * until their group is opened. So a cross-file row cannot be clicked without this first.
         * The twistie is the click target because the tree may run with
         * `expandOnlyOnTwistieClick`, where a click on the row body would do nothing.
         */
        'test:expandPeekFile': function (message) {
            const wanted = String(message.matchText).toLowerCase();
            const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
            const row = rows.find(r => !!r.querySelector('.reference-file') &&
                (r.textContent || '').toLowerCase().includes(wanted));
            if (row) {
                const target = row.querySelector('.monaco-tl-twistie') || row;
                // A real pointer sequence: the tree's mouse controller listens on mousedown/mouseup
                // as well as click, and a lone synthetic click is not always enough.
                for (const type of ['mousedown', 'mouseup', 'click']) {
                    target.dispatchEvent(new MouseEvent(type, {
                        bubbles: true, cancelable: true, button: 0, detail: 1
                    }));
                }
            }
            return {
                type: 'test:done',
                requestId: message.requestId,
                found: !!row,
                rowText: row ? (row.textContent || '').trim() : null
            };
        },

        /**
         * Double-clicks a row of the open references peek — the gesture that drives
         * `peekOpenMessage`'s 'openFile' body and the deferred `closeReferencePeek`. Matched on
         * visible text rather than index: the row order is Monaco's business.
         *
         * The peek tree is a flat list of two kinds of row, and only one of them navigates: a FILE
         * group row (it carries a `.reference-file` label) merely expands/collapses on
         * double-click, while a reference row opens. So when the match lands on a file row — which
         * is what a file-name `matchText` does — the click moves on to the first reference row
         * under it, the row a user would actually double-click.
         */
        'test:clickPeekRow': function (message) {
            const wanted = String(message.matchText).toLowerCase();
            const isFileRow = (r) => !!r.querySelector('.reference-file');
            const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
            let index = rows.findIndex(r => {
                const label = r.getAttribute('aria-label') || '';
                return (r.textContent || '').toLowerCase().includes(wanted) ||
                    label.toLowerCase().includes(wanted);
            });
            const matchedFileRow = index !== -1 && isFileRow(rows[index]);
            while (index !== -1 && index < rows.length && isFileRow(rows[index])) index++;
            const row = (index !== -1 && index < rows.length) ? rows[index] : null;
            if (row) {
                row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
            }
            return {
                type: 'test:done',
                requestId: message.requestId,
                found: !!row,
                matchedFileRow: matchedFileRow,
                rowText: row ? (row.textContent || '').trim() : null,
                // Every row, so a miss reports what the peek actually offered rather than just
                // "not found" — the widget virtualizes its list, and the rendered set is the fact
                // that matters when a match fails.
                rows: rows.map(r => ({ text: (r.textContent || '').trim(), file: isFileRow(r) }))
            };
        }
    };

    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message.type !== 'string' || !handlers[message.type]) return;
        try {
            vscode.postMessage(handlers[message.type](message));
        } catch (e) {
            // Answered, never dropped: the runner waits on `requestId`, and a silent throw would
            // read as a 10 s timeout with no cause attached to it.
            vscode.postMessage({
                type: 'test:error',
                requestId: message.requestId,
                error: String((e && e.stack) || e)
            });
        }
    });
}());
