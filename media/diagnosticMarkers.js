/**
 * @file media/diagnosticMarkers.js
 * @description Splits a flat diagnostics list from `custom/diagnostics` into the two Monaco marker
 * arrays the decl/impl panes each render — the pane-split step of `updateDiagnostics` in
 * `media/editor.js`, pulled out so it can run under a plain Node harness.
 *
 * Lives in `media/` because the webview loads it with a plain `<script>` tag, but it is written to
 * `require()` cleanly too (see the shim at the bottom) so `test/test_diagnostic_markers.js` can
 * exercise the exact code the panes run. There is no build step in this project, so one file that
 * works both ways is the only way to avoid two copies of the split logic drifting apart.
 *
 * The severity values that go into each marker are never Monaco's own — the caller injects them
 * (the webview passes `monaco.MarkerSeverity.Error/Warning/Info`; the harness passes sentinels), so
 * this module can be exercised with no Monaco at all and still prove the mapping is right.
 */

// Dual-mode shim: `module.exports` under Node, a `diagnosticMarkers` global in the webview. The cast
// is for the type-check gate, which reads this file as a module and would otherwise reject assigning
// a new property to `Window` — the branch Node never takes.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.diagnosticMarkers = factory();
}(typeof self !== 'undefined' ? /** @type {*} */ (self) : this, function () {
    'use strict';

    /**
     * Splits a diagnostics list into decl/impl marker arrays for one active component.
     * @param {Array<Object>|null|undefined} diags Flat diagnostics from `custom/diagnostics`, each
     *   `{ componentId, pane, severity, message, range }`.
     * @param {string} activeComponentId Only diagnostics for this component are kept.
     * @param {{error: *, warning: *, info: *}} severities Opaque severity values to stamp onto each
     *   marker; this module never touches monaco itself.
     * @returns {{decl: Array<Object>, impl: Array<Object>}} Marker arrays ready for
     *   `monaco.editor.setModelMarkers`.
     */
    function splitDiagnostics(diags, activeComponentId, severities) {
        const declMarkers = [];
        const implMarkers = [];

        (diags || []).forEach(d => {
            if (d.componentId !== activeComponentId) return;
            const marker = {
                severity: d.severity === 1 ? severities.error
                    : (d.severity === 2 ? severities.warning : severities.info),
                message: d.message,
                startLineNumber: d.range.startLineNumber,
                startColumn: d.range.startColumn,
                endLineNumber: d.range.endLineNumber,
                endColumn: d.range.endColumn
            };
            if (d.pane === 'decl') declMarkers.push(marker);
            else implMarkers.push(marker);
        });

        return { decl: declMarkers, impl: implMarkers };
    }

    return {
        splitDiagnostics: splitDiagnostics
    };
}));
