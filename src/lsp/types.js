/**
 * @file types.js
 * @description Structured Text type model and resolution engine for semantic diagnostics.
 *
 * Design rule: when a type cannot be fully resolved, every function returns an `unknown` type and
 * callers must NOT raise a diagnostic. Conservatism here is what keeps the checker free of
 * false positives — we only ever flag things we are certain about.
 */

const { STANDARD_TYPES, isBuiltin } = require('./builtins');

/**
 * @typedef {Object} Type
 * @property {string} kind  'elementary'|'fb'|'struct'|'enum'|'interface'|'namespace'|
 *                          'pointer'|'reference'|'array'|'string'|'unknown'
 * @property {string} name  Canonical name (e.g. 'INT', 'FB_Bin').
 * @property {Type} [base]  Element/pointed-to type for pointer/reference/array.
 * @property {boolean} [external] The type comes from an external library (libsymbols.js), or from a
 *                          member of one. Everything we know about it is partial, so **no check may
 *                          ever flag it** — see markExternal.
 * @property {boolean} [anonymous] An inline enum declared at its use site (`e : (idle, running)`).
 *                          It has no DUT node and no nominal identity, so it can never be proved
 *                          incompatible with anything — isAssignable declines on it.
 * @property {string[]} [values] The value names of an `anonymous` enum, in declaration order. They
 *                          ride on the Type because there is no node to hang them off.
 */

const UNKNOWN = { kind: 'unknown', name: '' };

/**
 * Tags a Type as coming from an external library, so that no check can flag it.
 *
 * The `.tmc` gives library types real members (libsymbols.js), which lets `stAxis.Position` resolve
 * to LREAL instead of `unknown` — a strict improvement for completion, but a *new* way for a wrong
 * or incomplete description to reach the assignability check and manufacture a false positive on
 * correct code (a member the `.tmc` describes as its element type where it is really an array, say).
 * The flag closes that door outright: isAssignable returns 'ok' the moment either side carries it.
 * We can never legitimately flag a library type — we only ever have a partial view of one — so the
 * flag costs no real diagnostic and buys airtightness.
 *
 * Returns a copy: the `unknown` singleton and cached member types must never be mutated.
 * @param {Type} type Type to tag.
 * @returns {Type} The tagged type ('unknown' is returned unchanged — it is already silent).
 */
function markExternal(type) {
    if (!type || type.kind === 'unknown' || type.external) return type;
    return Object.assign({}, type, { external: true });
}

/**
 * True when a member that was NOT found on `type`/`node` must be reported as *uncertain* rather than
 * *absent* — i.e. lookupMember must return `undefined`, never `null`.
 *
 * Both halves matter. `type.external` catches a type derived from a library one (a member's type,
 * a pointer's base). `node.membersComplete === false` catches the node itself: a library node's
 * member list is whatever the `.tmc` happened to export, which is a partial view by construction.
 * @param {Type} type The parent type.
 * @param {Object} node Its symbol-index node (may be null).
 * @returns {boolean}
 */
function membersUncertain(type, node) {
    return !!(type && type.external) || !!(node && node.membersComplete === false);
}

function elementary(name) { return { kind: 'elementary', name: name.toUpperCase() }; }

/** Numeric category of an elementary type, or null. */
function numericCategory(name) {
    const u = name.toUpperCase();
    if (['SINT', 'INT', 'DINT', 'LINT'].includes(u)) return 'int';
    if (['USINT', 'UINT', 'UDINT', 'ULINT'].includes(u)) return 'uint';
    if (['BYTE', 'WORD', 'DWORD', 'LWORD', 'BIT'].includes(u)) return 'bits';
    if (['REAL', 'LREAL'].includes(u)) return 'real';
    return null;
}

function isNumeric(t) {
    return t.kind === 'elementary' && numericCategory(t.name) !== null;
}

/**
 * True for STRING/WSTRING however they were built. Declared strings carry kind 'string'
 * (see parseTypeString), but other paths may hand us an `elementary` type merely *named*
 * STRING/WSTRING; both denote the same thing and must never be reported as a mismatch.
 * @param {Type} t
 * @returns {boolean}
 */
function isStringLike(t) {
    if (!t) return false;
    if (t.kind === 'string') return true;
    return t.kind === 'elementary' && (t.name === 'STRING' || t.name === 'WSTRING');
}

/** Case-insensitive lookup of a node in the symbol index. */
function findNode(index, name) {
    if (!name) return null;
    if (index[name]) return index[name];
    const lower = name.toLowerCase();
    const key = Object.keys(index).find(k => k.toLowerCase() === lower);
    return key ? index[key] : null;
}

/** True if a DUT node represents an enum (all members are enum members). */
function isEnumNode(node) {
    return node.type === 'DUT'
        && node.variables.length > 0
        && node.variables.every(v => (v.scope === 'ENUM') || (v.type === 'Enum'));
}

/**
 * Maps a symbol-index node to its Type.
 *
 * **External library nodes** (`node.external`, registered from libsymbols.js) come in two shapes:
 *
 *   - a **bare name** from an archive string table — no kind, no members, nothing behind it. It
 *     resolves to the fully anonymous UNKNOWN, for the same reason parseTypeString does it for
 *     builtins below. An `unknown` type is never member-checked, so `libType.SomeMember` stays
 *     silent instead of being flagged "is not a member of type".
 *
 *     The empty `name` is deliberate, not laziness. checkDeclarationTypes (features.js) reports an
 *     `unknown` leaf type unless its name is empty, builtin, or qualified — so a *named* unknown
 *     would make `inst : Tc2_System.T_MaxString;` newly flagged "Unknown type": the qualified name
 *     used to survive to that check with its dot intact (and be skipped as complex), whereas
 *     resolving it through a library node hands back the bare last segment. Staying anonymous keeps
 *     the check silent on every library type, qualified or not.
 *
 *   - a type the project's **`.tmc`** describes (`node.libKind`), which carries real members. It
 *     resolves to that concrete kind — so `stAxis.▮` completes with the fields of `ST_AxisStatus`
 *     and a library enum can be a CASE selector — but the Type is tagged `external`, and the node
 *     carries `membersComplete: false`. Together those two make the concrete kind unflaggable:
 *     lookupMember answers `undefined` (uncertain) rather than `null` (absent) for a member it does
 *     not find, isAssignable answers 'ok' on sight, and getCallParams/getInitParams decline to
 *     validate. The `.tmc` covers only what the project uses and only `<DataType>` blocks, so
 *     anything else would fabricate diagnostics on correct code. **Richness in completion,
 *     silence in diagnostics — the two must not be traded against each other.**
 *
 * An **alias** (`TYPE T_Handle : DWORD; END_TYPE`) or **subrange** (`TYPE T_Percent : INT(0..100);
 * END_TYPE`) DUT resolves to that same anonymous UNKNOWN. Such a DUT declares no members, so it is
 * indistinguishable from an empty struct by `isEnumNode` alone and used to fall through to
 * `kind: 'struct'` — which made both of these false positives on valid ST:
 *   - `nCount : INT := aliasVar;` → 'cannot assign "T_Handle" to "INT"' (struct vs numeric);
 *   - `aliasVar.anything` → '"anything" is not a member of type "T_Handle"' (empty field set).
 * `node.dutKind` (set by xmlIndexer.js) is what tells the two apart. The alias is deliberately NOT
 * resolved to its underlying type: that could only ever *add* diagnostics, and silence is the
 * conservative answer. Nodes with no `dutKind` (e.g. built by parser.js) keep the old behaviour.
 * A `.tmc` type with no members ('opaque' — an alias, a subrange, an opaque handle) carries no
 * `libKind` for exactly the same reason, and stays anonymous too.
 * @param {Object} node Symbol index node.
 * @returns {Type}
 */
function typeFromNode(node) {
    if (!node) return UNKNOWN;
    if (node.external) {
        switch (node.libKind) {
            case 'struct': return { kind: 'struct', name: node.name, external: true };
            case 'fb': return { kind: 'fb', name: node.name, external: true };
            case 'enum': return { kind: 'enum', name: node.name, external: true };
            default: return UNKNOWN; // bare archive name, or a `.tmc` type with no members
        }
    }
    switch (node.type) {
        case 'FUNCTION_BLOCK':
        case 'PROGRAM':
        case 'FUNCTION':
            return { kind: 'fb', name: node.name };
        case 'INTERFACE':
            return { kind: 'interface', name: node.name };
        case 'GVL':
            return { kind: 'namespace', name: node.name };
        case 'DUT':
            if (node.dutKind === 'alias') return UNKNOWN;
            return isEnumNode(node)
                ? { kind: 'enum', name: node.name }
                : { kind: 'struct', name: node.name };
        default:
            return UNKNOWN;
    }
}

/**
 * Parses a declaration type string into a Type.
 * Handles POINTER/REFERENCE TO, ARRAY [..] OF, STRING(n), qualified names, builtins, indexed types.
 * @param {string} typeStr Raw type text (may include ':= default').
 * @param {Object} index Workspace symbol index.
 * @returns {Type}
 */
function parseTypeString(typeStr, index) {
    if (!typeStr) return UNKNOWN;
    let t = String(typeStr).trim();

    // Inline (anonymous) enum: `eState : (idle, running, faulted)`, values optionally numbered
    // (`(idle := 0, running := 10)`). There is no DUT node to point at — the type IS the
    // declaration — so the values travel on the Type itself, and `anonymous` marks that its
    // identity is structural, not nominal. Without this the whole declaration fell through to a
    // NAMED unknown ('(idle, running)'), which is exactly the shape declarationTypes would flag as
    // an unknown type the day it is switched on, and which no CASE selector could resolve.
    //
    // Deliberately BEFORE the initializer strip below: that cuts at the first ':=', which for a
    // numbered enum lands INSIDE the parentheses and leaves the unparseable '(idle'. The match is
    // therefore not end-anchored either — a declaration may carry its own initializer after the
    // closing paren (`(idle, running) := idle`), and `[^)]*` already stops at the first ')'.
    const inlineEnum = t.match(/^\(([^)]*)\)/);
    if (inlineEnum) {
        const values = inlineEnum[1]
            .split(',')
            .map(v => v.split(':=')[0].trim())
            .filter(v => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v));
        if (values.length) return { kind: 'enum', name: `(${inlineEnum[1].trim()})`, anonymous: true, values };
    }

    // Strip initializer.
    const assign = t.indexOf(':=');
    if (assign !== -1) t = t.substring(0, assign).trim();
    if (!t) return UNKNOWN;

    // POINTER TO X / REFERENCE TO X
    const ptr = t.match(/^(POINTER|REFERENCE)\s+TO\s+(.+)$/i);
    if (ptr) {
        return {
            kind: ptr[1].toLowerCase() === 'pointer' ? 'pointer' : 'reference',
            name: t,
            base: parseTypeString(ptr[2], index)
        };
    }

    // ARRAY [..] OF X
    const arr = t.match(/^ARRAY\s*\[[^\]]*\]\s*OF\s+(.+)$/i);
    if (arr) {
        return { kind: 'array', name: t, base: parseTypeString(arr[1], index) };
    }

    // STRING / WSTRING (optionally sized)
    const str = t.match(/^(W?STRING)\s*(\(\s*\d+\s*\)|\[\s*\d+\s*\])?$/i);
    if (str) {
        return { kind: 'string', name: str[1].toUpperCase() };
    }

    // Bare identifier (possibly qualified namespace.Type)
    const idMatch = t.match(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/);
    if (idMatch) {
        const upper = t.toUpperCase();
        if (STANDARD_TYPES.has(upper)) return elementary(upper);

        // Indexed type (try full, then last qualified segment).
        let node = findNode(index, t);
        if (!node && t.includes('.')) {
            node = findNode(index, t.split('.').pop());
        }
        if (node) return typeFromNode(node);

        // Standard library FB/function/system names (e.g. TON, R_TRIG): valid types, but their
        // members are not indexed — resolve to 'unknown' so member access is never flagged.
        if (isBuiltin(t)) return { kind: 'unknown', name: upper };

        return { kind: 'unknown', name: t };
    }

    return { kind: 'unknown', name: t };
}

/** Strips pointer/reference wrappers to reach the underlying value type. */
function deref(type) {
    let t = type;
    while (t && (t.kind === 'pointer' || t.kind === 'reference') && t.base) t = t.base;
    return t || UNKNOWN;
}

/**
 * Looks up a member on a type and returns the member's Type.
 *
 * The three possible answers are what the whole member-access check rests on, so they must not be
 * conflated:
 *   - a **Type**      — the member exists, and this is what it is;
 *   - **null**        — the member is *definitely absent*  ⇒ the caller flags it;
 *   - **undefined**   — we *cannot be sure*                ⇒ the caller stays silent.
 *
 * For an **external (library) type** the answer is never `null`. Its member list is whatever the
 * `.tmc` exported — a partial view by construction (only the types the project uses, only
 * `<DataType>` blocks, member lists not guaranteed exhaustive) — so "not found here" simply does not
 * license "does not exist". `membersUncertain()` is what enforces that, and the member types handed
 * back are tagged `external` so nothing downstream can flag them either.
 * @param {Type} type Parent type.
 * @param {string} member Member name.
 * @param {Object} index Workspace symbol index.
 * @returns {Type|null|undefined} See above.
 */
function lookupMember(type, member, index) {
    const t = deref(type);
    if (!t || t.kind === 'unknown') return undefined; // can't tell — caller must not flag
    if (t.kind === 'elementary' || t.kind === 'string' || t.kind === 'array' || t.kind === 'enum') {
        // Enums are accessed as Enum.Member; members live on the node.
        if (t.kind === 'enum') {
            const node = findNode(index, t.name);
            if (!node) return undefined;
            const uncertain = membersUncertain(t, node);
            const m = node.variables.find(v => v.name.toLowerCase() === member.toLowerCase());
            if (m) return uncertain ? markExternal(elementary('INT')) : elementary('INT');
            return uncertain ? undefined : null;
        }
        return null; // no members on scalars/strings/arrays
    }

    const node = findNode(index, t.name);
    if (!node) return undefined;

    const uncertain = membersUncertain(t, node);
    const mark = (resolved) => (uncertain ? markExternal(resolved) : resolved);
    const lower = member.toLowerCase();

    const v = node.variables.find(x => x.name.toLowerCase() === lower);
    if (v) return mark(parseTypeString(v.type, index));

    const p = (node.properties || []).find(x => x.name.toLowerCase() === lower);
    if (p) return mark(parseTypeString(p.type, index));

    const m = (node.methods || []).find(x => x.name.toLowerCase() === lower);
    if (m) return mark(parseTypeString(m.returnType, index));

    const a = (node.actions || []).find(x => x.name.toLowerCase() === lower);
    if (a) return { kind: 'unknown', name: '' }; // actions have no value type

    // Walk EXTENDS parents for inherited members. An INTERFACE may extend SEVERAL interfaces
    // (`I_C EXTENDS I_A, I_B`), so every parent must be searched — checking only the first would
    // resolve the interface yet miss a second-parent member and return `null` (definitely absent),
    // a false "not a member" diagnostic on correct code.
    let sawUncertainParent = false;
    for (const parentName of parentNames(node)) {
        const parentType = parseTypeString(parentName, index);
        if (parentType.kind === 'unknown') { sawUncertainParent = true; continue; }
        const inherited = lookupMember(parentType, member, index);
        if (inherited === undefined) sawUncertainParent = true;   // deeper chain uncertain
        else if (inherited !== null) return inherited;            // found it
        // inherited === null → definitely absent in THIS parent; keep checking the others
    }
    if (sawUncertainParent) return undefined; // a parent we can't fully see could hold the member

    // Absent from a library type means "not in the partial view we have of it" — never "absent".
    //
    // This is not theoretical caution. The `.tmc` describes a `<DataType>`'s *fields*, and nothing
    // else — an FB's METHODS are not in it at all. Let this return `null` and the sample instantly
    // gains **79 false positives** ("ReadStatus" is not a member of type "AXIS_REF",
    // "GetString" is not a member of type "FB_JsonDomParser", …) on perfectly correct code.
    return uncertain ? undefined : null;
}

/**
 * Resolves the Type of a leading identifier within a scope.
 * @param {string} name Identifier.
 * @param {Object} scope { pou, method }.
 * @param {Object} index Workspace symbol index.
 * @returns {Type}
 */
function resolveSymbolType(name, scope, index) {
    const lower = name.toLowerCase();

    if (scope && scope.method) {
        const v = scope.method.variables.find(x => x.name.toLowerCase() === lower);
        if (v) return parseTypeString(v.type, index);
    }
    if (scope && scope.pou) {
        // IEC return-value idiom: inside `FUNCTION F : T`, the bare name `F` denotes the function's
        // return value (`F := <value>;`), not the function itself. Resolve it to the declared return
        // type. If the return type is missing or unparseable, parseTypeString yields `unknown` and
        // the caller stays silent — which is exactly the conservative behaviour we want.
        if (scope.pou.type === 'FUNCTION' && scope.pou.name.toLowerCase() === lower) {
            return parseTypeString(scope.pou.returnType, index);
        }

        const v = scope.pou.variables.find(x => x.name.toLowerCase() === lower);
        if (v) return parseTypeString(v.type, index);
        const p = (scope.pou.properties || []).find(x => x.name.toLowerCase() === lower);
        if (p) return parseTypeString(p.type, index);
        const m = (scope.pou.methods || []).find(x => x.name.toLowerCase() === lower);
        if (m) return parseTypeString(m.returnType, index);
    }

    // GVL globals (unqualified, when 'qualified_only' is not enforced).
    for (const key of Object.keys(index)) {
        const node = index[key];
        if (node.type === 'GVL') {
            const v = node.variables.find(x => x.name.toLowerCase() === lower);
            if (v) return parseTypeString(v.type, index);
        }
    }

    // A type / POU / GVL name used directly (FB instance type, enum namespace, GVL namespace).
    const node = findNode(index, name);
    if (node) return typeFromNode(node);

    return UNKNOWN;
}

/**
 * Resolves a dotted path, validating each member hop.
 * @param {string[]} parts Path segments (array indexes already stripped).
 * @param {Object} scope { pou, method }.
 * @param {Object} index Workspace symbol index.
 * @returns {{ type: Type, failedAt: number }} failedAt is the index of the first unresolved
 *          member segment (>=1), or -1 if fully resolved (or undeterminable, in which case type is unknown).
 */
function resolvePath(parts, scope, index) {
    if (!parts.length) return { type: UNKNOWN, failedAt: -1 };
    let current = resolveSymbolType(parts[0], scope, index);
    if (current.kind === 'unknown') return { type: UNKNOWN, failedAt: -1 };

    for (let i = 1; i < parts.length; i++) {
        const member = lookupMember(current, parts[i], index);
        if (member === undefined) return { type: UNKNOWN, failedAt: -1 }; // can't tell
        if (member === null) return { type: UNKNOWN, failedAt: i };       // definitely absent
        current = member;
    }
    return { type: current, failedAt: -1 };
}

/**
 * Conservative assignability check.
 * @param {Type} target Declared/target type.
 * @param {Type} source Source/value type.
 * @returns {'ok'|'incompatible'|'unknown'|'related'}
 */
function isAssignable(target, source) {
    if (!target || !source) return 'unknown';
    const a = deref(target);
    const b = deref(source);
    if (a.kind === 'unknown' || b.kind === 'unknown') return 'unknown';

    // Either side is a library type, or derives from one (markExternal). Everything we know about it
    // comes from the `.tmc`, which is a partial and occasionally imprecise view — so a mismatch here
    // would as likely be our description being wrong as the code being wrong, and the code is ground
    // truth. Never flag it. This is what lets typeFromNode hand back a *concrete* kind for a library
    // type (which completion needs) without that kind ever reaching a diagnostic.
    if (a.external || b.external) return 'ok';

    // STRING/WSTRING on both sides — checked first so a kind mismatch between an `elementary`
    // STRING (e.g. from a conversion builtin) and a declared kind-'string' never reads as an error.
    if (isStringLike(a) && isStringLike(b)) return 'ok';

    if (a.kind === 'elementary' && b.kind === 'elementary') {
        if (a.name === b.name) return 'ok';
        // Allow all numeric<->numeric (TwinCAT permits many implicit conversions; stay quiet).
        if (isNumeric(a) && isNumeric(b)) return 'ok';
        // BOOL <-> numeric and other elementary mixes are common with bit ops; don't flag.
        return 'ok';
    }

    // enum behaves like INT (non-strict); allow with numerics and itself.
    if (a.kind === 'enum' || b.kind === 'enum') {
        // An inline enum has no nominal identity, so nothing here can PROVE a mismatch: its value
        // names live in the enclosing scope and are routinely shared with a named enum or a
        // constant. Diagnostics are conservative by design — decline rather than invent a clash.
        if (a.anonymous || b.anonymous) return 'ok';
        if (a.name === b.name) return 'ok';
        if ((a.kind === 'enum' && isNumeric(b)) || (b.kind === 'enum' && isNumeric(a))) return 'ok';
        if (a.kind === 'enum' && b.kind === 'enum') return 'incompatible';
        return 'incompatible';
    }

    // FB/struct/interface: same name, or source implements/extends target.
    if (['fb', 'struct', 'interface'].includes(a.kind) && ['fb', 'struct', 'interface'].includes(b.kind)) {
        if (a.name.toLowerCase() === b.name.toLowerCase()) return 'ok';
        return 'related'; // inheritance/interface checks handled by caller with the index
    }

    if (a.kind === 'array' && b.kind === 'array') return 'ok';
    if (a.kind === 'pointer' || b.kind === 'pointer') return 'ok';

    // Clear category mismatch (e.g. struct target, numeric source).
    return 'incompatible';
}

/**
 * The direct EXTENDS parents of a node. An INTERFACE may extend several (`EXTENDS I_A, I_B`); FBs and
 * structs extend one. `extendsAll` carries the full list; `extends` is kept as the first parent for
 * single-parent call sites that predate multiple inheritance.
 * @param {Object} node
 * @returns {string[]} Parent type names (possibly empty).
 */
function parentNames(node) {
    if (!node) return [];
    if (node.extendsAll && node.extendsAll.length) return node.extendsAll;
    return node.extends ? [node.extends] : [];
}

/**
 * Resolves whether `source` (fb/struct/interface) is assignable to `target` using EXTENDS/IMPLEMENTS.
 * Traverses the full inheritance DAG (an interface may extend several; an FB's implemented interfaces
 * may themselves extend others), so `fb IMPLEMENTS I_C` with `I_C EXTENDS I_A` is assignable to I_A.
 * @param {Type} target
 * @param {Type} source
 * @param {Object} index
 * @returns {boolean}
 */
function isRelatedAssignable(target, source, index) {
    const targetName = target.name.toLowerCase();
    const seen = new Set();
    const queue = [findNode(index, source.name)];
    while (queue.length) {
        const node = queue.shift();
        if (!node || seen.has(node.name.toLowerCase())) continue;
        seen.add(node.name.toLowerCase());
        if (node.name.toLowerCase() === targetName) return true;
        if ((node.implements || []).some(i => i.toLowerCase() === targetName)) return true;
        for (const pn of parentNames(node)) { const p = findNode(index, pn); if (p) queue.push(p); }
        for (const impl of (node.implements || [])) { const p = findNode(index, impl); if (p) queue.push(p); }
    }
    return false;
}

/** Builds the set of nameable call-parameter names (VAR_INPUT/OUTPUT/IN_OUT) from a variable list. */
function paramSetFromVars(vars) {
    const s = new Set();
    (vars || []).forEach(v => {
        const sc = (v.scope || '').toUpperCase();
        if (sc === 'VAR_INPUT' || sc === 'VAR_OUTPUT' || sc === 'VAR_IN_OUT') s.add(v.name.toLowerCase());
    });
    return s;
}

/** Collects all call parameters of an FB/function node, including inherited ones; null if any ancestor is unknown. */
function collectParams(node, index) {
    const set = new Set();
    const seen = new Set();
    let cur = node;
    while (cur && !seen.has(cur.name)) {
        seen.add(cur.name);
        for (const n of paramSetFromVars(cur.variables)) set.add(n);
        if (cur.extends) {
            const p = findNode(index, cur.extends);
            if (!p) return null; // unknown ancestor — can't be sure of the full parameter set
            cur = p;
        } else {
            cur = null;
        }
    }
    return set;
}

/**
 * Finds a method by name across the EXTENDS chain, together with the node that declares it.
 * Callers that need to navigate to the declaration (uri/component) must use this rather than
 * findMethodInChain, because an inherited method lives in a *base* node, not in `node`.
 * @param {Object} node Starting symbol-index node.
 * @param {string} name Method name (case-insensitive).
 * @param {Object} index Workspace symbol index.
 * @returns {{method: Object, owner: Object}|null|undefined} The method and its declaring node,
 *          null if definitely absent, undefined if the chain is uncertain (unknown ancestor).
 */
function findMethodOwnerInChain(node, name, index) {
    const lower = name.toLowerCase();
    const seen = new Set();
    const queue = [node];
    let sawUnknownAncestor = false;
    while (queue.length) {
        const cur = queue.shift();
        if (!cur || seen.has(cur.name.toLowerCase())) continue;
        seen.add(cur.name.toLowerCase());
        const m = (cur.methods || []).find(x => x.name.toLowerCase() === lower);
        if (m) return { method: m, owner: cur };
        for (const pn of parentNames(cur)) {
            const p = findNode(index, pn);
            if (!p) { sawUnknownAncestor = true; continue; } // unknown ancestor — chain uncertain
            queue.push(p);
        }
    }
    return sawUnknownAncestor ? undefined : null;
}

/**
 * Finds a method by name across the EXTENDS chain.
 * @returns {Object|null|undefined} method node, null if definitely absent, undefined if chain is uncertain.
 */
function findMethodInChain(node, name, index) {
    const found = findMethodOwnerInChain(node, name, index);
    if (found === undefined) return undefined;
    return found ? found.method : null;
}

/**
 * Resolves the expected named-parameter set for a call.
 * @param {Type|null} receiverType Type of the receiver (for `recv.method(...)`), or null for a bare call.
 * @param {string} callee Callee identifier.
 * @param {Object} scope { pou, method }.
 * @param {Object} index Workspace symbol index.
 * @returns {Set<string>|null} Lowercased valid parameter names, or null when it can't be determined (skip).
 */
function getCallParams(receiverType, callee, scope, index) {
    if (receiverType) {
        const d = deref(receiverType);
        if (d.kind === 'unknown') return null;
        const node = findNode(index, d.name);
        if (!node) return null;
        if (node.external) return null; // library FB: the `.tmc` lists no methods — never validate
        const m = findMethodInChain(node, callee, index);
        if (!m) return null; // unknown or absent — don't validate parameters
        return paramSetFromVars(m.variables);
    }
    // Bare call: sibling method of the current POU?
    if (scope && scope.pou) {
        const m = (scope.pou.methods || []).find(x => x.name.toLowerCase() === callee.toLowerCase());
        if (m) return paramSetFromVars(m.variables);
    }
    // Function / FB (or FB-instance variable) by name.
    const t = resolveSymbolType(callee, scope, index);
    if (t.kind === 'fb') {
        const node = findNode(index, t.name);
        // A library FB (`fbPower(Enable := TRUE)`): the `.tmc` gives it real VAR_INPUT/OUTPUT members,
        // which completion offers — but the list is partial by construction, so validating a named
        // argument against it would flag correct code. Decline, exactly as before the `.tmc` was read.
        if (node && node.external) return null;
        if (node) return collectParams(node, index);
    }
    return null;
}

/**
 * Resolves the expected named-parameter set for a *declaration-site* FB initialization list —
 * `inst : FB_Type(a := v);` (and the structured form `inst : FB_Type := (a := v);`).
 *
 * This is NOT a normal call. In TwinCAT the arguments of a declaration-site initialization list are
 * passed to the FB's **FB_init method**, whose parameters are that method's VAR_INPUT — not the FB's
 * own VAR_INPUT. The structured form instead initializes the FB's own inputs. Both syntaxes are
 * valid, so the accepted set is the union of:
 *   - the FB_init parameters, resolved across the EXTENDS chain (FB_init may be inherited);
 *   - the implicit FB_init parameters `bInitRetains` / `bInCopyCode`, which TwinCAT always accepts
 *     whether or not FB_init is declared explicitly;
 *   - the FB's own call parameters (VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT, including inherited ones).
 *
 * @param {string} fbName Declared type name of the instance.
 * @param {Object} index Workspace symbol index.
 * @returns {Set<string>|null} Lowercased valid parameter names, or null when the FB, its FB_init, or
 *          any ancestor cannot be fully resolved — the caller must then skip validation entirely.
 */
function getInitParams(fbName, index) {
    const node = findNode(index, fbName);
    if (!node) return null;                          // unknown type (e.g. library FB) — never flag
    if (node.external) return null;                  // library FB: FB_init is not in the `.tmc` — skip
    if (node.type !== 'FUNCTION_BLOCK') return null; // only FBs carry FB_init; anything else: skip

    // Own parameters, incl. inherited. null ⇒ some ancestor is not indexed ⇒ set is uncertain.
    const own = collectParams(node, index);
    if (!own) return null;

    // undefined ⇒ the EXTENDS chain broke while searching ⇒ FB_init may exist but be invisible.
    const fbInit = findMethodInChain(node, 'FB_init', index);
    if (fbInit === undefined) return null;

    const set = new Set(own);
    set.add('binitretains');
    set.add('bincopycode');
    if (fbInit) {
        for (const p of paramSetFromVars(fbInit.variables)) set.add(p);
    }
    return set;
}

module.exports = {
    UNKNOWN,
    elementary,
    isNumeric,
    markExternal,
    membersUncertain,
    parseTypeString,
    typeFromNode,
    deref,
    lookupMember,
    resolveSymbolType,
    resolvePath,
    isAssignable,
    isRelatedAssignable,
    parentNames,
    findNode,
    findMethodOwnerInChain,
    getCallParams,
    getInitParams
};
