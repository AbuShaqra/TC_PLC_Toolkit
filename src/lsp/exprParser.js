/**
 * @file exprParser.js
 * @description Compact precedence-climbing type inference for Structured Text expressions.
 *
 * Goal is conservative typing for assignment checks: anything uncertain resolves to `unknown`
 * so callers never raise a diagnostic on a guess.
 */

const { TokenType } = require('./parser');
const {
    UNKNOWN, elementary, isNumeric,
    resolveSymbolType, lookupMember, deref, parseTypeString, findNode
} = require('./types');
const { STANDARD_TYPES } = require('./builtins');

const COMPARISON = new Set(['=', '<>', '<', '>', '<=', '>=']);
const BINPREC = {
    'OR': 1, 'XOR': 2, 'AND': 3, 'AND_THEN': 3, 'OR_ELSE': 1, '&': 3,
    '=': 4, '<>': 4, '<': 4, '>': 4, '<=': 4, '>=': 4,
    '+': 5, '-': 5,
    '*': 6, '/': 6, 'MOD': 6
};

/** Returns the elementary type of a literal token, or UNKNOWN. */
function literalType(tok) {
    if (tok.type === TokenType.Number) {
        const u = tok.value.toUpperCase();
        if (/^(LT|T|LTIME|TIME)#/.test(u)) return elementary('TIME');
        if (/^(LDATE|DATE|D)#/.test(u)) return elementary('DATE');
        if (/^(LTOD|TOD)#/.test(u)) return elementary('TOD');
        if (/^(LDT|DT)#/.test(u)) return elementary('DT');
        if (u.includes('#')) return elementary('DINT');           // based integer (16#, 2#, …)
        if (/[.][0-9]/.test(u) || /[0-9]E/.test(u)) return elementary('LREAL');
        return elementary('INT');
    }
    if (tok.type === TokenType.String) {
        return { kind: 'string', name: tok.value[0] === '"' ? 'WSTRING' : 'STRING' };
    }
    return UNKNOWN;
}

/** Numeric result of a binary numeric op (real dominates). */
function widerNumeric(a, b) {
    if ((a.name === 'LREAL' || a.name === 'REAL') || (b.name === 'LREAL' || b.name === 'REAL')) {
        return elementary('LREAL');
    }
    return elementary('DINT');
}

function combineBinary(op, a, b) {
    if (COMPARISON.has(op)) return elementary('BOOL');
    const u = op.toUpperCase();
    if (['AND', 'OR', 'XOR', 'AND_THEN', 'OR_ELSE', '&'].includes(u)) {
        if (a.kind === 'elementary' && a.name === 'BOOL' && b.kind === 'elementary' && b.name === 'BOOL') return elementary('BOOL');
        if (isNumeric(a) && isNumeric(b)) return widerNumeric(a, b);
        return UNKNOWN;
    }
    if (['+', '-', '*', '/', 'MOD'].includes(u)) {
        if (isNumeric(a) && isNumeric(b)) return widerNumeric(a, b);
        return UNKNOWN;
    }
    return UNKNOWN;
}

/** Return type of common builtin calls, or null if not a recognized typed builtin. */
function builtinCallType(name) {
    const u = name.toUpperCase();
    let m = u.match(/_TO_([A-Z0-9_]+)$/) || u.match(/^TO_([A-Z0-9_]+)$/);
    if (m && STANDARD_TYPES.has(m[1])) {
        // STRING/WSTRING are their own kind in the type model (see parseTypeString), not 'elementary' —
        // typing TO_STRING(...) as elementary would make it look incompatible with a declared STRING.
        if (m[1] === 'STRING' || m[1] === 'WSTRING') return { kind: 'string', name: m[1] };
        return elementary(m[1]);
    }
    if (u === 'ADR' || u === '__NEW') return { kind: 'pointer', name: 'POINTER', base: UNKNOWN };
    if (u === 'SIZEOF' || u === 'XSIZEOF' || u === 'BITADR') return elementary('UDINT');
    return null;
}

class ExprTyper {
    constructor(tokens, scope, index) {
        this.t = tokens;   // meaningful tokens only
        this.i = 0;
        this.scope = scope;
        this.index = index;
    }

    peek() { return this.t[this.i]; }

    parse() { return this.expr(0); }

    expr(minPrec) {
        let left = this.unary();
        while (true) {
            const op = this.peek();
            if (!op) break;
            const key = op.type === TokenType.Keyword ? op.value.toUpperCase() : op.value;
            const prec = BINPREC[key];
            if (prec === undefined || prec < minPrec) break;
            this.i++;
            const right = this.expr(prec + 1);
            left = combineBinary(key, left, right);
        }
        return left;
    }

    unary() {
        const t = this.peek();
        if (t && ((t.type === TokenType.Keyword && t.value.toUpperCase() === 'NOT') ||
                  (t.type === TokenType.Operator && (t.value === '-' || t.value === '+')))) {
            this.i++;
            return this.unary();
        }
        return this.primaryPostfix();
    }

    primaryPostfix() {
        const t = this.peek();
        if (!t) return UNKNOWN;

        if (t.type === TokenType.Punctuation && t.value === '(') {
            this.i++;
            const inner = this.expr(0);
            if (this.peek() && this.peek().value === ')') this.i++;
            return this.postfix(inner);
        }
        if (t.type === TokenType.Number || t.type === TokenType.String) {
            this.i++;
            return this.postfix(literalType(t));
        }
        if (t.type === TokenType.Keyword) {
            const u = t.value.toUpperCase();
            if (u === 'TRUE' || u === 'FALSE') { this.i++; return elementary('BOOL'); }
            if (u === 'NULL') { this.i++; return { kind: 'pointer', name: 'POINTER', base: UNKNOWN }; }
            return UNKNOWN;
        }
        if (t.type === TokenType.Identifier) {
            this.i++;
            let type = resolveSymbolType(t.value, this.scope, this.index);
            // Bare call: builtin / function return type.
            if (this.peek() && this.peek().value === '(') {
                const bi = builtinCallType(t.value);
                this.skipParens();
                if (bi) type = bi;
                else {
                    const node = findNode(this.index, t.value);
                    type = (node && node.type === 'FUNCTION') ? parseTypeString(node.returnType, this.index) : UNKNOWN;
                }
            }
            return this.postfix(type);
        }
        return UNKNOWN;
    }

    postfix(type) {
        let cur = type;
        while (this.peek()) {
            const t = this.peek();
            if (t.type === TokenType.Punctuation && t.value === '.') {
                this.i++;
                const m = this.peek();
                if (!m || m.type !== TokenType.Identifier) break;
                this.i++;
                if (cur.kind !== 'unknown') {
                    const r = lookupMember(cur, m.value, this.index);
                    cur = (r && r.kind) ? r : UNKNOWN;
                }
                if (this.peek() && this.peek().value === '(') this.skipParens(); // method call (return type already in cur)
                continue;
            }
            if (t.type === TokenType.Punctuation && t.value === '[') {
                this.skipBrackets();
                const d = deref(cur);
                cur = d.kind === 'array' ? (d.base || UNKNOWN) : UNKNOWN;
                continue;
            }
            if (t.type === TokenType.Operator && t.value === '^') {
                this.i++;
                cur = deref(cur);
                continue;
            }
            break;
        }
        return cur;
    }

    skipParens() { this.skipGroup('(', ')'); }
    skipBrackets() { this.skipGroup('[', ']'); }
    skipGroup(open, close) {
        let depth = 0;
        while (this.i < this.t.length) {
            const v = this.t[this.i].value;
            if (v === open) depth++;
            else if (v === close) { depth--; this.i++; if (depth === 0) return; continue; }
            this.i++;
        }
    }
}

/**
 * Infers the Type of an expression given as a token slice.
 * @param {Array<Object>} tokens Meaningful tokens of the expression (skippables already removed).
 * @param {Object} scope { pou, method }.
 * @param {Object} index Workspace symbol index.
 * @returns {import('./types').Type}
 */
function inferType(tokens, scope, index) {
    if (!tokens || tokens.length === 0) return UNKNOWN;
    try {
        return new ExprTyper(tokens, scope, index).parse() || UNKNOWN;
    } catch (e) {
        return UNKNOWN;
    }
}

module.exports = { inferType };
