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
 * Inserts a root-level Folder tag at TwinCAT's canonical position. The XML loader is
 * order-sensitive inside <POU>/<Itf>: root folders must sit between the root Implementation
 * (Declaration for interfaces) and the first member element — a folder placed after the
 * members makes XAE drop them from compile (C0004 per member). New folders therefore go
 * right after the last existing root-level folder (keeping the group contiguous), or, when
 * none exists, directly after the root </Implementation> / </Declaration>.
 * @param {string} xmlText The source POU/Itf XML text.
 * @param {string} newFolderTag The complete self-closing <Folder ... /> tag to insert.
 * @returns {string} The modified XML text.
 */
function insertRootFolderIntoXml(xmlText, newFolderTag) {
    // End of the last root-level folder's full extent (past its matching </Folder> when not
    // self-closing) — same stack discipline as getFoldersDetailedFromXml.
    const folderRegex = /<Folder\b([^>]*)(>?)|<\/Folder>/g;
    let depth = 0;
    let groupEnd = -1;
    let folderMatch;
    while ((folderMatch = folderRegex.exec(xmlText)) !== null) {
        if (folderMatch[0] === '</Folder>') {
            if (depth > 0) {
                depth--;
                if (depth === 0) groupEnd = folderMatch.index + folderMatch[0].length;
            }
        } else if (folderMatch[1].trim().endsWith('/')) {
            if (depth === 0) groupEnd = folderMatch.index + folderMatch[0].length;
        } else {
            depth++;
        }
    }
    if (groupEnd !== -1) {
        return xmlText.substring(0, groupEnd) + `\n    ${newFolderTag}` + xmlText.substring(groupEnd);
    }

    // No root-level folder yet: the canonical slot is directly after the root block that
    // precedes the members — </Implementation> for POUs; interfaces (.TcIO) have no root
    // implementation, so </Declaration>. In a well-formed TwinCAT file the root
    // Declaration/Implementation precede every member, so the first occurrence after the
    // root open tag is the root's own.
    const rootOpen = xmlText.match(/<(POU|Itf)\b[^>]*>/);
    if (rootOpen) {
        const searchFrom = rootOpen.index + rootOpen[0].length;
        for (const closeTag of ['</Implementation>', '</Declaration>']) {
            const closeIdx = xmlText.indexOf(closeTag, searchFrom);
            if (closeIdx !== -1) {
                const insertAt = closeIdx + closeTag.length;
                return xmlText.substring(0, insertAt) + `\n    ${newFolderTag}` + xmlText.substring(insertAt);
            }
        }
    }

    // Defensive (no root Declaration/Implementation found): insert at the start of the
    // closing root tag's line so its own indentation stays untouched.
    const rootClose = xmlText.match(/<\/(POU|Itf)>/);
    if (!rootClose) return xmlText;
    let lineStart = rootClose.index;
    while (lineStart > 0 && (xmlText[lineStart - 1] === ' ' || xmlText[lineStart - 1] === '\t')) {
        lineStart--;
    }
    return xmlText.substring(0, lineStart) + `    ${newFolderTag}\n` + xmlText.substring(lineStart);
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
        return insertRootFolderIntoXml(xmlText, newFolderTag);
    }

    const folders = getFoldersDetailedFromXml(xmlText);
    const parentFolder = folders.find(f => f.path === parentFolderPath);
    if (!parentFolder) {
        return insertRootFolderIntoXml(xmlText, newFolderTag);
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
 * @param {*} fileUri Unused; retained for call-signature stability.
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
 * Sets, replaces, or removes the FolderPath attribute on a single opening tag string. The tag-level
 * core shared by setComponentFolderPathInXml (drag & drop moves) and insertComponentBlockIntoXml
 * (clipboard paste), so the two features cannot drift on how the attribute is spliced.
 * All splicing is done with string slices (never String.replace with a computed replacement):
 * folder paths contain backslashes and could contain '$', both special in replacement strings.
 * @param {string} tag The component's opening tag (e.g. `<Method Name="Home" Id="{…}">`).
 * @param {string} newFolderPath New virtual folder path (trailing backslash), or '' to remove.
 * @returns {string} The modified tag; the input unchanged when there is nothing to change.
 */
function setFolderPathOnTag(tag, newFolderPath) {
    const attrMatch = tag.match(/\sFolderPath="[^"]*"/);
    if (attrMatch) {
        return newFolderPath
            ? tag.slice(0, attrMatch.index) + ` FolderPath="${newFolderPath}"` + tag.slice(attrMatch.index + attrMatch[0].length)
            : tag.slice(0, attrMatch.index) + tag.slice(attrMatch.index + attrMatch[0].length);
    }
    if (!newFolderPath) return tag; // absent + root: nothing to do
    // Insert before the closing '>'. Component tags are never self-closing in real TwinCAT
    // files (they always wrap Declaration/Implementation), but handle '/>' defensively.
    return tag.endsWith('/>')
        ? tag.slice(0, -2).replace(/\s*$/, '') + ` FolderPath="${newFolderPath}" />`
        : tag.slice(0, -1) + ` FolderPath="${newFolderPath}">`;
}

/**
 * Sets, replaces, or removes the FolderPath attribute on a component's opening tag — virtual-folder
 * membership in TwinCAT XML is nothing but this attribute (e.g. `FolderPath="Methods\Internal\"`,
 * trailing backslash). Only the matched opening tag changes; every other byte of the document is
 * preserved, including a Property's Get/Set accessors (they live inside the tag pair and carry no
 * FolderPath of their own).
 * @param {string} xmlText POU XML text.
 * @param {string} componentType 'Method', 'Property', 'Action', 'Transition'.
 * @param {string} componentName Name of the component to move.
 * @param {string} newFolderPath New virtual folder path (trailing backslash), or '' to move the
 * component back to the file root (the attribute is removed).
 * @returns {string} The modified XML text; the input unchanged when the component is not found or
 * there is nothing to change.
 */
function setComponentFolderPathInXml(xmlText, componentType, componentName, newFolderPath) {
    // Same anchoring as deleteComponentFromXml, but the name is regex-escaped: IEC identifiers
    // cannot contain metacharacters today, but a malformed name must not corrupt the match.
    const nameEsc = componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const openTagRegex = new RegExp(`<${componentType}\\b[^>]*Name="${nameEsc}"[^>]*>`);
    const openTagMatch = xmlText.match(openTagRegex);
    if (!openTagMatch) return xmlText;

    const tag = openTagMatch[0];
    const newTag = setFolderPathOnTag(tag, newFolderPath);
    if (newTag === tag) return xmlText;
    return xmlText.substring(0, openTagMatch.index) + newTag + xmlText.substring(openTagMatch.index + tag.length);
}

/**
 * Extracts a component's full XML block — opening tag through matching close tag, a Property's
 * Get/Set accessors included — for clipboard copy. The block is returned verbatim (original Ids,
 * FolderPath, line endings); insertComponentBlockIntoXml re-identifies it on paste. LineIds are
 * deliberately NOT part of the block: they live at the file bottom and TwinCAT regenerates them,
 * the same precedent insertComponentIntoXml sets for newly created components.
 * @param {string} xmlText POU/Interface XML text.
 * @param {string} componentType 'Method', 'Property', 'Action', 'Transition'.
 * @param {string} componentName Name of the component to extract.
 * @returns {string|null} The block string, or null when the component is not found.
 */
function extractComponentBlockFromXml(xmlText, componentType, componentName) {
    // Same open-tag anchoring as deleteComponentFromXml/setComponentFolderPathInXml.
    const nameEsc = componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const openTagRegex = new RegExp(`<${componentType}\\b[^>]*Name="${nameEsc}"[^>]*>`);
    const openTagMatch = xmlText.match(openTagRegex);
    if (!openTagMatch) return null;

    // Never self-closing in real files, but a defensive '/>' is its own complete block.
    if (openTagMatch[0].endsWith('/>')) return openTagMatch[0];

    const closeTag = `</${componentType}>`;
    const closeTagIndex = xmlText.indexOf(closeTag, openTagMatch.index);
    if (closeTagIndex === -1) return null;
    return xmlText.substring(openTagMatch.index, closeTagIndex + closeTag.length);
}

/**
 * Inserts a copied component block into a target file, re-identifying it on the way in: the pasted
 * copy must be a NEW object (fresh Ids), under a possibly new name, in the target's folder — while
 * its Declaration/Implementation content travels verbatim.
 * @param {string} targetXml The target POU/Interface XML text.
 * @param {string} block A block from extractComponentBlockFromXml.
 * @param {Object} opts
 * @param {string} opts.oldName The component's name inside the block.
 * @param {string} opts.newName The name to paste under (may equal oldName).
 * @param {string} opts.newFolderPath Target virtual folder (trailing backslash), or '' for the root.
 * @param {boolean} opts.isItf Whether the target is an Interface (.TcIO) — decides the close tag.
 * @returns {string} The modified target XML; the input unchanged when the close tag is missing.
 */
function insertComponentBlockIntoXml(targetXml, block, { oldName, newName, newFolderPath, isItf }) {
    // 1. Rewrite the block's OPENING tag only: the pasted name and the target folder. Deeper
    //    Name attributes (Get/Set accessors are Name="Get"/"Set") must not be touched.
    const openTagMatch = block.match(/^<(Method|Property|Action|Transition)\b[^>]*>/);
    if (!openTagMatch) return targetXml;
    let tag = openTagMatch[0];
    if (newName !== oldName) {
        const nameAttr = ` Name="${oldName}"`;
        const nameIdx = tag.indexOf(nameAttr);
        if (nameIdx !== -1) {
            tag = tag.slice(0, nameIdx) + ` Name="${newName}"` + tag.slice(nameIdx + nameAttr.length);
        }
    }
    tag = setFolderPathOnTag(tag, newFolderPath);
    let newBlock = tag + block.slice(openTagMatch[0].length);

    // 2. Fresh identity: EVERY Id in the block (the component's own and any nested Get/Set) gets a
    //    new GUID — TwinCAT object ids must be unique, and the source keeps the originals.
    newBlock = regenerateObjectIdsInXml(newBlock);

    // 3. Rename the declaration-header identifier: the first word-boundary occurrence of oldName
    //    after the METHOD/PROPERTY keyword in the block's FIRST Declaration CDATA (the Property's
    //    own declaration precedes its accessors'). Actions/Transitions have no declaration header,
    //    and other occurrences stay: bodies may reference the old name, and TwinCAT's own paste
    //    does not refactor either.
    if (newName !== oldName) {
        newBlock = renameFirstHeaderOccurrence(newBlock, /\b(?:METHOD|PROPERTY)\b/i, oldName, newName);
    }

    // 4. Splice before the root close tag, matching insertComponentIntoXml's convention
    //    (4-space indent on the opening line, trailing newline).
    const closeTag = isItf ? '</Itf>' : '</POU>';
    const index = targetXml.lastIndexOf(closeTag);
    if (index === -1) return targetXml;
    return targetXml.substring(0, index) + `    ${newBlock}\n` + targetXml.substring(index);
}

/**
 * Replaces every GUID-shaped `Id="{…}"` attribute in the text with a freshly generated one —
 * a duplicate must not collide with its source's object identity: TwinCAT keys objects on these
 * Ids, so a pasted component block and a duplicated FILE alike (the root object AND every member,
 * Get/Set accessors included) need fresh ones. Deliberately a separate step from
 * renameRootObjectInXml: renaming and re-identification are different concerns — a future
 * rename-in-place must keep Ids. Restricted to the brace-wrapped GUID shape so `<LineId Id="3">`
 * counters and any stray `Id=` text inside CDATA code can never be rewritten; splicing is
 * slice-based, as everywhere.
 * @param {string} xmlText XML text — a component block or a whole document.
 * @returns {string} The text with every GUID id regenerated; unchanged when none are present.
 */
function regenerateObjectIdsInXml(xmlText) {
    const regex = /Id="\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}"/g;
    let out = '';
    let last = 0;
    let match;
    while ((match = regex.exec(xmlText)) !== null) {
        out += xmlText.slice(last, match.index) + `Id="{${crypto.randomUUID()}}"`;
        last = match.index + match[0].length;
    }
    return out + xmlText.slice(last);
}

/**
 * In the FIRST Declaration CDATA of `text`, replaces the first word-boundary occurrence of
 * `oldName` found after `keywordRegex` with `newName`. Used by both paste renames (component
 * headers and root object headers). No-op when the CDATA, the keyword, or the name is missing.
 * @param {string} text XML text containing a `<Declaration><![CDATA[…]]>` section.
 * @param {RegExp} keywordRegex Matches the header keyword the name follows (e.g. /\bMETHOD\b/i).
 * @param {string} oldName Identifier to replace (matched case-insensitively — IEC names are).
 * @param {string} newName Replacement identifier.
 * @returns {string} The modified text, byte-identical outside the one renamed identifier.
 */
function renameFirstHeaderOccurrence(text, keywordRegex, oldName, newName) {
    const declIdx = text.indexOf('<Declaration>');
    if (declIdx === -1) return text;
    const cdataStart = text.indexOf('<![CDATA[', declIdx);
    if (cdataStart === -1) return text;
    const contentStart = cdataStart + 9;
    const cdataEnd = text.indexOf(']]>', contentStart);
    if (cdataEnd === -1) return text;

    const cdata = text.substring(contentStart, cdataEnd);
    const kwMatch = cdata.match(keywordRegex);
    if (!kwMatch) return text;

    const nameEsc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRegex = new RegExp(`\\b${nameEsc}\\b`, 'i');
    const searchFrom = kwMatch.index + kwMatch[0].length;
    const nameMatch = cdata.slice(searchFrom).match(nameRegex);
    if (!nameMatch) return text;

    const absIdx = contentStart + searchFrom + nameMatch.index;
    return text.slice(0, absIdx) + newName + text.slice(absIdx + nameMatch[0].length);
}

/**
 * Renames a TwinCAT object file's root: the root tag's Name attribute, the declaration-header
 * identifier, and the LineIds names — everything TwinCAT keys on the object name. Used when
 * pasting a copied FILE under a new name. Deliberately does NOT touch occurrences in code bodies
 * (self-references keep the old name, exactly like TwinCAT's own copy) and does not regenerate
 * Ids or LineId counters. Everything outside the three renamed spots is byte-for-byte identical.
 * @param {string} xmlText TwinCAT XML file text.
 * @param {string} newName The new object name.
 * @returns {string} The modified XML text; the input unchanged when no known root is found.
 */
function renameRootObjectInXml(xmlText, newName) {
    const rootMatch = xmlText.match(/<(POU|GVL|DUT|Itf|EnumerationTextList)\b([^>]*)>/);
    if (!rootMatch) return xmlText;
    const rootElement = rootMatch[1];
    const oldName = parseAttrs(rootMatch[2]).Name;
    if (!oldName || oldName === newName) return xmlText;

    // Root Name attribute — spliced inside the matched root tag only.
    let result = xmlText;
    const tag = rootMatch[0];
    const nameAttr = ` Name="${oldName}"`;
    const nameIdx = tag.indexOf(nameAttr);
    if (nameIdx !== -1) {
        const absIdx = rootMatch.index + nameIdx;
        result = result.slice(0, absIdx) + ` Name="${newName}"` + result.slice(absIdx + nameAttr.length);
    }

    // Declaration header. GVLs have no header naming the object (their declaration is VAR_GLOBAL
    // blocks) — the attribute rename above is all they need. EnumerationTextList declarations are
    // ordinary `TYPE X : (…)` enums (see parseTwinCatXml), so TYPE covers DUT and TLEO alike.
    if (rootElement !== 'GVL') {
        result = renameFirstHeaderOccurrence(
            result, /\b(?:FUNCTION_BLOCK|PROGRAM|FUNCTION|INTERFACE|TYPE)\b/i, oldName, newName);
    }

    // LineIds carry the object name (`Name="Old"` for the root, `Name="Old.Member[.Get|.Set]"` for
    // members) — a stale prefix would make TwinCAT mis-associate every line id with a dead object.
    // Only the name VALUE is spliced (group 1 keeps the tag's own bytes, whatever its spacing).
    const lineIdsRegex = /(<LineIds\s+Name=")([^"]*)"/g;
    const oldLower = oldName.toLowerCase();
    let out = '';
    let last = 0;
    let match;
    while ((match = lineIdsRegex.exec(result)) !== null) {
        const name = match[2];
        const nameLower = name.toLowerCase();
        let renamed = null;
        if (nameLower === oldLower) {
            renamed = newName;
        } else if (nameLower.startsWith(oldLower + '.')) {
            renamed = newName + name.slice(oldName.length);
        }
        if (renamed !== null) {
            const valueStart = match.index + match[1].length;
            out += result.slice(last, valueStart) + renamed;
            last = valueStart + name.length;
        }
    }
    result = out + result.slice(last);

    return result;
}

/**
 * Renames a Method/Property/Action/Transition in place — the member's opening-tag Name attribute,
 * its declaration-header identifier (Method/Property only; Actions/Transitions carry no ST header),
 * and every LineIds name rooted on it. Unlike a paste (insertComponentBlockIntoXml) or a file
 * duplicate (regenerateObjectIdsInXml), a rename-in-place must NOT re-identify: the object's Ids and
 * GUIDs are deliberately KEPT — see regenerateObjectIdsInXml's doc comment for the contrast.
 * Deliberately does NOT touch occurrences in code bodies (self-references keep the old name, exactly
 * as TwinCAT's own rename leaves them). Everything outside the renamed spots is byte-for-byte
 * identical.
 * @param {string} xmlText POU/Interface XML text.
 * @param {string} rootName Root POU/Interface name — the prefix carried by member LineIds names.
 * @param {string} componentType 'Method', 'Property', 'Action', 'Transition'.
 * @param {string} componentName Current name of the component to rename.
 * @param {string} newName The new component name.
 * @returns {string} The modified XML text; the input unchanged when the component is not found or
 * the names are equal.
 */
function renameComponentInXml(xmlText, rootName, componentType, componentName, newName) {
    if (componentName === newName) return xmlText;

    // Same open-tag anchoring as setComponentFolderPathInXml/deleteComponentFromXml, name escaped:
    // a malformed name must never corrupt the match or the replacement.
    const nameEsc = componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const openTagRegex = new RegExp(`<${componentType}\\b[^>]*Name="${nameEsc}"[^>]*>`);
    const openTagMatch = xmlText.match(openTagRegex);
    if (!openTagMatch) return xmlText;

    const openTag = openTagMatch[0];
    const openStart = openTagMatch.index;

    // The component block: opening tag through matching close tag (a Property's Get/Set included),
    // or just the tag when defensively self-closing. Scoping the header rename to THIS block is
    // essential — on the whole file renameFirstHeaderOccurrence would hit the ROOT's <Declaration>.
    let blockEnd;
    if (openTag.endsWith('/>')) {
        blockEnd = openStart + openTag.length;
    } else {
        const closeTag = `</${componentType}>`;
        const closeTagIndex = xmlText.indexOf(closeTag, openStart);
        if (closeTagIndex === -1) return xmlText;
        blockEnd = closeTagIndex + closeTag.length;
    }
    const block = xmlText.substring(openStart, blockEnd);

    // 1. Rewrite the opening tag's Name attribute (matched tag only) via indexOf+slice — never a
    //    computed String.replace (the technique in insertComponentBlockIntoXml).
    let newTag = openTag;
    const nameAttr = ` Name="${componentName}"`;
    const nameIdx = newTag.indexOf(nameAttr);
    if (nameIdx !== -1) {
        newTag = newTag.slice(0, nameIdx) + ` Name="${newName}"` + newTag.slice(nameIdx + nameAttr.length);
    }
    let newBlock = newTag + block.slice(openTag.length);

    // 2. Rename the declaration-header identifier (Method/Property only). Actions/Transitions have
    //    no ST declaration header to rename.
    if (componentType === 'Method' || componentType === 'Property') {
        newBlock = renameFirstHeaderOccurrence(newBlock, /\b(?:METHOD|PROPERTY)\b/i, componentName, newName);
    }

    let result = xmlText.substring(0, openStart) + newBlock + xmlText.substring(blockEnd);

    // 3. Rewrite member LineIds names: exact `rootName.componentName` and the dotted-prefix form
    //    `rootName.componentName.<suffix>` (a Property's `.Get`/`.Set`). Compared case-insensitively
    //    (IEC names are); only the name VALUE is spliced (group 1 keeps the tag's own bytes). This
    //    is the rename analogue of deleteComponentFromXml's LineIds removal.
    const oldFull = `${rootName}.${componentName}`;
    const oldFullLower = oldFull.toLowerCase();
    const newFull = `${rootName}.${newName}`;
    const lineIdsRegex = /(<LineIds\s+Name=")([^"]*)"/g;
    let out = '';
    let last = 0;
    let match;
    while ((match = lineIdsRegex.exec(result)) !== null) {
        const name = match[2];
        const nameLower = name.toLowerCase();
        let renamed = null;
        if (nameLower === oldFullLower) {
            renamed = newFull;
        } else if (nameLower.startsWith(oldFullLower + '.')) {
            renamed = newFull + name.slice(oldFull.length);
        }
        if (renamed !== null) {
            const valueStart = match.index + match[1].length;
            out += result.slice(last, valueStart) + renamed;
            last = valueStart + name.length;
        }
    }
    result = out + result.slice(last);

    return result;
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

/**
 * Renames a virtual folder in place: the target <Folder> tag's Name attribute, plus the FolderPath
 * attribute on every member whose path lies inside the folder. Virtual-folder membership in TwinCAT
 * XML is nothing but the folder nesting and the members' FolderPath attributes — so only the ONE
 * folder tag's Name and the affected FolderPath values change; nested sub-folder tags derive their
 * path from nesting and are left alone, and every other byte is preserved.
 * @param {string} xmlText POU/Interface XML text.
 * @param {string} folderPath Full virtual path of the folder to rename, with trailing backslash
 * (e.g. 'Methods\\Internal\\').
 * @param {string} newName The new (leaf) folder name.
 * @returns {string} The modified XML text; the input unchanged when the folder is not found or the
 * rename is a no-op.
 */
function renameVirtualFolderInXml(xmlText, folderPath, newName) {
    // Locate the target folder by its computed path — getFoldersDetailedFromXml walks the same
    // nesting stack deleteFolderTagFromXml relies on, and hands back the opening tag's span.
    const folder = getFoldersDetailedFromXml(xmlText).find(f => f.path === folderPath);
    if (!folder || folder.name === newName) return xmlText;

    // New leaf path: the parent prefix (folderPath minus its last segment) + newName + '\'.
    const parts = folderPath.split('\\').filter(p => p.length > 0);
    const parentSegments = parts.slice(0, -1);
    const newPath = (parentSegments.length ? parentSegments.join('\\') + '\\' : '') + newName + '\\';

    // 1. Rewrite the folder tag's Name attribute (matched tag only) via slice.
    const tag = xmlText.substring(folder.startIndex, folder.startIndex + folder.length);
    const nameAttr = ` Name="${folder.name}"`;
    const nameIdx = tag.indexOf(nameAttr);
    if (nameIdx === -1) return xmlText;
    const newTag = tag.slice(0, nameIdx) + ` Name="${newName}"` + tag.slice(nameIdx + nameAttr.length);
    let result = xmlText.substring(0, folder.startIndex) + newTag + xmlText.substring(folder.startIndex + folder.length);

    // 2. Repoint every member FolderPath that starts with the old path prefix (case-sensitive, as
    //    TwinCAT wrote it). FolderPath appears only on member opening tags, so a whole-file pass is
    //    safe; the value is spliced, never String.replace'd (paths carry backslashes and could
    //    carry '$', both special in replacement strings).
    const faRegex = /\sFolderPath="([^"]*)"/g;
    let out = '';
    let last = 0;
    let match;
    while ((match = faRegex.exec(result)) !== null) {
        const value = match[1];
        if (value.startsWith(folderPath)) {
            const newValue = newPath + value.slice(folderPath.length);
            const valueStart = match.index + match[0].indexOf('"') + 1;
            out += result.slice(last, valueStart) + newValue;
            last = valueStart + value.length;
        }
    }
    result = out + result.slice(last);

    return result;
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
    setComponentFolderPathInXml,
    extractComponentBlockFromXml,
    insertComponentBlockIntoXml,
    renameRootObjectInXml,
    renameComponentInXml,
    renameFirstHeaderOccurrence,
    regenerateObjectIdsInXml,
    deleteFolderTagFromXml,
    renameVirtualFolderInXml
};
