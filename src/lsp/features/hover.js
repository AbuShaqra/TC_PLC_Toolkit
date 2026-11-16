/**
 * @file features/hover.js
 * @description Hover help for pragmas: `{attribute 'qualified_only'}`, `{warning 'text'}`,
 * `{IF defined(X)}`, `{region "Inputs"}` and the rest.
 *
 * What a hover shows is built from `src/lsp/pragmas.js`'s catalogue: the pragma's category, its syntax
 * form and, for a documented name, a link to its Beckhoff Infosys page. The category summaries below are
 * this project's own words. The catalogue holds names, syntax forms and page ids only — no description
 * text is copied from the documentation, and none may be added here: a reader who wants Beckhoff's text
 * follows the link.
 *
 * An attribute that is in neither catalogue file gets a neutral hover (user-defined attributes are a
 * supported TwinCAT feature, so "not catalogued" is never a warning). A `{ … }` whose head matches no
 * category gets no hover at all. Nothing here needs the symbol index, so a hover never waits for a scan.
 */

const { tokenize, TokenType } = require('../parser');
const { classifyPragma, lookupAttribute, lookupDirective, PragmaKind } = require('../pragmas');
const documented = require('../pragmaCatalog.json');

/** One-line summaries per category, in this project's own words. */
const SUMMARY = {
    attribute: 'Attribute pragma: attaches a named property to the declaration that follows it. The compiler or a TwinCAT tool reads it; it is not code.',
    text: 'Message pragma: prints its text in the message list when this code is compiled.',
    info: 'Message pragma: reports its text as an information message when this code is compiled.',
    warning: 'Message pragma: reports its text as a compiler warning when this code is compiled.',
    error: 'Message pragma: reports its text as a compiler error when this code is compiled.',
    if: 'Conditional compilation: the code up to the matching `{ELSIF}`, `{ELSE}` or `{END_IF}` is compiled only when the expression is true.',
    elsif: 'Conditional compilation: the next branch, compiled only when no earlier branch was taken and this expression is true.',
    else: 'Conditional compilation: the branch compiled when no earlier `{IF}` or `{ELSIF}` branch was taken.',
    end_if: 'Conditional compilation: closes the `{IF}` block.',
    define: 'Conditional compilation: defines a name (optionally with a value) that `{IF}` expressions can test with `defined(...)` or `hasvalue(...)`.',
    undefine: 'Conditional compilation: removes a name defined with `{define}`.',
    region: 'Region: starts a named, foldable block in the editor. It has no effect on the compiled code.',
    endregion: 'Region: closes the nearest open `{region}`.',
    'warning disable': 'Warning suppression: turns the given compiler warning off for the code that follows.',
    'warning restore': 'Warning suppression: turns the given compiler warning back on.'
};

/** The pragma kinds a hover is offered for. `Unknown` gets none. */
const HOVERED = new Set([PragmaKind.Attribute, PragmaKind.Message, PragmaKind.Conditional,
    PragmaKind.Region, PragmaKind.EndRegion, PragmaKind.WarningSuppression]);

/**
 * The offset of an LSP position in `code`.
 * @param {string} code
 * @param {{line: number, character: number}} position 0-based.
 * @returns {number} -1 when the line does not exist.
 */
function offsetAt(code, position) {
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
        const nl = code.indexOf('\n', offset);
        if (nl === -1) return -1;
        offset = nl + 1;
    }
    return offset + position.character;
}

/**
 * The markdown for one classified pragma, or null when it gets no hover.
 * @param {import('../pragmas').PragmaInfo} info
 * @returns {string|null}
 */
function pragmaMarkdown(info) {
    if (!HOVERED.has(info.kind)) return null;
    const lines = [];
    const docLink = (/** @type {string|null} */ url) => url ? `[Beckhoff Infosys documentation](${url})` : null;

    if (info.kind === PragmaKind.Attribute) {
        if (!info.name) return null;
        const form = info.value !== null ? `{attribute '${info.name}' := '<value>'}` : `{attribute '${info.name}'}`;
        lines.push(`**attribute '${info.name}'**`, '', SUMMARY.attribute, '', '`' + form + '`');
        if (info.tier === 'documented') {
            lines.push('', 'Documented by Beckhoff. ' + docLink(info.doc));
        } else if (info.tier === 'observed') {
            // Only the note's first sentence: the rest records how the entry was measured, which is
            // for maintainers, not for a hover.
            const entry = lookupAttribute(info.name);
            const first = entry && entry.note ? (entry.note.match(/^.*?\.(?=\s|$)/) || [entry.note])[0] : '';
            lines.push('', 'Not on an Infosys page, but TwinCAT accepts it and libraries use it.' + (first ? ' ' + first : ''));
        } else {
            lines.push('', 'Not in the catalogue: a user-defined or undocumented attribute. TwinCAT supports user-defined attributes.');
        }
        return lines.join('\n');
    }

    // Directives: the catalogue entry gives the canonical name, the syntax form and the page.
    // A suppression's head is `warning`, the same as the message pragma's; its catalogue name
    // (`warning disable` / `warning restore`) is what tells them apart.
    const head = info.kind === PragmaKind.WarningSuppression ? String(info.name || '').toLowerCase() : info.head;
    const entry = lookupDirective(head);
    const summary = SUMMARY[head];
    if (!entry || !summary) return null;
    lines.push(`**{${entry.name}}**`, '', summary, '', '`' + entry.syntax + '`');
    if (info.kind === PragmaKind.Conditional && (head === 'if' || head === 'elsif')) {
        lines.push('', 'Operators in the expression: ' + documented.conditionalOperators.map(o => '`' + o.syntax.split(' | ')[0] + '`').join(', ') +
            ', combined with `AND`, `OR` and `NOT`.');
    }
    lines.push('', docLink(entry.doc));
    return lines.join('\n');
}

/**
 * Hover for the pragma under the cursor.
 * @param {string} code The document (or the live path's assembled unit).
 * @param {{line: number, character: number}} position 0-based LSP position.
 * @returns {{contents: {kind: 'markdown', value: string}, range: {start: {line: number, character: number}, end: {line: number, character: number}}}|null}
 */
function provideHover(code, position) {
    if (!position) return null;
    const offset = offsetAt(code, position);
    if (offset < 0) return null;
    const lineEnd = code.indexOf('\n', offset);
    // Cheap exit for the common case (hovering code): a pragma never spans lines, so no `{` on the
    // caret's line means no pragma under it.
    const lineStart = offset - position.character;
    if (code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd).indexOf('{') === -1) return null;

    const tok = tokenize(code).find(t => t.start <= offset && offset < t.end);
    if (!tok || tok.type !== TokenType.Pragma) return null;
    const value = pragmaMarkdown(classifyPragma(tok.value));
    if (!value) return null;
    return {
        contents: { kind: /** @type {'markdown'} */ ('markdown'), value },
        range: {
            start: { line: tok.line - 1, character: tok.col - 1 },
            end: { line: tok.line - 1, character: tok.col - 1 + (tok.end - tok.start) }
        }
    };
}

module.exports = { provideHover, pragmaMarkdown };
