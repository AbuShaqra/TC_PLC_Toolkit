/**
 * @file parser.js
 * @description Lightweight lexer, parser, and AST symbol indexer for Structured Text (.st).
 */

const fs = require('fs');
const path = require('path');
const { STANDARD_KEYWORDS } = require('./builtins');
const { createSymbolNode } = require('./symbolNode');

/**
 * Token types for Lexer
 */
const TokenType = {
    Keyword: 'keyword',
    Identifier: 'identifier',
    Number: 'number',
    String: 'string',
    Operator: 'operator',
    Punctuation: 'punctuation',
    Whitespace: 'whitespace',
    Comment: 'comment',
    Pragma: 'pragma',
    Address: 'address',
    Unknown: 'unknown'
};

/**
 * Token types that carry no semantic identifier meaning and are skipped by parsers.
 */
const SKIPPABLE = new Set([TokenType.Whitespace, TokenType.Comment, TokenType.Pragma]);

/**
 * Modifiers that may sit between a POU keyword and the POU's name — `FUNCTION_BLOCK ABSTRACT FB_Axis`,
 * `METHOD FINAL Cyclic`. They change nothing we model, but they must be stepped over: the name is what
 * the whole symbol node hangs off.
 */
const POU_MODIFIERS = new Set(['ABSTRACT', 'FINAL', 'INTERNAL', 'PUBLIC', 'PRIVATE', 'PROTECTED']);

/**
 * Returns true if a token should be skipped when scanning for meaningful tokens.
 * @param {Object} tok Token.
 * @returns {boolean}
 */
function isSkippable(tok) {
    return tok && SKIPPABLE.has(tok.type);
}

/**
 * Advances past whitespace/comments and any access or inheritance modifier, landing on the name that
 * follows a POU/METHOD/PROPERTY/ACTION keyword.
 *
 * Getting this wrong is not cosmetic: the name is what the symbol node hangs off. `FUNCTION_BLOCK
 * ABSTRACT FB_Axis` used to find no name, so parseAndIndexDocument never created the node and instead
 * *appended* its declarations to whatever xmlIndexer had already put in the index — FB_Axis carried
 * 151 variables where it has 67, every one duplicated, and a standalone parse of the file produced an
 * empty index.
 * @param {Array<Object>} tokens Token stream.
 * @param {number} idx Index just after the keyword.
 * @returns {number} Index of the name token (or of whatever is there, if no name follows).
 */
function skipPouModifiers(tokens, idx) {
    let i = idx;
    while (i < tokens.length && isSkippable(tokens[i])) i++;

    while (i < tokens.length && POU_MODIFIERS.has(String(tokens[i].value).toUpperCase())) {
        // Only treat it as a modifier when a name still follows — a POU actually *named* `Final`
        // must not have its own name skipped.
        let j = i + 1;
        while (j < tokens.length && isSkippable(tokens[j])) j++;
        if (j >= tokens.length || tokens[j].type !== TokenType.Identifier) break;
        i = j;
    }
    return i;
}

/**
 * Tokenizes Structured Text code.
 * @param {string} code 
 * @returns {Array<Object>} List of tokens
 */
function tokenize(code) {
    const tokens = [];
    let i = 0;
    let line = 1;
    let col = 1;

    // Shared keyword set (control flow, declaration sections, structural terminators).
    // Note: elementary type names are intentionally NOT keywords here so that type-name
    // parsing (return types, variable types) treats them as identifiers.
    const keywords = STANDARD_KEYWORDS;

    while (i < code.length) {
        const char = code[i];

        // 0a. Pragmas / attributes: { ... } are metadata, not code. Treat the whole
        // brace span as a single skippable token so its contents are never parsed.
        //
        // The scan stops at the end of the line as well as at '}'. TwinCAT writes every pragma on one
        // line, and an *unterminated* '{' used to swallow the rest of the file: while the user typed
        // `{region "Inputs"` — '{' is not auto-closed — every declaration below it vanished from the
        // symbol table and came back as "is not declared", flashing red on each 300 ms re-diagnose.
        if (char === '{') {
            let value = '';
            const start = i;
            const startLine = line;
            const startCol = col;
            while (i < code.length && code[i] !== '}' && code[i] !== '\n') {
                value += code[i];
                col++;
                i++;
            }
            if (i < code.length && code[i] === '}') { value += '}'; i++; col++; }
            tokens.push({ type: TokenType.Pragma, value, start, end: i, line: startLine, col: startCol });
            continue;
        }

        // 0b. Direct I/O address references: %I*, %Q*, %MB100, %IX0.0 etc.
        if (char === '%') {
            let value = '%';
            const start = i;
            const startLine = line;
            const startCol = col;
            i++;
            col++;
            while (i < code.length && /[A-Za-z0-9.*]/.test(code[i])) {
                value += code[i];
                i++;
                col++;
            }
            tokens.push({ type: TokenType.Address, value, start, end: i, line: startLine, col: startCol });
            continue;
        }

        // 1. Whitespace
        if (/\s/.test(char)) {
            let value = '';
            const start = i;
            const startLine = line;
            const startCol = col;
            while (i < code.length && /\s/.test(code[i])) {
                const c = code[i];
                value += c;
                if (c === '\n') {
                    line++;
                    col = 1;
                } else {
                    col++;
                }
                i++;
            }
            tokens.push({
                type: TokenType.Whitespace,
                value: value,
                start: start,
                end: i,
                line: startLine,
                col: startCol
            });
            continue;
        }

        // 2. Comments
        if (char === '/' && code[i + 1] === '/') {
            let value = '';
            const start = i;
            const startLine = line;
            const startCol = col;
            while (i < code.length && code[i] !== '\n') {
                value += code[i];
                i++;
                col++;
            }
            tokens.push({
                type: TokenType.Comment,
                value: value,
                start: start,
                end: i,
                line: startLine,
                col: startCol
            });
            continue;
        }

        // (* *) block comment
        if (char === '(' && code[i + 1] === '*') {
            let value = '(*';
            const start = i;
            const startLine = line;
            const startCol = col;
            i += 2;
            col += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === ')')) {
                const c = code[i];
                value += c;
                if (c === '\n') {
                    line++;
                    col = 1;
                } else {
                    col++;
                }
                i++;
            }
            if (i < code.length) {
                value += '*)';
                i += 2;
                col += 2;
            }
            tokens.push({
                type: TokenType.Comment,
                value: value,
                start: start,
                end: i,
                line: startLine,
                col: startCol
            });
            continue;
        }

        // /* */ block comment
        if (char === '/' && code[i + 1] === '*') {
            let value = '/*';
            const start = i;
            const startLine = line;
            const startCol = col;
            i += 2;
            col += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
                const c = code[i];
                value += c;
                if (c === '\n') {
                    line++;
                    col = 1;
                } else {
                    col++;
                }
                i++;
            }
            if (i < code.length) {
                value += '*/';
                i += 2;
                col += 2;
            }
            tokens.push({
                type: TokenType.Comment,
                value: value,
                start: start,
                end: i,
                line: startLine,
                col: startCol
            });
            continue;
        }

        // 3. Strings
        if (char === "'" || char === '"') {
            const quote = char;
            let value = quote;
            const start = i;
            const startLine = line;
            const startCol = col;
            i++;
            col++;
            while (i < code.length && code[i] !== quote) {
                const c = code[i];
                // IEC 61131-3 string escape is the DOLLAR SIGN, not backslash: $' $" $$ $N $T $R $L
                // $P and $<hex><hex>. '$' escapes the following character, so an escaped quote never
                // ends the literal — `'It$'s'` is one string, and `'C:\path\'` (a trailing backslash,
                // which is an ordinary character in ST) terminates at its real closing quote instead of
                // swallowing the code after it. Applies to both '…' (STRING) and "…" (WSTRING).
                if (c === '$') {
                    value += c;
                    const next = code[i + 1];
                    if (next !== undefined) {
                        value += next;
                        if (next === '\n') { line++; col = 1; i += 2; }
                        else { col += 2; i += 2; }
                    } else {
                        col++;
                        i++;
                    }
                } else {
                    value += c;
                    if (c === '\n') {
                        line++;
                        col = 1;
                    } else {
                        col++;
                    }
                    i++;
                }
            }
            if (i < code.length) {
                value += quote;
                i++;
                col++;
            }
            tokens.push({
                type: TokenType.String,
                value: value,
                start: start,
                end: i,
                line: startLine,
                col: startCol
            });
            continue;
        }

        // 4. Numbers
        if (/[0-9]/.test(char)) {
            let value = '';
            const start = i;
            const startLine = line;
            const startCol = col;

            // Digit runs may carry '_' separators (IEC 61131-3): 1_000_000, 16#FFFF_FFFF, 2#1001_0011.
            while (i < code.length && /[0-9_]/.test(code[i])) {
                value += code[i];
                i++;
                col++;
            }
            // Based literal: 16#FF, 2#1001_0011, 8#17 (radix '#' digits). No fraction/exponent follows.
            if (code[i] === '#') {
                value += '#';
                i++;
                col++;
                while (i < code.length && /[0-9a-zA-Z_]/.test(code[i])) {
                    value += code[i];
                    i++;
                    col++;
                }
            } else {
                // Optional fractional part. `1..3` (ARRAY range) is preserved: '.' only opens a fraction
                // when a digit follows it, so `1` then `..` then `3` still lex as separate tokens.
                if (code[i] === '.' && /[0-9]/.test(code[i + 1])) {
                    value += '.';
                    i++;
                    col++;
                    while (i < code.length && /[0-9_]/.test(code[i])) {
                        value += code[i];
                        i++;
                        col++;
                    }
                }
                // Optional REAL/LREAL exponent: e|E [+|-] digits — 1.64e+009, 1.0E-44, 1E9. Consumed
                // only when a digit actually follows, so an identifier like `e10` is never mis-eaten.
                if ((code[i] === 'e' || code[i] === 'E')
                    && (/[0-9]/.test(code[i + 1])
                        || ((code[i + 1] === '+' || code[i + 1] === '-') && /[0-9]/.test(code[i + 2])))) {
                    value += code[i];
                    i++;
                    col++;
                    if (code[i] === '+' || code[i] === '-') {
                        value += code[i];
                        i++;
                        col++;
                    }
                    while (i < code.length && /[0-9_]/.test(code[i])) {
                        value += code[i];
                        i++;
                        col++;
                    }
                }
            }

            tokens.push({
                type: TokenType.Number,
                value: value,
                start: start,
                end: i,
                line: startLine,
                col: startCol
            });
            continue;
        }

        // 5. Identifiers and Keywords
        if (/[a-zA-Z_]/.test(char)) {
            let value = '';
            const start = i;
            const startLine = line;
            const startCol = col;
            while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) {
                value += code[i];
                i++;
                col++;
            }
            // Typed/time/date literal prefix: T#5s, LTIME#..., TOD#12:00:00, DT#..., WORD#16#FF
            if (code[i] === '#') {
                value += '#';
                i++;
                col++;
                while (i < code.length && /[0-9a-zA-Z_#:.\-]/.test(code[i])) {
                    value += code[i];
                    i++;
                    col++;
                }
                tokens.push({
                    type: TokenType.Number,
                    value: value,
                    start: start,
                    end: i,
                    line: startLine,
                    col: startCol
                });
                continue;
            }
            // ExST word-formed assignment operators: REF= (reference assignment), S= (set) and
            // R= (reset). They must be lexed here, because the leading word would otherwise be
            // consumed as a plain identifier and the '=' as a comparison operator (`x REF = y`).
            // Conditions kept deliberately tight so ordinary code cannot mis-lex: the word must be
            // exactly REF/S/R (a token boundary, never the tail of a longer identifier such as
            // `nPos` or `R_TRIG`), the '=' must be glued to it, and it must not open '==' or '=>'.
            // A comparison written with spaces (`nPos = 5`, `S = 5`) therefore still lexes as '='.
            const upperValue = value.toUpperCase();
            if ((upperValue === 'REF' || upperValue === 'S' || upperValue === 'R')
                && code[i] === '=' && code[i + 1] !== '=' && code[i + 1] !== '>') {
                value += '=';
                i++;
                col++;
                tokens.push({
                    type: TokenType.Operator,
                    value: value,
                    start: start,
                    end: i,
                    line: startLine,
                    col: startCol
                });
                continue;
            }

            const isKeyword = keywords.has(upperValue);
            tokens.push({
                type: isKeyword ? TokenType.Keyword : TokenType.Identifier,
                value: value,
                start: start,
                end: i,
                line: startLine,
                col: startCol
            });
            continue;
        }

        // 6. Operators and Punctuation
        let operatorValue = '';
        const start = i;
        const startLine = line;
        const startCol = col;
        
        // Multi-character operators
        if (char === ':' && code[i + 1] === '=') {
            operatorValue = ':=';
            i += 2;
            col += 2;
        } else if (char === '<' && code[i + 1] === '>') {
            operatorValue = '<>';
            i += 2;
            col += 2;
        } else if (char === '<' && code[i + 1] === '=') {
            operatorValue = '<=';
            i += 2;
            col += 2;
        } else if (char === '>' && code[i + 1] === '=') {
            operatorValue = '>=';
            i += 2;
            col += 2;
        } else if (char === '=' && code[i + 1] === '>') {
            operatorValue = '=>';
            i += 2;
            col += 2;
        } else if (char === '(' && code[i + 1] === '*') {
            // Already handled above
        } else {
            operatorValue = char;
            i++;
            col++;
        }

        // '&' is IEC's alias for AND; classify it as an operator rather than Unknown.
        const isOperator = ['+', '-', '*', '/', '^', '=', '<', '>', ':=', '<>', '<=', '>=', '=>', '&'].includes(operatorValue);
        const isPunctuation = [':', ';', ',', '.', '(', ')', '[', ']', '{', '}'].includes(operatorValue);

        tokens.push({
            type: isOperator ? TokenType.Operator : (isPunctuation ? TokenType.Punctuation : TokenType.Unknown),
            value: operatorValue,
            start: start,
            end: i,
            line: startLine,
            col: startCol
        });
    }

    return tokens;
}

/**
 * Symbol Cache for the Workspace
 */
const workspaceSymbolIndex = {};

/**
 * Clears the workspace symbol index
 */
function clearWorkspaceIndex(index = workspaceSymbolIndex) {
    for (const key of Object.keys(index)) {
        delete index[key];
    }
}

/**
 * Returns the symbol index
 */
function getWorkspaceSymbolIndex() {
    return workspaceSymbolIndex;
}

/**
 * Terminators of a declaration block. STRUCT and UNION bodies declare their members with the very
 * same syntax as a VAR block, so the shared block parser accepts their terminators as well.
 */
const BLOCK_END = new Set(['END_VAR', 'END_STRUCT', 'END_UNION']);

/**
 * Returns true if a token closes a declaration block (END_VAR / END_STRUCT / END_UNION).
 * @param {Object} tok Token.
 * @returns {boolean}
 */
function isBlockEnd(tok) {
    return !!tok && tok.type === TokenType.Keyword && BLOCK_END.has(tok.value.toUpperCase());
}

/**
 * Parses variable declarations tokens in a VAR scope. Also used for STRUCT/UNION bodies, whose
 * members use identical declaration syntax (including `AT %I*` direct addresses).
 * @param {Array<Object>} tokens
 * @param {number} startIndex
 * @param {string} scopeName 'VAR', 'VAR_INPUT', 'STRUCT', 'UNION', etc.
 * @returns {Object} { vars: Array, nextIndex: number }
 */
function parseVariablesBlock(tokens, startIndex, scopeName) {
    const vars = [];
    let idx = startIndex;

    while (idx < tokens.length) {
        const tok = tokens[idx];
        if (isBlockEnd(tok)) {
            idx++;
            break;
        }

        // We are expecting: Identifier[, Identifier] : Type;
        if (tok.type === TokenType.Identifier) {
            const names = [tok.value];
            const nameRanges = [{ start: tok.start, end: tok.end, line: tok.line, col: tok.col }];
            idx++;

            // Check for commas (multi-variable declarations)
            while (idx < tokens.length && tokens[idx].type === TokenType.Punctuation && tokens[idx].value === ',') {
                idx++; // skip comma
                // skip whitespace
                while (idx < tokens.length && (tokens[idx].type === TokenType.Whitespace || tokens[idx].type === TokenType.Comment)) {
                    idx++;
                }
                if (idx < tokens.length && tokens[idx].type === TokenType.Identifier) {
                    const identTok = tokens[idx];
                    names.push(identTok.value);
                    nameRanges.push({ start: identTok.start, end: identTok.end, line: identTok.line, col: identTok.col });
                    idx++;
                }
            }

            // Skip whitespace
            while (idx < tokens.length && isSkippable(tokens[idx])) {
                idx++;
            }

            // Skip an optional AT <address> clause, e.g. "AT %I*" or "AT %QB100".
            if (idx < tokens.length && tokens[idx].type === TokenType.Keyword && tokens[idx].value.toUpperCase() === 'AT') {
                idx++;
                while (idx < tokens.length && (isSkippable(tokens[idx]) || tokens[idx].type === TokenType.Address)) {
                    idx++;
                }
            }

            // Expecting ':'
            if (idx < tokens.length && tokens[idx].type === TokenType.Punctuation && tokens[idx].value === ':') {
                idx++; // skip ':'

                // Skip whitespace
                while (idx < tokens.length && (tokens[idx].type === TokenType.Whitespace || tokens[idx].type === TokenType.Comment)) {
                    idx++;
                }

                // Parse Type (could be single identifier, ARRAY, POINTER, REFERENCE)
                let typeStr = '';
                const typeStart = idx < tokens.length ? tokens[idx].start : 0;
                let typeEnd = typeStart;
                const typeTokens = [];

                while (idx < tokens.length) {
                    const t = tokens[idx];
                    if (t.type === TokenType.Punctuation && t.value === ';') {
                        idx++; // skip ';'
                        break;
                    }
                    if (isBlockEnd(t)) {
                        break; // fail safe
                    }
                    // A pragma is metadata, not part of the type. `nVal : {attribute 'x'} INT;` must
                    // yield `INT`, not `{attribute 'x'} INT` — the latter resolves to nothing, which
                    // is invisible only while declarationTypes is off and becomes a false "Unknown
                    // type" the day it is switched on. The initializer (`INT := 7`) deliberately
                    // STAYS: decl-site init lists are load-bearing (getInitParams reads them).
                    if (t.type === TokenType.Pragma) {
                        idx++;
                        continue;
                    }
                    typeStr += t.value;
                    typeEnd = t.end;
                    typeTokens.push(t);
                    idx++;
                }

                const trimmedTypeStr = typeStr.trim();
                names.forEach((name, nIdx) => {
                    const r = nameRanges[nIdx];
                    vars.push({
                        name: name,
                        type: trimmedTypeStr,
                        scope: scopeName,
                        range: {
                            startLine: r.line,
                            startCol: r.col,
                            endLine: r.line,
                            endCol: r.col + name.length
                        },
                        typeRange: {
                            startLine: tokens.find(t => t.start === typeStart)?.line || r.line,
                            startCol: tokens.find(t => t.start === typeStart)?.col || r.col,
                            endLine: tokens.find(t => t.end === typeEnd)?.line || r.line,
                            endCol: tokens.find(t => t.end === typeEnd)?.col || r.col
                        }
                    });
                });

                // Parse implicit enum values to register them as valid identifiers in
                // scope, each at its OWN source position (inside the parentheses of the
                // type token span). Rule: an identifier immediately after '(' or ',' is a
                // member NAME; an identifier after ':=' is a value and is skipped.
                if (/^\s*\(/.test(trimmedTypeStr)) {
                    const meaningful = typeTokens.filter(t => t.type !== TokenType.Whitespace && t.type !== TokenType.Comment);
                    let inParen = false;
                    let expectName = false;
                    for (const t of meaningful) {
                        if (t.type === TokenType.Punctuation && t.value === '(') {
                            inParen = true;
                            expectName = true;
                            continue;
                        }
                        if (t.type === TokenType.Punctuation && t.value === ')') {
                            break;
                        }
                        if (!inParen) continue;
                        if (t.type === TokenType.Punctuation && t.value === ',') {
                            expectName = true;
                            continue;
                        }
                        if (t.type === TokenType.Operator && t.value === ':=') {
                            expectName = false;
                            continue;
                        }
                        if (expectName && t.type === TokenType.Identifier && /^[a-zA-Z_][a-zA-Z0-9_]*$/i.test(t.value)) {
                            vars.push({
                                name: t.value,
                                type: 'Enum',
                                scope: scopeName,
                                range: {
                                    startLine: t.line,
                                    startCol: t.col,
                                    endLine: t.line,
                                    endCol: t.col + t.value.length
                                }
                            });
                        }
                        expectName = false;
                    }
                }
            } else {
                idx++;
            }
        } else {
            idx++;
        }
    }

    return { vars, nextIndex: idx };
}

/**
 * Parses Structured Text content and registers it in the symbol table.
 * @param {string} code Pure Structured Text content.
 * @param {string} fileUri File path URI.
 */
function parseAndIndexDocument(code, fileUri, index = workspaceSymbolIndex) {
    const tokens = tokenize(code);
    let idx = 0;

    let pouNode = null;
    if (fileUri) {
        pouNode = Object.values(index).find(node => node.uri === fileUri);
    }
    let currentMethod = null;
    let currentProperty = null;

    while (idx < tokens.length) {
        const tok = tokens[idx];

        // Skip comments and whitespaces at the top-level loop
        if (tok.type === TokenType.Whitespace || tok.type === TokenType.Comment) {
            idx++;
            continue;
        }

        const valUpper = tok.value.toUpperCase();

        // 1. POU Declaration: FUNCTION_BLOCK, PROGRAM, FUNCTION, INTERFACE
        if (tok.type === TokenType.Keyword && ['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE', 'GVL'].includes(valUpper)) {
            if (pouNode) {
                const prevTok = tokens[idx - 1];
                pouNode.range.endLine = prevTok ? prevTok.line : tok.line;
                pouNode.range.endCol = prevTok ? (prevTok.col + prevTok.value.length) : tok.col;
            }
            const pouType = valUpper;
            idx = skipPouModifiers(tokens, idx + 1);   // `FUNCTION_BLOCK ABSTRACT FB_Axis`

            if (idx < tokens.length && tokens[idx].type === TokenType.Identifier) {
                const pouName = tokens[idx].value;
                const nameTok = tokens[idx];
                idx++;

                // Create POU node
                const existingPou = index[pouName];

                // A plain .st source must never steal a symbol already backed by a TwinCAT XML
                // object (.TcPOU/.TcGVL/.TcDUT/.TcIO) — XML is the source of truth in a TwinCAT
                // project. A stale exported mirror sitting NEXT to the real object (outside the
                // ST_Files/ folder that indexStDirectory skips) once hijacked P_Automatic's node
                // uri: the cross-file references scan then read the stale .st (which lacked the
                // call site) and the real .TcPOU was invisible until the user opened it. The .st
                // is still parsed — the token walk below must run, and later branches mutate
                // pouNode — but into a DETACHED node that never replaces the XML entry. The
                // reverse direction (the XML indexer overwriting a .st-backed node) stays allowed.
                const xmlObjectUri = /\.(tcpou|tcgvl|tcdut|tcio)$/i;
                const shadowedByXml = !!(existingPou && existingPou.uri && existingPou.uri !== fileUri &&
                    xmlObjectUri.test(existingPou.uri) && !xmlObjectUri.test(fileUri));

                pouNode = createSymbolNode({
                    name: pouName,
                    type: pouType,
                    uri: fileUri,
                    range: {
                        startLine: tok.line,
                        startCol: tok.col,
                        endLine: tok.line, // updated later
                        endCol: tok.col // updated later
                    },
                    nameRange: {
                        startLine: nameTok.line,
                        startCol: nameTok.col,
                        endLine: nameTok.line,
                        endCol: nameTok.col + pouName.length
                    },
                    // extends / extendsAll / implements / returnType are filled in below; the rest
                    // (variables, bodyRange) take the factory defaults. Nested members are carried
                    // over from a prior parse of this file so a re-index does not drop them — but
                    // NOT when shadowed: those arrays are shared by reference with the XML node,
                    // and pushing this file's .st-coordinate members into them would poison it.
                    methods: (existingPou && !shadowedByXml) ? existingPou.methods : [],
                    properties: (existingPou && !shadowedByXml) ? existingPou.properties : [],
                    actions: (existingPou && !shadowedByXml) ? existingPou.actions : []
                });

                // FUNCTION return type: `FUNCTION Name : ReturnType`. Recorded on the POU node so the
                // IEC return-value idiom (`Name := <value>;` in the body, which sets the return value)
                // types against the return type instead of against the function itself. May span
                // several tokens ("ARRAY [1..3] OF REAL", "POINTER TO INT"), like a METHOD's.
                if (pouType === 'FUNCTION') {
                    let k = idx;
                    while (k < tokens.length && isSkippable(tokens[k])) k++;
                    if (k < tokens.length && tokens[k].type === TokenType.Punctuation && tokens[k].value === ':') {
                        k++;
                        while (k < tokens.length && isSkippable(tokens[k])) k++;
                        const typeLine = k < tokens.length ? tokens[k].line : tok.line;
                        let retType = '';
                        while (k < tokens.length) {
                            const rt = tokens[k];
                            if (isSkippable(rt)) { k++; continue; }
                            // Stop at the declaration body or the next line.
                            if (rt.type === TokenType.Keyword && rt.value.toUpperCase().startsWith('VAR')) break;
                            if (rt.type === TokenType.Punctuation && rt.value === ';') { k++; break; }
                            if (rt.line !== typeLine) break;
                            retType += rt.value + ' ';
                            k++;
                        }
                        pouNode.returnType = retType.trim().replace(/\s+/g, ' ') || null;
                        idx = k;
                    }
                }

                // Parse EXTENDS / IMPLEMENTS
                while (idx < tokens.length) {
                    // Skip whitespace/comments first
                    while (idx < tokens.length && (tokens[idx].type === TokenType.Whitespace || tokens[idx].type === TokenType.Comment)) {
                        idx++;
                    }
                    if (idx >= tokens.length) break;

                    const nextTok = tokens[idx];
                    if (nextTok.type === TokenType.Keyword && nextTok.value.toUpperCase() === 'EXTENDS') {
                        idx++;
                        // An INTERFACE may extend SEVERAL interfaces (`EXTENDS I_A, I_B`); an FB/struct
                        // extends one. Collect the whole comma-separated list into extendsAll and keep
                        // `extends` as the first for single-parent call sites. Dropping the extras used
                        // to make second-parent members read as undeclared.
                        while (idx < tokens.length) {
                            while (idx < tokens.length && (tokens[idx].type === TokenType.Whitespace || tokens[idx].type === TokenType.Comment)) {
                                idx++;
                            }
                            if (idx < tokens.length && tokens[idx].type === TokenType.Identifier) {
                                pouNode.extendsAll.push(tokens[idx].value);
                                idx++;
                            } else {
                                break;
                            }
                            while (idx < tokens.length && (tokens[idx].type === TokenType.Whitespace || tokens[idx].type === TokenType.Comment)) {
                                idx++;
                            }
                            if (idx < tokens.length && tokens[idx].type === TokenType.Punctuation && tokens[idx].value === ',') {
                                idx++;
                            } else {
                                break;
                            }
                        }
                        if (pouNode.extendsAll.length) {
                            pouNode.extends = pouNode.extendsAll[0];
                        }
                    } else if (nextTok.type === TokenType.Keyword && nextTok.value.toUpperCase() === 'IMPLEMENTS') {
                        idx++;
                        while (idx < tokens.length) {
                            while (idx < tokens.length && (tokens[idx].type === TokenType.Whitespace || tokens[idx].type === TokenType.Comment)) {
                                idx++;
                            }
                            if (idx < tokens.length && tokens[idx].type === TokenType.Identifier) {
                                pouNode.implements.push(tokens[idx].value);
                                idx++;
                            } else {
                                break;
                            }
                            while (idx < tokens.length && (tokens[idx].type === TokenType.Whitespace || tokens[idx].type === TokenType.Comment)) {
                                idx++;
                            }
                            if (idx < tokens.length && tokens[idx].type === TokenType.Punctuation && tokens[idx].value === ',') {
                                idx++;
                            } else {
                                break;
                            }
                        }
                    } else {
                        break;
                    }
                }

                if (!shadowedByXml) {
                    index[pouName] = pouNode;
                }
            }
            continue;
        }

        // 2. Variables declaration block
        if (tok.type === TokenType.Keyword && tok.value.toUpperCase().startsWith('VAR')) {
            const scopeName = tok.value.toUpperCase();
            const startLine = tok.line;
            idx++;

            const { vars, nextIndex } = parseVariablesBlock(tokens, idx, scopeName);
            idx = nextIndex;

            if (currentMethod) {
                currentMethod.variables.push(...vars);
            } else if (pouNode) {
                pouNode.variables.push(...vars);
            }
            continue;
        }

        // 2b. STRUCT / UNION body of a DUT. Members are declared with exactly the same syntax as
        // VAR-block variables (`AT %I*` direct addresses included), so the shared block parser
        // handles them; a UNION is indexed exactly like a STRUCT. This pass is *attach-only*: the
        // members are merged into the node the XML indexer already built for this file, keeping
        // that node's XML-relative ranges intact, and names already known are skipped. It can
        // therefore only ever add a missing declaration — never move, replace, or duplicate one.
        // It is what makes an unsaved edit to a DUT visible to live diagnostics.
        if (tok.type === TokenType.Keyword && (valUpper === 'STRUCT' || valUpper === 'UNION')) {
            const { vars, nextIndex } = parseVariablesBlock(tokens, idx + 1, valUpper);
            idx = nextIndex;
            if (pouNode) {
                const known = new Set(pouNode.variables.map(v => v.name.toLowerCase()));
                for (const v of vars) {
                    const lower = v.name.toLowerCase();
                    if (known.has(lower)) continue;
                    known.add(lower);
                    pouNode.variables.push(v);
                }
            }
            continue;
        }

        // 3. Nested Method Declaration: METHOD Name : ReturnType
        if (tok.type === TokenType.Keyword && valUpper === 'METHOD') {
            idx = skipPouModifiers(tokens, idx + 1);   // `METHOD PUBLIC Cyclic : BOOL`

            if (idx < tokens.length && tokens[idx].type === TokenType.Identifier) {
                const methodName = tokens[idx].value;
                const nameTok = tokens[idx];
                idx++;

                currentMethod = {
                    name: methodName,
                    variables: [],
                    returnType: 'BOOL',
                    declRange: {
                        startLine: tok.line,
                        startCol: tok.col,
                        endLine: tok.line,
                        endCol: tok.col
                    },
                    nameRange: {
                        startLine: nameTok.line,
                        startCol: nameTok.col,
                        endLine: nameTok.line,
                        endCol: nameTok.col + methodName.length
                    },
                    implRange: null
                };

                // Find return type. It is the type expression after ':' on the METHOD line and may
                // span multiple tokens/keywords (e.g. "POINTER TO INT", "ARRAY [1..3] OF REAL").
                while (idx < tokens.length) {
                    const checkTok = tokens[idx];
                    if (checkTok.type === TokenType.Punctuation && checkTok.value === ':') {
                        idx++;
                        while (idx < tokens.length && isSkippable(tokens[idx])) {
                            idx++;
                        }
                        const typeLine = idx < tokens.length ? tokens[idx].line : checkTok.line;
                        let retType = '';
                        while (idx < tokens.length) {
                            const t = tokens[idx];
                            if (isSkippable(t)) { idx++; continue; }
                            // Stop at the declaration body or the next line.
                            if (t.type === TokenType.Keyword && t.value.toUpperCase().startsWith('VAR')) break;
                            if (t.type === TokenType.Punctuation && t.value === ';') { idx++; break; }
                            if (t.line !== typeLine) break;
                            retType += t.value + ' ';
                            idx++;
                        }
                        currentMethod.returnType = retType.trim().replace(/\s+/g, ' ');
                        break;
                    }
                    if (checkTok.type === TokenType.Keyword && checkTok.value.toUpperCase().startsWith('VAR')) {
                        break;
                    }
                    idx++;
                }

                if (pouNode) {
                    const existingMethodIdx = pouNode.methods.findIndex(m => m.name.toLowerCase() === currentMethod.name.toLowerCase());
                    if (existingMethodIdx !== -1) {
                        pouNode.methods[existingMethodIdx] = currentMethod;
                    } else {
                        pouNode.methods.push(currentMethod);
                    }
                }
            }
            continue;
        }

        // 4. Nested Property Declaration: PROPERTY Name : Type
        if (tok.type === TokenType.Keyword && valUpper === 'PROPERTY') {
            idx = skipPouModifiers(tokens, idx + 1);   // `PROPERTY PUBLIC bIsExtended : BOOL`

            if (idx < tokens.length && tokens[idx].type === TokenType.Identifier) {
                const propName = tokens[idx].value;
                const nameTok = tokens[idx];
                idx++;

                // Parse the property type expression after ':' on the PROPERTY line.
                let propType = 'BOOL';
                let scan = idx;
                while (scan < tokens.length && tokens[scan].line === nameTok.line) {
                    const ct = tokens[scan];
                    if (ct.type === TokenType.Punctuation && ct.value === ':') {
                        scan++;
                        while (scan < tokens.length && isSkippable(tokens[scan])) scan++;
                        const typeLine = scan < tokens.length ? tokens[scan].line : nameTok.line;
                        let collected = '';
                        while (scan < tokens.length && tokens[scan].line === typeLine) {
                            const tt = tokens[scan];
                            if (isSkippable(tt)) { scan++; continue; }
                            collected += tt.value + ' ';
                            scan++;
                        }
                        if (collected.trim()) propType = collected.trim().replace(/\s+/g, ' ');
                        break;
                    }
                    scan++;
                }

                currentProperty = {
                    name: propName,
                    type: propType,
                    declRange: {
                        startLine: tok.line,
                        startCol: tok.col,
                        endLine: tok.line,
                        endCol: tok.col
                    },
                    nameRange: {
                        startLine: nameTok.line,
                        startCol: nameTok.col,
                        endLine: nameTok.line,
                        endCol: nameTok.col + propName.length
                    },
                    getAccessor: null,
                    setAccessor: null
                };

                if (pouNode) {
                    const existingPropIdx = pouNode.properties.findIndex(p => p.name.toLowerCase() === currentProperty.name.toLowerCase());
                    if (existingPropIdx !== -1) {
                        pouNode.properties[existingPropIdx] = currentProperty;
                    } else {
                        pouNode.properties.push(currentProperty);
                    }
                }
            }
            continue;
        }

        // 5. Nested GET / SET inside properties
        //
        // GET and SET are only accessors when they stand at the head of a declaration inside a
        // PROPERTY. They are ordinary identifiers everywhere else, and TwinCAT code calls methods
        // named Get and Set all the time — `fbQueue.Get(Item := n)` on a Tc3 FB_Queue, for instance.
        //
        // Without this guard that call was read as the start of a property accessor, and the loop
        // below then scanned forward for an END_GET that never comes, swallowing the rest of the
        // method (its END_METHOD included) and every method after it until it happened to find one.
        // In one real FB this ate 24 of its 44 methods: every variable inside them became invisible,
        // so Find References could not resolve them and — keeping whatever it cannot resolve — listed
        // every same-named variable in the project. It also silently broke completion, diagnostics and
        // Go to Definition inside those methods.
        const prevMeaningful = (() => {
            for (let i = idx - 1; i >= 0; i--) {
                if (!isSkippable(tokens[i])) return tokens[i];
            }
            return null;
        })();
        const isAccessorHead = currentProperty && !currentMethod
            && !(prevMeaningful && prevMeaningful.type === TokenType.Punctuation && prevMeaningful.value === '.');

        if (tok.type === TokenType.Keyword && (valUpper === 'GET' || valUpper === 'SET') && isAccessorHead) {
            const isGet = valUpper === 'GET';
            const accessor = {
                type: valUpper,
                declRange: {
                    startLine: tok.line,
                    startCol: tok.col,
                    endLine: tok.line,
                    endCol: tok.col + valUpper.length
                },
                implRange: null
            };

            idx++;

            // Trace implementation text block until END_GET / END_SET
            const startLine = tok.line + 1;
            while (idx < tokens.length) {
                const nextTok = tokens[idx];
                const upperVal = nextTok.value.toUpperCase();
                if (nextTok.type === TokenType.Keyword && (upperVal === 'END_GET' || upperVal === 'END_SET')) {
                    accessor.implRange = {
                        startLine: startLine,
                        startCol: 1,
                        endLine: nextTok.line - 1,
                        endCol: 80
                    };
                    idx++;
                    break;
                }
                idx++;
            }

            if (currentProperty) {
                if (isGet) currentProperty.getAccessor = accessor;
                else currentProperty.setAccessor = accessor;
            }
            continue;
        }

        // 6. Nested Action Declaration: ACTION Name
        if (tok.type === TokenType.Keyword && valUpper === 'ACTION') {
            idx = skipPouModifiers(tokens, idx + 1);

            if (idx < tokens.length && tokens[idx].type === TokenType.Identifier) {
                const actionName = tokens[idx].value;
                const nameTok = tokens[idx];
                idx++;

                const action = {
                    name: actionName,
                    nameRange: {
                        startLine: nameTok.line,
                        startCol: nameTok.col,
                        endLine: nameTok.line,
                        endCol: nameTok.col + actionName.length
                    },
                    implRange: null
                };

                const startLine = tok.line + 1;
                while (idx < tokens.length) {
                    const nextTok = tokens[idx];
                    if (nextTok.type === TokenType.Keyword && nextTok.value.toUpperCase() === 'END_ACTION') {
                        action.implRange = {
                            startLine: startLine,
                            startCol: 1,
                            endLine: nextTok.line - 1,
                            endCol: 80
                        };
                        idx++;
                        break;
                    }
                    idx++;
                }

                if (pouNode) {
                    const existingActionIdx = pouNode.actions.findIndex(a => a.name.toLowerCase() === action.name.toLowerCase());
                    if (existingActionIdx !== -1) {
                        pouNode.actions[existingActionIdx] = action;
                    } else {
                        pouNode.actions.push(action);
                    }
                }
            }
            continue;
        }

        // 7. Ends: END_METHOD, END_PROPERTY, END_FUNCTION_BLOCK, END_PROGRAM, END_FUNCTION
        if (tok.type === TokenType.Keyword && valUpper === 'END_METHOD') {
            if (currentMethod) {
                currentMethod.declRange.endLine = tok.line;
                currentMethod.declRange.endCol = tok.col + 10;
                currentMethod = null;
            }
            idx++;
            continue;
        }

        if (tok.type === TokenType.Keyword && valUpper === 'END_PROPERTY') {
            currentProperty = null;
            idx++;
            continue;
        }

        if (tok.type === TokenType.Keyword && ['END_FUNCTION_BLOCK', 'END_PROGRAM', 'END_FUNCTION', 'END_INTERFACE'].includes(valUpper)) {
            if (pouNode) {
                pouNode.range.endLine = tok.line;
                pouNode.range.endCol = tok.col + valUpper.length;
                pouNode = null;
            }
            idx++;
            continue;
        }
        idx++;
    }

    if (pouNode) {
        const lastTok = tokens[tokens.length - 1];
        if (lastTok) {
            pouNode.range.endLine = lastTok.line;
            pouNode.range.endCol = lastTok.col + lastTok.value.length;
        }
    }
    if (currentMethod) {
        const lastTok = tokens[tokens.length - 1];
        if (lastTok) {
            currentMethod.declRange.endLine = lastTok.line;
            currentMethod.declRange.endCol = lastTok.col + lastTok.value.length;
        }
    }
    if (currentProperty) {
        const lastTok = tokens[tokens.length - 1];
        if (lastTok) {
            currentProperty.declRange.endLine = lastTok.line;
            currentProperty.declRange.endCol = lastTok.col + lastTok.value.length;
        }
    }

    // Secondary pass to determine POU / Method implementation ranges
    // Typically, the implementation is the code *after* declarations and variables, up to the END block
    // Since our parser is simplified, we'll locate implementation body ranges dynamically when needed.
}

/**
 * Scans directories recursively for standalone .st files to index. The generated-export folder
 * (ST_Files) is skipped: those are derived from the XML objects and would shadow them in the index.
 * @param {string} dirPath Absolute folder path.
 */
function indexStDirectory(dirPath, index = workspaceSymbolIndex) {
    if (!fs.existsSync(dirPath)) return;
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.vscode' || entry.name === 'ST_Files') {
                continue;
            }
            indexStDirectory(fullPath, index);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.st')) {
            try {
                const code = fs.readFileSync(fullPath, 'utf8');
                const fileUri = 'file:///' + fullPath.replace(/\\/g, '/');
                parseAndIndexDocument(code, fileUri, index);
            } catch (err) {
                console.error(`Failed to parse and index ${entry.name}:`, err);
            }
        }
    }
}

module.exports = {
    TokenType,
    isSkippable,
    isBlockEnd,
    tokenize,
    parseVariablesBlock,
    parseAndIndexDocument,
    indexStDirectory,
    getWorkspaceSymbolIndex,
    clearWorkspaceIndex
};
