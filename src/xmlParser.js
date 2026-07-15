/**
 * @file xmlParser.js
 * @description XML parsing and editing utilities for TwinCAT files (.TcPOU, .TcIO, .TcGVL, .TcDUT).
 */

const crypto = require('crypto');

/**
 * Parses XML attributes from a string.
 * @param {string} attrString The attributes string from an XML tag.
 * @returns {Object} Key-value pairs of attributes.
 */
function parseAttrs(attrString) {
    const attrs = {};
    const regex = /(\w+)="([^"]*)"/g;
    let match;
    while ((match = regex.exec(attrString)) !== null) {
        attrs[match[1]] = match[2];
    }
    return attrs;
}

/**
 * Extracts CDATA content within a given tag range.
 * @param {string} blockText The source text containing the XML blocks.
 * @param {string} startTag The opening tag (e.g., '<Declaration>').
 * @param {string} endTag The closing tag (e.g., '</Declaration>').
 * @returns {string} The text inside the CDATA wrapper, or empty string if not found.
 */
function getCdata(blockText, startTag, endTag) {
    const startTagIdx = blockText.indexOf(startTag);
    if (startTagIdx === -1) return '';
    const cdataStart = blockText.indexOf('<![CDATA[', startTagIdx + startTag.length);
    if (cdataStart === -1) return '';
    const endTagIdx = blockText.indexOf(endTag, cdataStart);
    if (endTagIdx === -1) return '';
    const cdataEnd = blockText.lastIndexOf(']]>', endTagIdx);
    if (cdataEnd === -1 || cdataEnd < cdataStart) return '';
    return blockText.substring(cdataStart + 9, cdataEnd);
}

/**
 * Parses a TwinCAT XML file content to extract its root and sub-components.
 * @param {string} xmlText TwinCAT XML file text.
 * @returns {Object|null} The parsed root type, root name, and list of components.
 */
function parseTwinCatXml(xmlText) {
    // `.TcTLEO` objects use an <EnumerationTextList> root, but their <Declaration> is an ordinary
    // `TYPE X : (…); END_TYPE` enum — i.e. a DUT in every way that matters to the language server.
    // Normalising the type here means stConverter, xmlIndexer and the webview need no special case;
    // only the close-tag lookup needs the real element name.
    const rootMatch = xmlText.match(/<(POU|GVL|DUT|Itf|EnumerationTextList)\b([^>]*)>/);
    if (!rootMatch) return null;

    const rootElement = rootMatch[1];
    const rootType = rootElement === 'EnumerationTextList' ? 'DUT' : rootElement;
    const rootAttrs = parseAttrs(rootMatch[2]);
    const rootName = rootAttrs.Name || 'Unnamed';
    const rootCloseIndex = xmlText.indexOf(`</${rootElement}>`, rootMatch.index);
    if (rootCloseIndex === -1) return null;
    
    const rootContentStart = rootMatch.index + rootMatch[0].length;
    const rootContent = xmlText.substring(rootContentStart, rootCloseIndex);
    
    const components = [];
    
    // Root Level Component
    let rootHasImpl = rootType === 'POU';
    const rootDecl = getCdata(rootContent, '<Declaration>', '</Declaration>');
    const rootImpl = rootHasImpl ? getCdata(rootContent, '<ST>', '</ST>') : null;
    
    components.push({
        id: 'root',
        type: rootType,
        name: rootName,
        folderPath: '',
        declaration: rootDecl,
        implementation: rootImpl,
        xmlContext: {
            rootType,
            subType: null,
            subName: null,
            accessorType: null
        }
    });
    
    // Search for Method, Property, Action, Transition inside rootContent
    const childRegex = /<(Method|Property|Action|Transition)\b([^>]*)>/g;
    let match;
    while ((match = childRegex.exec(rootContent)) !== null) {
        const subType = match[1];
        const subAttrs = parseAttrs(match[2]);
        const subName = subAttrs.Name || 'Unnamed';
        const folderPath = subAttrs.FolderPath || '';
        
        const closeTag = `</${subType}>`;
        const closeTagIdx = rootContent.indexOf(closeTag, match.index);
        if (closeTagIdx === -1) continue;
        
        const subBlock = rootContent.substring(match.index, closeTagIdx + closeTag.length);
        
        if (subType === 'Property') {
            const propDecl = getCdata(subBlock, '<Declaration>', '</Declaration>');
            components.push({
                id: `prop_${subName}`,
                type: 'Property',
                name: `${subName} (Property Signature)`,
                folderPath,
                declaration: propDecl,
                implementation: null,
                xmlContext: {
                    rootType,
                    subType: 'Property',
                    subName,
                    accessorType: null
                }
            });
            
            // Check Get/Set
            const getMatch = subBlock.match(/<Get\b([^>]*)>/);
            if (getMatch) {
                const getCloseIdx = subBlock.indexOf('</Get>', getMatch.index);
                if (getCloseIdx !== -1) {
                    const getBlock = subBlock.substring(getMatch.index, getCloseIdx + 6);
                    const getDecl = getCdata(getBlock, '<Declaration>', '</Declaration>');
                    const hasST = getBlock.includes('<ST>');
                    const getImpl = hasST ? getCdata(getBlock, '<ST>', '</ST>') : null;
                    
                    components.push({
                        id: `prop_${subName}_get`,
                        type: 'Get',
                        name: `${subName} [Get]`,
                        folderPath: folderPath,
                        declaration: getDecl,
                        implementation: getImpl,
                        xmlContext: {
                            rootType,
                            subType: 'Property',
                            subName,
                            accessorType: 'Get'
                        }
                    });
                }
            }
            
            const setMatch = subBlock.match(/<Set\b([^>]*)>/);
            if (setMatch) {
                const setCloseIdx = subBlock.indexOf('</Set>', setMatch.index);
                if (setCloseIdx !== -1) {
                    const setBlock = subBlock.substring(setMatch.index, setCloseIdx + 6);
                    const setDecl = getCdata(setBlock, '<Declaration>', '</Declaration>');
                    const hasST = setBlock.includes('<ST>');
                    const setImpl = hasST ? getCdata(setBlock, '<ST>', '</ST>') : null;
                    
                    components.push({
                        id: `prop_${subName}_set`,
                        type: 'Set',
                        name: `${subName} [Set]`,
                        folderPath: folderPath,
                        declaration: setDecl,
                        implementation: setImpl,
                        xmlContext: {
                            rootType,
                            subType: 'Property',
                            subName,
                            accessorType: 'Set'
                        }
                    });
                }
            }
        } else {
            // Method, Action, Transition
            const decl = getCdata(subBlock, '<Declaration>', '</Declaration>');
            const hasST = subBlock.includes('<ST>');
            const impl = hasST ? getCdata(subBlock, '<ST>', '</ST>') : null;
            
            components.push({
                id: `${subType.toLowerCase()}_${subName}`,
                type: subType,
                name: subName,
                folderPath,
                declaration: decl,
                implementation: impl,
                xmlContext: {
                    rootType,
                    subType,
                    subName,
                    accessorType: null
                }
            });
        }
    }
    
    return {
        rootType,
        rootName,
        components
    };
}

/**
 * Helper to replace the first CDATA segment in a block of text.
 * @param {string} text The block of XML text.
 * @param {string} startTag The starting tag.
 * @param {string} endTag The ending tag.
 * @param {string} newContent The new contents to put in the CDATA block.
 * @returns {string} The modified XML text.
 */
function replaceFirstCdataOccurrence(text, startTag, endTag, newContent) {
    const startTagIndex = text.indexOf(startTag);
    if (startTagIndex === -1) return text;
    
    const cdataStartIndex = text.indexOf('<![CDATA[', startTagIndex + startTag.length);
    if (cdataStartIndex === -1) return text;
    
    const endTagIndex = text.indexOf(endTag, cdataStartIndex);
    if (endTagIndex === -1) return text;
    
    const cdataEndIndex = text.lastIndexOf(']]>', endTagIndex);
    if (cdataEndIndex === -1 || cdataEndIndex < cdataStartIndex) return text;
    
    return text.substring(0, cdataStartIndex + 9) +
           newContent +
           text.substring(cdataEndIndex);
}

/**
 * Replaces the CDATA section of a component inside the XML text.
 * @param {string} xmlText The entire XML file content.
 * @param {Object} context Context metadata of the component.
 * @param {string} blockType 'Declaration' or 'Implementation'.
 * @param {string} newContent The updated structured text or variables code.
 * @returns {string} The modified XML text.
 */
function replaceComponentCdata(xmlText, context, blockType, newContent) {
    if (!context.subType) {
        // Root POU, GVL, DUT, Itf
        if (blockType === 'Declaration') {
            return replaceFirstCdataOccurrence(xmlText, '<Declaration>', '</Declaration>', newContent);
        } else {
            return replaceFirstCdataOccurrence(xmlText, '<ST>', '</ST>', newContent);
        }
    }
    
    const subType = context.subType;
    const subName = context.subName;
    const openTagRegex = new RegExp(`<${subType}\\b[^>]*Name="${subName}"[^>]*>`);
    const openTagMatch = xmlText.match(openTagRegex);
    if (!openTagMatch) return xmlText;
    
    const closeTag = `</${subType}>`;
    const closeTagIndex = xmlText.indexOf(closeTag, openTagMatch.index);
    if (closeTagIndex === -1) return xmlText;
    
    let subXml = xmlText.substring(openTagMatch.index, closeTagIndex + closeTag.length);
    
    if (subType === 'Property' && context.accessorType) {
        const accessorType = context.accessorType; // 'Get' or 'Set'
        const accOpenTagRegex = new RegExp(`<${accessorType}\\b[^>]*>`);
        const accOpenTagMatch = subXml.match(accOpenTagRegex);
        if (!accOpenTagMatch) return xmlText;
        
        const accCloseTag = `</${accessorType}>`;
        const accCloseTagIndex = subXml.indexOf(accCloseTag, accOpenTagMatch.index);
        if (accCloseTagIndex === -1) return xmlText;
        
        let accXml = subXml.substring(accOpenTagMatch.index, accCloseTagIndex + accCloseTag.length);
        let newAccXml;
        if (blockType === 'Declaration') {
            newAccXml = replaceFirstCdataOccurrence(accXml, '<Declaration>', '</Declaration>', newContent);
        } else {
            newAccXml = replaceFirstCdataOccurrence(accXml, '<ST>', '</ST>', newContent);
        }
        
        const newSubXml = subXml.substring(0, accOpenTagMatch.index) + newAccXml + subXml.substring(accCloseTagIndex + accCloseTag.length);
        return xmlText.substring(0, openTagMatch.index) + newSubXml + xmlText.substring(closeTagIndex + closeTag.length);
    } else {
        let newSubXml;
        if (blockType === 'Declaration') {
            newSubXml = replaceFirstCdataOccurrence(subXml, '<Declaration>', '</Declaration>', newContent);
        } else {
            newSubXml = replaceFirstCdataOccurrence(subXml, '<ST>', '</ST>', newContent);
        }
        return xmlText.substring(0, openTagMatch.index) + newSubXml + xmlText.substring(closeTagIndex + closeTag.length);
    }
}

/**
 * Extracts virtual folders defined in the XML.
 * @param {string} xmlText TwinCAT XML file text.
 * @returns {Array<Object>} Details of the defined folders.
 */
function getFoldersDetailedFromXml(xmlText) {
    const folders = [];
    const stack = [];
    
    const regex = /<Folder\b([^>]*)(>?)|<\/Folder>/g;
    let match;
    while ((match = regex.exec(xmlText)) !== null) {
        if (match[0] === '</Folder>') {
            if (stack.length > 0) {
                stack.pop();
            }
        } else {
            const attrsContent = match[1];
            const selfClosing = attrsContent.trim().endsWith('/');
            
            const nameMatch = attrsContent.match(/Name="([^"]*)"/);
            const folderName = nameMatch ? nameMatch[1] : '';
            
            if (folderName) {
                stack.push(folderName);
                const currentPath = stack.join('\\') + '\\';
                
                folders.push({
                    path: currentPath,
                    name: folderName,
                    startIndex: match.index,
                    length: match[0].length,
                    selfClosing: selfClosing,
                    id: (attrsContent.match(/Id="([^"]*)"/) || [])[1] || ''
                });
                
                if (selfClosing) {
                    stack.pop();
                }
            }
        }
    }
    return folders;
}

/**
 * Inserts a Folder tag inside another folder or at the POU root.
 * @param {string} xmlText The source POU XML text.
 * @param {string} parentFolderPath Parent folder path (e.g. 'Methods\\Internal\\') or empty string for root.
 * @param {string} newFolderName Name of the folder to insert.
 * @param {string} newFolderUuid UUID of the new folder.
 * @returns {string} The modified XML text.
 */
function insertFolderIntoXml(xmlText, parentFolderPath, newFolderName, newFolderUuid) {
    const newFolderTag = `<Folder Name="${newFolderName}" Id="${newFolderUuid}" />`;
    
    if (!parentFolderPath) {
        const match = xmlText.match(/<\/(POU|Itf)>/);
        if (!match) return xmlText;
        
        let indent = '';
        let scanIdx = match.index - 1;
        while (scanIdx >= 0 && (xmlText[scanIdx] === ' ' || xmlText[scanIdx] === '\t')) {
            indent = xmlText[scanIdx] + indent;
            scanIdx--;
        }
        const rootIndent = indent ? `${indent}    ` : '    ';
        return xmlText.substring(0, match.index) + `${rootIndent}${newFolderTag}\n` + xmlText.substring(match.index);
    }
    
    const folders = getFoldersDetailedFromXml(xmlText);
    const parentFolder = folders.find(f => f.path === parentFolderPath);
    if (!parentFolder) {
        const match = xmlText.match(/<\/(POU|Itf)>/);
        if (!match) return xmlText;
        return xmlText.substring(0, match.index) + `    ${newFolderTag}\n` + xmlText.substring(match.index);
    }
    
    let indent = '';
    let scanIdx = parentFolder.startIndex - 1;
    while (scanIdx >= 0 && (xmlText[scanIdx] === ' ' || xmlText[scanIdx] === '\t')) {
        indent = xmlText[scanIdx] + indent;
        scanIdx--;
    }
    
    if (parentFolder.selfClosing) {
        const replacement = `<Folder Name="${parentFolder.name}" Id="${parentFolder.id}">\n${indent}  ${newFolderTag}\n${indent}</Folder>`;
        return xmlText.substring(0, parentFolder.startIndex) + replacement + xmlText.substring(parentFolder.startIndex + parentFolder.length);
    } else {
        const insertIndex = parentFolder.startIndex + parentFolder.length;
        return xmlText.substring(0, insertIndex) + `\n${indent}  ${newFolderTag}` + xmlText.substring(insertIndex);
    }
}

/**
 * Inserts a Method, Property, or Action tag at the end of the root block.
 * @param {string} xmlText The source POU XML text.
 * @param {string} fileUri The POU file URI.
 * @param {boolean} isItf Whether the parent is an Interface (.TcIO).
 * @param {string} name Name of the component.
 * @param {string} componentType 'Method', 'Property', or 'Action'.
 * @param {string} folderPath Virtual folder path inside POU.
 * @returns {string} The modified XML text.
 */
function insertComponentIntoXml(xmlText, fileUri, isItf, name, componentType, folderPath) {
    const uuid = `{${crypto.randomUUID()}}`;
    const folderPathAttr = folderPath ? ` FolderPath="${folderPath}"` : '';
    
    let componentXml = '';
    if (componentType === 'Property') {
        const getUuid = `{${crypto.randomUUID()}}`;
        const setUuid = `{${crypto.randomUUID()}}`;
        if (isItf) {
            componentXml = `    <Property Name="${name}" Id="${uuid}"${folderPathAttr}>\n      <Declaration><![CDATA[PROPERTY ${name} : INT]]></Declaration>\n      <Get Name="Get" Id="${getUuid}">\n        <Declaration><![CDATA[]]></Declaration>\n      </Get>\n      <Set Name="Set" Id="${setUuid}">\n        <Declaration><![CDATA[]]></Declaration>\n      </Set>\n    </Property>\n`;
        } else {
            componentXml = `    <Property Name="${name}" Id="${uuid}"${folderPathAttr}>\n      <Declaration><![CDATA[PROPERTY ${name} : INT]]></Declaration>\n      <Get Name="Get" Id="${getUuid}">\n        <Declaration><![CDATA[VAR\nEND_VAR\n]]></Declaration>\n        <Implementation>\n          <ST><![CDATA[]]></ST>\n        </Implementation>\n      </Get>\n      <Set Name="Set" Id="${setUuid}">\n        <Declaration><![CDATA[VAR\nEND_VAR\n]]></Declaration>\n        <Implementation>\n          <ST><![CDATA[]]></ST>\n        </Implementation>\n      </Set>\n    </Property>\n`;
        }
    } else if (componentType === 'Action') {
        if (isItf) {
            componentXml = `    <Action Name="${name}" Id="${uuid}"${folderPathAttr}>\n    </Action>\n`;
        } else {
            componentXml = `    <Action Name="${name}" Id="${uuid}"${folderPathAttr}>\n      <Implementation>\n        <ST><![CDATA[]]></ST>\n      </Implementation>\n    </Action>\n`;
        }
    } else { // Method
        if (isItf) {
            componentXml = `    <Method Name="${name}" Id="${uuid}"${folderPathAttr}>\n      <Declaration><![CDATA[METHOD ${name} : BOOL\n]]></Declaration>\n    </Method>\n`;
        } else {
            componentXml = `    <Method Name="${name}" Id="${uuid}"${folderPathAttr}>\n      <Declaration><![CDATA[METHOD ${name} : BOOL\nVAR_INPUT\nEND_VAR\n]]></Declaration>\n      <Implementation>\n        <ST><![CDATA[]]></ST>\n      </Implementation>\n    </Method>\n`;
        }
    }

    const closeTag = isItf ? '</Itf>' : '</POU>';
    const index = xmlText.lastIndexOf(closeTag);
    if (index === -1) return xmlText;
    
    return xmlText.substring(0, index) + componentXml + xmlText.substring(index);
}

/**
 * Deletes a component block (or specific accessor) and its matching LineIds.
 * @param {string} xmlText POU XML text.
 * @param {string} rootName Root POU/Interface name.
 * @param {string} componentType 'Method', 'Property', 'Action', 'Transition'.
 * @param {string} componentName Name of the component to delete.
 * @param {string|null} accessorType 'Get' or 'Set' if deleting only an accessor.
 * @returns {string} The modified XML text.
 */
function deleteComponentFromXml(xmlText, rootName, componentType, componentName, accessorType = null) {
    const openTagRegex = new RegExp(`<${componentType}\\b[^>]*Name="${componentName}"[^>]*>`);
    const openTagMatch = xmlText.match(openTagRegex);
    if (!openTagMatch) return xmlText;
    
    const closeTag = `</${componentType}>`;
    const closeTagIndex = xmlText.indexOf(closeTag, openTagMatch.index);
    if (closeTagIndex === -1) return xmlText;
    
    const endIndex = closeTagIndex + closeTag.length;
    
    if (accessorType) {
        // Deleting only the Get/Set accessor inside the Property block
        const propBlock = xmlText.substring(openTagMatch.index, endIndex);
        const accOpenRegex = new RegExp(`<${accessorType}\\b[^>]*>`);
        const accOpenMatch = propBlock.match(accOpenRegex);
        if (!accOpenMatch) return xmlText;
        
        const accCloseTag = `</${accessorType}>`;
        const accCloseIdx = propBlock.indexOf(accCloseTag, accOpenMatch.index);
        if (accCloseIdx === -1) return xmlText;
        
        const accEndIndex = accCloseIdx + accCloseTag.length;
        
        let accStartIdx = accOpenMatch.index;
        while (accStartIdx > 0 && (propBlock[accStartIdx - 1] === ' ' || propBlock[accStartIdx - 1] === '\t')) {
            accStartIdx--;
        }
        if (accStartIdx > 0 && propBlock[accStartIdx - 1] === '\n') {
            accStartIdx--;
            if (accStartIdx > 0 && propBlock[accStartIdx - 1] === '\r') {
                accStartIdx--;
            }
        }
        
        const updatedPropBlock = propBlock.substring(0, accStartIdx) + propBlock.substring(accEndIndex);
        let cleanedText = xmlText.substring(0, openTagMatch.index) + updatedPropBlock + xmlText.substring(endIndex);
        
        // Remove line ids for rootName.componentName.accessorType
        const lineIdsRegex = new RegExp(`\\s*<LineIds\\s+Name="${rootName}\\.${componentName}\\.${accessorType}"[^>]*>[^]*?</LineIds>`, 'g');
        cleanedText = cleanedText.replace(lineIdsRegex, '');
        return cleanedText;
    }
    
    // Remove the block and any leading whitespace/newlines before it
    let startIdx = openTagMatch.index;
    while (startIdx > 0 && (xmlText[startIdx - 1] === ' ' || xmlText[startIdx - 1] === '\t')) {
        startIdx--;
    }
    if (startIdx > 0 && xmlText[startIdx - 1] === '\n') {
        startIdx--;
        if (startIdx > 0 && xmlText[startIdx - 1] === '\r') {
            startIdx--;
        }
    }
    
    let cleanedText = xmlText.substring(0, startIdx) + xmlText.substring(endIndex);
    
    // Remove corresponding LineIds block
    const lineIdsRegex = new RegExp(`\\s*<LineIds\\s+Name="${rootName}\\.${componentName}(\\.[^"]*)?"[^>]*>[^]*?</LineIds>`, 'g');
    cleanedText = cleanedText.replace(lineIdsRegex, '');
    
    return cleanedText;
}

/**
 * Deletes a Folder tag from the XML.
 * @param {string} xmlText TwinCAT XML text.
 * @param {string} folderPath Virtual folder path (e.g. 'Methods\\Internal\\').
 * @returns {string} The modified XML text.
 */
function deleteFolderTagFromXml(xmlText, folderPath) {
    const parts = folderPath.split('\\').map(p => p.trim()).filter(p => p.length > 0);
    if (parts.length === 0) return xmlText;
    
    let searchStartIdx = 0;
    let targetMatch = null;
    
    for (let i = 0; i < parts.length; i++) {
        const name = parts[i];
        const isTarget = (i === parts.length - 1);
        
        if (isTarget) {
            // Find self-closing
            const scRegex = new RegExp(`<Folder\\s+Name="${name}"\\s+Id="([^"]*)"\\s*/>`);
            const scMatch = xmlText.substring(searchStartIdx).match(scRegex);
            if (scMatch) {
                targetMatch = {
                    index: searchStartIdx + scMatch.index,
                    length: scMatch[0].length,
                    type: 'self'
                };
                break;
            }
            
            // Find non-self-closing
            const opRegex = new RegExp(`<Folder\\s+Name="${name}"\\s+Id="([^"]*)"\\s*>`);
            const opMatch = xmlText.substring(searchStartIdx).match(opRegex);
            if (opMatch) {
                targetMatch = {
                    index: searchStartIdx + opMatch.index,
                    length: opMatch[0].length,
                    type: 'block'
                };
                break;
            }
        } else {
            // Find parent opening tag to narrow search scope
            const opRegex = new RegExp(`<Folder\\s+Name="${name}"\\s+Id="([^"]*)"\\s*>`);
            const opMatch = xmlText.substring(searchStartIdx).match(opRegex);
            if (opMatch) {
                searchStartIdx = searchStartIdx + opMatch.index + opMatch[0].length;
            } else {
                break;
            }
        }
    }
    
    if (!targetMatch) return xmlText;
    
    if (targetMatch.type === 'self') {
        let startIdx = targetMatch.index;
        while (startIdx > 0 && (xmlText[startIdx - 1] === ' ' || xmlText[startIdx - 1] === '\t')) {
            startIdx--;
        }
        if (startIdx > 0 && xmlText[startIdx - 1] === '\n') {
            startIdx--;
            if (startIdx > 0 && xmlText[startIdx - 1] === '\r') {
                startIdx--;
            }
        }
        return xmlText.substring(0, startIdx) + xmlText.substring(targetMatch.index + targetMatch.length);
    } else {
        const closeTag = '</Folder>';
        const closeIdx = xmlText.indexOf(closeTag, targetMatch.index);
        if (closeIdx !== -1) {
            let startIdx = targetMatch.index;
            while (startIdx > 0 && (xmlText[startIdx - 1] === ' ' || xmlText[startIdx - 1] === '\t')) {
                startIdx--;
            }
            if (startIdx > 0 && xmlText[startIdx - 1] === '\n') {
                startIdx--;
                if (startIdx > 0 && xmlText[startIdx - 1] === '\r') {
                    startIdx--;
                }
            }
            return xmlText.substring(0, startIdx) + xmlText.substring(closeIdx + closeTag.length);
        }
    }
    
    return xmlText;
}

module.exports = {
    parseAttrs,
    getCdata,
    parseTwinCatXml,
    replaceComponentCdata,
    getFoldersDetailedFromXml,
    insertFolderIntoXml,
    insertComponentIntoXml,
    deleteComponentFromXml,
    deleteFolderTagFromXml
};
