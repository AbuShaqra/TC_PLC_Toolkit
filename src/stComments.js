/**
 * @file stComments.js
 * @description The one Node-side scanner for Structured Text comments, for the helpers that blank
 * comments out before a regex looks for keywords (object kinds, DUT kinds, the POU keyword of a check
 * unit). The lexer (`src/lsp/parser.js`), the fold scanner (`media/stFolding.js`), the webview's
 * Monarch tokenizer and the TextMate grammar implement the same rules on their own, because none of
 * them can require this file; `test/test_nested_comments.js` keeps all of them in step.
 *
 * ## The rules (TwinCAT 3, Infosys "ST comments")
 *
 * - `(* … *)` comments **nest**: Infosys documents a "nested" form, `(* a := 1; (* inner *) b := 2; *)`,
 *   where the first `*)` closes only the inner comment. Inside one, only `(*` and `*)` count — a `//`,
 *   a `/*` or a quote is plain comment text.
 * - `//` runs to the end of the line, and inside it nothing counts.
 * - `/* … *\/` does **not** nest here: Infosys does not document it for TwinCAT at all, so it keeps the
 *   behaviour it always had (the first `*\/` closes it). Inside one, only `*\/` counts.
 * - A comment marker inside a string literal is string text. ST escapes with `$`, never a backslash.
 * - An unterminated block comment runs to the end of the text, as it does in the lexer.
 */

/**
 * The index just past the `*)` that closes the nested `(* … *)` comment opening at `start`, or
 * `text.length` when it never closes.
 * @param {string} text Source text.
 * @param {number} start Index of the opening `(`; `text.slice(start, start + 2)` must be `(*`.
 * @returns {number}
 */
function blockCommentEnd(text, start) {
    let depth = 1;
    let i = start + 2;
    while (i < text.length) {
        if (text[i] === '(' && text[i + 1] === '*') { depth++; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === ')') {
            depth--;
            i += 2;
            if (depth === 0) return i;
            continue;
        }
        i++;
    }
    return text.length;
}

/**
 * Replaces every comment with spaces (line breaks kept), so a regex over the result sees no comment
 * text and every offset still matches the original.
 * @param {string} text Source text.
 * @param {{pragmas?: boolean, strings?: boolean}} [options] `pragmas`: blank `{ … }` spans too (they
 *   stop at `}` or the end of the line, as in the lexer). `strings`: blank string literals too. A
 *   string is always *recognised*, so a `(*` inside one never opens a comment; this only decides
 *   whether its text survives.
 * @returns {string}
 */
function blankComments(text, options) {
    const opts = options || {};
    const s = String(text == null ? '' : text);
    const blank = (/** @type {string} */ part) => part.replace(/[^\r\n]/g, ' ');
    let out = '';
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        const next = s[i + 1];
        let end = -1;
        let keep = false;
        if (c === '(' && next === '*') {
            end = blockCommentEnd(s, i);
        } else if (c === '/' && next === '*') {
            const close = s.indexOf('*/', i + 2);
            end = close < 0 ? s.length : close + 2;
        } else if (c === '/' && next === '/') {
            const nl = s.indexOf('\n', i);
            end = nl < 0 ? s.length : nl;
        } else if (c === '{') {
            let j = i + 1;
            while (j < s.length && s[j] !== '}' && s[j] !== '\n') j++;
            end = j < s.length && s[j] === '}' ? j + 1 : j;
            keep = !opts.pragmas;
        } else if (c === '\'' || c === '"') {
            let j = i + 1;
            while (j < s.length && s[j] !== c) j += s[j] === '$' ? 2 : 1;
            end = Math.min(j + 1, s.length);
            keep = !opts.strings;
        }
        if (end > i) {
            const part = s.slice(i, end);
            out += keep ? part : blank(part);
            i = end;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

module.exports = { blockCommentEnd, blankComments };
