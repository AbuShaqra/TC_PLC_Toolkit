/**
 * @file libraryDecls.js
 * @description Library declarations for Compile Project (roadmap R3.4): the external compiler knows
 * only the IEC standard functions and function blocks, so every call into a TwinCAT vendor library
 * (and every library type) would be "undeclared" on correct code. This module, at check time:
 *
 *   1. reads what the user's OWN machine already holds about the project's libraries — the same
 *      sources the language server reads (src/lsp/libsymbols.js, libraries.js, parseCache.js):
 *        - the `library-signatures.xml` dump that "Update Library Definitions" writes (function
 *          signatures, function-block inputs/outputs, global lists and their constants);
 *        - the project's `.tmc` (structs, enums, aliases, function blocks with their methods and
 *          properties, global lists with numeric initial values — for the library types the project uses);
 *        - the symbol NAMES in the `.compiled-library` / `.library` archives;
 *        - the `.plcproj` library references and namespaces;
 *   2. writes INTERFACE-ONLY declarations of the library symbols the project references (and the
 *      library types those need) as extra compiler inputs: FUNCTION / FUNCTION_BLOCK headers with
 *      their parameter blocks, methods and properties with no body, TYPE declarations, and
 *      VAR_GLOBAL lists. Nothing else: no body is copied from a library, and no comment or
 *      documentation text — none of it is even read;
 *   3. strips a library namespace qualifier (`Tc2_Standard.TON`, `LibNs.F_X(…)`) from the check
 *      unit, replacing it with spaces so every column stays where it was;
 *   4. builds the filter that drops an error ONLY when it says a symbol is undeclared AND that
 *      symbol is a known library name that the project itself does not declare.
 *
 * Local-only (Beckhoff licence §4(3), user decision 2026-11-10): the declarations are strings in
 * memory, handed to compileCheck.runCheck, which writes them into its per-run temporary directory
 * and deletes that directory when the run ends. This module writes no file and keeps nothing.
 *
 * Conservative by construction: a declaration whose types cannot all be resolved is not written
 * (its uses stay undeclared and the filter takes them), never written with a guessed type; a name
 * the compiler already provides (TON, R_TRIG, CONCAT, LIMIT …) or the project declares is never
 * redeclared — the user's own wins.
 *
 * vscode-free, so test/test_library_decls.js and test/test_compile_real.js drive it under plain Node.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const libsymbols = require('./lsp/libsymbols');
const { indexLibraryNamespaces, getLibraryNamespaces } = require('./lsp/libraries');
const { readOnlyParse, signatureLibrariesFor } = require('./lsp/parseCache');
const { blockCommentEnd } = require('./stComments');

/** An IEC identifier. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Elementary types the bundled compiler accepts under the twincat3 profile (probed one by one).
 * TwinCAT's LTIME, LDATE, LTOD, LDT, CHAR, WCHAR, PVOID, XINT, UXINT, XWORD, BIT and ANY are not
 * among them: a library declaration that needs one is not written.
 */
const ELEMENTARY = new Set([
    'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT',
    'ULINT', 'REAL', 'LREAL', 'STRING', 'WSTRING', 'TIME', 'DATE', 'TOD', 'TIME_OF_DAY', 'DT',
    'DATE_AND_TIME', '__XWORD'
]);

/** How many declaration files one run may pass before declarations are grouped (command length). */
const MAX_DECLARATION_FILES = 300;

/** Integer types an enumeration may name as its base. */
const ENUM_BASES = new Set(['SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD']);

/**
 * The IEC standard function blocks and functions, used only when the bundled libraries cannot be
 * read (their manifests are the real list — see compilerProvidedNames).
 */
const IEC_FALLBACK = [
    'TON', 'TOF', 'TP', 'R_TRIG', 'F_TRIG', 'CTU', 'CTD', 'CTUD', 'SR', 'RS', 'SEMA',
    'ABS', 'SQRT', 'LN', 'LOG', 'EXP', 'EXPT', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2',
    'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOVE', 'SEL', 'MAX', 'MIN', 'LIMIT', 'MUX', 'SHL', 'SHR', 'ROL',
    'ROR', 'AND', 'OR', 'XOR', 'NOT', 'GT', 'GE', 'EQ', 'LE', 'LT', 'NE', 'LEN', 'LEFT', 'RIGHT', 'MID',
    'CONCAT', 'INSERT', 'DELETE', 'REPLACE', 'FIND', 'TRUNC', 'ROUND', 'ADR', 'SIZEOF', 'MEMCPY',
    'LOWER_BOUND', 'UPPER_BOUND'
];

/**
 * The names the compiler provides itself: the function blocks, functions, types and globals of the
 * libraries next to it (`<compiler dir>/libs/*.stlib`, JSON manifests), plus the elementary types.
 * A library declaration of one of these is never written (Tc2_Standard duplicates TON, R_TRIG …).
 * @param {string} compilerPath The compiler's command-line file.
 * @returns {Set<string>} Upper-cased names.
 */
function compilerProvidedNames(compilerPath) {
    const names = new Set(ELEMENTARY);
    let found = false;
    const libDir = path.join(path.dirname(String(compilerPath || '')), 'libs');
    let entries = [];
    try { entries = fs.readdirSync(libDir); } catch (e) { entries = []; }
    for (const file of entries) {
        if (!/\.stlib$/i.test(file)) continue;
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(libDir, file), 'utf8')).manifest || {};
            for (const list of ['functions', 'functionBlocks', 'types', 'globals']) {
                for (const item of Array.isArray(manifest[list]) ? manifest[list] : []) {
                    if (item && typeof item.name === 'string') { names.add(item.name.toUpperCase()); found = true; }
                }
            }
        } catch (e) { /* an unreadable manifest adds nothing; the fallback below still applies */ }
    }
    if (!found) for (const n of IEC_FALLBACK) names.add(n);
    return names;
}

/**
 * True for the type-conversion names the compiler resolves on its own: `INT_TO_REAL`, `TO_DINT`,
 * `TRUNC_INT`, `DINT_TRUNC`… — never redeclared.
 * @param {string} upper Upper-cased name.
 * @returns {boolean}
 */
function isConversionName(upper) {
    const m = /^(?:([A-Z_]+?)_)?(TO|TRUNC)_([A-Z_]+)$/.exec(upper);
    if (!m) return false;
    const elementary = (/** @type {string} */ t) => ELEMENTARY.has(t) || t === 'ANY' || /^ANY_/.test(t) || t === 'LTIME' || t === 'LDT' || t === 'LDATE' || t === 'LTOD';
    return elementary(m[3]) && (!m[1] || elementary(m[1]));
}

// ── Type text ──────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TypeRef A library member's type, ready to write.
 * @property {string} text The type as written in the declaration (qualifiers stripped).
 * @property {string[]} deps Lower-cased non-elementary type names it needs.
 */

/**
 * Reads a type the way a declaration may write it, or refuses it. Accepted: an identifier (a
 * namespace qualifier is stripped), `STRING`/`WSTRING` with an optional literal length,
 * `ARRAY [l..u, …] OF T` with integer-literal bounds or `*`, `POINTER TO T`, `REFERENCE TO T`.
 * Anything else — a bound or length that names a constant, a qualifier that is not a library
 * namespace — is null, and the declaration that needs it is not written.
 * @param {string} raw
 * @param {Set<string>} namespaces Lower-cased library namespaces.
 * @returns {TypeRef|null}
 */
function readType(raw, namespaces) {
    const t = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!t) return null;
    let m = /^(POINTER|REFERENCE) TO (.+)$/i.exec(t);
    if (m) {
        const inner = readType(m[2], namespaces);
        return inner && { text: `${m[1].toUpperCase()} TO ${inner.text}`, deps: inner.deps };
    }
    m = /^ARRAY ?\[([^\]]+)\] ?OF (.+)$/i.exec(t);
    if (m) {
        const dims = m[1].split(',').map(d => d.trim());
        const okDims = dims.every(d => d === '*' || /^[+-]?\d+ ?\.\. ?[+-]?\d+$/.test(d));
        if (!okDims) return null;
        const inner = readType(m[2], namespaces);
        return inner && { text: `ARRAY [${dims.map(d => d.replace(/ /g, '')).join(', ')}] OF ${inner.text}`, deps: inner.deps };
    }
    m = /^(STRING|WSTRING) ?(?:[([] ?(\d+) ?[)\]])?$/i.exec(t);
    if (m) return { text: m[2] ? `${m[1].toUpperCase()}(${m[2]})` : m[1].toUpperCase(), deps: [] };
    const name = stripNamespaces(t, namespaces);
    if (!name || !IDENT.test(name)) return null;
    const upper = name.toUpperCase();
    if (ELEMENTARY.has(upper)) return { text: upper, deps: [] };
    return { text: name, deps: [name.toLowerCase()] };
}

/**
 * `Ns.Name` → `Name` when every head is a library namespace; a plain name unchanged; anything
 * else null.
 * @param {string} text
 * @param {Set<string>} namespaces Lower-cased.
 * @returns {string|null}
 */
function stripNamespaces(text, namespaces) {
    const parts = text.split('.').map(p => p.trim());
    if (!parts.every(p => IDENT.test(p))) return null;
    while (parts.length > 1 && namespaces.has(parts[0].toLowerCase())) parts.shift();
    return parts.length === 1 ? parts[0] : null;
}

/**
 * A numeric or boolean initial value, as written; anything else (a string, a structured value, an
 * expression) is dropped — a string constant's text is library content, not interface.
 * @param {string} raw
 * @returns {string}
 */
function literalValue(raw) {
    const v = String(raw || '').trim();
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return v;
    if (/^(2|8|16)#[0-9A-Fa-f_]+$/.test(v)) return v;
    if (/^(true|false)$/i.test(v)) return v.toUpperCase();
    return '';
}

// ── The .tmc ───────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RawMember
 * @property {string} name
 * @property {string} type The type as the source spells it.
 * @property {string} [scope] `VAR_INPUT` / `VAR_OUTPUT` / `VAR_IN_OUT`, or '' for a plain member.
 * @property {string} [value] A literal initial value, or ''.
 * @property {boolean} [constant]
 */

/**
 * @typedef {Object} RawDecl One library symbol the sources describe, before it is resolved.
 * @property {'fb'|'function'|'struct'|'enum'|'alias'|'gvl'} kind
 * @property {string} name
 * @property {'tmc'|'sig'} origin
 * @property {boolean} topLevel May be declared because the project references it (a `.tmc` type,
 *   or a dump symbol of a library the project's `.plcproj` references). False for a dump symbol of
 *   another library: it is declared only when a declaration that IS declared needs it.
 * @property {RawMember[]} [io] Function block / function parameters.
 * @property {boolean} [ioComplete] The parameter list is known to be complete (the dump's is; a
 *   `.tmc`'s may not be — a call naming a parameter it lacks is then filtered like a missing member).
 * @property {Array<{name: string, returnType: string, params: RawMember[]}>} [methods]
 * @property {Array<{name: string, type: string, get: boolean, set: boolean}>} [properties]
 * @property {string[]} [actions]
 * @property {string} [extendsType]
 * @property {string} [returnType]
 * @property {RawMember[]} [members] Struct fields / global-list variables.
 * @property {Array<{name: string, value: string}>} [values] Enumeration values.
 * @property {string} [baseType] Alias target / enumeration base.
 */

const TMC_ANY_SUBITEM = /<SubItem>\s*<Name([^>]*)>([^<]+)<\/Name>\s*<Type([^>]*)>([^<]*)<\/Type>((?:\s*<ArrayInfo>[\s\S]*?<\/ArrayInfo>)*)([\s\S]*?)<\/SubItem>/g;
const TMC_ENUM_PAIR = /<EnumInfo>\s*<Text>([^<]*)<\/Text>\s*<Enum>([^<]*)<\/Enum>/g;
const TMC_BASE_TYPE = /<BaseType([^>]*)>([^<]*)<\/BaseType>((?:\s*<ArrayInfo>[\s\S]*?<\/ArrayInfo>)*)/;
const TMC_ACTION = /<Action>\s*<Name[^>]*>([^<]+)<\/Name>/g;

/**
 * Reads the library-owned `<DataType>`s of one `.tmc` into declarations. A type is library-owned
 * when its `<Name>` carries a `Namespace` attribute or `TcBaseType="true"`; the project's own
 * types (no such attribute) are skipped — the project's sources declare those, and a stale `.tmc`
 * must not bring back a type the user removed. Interfaces (`TcPlcInterfaceType`) are skipped: their
 * member lists are not complete enough to check an IMPLEMENTS against. `<Comment>` is never read.
 * @param {string} xml
 * @returns {{decls: RawDecl[], names: string[]}} `names`: every library-owned name the file holds
 *   (types, members, methods, properties, actions, enumeration values), for the filter.
 */
function parseTmcDeclarations(xml) {
    /** @type {RawDecl[]} */
    const decls = [];
    /** @type {string[]} */
    const names = [];
    const blocks = String(xml || '').match(/<DataType>[\s\S]*?<\/DataType>/g) || [];
    for (const rawBlock of blocks) {
        // Documentation text never enters the model: comments are cut before anything is read.
        const block = rawBlock.replace(/<Comment>[\s\S]*?<\/Comment>/g, '');
        const head = /<Name([^>]*)>([^<]+)<\/Name>/.exec(block);
        if (!head) continue;
        const name = head[2].trim();
        if (!IDENT.test(name)) continue;
        if (!/\bNamespace\s*=\s*"[^"]+"/.test(head[1]) && !/\bTcBaseType\s*=\s*"true"/i.test(head[1])) continue;
        names.push(name);
        const props = new Set([...block.matchAll(/<Property>\s*<Name>([^<]+)<\/Name>/g)].map(m => m[1].trim()));
        if (props.has('TcPlcInterfaceType') || props.has('TcComInterface')) continue;

        const parsed = libsymbols.parseTmcDataType(block);
        if (!parsed) continue;
        for (const member of parsed.members || []) names.push(member.name);
        for (const method of parsed.methods || []) names.push(method.name.replace(/^__(get|set)/i, ''));

        /** @type {RawMember[]} */
        const statics = [];
        /** @type {RawMember[]} */
        const plain = [];
        TMC_ANY_SUBITEM.lastIndex = 0;
        let sub;
        while ((sub = TMC_ANY_SUBITEM.exec(block)) !== null) {
            const memberName = sub[2].trim();
            if (!IDENT.test(memberName)) continue;
            const type = libsymbols.tmcMemberType(sub[3], sub[4], sub[5]);
            const valueMatch = /^\s*(?:<BitSize>\d+<\/BitSize>\s*)?(?:<BitOffs>\d+<\/BitOffs>\s*)?<Default>\s*<(Value|Bool)>([^<]*)<\/\1>\s*<\/Default>/.exec(sub[6] || '');
            const member = { name: memberName, type, value: valueMatch ? literalValue(valueMatch[2]) : '' };
            if (/\bStatic\s*=\s*"true"/i.test(sub[1])) { statics.push(member); names.push(memberName); } else plain.push(member);
        }
        const enumValues = [...block.matchAll(TMC_ENUM_PAIR)].map(m => ({ name: m[1].trim(), value: literalValue(m[2]) })).filter(v => IDENT.test(v.name));
        for (const v of enumValues) names.push(v.name);
        const actions = [...block.matchAll(TMC_ACTION)].map(m => m[1].trim()).filter(a => IDENT.test(a));
        for (const a of actions) names.push(a);
        // The base, with or without a Namespace attribute (parseTmcDataType reads only the bare tag).
        const ext = /<ExtendsType[^>]*>([^<]+)<\/ExtendsType>/.exec(block);
        const extendsType = ext ? ext[1].trim() : (parsed.extendsType || '');
        const hasSubItems = /<SubItem>/.test(block);
        const base = hasSubItems ? null : TMC_BASE_TYPE.exec(block);
        const baseType = base ? libsymbols.tmcMemberType(base[1], base[2], base[3]) : '';

        const isFb = props.has('PouType') || parsed.kind === 'fb' || actions.length > 0 || /<Implements>/.test(block);
        if (statics.length > 0) {
            // A global variable list (a PROGRAM has the same shape but carries methods or a PouType).
            if (plain.length === 0 && !isFb) decls.push({ kind: 'gvl', name, origin: 'tmc', topLevel: true, members: statics });
        } else if (enumValues.length > 0) {
            decls.push({ kind: 'enum', name, origin: 'tmc', topLevel: true, values: enumValues, baseType });
        } else if (isFb) {
            /** @type {Array<{name: string, returnType: string, params: RawMember[]}>} */
            const methods = [];
            /** @type {Map<string, {name: string, type: string, get: boolean, set: boolean}>} */
            const properties = new Map();
            for (const method of parsed.methods || []) {
                const accessor = /^__(get|set)(.+)$/i.exec(method.name);
                if (accessor) {
                    const propName = accessor[2];
                    if (!IDENT.test(propName)) continue;
                    const key = propName.toLowerCase();
                    const prop = properties.get(key) || { name: propName, type: '', get: false, set: false };
                    if (accessor[1].toLowerCase() === 'get') { prop.get = true; prop.type = prop.type || method.returnType || ''; } else {
                        prop.set = true;
                        const p = (method.params || [])[0];
                        prop.type = prop.type || (p ? p.type : '');
                    }
                    properties.set(key, prop);
                } else if (!method.name.startsWith('__')) {
                    methods.push({ name: method.name, returnType: method.returnType || '', params: (method.params || []).map(p => ({ name: p.name, type: p.type, scope: p.scope })) });
                }
            }
            decls.push({
                kind: 'fb', name, origin: 'tmc', topLevel: true, ioComplete: false,
                io: (parsed.members || []).filter(m => m.scope).map(m => ({ name: m.name, type: m.type, scope: m.scope })),
                methods, properties: [...properties.values()], actions, extendsType
            });
        } else if (plain.length > 0) {
            decls.push({ kind: 'struct', name, origin: 'tmc', topLevel: true, members: plain.map(m => ({ name: m.name, type: m.type })), extendsType });
        } else if (baseType) {
            decls.push({ kind: 'alias', name, origin: 'tmc', topLevel: true, baseType });
        }
    }
    return { decls, names };
}

// ── Gathering ──────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LibraryKnowledge What the user's machine holds about one project's libraries.
 * @property {Map<string, RawDecl>} decls Lower-cased name → the merged declaration.
 * @property {Set<string>} knownNames Lower-cased library names (archives, dump, `.tmc`, namespaces).
 * @property {Set<string>} namespaces Lower-cased library namespaces of the project's `.plcproj`.
 * @property {boolean} hasSignatures A `library-signatures.xml` dump was found.
 * @property {{archives: number, archiveNames: number, signatureFiles: number, tmcFiles: number, ms: number}} stats
 */

/**
 * Reads every local source of library knowledge for one PLC project. Reads only; writes nothing.
 * A fresh symbol index is used so the language server's registries are not touched; the archive
 * and dump parses are shared through the existing content-guarded caches.
 * @param {{projectDir: string, roots?: string[]}} o `roots`: the workspace folders — the dump is
 *   written at a workspace root, above the project directory (see server.js indexLibraries).
 * @returns {LibraryKnowledge}
 */
function gatherLibraryKnowledge(o) {
    const started = Date.now();
    const projectDir = o.projectDir;
    /** @type {any} */
    const index = {};
    const archiveStats = libsymbols.indexLibrarySymbols(projectDir, index);
    indexLibraryNamespaces(projectDir, index);
    const namespaces = new Set(getLibraryNamespaces(index).map(n => n.toLowerCase()));
    for (const n of libsymbols.getLibraryNamespaceNames(index)) namespaces.add(n.toLowerCase());

    const knownNames = new Set(namespaces);
    for (const n of libsymbols.getLibrarySymbols(index)) if (IDENT.test(n)) knownNames.add(n.toLowerCase());
    const archiveNames = knownNames.size - namespaces.size;

    /** @type {Map<string, RawDecl>} */
    const decls = new Map();

    // The .tmc first: where it describes a symbol, it is the richer source.
    /** @type {string[]} */
    const tmcFiles = [];
    libsymbols.collectTmcFiles(projectDir, tmcFiles);
    for (const file of tmcFiles) {
        const model = readOnlyParse('tmc-declarations', file, parseTmcDeclarations);
        if (!model) continue;
        for (const n of model.names) knownNames.add(n.toLowerCase());
        for (const d of model.decls) {
            const key = d.name.toLowerCase();
            // A private copy: the cached model is shared and frozen, and the merge below edits.
            if (!decls.has(key)) decls.set(key, JSON.parse(JSON.stringify(d)));
        }
    }

    /** @type {string[]} */
    const sigFiles = [];
    const seen = new Set();
    for (const dir of [projectDir, ...(o.roots || [])]) {
        /** @type {string[]} */
        const found = [];
        if (dir) libsymbols.collectSignatureFiles(dir, found);
        for (const f of found) {
            const k = path.resolve(f).toLowerCase();
            if (!seen.has(k)) { seen.add(k); sigFiles.push(f); }
        }
    }
    for (const file of sigFiles) {
        const parsed = signatureLibrariesFor(file);
        if (!parsed) continue;
        for (const lib of parsed.libraries) mergeSignatureLibrary(lib, decls, knownNames, libsymbols.namespaceForLibraryTitle(lib.name, index) !== '');
    }

    return {
        decls, knownNames, namespaces, hasSignatures: sigFiles.length > 0,
        stats: { archives: archiveStats.archives, archiveNames, signatureFiles: sigFiles.length, tmcFiles: tmcFiles.length, ms: Date.now() - started }
    };
}

/**
 * Merges one library of the dump. The dump's parameter lists are authoritative (complete), so they
 * replace a `.tmc` function block's inputs/outputs; the `.tmc` keeps its methods, properties,
 * actions and base. A global list merges both: the dump says which variables are constants, the
 * `.tmc` gives numeric initial values.
 * @param {any} lib One library of parseLibrarySignaturesXml.
 * @param {Map<string, RawDecl>} decls
 * @param {Set<string>} knownNames
 * @param {boolean} referenced The project's `.plcproj` references this library.
 */
function mergeSignatureLibrary(lib, decls, knownNames, referenced) {
    const add = (/** @type {RawDecl} */ d) => {
        knownNames.add(d.name.toLowerCase());
        const key = d.name.toLowerCase();
        const existing = decls.get(key);
        if (!existing) { decls.set(key, d); return; }
        if (referenced && existing.origin === 'sig') existing.topLevel = true;
        if (existing.kind === 'fb' && d.kind === 'fb') { existing.io = d.io; existing.ioComplete = true; }
        if (existing.kind === 'gvl' && d.kind === 'gvl') {
            const byName = new Map((existing.members || []).map(m => [m.name.toLowerCase(), m]));
            for (const m of d.members || []) {
                const had = byName.get(m.name.toLowerCase());
                if (had) had.constant = had.constant || m.constant;
                else (existing.members || (existing.members = [])).push(m);
            }
        }
    };
    const copyVars = (/** @type {any[]} */ rows, /** @type {string} */ scope) => (rows || []).map(r => ({ name: r.name, type: r.type, scope }));
    for (const fb of lib.functionBlocks || []) {
        add({ kind: 'fb', name: fb.name, origin: 'sig', topLevel: referenced, ioComplete: true,
            io: [...copyVars(fb.inputs, 'VAR_INPUT'), ...copyVars(fb.outputs, 'VAR_OUTPUT'), ...copyVars(fb.inouts, 'VAR_IN_OUT')],
            methods: [], properties: [], actions: [], extendsType: '' });
    }
    for (const fn of lib.functions || []) {
        // The return value is the like-named output; any other output is a VAR_OUTPUT.
        const outputs = parseOutputsOf(fn);
        add({ kind: 'function', name: fn.name, origin: 'sig', topLevel: referenced, returnType: outputs.returnType,
            io: [...copyVars(fn.inputs, 'VAR_INPUT'), ...outputs.others, ...copyVars(fn.inouts, 'VAR_IN_OUT')] });
    }
    for (const t of lib.types || []) knownNames.add(String(t).toLowerCase());
    for (const t of lib.interfaces || []) knownNames.add(String(t).toLowerCase());
    for (const g of lib.globals || []) {
        const constants = g.constants || [];
        for (const c of constants) knownNames.add(c.name.toLowerCase());
        const selfTyped = constants.length > 0 && constants.every((/** @type {any} */ c) => String(c.type).toLowerCase() === g.name.toLowerCase());
        if (selfTyped) {
            add({ kind: 'enum', name: g.name, origin: 'sig', topLevel: referenced, values: constants.map((/** @type {any} */ c) => ({ name: c.name, value: '' })), baseType: '' });
        } else {
            add({ kind: 'gvl', name: g.name, origin: 'sig', topLevel: referenced,
                members: constants.map((/** @type {any} */ c) => ({ name: c.name, type: c.type, value: '', constant: true })) });
        }
    }
}

/**
 * A dump function's return type and its further outputs: the return value is the output named like
 * the function (else the first, as parseLibrarySignaturesXml reads it); any other is a VAR_OUTPUT.
 * @param {any} fn
 * @returns {{returnType: string, others: RawMember[]}}
 */
function parseOutputsOf(fn) {
    const outputs = Array.isArray(fn.outputs) ? fn.outputs : [];
    if (outputs.length === 0) return { returnType: fn.returnType || '', others: [] };
    const own = outputs.find((/** @type {any} */ o) => String(o.name).toLowerCase() === String(fn.name).toLowerCase()) || outputs[0];
    return {
        returnType: own.type || '',
        others: outputs.filter((/** @type {any} */ o) => o !== own).map((/** @type {any} */ o) => ({ name: o.name, type: o.type, scope: 'VAR_OUTPUT' }))
    };
}

// ── The project's own names ────────────────────────────────────────────────────────────────────

/**
 * The names the project itself declares at the top level: its POUs, interfaces, types, global
 * variable lists and global variables. A library declaration of one of them is never written, and
 * a diagnostic about one is never filtered.
 * @param {Array<{unit: {stText: string, rootName: string, rootType: string, globalListName: string|null}}>} inputs
 * @returns {Set<string>} Lower-cased.
 */
function collectUserNames(inputs) {
    const names = new Set();
    for (const input of inputs || []) {
        const unit = input.unit;
        if (unit.rootName) names.add(unit.rootName.toLowerCase());
        if (unit.globalListName) names.add(unit.globalListName.toLowerCase());
        const code = blankCommentsAndStrings(unit.stText);
        for (const m of code.matchAll(/\b(?:FUNCTION_BLOCK|FUNCTION|PROGRAM|INTERFACE)\s+(?:(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\s+)*([A-Za-z_]\w*)/gi)) names.add(m[1].toLowerCase());
        for (const m of code.matchAll(/\bTYPE\s+([A-Za-z_]\w*)/gi)) names.add(m[1].toLowerCase());
        if (unit.rootType === 'GVL') {
            for (const m of code.matchAll(/(?:^|;|\bVAR_GLOBAL\b(?:\s+(?:CONSTANT|RETAIN|PERSISTENT))*)\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:AT\s+%\S+\s*)?:(?!=)/gi)) {
                for (const n of m[1].split(',')) names.add(n.trim().toLowerCase());
            }
        }
    }
    return names;
}

/**
 * Replaces comments, pragmas and string literals with spaces (newlines kept), so a scan over the
 * result sees code only and every offset still matches the original.
 * @param {string} text
 * @returns {string}
 */
function blankCommentsAndStrings(text) {
    const s = String(text || '');
    let out = '';
    let i = 0;
    const blank = (/** @type {string} */ part) => part.replace(/[^\r\n]/g, ' ');
    while (i < s.length) {
        const two = s.slice(i, i + 2);
        let end = -1;
        if (two === '(*') end = blockCommentEnd(s, i);   // nests: (* (* *) *)
        else if (two === '/*') { end = s.indexOf('*/', i + 2); end = end < 0 ? s.length : end + 2; }
        else if (two === '//') { end = s.indexOf('\n', i); end = end < 0 ? s.length : end; }
        else if (s[i] === '{') { end = s.indexOf('}', i + 1); end = end < 0 ? s.length : end + 1; }
        else if (s[i] === '\'' || s[i] === '"') {
            const q = s[i];
            let j = i + 1;
            while (j < s.length && s[j] !== q && s[j] !== '\n') j += s[j] === '$' ? 2 : 1;
            end = Math.min(j + 1, s.length);
        }
        if (end > i) { out += blank(s.slice(i, end)); i = end; } else { out += s[i]; i++; }
    }
    return out;
}

// ── Qualifiers ─────────────────────────────────────────────────────────────────────────────────

/**
 * Blanks every library namespace qualifier in a unit's text: `Tc2_Standard.TON` → `             TON`.
 * The compiler cannot parse a qualified type and would read `Ns.F()` as a member of an undeclared
 * variable. The qualifier is replaced by as many spaces, so every column the compiler reports is
 * still the column in the pane. A head that the project itself declares (a user name), or that
 * follows a `.` (a member, not a qualifier), is left alone; so are comments and strings.
 * @param {string} text
 * @param {Set<string>} namespaces Lower-cased.
 * @param {Set<string>} userNames Lower-cased.
 * @returns {{text: string, count: number}}
 */
function stripQualifiers(text, namespaces, userNames) {
    if (!namespaces || namespaces.size === 0) return { text, count: 0 };
    const code = blankCommentsAndStrings(text);
    const chars = text.split('');
    let count = 0;
    const re = /[A-Za-z_]\w*/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const lower = m[0].toLowerCase();
        if (!namespaces.has(lower) || userNames.has(lower)) continue;
        let k = m.index - 1;
        while (k >= 0 && (code[k] === ' ' || code[k] === '\t')) k--;
        if (k >= 0 && code[k] === '.') continue;
        let j = m.index + m[0].length;
        while (j < code.length && (code[j] === ' ' || code[j] === '\t')) j++;
        if (code[j] !== '.' || code[j + 1] === '.') continue;
        let after = j + 1;
        while (after < code.length && (code[after] === ' ' || code[after] === '\t')) after++;
        if (!/[A-Za-z_]/.test(code[after] || '')) continue;
        for (let p = m.index; p <= j; p++) chars[p] = ' ';
        count++;
    }
    return { text: chars.join(''), count };
}

// ── Selection and writing ──────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExtraFile A generated compiler input.
 * @property {string} name File name inside the run's temporary directory.
 * @property {string} text
 * @property {string|null} globalListName The global list it declares, else null.
 */

/**
 * @typedef {Object} DeclarationSet
 * @property {ExtraFile[]} files One file per declaration (a declaration the compiler cannot parse
 *   costs only itself) — global lists first; past MAX_DECLARATION_FILES the others are grouped.
 * @property {Set<string>} declared Lower-cased names written.
 * @property {Set<string>} owners Lower-cased function blocks and structs written (their member
 *   lists may be partial — see the filter).
 * @property {Set<string>} globalLists Lower-cased global lists written.
 * @property {Set<string>} partialIo Lower-cased function blocks written with a parameter list that
 *   may be incomplete (from the `.tmc` alone).
 * @property {{skippedCompiler: number, skippedUser: number, unresolved: number}} counts
 */

/**
 * Chooses and writes the declarations for one check: the library symbols the units reference
 * (by name, or a global list / enumeration through one of its members), plus — transitively — the
 * library types those need. A declaration with a type that resolves to nothing declared is
 * dropped, repeatedly, until what is left is closed. An optional part (a method, a property, a
 * struct field, a global variable) with such a type is dropped on its own.
 * @param {LibraryKnowledge} knowledge
 * @param {{texts: string[], userNames: Set<string>, compilerNames: Set<string>}} o
 * @returns {DeclarationSet}
 */
function buildDeclarations(knowledge, o) {
    const ns = knowledge.namespaces;
    const referenced = new Set();
    for (const text of o.texts) for (const m of String(text).matchAll(/[A-Za-z_]\w*/g)) referenced.add(m[0].toLowerCase());
    const counts = { skippedCompiler: 0, skippedUser: 0, unresolved: 0 };
    const isCompiler = (/** @type {string} */ key) => o.compilerNames.has(key.toUpperCase()) || isConversionName(key.toUpperCase());
    const conflicts = (/** @type {string} */ key) => {
        if (o.userNames.has(key)) return 'user';
        if (isCompiler(key)) return 'compiler';
        return '';
    };

    /** Required type dependencies of a declaration (all must resolve), or null if one is unreadable. */
    const requiredDeps = (/** @type {RawDecl} */ d) => {
        /** @type {string[]} */
        const deps = [];
        const need = (/** @type {string} */ t) => { const r = readType(t, ns); if (!r) return false; deps.push(...r.deps); return true; };
        if (d.kind === 'fb' || d.kind === 'function') {
            for (const p of d.io || []) if (!need(p.type)) return null;
        }
        if (d.kind === 'function' && !need(d.returnType || '')) return null;
        if (d.kind === 'alias' && !need(d.baseType || '')) return null;
        if ((d.kind === 'fb' || d.kind === 'struct') && d.extendsType) {
            const base = stripNamespaces(d.extendsType, ns);
            if (!base) return null;
            deps.push(base.toLowerCase());
        }
        return deps;
    };
    /** Optional dependencies: each part needs its own. */
    const optionalDeps = (/** @type {RawDecl} */ d) => {
        /** @type {string[]} */
        const deps = [];
        const add = (/** @type {string} */ t) => { const r = readType(t, ns); if (r) deps.push(...r.deps); };
        for (const m of d.members || []) add(m.type);
        for (const m of d.methods || []) { if (m.returnType) add(m.returnType); for (const p of m.params) add(p.type); }
        for (const p of d.properties || []) add(p.type);
        return deps;
    };

    // Roots: what the units reference.
    const included = new Set();
    for (const [key, d] of knowledge.decls) {
        if (!d.topLevel) continue;
        let hit = referenced.has(key);
        if (!hit && d.kind === 'gvl') hit = (d.members || []).some(m => referenced.has(m.name.toLowerCase()));
        if (!hit && d.kind === 'enum') hit = (d.values || []).some(v => referenced.has(v.name.toLowerCase()));
        if (!hit) continue;
        const c = conflicts(key);
        if (c === 'user') { counts.skippedUser++; continue; }
        if (c === 'compiler') { counts.skippedCompiler++; continue; }
        included.add(key);
    }
    // Closure over the types they need.
    const queue = [...included];
    while (queue.length > 0) {
        const d = knowledge.decls.get(/** @type {string} */ (queue.pop()));
        if (!d) continue;
        for (const dep of [...(requiredDeps(d) || []), ...optionalDeps(d)]) {
            if (included.has(dep) || !knowledge.decls.has(dep) || conflicts(dep)) continue;
            included.add(dep);
            queue.push(dep);
        }
    }
    // Prune what cannot be resolved, until nothing changes.
    const resolves = (/** @type {string} */ dep) => isCompiler(dep) || included.has(dep);
    let changed = true;
    while (changed) {
        changed = false;
        for (const key of [...included]) {
            const d = /** @type {RawDecl} */ (knowledge.decls.get(key));
            const deps = requiredDeps(d);
            const empty = (d.kind === 'struct' && (d.members || []).length === 0 && !d.extendsType) ||
                (d.kind === 'enum' && (d.values || []).length === 0);
            if (!deps || empty || !deps.every(resolves)) {
                included.delete(key);
                counts.unresolved++;
                changed = true;
            }
        }
    }

    const typeOk = (/** @type {string} */ t) => { const r = readType(t, ns); return !!r && r.deps.every(resolves); };
    const typeText = (/** @type {string} */ t) => /** @type {TypeRef} */ (readType(t, ns)).text;
    /** @type {ExtraFile[]} */
    const files = [];
    const owners = new Set();
    const globalLists = new Set();
    const partialIo = new Set();
    /** @type {string[]} */
    const texts = [];
    for (const key of [...included].sort()) {
        const d = /** @type {RawDecl} */ (knowledge.decls.get(key));
        const text = renderDeclaration(d, { typeOk, typeText, ns, decls: knowledge.decls, included, userNames: o.userNames });
        if (!text) { included.delete(key); counts.unresolved++; continue; }
        if (d.kind === 'gvl') files.push({ name: `lib-${files.length + 1}.st`, text, globalListName: d.name });
        else texts.push(text);
        if (d.kind === 'fb' || d.kind === 'struct') owners.add(key);
        if (d.kind === 'fb' && !d.ioComplete) partialIo.add(key);
        if (d.kind === 'gvl') globalLists.add(key);
    }
    // One file per declaration, so one the compiler cannot parse costs only itself — up to
    // MAX_DECLARATION_FILES; beyond that they are grouped, to keep the command line short (Windows).
    const perFile = Math.max(1, Math.ceil(texts.length / MAX_DECLARATION_FILES));
    for (let i = 0; i < texts.length; i += perFile) {
        files.push({ name: `lib-${files.length + 1}.st`, text: texts.slice(i, i + perFile).join('\n'), globalListName: null });
    }
    return { files, declared: included, owners, globalLists, partialIo, counts };
}

/**
 * Writes one declaration as Structured Text — interface only.
 * @param {RawDecl} d
 * @param {{typeOk: (t: string) => boolean, typeText: (t: string) => string, ns: Set<string>, decls: Map<string, RawDecl>,
 *   included: Set<string>, userNames?: Set<string>}} c `userNames`: a global the project declares
 *   itself is left out of a library list (a plain use would otherwise be ambiguous).
 * @returns {string} '' when nothing writable is left.
 */
function renderDeclaration(d, c) {
    const vars = (/** @type {string} */ keyword, /** @type {RawMember[]} */ rows) => {
        if (rows.length === 0) return [];
        return [keyword, ...rows.map(r => `\t${r.name} : ${c.typeText(r.type)}${r.value ? ` := ${r.value}` : ''};`), 'END_VAR'];
    };
    const byScope = (/** @type {RawMember[]} */ rows, /** @type {string} */ scope) => rows.filter(r => r.scope === scope && IDENT.test(r.name));
    const lines = [];
    if (d.kind === 'function') {
        const io = d.io || [];
        lines.push(`FUNCTION ${d.name} : ${c.typeText(d.returnType || '')}`,
            ...vars('VAR_INPUT', byScope(io, 'VAR_INPUT')), ...vars('VAR_OUTPUT', byScope(io, 'VAR_OUTPUT')),
            ...vars('VAR_IN_OUT', byScope(io, 'VAR_IN_OUT')), 'END_FUNCTION');
    } else if (d.kind === 'fb') {
        const base = d.extendsType ? stripNamespaces(d.extendsType, c.ns) : '';
        // Members an ancestor already declares are not declared again.
        const inherited = new Set();
        let cursor = base ? base.toLowerCase() : '';
        for (let guard = 0; cursor && guard < 32; guard++) {
            const parent = c.decls.get(cursor);
            if (!parent || !c.included.has(cursor)) break;
            for (const m of parent.io || []) inherited.add(m.name.toLowerCase());
            for (const m of parent.methods || []) inherited.add(m.name.toLowerCase());
            for (const p of parent.properties || []) inherited.add(p.name.toLowerCase());
            cursor = parent.extendsType ? String(stripNamespaces(parent.extendsType, c.ns) || '').toLowerCase() : '';
        }
        const io = (d.io || []).filter(m => !inherited.has(m.name.toLowerCase()));
        lines.push(`FUNCTION_BLOCK ${d.name}${base ? ` EXTENDS ${base}` : ''}`,
            ...vars('VAR_INPUT', byScope(io, 'VAR_INPUT')), ...vars('VAR_OUTPUT', byScope(io, 'VAR_OUTPUT')),
            ...vars('VAR_IN_OUT', byScope(io, 'VAR_IN_OUT')));
        const taken = new Set(io.map(m => m.name.toLowerCase()));
        for (const m of d.methods || []) {
            const key = m.name.toLowerCase();
            if (!IDENT.test(m.name) || taken.has(key)) continue;
            if ((m.returnType && !c.typeOk(m.returnType)) || !m.params.every(p => IDENT.test(p.name) && c.typeOk(p.type))) continue;
            taken.add(key);
            lines.push(`METHOD ${m.name}${m.returnType ? ` : ${c.typeText(m.returnType)}` : ''}`,
                ...vars('VAR_INPUT', byScope(m.params, 'VAR_INPUT')), ...vars('VAR_OUTPUT', byScope(m.params, 'VAR_OUTPUT')),
                ...vars('VAR_IN_OUT', byScope(m.params, 'VAR_IN_OUT')), 'END_METHOD');
        }
        for (const p of d.properties || []) {
            const key = p.name.toLowerCase();
            if (taken.has(key) || !p.type || !c.typeOk(p.type)) continue;
            taken.add(key);
            lines.push(`PROPERTY ${p.name} : ${c.typeText(p.type)}`);
            if (p.get) lines.push('GET', 'END_GET');
            if (p.set) lines.push('SET', 'END_SET');
            lines.push('END_PROPERTY');
        }
        for (const a of d.actions || []) {
            const key = a.toLowerCase();
            if (taken.has(key)) continue;
            taken.add(key);
            lines.push(`ACTION ${a}`, 'END_ACTION');
        }
        lines.push('END_FUNCTION_BLOCK');
    } else if (d.kind === 'struct') {
        const base = d.extendsType ? stripNamespaces(d.extendsType, c.ns) : '';
        const members = (d.members || []).filter(m => IDENT.test(m.name) && c.typeOk(m.type));
        if (members.length === 0) return '';
        lines.push(`TYPE ${d.name}${base ? ` EXTENDS ${base}` : ''} :`, 'STRUCT',
            ...members.map(m => `\t${m.name} : ${c.typeText(m.type)};`), 'END_STRUCT', 'END_TYPE');
    } else if (d.kind === 'enum') {
        const base = String(d.baseType || '').trim().toUpperCase();
        const values = (d.values || []).filter(v => IDENT.test(v.name)).map(v => (v.value && /^[+-]?\d+$/.test(v.value) ? `${v.name} := ${v.value}` : v.name));
        if (values.length === 0) return '';
        lines.push(`TYPE ${d.name} :`, `(${values.join(', ')})${ENUM_BASES.has(base) ? ` ${base}` : ''};`, 'END_TYPE');
    } else if (d.kind === 'alias') {
        lines.push(`TYPE ${d.name} : ${c.typeText(d.baseType || '')};`, 'END_TYPE');
    } else if (d.kind === 'gvl') {
        const members = (d.members || []).filter(m => IDENT.test(m.name) && c.typeOk(m.type) && !(c.userNames && c.userNames.has(m.name.toLowerCase())));
        if (members.length === 0) return '';
        lines.push(...vars('VAR_GLOBAL CONSTANT', members.filter(m => m.constant)), ...vars('VAR_GLOBAL', members.filter(m => !m.constant)));
    }
    return lines.join('\n') + '\n';
}

// ── The filter ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a compiler message says about a name, when it is one of the "this symbol is not declared"
 * messages: an undeclared variable or function, an undefined type, a constant that is not one, a
 * missing member of a library type this run declared partially, a missing global of a library list.
 * @param {string} message
 * @returns {{kind: 'undeclared'|'undefined-type'|'member'|'io'|'global'|'cascade', name: string, owner?: string}|null}
 */
function classifyMessage(message) {
    const s = String(message || '');
    let m = /^Undeclared (?:variable|function) '([^']+)'/.exec(s);
    if (m) return { kind: 'undeclared', name: m[1] };
    m = /^Undefined type '([^']+)'/.exec(s);
    if (m) return { kind: 'undefined-type', name: m[1] };
    m = /^The bounds of an ARRAY must be integer constants: '([^']+)' is not a constant/.exec(s);
    if (m) return { kind: 'undeclared', name: m[1] };
    m = /^'([^']+)' is not a variable of global variable list '([^']+)'/.exec(s);
    if (m) return { kind: 'global', name: m[1], owner: m[2] };
    m = /'([^']+)' has no (?:member|method) '([^']+)'/.exec(s);
    if (m) return { kind: 'member', name: m[2], owner: m[1] };
    m = /^([A-Za-z_]\w*) has no input or output named ([A-Za-z_]\w*)$/.exec(s);
    if (m) return { kind: 'io', name: m[2], owner: m[1] };
    m = /\bgot ([A-Za-z_]\w*)$/.exec(s);
    if (m) return { kind: 'cascade', name: m[1] };
    return null;
}

/**
 * @typedef {Object} LibraryFilter
 * @property {(diagnostics: Array<{severity: string, message: string}>) => Set<any>} select
 *   The diagnostics of one run to drop (all of them are looked at together: a cascade is dropped
 *   only when the error it follows from was).
 */

/**
 * The filter: an ERROR is dropped only when it says a symbol is not declared AND that symbol is a
 * known library name the project does not declare itself. A missing member is dropped only on a
 * library type this run declared (the `.tmc` and dump member lists can be partial) and only when the
 * member's name is a known library name; a missing call parameter only on a function block whose
 * parameter list came from the `.tmc` alone; a "got X" cascade only when X's own "undefined type"
 * error was dropped. Everything else — every warning, every user symbol, every unknown name — stays.
 * @param {{knownNames: Set<string>, userNames: Set<string>, owners: Set<string>, globalLists: Set<string>,
 *   partialIo?: Set<string>}} o Lower-cased sets.
 * @returns {LibraryFilter}
 */
function createLibraryFilter(o) {
    const library = (/** @type {string} */ name) => {
        const key = String(name || '').toLowerCase();
        return !!key && o.knownNames.has(key) && !o.userNames.has(key);
    };
    return {
        select(diagnostics) {
            const dropped = new Set();
            const droppedTypes = new Set();
            const later = [];
            for (const d of diagnostics || []) {
                if (!d || d.severity !== 'error') continue;
                const c = classifyMessage(d.message);
                if (!c) continue;
                if (c.kind === 'cascade') { later.push({ d, c }); continue; }
                let drop = false;
                if (c.kind === 'undeclared' || c.kind === 'undefined-type') drop = library(c.name);
                else if (c.kind === 'member') drop = o.owners.has(String(c.owner).toLowerCase()) && library(c.name);
                else if (c.kind === 'io') drop = !!o.partialIo && o.partialIo.has(String(c.owner).toLowerCase()) && library(c.name);
                else if (c.kind === 'global') drop = o.globalLists.has(String(c.owner).toLowerCase()) && library(c.name);
                if (drop) {
                    dropped.add(d);
                    if (c.kind === 'undefined-type') droppedTypes.add(c.name.toLowerCase());
                }
            }
            for (const { d, c } of later) if (droppedTypes.has(c.name.toLowerCase())) dropped.add(d);
            return dropped;
        }
    };
}

// ── The one entry point ────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LibraryCheck What one Compile Project run needs about libraries.
 * @property {any[]} inputs The check inputs, with library qualifiers blanked (new unit objects;
 *   the given ones are not changed).
 * @property {ExtraFile[]} extraFiles The declarations, for runCheck's temporary directory.
 * @property {LibraryFilter} filter
 * @property {boolean} hasSignatures
 * @property {boolean} referencesLibraries The project's `.plcproj` references at least one library.
 * @property {{declared: number, skippedCompiler: number, skippedUser: number, unresolved: number,
 *   qualifiers: number, knownNames: number, gatherMs: number, ms: number}} stats
 */

/**
 * Prepares the library side of one check. Reads the local sources, writes nothing.
 * @param {{projectDir: string, roots?: string[], inputs: any[], compilerPath: string, knowledge?: LibraryKnowledge}} o
 *   `knowledge` replaces the gathering (tests).
 * @returns {LibraryCheck}
 */
function prepareLibraryCheck(o) {
    const started = Date.now();
    const knowledge = o.knowledge || gatherLibraryKnowledge({ projectDir: o.projectDir, roots: o.roots });
    const userNames = collectUserNames(o.inputs);
    let qualifiers = 0;
    const inputs = (o.inputs || []).map((input) => {
        const stripped = stripQualifiers(input.unit.stText, knowledge.namespaces, userNames);
        if (stripped.count === 0) return input;
        qualifiers += stripped.count;
        const lines = stripped.text.split('\n');
        return { ...input, unit: { ...input.unit, stText: stripped.text, lines } };
    });
    const set = buildDeclarations(knowledge, {
        texts: inputs.map(i => i.unit.stText), userNames, compilerNames: compilerProvidedNames(o.compilerPath)
    });
    const filter = createLibraryFilter({ knownNames: knowledge.knownNames, userNames, owners: set.owners, globalLists: set.globalLists, partialIo: set.partialIo });
    return {
        inputs, extraFiles: set.files, filter, hasSignatures: knowledge.hasSignatures,
        referencesLibraries: knowledge.namespaces.size > 0,
        stats: { declared: set.declared.size, ...set.counts, qualifiers, knownNames: knowledge.knownNames.size,
            gatherMs: knowledge.stats.ms, ms: Date.now() - started }
    };
}

module.exports = {
    ELEMENTARY,
    MAX_DECLARATION_FILES,
    compilerProvidedNames,
    isConversionName,
    readType,
    parseTmcDeclarations,
    gatherLibraryKnowledge,
    collectUserNames,
    blankCommentsAndStrings,
    stripQualifiers,
    buildDeclarations,
    renderDeclaration,
    classifyMessage,
    createLibraryFilter,
    prepareLibraryCheck
};
