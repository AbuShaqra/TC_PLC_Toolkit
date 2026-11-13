/**
 * @file features/onlinePaths.js
 * @description Online monitoring (R15): which ADS symbol path each variable occurrence in a pane
 * stands for. The extension host asks this for the lines a pane shows; it answers one entry per
 * occurrence with a path TEMPLATE — `MAIN.nCount`, `GVL_Io.bStart`, or `{instance}._eState` inside a
 * FUNCTION_BLOCK, whose instance the host picks from the PLC's own symbol table.
 *
 * The rules are the conservative ones of every LSP feature here: anything this cannot fully resolve
 * answers nothing, and the host checks every path against the PLC's uploaded symbols before it shows
 * a value — a path built here is a candidate, never a guess the user sees unchecked.
 *
 *   - A chain is `name ( .member | [const, …] )*`. A chain followed by `(` (a call), `^` (a pointer
 *     dereference) or an index that is not an integer literal answers nothing.
 *   - A named call argument's NAME (`fValue := …` inside a call) is the callee's parameter, not a
 *     variable, and answers nothing; its value side resolves normally.
 *   - Method locals, VAR_TEMP, VAR_IN_OUT and a FUNCTION's own variables have no ADS symbol of their
 *     own (XAE needs a breakpoint for them too): they answer with `path: null` and a `reason`, so the
 *     host can say why a write or a watch is refused instead of failing silently.
 *   - Property accessor bodies answer nothing: the parser does not record an accessor's own locals,
 *     so a local shadowing a member could not be told apart from the member.
 *   - An unqualified global resolves only when everything that could shadow or claim the name is
 *     known: the POU's EXTENDS chain is fully resolved with no library ancestor (an inherited member
 *     the index cannot see would otherwise be shown as the GVL variable's value), exactly one project
 *     GVL declares it and that GVL is known NOT to be `{attribute 'qualified_only'}` (the code cannot
 *     name its variables unqualified), no library GVL declares it, and it is not an enumerator.
 *     Wrong values are the worst failure here: when unsure, nothing is shown.
 */

const { tokenize, TokenType } = require('../parser');
const { findNode } = require('../types');
const { findActiveScope, findVarInChain, walkExtendsChain, cleanTypeName, nextMeaningful, prevMeaningful } = require('./core');

/** The placeholder a FUNCTION_BLOCK's paths start with; the host replaces it with an instance path. */
const INSTANCE = '{instance}';

/**
 * @typedef {Object} OnlineRange
 * @property {number} start First line, 0-based, in the unit.
 * @property {number} end Last line, 0-based, inclusive.
 * @property {'decl'|'impl'} pane Which pane the lines belong to.
 */

/**
 * @typedef {Object} OnlineOccurrence
 * @property {number} line 0-based unit line.
 * @property {number} start 0-based column of the chain's first character.
 * @property {number} end 0-based column just past the chain.
 * @property {'decl'|'impl'} pane
 * @property {string|null} path The ADS path template, or null when the variable has no ADS symbol.
 * @property {string|null} reason Why `path` is null: 'method-local', 'temp', 'in-out', 'function-local'.
 * @property {string|null} localType The declared type of the chain's last element, as written, or null
 *   when it cannot be followed (a library type, say). The host compares it with the online type.
 * @property {string} text The chain as written (`fbA.nState`, `arr[2]`).
 */

/**
 * The scope facts of the POU that owns a unit line, as far as paths need them.
 * @param {Object} symbolIndex
 * @param {string} fileUri
 * @param {number} line1 1-based unit line.
 * @returns {{pou: Object|null, method: Object|null, inAccessor: boolean}}
 */
function scopeAt(symbolIndex, fileUri, line1) {
    const { pou, method } = findActiveScope(symbolIndex, fileUri, line1);
    let inAccessor = false;
    if (pou && !method) {
        for (const p of pou.properties || []) {
            for (const acc of [p.getAccessor, p.setAccessor]) {
                if (!acc || !acc.implRange) continue;
                if (line1 >= acc.declRange.startLine && line1 <= acc.implRange.endLine + 1) inAccessor = true;
            }
            // The property header and its accessors' declaration lines sit between the PROPERTY line
            // and the first accessor; nothing there is a member occurrence either.
            if (p.declRange && line1 >= p.declRange.startLine) {
                const accs = [p.getAccessor, p.setAccessor].filter(a => a && a.declRange);
                const first = accs.length ? Math.min(...accs.map(a => a.declRange.startLine)) : p.declRange.startLine;
                if (line1 <= first) inAccessor = true;
            }
        }
    }
    return { pou, method, inAccessor };
}

/**
 * The path prefix for a POU's own members, or a refusal reason.
 * @param {Object} pou
 * @returns {{prefix: string|null, reason: string|null}}
 */
function ownerPrefix(pou) {
    const kind = String(pou.type || '').toUpperCase();
    if (kind === 'PROGRAM' || kind === 'GVL') return { prefix: pou.name, reason: null };
    if (kind === 'FUNCTION_BLOCK') return { prefix: INSTANCE, reason: null };
    if (kind === 'FUNCTION') return { prefix: null, reason: 'function-local' };
    return { prefix: null, reason: 'unsupported' };
}

/**
 * Why a variable of a given scope has no ADS symbol of its own, or null when it can have one.
 * @param {string} scope Declared scope, e.g. 'VAR_TEMP'.
 * @returns {string|null}
 */
function scopeRefusal(scope) {
    const s = String(scope || '').toUpperCase();
    if (s === 'VAR_TEMP') return 'temp';
    if (s === 'VAR_IN_OUT') return 'in-out';
    return null;
}

/**
 * A declaration's type as the PLC names it: the initializer (`:= …`) and an FB_init argument list
 * (`FB_Cylinder(refOut := …)`) dropped, a STRING length kept.
 * @param {string} type The type text as declared.
 * @returns {string|null}
 */
function declaredType(type) {
    if (!type) return null;
    const s = String(type);
    let depth = 0;
    let cut = s.length;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (depth === 0 && c === ':' && s[i + 1] === '=') { cut = i; break; }
    }
    let t = s.slice(0, cut).trim();
    const init = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(t);
    if (init && !/^W?STRING$/i.test(init[1])) t = init[1];
    return t || null;
}

/**
 * The element type of one indexing step on a declared type (`ARRAY[0..9] OF INT` indexed with one
 * group of `dims` subscripts gives `INT`), or null when the subscripts do not match the declaration.
 * @param {string} type
 * @param {number} dims Subscripts in the bracket group.
 * @returns {string|null}
 */
function elementType(type, dims) {
    const m = /^\s*ARRAY\s*\[([^\]]*)\]\s*OF\s+([\s\S]+)$/i.exec(type || '');
    if (!m) return null;
    if (m[1].split(',').length !== dims) return null;
    return m[2].trim();
}

/**
 * Follows a chain's members from a root declaration and returns the last element's declared type.
 * @param {string} rootType The root variable's declared type.
 * @param {Array<{member?: string, dims?: number}>} steps
 * @param {Object} symbolIndex
 * @returns {string|null}
 */
function chainType(rootType, steps, symbolIndex) {
    let type = rootType ? declaredType(rootType) : null;
    for (const step of steps) {
        if (!type) return null;
        if (step.dims) {
            type = elementType(type, step.dims);
            continue;
        }
        const node = findNode(symbolIndex, cleanTypeName(type));
        if (!node || node.external) return null;
        const v = findVarInChain(node, step.member, symbolIndex);
        type = v && v.type ? declaredType(v.type) : null;
    }
    return type || null;
}

/**
 * Reads the chain that starts at token `i`. Returns null when it is not a monitorable chain shape.
 * @param {Array<Object>} tokens
 * @param {number} i Index of the root identifier (or of THIS).
 * @returns {{rootName: string, isThis: boolean, steps: Array<{member?: string, dims?: number, text: string}>,
 *   lastIdx: number}|null}
 */
function readChain(tokens, i) {
    const root = tokens[i];
    let isThis = false;
    let j = i;
    let rootName = root.value;
    if (root.type === TokenType.Keyword && /^THIS$/i.test(root.value)) {
        const caret = nextMeaningful(tokens, i + 1);
        const dot = nextMeaningful(tokens, caret + 1);
        const name = nextMeaningful(tokens, dot + 1);
        if (!tokens[caret] || tokens[caret].value !== '^' || !tokens[dot] || tokens[dot].value !== '.'
            || !tokens[name] || tokens[name].type !== TokenType.Identifier) return null;
        isThis = true;
        rootName = tokens[name].value;
        j = name;
    }
    const steps = [];
    let lastIdx = j;
    for (;;) {
        const k = nextMeaningful(tokens, lastIdx + 1);
        const t = tokens[k];
        if (!t) break;
        if (t.value === '.') {
            const m = nextMeaningful(tokens, k + 1);
            if (!tokens[m] || tokens[m].type !== TokenType.Identifier) return null;
            steps.push({ member: tokens[m].value, text: '.' + tokens[m].value });
            lastIdx = m;
            continue;
        }
        if (t.value === '[') {
            const subs = [];
            let p = k + 1;
            let ok = false;
            let cur = '';
            for (; p < tokens.length; p++) {
                const s = tokens[p];
                if (s.type === TokenType.Whitespace || s.type === TokenType.Comment) continue;
                if (s.value === ']') { ok = cur !== ''; if (ok) subs.push(cur); break; }
                if (s.value === ',') { if (cur === '') break; subs.push(cur); cur = ''; continue; }
                if (s.type === TokenType.Operator && s.value === '-' && cur === '') { cur = '-'; continue; }
                if (s.type === TokenType.Number && /^\d+$/.test(s.value) && (cur === '' || cur === '-')) { cur += s.value; continue; }
                break; // not an integer literal: the element cannot be named statically
            }
            if (!ok) return null;
            steps.push({ dims: subs.length, text: '[' + subs.join(',') + ']' });
            lastIdx = p;
            continue;
        }
        if (t.value === '(' || t.value === '^') return null;
        break;
    }
    return { rootName, isThis, steps, lastIdx };
}

/**
 * True when token `i` is the NAME of a named call argument: inside parentheses and followed by `:=`
 * or `=>`. Its value side is an ordinary expression and is not affected.
 * @param {Array<Object>} tokens
 * @param {number} i
 * @returns {boolean}
 */
function isNamedArgName(tokens, i) {
    const after = nextMeaningful(tokens, i + 1);
    if (!tokens[after] || (tokens[after].value !== ':=' && tokens[after].value !== '=>')) return false;
    let depth = 0;
    for (let k = i - 1; k >= 0; k--) {
        const v = tokens[k].value;
        if (tokens[k].type !== TokenType.Punctuation) continue;
        if (v === ')') depth++;
        else if (v === '(') { if (depth === 0) return true; depth--; }
        else if (v === ';') return false;
    }
    return false;
}

/**
 * Resolves the root of a chain to its path prefix and declared type.
 * @param {string} name Root identifier.
 * @param {boolean} isThis Written as `THIS^.name`.
 * @param {{pou: Object|null, method: Object|null}} scope
 * @param {Object} symbolIndex
 * @param {boolean} hasMember Whether the chain continues with `.member` (a GVL/PROGRAM qualifier needs one).
 * @returns {{path: string|null, reason: string|null, type: string|null, consumed: number, node?: Object}|null}
 *   `consumed` is 1 when the root was a GVL/PROGRAM qualifier that already used the first member.
 */
function resolveRoot(name, isThis, scope, symbolIndex, hasMember) {
    const lower = name.toLowerCase();
    const { pou, method } = scope;
    if (isThis) {
        if (!pou || String(pou.type).toUpperCase() !== 'FUNCTION_BLOCK') return null;
        const v = findVarInChain(pou, name, symbolIndex);
        if (!v) return null;
        const refused = scopeRefusal(v.scope);
        return { path: refused ? null : `${INSTANCE}.${v.name}`, reason: refused, type: v.type || null, consumed: 0 };
    }
    if (method) {
        if (method.name && method.name.toLowerCase() === lower) return { path: null, reason: 'method-local', type: null, consumed: 0 };
        const local = (method.variables || []).find(v => v.name.toLowerCase() === lower);
        if (local) return { path: null, reason: 'method-local', type: local.type || null, consumed: 0 };
    }
    if (pou) {
        const v = findVarInChain(pou, name, symbolIndex);
        if (v && !('getAccessor' in v)) {
            const owner = ownerPrefix(pou);
            const refused = owner.reason || scopeRefusal(v.scope);
            if (refused) return { path: null, reason: refused, type: v.type || null, consumed: 0 };
            return { path: `${owner.prefix}.${v.name}`, reason: null, type: v.type || null, consumed: 0 };
        }
        if (v) return null; // a property: answers only when the PLC exposes it, not worth guessing a path for
    }
    // A GVL or PROGRAM name qualifies its own variable: `GVL_Io.bStart`, `MAIN.nCount`.
    const node = findNode(symbolIndex, name);
    if (node && hasMember && !node.external) {
        const kind = String(node.type || '').toUpperCase();
        if (kind === 'GVL' || kind === 'PROGRAM') return { path: node.name, reason: null, type: null, consumed: 1, node };
        return null;
    }
    if (node) return null; // a type, a function, an FB name: not a variable
    return unqualifiedGlobal(name, pou, symbolIndex);
}

/**
 * An unqualified name as a GVL variable, only when nothing else can be what the name means (see the
 * file header). Any doubt answers null.
 * @param {string} name
 * @param {Object|null} pou The POU the name is used in.
 * @param {Object} symbolIndex
 * @returns {{path: string, reason: null, type: string|null, consumed: 0}|null}
 */
function unqualifiedGlobal(name, pou, symbolIndex) {
    const lower = name.toLowerCase();
    if (pou) {
        // An ancestor the index cannot read (unknown, a library FB, or behind a define) may declare it.
        const chain = walkExtendsChain(pou, symbolIndex);
        if (!chain.fullyResolved || pou.external || chain.ancestors.some(a => a.external)) return null;
    }
    const owners = [];
    for (const key of Object.keys(symbolIndex)) {
        const n = symbolIndex[key];
        if (!n) continue;
        const kind = String(n.type).toUpperCase();
        const vars = n.variables || [];
        const hit = vars.find(x => x && String(x.name).toLowerCase() === lower);
        if (!hit) continue;
        // An enumerator of the same name: the code may mean the enum value.
        if ((kind === 'DUT' && n.dutKind === 'enum') || hit.type === 'Enum' || String(hit.scope).toUpperCase() === 'ENUM') return null;
        if (kind !== 'GVL') continue;
        if (n.external) return null;                 // a library global of that name: ambiguous
        if (n.qualifiedOnly !== false) continue;     // qualified_only, or not known not to be: never unqualified
        owners.push({ n, v: hit });
    }
    if (owners.length !== 1) return null;
    return { path: `${owners[0].n.name}.${owners[0].v.name}`, reason: null, type: owners[0].v.type || null, consumed: 0 };
}

/**
 * The online-path occurrences on the given lines of a unit.
 * @param {string} code The assembled unit.
 * @param {Array<OnlineRange>} ranges Lines to answer for, per pane.
 * @param {Object} symbolIndex Workspace symbol index, already synced with `code`.
 * @param {string} fileUri
 * @returns {{occurrences: Array<OnlineOccurrence>, owner: {name: string, kind: string, derived: string[]}|null}}
 */
function provideOnlinePaths(code, ranges, symbolIndex, fileUri) {
    /** @type {Array<OnlineOccurrence>} */
    const occurrences = [];
    let tokens;
    try { tokens = tokenize(code); } catch (e) { return { occurrences, owner: null }; }
    const lines = code.split('\n');
    const inRange = (line0, pane) => (ranges || []).some(r => r.pane === pane && line0 >= r.start && line0 <= r.end);
    const paneOf = (line0) => {
        for (const r of ranges || []) if (line0 >= r.start && line0 <= r.end) return r.pane;
        return null;
    };

    let ownerNode = null;
    // A variable's range is trusted only where the unit has its name, once: a range in another
    // coordinate system would put one variable's value on another's line. Both indexers emit unit
    // lines (parser.js, and xmlIndexer.js `unitLineMap`); this is the check that keeps it so.
    /** @type {Set<string>} */
    const placed = new Set();
    const isNameAt = (/** @type {number} */ line0, /** @type {any} */ v) => {
        const text = lines[line0];
        const key = `${line0}:${v.range.startCol}`;
        if (text === undefined || placed.has(key)) return false;
        if (text.slice(v.range.startCol - 1, v.range.endCol - 1).toLowerCase() !== String(v.name).toLowerCase()) return false;
        placed.add(key);
        return true;
    };
    // Declaration panes: one occurrence per declared NAME, never the initializers.
    for (const key of Object.keys(symbolIndex)) {
        const n = symbolIndex[key];
        if (!n || n.uri !== fileUri) continue;
        ownerNode = ownerNode || n;
        const owner = ownerPrefix(n);
        for (const v of n.variables || []) {
            if (!v.range || v.type === 'Enum' || String(v.scope).toUpperCase() === 'ENUM') continue;
            const line0 = v.range.startLine - 1;
            if (!inRange(line0, 'decl') || !isNameAt(line0, v)) continue;
            const refused = owner.reason || scopeRefusal(v.scope);
            occurrences.push({
                line: line0, start: v.range.startCol - 1, end: v.range.endCol - 1, pane: 'decl',
                path: refused ? null : `${owner.prefix}.${v.name}`, reason: refused,
                localType: v.type ? declaredType(v.type) : null, text: v.name
            });
        }
        for (const m of n.methods || []) {
            for (const v of m.variables || []) {
                if (!v.range) continue;
                const line0 = v.range.startLine - 1;
                if (!inRange(line0, 'decl') || !isNameAt(line0, v)) continue;
                occurrences.push({ line: line0, start: v.range.startCol - 1, end: v.range.endCol - 1, pane: 'decl',
                    path: null, reason: 'method-local', localType: v.type || null, text: v.name });
            }
        }
    }

    // Implementation panes: every identifier chain.
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== TokenType.Identifier && !(t.type === TokenType.Keyword && /^THIS$/i.test(t.value))) continue;
        const line0 = t.line - 1;
        if (paneOf(line0) !== 'impl') continue;
        const prev = prevMeaningful(tokens, i - 1);
        if (prev >= 0 && (tokens[prev].value === '.' || tokens[prev].value === '^')) continue;
        if (t.type === TokenType.Identifier && isNamedArgName(tokens, i)) continue;
        const chain = readChain(tokens, i);
        if (!chain) continue;
        const scope = scopeAt(symbolIndex, fileUri, t.line);
        if (scope.inAccessor) continue;
        const firstIsMember = chain.steps.length > 0 && !!chain.steps[0].member;
        const root = resolveRoot(chain.rootName, chain.isThis, scope, symbolIndex, firstIsMember);
        const last = tokens[chain.lastIdx];
        const endLine0 = last.line - 1;
        if (!root || endLine0 !== line0) { i = chain.lastIdx; continue; }
        let path = root.path;
        let type = root.type;
        let steps = chain.steps;
        if (root.consumed) {
            const gvlVar = (root.node.variables || []).find(v => v.name.toLowerCase() === steps[0].member.toLowerCase());
            if (!gvlVar) { i = chain.lastIdx; continue; }
            const refused = String(root.node.type).toUpperCase() === 'PROGRAM' ? scopeRefusal(gvlVar.scope) : null;
            path = refused ? null : `${root.node.name}.${gvlVar.name}`;
            type = gvlVar.type || null;
            steps = steps.slice(1);
            if (refused) {
                occurrences.push({ line: line0, start: t.col - 1, end: last.col - 1 + last.value.length, pane: 'impl',
                    path: null, reason: refused, localType: null, text: lines[line0].slice(t.col - 1, last.col - 1 + last.value.length) });
                i = chain.lastIdx;
                continue;
            }
        }
        const suffix = steps.map(s => s.text).join('');
        occurrences.push({
            line: line0, start: t.col - 1, end: last.col - 1 + last.value.length, pane: 'impl',
            path: path ? path + suffix : null,
            reason: path ? null : root.reason,
            localType: path ? chainType(type, steps, symbolIndex) : null,
            text: lines[line0].slice(t.col - 1, last.col - 1 + last.value.length)
        });
        i = chain.lastIdx;
    }

    let owner = null;
    if (ownerNode) {
        const derived = [];
        if (String(ownerNode.type).toUpperCase() === 'FUNCTION_BLOCK') {
            for (const key of Object.keys(symbolIndex)) {
                const n = symbolIndex[key];
                if (!n || n === ownerNode || String(n.type).toUpperCase() !== 'FUNCTION_BLOCK') continue;
                if (walkExtendsChain(n, symbolIndex).ancestors.includes(ownerNode)) derived.push(n.name);
            }
        }
        owner = { name: ownerNode.name, kind: String(ownerNode.type || '').toUpperCase(), derived };
    }
    occurrences.sort((a, b) => a.line - b.line || a.start - b.start);
    return { occurrences, owner };
}

module.exports = { provideOnlinePaths, INSTANCE, readChain, elementType };
