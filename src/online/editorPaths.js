/**
 * @file editorPaths.js
 * @description Online monitoring (R15), the editor half of "which variable sits where": turns the
 * lines a pane shows into the unit-line ranges the LSP's `custom/onlinePaths` takes, maps its answer
 * back to pane-local Monaco positions through the live path's `lineMap`, and fills a FUNCTION_BLOCK's
 * `{instance}` placeholder. vscode-free, so test/test_ads_paths.js drives the same code the host runs.
 */

'use strict';

const { absoluteToLocal } = require('../livePath');

/** The placeholder a FUNCTION_BLOCK's paths start with (src/lsp/features/onlinePaths.js). */
const INSTANCE = '{instance}';

/**
 * @typedef {Object} VisibleLines
 * @property {string} componentId The component the panes show.
 * @property {Array<{start: number, end: number}>|null} decl Visible declaration lines (1-based,
 *   pane-local, inclusive), or null when the pane is not shown.
 * @property {Array<{start: number, end: number}>|null} impl The same for the implementation pane.
 */

/**
 * The LSP ranges (0-based unit lines, inclusive) for what the panes show.
 * @param {Object} lineMap The live path's component -> decl/impl block map (1-based unit lines).
 * @param {VisibleLines|null} visible What is visible; null asks for every component's every line.
 * @returns {Array<{start: number, end: number, pane: 'decl'|'impl'}>}
 */
function paneRanges(lineMap, visible) {
    /** @type {Array<{start: number, end: number, pane: 'decl'|'impl'}>} */
    const out = [];
    const ids = visible ? [visible.componentId] : Object.keys(lineMap || {});
    for (const id of ids) {
        const blocks = lineMap && lineMap[id];
        if (!blocks) continue;
        for (const pane of /** @type {Array<'decl'|'impl'>} */ (['decl', 'impl'])) {
            const block = blocks[pane];
            if (!block || !block.start) continue;
            const wanted = visible ? visible[pane] : [{ start: 1, end: block.end - block.start + 1 }];
            if (!wanted) continue;
            for (const w of wanted) {
                const start = Math.max(block.start, block.start + w.start - 1);
                const end = Math.min(block.end, block.start + w.end - 1);
                if (end >= start) out.push({ start: start - 1, end: end - 1, pane });
            }
        }
    }
    return out;
}

/**
 * @typedef {Object} PaneOccurrence
 * @property {string} componentId
 * @property {'decl'|'impl'} pane
 * @property {number} line 1-based pane-local line.
 * @property {number} startColumn 1-based Monaco column of the chain's first character.
 * @property {number} endColumn 1-based Monaco column just past the chain.
 * @property {boolean} eol Shown at the end of the line (declaration panes) rather than after the chain.
 * @property {string|null} path The ADS path template, or null with a `reason`.
 * @property {string|null} reason
 * @property {string|null} localType
 * @property {string} text
 */

/**
 * Maps the LSP's unit occurrences to pane positions; anything outside a component block is dropped.
 * @param {Array<{line: number, start: number, end: number, pane: string, path: string|null,
 *   reason: string|null, localType: string|null, text: string}>} occurrences
 * @param {Object} lineMap
 * @returns {Array<PaneOccurrence>}
 */
function mapOccurrences(occurrences, lineMap) {
    /** @type {Array<PaneOccurrence>} */
    const out = [];
    for (const o of occurrences || []) {
        const local = absoluteToLocal(lineMap, o.line);
        if (!local || local.pane !== o.pane) continue;
        out.push({
            componentId: local.componentId, pane: /** @type {'decl'|'impl'} */ (local.pane), line: local.localLine0 + 1,
            startColumn: o.start + 1, endColumn: o.end + 1, eol: local.pane === 'decl',
            path: o.path, reason: o.reason || null, localType: o.localType || null, text: o.text
        });
    }
    return out;
}

/**
 * Fills the `{instance}` placeholder.
 * @param {string|null} template A path template from the LSP.
 * @param {string|null} instance The chosen instance path, e.g. `MAIN.fbStation`.
 * @returns {string|null} The ADS path, or null when it needs an instance and none is chosen.
 */
function substituteInstance(template, instance) {
    if (!template) return null;
    if (!template.startsWith(INSTANCE)) return template;
    return instance ? instance + template.slice(INSTANCE.length) : null;
}

/** Plain-language reasons for a variable without an ADS symbol, used by refusals. */
const REASON_TEXT = {
    'method-local': 'Method locals exist only while the method runs, so they have no ADS symbol (XAE needs a breakpoint for them too).',
    'temp': 'VAR_TEMP variables exist only during the call, so they have no ADS symbol.',
    'in-out': 'A VAR_IN_OUT is a reference to the caller\'s variable and has no ADS symbol of its own; monitor the variable passed in.',
    'function-local': 'A FUNCTION\'s variables exist only while it runs, so they have no ADS symbol.',
    'unsupported': 'This variable has no ADS symbol.'
};

module.exports = { paneRanges, mapOccurrences, substituteInstance, REASON_TEXT, INSTANCE };
