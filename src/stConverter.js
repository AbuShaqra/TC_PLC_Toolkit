/**
 * @file stConverter.js
 * @description Translates TwinCAT XML structures into Structured Text: clean portable .st output,
 * or a raw 1:1 unit for the live path (diagnostics mapping lives in livePath.js).
 */

/** Matches one struct DUT head and body: `TYPE Name [EXTENDS Base] : STRUCT … END_STRUCT`. */
const STRUCT_DEF_RE = /\bTYPE\s+([A-Za-z_]\w*)\s*(?:EXTENDS\s+([A-Za-z_][\w.]*)\s*)?:\s*STRUCT\b([\s\S]*?)\bEND_STRUCT\b/gi;

/**
 * @typedef {{ name: string, base: string|null, body: string }} StructDef
 * @typedef {Map<string, StructDef>} StructRegistry Keyed by the lower-cased struct name (ST is
 *   case-insensitive).
 */

/**
 * Collects every struct definition (`TYPE X [EXTENDS Y] : STRUCT … END_STRUCT`) from the given
 * parsed TwinCAT files, so portable output can flatten struct inheritance from the project's OWN
 * types instead of from any hard-coded list. Pass every file of one PLC project; types are
 * project-scoped, so a registry must not mix projects.
 * @param {Array<Object|null|undefined>} parsedFiles Results of parseTwinCatXml.
 * @param {StructRegistry} [into] Registry to add to (a new one when absent).
 * @returns {StructRegistry}
 */
function collectStructDefinitions(parsedFiles, into) {
    const registry = into || new Map();
    for (const parsed of parsedFiles || []) {
        if (!parsed || !Array.isArray(parsed.components)) continue;
        for (const comp of parsed.components) {
            const decl = comp && comp.declaration;
            if (!decl) continue;
            STRUCT_DEF_RE.lastIndex = 0;
            let m;
            while ((m = STRUCT_DEF_RE.exec(decl)) !== null) {
                const key = m[1].toLowerCase();
                // First definition wins: a duplicate name is a project error we must not paper over
                // by silently picking whichever file happened to be read last.
                if (!registry.has(key)) registry.set(key, { name: m[1], base: m[2] || null, body: m[3] });
            }
        }
    }
    return registry;
}

/**
 * The inherited field text for a struct whose base is `baseName`: each ancestor's body, root-most
 * first, under a `// Fields from <Ancestor>` comment. Returns null unless the WHOLE chain resolves
 * in the registry — a partially known chain (e.g. a base from a library) would produce a struct
 * that silently lacks fields, so it is left untouched instead.
 * @param {string} baseName
 * @param {StructRegistry} registry
 * @returns {string|null}
 */
function inheritedFieldsText(baseName, registry) {
    const chain = [];
    const seen = new Set();
    let current = baseName;
    while (current) {
        const key = current.toLowerCase();
        if (seen.has(key)) return null; // EXTENDS cycle: not a valid project, do not rewrite
        seen.add(key);
        const def = registry.get(key);
        if (!def) return null;
        chain.unshift(def);
        current = def.base;
    }
    return chain.map(def => `\n\t// Fields from ${def.name}${def.body.replace(/\s+$/, '')}`).join('');
}

/**
 * Portable-output rewrite: a standard IEC 61131-3 compiler cannot resolve struct EXTENDS, so the
 * base's fields are flattened into the struct, using definitions parsed from the project itself.
 * Applied only in clean (non-raw) mode; never shapes the live editor path.
 * @param {string} text Declaration text.
 * @param {StructRegistry} registry
 * @returns {string}
 */
function flattenStructInheritance(text, registry) {
    if (!registry || registry.size === 0) return text;
    return text.replace(
        /\b(TYPE\s+[A-Za-z_]\w*)\s+EXTENDS\s+([A-Za-z_][\w.]*)(\s*:\s*STRUCT\b)/gi,
        (match, head, baseName, structKw) => {
            const fields = inheritedFieldsText(baseName, registry);
            return fields === null ? match : `${head}${structKw}${fields}`;
        });
}

/**
 * Converts a parsed TwinCAT XML object into standard Structured Text.
 * @param {Object} parsedXml The parsed object from parseTwinCatXml.
 * @param {Object} [options] { raw: boolean, structs: StructRegistry } — when raw,
 *   declarations/implementations are not cleaned, so line counts match the editor exactly (for
 *   diagnostics mapping). `structs` (from collectStructDefinitions over the whole project) lets the
 *   clean output flatten struct EXTENDS across files; this file's own structs are always added.
 * @returns {{ stText: string, lineMap: Object, warnings: string[] }} `warnings` names every member
 *   that could not be converted (today: SFC transitions), one human-readable line each, so a caller
 *   can tell the user what the output is missing. Raw mode reports them too but never adds text.
 */
function convertXmlToSt(parsedXml, options = {}) {
    const raw = !!options.raw;
    const structs = raw ? null : collectStructDefinitions([parsedXml], new Map(options.structs || []));
    const lines = [];
    const lineMap = {};
    /** @type {string[]} */
    const warnings = [];

    function append(text) {
        if (text === null || text === undefined) return;
        const parts = text.split(/\r?\n/);
        lines.push(...parts);
    }

    function getLineCount() {
        return lines.length;
    }

    // 1. Add generated header
    append(`// ==============================================================================`);
    append(`// ${parsedXml.rootName || 'Unnamed'} - Structured Text (ST) Code File`);
    append(`// Generated clean version stripping XML wrappers and TwinCAT-specific schemas`);
    append(`// ==============================================================================`);
    append(``);

    const root = parsedXml.components.find(c => c.id === 'root');
    if (!root) {
        return { stText: lines.join('\n'), lineMap, warnings };
    }

    // GVL / DUT / Itf / POU
    if (parsedXml.rootType === 'POU') {
        const subComponents = parsedXml.components.filter(c => c.id !== 'root');
        // The POU kind is kept as written: TwinCAT keeps a PROGRAM with METHODs a PROGRAM (its
        // methods are called without an instance, `MAIN.Init()`), and so does every converter path.
        const decl = root.declaration || '';

        // Main POU Declaration
        const declStart = getLineCount() + 1;
        append(cleanDeclarationText(decl, raw, structs));
        const declEnd = getLineCount();

        append(``);

        // Main POU Implementation
        const implStart = getLineCount() + 1;
        append(cleanImplementationText(root.implementation || '', raw));
        const implEnd = getLineCount();

        lineMap['root'] = {
            decl: { start: declStart, end: declEnd },
            impl: { start: implStart, end: implEnd }
        };

        append(``);

        // Append Sub-components (Methods, Properties, Actions)
        if (subComponents.length > 0) {
            append(`// ==========================================`);
            append(`// SUB-COMPONENTS (METHODS, PROPERTIES, ACTIONS)`);
            append(`// ==========================================`);
            append(``);

            const processedProperties = new Set();

            for (const comp of subComponents) {
                if (comp.type === 'Method') {
                    const startDecl = getLineCount() + 1;
                    append(cleanDeclarationText(comp.declaration || '', raw, structs));
                    const endDecl = getLineCount();

                    append(``);

                    const startImpl = getLineCount() + 1;
                    append(cleanImplementationText(comp.implementation || '', raw));
                    const endImpl = getLineCount();

                    append(`END_METHOD`);
                    append(``);

                    lineMap[comp.id] = {
                        decl: { start: startDecl, end: endDecl },
                        impl: { start: startImpl, end: endImpl }
                    };
                } else if (comp.type === 'Action') {
                    const startDecl = getLineCount() + 1;
                    append(`ACTION ${comp.name}`);
                    const endDecl = getLineCount();

                    append(``);

                    const startImpl = getLineCount() + 1;
                    append(cleanImplementationText(comp.implementation || '', raw));
                    const endImpl = getLineCount();

                    append(`END_ACTION`);
                    append(``);

                    lineMap[comp.id] = {
                        decl: { start: startDecl, end: endDecl },
                        impl: { start: startImpl, end: endImpl }
                    };
                } else if (comp.type === 'Property' || comp.type === 'Get' || comp.type === 'Set') {
                    const propName = comp.xmlContext.subName;
                    if (processedProperties.has(propName)) continue;
                    processedProperties.add(propName);

                    const propSignature = subComponents.find(c => c.type === 'Property' && c.xmlContext.subName === propName);
                    const propGet = subComponents.find(c => c.type === 'Get' && c.xmlContext.subName === propName);
                    const propSet = subComponents.find(c => c.type === 'Set' && c.xmlContext.subName === propName);

                    const startDecl = getLineCount() + 1;
                    append(cleanDeclarationText(propSignature ? (propSignature.declaration || '') : `PROPERTY ${propName} : INT`, raw, structs));
                    const endDecl = getLineCount();

                    if (propSignature) {
                        lineMap[propSignature.id] = {
                            decl: { start: startDecl, end: endDecl },
                            impl: { start: 0, end: 0 }
                        };
                    }

                    if (propGet) {
                        const getDeclStart = getLineCount() + 1;
                        append(`GET`);
                        if (propGet.declaration) {
                            const cleanedDecl = cleanDeclarationText(propGet.declaration, raw, structs);
                            if (cleanedDecl.replace(/\s/g, '') !== 'VAREND_VAR' && cleanedDecl.trim() !== '') {
                                append(cleanedDecl);
                            }
                        }
                        const getDeclEnd = getLineCount();

                        append(``);

                        const getImplStart = getLineCount() + 1;
                        append(cleanImplementationText(propGet.implementation || '', raw));
                        const getImplEnd = getLineCount();

                        append(`END_GET`);

                        lineMap[propGet.id] = {
                            decl: { start: getDeclStart, end: getDeclEnd },
                            impl: { start: getImplStart, end: getImplEnd }
                        };
                    }

                    if (propSet) {
                        const setDeclStart = getLineCount() + 1;
                        append(`SET`);
                        if (propSet.declaration) {
                            const cleanedDecl = cleanDeclarationText(propSet.declaration, raw, structs);
                            if (cleanedDecl.replace(/\s/g, '') !== 'VAREND_VAR' && cleanedDecl.trim() !== '') {
                                append(cleanedDecl);
                            }
                        }
                        const setDeclEnd = getLineCount();

                        append(``);

                        const setImplStart = getLineCount() + 1;
                        append(cleanImplementationText(propSet.implementation || '', raw));
                        const setImplEnd = getLineCount();

                        append(`END_SET`);

                        lineMap[propSet.id] = {
                            decl: { start: setDeclStart, end: setDeclEnd },
                            impl: { start: setImplStart, end: setImplEnd }
                        };
                    }

                    append(`END_PROPERTY`);
                    append(``);
                } else if (comp.type === 'Transition') {
                    // An SFC transition is a condition attached to a chart step; a single ST unit
                    // has nowhere to put it. Say so rather than drop it silently. The export gets
                    // a marker comment (appended like any other line, so the lineMap stays exact);
                    // the raw live unit gets nothing, since every line of it must map to a pane.
                    const warning = `Transition '${comp.name}' of '${parsedXml.rootName || 'Unnamed'}' is not exported: ` +
                        'transitions have no Structured Text equivalent in a single compilation unit';
                    warnings.push(warning);
                    if (!raw) {
                        append(`// WARNING: ${warning}`);
                        append(``);
                    }
                }
            }
        }

        // Append closing POU keyword (END_FUNCTION_BLOCK, END_PROGRAM, or END_FUNCTION)
        const pouKind = leadingPouKeyword(decl);
        const closingKeyword = pouKind ? `END_${pouKind}` : '';

        if (closingKeyword) {
            append(closingKeyword);
            append(``);
        }
    } else if (parsedXml.rootType === 'Itf') {
        // Interface Definition
        const declStart = getLineCount() + 1;
        append(cleanDeclarationText(root.declaration || '', raw, structs));
        const declEnd = getLineCount();

        lineMap['root'] = {
            decl: { start: declStart, end: declEnd },
            impl: { start: 0, end: 0 }
        };

        append(``);

        const subComponents = parsedXml.components.filter(c => c.id !== 'root');
        const processedProperties = new Set();

        for (const comp of subComponents) {
            if (comp.type === 'Method') {
                const startDecl = getLineCount() + 1;
                let decl = comp.declaration || '';
                append(cleanDeclarationText(decl, raw, structs));
                append(`END_METHOD`);
                const endDecl = getLineCount();
                append(``);

                lineMap[comp.id] = {
                    decl: { start: startDecl, end: endDecl },
                    impl: { start: 0, end: 0 }
                };
            } else if (comp.type === 'Property' || comp.type === 'Get' || comp.type === 'Set') {
                const propName = comp.xmlContext.subName;
                if (processedProperties.has(propName)) continue;
                processedProperties.add(propName);

                const propSignature = subComponents.find(c => c.type === 'Property' && c.xmlContext.subName === propName);

                const startDecl = getLineCount() + 1;
                let decl = propSignature ? (propSignature.declaration || '') : `PROPERTY ${propName} : INT`;
                append(cleanDeclarationText(decl, raw, structs));
                append(`END_PROPERTY`);
                const endDecl = getLineCount();

                if (propSignature) {
                    lineMap[propSignature.id] = {
                        decl: { start: startDecl, end: endDecl },
                        impl: { start: 0, end: 0 }
                    };
                }
                append(``);
            }
        }

        append(`END_INTERFACE`);
        append(``);
    } else if (parsedXml.rootType === 'GVL' || parsedXml.rootType === 'DUT') {
        // GVL or DUT
        const declStart = getLineCount() + 1;
        append(cleanDeclarationText(root.declaration || '', raw, structs));
        const declEnd = getLineCount();

        lineMap['root'] = {
            decl: { start: declStart, end: declEnd },
            impl: { start: 0, end: 0 }
        };
    }

    return {
        stText: lines.join('\n'),
        lineMap,
        warnings
    };
}

/**
 * The POU keyword that opens a root declaration — the first of FUNCTION_BLOCK / PROGRAM / FUNCTION
 * outside comments and pragmas — so a PROGRAM whose comment mentions FUNCTION_BLOCK still closes
 * with END_PROGRAM.
 * @param {string} declText Root declaration text.
 * @returns {'FUNCTION_BLOCK'|'PROGRAM'|'FUNCTION'|null}
 */
function leadingPouKeyword(declText) {
    const code = (declText || '')
        .replace(/\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|\/\/[^\n]*|\{[^}]*\}/g, ' ');
    const m = /\b(FUNCTION_BLOCK|PROGRAM|FUNCTION)\b/i.exec(code);
    return m ? /** @type {'FUNCTION_BLOCK'|'PROGRAM'|'FUNCTION'} */ (m[1].toUpperCase()) : null;
}

/**
 * Cleans TwinCAT-specific syntax elements from Structured Text declarations
 * to make them fully compliant with standard IEC 61131-3 compilers.
 * @param {string} declText Original declaration text.
 * @param {boolean} [raw] When true, pass declText through verbatim (used by the live LSP path so
 *   the generated lineMap aligns 1:1 with the raw editor content).
 * @param {StructRegistry|null} [structs] Struct definitions for flattening EXTENDS.
 * @returns {string} Cleaned declaration text.
 */
function cleanDeclarationText(declText, raw, structs) {
    if (!declText) return '';
    if (raw) return declText;
    // Flatten first, so the inherited fields pass through the same cleaning as the struct's own.
    let text = flattenStructInheritance(declText, structs || null);

    // Strip access modifiers (PUBLIC, PROTECTED, PRIVATE, INTERNAL) globally
    text = text.replace(/\b(?:PUBLIC|PROTECTED|PRIVATE|INTERNAL)\b\s*/gi, '');

    // 1. Strip FB instantiation parameters (e.g. fb : FB_Type(param := val);)
    // Matches: : TypeName(params); but ignores STRING(80);
    text = text.replace(/:\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\(([^)]+)\)\s*;/g, (match, typeName, params) => {
        const upper = typeName.toUpperCase();
        if (upper === 'STRING' || upper === 'WSTRING') {
            return match;
        }
        return `: ${typeName};`;
    });

    // 2. Strip trailing commas inside standard parameter lists or enums
    text = text.replace(/,\s*\)/g, ')');

    // 3. Replace VAR_INST with VAR (for compatibility with standard compilers)
    text = text.replace(/\bVAR_INST\b/g, 'VAR');

    // 4. Replace REFERENCE TO with POINTER TO (standard IEC 61131-3 compatibility)
    text = text.replace(/\bREFERENCE\s+TO\b/gi, 'POINTER TO');

    // 5. Convert implicit enums to INT and declare their elements as CONSTANT
    const implicitEnumRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\(([^)]+)\)\s*(?::=\s*[^;]+)?\s*;/g;
    const enumConstants = [];
    text = text.replace(implicitEnumRegex, (match, varName, elementsStr, offset) => {
        const prefix = text.substring(0, offset);
        const isTypeDecl = /\bTYPE\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*$/i.test(prefix);
        if (isTypeDecl) {
            return match;
        }

        const parts = elementsStr.split(',');
        let lastVal = 0;
        for (let part of parts) {
            part = part.trim();
            if (!part) continue;
            const eqIdx = part.indexOf(':=');
            let name = part;
            let val = lastVal;
            if (eqIdx !== -1) {
                name = part.substring(0, eqIdx).trim();
                val = parseInt(part.substring(eqIdx + 2).trim(), 10);
                if (isNaN(val)) val = lastVal;
            }
            enumConstants.push({ name, val });
            lastVal = val + 1;
        }

        return `${varName} : INT;`;
    });

    if (enumConstants.length > 0) {
        let constBlock = '\nVAR CONSTANT\n';
        for (const c of enumConstants) {
            constBlock += `\t${c.name} : INT := ${c.val};\n`;
        }
        constBlock += 'END_VAR\n';
        
        const lastEndVarIdx = text.lastIndexOf('END_VAR');
        if (lastEndVarIdx !== -1) {
            text = text.substring(0, lastEndVarIdx) + 'END_VAR\n' + constBlock + text.substring(lastEndVarIdx + 7);
        } else {
            text += '\n' + constBlock;
        }
    }

    return text;
}

/**
 * Cleans TwinCAT-specific syntax elements from Structured Text implementations
 * to make them fully compliant with standard IEC 61131-3 compilers.
 * @param {string} implText Original implementation text.
 * @param {boolean} [raw] When true, pass implText through verbatim (used by the live LSP path so
 *   the generated lineMap aligns 1:1 with the raw editor content).
 * @returns {string} Cleaned implementation text.
 */
function cleanImplementationText(implText, raw) {
    if (!implText) return '';
    if (raw) return implText;
    let text = implText;

    // Translate REF= to :=
    text = text.replace(/\bREF\s*=\s*/g, ':= ');

    // Translate short-circuit logical operators
    text = text.replace(/\bAND_THEN\b/gi, 'AND');
    text = text.replace(/\bOR_ELSE\b/gi, 'OR');

    // Strip empty arguments (e.g. name => ,  or  name := ,)
    text = text.replace(/\b[a-zA-Z0-9_]+\s*(?:=>|:=)\s*,/g, '');
    text = text.replace(/\b[a-zA-Z0-9_]+\s*(?:=>|:=)\s*(?=\))/g, '');
    
    // Rewrite inline assignments in FOR loops (e.g. FOR i := 0 TO limit := 100 DO -> limit := 100; FOR i := 0 TO limit DO)
    text = text.replace(/FOR\s+([a-zA-Z0-9_]+)\s*:=\s*(.*?)\s+TO\s+([a-zA-Z0-9_]+)\s*:=\s*(.*?)\s+DO/gi, '$3 := $4; FOR $1 := $2 TO $3 DO');
    
    // Clean up trailing commas before closing parenthesis
    text = text.replace(/,\s*\)/g, ')');
    
    return text;
}

module.exports = {
    convertXmlToSt,
    collectStructDefinitions
};
