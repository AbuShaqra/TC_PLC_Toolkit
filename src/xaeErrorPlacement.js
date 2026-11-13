/**
 * @file xaeErrorPlacement.js
 * @description Where an error reported by the XAE build (roadmap R14) goes in the Problems panel.
 *
 * The driver (resources/xae/build-plc-project.ps1) reports raw data only: the XAE error list's items
 * (`file`, `line`, `column`, `description`, `project`, `level`) and the text of the output-window
 * panes. Parsing and placement live here, in JS, because they need the same XML parse and Structured
 * Text line map as the rest of the extension, and because they can be tested off Windows.
 *
 * What the two sources carry (user's Windows runs, 4026.28, 2026-11-13, sample 1 + a planted error):
 *   - **Headless**, the error list's items are EMPTY (no description, no file), apart from a file-less
 *     "Project '...' build ... failed." item. Only the "Build" pane names the errors.
 *   - **Window shown**, the items are filled: `file` is `<path> (Impl)` / `(Decl)` - the pane as a
 *     suffix - and `line` is a line of that pane.
 *   - **The "Build" pane** prints `<path>(<line>) : error: C0189: <message>`, and its line counts the
 *     object as ONE text: the declaration's lines, then the implementation's (`lineBase: 'object'`,
 *     `PANE_LINE_BASE`): 21/22 = 7 declaration lines + implementation lines 14/15. Confirmed for a
 *     POU's own body; how a method/action/property of a POU is numbered there is NOT known yet, so a
 *     pane line in an object that has child components is placed "(location approximate)".
 *
 * So placement is a strategy chain that falls through on no match, and says how sure it is:
 *   1. the item names an existing `.TcPOU`/`.TcGVL`/`.TcDUT`/`.TcIO` (absolute, relative to the `.sln`
 *      directory, or an absolute path from another root whose tail exists under it): parse it and map
 *      the line by the item's line base. A pane suffix or section marker makes a `'pane'` line exact;
 *      an `'object'` line is exact in an object without child components;
 *   2. a known file but no usable line: line 1 of its first pane, `exact: false`;
 *   3. nothing usable: `general` (shown in the channel, never dropped).
 * Empty items are dropped, a file-less "build ... failed" item is a `note` (one channel line, never
 * counted), and a message both sources report at the same place is kept once.
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
 * What a line of the "Build" pane counts: `'object'` = the declaration's lines, then the
 * implementation's, as one text. Confirmed on 4026.28 (2026-11-13) for a POU's own body; the one
 * place to change it if another XAE numbers differently.
 * @type {'object'|'pane'|'file'}
 */
const PANE_LINE_BASE = 'object';

/**
 * A "Build" pane message: `<path>(<line>[,<col>]) : <level>: [<code>:] <text>`. Level words in
 * English and German (`Fehler`, `Warnung`, `Meldung`, `Hinweis`); spacing is free.
 */
const PANE_MESSAGE_RE = /^\s*(.+?\.\w+(?:@[^()]*?)?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)\s*:\s*(information|error|warning|info|message|fehler|warnung|meldung|hinweis)\b\s*:?\s*(?:([A-Z]{1,3}\d{3,5})\s*:\s*)?(.*)$/i;

/**
 * A pane line that ends a message's continuation: blank, a separator, a build/compile summary
 * ("Kompilierung abgeschlossen -- ...", "Build complete -- ...", "BUILD FAILED."), or a level-prefixed
 * line without a location ("Fehler: Unbekannter Fehler ..."). A wrapped message (C0139 prints the code
 * it quotes with its line break) continues on every other line, at most `MAX_CONTINUATION` of them.
 */
const PANE_STOP_RE = /^\s*(?:$|-{3,}|={3,}|(?:build|rebuild|compile|kompilierung|erstellen|erstellung)\b|(?:error|warning|info|fehler|warnung|meldung|hinweis)\s*:)/i;
const MAX_CONTINUATION = 5;

/** A leading compiler code in a description ("C0189: ..."). */
const CODE_RE = /^\s*([A-Z]{1,3}\d{3,5})\s*:\s*/;

/** A file-less error-list item that only says a project's build failed (a summary, not a message). */
const SUMMARY_ITEM_RE = /\b(?:build|erstellen|erstellung)\b.*\b(?:failed|fehlgeschlagen)\b|\b(?:failed|fehlgeschlagen)\b.*\b(?:build|erstellen|erstellung)\b/i;

/**
 * @typedef {Object} XaeErrorItem One item of the XAE error list as the driver reported it, or one
 *   message parsed from an output pane.
 * @property {string|null} file A list item's may end in a pane suffix: `<path> (Impl)`.
 * @property {number|null} line
 * @property {number|null} column
 * @property {string} description
 * @property {string|null} project
 * @property {string|null} level e.g. `vsBuildErrorLevelHigh`, or a pane level word; null when absent.
 * @property {string|null} [code] The compiler code (`C0189`), when known.
 * @property {'pane'|'file'|'object'} [lineBase] What `line` counts; a pane message carries `PANE_LINE_BASE`.
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
 * @property {string|null} code The compiler code, when known.
 */

/**
 * @typedef {Object} PlacementDeps
 * @property {(p: string) => string} readFile
 * @property {(p: string) => boolean} exists
 * @property {(p: string) => string} [canonical] The path as the file system spells it (Windows:
 *   `fs.realpathSync.native`), so a Problems entry uses the workspace's own casing.
 * @property {string} [slnDir] Relative file names are resolved against it.
 * @property {'pane'|'file'|'object'} [lineBase] What an error-list item's line counts; default `pane`.
 * @property {(text: string) => any} [parseXml] Default xmlParser.parseTwinCatXml.
 * @property {(text: string) => ({lineMap: Object}|null)} [toUnit] Default livePath.assembleSt (raw mode).
 */

/**
 * The severity of an error-list level (`vsBuildErrorLevelHigh/Medium/Low`) or a pane level word.
 * @param {string|null} level
 * @returns {'error'|'warning'|'info'}
 */
function severityOf(level) {
    const l = String(level || '').toLowerCase();
    if (/medium|warn/.test(l)) return 'warning';
    if (/low|info|message|meldung|hinweis/.test(l)) return 'info';
    return 'error';
}

/**
 * How many items are errors, warnings and messages (by `severityOf`), not counting empty items and
 * build-failed summaries. `placeXaeErrors` counts its de-duplicated messages itself; this is for a
 * caller that has only the raw list.
 * @param {Array<{level: string|null, file?: string|null, description?: string}>} items
 * @returns {{errors: number, warnings: number, infos: number}}
 */
function countBySeverity(items) {
    const n = { errors: 0, warnings: 0, infos: 0 };
    for (const it of items) {
        if (isEmptyItem(it) || isSummaryItem(it)) continue;
        const s = severityOf(it.level);
        if (s === 'error') n.errors++;
        else if (s === 'warning') n.warnings++;
        else n.infos++;
    }
    return n;
}

/**
 * An error-list item with neither a description nor a file (what the headless 4026 run returned).
 * @param {{file?: string|null, description?: string}} it
 * @returns {boolean}
 */
function isEmptyItem(it) {
    return !String(it.description || '').trim() && !String(it.file || '').trim();
}

/**
 * A file-less "Project '...' build for platform '...' failed." item: a summary, not a message.
 * @param {{file?: string|null, description?: string}} it
 * @returns {boolean}
 */
function isSummaryItem(it) {
    return !String(it.file || '').trim() && SUMMARY_ITEM_RE.test(String(it.description || ''));
}

/**
 * Joins a wrapped continuation onto a message: inside an open quote (an odd number of `'` so far)
 * the line break belonged to the quoted code and is dropped, elsewhere it becomes a space.
 * @param {string} text
 * @param {string} more
 * @returns {string}
 */
function joinContinuation(text, more) {
    const insideQuote = ((text.match(/'/g) || []).length % 2) === 1;
    return insideQuote ? text + more.trim() : `${text.trimEnd()} ${more.trim()}`;
}

/**
 * A Problems entry's text: one line (an XAE description can break inside quoted code, as in
 * `The code 'h;<newline>' has no effect`), without the leading `Cnnnn:`, which Problems shows as
 * the entry's code.
 * @param {string} text
 * @param {string|undefined} code
 * @returns {string}
 */
function problemText(text, code) {
    const lines = String(text || '').split(/\r?\n/);
    let one = lines.shift() || '';
    for (const more of lines) one = joinContinuation(one, more);
    return code ? one.replace(CODE_RE, '') : one;
}

/**
 * The located messages of an output pane ("Build"): see `PANE_MESSAGE_RE` / `PANE_STOP_RE`. Each
 * carries `lineBase: PANE_LINE_BASE`. Lines without a location (summaries, "Fehler: Unbekannter
 * Fehler" from the solution-level build) are not messages; they stay in the channel only.
 * @param {string} text
 * @returns {XaeErrorItem[]}
 */
function parseOutputPaneLines(text) {
    /** @type {XaeErrorItem[]} */
    const out = [];
    /** @type {{item: XaeErrorItem, body: string, more: number}|null} */
    let open = null;
    const close = () => {
        if (!open) return;
        const body = open.body.trim();
        open.item.description = open.item.code ? `${open.item.code}: ${body}` : body;
        out.push(open.item);
        open = null;
    };
    for (const raw of String(text || '').split(/\r?\n/)) {
        const m = PANE_MESSAGE_RE.exec(raw);
        if (m) {
            close();
            open = {
                item: {
                    file: m[1].trim(), line: Number(m[2]), column: m[3] ? Number(m[3]) : null, description: '',
                    project: null, level: m[4].toLowerCase(), code: m[5] ? m[5].toUpperCase() : null, lineBase: PANE_LINE_BASE
                },
                body: m[6], more: 0
            };
            continue;
        }
        if (!open) continue;
        if (PANE_STOP_RE.test(raw) || open.more >= MAX_CONTINUATION) { close(); continue; }
        open.body = joinContinuation(open.body, raw);
        open.more++;
    }
    close();
    return out;
}

/**
 * Splits an error-list file name into the path and its pane suffix: `<path> (Impl)`, `(Decl)`, and
 * tolerantly a component name in it (`(M_Foo Impl)`, `(FB.M_Foo Decl)`, `(State Get Impl)`).
 * @param {string|null} file
 * @returns {{file: string|null, pane: 'decl'|'impl'|null, component: string|null}}
 */
function splitFileSuffix(file) {
    // `<path>.TcPOU@<Component>` names a child (method, action, property accessor): seen on Windows
    // 2026-11-13 as `...\FB_StationDerived.TcPOU@Cyclic (Impl)`; the pane suffix may follow.
    const m = file ? /^(.*?\.(?:TcPOU|TcGVL|TcDUT|TcIO))(?:@([^()]*?))?\s*(?:\(([^()]*)\))?\s*$/i.exec(file) : null;
    if (!m) return { file, pane: null, component: null };
    const inner = m[3] || '';
    /** @type {'decl'|'impl'|null} */
    let pane = null;
    if (/\b(?:Impl|Implementation|Implementierung)\b/i.test(inner)) pane = 'impl';
    else if (/\b(?:Decl|Declaration|Deklaration)\b/i.test(inner)) pane = 'decl';
    const fromParens = inner.replace(/\b(?:Impl|Implementation|Implementierung|Decl|Declaration|Deklaration)\b/ig, ' ')
        .replace(/[\s,;:]+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
    const fromAt = (m[2] || '').trim().replace(/^\.+|\.+$/g, '');
    const component = fromAt || fromParens;
    return { file: m[1].trim(), pane, component: component || null };
}

/**
 * The object file an item names, if it exists: the path as given (absolute, or relative to the
 * `.sln` directory), else - for a path from another root, e.g. a fixture's - its longest tail of at
 * least two segments that exists under the `.sln` directory.
 * @param {string|null} file
 * @param {PlacementDeps} deps
 * @returns {string|null}
 */
function resolveObjectFile(file, deps) {
    if (!file || !OBJECT_FILE_RE.test(file)) return null;
    // XAE reports Windows paths; the separators are made native so the tests can run anywhere.
    const segs = file.split(/[\\/]/).filter(Boolean);
    const native = file.split(/[\\/]/).join(path.sep);
    const candidates = path.isAbsolute(native) ? [native] : (deps.slnDir ? [path.join(deps.slnDir, native)] : []);
    if (deps.slnDir) for (let i = 1; i <= segs.length - 2; i++) candidates.push(path.join(deps.slnDir, ...segs.slice(i)));
    for (const c of candidates) {
        let hit = false;
        try { hit = deps.exists(c); } catch (e) { /* not there */ }
        if (!hit) continue;
        if (deps.canonical) { try { return deps.canonical(c); } catch (e) { /* keep c */ } }
        return c;
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
    const root = comps.find((/** @type {any} */ c) => c.id === 'root') || comps[0];
    for (const c of comps) {
        if (c.id === 'root') continue;
        const name = memberName(c.id);
        if (root && root.name && new RegExp(`\\b${escapeRe(root.name)}\\.${escapeRe(name)}\\b`, 'i').test(description)) return c;
    }
    return root;
}

/**
 * The component a pane suffix names (`M_Foo`, `FB.M_Foo`, `State Get`), or null when none matches.
 * @param {any} parsed
 * @param {string} name
 * @returns {any}
 */
function componentBySuffix(parsed, name) {
    const comps = parsed.components || [];
    const root = comps.find((/** @type {any} */ c) => c.id === 'root') || comps[0];
    let n = name.trim();
    if (root && root.name && n.toLowerCase() === String(root.name).toLowerCase()) return root;
    if (root && root.name && n.toLowerCase().startsWith(String(root.name).toLowerCase() + '.')) n = n.slice(String(root.name).length + 1);
    const acc = /^(.+?)[\s._]+(get|set)$/i.exec(n);
    const want = (acc ? `${acc[1]}_${acc[2]}` : n).toLowerCase();
    return comps.find((/** @type {any} */ c) => c.id !== 'root' && memberName(c.id).toLowerCase() === want) || null;
}

/** @param {string} s @returns {string} */
function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The number of lines of a pane's text, as the object numbering counts them (a trailing line break
 * opens one more, empty line: MAIN's 6-line declaration plus its final CRLF counts 7).
 * @param {unknown} text
 * @returns {number}
 */
function lineCount(text) {
    return typeof text === 'string' ? text.split(/\r\n|\r|\n/).length : 0;
}

/** The same message, whatever the whitespace or a leading code: for de-duplication. @param {string} s */
function normMessage(s) {
    return String(s || '').replace(CODE_RE, '').replace(/\s+/g, '').toLowerCase();
}

/**
 * Places the XAE build's errors: the error list's items and the messages parsed from the output
 * panes, de-duplicated (the same message at the same place is kept once, the exact one preferred).
 * @param {XaeErrorItem[]} errorItems
 * @param {Array<{name: string, text: string}>} panes
 * @param {PlacementDeps} deps
 * @returns {{byFile: Map<string, XaeProblem[]>, general: Array<XaeErrorItem & {severity: 'error'|'warning'|'info'}>,
 *   notes: XaeErrorItem[], placed: number, total: number, errors: number, warnings: number, infos: number}}
 */
function placeXaeErrors(errorItems, panes, deps) {
    const parseXml = deps.parseXml || parseTwinCatXml;
    const toUnit = deps.toUnit || ((/** @type {string} */ text) => assembleSt(text, null));
    /** @type {XaeErrorItem[]} */
    const notes = [];
    /** @type {Array<{item: XaeErrorItem, origin: string}>} Where each came from: the list, or a pane by name. */
    const sources = [];
    for (const it of errorItems) {
        if (isEmptyItem(it)) continue;
        if (isSummaryItem(it)) notes.push(it);
        else sources.push({ item: it, origin: 'list' });
    }
    for (const p of panes) for (const it of parseOutputPaneLines(p.text)) sources.push({ item: it, origin: `pane:${p.name}` });

    /** @type {Map<string, any>} */
    const parsedCache = new Map();
    const parsedOf = (/** @type {string} */ filePath) => {
        if (!parsedCache.has(filePath)) {
            /** @type {string|null} */
            let text;
            try { text = deps.readFile(filePath); } catch (e) { text = null; }
            const parsed = text === null ? null : parseXml(text);
            parsedCache.set(filePath, parsed ? { text, parsed } : null);
        }
        return parsedCache.get(filePath);
    };

    /**
     * @typedef {{item: XaeErrorItem, origin: string, severity: 'error'|'warning'|'info', code: string|null, filePath: string|null,
     *   at: {componentId: string, pane: 'decl'|'impl', line: number}|null, exact: boolean}} Rec
     */
    /** @type {Map<string, Rec>} */
    const seen = new Map();
    for (const { item, origin } of sources) {
        const suffix = splitFileSuffix(item.file);
        const filePath = resolveObjectFile(suffix.file, deps);
        const entry = filePath ? parsedOf(filePath) : null;
        const descCode = CODE_RE.exec(item.description || '');
        /** @type {Rec} */
        const rec = {
            item, origin, severity: severityOf(item.level), code: item.code || (descCode ? descCode[1] : null),
            filePath: entry ? filePath : null, at: null, exact: false
        };
        if (entry) placeOne(rec, entry, suffix, item.lineBase || deps.lineBase || 'pane', toUnit);
        const key = rec.at
            ? ['p', String(rec.filePath).toLowerCase(), rec.at.componentId, rec.at.pane, rec.at.line, normMessage(item.description)].join('|')
            : ['g', String(suffix.file || '').toLowerCase(), normMessage(item.description)].join('|');
        const prev = seen.get(key);
        // Only different sources repeat each other: within one, every message counts.
        if (!prev || prev.origin === origin) { seen.set(seen.has(key) ? `${key}|${seen.size}` : key, rec); continue; }
        if (!prev.exact && rec.exact) { rec.code = rec.code || prev.code; seen.set(key, rec); }
        else prev.code = prev.code || rec.code;
    }
    // An approximate copy (a child's pane line, whose numbering is unconfirmed) of a message another
    // source placed exactly in the same component is the same message: keep the exact one only.
    const loose = (/** @type {Rec} */ r) => r.at ? [String(r.filePath).toLowerCase(), r.at.componentId, normMessage(r.item.description)].join('|') : null;
    const exactBy = new Map();
    for (const r of seen.values()) { const k = loose(r); if (k && r.exact) exactBy.set(k, r); }
    for (const [k, r] of [...seen.entries()]) {
        const lk = loose(r);
        const twin = lk && !r.exact ? exactBy.get(lk) : null;
        if (twin && twin.origin !== r.origin) { twin.code = twin.code || r.code; seen.delete(k); }
    }

    /** @type {Map<string, XaeProblem[]>} */
    const byFile = new Map();
    /** @type {Array<XaeErrorItem & {severity: 'error'|'warning'|'info'}>} */
    const general = [];
    const n = { errors: 0, warnings: 0, infos: 0 };
    let placed = 0;
    for (const rec of seen.values()) {
        if (rec.severity === 'error') n.errors++;
        else if (rec.severity === 'warning') n.warnings++;
        else n.infos++;
        const description = rec.code && !CODE_RE.test(rec.item.description) ? `${rec.code}: ${rec.item.description}` : rec.item.description;
        if (!rec.at || !rec.filePath) { general.push({ ...rec.item, description, severity: rec.severity }); continue; }
        const column = rec.item.column && rec.item.column > 0 ? rec.item.column : 1;
        if (!byFile.has(rec.filePath)) byFile.set(rec.filePath, []);
        /** @type {XaeProblem[]} */ (byFile.get(rec.filePath)).push({
            filePath: rec.filePath, componentId: rec.at.componentId, pane: rec.at.pane, line: rec.at.line, column,
            endLine: rec.at.line, endColumn: column, severity: rec.severity,
            message: problemText(description, rec.code) + (rec.exact ? '' : APPROXIMATE_NOTE), exact: rec.exact, code: rec.code
        });
        placed++;
    }
    return { byFile, general, notes, placed, total: seen.size, ...n };
}

/**
 * Sets `rec.at` / `rec.exact` for an item whose object file is known.
 * @param {{item: XaeErrorItem, at: any, exact: boolean}} rec
 * @param {{text: string, parsed: any}} entry
 * @param {{pane: 'decl'|'impl'|null, component: string|null}} suffix
 * @param {'pane'|'file'|'object'} lineBase
 * @param {(text: string) => ({lineMap: Object}|null)} toUnit
 */
function placeOne(rec, entry, suffix, lineBase, toUnit) {
    const { item } = rec;
    const comps = entry.parsed.components || [];
    const named = suffix.component ? componentBySuffix(entry.parsed, suffix.component) : null;
    const comp = named || componentNamed(entry.parsed, item.description);
    const marker = suffix.pane || sectionMarker(item.description);
    if (item.line && item.line > 0 && comp) {
        if (lineBase === 'file') {
            const unit = toUnit(entry.text);
            const local = unit ? absoluteToLocal(unit.lineMap, item.line - 1) : null;
            if (local) { rec.at = { componentId: local.componentId, pane: local.pane, line: local.localLine0 + 1 }; rec.exact = true; }
        } else if (lineBase === 'object') {
            // Declaration lines first, then the implementation's, counted as one text.
            const declLines = lineCount(comp.declaration);
            const implLines = lineCount(comp.implementation);
            if (item.line <= declLines) rec.at = { componentId: comp.id, pane: 'decl', line: item.line };
            else if (item.line - declLines <= implLines) rec.at = { componentId: comp.id, pane: 'impl', line: item.line - declLines };
            // Confirmed only for an object's own body: with child components the line may be a child's.
            rec.exact = !!rec.at && comp.id === 'root' && comps.length === 1;
        } else {
            const hasImpl = typeof comp.implementation === 'string';
            rec.at = { componentId: comp.id, pane: marker || (hasImpl ? 'impl' : 'decl'), line: item.line };
            rec.exact = marker !== null && (!suffix.component || !!named);
        }
    }
    if (!rec.at) {
        // The file is known, the line is not.
        rec.at = { componentId: comp ? comp.id : 'root', pane: marker || 'decl', line: 1 };
        rec.exact = false;
    }
}

/**
 * The run summary's sentence about the errors, counted by severity (warnings and messages are not
 * called errors).
 * @param {{placed: number, total: number, errors?: number, warnings?: number, infos?: number}} placement
 * @param {number} exitCode
 * @param {string} channelName
 * @returns {string}
 */
function placementSummary(placement, exitCode, channelName) {
    if (exitCode === 1 && placement.total === 0) return `XAE named no error with a file and line; see '${channelName}'.`;
    if (placement.total === 0) return '';
    const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const errors = placement.errors === undefined ? placement.total : placement.errors;
    const warnings = placement.warnings || 0;
    const infos = placement.infos || 0;
    const parts = [];
    if (errors > 0 || (warnings === 0 && infos === 0)) parts.push(plural(errors, 'error'));
    if (warnings > 0) parts.push(plural(warnings, 'warning'));
    if (infos > 0) parts.push(plural(infos, 'message'));
    return `${parts.join(', ')} (${placement.placed} placed in Problems).`;
}

module.exports = {
    OBJECT_FILE_RE, APPROXIMATE_NOTE, PANE_LINE_BASE, severityOf, countBySeverity, isEmptyItem, isSummaryItem,
    parseOutputPaneLines, splitFileSuffix, sectionMarker, placeXaeErrors, placementSummary, problemText
};
