/**
 * @file xmlIndexer.js
 * @description Builds LSP workspace symbol nodes directly from TwinCAT XML objects
 * (.TcPOU/.TcGVL/.TcDUT/.TcIO) with real declaration ranges. This is the single source of
 * truth for cross-file symbols (function blocks, programs, GVLs, DUT structs/enums, interfaces).
 * Ranges are lines of the file's assembled Structured Text unit (stConverter raw mode), the frame
 * parser.js uses for a synced editor and livePath.js maps back to panes (`unitLineMap`), and in the
 * shapes parser.js gives them: name ranges are the name token (never a mention in a comment, pragma
 * or string, matched case-insensitively), a method's declRange spans METHOD..END_METHOD. Only a name
 * that cannot be found keeps the (1,1) stub range.
 * Has no dependency on the `vscode` module so it can run inside the LSP server process and in
 * test harnesses.
 */

const fs = require('fs');
const path = require('path');
const { fsPathToFileUri } = require('../fileUri');
const { parseTwinCatXml } = require('../xmlParser');
const { convertXmlToSt } = require('../stConverter');
const { blankComments } = require('../stComments');
const { tokenize, parseVariablesBlock, TokenType } = require('./parser');
const { headHasDirective } = require('./conditionals');
const { createSymbolNode } = require('./symbolNode');
const { TWINCAT_XML_EXTS, XML_INDEX_SKIP_DIRS } = require('../twincatWorkspace');
const log = require('./log');

// `.tctleo` (EnumerationTextList) declares a real ST enum — xmlParser normalises its root element to
// DUT, so it indexes as one. `.tctto` (task) and `.tctlo` (HMI text list) are NOT ST types. Same Set
// object as twincatWorkspace.js's TWINCAT_XML_EXTS (the discovery owner), kept under this module's
// existing export name.
const TWINCAT_EXTS = TWINCAT_XML_EXTS;

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Blanks the text a name search must not match — comments, pragmas (`{attribute …}`) and string
 * literals — with spaces, keeping every line break, so an offset into the result is the same line and
 * column of the original. The lexer skips all three, so this is what parser.js sees.
 * @param {string} text Declaration text.
 * @returns {string} Same-length text.
 */
function codeOnly(text) {
    return blankComments(text || '', { pragmas: true, strings: true });
}

/**
 * The 1-based range of the identifier at `idx` in `text`.
 * @param {string} text Source text.
 * @param {number} idx Offset of the identifier's first character.
 * @param {number} length The identifier's length.
 * @param {number} firstLine The unit line `text` starts on.
 * @returns {{startLine: number, startCol: number, endLine: number, endCol: number}}
 */
function rangeAt(text, idx, length, firstLine) {
    const before = text.substring(0, idx);
    const line = (before.match(/\n/g) || []).length + firstLine;
    const col = idx - before.lastIndexOf('\n'); // 1-based column
    return { startLine: line, startCol: col, endLine: line, endCol: col + length };
}

/**
 * Locates the 1-based position of a whole-word identifier within a text block: its first occurrence
 * outside comments, pragmas and strings, compared case-insensitively (ST names are), which is the
 * name token parser.js takes for a declaration whose head is the first code in it.
 * @param {string} text Source text.
 * @param {string} word Identifier to locate.
 * @param {number} [firstLine] The unit line `text` starts on (see `unitLineMap`); 1 by default.
 * @param {number} [from] Offset to start searching at, which must be outside any comment, pragma or
 *   string (0, or just past a keyword found as code); 0 by default.
 * @param {string} [code] `codeOnly(text)`, when the caller already has it.
 * @returns {Object} A range { startLine, startCol, endLine, endCol } (1-based), or a default at 1:1
 *   (not found: the default is not moved by `firstLine`).
 */
function locate(text, word, firstLine = 1, from = 0, code = undefined) {
    const def = { startLine: 1, startCol: 1, endLine: 1, endCol: 1 };
    if (!text || !word) return def;
    const idx = code === undefined ? findCodeWord(text, word, from) : findWord(code, word, from);
    return idx === -1 ? def : rangeAt(text, idx, word.length, firstLine);
}

/**
 * `findWord(codeOnly(text), word, from)`, without blanking when nothing between `from` and the first
 * textual match can open a comment, pragma or string (the usual declaration, whose head is its first
 * line): indexing runs this per name, and the blanking pass is what costs.
 * @param {string} text Raw source text.
 * @param {string} word Identifier.
 * @param {number} [from] Start offset, outside any comment, pragma or string.
 * @returns {number} The offset, or -1.
 */
function findCodeWord(text, word, from = 0) {
    const idx = findWord(text, word, from);
    if (idx === -1) return -1;
    if (!/[/({'"]/.test(text.substring(from, idx))) return idx;
    return findWord(codeOnly(text), word, from);
}

/**
 * Offset of the first whole-word, case-insensitive occurrence of `word` in `code` at or after `from`.
 * @param {string} code Text already passed through `codeOnly`.
 * @param {string} word Identifier.
 * @param {number} [from] Start offset.
 * @returns {number} The offset, or -1.
 */
function findWord(code, word, from = 0) {
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi');
    re.lastIndex = from;
    const m = re.exec(code);
    return m ? m.index : -1;
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
 * @param {number} [firstLine] The unit line `declText` starts on; 1 by default.
 * @returns {Array<Object>} Parsed variables, every range (name, type, …) in unit lines.
 */
function extractVars(declText, firstLine = 1) {
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
    if (firstLine !== 1) for (const v of vars) shiftRanges(v, firstLine - 1);
    return vars;
}

/**
 * Moves every range of a parsed variable (`range`, `typeRange`, …: any own object property with a
 * numeric `startLine`) down by `offset` lines. The ranges are the variable's own objects.
 * @param {Object} v A variable from parseVariablesBlock.
 * @param {number} offset Lines to add.
 */
function shiftRanges(v, offset) {
    for (const key of Object.keys(v)) {
        const r = v[key];
        if (r && typeof r === 'object' && typeof r.startLine === 'number') {
            r.startLine += offset;
            if (typeof r.endLine === 'number') r.endLine += offset;
        }
    }
}

/**
 * The line map of the file's assembled Structured Text unit (stConverter raw mode): the same unit the
 * live path assembles and a synced editor's node (parser.js) is indexed from. Every range this
 * indexer emits is in that frame, so a consumer never has to know which indexer built a node (R15
 * review round 3, #0: livePath.js `mapDefinition` read CDATA-relative lines as unit lines and jumped
 * to the wrong line).
 * @param {Object} parsed parseTwinCatXml's result.
 * @returns {{declStart: (componentId: string) => number, lineMap: Object, line: (n: number) => (string|undefined)}}
 *   `declStart` gives the 1-based line a component's declaration starts on, or 1 when the component
 *   has no declaration block in the unit; `line` gives the text of 1-based unit line `n`.
 */
function unitLineMap(parsed) {
    let lineMap = {};
    let stText = '';
    try {
        const unit = convertXmlToSt(parsed, { raw: true });
        lineMap = unit.lineMap || {};
        stText = unit.stText;
    } catch (e) { /* keep the empty map */ }
    const declStart = (/** @type {string} */ componentId) => {
        const b = lineMap[componentId];
        return b && b.decl && b.decl.start ? b.decl.start : 1;
    };
    /** @type {string[]|null} */
    let lines = null;
    const line = (/** @type {number} */ n) => (lines || (lines = stText.split('\n')))[n - 1];
    return { declStart, lineMap, line };
}

/**
 * The unit line of a method's `END_METHOD`, as stConverter emits it: after the implementation in a
 * POU, after the declaration in an interface (which has none). Checked against the unit text, so a
 * layout change cannot silently move it.
 * @param {{lineMap: Object, line: (n: number) => (string|undefined)}} unit `unitLineMap`'s result.
 * @param {string} componentId The method's component id.
 * @returns {number} The 1-based line, or 0 when it is not where it should be.
 */
function endMethodLine(unit, componentId) {
    const b = unit.lineMap[componentId];
    if (!b) return 0;
    const line = b.impl && b.impl.start ? b.impl.end + 1 : b.decl.end;
    return /^END_METHOD\s*$/.test(unit.line(line) || '') ? line : 0;
}

/**
 * Extracts enum members from a DUT enum declaration of the form
 * `TYPE Name : ( A := 0, B, C ); END_TYPE`.
 * @param {string} declText Declaration text.
 * @param {number} [firstLine] The unit line `declText` starts on; 1 by default.
 * @returns {Array<Object>} Members as variable-shaped entries ({ name, type: 'Enum', range }).
 */
function extractEnumMembers(declText, firstLine = 1) {
    const members = [];
    if (!declText) return members;
    // Blank comments (nested ones included), pragmas (`{IF defined(X)}`, attributes) and strings to
    // avoid false parens and commas, and so a member mentioned in a comment is not located there.
    // Members in every conditional branch are kept: any of them may exist.
    const clean = codeOnly(declText);
    const colonIdx = clean.indexOf(':');
    if (colonIdx === -1) return members;
    const parenStart = clean.indexOf('(', colonIdx);
    const parenEnd = clean.indexOf(')', parenStart);
    if (parenStart === -1 || parenEnd === -1 || parenStart > parenEnd) return members;
    // Each member is located in the list itself, after the one before it: the first whole-word match
    // in the text could be an earlier member's initialiser (`B := A + 1`) or the type head.
    let offset = parenStart + 1;
    for (const part of clean.substring(parenStart + 1, parenEnd).split(',')) {
        const partStart = offset;
        offset += part.length + 1;
        const eq = part.indexOf(':=');
        const name = (eq !== -1 ? part.substring(0, eq) : part).trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            members.push({ name, type: 'Enum', scope: 'ENUM', range: locate(declText, name, firstLine, partStart, clean) });
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
    // Blank comments (nested ones included) so a commented-out keyword or paren cannot decide the kind.
    const clean = blankComments(decl);

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
    // The same comma-separated identifier list as EXTENDS. The old character class also took
    // whitespace, so on a multi-line head it ran on into the VAR block ("I_A\r\nVAR_INPUT\r\n\tx"),
    // the interface name never matched, and assigning the FB to its interface was reported as a type
    // mismatch until the FB's own unit had been parsed.
    const impl = decl.match(/\bIMPLEMENTS\s+([a-zA-Z_][a-zA-Z0-9_.]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_.]*)*)/i);
    if (impl) {
        result.implements = impl[1].split(',').map(s => s.trim()).filter(Boolean);
    }
    return result;
}

/**
 * True when the declaration head (between the POU/INTERFACE/TYPE keyword and the first declaration
 * block) holds a conditional pragma, so EXTENDS/IMPLEMENTS depend on a define (conditionals.js).
 * @param {string} decl Declaration text.
 * @returns {boolean}
 */
function inheritanceDependsOnDefine(decl) {
    if (!decl || decl.indexOf('{') === -1) return false;
    const tokens = tokenize(decl);
    if (!tokens.conditionals) return false;
    const heads = new Set(['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE', 'TYPE']);
    const i = tokens.findIndex(t => t.type === TokenType.Keyword && heads.has(t.value.toUpperCase()));
    return i !== -1 && headHasDirective(tokens, i + 1);
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
    // Every range below is a line of the assembled unit, not of a CDATA block (see unitLineMap).
    const unit = unitLineMap(parsed);
    const declStart = unit.declStart;
    const rootStart = declStart('root');

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
        nameRange: locate(rootDecl, parsed.rootName, rootStart)
        // extends / extendsAll / implements are filled in from parseInheritance just below;
        // range defaults to (1,1,1,1) as before. DUT-specific fields (dutKind) are added later.
    });

    const inh = parseInheritance(rootDecl);
    node.extends = inh.extends;
    node.extendsAll = inh.extendsAll;
    node.implements = inh.implements;
    if (inheritanceDependsOnDefine(rootDecl)) node.inheritanceUncertain = true;
    // A GVL records whether it is `{attribute 'qualified_only'}` (online monitoring may map an
    // unqualified name to a GVL variable only when it is not). A pragma anywhere in the declaration
    // counts, even one in a comment: the safe answer is the restrictive one.
    if (type === 'GVL') node.qualifiedOnly = /\{\s*attribute\s+'qualified_only'\s*\}/i.test(rootDecl);

    // Root variables: VAR blocks (POU/GVL), struct/union fields (DUT struct or union), or enum
    // members (DUT enum). A union declares its members like a struct, so it takes the same path —
    // its node then resolves as a struct type and member access on it is checked normally.
    // An alias/subrange DUT declares no members at all; `dutKind` records that, so types.js can tell
    // it apart from an empty struct and stay silent about it instead of inventing false positives.
    if (type === 'DUT') {
        node.dutKind = dutKindFromDecl(rootDecl);
        if (node.dutKind === 'struct' || node.dutKind === 'union') {
            node.variables = extractVars(rootDecl, rootStart);
        } else if (node.dutKind === 'enum') {
            node.variables = extractEnumMembers(rootDecl, rootStart);
        } else {
            node.variables = []; // alias / subrange
        }
    } else {
        node.variables = extractVars(rootDecl, rootStart);
    }

    // Sub-components (methods, properties, actions).
    for (const comp of parsed.components) {
        if (comp.id === 'root') continue;
        // Ranges take parser.js's shapes (parseAndIndexDocument on the same unit), so a node is the
        // same whichever indexer built it: a method's declRange runs from its METHOD keyword to its
        // END_METHOD, a property's is collapsed onto its PROPERTY keyword (parser.js never extends
        // it), and an action's name is on the `ACTION <name>` line stConverter synthesises.
        if (comp.type === 'Method') {
            const decl = comp.declaration || '';
            const first = declStart(comp.id);
            const retMatch = decl.match(/\bMETHOD\b\s+[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*([a-zA-Z_][a-zA-Z0-9_.]*)/i);
            const kw = findCodeWord(decl, 'METHOD');
            const declRange = kw === -1 ? locate(decl, comp.name, first) : rangeAt(decl, kw, 0, first);
            const endLine = endMethodLine(unit, comp.id);
            if (kw !== -1 && endLine) {
                declRange.endLine = endLine;
                declRange.endCol = 11; // 'END_METHOD' at column 1, as parser.js closes it
            }
            node.methods.push({
                name: comp.name,
                variables: extractVars(decl, first),
                returnType: retMatch ? retMatch[1] : 'BOOL',
                declRange,
                nameRange: locate(decl, comp.name, first, kw === -1 ? 0 : kw + 6),
                implRange: null
            });
        } else if (comp.type === 'Property') {
            const decl = comp.declaration || '';
            const first = declStart(comp.id);
            const subName = comp.xmlContext.subName;
            const typeMatch = decl.match(/\bPROPERTY\b\s+[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*(.+)$/im);
            const kw = findCodeWord(decl, 'PROPERTY');
            node.properties.push({
                name: subName,
                type: typeMatch ? typeMatch[1].trim() : 'BOOL',
                declRange: kw === -1 ? locate(decl, subName, first) : rangeAt(decl, kw, 0, first),
                nameRange: locate(decl, subName, first, kw === -1 ? 0 : kw + 8),
                getAccessor: null,
                setAccessor: null
            });
        } else if (comp.type === 'Action') {
            const line = unit.lineMap[comp.id] ? declStart(comp.id) : 0;
            node.actions.push({
                name: comp.name,
                nameRange: line
                    ? { startLine: line, startCol: 8, endLine: line, endCol: 8 + comp.name.length }
                    : { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
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
        const fileUri = fsPathToFileUri(filePath);
        return indexXmlObject(index, xml, fileUri);
    } catch (e) {
        // `debug`, not `warn`: a `.plcproj` that still `<Compile>`s a file someone moved or deleted is
        // ordinary in the wild (projectMap.js keeps the Include spelling when the file cannot be found
        // on disk), so this fires on projects that are not broken in any way the user cares about.
        log.debug('xml-object-index-failed', { file: filePath, error: e });
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
        log.debug('object-directory-read-failed', { dir: dirPath, error: e });
        return;
    }
    for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            // R1: case-insensitive skip matching (was an exact-case chain) — see twincatWorkspace.js's
            // walkFiles, whose XML_INDEX_SKIP_DIRS this reuses.
            if (XML_INDEX_SKIP_DIRS.has(entry.name.toLowerCase())) {
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

