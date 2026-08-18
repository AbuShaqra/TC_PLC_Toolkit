/**
 * @file editorMapping.js
 * @description Pure coordinate and peek-model helpers shared by the editor host and its harness.
 */

const { fileUriBasename } = require('./fileUri');

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
    const member = componentId === 'root'
        ? 'root'
        : String(componentId).replace(/^(method|prop|action|trans|get|set)_/i, '');
    return `/${member}.${pane}/${base}`;
}

module.exports = { localToAbsolute, absoluteToLocal, paneTextFromUnit, peekPath };
