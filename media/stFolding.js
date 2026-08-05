/**
 * @file media/stFolding.js
 * @description Computes folding ranges for Structured Text from its actual block structure.
 *
 * Lives in `media/` because the webview loads it with a plain `<script>` tag, but it is written to
 * `require()` cleanly too (see the shim at the bottom) so `test/test_folding.js` can exercise the
 * exact code the panes run. There is no build step in this project, so one file that works both ways
 * is the only way to avoid two copies of an algorithm that must not drift.
 *
 * ## Why this exists at all
 *
 * Monaco's default is **indentation** folding, and ST is not an indentation-structured language — its
 * blocks are keyword-delimited. Two bugs came out of that, both reported from the panes:
 *
 *   1. An unmatched `{endregion}` truncated the enclosing `VAR` fold. Monaco's `computeRanges` scans
 *      bottom-up and pushes `{indent: -2}` when it meets an end marker with no start yet. Nothing but
 *      a *matching start marker* ever pops that sentinel — the indentation unwind is
 *      `while (top.indent > lineIndent)`, and -2 is below every real indent — so a lone `{endregion}`
 *      became a permanent barrier. Here an unmatched closer is simply **ignored**.
 *
 *   2. `{attribute 'TcLinkTo' := ''}` written at column 0 under an indented `VAR` body grew its own
 *      fold arrow, because an unindented line followed by indented ones *is* an indentation region.
 *      That was never about pragmas: any unindented line did it. Here a fold exists only where ST
 *      says a block does.
 *
 * Registering a provider **replaces** Monaco's indentation provider outright, which is why this has
 * to cover the keyword blocks too — otherwise `IF … END_IF` would silently stop folding.
 *
 * ## The one thing that makes this correct
 *
 * Keywords are counted only where they are *code*. Comments, strings and pragmas are blanked first,
 * and that is not defensive tidiness — `{IF defined(Variant1)}` is a **conditional pragma**, not an
 * `IF` block, and TwinCAT projects are full of them. Counting it would leave an unclosed `IF` on the
 * stack and swallow every fold after it.
 */

// Dual-mode shim: `module.exports` under Node, a `stFolding` global in the webview. The cast is for
// the type-check gate, which reads this file as a module and would otherwise reject assigning a new
// property to `Window` — the branch Node never takes.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.stFolding = factory();
}(typeof self !== 'undefined' ? /** @type {*} */ (self) : this, function () {
    'use strict';

    /**
     * Block openers → the keyword that closes them. Case-insensitive, as ST itself is.
     *
     * The VAR family is listed out rather than matched with a prefix so that `VAR_INPUT` is one
     * keyword and not `VAR` followed by something: they all close on the same `END_VAR`, but a prefix
     * match would push twice for `VAR_IN_OUT` and leave the stack unbalanced.
     */
    var CLOSES = {
        VAR: 'END_VAR',
        VAR_INPUT: 'END_VAR',
        VAR_OUTPUT: 'END_VAR',
        VAR_IN_OUT: 'END_VAR',
        VAR_GLOBAL: 'END_VAR',
        VAR_TEMP: 'END_VAR',
        VAR_STAT: 'END_VAR',
        VAR_EXTERNAL: 'END_VAR',
        VAR_INST: 'END_VAR',
        VAR_CONFIG: 'END_VAR',
        VAR_ACCESS: 'END_VAR',
        IF: 'END_IF',
        CASE: 'END_CASE',
        FOR: 'END_FOR',
        WHILE: 'END_WHILE',
        REPEAT: 'END_REPEAT',
        STRUCT: 'END_STRUCT',
        UNION: 'END_UNION',
        TYPE: 'END_TYPE'
    };

    /** Every closing keyword, for the reverse test. */
    var CLOSERS = {};
    for (var opener in CLOSES) {
        if (Object.prototype.hasOwnProperty.call(CLOSES, opener)) CLOSERS[CLOSES[opener]] = true;
    }

    /**
     * Opens/closes a foldable region. Case-**sensitive** on purpose: Infosys spells the pragma
     * `{region "description"}` and warns to follow that syntax, and every occurrence across the real
     * projects on this machine is lowercase. Folding what TwinCAT itself would not fold is worse than
     * not folding it. Kept identical to the folding markers in `src/lsp/pragmas.js`, which
     * `test_pragmas.js` pins.
     */
    var REGION_START = /^\{\s*region\b/;
    var REGION_END = /^\{\s*endregion\b/;

    var WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

    /**
     * Splits each line into the part that is *code* and the pragma spans that sit on it.
     *
     * Comments, string literals and pragma bodies are replaced with spaces — same length, so offsets
     * still line up — and the pragmas are handed back separately, because region markers have to be
     * read from them. A pragma inside a comment yields neither.
     *
     * Block comments carry across lines; strings and pragmas deliberately do not. TwinCAT writes a
     * pragma on one line, and the lexer already stops an unterminated `{` at end-of-line for exactly
     * this reason: while `{region "Inputs"` is half typed, it must not swallow the rest of the file.
     * @param {string[]} lines
     * @returns {Array<{code: string, pragmas: Array<{text: string, start: number}>}>}
     */
    function scanLines(lines) {
        var out = [];
        var blockComment = null;   // null | '*)' | '*/'

        for (var i = 0; i < lines.length; i++) {
            var line = String(lines[i] == null ? '' : lines[i]);
            var code = '';
            var pragmas = [];
            var j = 0;

            while (j < line.length) {
                if (blockComment) {
                    if (line.substr(j, 2) === blockComment) { blockComment = null; code += '  '; j += 2; }
                    else { code += ' '; j++; }
                    continue;
                }
                var two = line.substr(j, 2);
                if (two === '//') { code += repeat(' ', line.length - j); break; }
                if (two === '(*' || two === '/*') {
                    blockComment = two === '(*' ? '*)' : '*/';
                    code += '  ';
                    j += 2;
                    continue;
                }
                var ch = line[j];
                if (ch === "'" || ch === '"') {
                    // ST escapes inside a string with '$', not a backslash.
                    var k = j + 1;
                    while (k < line.length) {
                        if (line[k] === '$') { k += 2; continue; }
                        if (line[k] === ch) { k++; break; }
                        k++;
                    }
                    code += repeat(' ', Math.min(k, line.length) - j);
                    j = k;
                    continue;
                }
                if (ch === '{') {
                    var end = line.indexOf('}', j);
                    var stop = end === -1 ? line.length : end + 1;
                    pragmas.push({ text: line.slice(j, stop), start: j });
                    code += repeat(' ', stop - j);
                    j = stop;
                    continue;
                }
                code += ch;
                j++;
            }

            out.push({ code: code, pragmas: pragmas });
        }
        return out;
    }

    /**
     * @param {string} s
     * @param {number} n
     * @returns {string}
     */
    function repeat(s, n) {
        return n > 0 ? new Array(n + 1).join(s) : '';
    }

    /**
     * Pops the stack down to the entry this closer belongs to and returns it, or null when the closer
     * matches nothing open.
     *
     * Returning null is the fix for bug 1: a closer with no opener is **dropped**, and folding
     * carries on as if it were not there. Entries above the match are discarded — they are blocks the
     * document never closed, which is the normal state of a file being typed into.
     * @param {Array<{keyword: string, closer: string, line: number}>} stack
     * @param {string} closer
     * @returns {?{keyword: string, closer: string, line: number}}
     */
    function unwind(stack, closer) {
        for (var i = stack.length - 1; i >= 0; i--) {
            if (stack[i].closer === closer) {
                var hit = stack[i];
                stack.length = i;
                return hit;
            }
        }
        return null;
    }

    /**
     * Folding ranges for a Structured Text pane.
     *
     * Regions and keyword blocks use **separate stacks** on purpose. They nest independently in real
     * code, and sharing one stack would mean a single malformed construct destroyed the other's
     * ranges — a stray `{endregion}` inside a `VAR` block should never cost you the `VAR` fold, which
     * is the very bug this replaces.
     *
     * `end` differs by kind, and both match what these panes already did, so nothing a user is used to
     * moves: a keyword block hides through the line *before* its closer (`END_VAR` stays visible under
     * a collapsed `VAR`), while a region hides its `{endregion}` — the same as `#region` in VS Code.
     * @param {string[]} lines Pane text, split on newlines.
     * @returns {Array<{start: number, end: number, kind: string}>} 1-based, `kind` is 'region' or 'block'.
     */
    function computeFoldingRanges(lines) {
        var scanned = scanLines(lines || []);
        var ranges = [];
        var blocks = [];
        var regions = [];

        for (var i = 0; i < scanned.length; i++) {
            var lineNo = i + 1;
            var entry = scanned[i];

            // Regions, from the first pragma on the line and only when nothing but whitespace
            // precedes it — the same anchoring as the folding markers.
            if (entry.pragmas.length) {
                var first = entry.pragmas[0];
                if (/^\s*$/.test(entry.code.slice(0, first.start))) {
                    if (REGION_START.test(first.text)) {
                        regions.push({ keyword: 'region', closer: 'endregion', line: lineNo });
                    } else if (REGION_END.test(first.text)) {
                        var openRegion = unwind(regions, 'endregion');
                        if (openRegion && lineNo > openRegion.line) {
                            ranges.push({ start: openRegion.line, end: lineNo, kind: 'region' });
                        }
                    }
                }
            }

            // Keyword blocks. Words are read left to right so several on one line nest correctly.
            WORD.lastIndex = 0;
            var m;
            while ((m = WORD.exec(entry.code)) !== null) {
                // `axis.Status` must not be read as a keyword just because a member is named like
                // one; only a word that stands on its own opens or closes a block.
                if (m.index > 0 && entry.code[m.index - 1] === '.') continue;
                var word = m[0].toUpperCase();
                if (CLOSERS[word]) {
                    var open = unwind(blocks, word);
                    // A one-line `IF x THEN y := 1; END_IF;` opens and closes on the same line and
                    // has nothing to hide.
                    if (open && lineNo - 1 > open.line) {
                        ranges.push({ start: open.line, end: lineNo - 1, kind: 'block' });
                    }
                } else if (Object.prototype.hasOwnProperty.call(CLOSES, word)) {
                    blocks.push({ keyword: word, closer: CLOSES[word], line: lineNo });
                }
            }
        }

        return ranges.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    }

    return {
        computeFoldingRanges: computeFoldingRanges,
        // Exported for the tests: the comment/string/pragma blanking is where the subtle failures
        // live, and asserting it directly beats inferring it from a fold that did not happen.
        scanLines: scanLines,
        CLOSES: CLOSES
    };
}));
