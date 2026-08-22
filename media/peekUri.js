/**
 * @file media/peekUri.js
 * @description The synthetic peek/goto URI vocabulary the webview uses to route Monaco navigation
 * across panes, components and files that have no live model — pulled out of `media/editor.js` so
 * the encode/decode logic can run under a plain Node harness with no Monaco at all.
 *
 * Lives in `media/` because the webview loads it with a plain `<script>` tag, but it is written to
 * `require()` cleanly too (see the shim at the bottom) so `test/test_peek_uri.js` can exercise the
 * exact code the panes run. There is no build step in this project, so one file that works both ways
 * is the only way to avoid two copies of this vocabulary drifting apart.
 *
 * `peekPath` (the value behind `pane.path`) is minted on the extension-host side, in
 * `src/livePath.js` — this module only embeds whatever `pane.path` it is handed; see that file's
 * matching cross-reference comment.
 *
 * Every function here is a pure encode/decode step: this module never touches `monaco.Uri.from` or
 * `vscode.postMessage` itself, so callers stay free to inject sentinels in place of real Monaco/VS
 * Code objects.
 */

// Dual-mode shim: `module.exports` under Node, a `peekUri` global in the webview. The cast is for the
// type-check gate, which reads this file as a module and would otherwise reject assigning a new
// property to `Window` — the branch Node never takes.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.peekUri = factory();
}(typeof self !== 'undefined' ? /** @type {*} */ (self) : this, function () {
    'use strict';

    // ---------------------------------------------------------------------------------------
    // Go to Definition targets
    //
    // A definition can land in another component, another pane or another file — none of which
    // has a Monaco model in this webview. Monaco cannot open such a location itself, so the
    // definition provider encodes the destination into a synthetic URI:
    //
    //     twincat:/goto?file=<fileUri>&component=<id>&word=<name>[&sl=&sc=&el=&ec=][&pane=&ll=]
    //
    // and the editor opener (registered next to the provider) decodes it and does the jump:
    // same file -> loadComponent + highlightTarget; other file -> 'openFile' to the extension.
    // sl/sc/el/ec carry the raw LSP range (0-indexed), which the extension host needs for the
    // generated `.st` navigation branch of `twincat.openComponent`; pane/ll carry the same target
    // expressed as a pane and a line WITHIN it, which is what selecting inside a component needs.
    // Both are the host's answer, mapped through absoluteToLocal — never a search for the name.
    // ---------------------------------------------------------------------------------------
    const GOTO_SCHEME = 'twincat';

    /**
     * Scheme for the read-only models that back references-peek entries outside the two live panes.
     * Monaco throws "Model not found" for a Location whose URI has no loaded model, which is why the
     * peek used to be limited to the active component — so every other pane gets a hidden model
     * holding just that pane's text, built from what the extension sends with the reference list.
     */
    const PEEK_SCHEME = 'twincat-peek';

    /**
     * The one query parser both directions share (was byte-duplicated in editor.js as
     * `openPeekTarget` and `decodeGotoUri`'s inline loops).
     * @param {string|null|undefined} queryString A `monaco.Uri`'s `.query`.
     * @returns {Object<string, string>} Flat key -> decoded value map.
     */
    function parseQuery(queryString) {
        const q = {};
        (queryString || '').split('&').forEach(pair => {
            if (!pair) return;
            const eq = pair.indexOf('=');
            q[eq < 0 ? pair : pair.substring(0, eq)] = eq < 0 ? '' : decodeURIComponent(pair.substring(eq + 1));
        });
        return q;
    }

    /**
     * The synthetic URI parts for one peek pane. Carries the file/component/pane so a click can be
     * routed back to the real editor; the exact line and column come from the click position itself,
     * so one model serves every occurrence inside that pane.
     * @param {Object} pane { uri, componentId, pane, path } as sent by the extension.
     * @returns {{scheme: string, path: string, query: string}} Parts for `monaco.Uri.from`.
     */
    function encodePeekParts(pane) {
        const query = [
            'file=' + encodeURIComponent(pane.uri || ''),
            'component=' + encodeURIComponent(pane.componentId || 'root'),
            'pane=' + encodeURIComponent(pane.pane || 'impl')
        ].join('&');
        return { scheme: PEEK_SCHEME, path: pane.path || '/reference', query: query };
    }

    /**
     * Encodes an LSP definition into synthetic navigation URI parts.
     * @param {Object} def LSP definition { uri, componentId, range, pane, localLine }.
     * @param {string} targetWord The word to select once the target is shown.
     * @param {string} activeFileUri Fallback file URI when `def.uri` is absent (the current file).
     * @returns {{scheme: string, path: string, query: string}} Parts for `monaco.Uri.from`.
     */
    function encodeGotoParts(def, targetWord, activeFileUri) {
        const parts = [
            'file=' + encodeURIComponent(def.uri || activeFileUri),
            'component=' + encodeURIComponent(def.componentId || 'root'),
            'word=' + encodeURIComponent(targetWord || '')
        ];
        if (def.range && def.range.start && def.range.end) {
            parts.push('sl=' + def.range.start.line);
            parts.push('sc=' + def.range.start.character);
            parts.push('el=' + def.range.end.line);
            parts.push('ec=' + def.range.end.character);
        }
        // The exact destination inside the component. Without it the jump ends in a first-match word
        // search over the target's declaration pane, which finds the name in a header comment before
        // it finds the declaration.
        if (def.pane && def.localLine != null) {
            parts.push('pane=' + encodeURIComponent(def.pane));
            parts.push('ll=' + def.localLine);
        }
        return { scheme: GOTO_SCHEME, path: '/goto', query: parts.join('&') };
    }

    /**
     * Decodes a synthetic navigation URI's query, produced by encodeGotoParts.
     * @param {string} queryString A `monaco.Uri`'s `.query`.
     * @returns {Object} { fileUri, componentId, targetWord, pane, localLine, range } — range is the
     *                   raw LSP range ({ start:{line,character}, end:{...} }) or null when absent;
     *                   pane/localLine are null when the host could not place the target.
     */
    function decodeGotoTarget(queryString) {
        const q = parseQuery(queryString);
        const target = {
            fileUri: q.file || '',
            componentId: q.component || 'root',
            targetWord: q.word || '',
            pane: q.pane || null,
            localLine: q.ll !== undefined ? Number(q.ll) : null,
            range: null
        };
        if (q.sl !== undefined) {
            target.range = {
                start: { line: Number(q.sl), character: Number(q.sc) },
                end: { line: Number(q.el), character: Number(q.ec) }
            };
        }
        return target;
    }

    /**
     * The pure body of `openPeekTarget`: decodes a peek click into the 'openFile' message the
     * extension host expects.
     * @param {string} queryString The clicked peek model's `monaco.Uri.query`.
     * @param {Object|null} rangeOrNull `toRange(selectionOrPosition)`'s result (stays in editor.js;
     *   this module never touches monaco), or null for a bare position.
     * @param {string} targetWord The searched word, for the fallback highlight/selection width.
     * @param {string} activeFileUri Fallback file URI when the query carries none.
     * @returns {Object} The full 'openFile' message body, including `type`.
     */
    function peekOpenMessage(queryString, rangeOrNull, targetWord, activeFileUri) {
        const q = parseQuery(queryString);
        const range = rangeOrNull;
        const line0 = (range ? range.startLineNumber : 1) - 1;
        const startCol0 = (range ? range.startColumn : 1) - 1;
        // Monaco may hand back a bare position, which toRange widens into a zero-length range —
        // that would place the caret but select nothing, so fall back to the word's own length.
        let endCol0 = range ? range.endColumn - 1 : startCol0;
        if (endCol0 <= startCol0) endCol0 = startCol0 + (targetWord || '').length;
        return {
            type: 'openFile',
            fileUri: q.file || activeFileUri,
            componentId: q.component || 'root',
            range: {
                pane: q.pane || null,
                localLine: line0,
                start: { line: line0, character: startCol0 },
                end: { line: line0, character: endCol0 }
            },
            targetWord: targetWord || ''
        };
    }

    return {
        PEEK_SCHEME: PEEK_SCHEME,
        GOTO_SCHEME: GOTO_SCHEME,
        parseQuery: parseQuery,
        encodePeekParts: encodePeekParts,
        encodeGotoParts: encodeGotoParts,
        decodeGotoTarget: decodeGotoTarget,
        peekOpenMessage: peekOpenMessage
    };
}));
