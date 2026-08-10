/**
 * @file xmlIndexer.js
 * @description Builds LSP workspace symbol nodes directly from TwinCAT XML objects
 * (.TcPOU/.TcGVL/.TcDUT/.TcIO) with real declaration ranges. This is the single source of
 * truth for cross-file symbols (function blocks, programs, GVLs, DUT structs/enums, interfaces).
 * Has no dependency on the `vscode` module so it can run inside the LSP server process and in
 * test harnesses.
 */

const fs = require('fs');
const path = require('path');
const { parseTwinCatXml } = require('../xmlParser');
const { tokenize, parseVariablesBlock, TokenType } = require('./parser');
const { createSymbolNode } = require('./symbolNode');

// `.tctleo` (EnumerationTextList) declares a real ST enum — xmlParser normalises its root element to
// DUT, so it indexes as one. `.tctto` (task) and `.tctlo` (HMI text list) are NOT ST types.
const TWINCAT_EXTS = new Set(['.tcpou', '.tcgvl', '.tcdut', '.tcio', '.tctleo']);

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locates the 1-based position of a whole-word identifier within a text block.
 * @param {string} text Source text.
 * @param {string} word Identifier to locate.
 * @returns {Object} A range { startLine, startCol, endLine, endCol } (1-based), or a default at 1:1.
 */
function locate(text, word) {
    const def = { startLine: 1, startCol: 1, endLine: 1, endCol: 1 };
    if (!text || !word) return def;
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`);
    const idx = text.search(re);
    if (idx === -1) return def;
    const before = text.substring(0, idx);
    const line = (before.match(/\n/g) || []).length + 1;
    const lastNl = before.lastIndexOf('\n');
    const col = idx - lastNl; // 1-based column
    return { startLine: line, startCol: col, endLine: line, endCol: col + word.length };
}

/**
 * Replaces a keyword with a same-length padded token so character offsets are preserved.
 * @param {string} text Source.
 * @param {RegExp} re Keyword regex (global).
 * @param {string} replacement Replacement keyword (must be <= matched length).
 * @returns {string} Length-preserving rewritten text.
 */
function padReplace(text, re, replacement) {
    return text.replace(re, (m) => replacement + ' '.repeat(Math.max(0, m.length - replacement.length)));
}

/**
 * Extracts variables from any declaration containing VAR-family, STRUCT or UNION blocks.
 * STRUCT/END_STRUCT and UNION/END_UNION are normalized (length-preserving) to VAR/END_VAR so the
 * shared variable-block parser can extract their fields — union members are declared with exactly
 * the same syntax as struct fields, so a union is indexed exactly like a struct.
 * (`\bUNION\b` cannot match inside `END_UNION`: the preceding '_' is a word character.)
 * @param {string} declText Declaration text.
 * @returns {Array<Object>} Parsed variables with ranges relative to declText.
 */
function extractVars(declText) {
    if (!declText) return [];
    let normalized = padReplace(declText, /\bSTRUCT\b/gi, 'VAR');
    normalized = padReplace(normalized, /\bEND_STRUCT\b/gi, 'END_VAR');
    normalized = padReplace(normalized, /\bUNION\b/gi, 'VAR');
    normalized = padReplace(normalized, /\bEND_UNION\b/gi, 'END_VAR');
    const tokens = tokenize(normalized);
    const vars = [];
    let idx = 0;
    while (idx < tokens.length) {
        const t = tokens[idx];
        if (t.type === TokenType.Keyword && t.value.toUpperCase().startsWith('VAR')) {
            const { vars: blockVars, nextIndex } = parseVariablesBlock(tokens, idx + 1, t.value.toUpperCase());
            vars.push(...blockVars);
            idx = nextIndex;
        } else {
            idx++;
        }
    }
    return vars;
}

/**
 * Extracts enum members from a DUT enum declaration of the form
 * `TYPE Name : ( A := 0, B, C ); END_TYPE`.
 * @param {string} declText Declaration text.
 * @returns {Array<Object>} Members as variable-shaped entries ({ name, type: 'Enum', range }).
 */
function extractEnumMembers(declText) {
    const members = [];
    if (!declText) return members;
    // Strip comments to avoid false parens.
    const clean = declText.replace(/\/\/.*$/gm, '').replace(/\(\*[\s\S]*?\*\)/g, '');
    const colonIdx = clean.indexOf(':');
    if (colonIdx === -1) return members;
    const parenStart = clean.indexOf('(', colonIdx);
    const parenEnd = clean.indexOf(')', parenStart);
    if (parenStart === -1 || parenEnd === -1 || parenStart > parenEnd) return members;
    const body = clean.substring(parenStart + 1, parenEnd);
    for (let part of body.split(',')) {
        part = part.trim();
        if (!part) continue;
        const eq = part.indexOf(':=');
        const name = (eq !== -1 ? part.substring(0, eq) : part).trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            members.push({ name, type: 'Enum', scope: 'ENUM', range: locate(declText, name) });
        }
    }
    return members;
}

/**
 * Classifies a DUT declaration into the four shapes `TYPE ... END_TYPE` can take.
 *
 * The distinction matters because only struct/union/enum DUTs declare members; an **alias**
 * (`TYPE T_Handle : DWORD; END_TYPE`) and a **subrange** (`TYPE T_Percent : INT(0..100); END_TYPE`)
 * declare none. Without this kind, a member-less DUT is indistinguishable from an empty struct, and
 * types.js resolves it as a struct — which then member-checks it against an empty field set and
 * treats every numeric use of it as a type mismatch. Both are false positives on perfectly legal ST.
 *
 * Enum vs subrange is decided on **what precedes the parenthesis**, not on its mere presence:
 *   - an enum's member list follows the colon *directly* — `TYPE E : (Idle := 0, Run) DINT;`
 *     (an optional base type comes *after* the list, never before it);
 *   - a subrange's parens follow a base **type name** and hold a `low..high` range — `INT(0..100)`;
 *     so does a sized string alias, `STRING(80)`.
 * The `..` guard is belt-and-braces: an enum member list never contains a range.
 *
 * @param {string} decl DUT root declaration text.
 * @returns {string} 'struct' | 'union' | 'enum' | 'alias'
 */
function dutKindFromDecl(decl) {
    if (!decl) return 'alias';
    // Strip comments so a commented-out keyword or paren cannot decide the kind.
    const clean = decl.replace(/\/\/.*$/gm, '').replace(/\(\*[\s\S]*?\*\)/g, '');

    // `\bUNION\b` / `\bSTRUCT\b` cannot match inside END_UNION / END_STRUCT: '_' is a word character.
    if (/\bUNION\b/i.test(clean)) return 'union';
    if (/\bSTRUCT\b/i.test(clean)) return 'struct';

    // Text after the `TYPE <Name> :` head. Matching the head (rather than the first ':' in the file)
    // keeps a preceding attribute pragma such as `{attribute 'namespace' := 'X'}` out of the way.
    const head = clean.match(/\bTYPE\b\s+[a-zA-Z_][a-zA-Z0-9_]*\s*:/i);
    const colonIdx = head ? head.index + head[0].length : clean.indexOf(':') + 1;
    if (colonIdx <= 0) return 'alias';
    const after = clean.substring(colonIdx);

    const parenStart = after.indexOf('(');
    if (parenStart === -1) return 'alias'; // plain alias: `TYPE T : DWORD;`
    const parenEnd = after.indexOf(')', parenStart);
    const body = parenEnd === -1 ? after.substring(parenStart + 1) : after.substring(parenStart + 1, parenEnd);

    const beforeParen = after.substring(0, parenStart).trim();
    if (beforeParen === '' && !/\.\./.test(body)) return 'enum';
    return 'alias'; // subrange `INT(0..100)`, sized string `STRING(80)`, ...
}

/**
 * Determines the specific POU type from a root declaration.
 * @param {string} decl Root declaration text.
 * @returns {string} 'FUNCTION_BLOCK' | 'PROGRAM' | 'FUNCTION' | 'POU'
 */
function specificPouType(decl) {
    if (/\bFUNCTION_BLOCK\b/i.test(decl)) return 'FUNCTION_BLOCK';
    if (/\bPROGRAM\b/i.test(decl)) return 'PROGRAM';
    if (/\bFUNCTION\b(?!\s*BLOCK)/i.test(decl)) return 'FUNCTION';
    return 'POU';
}

/**
 * Parses `EXTENDS X` and `IMPLEMENTS A, B` clauses from a declaration head.
 * @param {string} decl Declaration text.
 * @returns {Object} { extends: string|null, implements: string[] }
 */
function parseInheritance(decl) {
    const result = { extends: null, extendsAll: [], implements: [] };
    // EXTENDS may name several parents — an interface can extend multiple interfaces
    // (`EXTENDS I_A, I_B`). Match the comma-separated identifier list, which naturally stops before
    // IMPLEMENTS or a VAR block (no comma precedes them). Capturing only the first parent made a
    // second-parent member read as undeclared. `extends` stays the first for single-parent callers.
    const ext = decl.match(/\bEXTENDS\s+([a-zA-Z_][a-zA-Z0-9_.]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_.]*)*)/i);
    if (ext) {
        result.extendsAll = ext[1].split(',').map(s => s.trim()).filter(Boolean);
        if (result.extendsAll.length) result.extends = result.extendsAll[0];
    }
    const impl = decl.match(/\bIMPLEMENTS\s+([a-zA-Z_][a-zA-Z0-9_.,\s]*)/i);
    if (impl) {
        result.implements = impl[1].split(',').map(s => s.trim()).filter(Boolean);
    }
    return result;
}

/**
 * Builds a workspace symbol node from a TwinCAT XML object.
 * @param {string} xmlText The raw .TcPOU/.TcGVL/.TcDUT/.TcIO content.
 * @param {string} fileUri The file URI to associate with the node.
 * @returns {Object|null} A symbol node compatible with the LSP symbol index, or null.
 */
function buildNodeFromXml(xmlText, fileUri) {
    const parsed = parseTwinCatXml(xmlText);
    if (!parsed) return null;

    const root = parsed.components.find(c => c.id === 'root');
    const rootDecl = root ? (root.declaration || '') : '';

    let type;
    if (parsed.rootType === 'POU') type = specificPouType(rootDecl);
    else if (parsed.rootType === 'GVL') type = 'GVL';
    else if (parsed.rootType === 'DUT') type = 'DUT';
    else if (parsed.rootType === 'Itf') type = 'INTERFACE';
    else type = parsed.rootType;

    const node = createSymbolNode({
        name: parsed.rootName,
        type,
        uri: fileUri,
        nameRange: locate(rootDecl, parsed.rootName)
        // extends / extendsAll / implements are filled in from parseInheritance just below;
        // range defaults to (1,1,1,1) as before. DUT-specific fields (dutKind) are added later.
    });

    const inh = parseInheritance(rootDecl);
    node.extends = inh.extends;
    node.extendsAll = inh.extendsAll;
    node.implements = inh.implements;

    // Root variables: VAR blocks (POU/GVL), struct/union fields (DUT struct or union), or enum
    // members (DUT enum). A union declares its members like a struct, so it takes the same path —
    // its node then resolves as a struct type and member access on it is checked normally.
    // An alias/subrange DUT declares no members at all; `dutKind` records that, so types.js can tell
    // it apart from an empty struct and stay silent about it instead of inventing false positives.
    if (type === 'DUT') {
        node.dutKind = dutKindFromDecl(rootDecl);
        if (node.dutKind === 'struct' || node.dutKind === 'union') {
            node.variables = extractVars(rootDecl);
        } else if (node.dutKind === 'enum') {
            node.variables = extractEnumMembers(rootDecl);
        } else {
            node.variables = []; // alias / subrange
        }
    } else {
        node.variables = extractVars(rootDecl);
    }

    // Sub-components (methods, properties, actions).
    for (const comp of parsed.components) {
        if (comp.id === 'root') continue;
        if (comp.type === 'Method') {
            const decl = comp.declaration || '';
            const retMatch = decl.match(/\bMETHOD\b\s+[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*([a-zA-Z_][a-zA-Z0-9_.]*)/i);
            node.methods.push({
                name: comp.name,
                variables: extractVars(decl),
                returnType: retMatch ? retMatch[1] : 'BOOL',
                declRange: locate(decl, comp.name),
                nameRange: locate(decl, comp.name),
                implRange: null
            });
        } else if (comp.type === 'Property') {
            const decl = comp.declaration || '';
            const subName = comp.xmlContext.subName;
            const typeMatch = decl.match(/\bPROPERTY\b\s+[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*(.+)$/im);
            node.properties.push({
                name: subName,
                type: typeMatch ? typeMatch[1].trim() : 'BOOL',
                declRange: locate(decl, subName),
                nameRange: locate(decl, subName),
                getAccessor: null,
                setAccessor: null
            });
        } else if (comp.type === 'Action') {
            node.actions.push({
                name: comp.name,
                nameRange: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
                implRange: null
            });
        }
    }

    return node;
}

/**
 * Builds a node from XML and inserts it into the given symbol index (keyed by name).
 * @param {Object} index The workspace symbol index to mutate.
 * @param {string} xmlText Raw XML content.
 * @param {string} fileUri File URI.
 * @returns {Object|null} The inserted node, or null.
 */
function indexXmlObject(index, xmlText, fileUri) {
    const node = buildNodeFromXml(xmlText, fileUri);
    if (node && node.name) {
        index[node.name] = node;
    }
    return node;
}

/**
 * Indexes a single TwinCAT XML file from disk into the given index.
 * @param {Object} index Workspace symbol index to mutate.
 * @param {string} filePath Absolute path to the .TcPOU/.TcGVL/.TcDUT/.TcIO file.
 * @returns {Object|null} The inserted node, or null.
 */
function indexXmlFile(index, filePath) {
    try {
        const xml = fs.readFileSync(filePath, 'utf8');
        const fileUri = 'file:///' + filePath.replace(/\\/g, '/');
        return indexXmlObject(index, xml, fileUri);
    } catch (e) {
        return null;
    }
}

/**
 * Normalizes an absolute path for comparison: forward slashes, lower-cased. The extension targets
 * Windows/TwinCAT and the rest of the code already compares paths case-insensitively, so this is the
 * comparison key both the .plcproj include set and the directory walk agree on.
 * @param {string} p Absolute path.
 * @returns {string} Normalized key.
 */
function normalizeObjectPath(p) {
    return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Recursively scans a directory for TwinCAT XML objects and indexes them.
 *
 * The project-scoped caller (`src/lsp/workspaceScan.js`) does not use `includedPaths` at all — it
 * indexes one project at a time by calling {@link indexXmlFile} directly over
 * `createProjectMap()`'s per-project `objectPaths` (see `src/lsp/projectMap.js`), so a duplicate
 * object name in another project's directory can never shadow it. `includedPaths` remains for the
 * loose/no-`.plcproj` fallback path and any other caller that still wants a single filtered walk.
 * @param {Object} index Workspace symbol index to mutate.
 * @param {string} dirPath Absolute directory path.
 * @param {Set<string>|null} [includedPaths] When supplied, only objects whose path is in the set are
 *   indexed — orphan/backup copies on disk are skipped so they cannot shadow a real object. Omit/null
 *   to index every object file (the no-project fallback, and the behavior every existing test caller
 *   relies on).
 */
function indexTwinCatDirectory(index, dirPath, includedPaths) {
    if (!fs.existsSync(dirPath)) return;
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.vscode' || entry.name === '_Libraries') {
                continue;
            }
            indexTwinCatDirectory(index, full, includedPaths);
        } else if (entry.isFile() && TWINCAT_EXTS.has(path.extname(entry.name).toLowerCase())) {
            if (includedPaths && !includedPaths.has(normalizeObjectPath(full))) continue;
            indexXmlFile(index, full);
        }
    }
}

module.exports = {
    TWINCAT_EXTS,
    buildNodeFromXml,
    indexXmlObject,
    indexXmlFile,
    indexTwinCatDirectory,
    extractVars,
    extractEnumMembers,
    dutKindFromDecl
};

