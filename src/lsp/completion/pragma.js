/**
 * @file completion/pragma.js
 * @description Completions inside a pragma (`{▮`, `{attribute '▮`). Pure: the caret detection is
 * textual and the items come from the pragma catalog, so no symbol index is involved.
 */

const { listAttributes, lookupDirective } = require('../pragmas');

// sortText prefixes inside a pragma. Every item in that list carries one, so only their order
// relative to each other matters: Infosys-documented names first, then the ones that are merely
// measured to exist. Both sort before nothing else, because a pragma completion never shares its
// list with ordinary ST suggestions.
const PRAGMA_DOCUMENTED_SORT_PREFIX = '0_';
const PRAGMA_OBSERVED_SORT_PREFIX = '1_';

/**
 * Pragma heads offered at `{▮`. `attribute` is not one of the catalog's `directives` — it names a
 * whole category rather than a single form — so it is added here with the category's own page.
 */
const PRAGMA_HEADS = ['attribute', 'region', 'endregion', 'IF', 'ELSIF', 'ELSE', 'END_IF',
    'define', 'undefine', 'text', 'info', 'warning', 'error'];

/**
 * Completions inside a pragma, or null when the caret is not in one.
 *
 * Pragmas are their own little language — nothing in ST's scope, type or statement machinery applies
 * inside `{ … }`, and the caller returns this list verbatim rather than merging it. Two carets are
 * worth answering: the head (`{▮`) and an attribute name (`{attribute '▮`), which is the one that
 * actually pays, since the name has to be spelled exactly and there are 78 of them.
 *
 * Detection is textual and deliberately narrow: the last `{` on the line, still unclosed. TwinCAT
 * writes every pragma on one line, so a `{` with no `}` after it *is* the pragma being typed.
 * @param {string} textBeforeCursor Text on the caret's line, up to the caret.
 * @returns {?Array<Object>} LSP CompletionItems, or null if the caret is not inside a pragma.
 */
function pragmaCompletions(textBeforeCursor) {
    const open = textBeforeCursor.lastIndexOf('{');
    if (open === -1) return null;
    const span = textBeforeCursor.slice(open);
    if (span.includes('}')) return null;

    // `{▮` / `{att▮` — the head. Monaco replaces the typed word, so the label alone is the insert.
    if (/^\{\s*[A-Za-z_]*$/.test(span)) {
        return PRAGMA_HEADS.map(head => {
            const entry = lookupDirective(head);
            return {
                label: head,
                kind: 14, // Keyword
                detail: entry ? entry.syntax : "attribute '<name>'",
                sortText: PRAGMA_DOCUMENTED_SORT_PREFIX + head.toLowerCase()
            };
        });
    }

    // `{attribute '▮` — inside the quotes. Also answered for `{attribute ▮`, where the quotes do not
    // exist yet and therefore have to come along with the name.
    const insideQuotes = /^\{\s*attribute\s+'[^']*$/i.test(span);
    const beforeQuotes = /^\{\s*attribute\s+$/i.test(span);
    if (insideQuotes || beforeQuotes) {
        return listAttributes().map(attr => ({
            label: attr.name,
            kind: 10, // Property
            insertText: insideQuotes ? attr.name : `'${attr.name}'`,
            detail: attr.tier === 'documented'
                ? 'TwinCAT attribute (Beckhoff Infosys)'
                : (attr.note || 'TwinCAT attribute (observed in libraries; not documented)'),
            sortText: (attr.tier === 'documented' ? PRAGMA_DOCUMENTED_SORT_PREFIX : PRAGMA_OBSERVED_SORT_PREFIX) + attr.name.toLowerCase()
        }));
    }

    return null;
}

module.exports = {
    pragmaCompletions
};
