/**
 * @file stConverter.js
 * @description Translates TwinCAT XML structures into clean, pure Structured Text (.st) files
 * and maps diagnostics back to Monaco editor relative line numbers.
 */

/**
 * When true, cleanDeclarationText/cleanImplementationText pass text through verbatim.
 * Used by the live LSP path so the generated lineMap aligns 1:1 with the raw editor content.
 * Safe as a module flag because convertXmlToSt is fully synchronous.
 */
let RAW_MODE = false;

/**
 * Converts a parsed TwinCAT XML object into standard Structured Text.
 * @param {Object} parsedXml The parsed object from parseTwinCatXml.
 * @param {Object} [options] { raw: boolean } — when raw, declarations/implementations are not
 *   cleaned, so line counts match the editor exactly (for diagnostics mapping).
 * @returns {Object} { stText: string, lineMap: Object }
 */
function convertXmlToSt(parsedXml, options = {}) {
    RAW_MODE = !!options.raw;
    const lines = [];
    const lineMap = {};

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
        return { stText: lines.join('\n'), lineMap };
    }

    // GVL / DUT / Itf / POU
    if (parsedXml.rootType === 'POU') {
        const subComponents = parsedXml.components.filter(c => c.id !== 'root');
        const hasMethods = subComponents.some(c => c.type === 'Method');
        
        let decl = root.declaration || '';
        if (hasMethods && /\bPROGRAM\b/i.test(decl)) {
            // Replace PROGRAM with FUNCTION_BLOCK to compile methods correctly in trust-runtime
            decl = decl.replace(/\bPROGRAM\b/gi, 'FUNCTION_BLOCK');
        }

        // Main POU Declaration
        const declStart = getLineCount() + 1;
        append(cleanDeclarationText(decl));
        const declEnd = getLineCount();

        append(``);

        // Main POU Implementation
        const implStart = getLineCount() + 1;
        append(cleanImplementationText(root.implementation || ''));
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
                    append(cleanDeclarationText(comp.declaration || ''));
                    const endDecl = getLineCount();

                    append(``);

                    const startImpl = getLineCount() + 1;
                    append(cleanImplementationText(comp.implementation || ''));
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
                    append(cleanImplementationText(comp.implementation || ''));
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
                    append(cleanDeclarationText(propSignature ? (propSignature.declaration || '') : `PROPERTY ${propName} : INT`));
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
                            const cleanedDecl = cleanDeclarationText(propGet.declaration);
                            if (cleanedDecl.replace(/\s/g, '') !== 'VAREND_VAR' && cleanedDecl.trim() !== '') {
                                append(cleanedDecl);
                            }
                        }
                        const getDeclEnd = getLineCount();

                        append(``);

                        const getImplStart = getLineCount() + 1;
                        append(cleanImplementationText(propGet.implementation || ''));
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
                            const cleanedDecl = cleanDeclarationText(propSet.declaration);
                            if (cleanedDecl.replace(/\s/g, '') !== 'VAREND_VAR' && cleanedDecl.trim() !== '') {
                                append(cleanedDecl);
                            }
                        }
                        const setDeclEnd = getLineCount();

                        append(``);

                        const setImplStart = getLineCount() + 1;
                        append(cleanImplementationText(propSet.implementation || ''));
                        const setImplEnd = getLineCount();

                        append(`END_SET`);

                        lineMap[propSet.id] = {
                            decl: { start: setDeclStart, end: setDeclEnd },
                            impl: { start: setImplStart, end: setImplEnd }
                        };
                    }

                    append(`END_PROPERTY`);
                    append(``);
                }
            }
        }

        // Append closing POU keyword (END_FUNCTION_BLOCK, END_PROGRAM, or END_FUNCTION)
        let closingKeyword = '';
        const rootDecl = decl;
        if (/\bFUNCTION_BLOCK\b/i.test(rootDecl)) {
            closingKeyword = 'END_FUNCTION_BLOCK';
        } else if (/\bPROGRAM\b/i.test(rootDecl)) {
            closingKeyword = 'END_PROGRAM';
        } else if (/\bFUNCTION\b/i.test(rootDecl)) {
            closingKeyword = 'END_FUNCTION';
        }

        if (closingKeyword) {
            append(closingKeyword);
            append(``);
        }
    } else if (parsedXml.rootType === 'Itf') {
        // Interface Definition
        const declStart = getLineCount() + 1;
        append(cleanDeclarationText(root.declaration || ''));
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
                append(cleanDeclarationText(decl));
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
                append(cleanDeclarationText(decl));
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
        append(cleanDeclarationText(root.declaration || ''));
        const declEnd = getLineCount();

        lineMap['root'] = {
            decl: { start: declStart, end: declEnd },
            impl: { start: 0, end: 0 }
        };
    }

    return {
        stText: lines.join('\n'),
        lineMap
    };
}

/**
 * Maps standard VS Code diagnostics for a combined .st file to relative editor components.
 * @param {Array<Object>} diagnostics The diagnostics array from VS Code.
 * @param {Object} lineMap The line offset mapping dictionary.
 * @returns {Array<Object>} List of mapped diagnostics with target componentId, pane, and Monaco range.
 */
function mapDiagnosticsToMonaco(diagnostics, lineMap) {
    const mapped = [];

    for (const diag of diagnostics) {
        // VS Code line numbers are 0-indexed, translate to 1-indexed.
        const line = diag.range.start.line + 1;
        const endLine = diag.range.end.line + 1;

        for (const [componentId, blocks] of Object.entries(lineMap)) {
            // Check declaration block
            if (blocks.decl && line >= blocks.decl.start && line <= blocks.decl.end) {
                const relativeStartLine = line - blocks.decl.start + 1;
                const relativeEndLine = endLine - blocks.decl.start + 1;

                mapped.push({
                    componentId,
                    pane: 'declaration',
                    severity: diag.severity,
                    message: diag.message,
                    range: {
                        startLineNumber: relativeStartLine,
                        startColumn: diag.range.start.character + 1,
                        endLineNumber: relativeEndLine,
                        endColumn: diag.range.end.character + 1
                    }
                });
                break;
            }
            // Check implementation block
            if (blocks.impl && line >= blocks.impl.start && line <= blocks.impl.end) {
                const relativeStartLine = line - blocks.impl.start + 1;
                const relativeEndLine = endLine - blocks.impl.start + 1;

                mapped.push({
                    componentId,
                    pane: 'implementation',
                    severity: diag.severity,
                    message: diag.message,
                    range: {
                        startLineNumber: relativeStartLine,
                        startColumn: diag.range.start.character + 1,
                        endLineNumber: relativeEndLine,
                        endColumn: diag.range.end.character + 1
                    }
                });
                break;
            }
        }
    }

    return mapped;
}

/**
 * Cleans TwinCAT-specific syntax elements from Structured Text declarations
 * to make them fully compliant with standard IEC 61131-3 compilers.
 * @param {string} declText Original declaration text.
 * @returns {string} Cleaned declaration text.
 */
function cleanDeclarationText(declText) {
    if (!declText) return '';
    if (RAW_MODE) return declText;
    let text = declText;

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

    // 6. Flat struct inheritance (replace EXTENDS ParentStruct with flattened fields)
    if (/\bTYPE\s+ST_MES_Interlocking_Data\s+EXTENDS\s+ST_MES_Basic_Data\s*:/i.test(text)) {
        text = text.replace(/\bTYPE\s+ST_MES_Interlocking_Data\s+EXTENDS\s+ST_MES_Basic_Data\s*:/i, 'TYPE ST_MES_Interlocking_Data :');
        text = text.replace(/\bSTRUCT\b/i, `STRUCT\n\t// Fields from ST_MES_Basic_Data\n\tsOperationNumber\t\t: STRING(15);\n\tsMaterialNumber  \t\t: STRING(15);\n\tsOperator\t\t\t\t: STRING(25);\n\tsWorkstationName \t\t: STRING(25);\n\tsOrderNumber\t\t\t: STRING(15);\n\tsTestMethodName\t\t\t: eMESTestMethodNames;\n\tsTestProgramName \t\t: STRING(50);\n\tsTestEquipmentNumber \t: STRING(15);`);
    }
    if (/\bTYPE\s+ST_MES_TestUnit_Data\s+EXTENDS\s+ST_MES_Basic_Data\s*:/i.test(text)) {
        text = text.replace(/\bTYPE\s+ST_MES_TestUnit_Data\s+EXTENDS\s+ST_MES_Basic_Data\s*:/i, 'TYPE ST_MES_TestUnit_Data :');
        text = text.replace(/\bSTRUCT\b/i, `STRUCT\n\t// Fields from ST_MES_Basic_Data\n\tsOperationNumber\t\t: STRING(15);\n\tsMaterialNumber  \t\t: STRING(15);\n\tsOperator\t\t\t\t: STRING(25);\n\tsWorkstationName \t\t: STRING(25);\n\tsOrderNumber\t\t\t: STRING(15);\n\tsTestMethodName\t\t\t: eMESTestMethodNames;\n\tsTestProgramName \t\t: STRING(50);\n\tsTestEquipmentNumber \t: STRING(15);`);
    }
    if (/\bTYPE\s+ST_AxisErrors\s+EXTENDS\s+ST_Errors\s*:/i.test(text)) {
        text = text.replace(/\bTYPE\s+ST_AxisErrors\s+EXTENDS\s+ST_Errors\s*:/i, 'TYPE ST_AxisErrors :');
        text = text.replace(/\bSTRUCT\b/i, `STRUCT\n\t// Fields from ST_Errors\n\tbError\t\t\t\t: BOOL;\n\tnExternalErrorID\t: UDINT;\n\teErrorState\t\t\t: E_error_state := E_error_state.no_error;`);
    }

    return text;
}

/**
 * Cleans TwinCAT-specific syntax elements from Structured Text implementations
 * to make them fully compliant with standard IEC 61131-3 compilers.
 * @param {string} implText Original implementation text.
 * @returns {string} Cleaned implementation text.
 */
function cleanImplementationText(implText) {
    if (!implText) return '';
    if (RAW_MODE) return implText;
    let text = implText;
    
    // Translate REF= to :=
    text = text.replace(/\bREF\s*=\s*/g, ':= ');

    // Translate short-circuit logical operators
    text = text.replace(/\bAND_THEN\b/gi, 'AND');
    text = text.replace(/\bOR_ELSE\b/gi, 'OR');

    // Rewrite fbMCPower calls with Override keyword to use positional argument passing
    text = text.replace(/fbMCPower\s*\(\s*Axis\s*:=\s*([a-zA-Z0-9_]+)\s*,\s*Override\s*:=\s*([a-zA-Z0-9_]+)\s*,\s*Busy\s*=>\s*([\s\S]*?)\)/gi, (match, axis, override, rest) => {
        return `fbMCPower(\n\t${axis},\n\tfbMCPower.Enable,\n\tfbMCPower.Enable_Positive,\n\tfbMCPower.Enable_Negative,\n\t${override},\n\tBusy => ${rest.trim()})`;
    });

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
    mapDiagnosticsToMonaco
};
