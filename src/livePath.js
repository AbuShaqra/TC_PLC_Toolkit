/**
 * @file livePath.js
 * @description The live language-feature path, as one vscode-free module: assemble a TwinCAT XML
 * object into a single Structured Text compilation unit (webview overlay applied), map pane-local
 * coordinates to unit coordinates and back, slice pane texts, build peek-model paths, and resolve
 * other files' units through an injected reader. The custom editor host and the harnesses drive
 * the SAME functions — this file exists so the live-path regression gate tests shipped code.
 */

const { parseTwinCatXml } = require('./xmlParser');
const { convertXmlToSt } = require('./stConverter');
const { normalizeFileUri, fileUriBasename } = require('./fileUri');
const { memberName } = require('./componentId');

/**
 * Assembles the full document as a single Structured Text compilation unit, applying the
 * webview's live (unsaved) edits for the active component as an overlay so the LSP sees a
 * complete, valid POU/GVL/DUT — giving methods/properties/actions correct scope.
 * @param {string} xmlText The backing XML document's text.
 * @param {Object} overlay { componentId, decl?, impl? } live edits for the active component.
 * @returns {Object|null} { stText, lineMap } or null if the document could not be parsed.
 */
function assembleSt(xmlText, overlay) {
    const parsed = parseTwinCatXml(xmlText);
    if (!parsed) return null;
    if (overlay && overlay.componentId) {
        const comp = parsed.components.find(c => c.id === overlay.componentId);
        if (comp) {
            if (typeof overlay.decl === 'string' && comp.declaration !== null && comp.declaration !== undefined) {
                comp.declaration = overlay.decl;
            }
            if (typeof overlay.impl === 'string' && comp.implementation !== null && comp.implementation !== undefined) {
                comp.implementation = overlay.impl;
            }
        }
    }
    // raw: keep declarations/implementations verbatim so the lineMap matches the editor content 1:1.
    return convertXmlToSt(parsed, { raw: true });
}

function localToAbsolute(lineMap, componentId, pane, lineNumber, column) {
    const blocks = lineMap[componentId];
    if (!blocks) return null;
    const block = pane === 'decl' ? blocks.decl : blocks.impl;
    if (!block || !block.start) return null;
    return { line: (block.start - 1) + (lineNumber - 1), character: column - 1 };
}

function absoluteToLocal(lineMap, absLine0) {
    const line1 = absLine0 + 1;
    for (const componentId of Object.keys(lineMap)) {
        const blocks = lineMap[componentId];
        if (blocks.decl && blocks.decl.start && line1 >= blocks.decl.start && line1 <= blocks.decl.end) {
            return { componentId, pane: 'decl', localLine0: line1 - blocks.decl.start };
        }
        if (blocks.impl && blocks.impl.start && line1 >= blocks.impl.start && line1 <= blocks.impl.end) {
            return { componentId, pane: 'impl', localLine0: line1 - blocks.impl.start };
        }
    }
    return null;
}

function paneTextFromUnit(stLines, lineMap, componentId, pane) {
    const blocks = lineMap && lineMap[componentId];
    if (!blocks) return null;
    const block = pane === 'decl' ? blocks.decl : blocks.impl;
    if (!block || !block.start) return null;
    return stLines.slice(block.start - 1, block.end).join('\n');
}

function peekPath(fileUri, componentId, pane) {
    let base = 'object';
    try { base = fileUriBasename(fileUri) || base; } catch (e) { /* keep default */ }
    return `/${memberName(componentId)}.${pane}/${base}`;
}

/**
 * Builds a per-request resolver from a file URI to its assembled ST unit.
 *
 * Every navigation feature has the same problem: the LSP answers in absolute lines of a unit, and
 * that unit belongs to whichever file the symbol lives in — which is often not the open one. The
 * active document is already assembled (unsaved edits included) and must be reused rather than
 * re-read; anything else is read from disk and converted. Results are cached per request because a
 * search with many hits in one file would otherwise re-read and re-split it once per hit.
 *
 * Note the consequence, unchanged from before: another file is read from DISK, so a target inside a
 * file with unsaved edits in some other tab is located against the SAVED text.
 * @param {Object} opts { activeUri, activeUnit, readFile }
 * @param {string} opts.activeUri URI of the document this request came from.
 * @param {Object} opts.activeUnit Its assembled unit ({ stText, lineMap }) from assembleSt.
 * @param {Function} opts.readFile async (uriString) => string, reading a file's raw text.
 * @returns {Function} async (uri) => { st, lines } for that file, or null when it is unreadable.
 */
function createStResolver({ activeUri, activeUnit, readFile }) {
    const cache = new Map();
    return async function getSt(uri) {
        const key = normalizeFileUri(uri);
        if (cache.has(key)) return cache.get(key);
        let result = null;
        if (key === normalizeFileUri(activeUri)) {
            result = { st: activeUnit, lines: activeUnit.stText.split('\n') };
        } else {
            try {
                const text = await readFile(uri);
                const parsed = parseTwinCatXml(text);
                if (parsed) {
                    const converted = convertXmlToSt(parsed, { raw: true });
                    result = { st: converted, lines: converted.stText.split('\n') };
                }
            } catch (e) { /* unreadable: the caller degrades, it never guesses */ }
        }
        cache.set(key, result);
        return result;
    };
}

/**
 * Ceilings on what one Find References may materialise as peek models. A symbol used in a hundred
 * files would otherwise read, convert and hold a hundred panes — the peek is a preview, and the
 * References panel already lists every hit without any of this cost. Refs past the cap simply get
 * no peek entry, which is exactly the behaviour the whole feature started from.
 */
const PEEK_MAX_PANES = 50;
const PEEK_MAX_TEXT_BYTES = 2 * 1024 * 1024;

module.exports = {
    assembleSt,
    localToAbsolute,
    absoluteToLocal,
    paneTextFromUnit,
    peekPath,
    createStResolver,
    PEEK_MAX_PANES,
    PEEK_MAX_TEXT_BYTES
};
