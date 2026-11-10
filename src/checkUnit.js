/**
 * @file checkUnit.js
 * @description The "check" unit behind Compile Project (roadmap R3.2): one Structured Text
 * compilation unit per TwinCAT object, shaped for an external IEC 61131-3 compiler, plus a map from
 * EVERY emitted line back to the pane it came from.
 *
 * It is deliberately NOT the live path's unit (`convertXmlToSt(…, { raw: true })`, guarded by
 * test/test_live_path.js) and NOT the export (`convertXmlToSt` clean mode, which rewrites
 * `REFERENCE TO`/`REF=` and so changes meaning). The differences from the live unit:
 *   - members (methods, properties, actions) are written BEFORE the POU body — the compiler accepts
 *     them only there;
 *   - no header comment and no separator lines: every line is either pane text, verbatim, or one of
 *     a handful of generated keywords (`END_METHOD`, `GET`, `ACTION x`, `END_FUNCTION_BLOCK` …);
 *   - the map is per line, not per range, so a generated line has an answer too.
 *
 * Pane text is never rewritten: a column the compiler reports is the column in the pane. Pragmas
 * stay in place (the compiler skips `{attribute '…'}` with a warning, which the caller filters).
 *
 * vscode-free and side-effect-free, so test/test_check_unit.js runs it under plain Node.
 */

'use strict';

/**
 * @typedef {Object} CheckLineOrigin Where one emitted line came from.
 * @property {string} componentId The component (`root`, `method_X`, `prop_X_get` …).
 * @property {'decl'|'impl'} pane The pane, in the system's one pane dialect.
 * @property {number} line 1-based line in that pane.
 * @property {boolean} generated True for a line the emitter wrote itself (`END_METHOD` …). Its
 *   origin is the nearest real pane line of the component that owns it, so a diagnostic on it still
 *   lands somewhere the user can see.
 */

/**
 * @typedef {Object} CheckUnit
 * @property {string} stText The unit's text, lines joined with `\n`.
 * @property {string[]} lines The unit's lines.
 * @property {CheckLineOrigin[]} origins `origins[i]` is the origin of `lines[i]` — same length.
 * @property {string} rootType `POU` | `GVL` | `DUT` | `Itf`.
 * @property {string} rootName The object's name.
 * @property {string|null} globalListName The global variable list's name (a GVL), else null. The
 *   compiler needs it to resolve `GVL_Name.variable`.
 * @property {string[]} skipped Members that are not in the unit (SFC transitions), one line each.
 */

/**
 * Splits pane text into the lines the pane shows. An empty pane contributes no line to the unit.
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
function paneLines(text) {
    if (text === null || text === undefined || text === '') return [];
    return String(text).split(/\r\n|\r|\n/);
}

/**
 * The POU keyword that opens a root declaration — the first of FUNCTION_BLOCK / PROGRAM / FUNCTION
 * outside comments and pragmas.
 * @param {string} declText Root declaration text.
 * @returns {string|null}
 */
function leadingPouKeyword(declText) {
    const code = (declText || '')
        .replace(/\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|\/\/[^\n]*|\{[^}]*\}/g, ' ');
    const m = /\b(FUNCTION_BLOCK|PROGRAM|FUNCTION)\b/i.exec(code);
    return m ? m[1].toUpperCase() : null;
}

/**
 * Builds the check unit of one parsed TwinCAT object.
 * @param {any} parsed The result of parseTwinCatXml (with any unsaved edits already applied).
 * @returns {CheckUnit|null} null when there is nothing to check (no root component).
 */
function buildCheckUnit(parsed) {
    if (!parsed || !Array.isArray(parsed.components)) return null;
    const root = parsed.components.find(c => c.id === 'root');
    if (!root) return null;

    /** @type {string[]} */
    const lines = [];
    /** @type {CheckLineOrigin[]} */
    const origins = [];
    /** @type {string[]} */
    const skipped = [];
    /** Pane line counts, for anchoring generated lines: `${componentId}:${pane}` → count. */
    const counts = new Map();

    /**
     * Emits one pane verbatim.
     * @param {any} comp
     * @param {'decl'|'impl'} pane
     */
    const emitPane = (comp, pane) => {
        const text = pane === 'decl' ? comp.declaration : comp.implementation;
        const parts = paneLines(text);
        counts.set(`${comp.id}:${pane}`, parts.length);
        parts.forEach((part, i) => {
            lines.push(part);
            origins.push({ componentId: comp.id, pane, line: i + 1, generated: false });
        });
    };

    /**
     * Emits one generated line, anchored on the LAST real line of the owner's pane (`atEnd`) or on
     * its first. A pane with no text still has line 1 in the editor, so the anchor always exists.
     * @param {string} text
     * @param {any} owner The component the line belongs to.
     * @param {'decl'|'impl'} pane
     * @param {boolean} atEnd
     */
    const emitGenerated = (text, owner, pane, atEnd) => {
        const count = counts.get(`${owner.id}:${pane}`) || 0;
        lines.push(text);
        origins.push({ componentId: owner.id, pane, line: atEnd ? Math.max(1, count) : 1, generated: true });
    };

    /** The pane a component's closing keyword is anchored on: its body when it has one. */
    const closingPane = (comp) => (typeof comp.implementation === 'string' ? 'impl' : 'decl');

    const members = parsed.components.filter(c => c.id !== 'root');
    const isItf = parsed.rootType === 'Itf';

    emitPane(root, 'decl');

    if (parsed.rootType === 'POU' || isItf) {
        const seenProperties = new Set();
        for (const comp of members) {
            if (comp.type === 'Method') {
                emitPane(comp, 'decl');
                // An interface method is a signature only.
                if (!isItf) emitPane(comp, 'impl');
                emitGenerated('END_METHOD', comp, isItf ? 'decl' : closingPane(comp), true);
            } else if (comp.type === 'Action') {
                emitGenerated(`ACTION ${comp.name}`, comp, 'impl', false);
                emitPane(comp, 'impl');
                emitGenerated('END_ACTION', comp, 'impl', true);
            } else if (comp.type === 'Property' || comp.type === 'Get' || comp.type === 'Set') {
                const propName = comp.xmlContext && comp.xmlContext.subName;
                if (seenProperties.has(propName)) continue;
                seenProperties.add(propName);
                const ofProperty = (/** @type {string} */ type) =>
                    members.find(c => c.type === type && c.xmlContext && c.xmlContext.subName === propName);
                const signature = ofProperty('Property');
                // An accessor without its property signature cannot be written as valid ST; the
                // parser always yields the signature first, so this is only a guard.
                if (!signature) continue;
                emitPane(signature, 'decl');
                for (const type of ['Get', 'Set']) {
                    const accessor = ofProperty(type);
                    if (!accessor) continue;
                    const keyword = type.toUpperCase();
                    if (isItf) {
                        emitGenerated(keyword, signature, 'decl', true);
                        emitGenerated(`END_${keyword}`, signature, 'decl', true);
                        continue;
                    }
                    const first = paneLines(accessor.declaration).length > 0 ? 'decl' : 'impl';
                    // Anchored before its panes are emitted, so the counts are not known yet: the
                    // opening keyword always points at line 1 of the accessor's first pane.
                    emitGenerated(keyword, accessor, first, false);
                    emitPane(accessor, 'decl');
                    emitPane(accessor, 'impl');
                    emitGenerated(`END_${keyword}`, accessor, closingPane(accessor), true);
                }
                emitGenerated('END_PROPERTY', signature, 'decl', true);
            } else if (comp.type === 'Transition') {
                // An SFC transition is a condition attached to a chart step; a single ST unit has
                // nowhere to put it, so it is not checked.
                skipped.push(`Transition '${comp.name}' of '${parsed.rootName || 'Unnamed'}'`);
            }
        }
    }

    if (parsed.rootType === 'POU') {
        emitPane(root, 'impl');
        const keyword = leadingPouKeyword(root.declaration || '');
        if (keyword) emitGenerated(`END_${keyword}`, root, closingPane(root), true);
    } else if (isItf) {
        emitGenerated('END_INTERFACE', root, 'decl', true);
    }

    return {
        stText: lines.join('\n'),
        lines,
        origins,
        rootType: parsed.rootType,
        rootName: parsed.rootName || 'Unnamed',
        globalListName: parsed.rootType === 'GVL' ? (parsed.rootName || null) : null,
        skipped
    };
}

/**
 * @typedef {Object} PaneLocation A position in a pane, 1-based like Monaco.
 * @property {string} componentId
 * @property {'decl'|'impl'} pane
 * @property {number} line
 * @property {number} column
 * @property {number} endLine
 * @property {number} endColumn
 * @property {boolean} exact False when the compiler's position had to be approximated: it was
 *   missing or outside the unit, or it fell on a generated line.
 */

/**
 * Maps a compiler position in a check unit to a pane position. Never returns null for a unit that
 * has lines: a position that cannot be placed exactly falls back to a line the user can see (the
 * generated line's anchor, or line 1 of the root declaration) and says so with `exact: false`.
 * @param {CheckUnit} unit
 * @param {{line?: number, column?: number, endLine?: number, endColumn?: number}} pos 1-based
 *   line and column, as the compiler reports them.
 * @returns {PaneLocation}
 */
function mapUnitPosition(unit, pos) {
    const line = Number(pos && pos.line);
    const origin = Number.isInteger(line) && line >= 1 && line <= unit.origins.length ? unit.origins[line - 1] : null;
    if (!origin) {
        return { componentId: 'root', pane: 'decl', line: 1, column: 1, endLine: 1, endColumn: 1, exact: false };
    }
    if (origin.generated) {
        return {
            componentId: origin.componentId, pane: origin.pane, line: origin.line, column: 1,
            endLine: origin.line, endColumn: 1, exact: false
        };
    }
    const text = unit.lines[line - 1];
    const column = Number.isInteger(Number(pos.column)) && Number(pos.column) >= 1
        ? Math.min(Number(pos.column), text.length + 1) : 1;
    // The end stays in the same pane or it is dropped: a range must never run into another
    // component's text just because that text follows in the unit.
    let endLine = origin.line;
    let endColumn = text.length + 1;
    const rawEndLine = Number(pos.endLine);
    const rawEndColumn = Number(pos.endColumn);
    if (Number.isInteger(rawEndLine) && rawEndLine >= line && rawEndLine <= unit.origins.length) {
        const endOrigin = unit.origins[rawEndLine - 1];
        if (!endOrigin.generated && endOrigin.componentId === origin.componentId && endOrigin.pane === origin.pane) {
            endLine = endOrigin.line;
            const endText = unit.lines[rawEndLine - 1];
            endColumn = Number.isInteger(rawEndColumn) && rawEndColumn >= 1
                ? Math.min(rawEndColumn, endText.length + 1) : endText.length + 1;
        }
    } else if (Number.isInteger(rawEndColumn) && rawEndColumn > column) {
        endColumn = Math.min(rawEndColumn, text.length + 1);
    }
    if (endLine === origin.line && endColumn <= column) endColumn = Math.min(column + 1, text.length + 1);
    return { componentId: origin.componentId, pane: origin.pane, line: origin.line, column, endLine, endColumn, exact: true };
}

module.exports = { buildCheckUnit, mapUnitPosition, paneLines };
