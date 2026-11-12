/**
 * @file xaeErrorPlacement.js
 * @description Where an error reported by the XAE build (roadmap R14) goes in the Problems panel.
 *
 * The driver (resources/xae/build-plc-project.ps1) reports raw data only: the XAE error list's items
 * (`file`, `line`, `column`, `description`, `project`, `level`) and, on a failed build, the text of
 * the output-window panes. Placement lives here, in JS, because it needs the same XML parse and
 * Structured Text line map as the rest of the extension, and because it can be tested off Windows.
 *
 * What an ErrorItem's line counts is NOT KNOWN yet (no Windows fixture exists): a line of the pane
 * the error is in (`lineBase: 'pane'`, the default) or a line of the whole object as one text
 * (`'file'`, mapped back through the stConverter `raw` lineMap). So placement is a strategy chain that
 * falls through on no match, and says how sure it is:
 *   1. the item names an existing `.TcPOU`/`.TcGVL`/`.TcDUT`/`.TcIO` (absolute, or relative to the
 *      `.sln` directory): parse it and map the line. A section marker in the description
 *      ("Declaration"/"Implementation") makes it exact; otherwise `exact: false` and the message
 *      ends with " (location approximate)";
 *   2. `parseOutputPaneLines(text)` over the output panes - ships returning [] until real captures exist;
 *   3. a known file but no usable line: line 1 of its first pane, `exact: false`;
 *   4. nothing usable: `general` (shown in the summary and the channel, never dropped).
 *
 * Pure: the file reads are injected. test/test_xae_error_placement.js runs it against sample/.
 */

'use strict';

const path = require('path');
const { parseTwinCatXml } = require('./xmlParser');
const { assembleSt, absoluteToLocal } = require('./livePath');
const { memberName } = require('./componentId');

/** The TwinCAT object files a Problems entry can sit on. */
const OBJECT_FILE_RE = /\.(TcPOU|TcGVL|TcDUT|TcIO)$/i;

/** Appended to the message of a problem whose position is a guess. */
const APPROXIMATE_NOTE = ' (location approximate)';

/**
 * @typedef {Object} XaeErrorItem One item of the XAE error list, as the driver reported it.
 * @property {string|null} file
 * @property {number|null} line
 * @property {number|null} column
 * @property {string} description
 * @property {string|null} project
 * @property {string|null} level e.g. `vsBuildErrorLevelHigh`; null when absent.
 */

/**
 * @typedef {Object} XaeProblem The R13 problem shape (compileCheck CompileDiagnostic).
 * @property {string} filePath
 * @property {string} componentId
 * @property {'decl'|'impl'} pane
 * @property {number} line 1-based pane line.
 * @property {number} column
 * @property {number} endLine
 * @property {number} endColumn
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {boolean} exact
 */

/**
 * @typedef {Object} PlacementDeps
 * @property {(p: string) => string} readFile
 * @property {(p: string) => boolean} exists
 * @property {string} [slnDir] Relative file names are resolved against it.
 * @property {'pane'|'file'} [lineBase] What an item's line counts; default `pane`.
 * @property {(text: string) => any} [parseXml] Default xmlParser.parseTwinCatXml.
 * @property {(text: string) => ({lineMap: Object}|null)} [toUnit] Default livePath.assembleSt (raw mode).
 */

/**
 * The severity of an error-list level (`vsBuildErrorLevelHigh/Medium/Low`, or a plain word).
 * @param {string|null} level
 * @returns {'error'|'warning'|'info'}
 */
function severityOf(level) {
    const l = String(level || '').toLowerCase();
    if (/medium|warn/.test(l)) return 'warning';
    if (/low|info|message/.test(l)) return 'info';
    return 'error';
}

/**
 * Lines of an output pane that name a file and line. Deliberately empty until real XAE output has
 * been captured on Windows: guessing a format would place errors on the wrong line with confidence.
 * @param {string} text
 * @returns {XaeErrorItem[]}
 */
function parseOutputPaneLines(text) {
    return [];
}

/**
 * The object file an item names, if it exists.
 * @param {string|null} file
 * @param {PlacementDeps} deps
 * @returns {string|null}
 */
function resolveObjectFile(file, deps) {
    if (!file || !OBJECT_FILE_RE.test(file)) return null;
    // XAE reports Windows paths; the separators are made native so the tests can run anywhere.
    file = file.split(/[\\/]/).join(path.sep);
    const candidates = path.isAbsolute(file) ? [file] : (deps.slnDir ? [path.join(deps.slnDir, file)] : []);
    for (const c of candidates) {
        try { if (deps.exists(c)) return c; } catch (e) { /* not there */ }
    }
    return null;
}

/**
 * Which pane a description names, if any.
 * @param {string} description
 * @returns {'decl'|'impl'|null}
 */
function sectionMarker(description) {
    if (/\b(Declaration|Deklaration|Decl)\b/i.test(description)) return 'decl';
    if (/\b(Implementation|Implementierung|Impl)\b/i.test(description)) return 'impl';
    return null;
}

/**
 * The component a description names as `<Object>.<Member>` (a method, action or property), else root.
 * @param {any} parsed
 * @param {string} description
 * @returns {any}
 */
function componentNamed(parsed, description) {
    const comps = parsed.components || [];
    const root = comps.find(c => c.id === 'root') || comps[0];
    for (const c of comps) {
        if (c.id === 'root') continue;
        const name = memberName(c.id);
        if (root && root.name && new RegExp(`\\b${escapeRe(root.name)}\\.${escapeRe(name)}\\b`, 'i').test(description)) return c;
    }
    return root;
}

/** @param {string} s @returns {string} */
function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Places the XAE build's errors.
 * @param {XaeErrorItem[]} errorItems
 * @param {Array<{name: string, text: string}>} panes
 * @param {PlacementDeps} deps
 * @returns {{byFile: Map<string, XaeProblem[]>, general: XaeErrorItem[], placed: number, total: number}}
 */
function placeXaeErrors(errorItems, panes, deps) {
    const parseXml = deps.parseXml || parseTwinCatXml;
    const toUnit = deps.toUnit || ((/** @type {string} */ text) => assembleSt(text, null));
    const lineBase = deps.lineBase === 'file' ? 'file' : 'pane';
    /** @type {Map<string, XaeProblem[]>} */
    const byFile = new Map();
    /** @type {XaeErrorItem[]} */
    const general = [];
    const items = errorItems.length > 0 ? errorItems.slice() : panes.flatMap(p => parseOutputPaneLines(p.text));
    /** @type {Map<string, any>} */
    const parsedCache = new Map();
    let placed = 0;

    const add = (/** @type {XaeProblem} */ p) => {
        if (!byFile.has(p.filePath)) byFile.set(p.filePath, []);
        /** @type {XaeProblem[]} */ (byFile.get(p.filePath)).push(p);
        placed++;
    };

    for (const item of items) {
        const filePath = resolveObjectFile(item.file, deps);
        const severity = severityOf(item.level);
        if (!filePath) { general.push(item); continue; }
        if (!parsedCache.has(filePath)) {
            /** @type {string|null} */
            let text;
            try { text = deps.readFile(filePath); } catch (e) { text = null; }
            const parsed = text === null ? null : parseXml(text);
            parsedCache.set(filePath, parsed ? { text, parsed } : null);
        }
        const entry = parsedCache.get(filePath);
        if (!entry) { general.push(item); continue; }
        const marker = sectionMarker(item.description);
        const column = item.column && item.column > 0 ? item.column : 1;
        /** @type {{componentId: string, pane: 'decl'|'impl', line: number}|null} */
        let at = null;
        if (item.line && item.line > 0) {
            if (lineBase === 'file') {
                const unit = toUnit(entry.text);
                const local = unit ? absoluteToLocal(unit.lineMap, item.line - 1) : null;
                if (local) at = { componentId: local.componentId, pane: /** @type {'decl'|'impl'} */ (local.pane), line: local.localLine0 + 1 };
            } else {
                const comp = componentNamed(entry.parsed, item.description);
                if (comp) {
                    const hasImpl = typeof comp.implementation === 'string';
                    at = { componentId: comp.id, pane: marker || (hasImpl ? 'impl' : 'decl'), line: item.line };
                }
            }
        }
        const exact = !!at && (lineBase === 'file' || marker !== null);
        if (!at) {
            // Strategy 3: the file is known, the line is not.
            const comp = componentNamed(entry.parsed, item.description);
            at = { componentId: comp ? comp.id : 'root', pane: marker || 'decl', line: 1 };
        }
        add({
            filePath, componentId: at.componentId, pane: at.pane, line: at.line, column, endLine: at.line, endColumn: column,
            severity, message: item.description + (exact ? '' : APPROXIMATE_NOTE), exact
        });
    }
    return { byFile, general, placed, total: items.length };
}

/**
 * The run summary's sentence about errors.
 * @param {{placed: number, total: number}} placement
 * @param {number} exitCode
 * @param {string} channelName
 * @returns {string}
 */
function placementSummary(placement, exitCode, channelName) {
    if (exitCode === 1 && placement.total === 0) return `XAE reported no error list; see '${channelName}'.`;
    if (placement.total === 0) return '';
    return `${placement.total} error${placement.total === 1 ? '' : 's'} (${placement.placed} placed in Problems).`;
}

module.exports = {
    OBJECT_FILE_RE, APPROXIMATE_NOTE, severityOf, parseOutputPaneLines, sectionMarker, placeXaeErrors, placementSummary
};
