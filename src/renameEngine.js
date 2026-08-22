/**
 * @file renameEngine.js
 * @description Edit-application half of the rename feature. Given a TwinCAT file and the reference
 * occurrences of a symbol expressed as positions in that file's raw-converted Structured Text unit
 * (the 0-based coordinate space convertXmlToSt(parsed, { raw: true }) produces), it splices
 * oldName -> newName back into the backing <![CDATA[...]]> blocks without disturbing a single byte
 * outside them.
 *
 * The mapping is exact because it is recomputed from the very bytes being edited: parseTwinCatXml +
 * convertXmlToSt(raw) rebuild the same lineMap the LSP saw, so an occurrence's absolute ST line
 * classifies unambiguously into (componentId, pane) and then into a line offset inside that block's
 * CDATA string. A mandatory guard re-verifies the identifier at every mapped offset before writing,
 * so a stale, shifted, or fabricated position can only ever be skipped, never corrupt the file.
 *
 * Two things the raw ST unit synthesizes have NO byte in any CDATA and so can never be spliced:
 *   - an Action's `ACTION <name>` header line, and a property accessor's `GET`/`SET` keyword line;
 *   - a member's declaration HEADER identifier (the `METHOD X`/`PROPERTY X`/`ACTION X` naming of the
 *     component itself). Splicing that header text alone would desynchronise the member's tag Name
 *     attribute and its LineIds, corrupting the file. Such occurrences are diverted: recorded as
 *     skips flagged coveredByStructuralRename, and — when propagateDeclRenames is set — completed by
 *     a structural rename (renameComponentInXml) run AFTER the CDATA splice chain. The root object's
 *     own name is handled the same way in spirit, but its structural rename (renameRootObjectInXml)
 *     is the caller's job, so it is only reported, never applied here.
 *
 * Pure module: depends only on ./xmlParser and ./stConverter (no vscode). Tested by
 * test/test_rename_engine.js.
 */

const { parseTwinCatXml, replaceComponentCdata, renameComponentInXml } = require('./xmlParser');
const { convertXmlToSt } = require('./stConverter');

/**
 * @typedef {{ line: number, character: number }} StPosition 0-based raw-ST-unit coordinates.
 */

/** True when ch is an IEC identifier character; undefined (string bound) counts as a non-word char. */
function isWordChar(ch) {
    return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Byte offsets at which each 0-based line begins, splitting on `\n` only so CRLF terminators are
 * left in place (a line's `\r`, when present, is the last byte before the next line's start). This
 * matches convertXmlToSt's `text.split(/\r?\n/)` line indexing 1:1: a position's column indexes the
 * `\r`-stripped line content, and off + column lands inside that content, before any trailing `\r`.
 * @param {string} text The CDATA string being spliced.
 * @returns {number[]} lineStarts[i] = offset of 0-based line i.
 */
function computeLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

/**
 * Classifies an absolute (1-based) ST-unit line into the (componentId, pane) block that contains it,
 * checking each component's declaration range then its implementation range in lineMap insertion
 * order — identical to livePath.mapDiagnosticsToLocal, so the two paths cannot drift. Blocks with
 * an impl range of {0,0} (interfaces, GVL/DUT, property signatures) never match (abs >= 1).
 * @param {number} abs 1-based ST-unit line.
 * @param {Object} lineMap componentId -> { decl:{start,end}, impl:{start,end} }.
 * @returns {{componentId: string, pane: string, block: {start: number, end: number}}|null}
 */
function classifyLine(abs, lineMap) {
    for (const componentId of Object.keys(lineMap)) {
        const blocks = lineMap[componentId];
        if (blocks.decl && abs >= blocks.decl.start && abs <= blocks.decl.end) {
            return { componentId, pane: 'declaration', block: blocks.decl };
        }
        if (blocks.impl && abs >= blocks.impl.start && abs <= blocks.impl.end) {
            return { componentId, pane: 'implementation', block: blocks.impl };
        }
    }
    return null;
}

/**
 * Splices oldName -> newName at each guarded occurrence of a single (componentId, pane) group, in a
 * single CDATA string. Occurrences are applied in descending (line, column) order so earlier splices
 * never shift a not-yet-applied offset, which keeps a whole line of occurrences correct even when
 * newName is a different length than oldName.
 * @param {string} text The block's original CDATA string (comp.declaration / comp.implementation).
 * @param {Array<{cdataLine: number, column: number, position: StPosition, coveredIfGuardFails: boolean}>} occ
 * @param {string} oldName
 * @param {string} newName
 * @returns {{newText: string, applied: number, skipped: Array<Object>, changed: boolean}}
 */
function spliceGroup(text, occ, oldName, newName) {
    const lineStarts = computeLineStarts(text);
    const oldLower = oldName.toLowerCase();
    const sorted = occ.slice().sort((a, b) => (b.cdataLine - a.cdataLine) || (b.column - a.column));

    let out = text;
    let applied = 0;
    const skipped = [];

    for (const o of sorted) {
        if (o.cdataLine < 0 || o.cdataLine >= lineStarts.length) {
            skipped.push({
                position: o.position,
                coveredByStructuralRename: false,
                reason: 'position maps past the block text (synthesized trailing line)'
            });
            continue;
        }
        const pos = lineStarts[o.cdataLine] + o.column;
        const slice = out.slice(pos, pos + oldName.length);
        const before = pos > 0 ? out[pos - 1] : undefined;
        const after = out[pos + oldName.length];
        if (slice.toLowerCase() !== oldLower || isWordChar(before) || isWordChar(after)) {
            skipped.push({
                position: o.position,
                coveredByStructuralRename: !!o.coveredIfGuardFails,
                reason: 'identifier at mapped position does not match oldName (guard)'
            });
            continue;
        }
        out = out.slice(0, pos) + newName + out.slice(pos + oldName.length);
        applied++;
    }

    return { newText: out, applied, skipped, changed: applied > 0 };
}

/**
 * Applies a symbol's reference occurrences to one TwinCAT file, splicing oldName -> newName inside
 * the backing CDATA blocks and (optionally) completing member declaration-header renames structurally.
 * See the file header for the model. The returned xmlText is byte-for-byte identical to the input
 * outside the spliced identifiers and any structural member renames.
 *
 * @param {string} xmlText Current file content (the same text the caller's modifier receives).
 * @param {StPosition[]} occurrences This file's occurrences of the symbol, in raw-ST-unit coords.
 * @param {{ oldName: string, newName: string, propagateDeclRenames?: boolean }} opts
 * @returns {{ xmlText: string, applied: number,
 *             skipped: Array<{position: StPosition, coveredByStructuralRename: boolean, reason: string}>,
 *             renamedDeclComponents: Array<{componentType: string, componentName: string}> }}
 */
function applyReferenceEditsToXml(xmlText, occurrences, opts) {
    const oldName = opts && opts.oldName;
    const newName = opts && opts.newName;
    const propagateDeclRenames = !!(opts && opts.propagateDeclRenames);

    const result = { xmlText, applied: 0, skipped: [], renamedDeclComponents: [] };
    if (!oldName || newName === undefined || newName === null || !Array.isArray(occurrences) || occurrences.length === 0) {
        return result;
    }

    const parsed = parseTwinCatXml(xmlText);
    if (!parsed) {
        for (const occ of occurrences) {
            result.skipped.push({ position: occ, coveredByStructuralRename: false, reason: 'file could not be parsed' });
        }
        return result;
    }

    const { lineMap } = convertXmlToSt(parsed, { raw: true });
    const rootName = parsed.rootName || '';
    const oldLower = oldName.toLowerCase();

    const compById = {};
    for (const c of parsed.components) compById[c.id] = c;

    // Splice groups keyed by `${componentId} ${pane}`. Each carries the target component and its
    // per-occurrence records; the whole group edits one CDATA string in one replaceComponentCdata call.
    const groups = new Map();
    // Members whose own declaration header is the symbol being renamed — completed structurally.
    const marked = new Map(); // key `${subType} ${subName}` -> { componentType, componentName }

    for (const occ of occurrences) {
        const abs = occ.line + 1; // 1-based ST-unit line
        const cls = classifyLine(abs, lineMap);
        if (!cls) {
            result.skipped.push({ position: occ, coveredByStructuralRename: false, reason: 'position is not within any editable block' });
            continue;
        }

        const comp = compById[cls.componentId];
        const pane = cls.pane;
        const block = cls.block;
        const isRoot = comp.xmlContext.subType === null;
        const ownName = isRoot ? rootName : comp.xmlContext.subName;
        const isSelfName = !!ownName && ownName.toLowerCase() === oldLower;

        // --- Action declaration: a lone synthesized `ACTION <name>` line, no backing CDATA. ---
        if (comp.type === 'Action' && pane === 'declaration') {
            if (isSelfName) {
                result.skipped.push({
                    position: occ,
                    coveredByStructuralRename: true,
                    reason: 'action declaration is synthesized; structural rename covers it'
                });
                markComponent(marked, comp);
            } else {
                result.skipped.push({
                    position: occ,
                    coveredByStructuralRename: false,
                    reason: 'action declaration line has no backing text'
                });
            }
            continue;
        }

        // --- Property accessor (Get/Set) declaration: a synthesized `GET`/`SET` keyword line,
        //     optionally followed by the accessor's own VAR-block CDATA (omitted when whitespace-only
        //     `VAR END_VAR`, which stConverter drops even in raw mode). The keyword line is line 1 of
        //     the block; the CDATA, when present, starts one line below. The property name is NOT a
        //     header here (this is a VAR block), so an occurrence is always a genuine reference. ---
        if ((comp.type === 'Get' || comp.type === 'Set') && pane === 'declaration') {
            if (abs === block.start) {
                result.skipped.push({
                    position: occ,
                    coveredByStructuralRename: false,
                    reason: `synthesized ${comp.type === 'Get' ? 'GET' : 'SET'} keyword line`
                });
                continue;
            }
            // CDATA emitted iff the block spans more than the keyword line (block.end > block.start).
            if (block.end <= block.start) {
                result.skipped.push({
                    position: occ,
                    coveredByStructuralRename: false,
                    reason: 'accessor declaration CDATA was omitted (whitespace-only VAR block)'
                });
                continue;
            }
            addToGroup(groups, comp, pane, {
                cdataLine: abs - block.start - 1,
                column: occ.character,
                position: occ,
                coveredIfGuardFails: false
            });
            continue;
        }

        // --- Member declaration header naming the component itself (Method/Property/Action): divert.
        //     Splicing the header CDATA alone would desync the tag Name + LineIds. ---
        if (pane === 'declaration' && !isRoot && isSelfName
            && (comp.type === 'Method' || comp.type === 'Property' || comp.type === 'Action')) {
            result.skipped.push({
                position: occ,
                coveredByStructuralRename: true,
                reason: 'component declaration header; structural rename covers it'
            });
            markComponent(marked, comp);
            continue;
        }

        // --- Everything else with backing CDATA: splice, guarded. cdataLine = abs - block.start.
        //     For a root-decl occurrence of the root's OWN name, the PROGRAM->FUNCTION_BLOCK rewrite
        //     may shift the column so the guard fails; such a skip is covered by the caller's
        //     renameRootObjectInXml. ---
        addToGroup(groups, comp, pane, {
            cdataLine: abs - block.start,
            column: occ.character,
            position: occ,
            coveredIfGuardFails: isRoot && pane === 'declaration' && isSelfName
        });
    }

    // Apply the CDATA splices. Every replaceComponentCdata lookup resolves the block by its OLD tag
    // name/content, so all splices must precede any structural rename (which rewrites tag names).
    let xml = xmlText;
    for (const grp of groups.values()) {
        const cdata = grp.pane === 'declaration' ? (grp.comp.declaration || '') : (grp.comp.implementation || '');
        const spliced = spliceGroup(cdata, grp.occ, oldName, newName);
        result.applied += spliced.applied;
        for (const s of spliced.skipped) result.skipped.push(s);
        if (spliced.changed) {
            xml = replaceComponentCdata(
                xml,
                grp.comp.xmlContext,
                grp.pane === 'declaration' ? 'Declaration' : 'Implementation',
                spliced.newText
            );
        }
    }

    // Structural member renames, AFTER the splice chain. Only applied (and reported) when requested;
    // the covered skips were already recorded above regardless of the flag.
    if (propagateDeclRenames) {
        for (const m of marked.values()) {
            xml = renameComponentInXml(xml, rootName, m.componentType, m.componentName, newName);
            result.renamedDeclComponents.push({ componentType: m.componentType, componentName: m.componentName });
        }
    }

    result.xmlText = xml;
    return result;
}

/** Records a member component (Method/Property/Action) for structural rename, deduped by tag identity. */
function markComponent(marked, comp) {
    const subType = comp.xmlContext.subType;
    const subName = comp.xmlContext.subName;
    if (!subType || !subName) return;
    const key = `${subType} ${subName}`;
    if (!marked.has(key)) marked.set(key, { componentType: subType, componentName: subName });
}

/** Adds an occurrence record to its (componentId, pane) splice group, creating the group on first use. */
function addToGroup(groups, comp, pane, record) {
    const key = `${comp.id} ${pane}`;
    let grp = groups.get(key);
    if (!grp) {
        grp = { comp, pane, occ: [] };
        groups.set(key, grp);
    }
    grp.occ.push(record);
}

module.exports = {
    applyReferenceEditsToXml,
    computeLineStarts,
    spliceGroup,
    classifyLine
};
