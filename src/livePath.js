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

/**
 * Resolves a raw LSP definition answer to an exact (component, pane, local line). Without this the
 * webview only knew a file, a component and a NAME, and fell back to a first-match word search —
 * which lands on the name's first appearance in the declaration pane. In an FB whose header comment
 * mentions its own outputs ("…until bDone or bError"), that is a line of prose in a comment, not the
 * declaration.
 *
 * The target may live in another file, so its own unit is what the range must be mapped against;
 * resolveSt (from createStResolver) reads and converts it.
 * @param {Object|null} definition Raw definition from twincat.lsp.queryDefinition ({ uri, range, ... }), or null.
 * @param {Function} resolveSt Resolver from createStResolver.
 * @returns {Promise<Object|null>} definition, augmented with componentId/pane/localLine when resolvable; unchanged otherwise.
 */
async function mapDefinition(definition, resolveSt) {
    if (!(definition && definition.uri && definition.range)) return definition;
    const entry = await resolveSt(definition.uri);
    const loc = entry ? absoluteToLocal(entry.st.lineMap, definition.range.start.line) : null;
    if (!loc) return definition;
    // componentId comes from the same mapping as pane/localLine so the three can never disagree; it
    // matches what the LSP reports.
    return Object.assign({}, definition, {
        componentId: loc.componentId,
        pane: loc.pane,
        localLine: loc.localLine0
    });
}

/**
 * Resolves a Find References answer to peek data: every reference — in this component, another
 * component of this file, or another file entirely — is resolved to a (file, component, pane, local
 * line) so the webview can render it in the peek. A location whose URI has no loaded model makes
 * Monaco throw "Model not found", so each pane that is not one of the live editors ships its TEXT
 * too and the webview builds a hidden model from it.
 *
 * This reads and converts the referenced files, which listExternalReferences then does again for the
 * panel. Kept as two passes deliberately: merging them would restructure the panel path for a few ms
 * on a handful of files, and maxPanes already bounds the work here to the files the preview can
 * actually show.
 * @param {Array<Object>} refs Raw references from twincat.lsp.queryReferences.
 * @param {Object} opts { activeUri, resolveSt, maxPanes, maxTextBytes }
 * @param {string} opts.activeUri URI of the document this request came from (for `sameFile`).
 * @param {Function} opts.resolveSt Resolver from createStResolver.
 * @param {number} [opts.maxPanes] Cap on distinct (file, component, pane) peek models materialised.
 * @param {number} [opts.maxTextBytes] Cap on total pane text bytes materialised.
 * @returns {Promise<{references: Array<Object>, panes: Array<Object>}>}
 */
async function collectPeekReferences(refs, { activeUri, resolveSt, maxPanes = PEEK_MAX_PANES, maxTextBytes = PEEK_MAX_TEXT_BYTES }) {
    const mapped = [];
    // The cap below counts FILES already opened, so the resolver's own cache is not enough — this
    // pass needs to know whether a file has been seen yet.
    const stCache = new Map();
    const getSt = async (uri) => {
        const key = normalizeFileUri(uri);
        const result = await resolveSt(uri);
        stCache.set(key, result);
        return result;
    };

    const paneByKey = new Map();
    let textBudget = maxTextBytes;
    for (const r of (refs || [])) {
        if (!r || !r.uri) continue;
        const key = normalizeFileUri(r.uri);
        // Stop opening NEW files once the preview is full; already-read ones still resolve, so the
        // cap bounds file reads, not just models.
        if (!stCache.has(key) && paneByKey.size >= maxPanes) continue;
        const entry = await getSt(r.uri);
        if (!entry) continue;
        const loc = absoluteToLocal(entry.st.lineMap, r.range.start.line);
        if (!loc) continue;

        const paneKey = `${key}::${loc.componentId}::${loc.pane}`;
        if (!paneByKey.has(paneKey) && paneByKey.size < maxPanes) {
            const text = paneTextFromUnit(entry.lines, entry.st.lineMap, loc.componentId, loc.pane);
            if (text !== null && text.length <= textBudget) {
                textBudget -= text.length;
                paneByKey.set(paneKey, {
                    key: paneKey,
                    uri: r.uri,
                    componentId: loc.componentId,
                    pane: loc.pane,
                    path: peekPath(r.uri, loc.componentId, loc.pane),
                    text: text
                });
            }
        }

        mapped.push({
            sameFile: key === normalizeFileUri(activeUri),
            uri: r.uri,
            paneKey: paneKey,
            componentId: loc.componentId,
            pane: loc.pane,
            line: loc.localLine0,
            startCharacter: r.range.start.character,
            endCharacter: r.range.end.character
        });
    }
    return { references: mapped, panes: [...paneByKey.values()] };
}

/**
 * Resolves a Find References answer to a flat list of navigable items for the References panel:
 * (file, component, line text, target word). Cross-file references can't render in the webview
 * peek, so the panel is the only place they're listed.
 *
 * Caches the split lines alongside the converted ST via resolveSt: the line lookup below runs once
 * per reference, and splitting the whole unit each time made a search with many hits in one file
 * re-split that file's entire text for every one of them.
 * @param {Array<Object>} refs Raw references from twincat.lsp.queryReferences.
 * @param {Function} resolveSt Resolver from createStResolver.
 * @returns {Promise<{items: Array<Object>, searchedWord: string}>}
 */
async function listExternalReferences(refs, resolveSt) {
    const items = [];
    let searchedWord = '';
    for (const r of (refs || [])) {
        const entry = await resolveSt(r.uri);
        if (!entry) continue;
        const st = entry.st;
        const lines = entry.lines;
        const lineText = (lines[r.range.start.line] || '').trim();
        const targetWord = (lines[r.range.start.line] || '').substring(r.range.start.character, r.range.end.character);
        if (!searchedWord) searchedWord = targetWord;
        const loc = absoluteToLocal(st.lineMap, r.range.start.line);
        // Carry the exact location (pane + local line + start/end columns) so the References panel
        // can navigate to the precise occurrence instead of relying on a first-match word search
        // (which lands on the wrong hit when the same word appears earlier in the target component).
        // `line` stays absolute for the .st navigation branch; pane/localLine are null when outside
        // any block.
        items.push({
            uri: r.uri,
            componentId: loc ? loc.componentId : 'root',
            targetWord: targetWord,
            lineText: lineText,
            line: r.range.start.line,
            pane: loc ? loc.pane : null,
            localLine: loc ? loc.localLine0 : null,
            startCharacter: r.range.start.character,
            endCharacter: r.range.end.character
        });
    }
    return { items, searchedWord };
}

module.exports = {
    assembleSt,
    localToAbsolute,
    absoluteToLocal,
    paneTextFromUnit,
    peekPath,
    createStResolver,
    mapDefinition,
    collectPeekReferences,
    listExternalReferences,
    PEEK_MAX_PANES,
    PEEK_MAX_TEXT_BYTES
};
