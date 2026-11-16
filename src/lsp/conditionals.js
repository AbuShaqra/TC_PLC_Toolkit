/**
 * @file conditionals.js
 * @description TwinCAT conditional pragmas (`{IF}` / `{ELSIF}` / `{ELSE}` / `{END_IF}`) for the
 * built-in language server.
 *
 * The LSP never evaluates a condition: every branch combination is treated as possible, because the
 * defines that pick a branch (the `.plcproj` `<CompilerDefines>`, per-object defines, the build
 * configuration, `{define}` in the code) are not all knowable here. Everything in this module serves
 * the conservative rule — a diagnostic is only raised when it is true under EVERY configuration:
 *
 *   - annotateConditionals() tags tokens with the innermost group/branch they sit in and records the
 *     groups per *segment* (a POU body, a method, an accessor — the wrapper lines of the raw unit).
 *   - blockSelections() enumerates the branch choices of a segment, so the block matcher can keep only
 *     the errors every choice has.
 *   - suppressionSpans() gives the statement ranges around each group, where semantic diagnostics are
 *     dropped.
 *
 * It only reads tokens (plain CommonJS, no VS Code, no file system) and never removes one, so every
 * range the features compute stays exact. A unit with no conditional directive is never touched:
 * tokenize() calls annotateConditionals() only when a directive was seen.
 */

/**
 * A token stream from tokenize(); `conditionals` is set by annotateConditionals().
 * @typedef {Array<Object> & {conditionals?: {groups: Array<Object>, segments: Array<Object>, unbalancedSegments: Array<Object>}}} TokenStream
 */

/** A conditional directive pragma. {define}/{undefine} have no structure and stay plain pragmas. */
const CONDITIONAL_RE = /^\{\s*(if|elsif|else|end_if)\b/i;

/** Keywords that start/end a segment when they are the first code token on their line. */
const BOUNDARY = new Set([
    'METHOD', 'PROPERTY', 'ACTION', 'GET', 'SET',
    'END_METHOD', 'END_PROPERTY', 'END_ACTION', 'END_GET', 'END_SET',
    'END_PROGRAM', 'END_FUNCTION_BLOCK', 'END_FUNCTION', 'END_INTERFACE'
]);

/** Keywords the block matcher looks at. */
const BLOCK_KEYWORDS = new Set([
    'IF', 'CASE', 'FOR', 'WHILE', 'REPEAT',
    'END_IF', 'END_CASE', 'END_FOR', 'END_WHILE', 'UNTIL'
]);

/** Selections enumerated per segment before the structural check gives up (reports nothing). */
const SELECTION_CAP = 64;

/** Tokens after which a new statement (or declaration) starts. */
const STATEMENT_START = new Set(['THEN', 'DO', 'ELSE', 'ELSIF', 'OF', 'REPEAT', 'STRUCT', 'UNION']);

/**
 * Keywords that may sit in a POU/DUT head between its keyword and its first declaration block.
 * The head scan stops at anything else.
 */
const HEAD_KEYWORDS = new Set(['EXTENDS', 'IMPLEMENTS', 'ABSTRACT', 'FINAL', 'INTERNAL', 'PUBLIC', 'PRIVATE', 'PROTECTED']);

/**
 * Directive kind of a pragma's text.
 * @param {string} text Pragma token value (`{IF defined(X)}`).
 * @returns {('if'|'elsif'|'else'|'end_if'|null)}
 */
function directiveKind(text) {
    const m = CONDITIONAL_RE.exec(String(text || ''));
    return m ? /** @type {'if'|'elsif'|'else'|'end_if'} */ (m[1].toLowerCase()) : null;
}

/** @param {Object} t Token. @returns {boolean} */
function isTrivia(t) {
    return t.type === 'whitespace' || t.type === 'comment';
}

/**
 * The 1-based line/column just past a token (pragmas and comments may span lines).
 * @param {Object} t Token.
 * @returns {{line: number, col: number}}
 */
function tokenEnd(t) {
    const v = String(t.value);
    const nl = v.lastIndexOf('\n');
    if (nl === -1) return { line: t.line, col: t.col + v.length };
    let lines = 0;
    for (let i = 0; i < v.length; i++) if (v[i] === '\n') lines++;
    return { line: t.line + lines, col: v.length - nl };
}

/** Code tokens after a boundary keyword that make it a call argument or member, not a wrapper line. */
const NOT_A_BOUNDARY_AFTER = new Set([':=', '=>', ',', ')', '.', '(', ';']);

/**
 * Splits the token stream into segments at boundary keywords that start their line.
 *
 * A keyword only counts outside parentheses, when the previous code token is not `.` and the next
 * one is not `:=`/`=>`/`,`/`)`/`.`/`(`/`;`: `fbRS(\n\tSET := c,` is a named argument, not an accessor.
 * @param {Array<Object>} tokens
 * @returns {Array<{start: number, end: number}>} Half-open token index ranges.
 */
function findSegments(tokens) {
    const segments = [];
    let segStart = 0;
    let lineStart = true;
    let depth = 0;
    let prevCode = null;
    const nextCode = (i) => {
        for (let j = i + 1; j < tokens.length; j++) {
            const t = tokens[j];
            if (isTrivia(t) || (t.type === 'pragma' && !directiveKind(t.value))) continue;
            return t;
        }
        return null;
    };
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'whitespace') {
            if (t.value.includes('\n')) lineStart = true;
            continue;
        }
        if (t.type === 'comment') {
            if (t.value.includes('\n')) lineStart = true;
            continue;
        }
        if (lineStart && depth === 0 && t.type === 'keyword' && BOUNDARY.has(t.value.toUpperCase()) && i > segStart
            && !(prevCode && prevCode.value === '.')) {
            const n = nextCode(i);
            if (!n || !NOT_A_BOUNDARY_AFTER.has(n.value)) {
                segments.push({ start: segStart, end: i });
                segStart = i;
            }
        }
        if (t.type === 'punctuation' || t.type === 'operator') {
            if (t.value === '(') depth++;
            else if (t.value === ')' && depth > 0) depth--;
        }
        if (t.type !== 'pragma') prevCode = t;
        lineStart = false;
    }
    segments.push({ start: segStart, end: tokens.length });
    return segments;
}

/**
 * Annotates a token stream that holds at least one conditional directive.
 *
 * Sets, in place:
 *   - `tok.cond = { group, branch }` on every token inside a group (innermost group); in an
 *     unbalanced segment every token gets `{ group: -1, branch: -1 }`;
 *   - `tok.condDirective = 'if'|'elsif'|'else'|'end_if'` on the directive pragmas;
 *   - `tokens.conditionals = { groups, segments, unbalancedSegments }`.
 *
 * A segment is UNBALANCED when a directive appears at depth 0 without an `{IF}`, when `{ELSIF}`
 * follows `{ELSE}` or a second `{ELSE}` appears, or when a group is still open at its end. Nothing in
 * an unbalanced segment is ever reported: re-exposing a branch is how false positives come back.
 * @param {TokenStream} tokens Token stream from tokenize().
 * @returns {TokenStream} The same array.
 */
function annotateConditionals(tokens) {
    const groups = [];
    const segments = [];
    const unbalancedSegments = [];

    for (const { start, end } of findSegments(tokens)) {
        const seg = { start, end, unbalanced: false, items: [], groups: [], keywordTokens: [] };
        const stack = [];
        const itemsOf = () => (stack.length ? stack[stack.length - 1].branches[stack[stack.length - 1].branches.length - 1].items : seg.items);
        const locOf = () => (stack.length
            ? { group: stack[stack.length - 1].id, branch: stack[stack.length - 1].branches.length - 1 }
            : null);

        for (let i = start; i < end && !seg.unbalanced; i++) {
            const t = tokens[i];
            const kind = t.type === 'pragma' ? directiveKind(t.value) : null;
            if (kind) {
                t.condDirective = kind;
                if (kind === 'if') {
                    const loc = locOf();
                    if (loc) t.cond = loc;
                    const g = {
                        id: groups.length,
                        parent: stack.length ? stack[stack.length - 1] : null,
                        ifTok: t,
                        ifIndex: i,
                        endTok: null,
                        endIndex: -1,
                        directiveIndexes: [],
                        branches: [{ items: [] }],
                        hasElse: false
                    };
                    groups.push(g);
                    seg.groups.push(g);
                    itemsOf().push({ group: g });
                    stack.push(g);
                    continue;
                }
                const top = stack[stack.length - 1];
                if (!top || (kind !== 'end_if' && top.hasElse)) { seg.unbalanced = true; break; }
                if (top.parent) t.cond = { group: top.parent.id, branch: top.parent.branches.length - 1 };
                top.directiveIndexes.push(i);
                if (kind === 'end_if') {
                    top.endTok = t;
                    top.endIndex = i;
                    stack.pop();
                } else {
                    if (kind === 'else') top.hasElse = true;
                    top.branches.push({ items: [] });
                }
                continue;
            }
            const loc = locOf();
            if (loc) t.cond = loc;
            if (t.type === 'keyword' && BLOCK_KEYWORDS.has(t.value.toUpperCase())) {
                itemsOf().push({ tok: t });
                seg.keywordTokens.push(t);
            }
        }
        if (stack.length) seg.unbalanced = true;

        if (seg.unbalanced) {
            for (let i = start; i < end; i++) {
                const t = tokens[i];
                t.cond = { group: -1, branch: -1 };
                if (t.type === 'pragma' && !t.condDirective) {
                    const kind = directiveKind(t.value);
                    if (kind) t.condDirective = kind;
                }
            }
            unbalancedSegments.push(seg);
        }
        segments.push(seg);
    }

    Object.defineProperty(tokens, 'conditionals', {
        value: { groups, segments, unbalancedSegments },
        enumerable: false,
        configurable: true,
        writable: true
    });
    return tokens;
}

/**
 * The outermost group a token sits in, or null.
 * @param {TokenStream} tokens Annotated token stream.
 * @param {Object} tok Token.
 * @returns {Object|null}
 */
function outermostGroup(tokens, tok) {
    if (!tok || !tok.cond || tok.cond.group < 0 || !tokens.conditionals) return null;
    let g = tokens.conditionals.groups[tok.cond.group];
    while (g && g.parent) g = g.parent;
    return g || null;
}

/**
 * Enumerates the block-keyword sequences of a balanced segment, one per selection of branches.
 *
 * (a) A group is NEUTRAL when each branch, matched alone (with nested neutral groups removed), is
 *     balanced and error-free; its keywords cannot change any other diagnostic, so it is dropped.
 * (b) Every other group contributes one branch per selection, plus an implicit empty branch when it
 *     has no `{ELSE}`; a nested group counts only inside its parent's selected branch.
 * @param {Object} segment A segment from tokens.conditionals.
 * @param {(seq: Array<Object>) => boolean} isClean True when a keyword sequence matches cleanly.
 * @param {number} [cap] Maximum selections; above it the function returns null.
 * @returns {Array<Array<Object>>|null} Keyword-token sequences, or null above the cap.
 */
function blockSelections(segment, isClean, cap = SELECTION_CAP) {
    const neutral = new Map();
    const isNeutral = (g) => {
        if (neutral.has(g)) return neutral.get(g);
        let ok = true;
        for (const b of g.branches) {
            const seq = [];
            for (const it of b.items) {
                if (it.tok) seq.push(it.tok);
                else if (!isNeutral(it.group)) ok = false;
            }
            if (ok && !isClean(seq)) ok = false;
            if (!ok) break;
        }
        neutral.set(g, ok);
        return ok;
    };

    const count = (items) => {
        let n = 1;
        for (const it of items) {
            if (!it.group || isNeutral(it.group)) continue;
            let choices = it.group.hasElse ? 0 : 1;
            for (const b of it.group.branches) choices += count(b.items);
            n = Math.min(n * choices, cap + 1);
        }
        return n;
    };
    if (count(segment.items) > cap) return null;

    const enumerate = (items) => {
        let seqs = [[]];
        for (const it of items) {
            if (it.tok) {
                for (const s of seqs) s.push(it.tok);
                continue;
            }
            if (isNeutral(it.group)) continue;
            const options = [];
            for (const b of it.group.branches) options.push(...enumerate(b.items));
            if (!it.group.hasElse) options.push([]);
            const next = [];
            for (const s of seqs) for (const o of options) next.push(s.concat(o));
            seqs = next;
        }
        return seqs;
    };
    return enumerate(segment.items);
}

/**
 * Statement-level ranges around each outermost group (and each whole unbalanced segment), in which
 * semantic diagnostics are dropped.
 *
 * A group's span runs from its `{IF}` to its `{END_IF}`, widened backwards to just after the previous
 * `;` / statement-start keyword / other directive (or the segment start) and — when a branch ends in
 * the middle of a statement — forwards through the next `;`. That covers `x := {IF a}1{ELSE}2{END_IF};`,
 * whose assignment diagnostic is anchored on `x`, outside the braces.
 * @param {TokenStream} tokens Annotated token stream.
 * @returns {Array<{startLine: number, startCol: number, endLine: number, endCol: number}>}
 */
function suppressionSpans(tokens) {
    const cond = tokens.conditionals;
    if (!cond) return [];
    const spans = [];
    const isStop = (t) => {
        if (t.type === 'punctuation' && t.value === ';') return true;
        if (t.condDirective) return true;
        if (t.type !== 'keyword') return false;
        const u = t.value.toUpperCase();
        return STATEMENT_START.has(u) || u.startsWith('END_') || u.startsWith('VAR') || BOUNDARY.has(u);
    };
    const isTerminatorToken = (t) => {
        if (t.type === 'punctuation' && t.value === ';') return true;
        if (t.type !== 'keyword') return false;
        const u = t.value.toUpperCase();
        return STATEMENT_START.has(u) || u.startsWith('END_') || u.startsWith('VAR');
    };
    const skippable = (t) => isTrivia(t) || (t.type === 'pragma' && !t.condDirective);

    const byEnd = new Map();
    for (const g of cond.groups) if (g.endIndex >= 0) byEnd.set(g.endIndex, g);
    /**
     * How the code in (lo, j] ends: true mid-statement, false at a statement end, 'empty' when there
     * is no code (the state is then whatever precedes lo). A nested group is resolved through its branches.
     * @returns {boolean|'empty'}
     */
    const lastState = (j, lo) => {
        while (j > lo && skippable(tokens[j])) j--;
        if (j <= lo) return 'empty';
        const t = tokens[j];
        const nested = t.condDirective === 'end_if' ? byEnd.get(j) : null;
        if (nested) {
            const r = groupMid(nested);
            return r === 'empty' ? lastState(nested.ifIndex - 1, lo) : r;
        }
        if (t.condDirective) return true;
        return !isTerminatorToken(t);
    };
    /** True when any branch ends mid-statement; 'empty' when none does but one may be empty. */
    const groupMid = (g) => {
        let prev = g.ifIndex;
        let mayBeEmpty = !g.hasElse;
        for (const di of g.directiveIndexes) {
            const r = lastState(di - 1, prev);
            prev = di;
            if (r === true) return true;
            if (r === 'empty') mayBeEmpty = true;
        }
        return mayBeEmpty ? 'empty' : false;
    };

    for (const seg of cond.segments) {
        if (seg.unbalanced) {
            let last = seg.end - 1;
            while (last > seg.start && isTrivia(tokens[last])) last--;
            if (last < seg.start) continue;
            const s = tokens[seg.start];
            const e = tokenEnd(tokens[last]);
            spans.push({ startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col });
            continue;
        }
        for (const g of seg.groups) {
            if (g.parent) continue;

            // Backwards: to the first code token after the previous statement end.
            let first = g.ifIndex;
            for (let i = g.ifIndex - 1; i >= seg.start; i--) {
                const t = tokens[i];
                if (skippable(t)) continue;
                if (isStop(t)) break;
                first = i;
            }

            // Forwards: through the next ';' when any branch ends mid-statement.
            const midStatement = groupMid(g) === true;
            let last = g.endIndex;
            if (midStatement) {
                for (let i = g.endIndex + 1; i < seg.end; i++) {
                    const t = tokens[i];
                    if (skippable(t)) continue;
                    last = i;
                    if (t.type === 'punctuation' && t.value === ';') break;
                    if (t.condDirective) break;
                }
            }
            const s = tokens[first];
            const e = tokenEnd(tokens[last]);
            spans.push({ startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col });
        }
    }
    return spans;
}

/**
 * True when a 1-based position lies inside one of the spans.
 * @param {Array<Object>} spans From suppressionSpans().
 * @param {number} line 1-based line.
 * @param {number} col 1-based column.
 * @returns {boolean}
 */
function isSuppressed(spans, line, col) {
    for (const s of spans) {
        const afterStart = line > s.startLine || (line === s.startLine && col >= s.startCol);
        const beforeEnd = line < s.endLine || (line === s.endLine && col < s.endCol);
        if (afterStart && beforeEnd) return true;
    }
    return false;
}

/**
 * True when a conditional directive in a POU/DUT head (the tokens after its keyword, up to the first
 * declaration block or body code) precedes head content — a name, EXTENDS/IMPLEMENTS or a modifier —
 * so its inheritance depends on a define. A directive right before the first VAR block (a wrapped
 * declaration block) does not count.
 * @param {Array<Object>} tokens Token stream.
 * @param {number} from Index just after the POU/TYPE keyword.
 * @returns {boolean}
 */
function headHasDirective(tokens, from) {
    let seen = false;
    for (let i = from; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.condDirective || (t.type === 'pragma' && directiveKind(t.value))) { seen = true; continue; }
        if (isTrivia(t) || t.type === 'pragma') continue;
        if (t.type === 'keyword' && !HEAD_KEYWORDS.has(t.value.toUpperCase())) return false;
        if (t.type === 'operator') return false;
        if (t.type === 'punctuation' && t.value === ';') return false;
        if (seen) return true;
    }
    return false;
}

module.exports = {
    CONDITIONAL_RE,
    BOUNDARY,
    SELECTION_CAP,
    directiveKind,
    annotateConditionals,
    blockSelections,
    suppressionSpans,
    isSuppressed,
    outermostGroup,
    headHasDirective,
    tokenEnd
};
