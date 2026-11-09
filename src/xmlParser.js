/**
 * @file xmlParser.js
 * @description XML parsing and editing utilities for TwinCAT files (.TcPOU, .TcIO, .TcGVL, .TcDUT).
 */

const crypto = require('crypto');
const { make: makeComponentId } = require('./componentId');

// ── Attribute values: decode on read, encode on write ───────────────────────────────────────────
// Attribute values are entity-encoded in the file (`FolderPath="In &amp; Out\"`). Every value the
// parser RETURNS is decoded, and every writer that finds a tag by a value or inserts one goes
// through encodeXmlAttr / attrValueSpan — never a regex or string built from the raw value — so a
// decoded name handed back by a caller still finds its tag.

/** @type {Record<string, string>} */
const XML_NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Decodes the five predefined XML entities and numeric character references (`&#38;`, `&#x26;`)
 * in an attribute value. Anything else (an unknown or malformed reference) is left as written.
 * @param {string} value Raw attribute value as it appears between the quotes.
 * @returns {string} The decoded value.
 */
function decodeXmlAttr(value) {
    if (value.indexOf('&') === -1) return value;
    return value.replace(/&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (ref, hex, dec, named) => {
        if (named) return XML_NAMED_ENTITIES[named];
        const codePoint = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
        return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : ref;
    });
}

/**
 * Encodes a value for a double-quoted XML attribute: `&`, `<`, `>` and `"` — the set .NET's
 * XmlWriter (and so TwinCAT) escapes.
 * @param {string} value Decoded value.
 * @returns {string} The value as it must appear between the quotes.
 */
function encodeXmlAttr(value) {
    return String(value).replace(/[&<>"]/g, ch =>
        ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;');
}

/**
 * Parses XML attributes from a string. Values are entity-decoded.
 * @param {string} attrString The attributes string from an XML tag.
 * @returns {Object} Key-value pairs of attributes.
 */
function parseAttrs(attrString) {
    const attrs = {};
    const regex = /(\w+)="([^"]*)"/g;
    let match;
    while ((match = regex.exec(attrString)) !== null) {
        attrs[match[1]] = decodeXmlAttr(match[2]);
    }
    return attrs;
}

/**
 * Locates one attribute's VALUE inside a single tag string, so a writer can splice exactly those
 * bytes (and nothing else of the tag) with an encoded replacement.
 * @param {string} tag An opening tag, e.g. `<Method Name="Go" FolderPath="A &amp; B\">`.
 * @param {string} attrName Attribute name (exact; `Name` does not match `FolderName`).
 * @returns {{start: number, end: number, value: string}|null} Offsets of the raw value within `tag`
 * and its decoded value; null when the attribute is absent.
 */
function attrValueSpan(tag, attrName) {
    const match = new RegExp(`\\s${attrName}="([^"]*)"`).exec(tag);
    if (!match) return null;
    const start = match.index + match[0].length - match[1].length - 1;
    return { start, end: start + match[1].length, value: decodeXmlAttr(match[1]) };
}

/**
 * Turns lone CR line breaks (old Mac style) into LF; CRLF and LF are left alone. Applied to the
 * code the parser RETURNS only — Monaco treats a lone CR as a line break while the ST converter
 * splits on `\r?\n`, so without this the pane's lines and the unit's lines disagree. The file text
 * is never normalised (byte fidelity outside an edited CDATA).
 * @param {string} text
 * @returns {string}
 */
function normalizeLoneCr(text) {
    return text.indexOf('\r') === -1 ? text : text.replace(/\r(?!\n)/g, '\n');
}

// ── Element scanning ────────────────────────────────────────────────────────────────────────────
// Still regex-based (TwinCAT's exact bytes must survive), but CDATA-, comment- and nesting-aware:
// a `<ST>` or `</Declaration>` inside ST code, or inside a NESTED element, is never taken for the
// element being looked for.

/**
 * @typedef {Object} XmlElementSpan
 * @property {string} name Element name.
 * @property {string} openTag The opening tag text (the whole tag when self-closing).
 * @property {number} start Offset of `<` of the opening tag.
 * @property {number} openEnd Offset just past the opening tag (content start).
 * @property {number} contentEnd Offset of the closing tag (=== openEnd when self-closing).
 * @property {number} end Offset just past the closing tag.
 * @property {boolean} selfClosing
 */

/**
 * Yields the tags in `text[from, to)`, skipping CDATA sections, comments and processing
 * instructions (their contents are never markup).
 * @param {string} text
 * @param {number} from
 * @param {number} to
 * @returns {Generator<{closing: boolean, name: string, selfClosing: boolean, start: number, end: number, raw: string}>}
 */
function* scanTags(text, from, to) {
    const regex = /<!\[CDATA\[|<!--|<\?|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g;
    regex.lastIndex = from;
    let match;
    while ((match = regex.exec(text)) !== null && match.index < to) {
        const opener = match[0];
        if (opener === '<![CDATA[' || opener === '<!--' || opener === '<?') {
            const terminator = opener === '<![CDATA[' ? ']]>' : opener === '<!--' ? '-->' : '?>';
            const termIdx = text.indexOf(terminator, match.index + opener.length);
            if (termIdx === -1) return;
            regex.lastIndex = termIdx + terminator.length;
            continue;
        }
        const end = match.index + opener.length;
        if (end > to) return;
        yield { closing: match[1] === '/', name: match[2], selfClosing: match[3] === '/', start: match.index, end, raw: opener };
    }
}

/**
 * The direct child elements of the element whose content is `text[from, to)`, in document order.
 * Assumes well-formed nesting (TwinCAT writes it); close-tag names are not cross-checked.
 * @param {string} text
 * @param {number} from Content start of the parent.
 * @param {number} to Content end of the parent (offset of its closing tag).
 * @returns {XmlElementSpan[]}
 */
function childElements(text, from, to) {
    const children = [];
    const stack = [];
    for (const tag of scanTags(text, from, to)) {
        if (tag.closing) {
            const open = stack.pop();
            if (open && stack.length === 0) {
                children.push({ ...open, contentEnd: tag.start, end: tag.end, selfClosing: false });
            }
        } else if (tag.selfClosing) {
            if (stack.length === 0) {
                children.push({ name: tag.name, openTag: tag.raw, start: tag.start, openEnd: tag.end, contentEnd: tag.end, end: tag.end, selfClosing: true });
            }
        } else {
            stack.push({ name: tag.name, openTag: tag.raw, start: tag.start, openEnd: tag.end });
        }
    }
    return children;
}

/**
 * The first element named `name` in `text[from, to)` at any depth (outside CDATA/comments).
 * @param {string} text
 * @param {string} name
 * @param {number} [from]
 * @param {number} [to]
 * @returns {XmlElementSpan|null}
 */
function findFirstElement(text, name, from = 0, to = text.length) {
    let open = null;
    let depth = 0;
    for (const tag of scanTags(text, from, to)) {
        if (tag.name !== name) continue;
        if (!open) {
            if (tag.closing) continue;
            if (tag.selfClosing) {
                return { name, openTag: tag.raw, start: tag.start, openEnd: tag.end, contentEnd: tag.end, end: tag.end, selfClosing: true };
            }
            open = tag;
            depth = 1;
        } else if (tag.closing) {
            if (--depth === 0) {
                return { name, openTag: open.raw, start: open.start, openEnd: open.end, contentEnd: tag.start, end: tag.end, selfClosing: false };
            }
        } else if (!tag.selfClosing) {
            depth++;
        }
    }
    return null;
}

/**
 * The CDATA payload span of an element, bounded to that element: from the first `<![CDATA[` in its
 * content to the last `]]>` before its closing tag (TwinCAT splits a payload containing `]]>` into
 * adjacent sections; the span keeps them together, as before). Null when the element holds none —
 * the search never runs on into a later element.
 * @param {string} text
 * @param {XmlElementSpan} element
 * @returns {{start: number, end: number}|null} Offsets of the payload (inside the markers).
 */
function cdataSpan(text, element) {
    if (element.selfClosing) return null;
    const cdataStart = text.indexOf('<![CDATA[', element.openEnd);
    if (cdataStart === -1 || cdataStart >= element.contentEnd) return null;
    const cdataEnd = text.lastIndexOf(']]>', element.contentEnd - 3);
    if (cdataEnd === -1 || cdataEnd < cdataStart + 9) return null;
    return { start: cdataStart + 9, end: cdataEnd };
}

/**
 * Extracts CDATA content within a given tag range — the first `startTag` element at any depth,
 * outside CDATA. An element without CDATA (`<X />`, `<X></X>`) yields '' rather than a LATER
 * element's payload.
 * @param {string} blockText The source text containing the XML blocks.
 * @param {string} startTag The opening tag (e.g., '<Declaration>').
 * @param {string} endTag The closing tag (e.g., '</Declaration>'); implied by startTag, kept for
 * call-signature stability.
 * @returns {string} The text inside the CDATA wrapper, or empty string if not found.
 */
function getCdata(blockText, startTag, endTag) {
    const element = findFirstElement(blockText, startTag.replace(/^<|>$/g, ''));
    if (!element) return '';
    const span = cdataSpan(blockText, element);
    return span ? blockText.substring(span.start, span.end) : '';
}

/**
 * The root element of a TwinCAT object file and its direct children.
 * `.TcTLEO` objects use an <EnumerationTextList> root, but their <Declaration> is an ordinary
 * `TYPE X : (…); END_TYPE` enum — i.e. a DUT in every way that matters to the language server.
 * Normalising the type here means stConverter, xmlIndexer and the webview need no special case;
 * only the close-tag lookup needs the real element name.
 * @param {string} xmlText
 * @returns {{rootElement: string, rootType: string, rootTag: string, rootAttrs: Object, start: number, openEnd: number, contentEnd: number, children: XmlElementSpan[]}|null}
 */
function locateRoot(xmlText) {
    const rootMatch = xmlText.match(/<(POU|GVL|DUT|Itf|EnumerationTextList)\b([^>]*)>/);
    if (!rootMatch) return null;
    const rootElement = rootMatch[1];
    const openEnd = rootMatch.index + rootMatch[0].length;
    const contentEnd = xmlText.indexOf(`</${rootElement}>`, rootMatch.index);
    if (contentEnd === -1) return null;
    return {
        rootElement,
        rootType: rootElement === 'EnumerationTextList' ? 'DUT' : rootElement,
        rootTag: rootMatch[0],
        rootAttrs: parseAttrs(rootMatch[2]),
        start: rootMatch.index,
        openEnd,
        contentEnd,
        children: childElements(xmlText, openEnd, contentEnd)
    };
}

const MEMBER_ELEMENTS = new Set(['Method', 'Property', 'Action', 'Transition']);

/**
 * A member (Method/Property/Action/Transition) of the root, found among the root's DIRECT children
 * by its decoded Name — the same elements parseTwinCatXml reports, so a name the parser returned
 * always finds its tag (entities and all), and nothing nested in a body (e.g. inside an SFC
 * `<Implementation>`) is ever mistaken for one.
 * @param {string} xmlText
 * @param {string} memberType 'Method', 'Property', 'Action', 'Transition'.
 * @param {string} memberName Decoded Name attribute.
 * @returns {XmlElementSpan|null}
 */
function findMember(xmlText, memberType, memberName) {
    const root = locateRoot(xmlText);
    if (!root) return null;
    return root.children.find(c => c.name === memberType && parseAttrs(c.openTag).Name === memberName) || null;
}

/**
 * The body element of an owner's own <Implementation> — its first child element (`<ST>`, `<SFC>`,
 * `<NWL>` for LD/FBD, `<CFC>`, …) — and the language that element names.
 * @param {string} text
 * @param {XmlElementSpan[]} ownerChildren The owner's direct children.
 * @returns {{language: string|null, body: XmlElementSpan|null}} language null when the owner has
 * no Implementation (or an empty one).
 */
function implementationBody(text, ownerChildren) {
    const impl = ownerChildren.find(c => c.name === 'Implementation');
    if (!impl || impl.selfClosing) return { language: null, body: null };
    const body = childElements(text, impl.openEnd, impl.contentEnd)[0] || null;
    return { language: body ? body.name : null, body };
}

/**
 * Reads an owner element's Declaration and ST implementation from its own direct children.
 * @param {string} text
 * @param {XmlElementSpan[]} ownerChildren
 * @returns {{declaration: string, implementation: string|null, implementationLanguage: string|null}}
 * implementation is null unless the owner's own Implementation is ST.
 */
function readOwnBlocks(text, ownerChildren) {
    const declEl = ownerChildren.find(c => c.name === 'Declaration');
    const declSpan = declEl ? cdataSpan(text, declEl) : null;
    const { language, body } = implementationBody(text, ownerChildren);
    let implementation = null;
    if (language === 'ST' && body) {
        const implSpan = cdataSpan(text, body);
        implementation = normalizeLoneCr(implSpan ? text.substring(implSpan.start, implSpan.end) : '');
    }
    return {
        declaration: normalizeLoneCr(declSpan ? text.substring(declSpan.start, declSpan.end) : ''),
        implementation,
        implementationLanguage: language
    };
}

/**
 * Parses a TwinCAT XML file content to extract its root and sub-components.
 *
 * Every Declaration/Implementation is read from its OWNER's direct children: the root's own
 * <Implementation> is the one before its members, never the first `<ST>` in the file — on an
 * SFC/LD/FBD/CFC POU that is a member's code. Each component records `implementationLanguage`
 * (the element inside its Implementation: 'ST', 'SFC', 'NWL', 'CFC', …; null when it has none),
 * and `implementation` is null unless that language is ST — the webview's "no implementation pane".
 * @param {string} xmlText TwinCAT XML file text.
 * @returns {Object|null} The parsed root type, root name, and list of components.
 */
function parseTwinCatXml(xmlText) {
    const root = locateRoot(xmlText);
    if (!root) return null;

    const rootType = root.rootType;
    const rootName = root.rootAttrs.Name || 'Unnamed';

    const components = [];

    // Root Level Component. Only a POU has an implementation.
    const rootBlocks = readOwnBlocks(xmlText, root.children);
    components.push({
        id: makeComponentId('root'),
        type: rootType,
        name: rootName,
        folderPath: '',
        declaration: rootBlocks.declaration,
        implementation: rootType === 'POU' ? rootBlocks.implementation : null,
        implementationLanguage: rootType === 'POU' ? rootBlocks.implementationLanguage : null,
        xmlContext: {
            rootType,
            subType: null,
            subName: null,
            accessorType: null
        }
    });

    // Method, Property, Action, Transition: the root's direct children
    for (const member of root.children) {
        if (!MEMBER_ELEMENTS.has(member.name)) continue;
        const subType = member.name;
        const subAttrs = parseAttrs(member.openTag);
        const subName = subAttrs.Name || 'Unnamed';
        const folderPath = subAttrs.FolderPath || '';
        const memberChildren = member.selfClosing ? [] : childElements(xmlText, member.openEnd, member.contentEnd);

        if (subType === 'Property') {
            const propDecl = memberChildren.find(c => c.name === 'Declaration');
            const propDeclSpan = propDecl ? cdataSpan(xmlText, propDecl) : null;
            components.push({
                id: makeComponentId('prop', subName),
                type: 'Property',
                name: `${subName} (Property Signature)`,
                folderPath,
                declaration: normalizeLoneCr(propDeclSpan ? xmlText.substring(propDeclSpan.start, propDeclSpan.end) : ''),
                implementation: null,
                implementationLanguage: null,
                xmlContext: {
                    rootType,
                    subType: 'Property',
                    subName,
                    accessorType: null
                }
            });

            // Get/Set accessors: the Property's own children
            for (const accessorType of ['Get', 'Set']) {
                const accessor = memberChildren.find(c => c.name === accessorType);
                if (!accessor) continue;
                const accessorChildren = accessor.selfClosing ? [] : childElements(xmlText, accessor.openEnd, accessor.contentEnd);
                const blocks = readOwnBlocks(xmlText, accessorChildren);
                components.push({
                    id: makeComponentId('prop', subName, accessorType === 'Get' ? 'get' : 'set'),
                    type: accessorType,
                    name: `${subName} [${accessorType}]`,
                    folderPath: folderPath,
                    declaration: blocks.declaration,
                    implementation: blocks.implementation,
                    implementationLanguage: blocks.implementationLanguage,
                    xmlContext: {
                        rootType,
                        subType: 'Property',
                        subName,
                        accessorType
                    }
                });
            }
        } else {
            // Method, Action, Transition
            const blocks = readOwnBlocks(xmlText, memberChildren);
            components.push({
                // subType is always 'Method'/'Action'/'Transition' here (MEMBER_ELEMENTS minus
                // Property), which are also valid componentId kinds once lowercased.
                id: makeComponentId(/** @type {any} */ (subType.toLowerCase()), subName),
                type: subType,
                name: subName,
                folderPath,
                declaration: blocks.declaration,
                implementation: blocks.implementation,
                implementationLanguage: blocks.implementationLanguage,
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
 * Replaces the CDATA payload of one element, bounded to that element. An element that has no CDATA
 * yet (`<ST />`, `<Declaration></Declaration>`) gets one — the edit stays inside the element, never
 * in a later block's CDATA. An element holding non-CDATA text is left alone (refused).
 * @param {string} text
 * @param {XmlElementSpan} element
 * @param {string} newContent
 * @returns {string} The modified text, or `text` unchanged when refused.
 */
function replaceElementCdata(text, element, newContent) {
    const cdata = `<![CDATA[${newContent}]]>`;
    if (element.selfClosing) {
        const openTag = element.openTag.replace(/\s*\/>$/, '>');
        return text.substring(0, element.start) + openTag + cdata + `</${element.name}>` + text.substring(element.end);
    }
    const span = cdataSpan(text, element);
    if (span) {
        return text.substring(0, span.start) + newContent + text.substring(span.end);
    }
    if (text.substring(element.openEnd, element.contentEnd).trim() !== '') return text;
    return text.substring(0, element.openEnd) + cdata + text.substring(element.contentEnd);
}

/**
 * Replaces the CDATA section of a component inside the XML text. The target is always the
 * component's OWN Declaration / Implementation (its owner's direct children), mirroring
 * parseTwinCatXml. An Implementation write is refused (text returned unchanged) unless the owner's
 * own Implementation is ST — on an SFC/LD/FBD/CFC body there is nothing ST to write, and writing
 * the first `<ST>` found would overwrite a member's code.
 * @param {string} xmlText The entire XML file content.
 * @param {Object} context Context metadata of the component.
 * @param {string} blockType 'Declaration' or 'Implementation'.
 * @param {string} newContent The updated structured text or variables code.
 * @returns {string} The modified XML text.
 */
function replaceComponentCdata(xmlText, context, blockType, newContent) {
    let ownerChildren;
    if (!context.subType) {
        // Root POU, GVL, DUT, Itf
        const root = locateRoot(xmlText);
        if (!root) return xmlText;
        ownerChildren = root.children;
    } else {
        const member = findMember(xmlText, context.subType, context.subName);
        if (!member || member.selfClosing) return xmlText;
        ownerChildren = childElements(xmlText, member.openEnd, member.contentEnd);
        if (context.subType === 'Property' && context.accessorType) {
            const accessor = ownerChildren.find(c => c.name === context.accessorType); // 'Get' or 'Set'
            if (!accessor || accessor.selfClosing) return xmlText;
            ownerChildren = childElements(xmlText, accessor.openEnd, accessor.contentEnd);
        }
    }

    let target;
    if (blockType === 'Declaration') {
        target = ownerChildren.find(c => c.name === 'Declaration');
    } else {
        const { language, body } = implementationBody(xmlText, ownerChildren);
        if (language !== 'ST') return xmlText;
        target = body;
    }
    if (!target) return xmlText;
    return replaceElementCdata(xmlText, target, newContent);
}


/**
 * Extracts virtual folders defined in the XML. Names and paths are entity-decoded; `startIndex` /
 * `length` locate the raw opening tag in `xmlText`.
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
            
            // Decoded (`In &amp; Out` -> `In & Out`), so paths compare equal to the decoded
            // FolderPath values parseTwinCatXml reports.
            const folderAttrs = parseAttrs(attrsContent);
            const folderName = folderAttrs.Name || '';
            
            if (folderName) {
                stack.push(folderName);
                const currentPath = stack.join('\\') + '\\';
                
                folders.push({
                    path: currentPath,
                    name: folderName,
                    startIndex: match.index,
                    length: match[0].length,
                    selfClosing: selfClosing,
                    id: folderAttrs.Id || ''
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
 * @param {string} parentFolderPath Parent folder path (e.g. 'Methods\\Internal\\') or empty string for root
 * (decoded, as getFoldersDetailedFromXml reports it).
 * @param {string} newFolderName Name of the folder to insert (decoded; encoded on the way in).
 * @param {string} newFolderUuid UUID of the new folder.
 * @returns {string} The modified XML text.
 */
function insertFolderIntoXml(xmlText, parentFolderPath, newFolderName, newFolderUuid) {
    const newFolderTag = `<Folder Name="${encodeXmlAttr(newFolderName)}" Id="${newFolderUuid}" />`;

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
        // Expand the parent's OWN tag (raw bytes, attributes and encoding kept) into an open tag.
        const parentTag = xmlText.substring(parentFolder.startIndex, parentFolder.startIndex + parentFolder.length);
        const replacement = `${parentTag.replace(/\s*\/>$/, '>')}\n${indent}  ${newFolderTag}\n${indent}</Folder>`;
        return xmlText.substring(0, parentFolder.startIndex) + replacement + xmlText.substring(parentFolder.startIndex + parentFolder.length);
    } else {
        const insertIndex = parentFolder.startIndex + parentFolder.length;
        return xmlText.substring(0, insertIndex) + `\n${indent}  ${newFolderTag}` + xmlText.substring(insertIndex);
    }
}

/**
 * Splices a member block (Method/Property/Action/Transition) into a POU/Itf at TwinCAT's
 * canonical position: after the last member, BEFORE the <LineIds> group.
 *
 * TwinCAT's XML loader is ORDER-SENSITIVE inside <POU>/<Itf> — the same trap that made root
 * <Folder> tags land after the members and dropped the whole FB from compile, C0004 per member
 * (see insertRootFolderIntoXml). The canonical child order is
 *     Declaration, Implementation, Folder*, member*, LineIds*
 * so the first <LineIds> is the anchor. Files that have none — every .TcIO, since interfaces
 * carry no executable lines, and any POU not yet compiled — fall back to the root close tag.
 *
 * Three things this has to get right, all of which the old `lastIndexOf('</POU>') + splice` got
 * wrong (it appended past the LineIds group, at 6-space indent, leaving `</POU>` at column 0):
 *  - the anchor is the START of the anchor tag's LINE, not the tag index: splicing at the tag
 *    inherits the anchor's own indentation and then strands the anchor without any;
 *  - `memberXml` brings its own 4-space indent and trailing newline, so the seam needs neither;
 *  - line endings follow the document. TwinCAT writes CRLF, and a bare-LF splice leaves the file
 *    mixed — a diff both TwinCAT and version control see, against the byte-fidelity invariant.
 *
 * @param {string} xmlText The source POU/Itf XML text.
 * @param {string} memberXml The complete member block: 4-space indented, newline-terminated.
 * @param {boolean} isItf Whether the parent is an Interface (.TcIO).
 * @returns {string} The modified XML text, or the input unchanged if there is no root close tag.
 */
function insertMemberIntoXml(xmlText, memberXml, isItf) {
    // Search from past the root open tag so nothing in the XML prolog can be mistaken for it.
    const rootOpen = xmlText.match(isItf ? /<Itf\b[^>]*>/ : /<POU\b[^>]*>/);
    const searchFrom = rootOpen ? rootOpen.index + rootOpen[0].length : 0;

    const lineIdsRegex = /<LineIds\b/g;
    lineIdsRegex.lastIndex = searchFrom;
    let anchor = -1;
    let lineIdsMatch;
    while ((lineIdsMatch = lineIdsRegex.exec(xmlText)) !== null) {
        // A `<LineIds` sitting inside a Declaration/Implementation CDATA is ST source text, not the
        // tag — anchoring there would splice the member into the middle of someone's code. CDATA
        // cannot nest, so unbalanced open/close counts before the match mean exactly "inside one".
        const before = xmlText.slice(0, lineIdsMatch.index);
        const opens = (before.match(/<!\[CDATA\[/g) || []).length;
        const closes = (before.match(/\]\]>/g) || []).length;
        if (opens === closes) { anchor = lineIdsMatch.index; break; }
    }
    if (anchor === -1) anchor = xmlText.lastIndexOf(isItf ? '</Itf>' : '</POU>');
    if (anchor === -1) return xmlText;

    while (anchor > 0 && (xmlText[anchor - 1] === ' ' || xmlText[anchor - 1] === '\t')) {
        anchor--;
    }

    const eol = xmlText.includes('\r\n') ? '\r\n' : '\n';
    const block = memberXml.replace(/\r\n/g, '\n').replace(/\n/g, eol);

    return xmlText.substring(0, anchor) + block + xmlText.substring(anchor);
}

/**
 * Inserts a Method, Property, or Action tag as the last member of the root block.
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
    const folderPathAttr = folderPath ? ` FolderPath="${encodeXmlAttr(folderPath)}"` : '';
    // Attribute copy of the name. Member names are IEC identifiers (validated by every caller), so
    // this is the name itself; encoding just keeps the attribute well-formed whatever it is.
    const nameAttr = encodeXmlAttr(name);

    let componentXml = '';
    if (componentType === 'Property') {
        const getUuid = `{${crypto.randomUUID()}}`;
        const setUuid = `{${crypto.randomUUID()}}`;
        if (isItf) {
            componentXml = `    <Property Name="${nameAttr}" Id="${uuid}"${folderPathAttr}>\n      <Declaration><![CDATA[PROPERTY ${name} : INT]]></Declaration>\n      <Get Name="Get" Id="${getUuid}">\n        <Declaration><![CDATA[]]></Declaration>\n      </Get>\n      <Set Name="Set" Id="${setUuid}">\n        <Declaration><![CDATA[]]></Declaration>\n      </Set>\n    </Property>\n`;
        } else {
            componentXml = `    <Property Name="${nameAttr}" Id="${uuid}"${folderPathAttr}>\n      <Declaration><![CDATA[PROPERTY ${name} : INT]]></Declaration>\n      <Get Name="Get" Id="${getUuid}">\n        <Declaration><![CDATA[VAR\nEND_VAR\n]]></Declaration>\n        <Implementation>\n          <ST><![CDATA[]]></ST>\n        </Implementation>\n      </Get>\n      <Set Name="Set" Id="${setUuid}">\n        <Declaration><![CDATA[VAR\nEND_VAR\n]]></Declaration>\n        <Implementation>\n          <ST><![CDATA[]]></ST>\n        </Implementation>\n      </Set>\n    </Property>\n`;
        }
    } else if (componentType === 'Action') {
        if (isItf) {
            componentXml = `    <Action Name="${nameAttr}" Id="${uuid}"${folderPathAttr}>\n    </Action>\n`;
        } else {
            componentXml = `    <Action Name="${nameAttr}" Id="${uuid}"${folderPathAttr}>\n      <Implementation>\n        <ST><![CDATA[]]></ST>\n      </Implementation>\n    </Action>\n`;
        }
    } else { // Method
        if (isItf) {
            componentXml = `    <Method Name="${nameAttr}" Id="${uuid}"${folderPathAttr}>\n      <Declaration><![CDATA[METHOD ${name} : BOOL\n]]></Declaration>\n    </Method>\n`;
        } else {
            componentXml = `    <Method Name="${nameAttr}" Id="${uuid}"${folderPathAttr}>\n      <Declaration><![CDATA[METHOD ${name} : BOOL\nVAR_INPUT\nEND_VAR\n]]></Declaration>\n      <Implementation>\n        <ST><![CDATA[]]></ST>\n      </Implementation>\n    </Method>\n`;
        }
    }

    return insertMemberIntoXml(xmlText, componentXml, isItf);
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
    // Found by decoded Name among the root's members (see findMember), never by a regex built
    // from the name.
    const member = findMember(xmlText, componentType, componentName);
    if (!member) return xmlText;
    const endIndex = member.end;

    // LineIds names are attribute values too: compared decoded, never spliced into a regex. Every
    // LineIds element is visited (a self-closing one is its own whole match, so it can never swallow
    // the next block); only the targets are dropped.
    const removeLineIds = (text, isTarget) =>
        text.replace(/\s*<LineIds\s+Name="([^"]*)"[^>]*?(?:\/>|>[^]*?<\/LineIds>)/g,
            (block, rawName) => (isTarget(decodeXmlAttr(rawName)) ? '' : block));

    if (accessorType) {
        // Deleting only the Get/Set accessor inside the Property block
        const propBlock = xmlText.substring(member.start, endIndex);
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
        const cleanedText = xmlText.substring(0, member.start) + updatedPropBlock + xmlText.substring(endIndex);
        
        // Remove line ids for rootName.componentName.accessorType
        const accessorLineIds = `${rootName}.${componentName}.${accessorType}`;
        return removeLineIds(cleanedText, name => name === accessorLineIds);
    }
    
    // Remove the block and any leading whitespace/newlines before it
    let startIdx = member.start;
    while (startIdx > 0 && (xmlText[startIdx - 1] === ' ' || xmlText[startIdx - 1] === '\t')) {
        startIdx--;
    }
    if (startIdx > 0 && xmlText[startIdx - 1] === '\n') {
        startIdx--;
        if (startIdx > 0 && xmlText[startIdx - 1] === '\r') {
            startIdx--;
        }
    }
    
    const cleanedText = xmlText.substring(0, startIdx) + xmlText.substring(endIndex);
    
    // Remove corresponding LineIds block (`Root.Member` and `Root.Member.<suffix>`)
    const memberLineIds = `${rootName}.${componentName}`;
    return removeLineIds(cleanedText, name => name === memberLineIds || name.startsWith(memberLineIds + '.'));
}

/**
 * Sets, replaces, or removes the FolderPath attribute on a single opening tag string. The tag-level
 * core shared by setComponentFolderPathInXml (drag & drop moves) and insertComponentBlockIntoXml
 * (clipboard paste), so the two features cannot drift on how the attribute is spliced.
 * All splicing is done with string slices (never String.replace with a computed replacement):
 * folder paths contain backslashes and could contain '$', both special in replacement strings.
 * @param {string} tag The component's opening tag (e.g. `<Method Name="Home" Id="{…}">`).
 * @param {string} newFolderPath New virtual folder path (trailing backslash, decoded — it is
 * entity-encoded here), or '' to remove.
 * @returns {string} The modified tag; the input unchanged when there is nothing to change.
 */
function setFolderPathOnTag(tag, newFolderPath) {
    const attrMatch = tag.match(/\sFolderPath="[^"]*"/);
    const encoded = encodeXmlAttr(newFolderPath);
    if (attrMatch) {
        return newFolderPath
            ? tag.slice(0, attrMatch.index) + ` FolderPath="${encoded}"` + tag.slice(attrMatch.index + attrMatch[0].length)
            : tag.slice(0, attrMatch.index) + tag.slice(attrMatch.index + attrMatch[0].length);
    }
    if (!newFolderPath) return tag; // absent + root: nothing to do
    // Insert before the closing '>'. Component tags are never self-closing in real TwinCAT
    // files (they always wrap Declaration/Implementation), but handle '/>' defensively.
    return tag.endsWith('/>')
        ? tag.slice(0, -2).replace(/\s*$/, '') + ` FolderPath="${encoded}" />`
        : tag.slice(0, -1) + ` FolderPath="${encoded}">`;
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
    // Same anchoring as deleteComponentFromXml: the member is found by its decoded Name.
    const member = findMember(xmlText, componentType, componentName);
    if (!member) return xmlText;

    const tag = member.openTag;
    const newTag = setFolderPathOnTag(tag, newFolderPath);
    if (newTag === tag) return xmlText;
    return xmlText.substring(0, member.start) + newTag + xmlText.substring(member.start + tag.length);
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
    // Same anchoring as deleteComponentFromXml/setComponentFolderPathInXml. The span ends at the
    // MATCHING close tag (a defensive self-closing tag is its own complete block).
    const member = findMember(xmlText, componentType, componentName);
    if (!member) return null;
    return xmlText.substring(member.start, member.end);
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
        const nameSpan = attrValueSpan(tag, 'Name');
        if (nameSpan && nameSpan.value === oldName) {
            tag = tag.slice(0, nameSpan.start) + encodeXmlAttr(newName) + tag.slice(nameSpan.end);
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

    // 4. Splice in as the last member, sharing insertComponentIntoXml's placement (canonical
    //    position before the LineIds group) and its convention: 4-space indent on the opening
    //    line, trailing newline. The block's own line endings are normalised to the TARGET
    //    document's by the helper — a copy can cross files with unlike endings.
    return insertMemberIntoXml(targetXml, `    ${newBlock}\n`, isItf);
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

    // Root Name attribute — only its value is spliced, inside the matched root tag only.
    let result = xmlText;
    const nameSpan = attrValueSpan(rootMatch[0], 'Name');
    if (nameSpan) {
        const absStart = rootMatch.index + nameSpan.start;
        result = result.slice(0, absStart) + encodeXmlAttr(newName) + result.slice(rootMatch.index + nameSpan.end);
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
        const rawName = match[2];
        const name = decodeXmlAttr(rawName);
        const nameLower = name.toLowerCase();
        let renamed = null;
        if (nameLower === oldLower) {
            renamed = newName;
        } else if (nameLower.startsWith(oldLower + '.')) {
            renamed = newName + name.slice(oldName.length);
        }
        if (renamed !== null) {
            const valueStart = match.index + match[1].length;
            out += result.slice(last, valueStart) + encodeXmlAttr(renamed);
            last = valueStart + rawName.length;
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

    // Same anchoring as setComponentFolderPathInXml/deleteComponentFromXml: found by decoded Name.
    const member = findMember(xmlText, componentType, componentName);
    if (!member) return xmlText;

    const openTag = member.openTag;
    const openStart = member.start;

    // The component block: opening tag through matching close tag (a Property's Get/Set included),
    // or just the tag when defensively self-closing. Scoping the header rename to THIS block is
    // essential — on the whole file renameFirstHeaderOccurrence would hit the ROOT's <Declaration>.
    const blockEnd = member.end;
    const block = xmlText.substring(openStart, blockEnd);

    // 1. Rewrite the opening tag's Name attribute VALUE (matched tag only) via slice — never a
    //    computed String.replace (the technique in insertComponentBlockIntoXml).
    let newTag = openTag;
    const nameSpan = attrValueSpan(newTag, 'Name');
    if (nameSpan) {
        newTag = newTag.slice(0, nameSpan.start) + encodeXmlAttr(newName) + newTag.slice(nameSpan.end);
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
        const rawName = match[2];
        const name = decodeXmlAttr(rawName);
        const nameLower = name.toLowerCase();
        let renamed = null;
        if (nameLower === oldFullLower) {
            renamed = newFull;
        } else if (nameLower.startsWith(oldFullLower + '.')) {
            renamed = newFull + name.slice(oldFull.length);
        }
        if (renamed !== null) {
            const valueStart = match.index + match[1].length;
            out += result.slice(last, valueStart) + encodeXmlAttr(renamed);
            last = valueStart + rawName.length;
        }
    }
    result = out + result.slice(last);

    return result;
}

/**
 * Deletes a Folder tag from the XML — a self-closing tag alone, or an open tag through its MATCHING
 * `</Folder>` (sub-folders included) — plus the whitespace/newline that leads it.
 * @param {string} xmlText TwinCAT XML text.
 * @param {string} folderPath Virtual folder path, decoded as getFoldersDetailedFromXml reports it
 * (e.g. 'Methods\\Internal\\'; the trailing backslash is optional).
 * @returns {string} The modified XML text.
 */
function deleteFolderTagFromXml(xmlText, folderPath) {
    const parts = folderPath.split('\\').filter(p => p.length > 0);
    if (parts.length === 0) return xmlText;
    // Located by its decoded path through the same nesting walk the tree uses, so a folder whose
    // name holds entities (`In &amp; Out`) is found by the name the user sees.
    const target = getFoldersDetailedFromXml(xmlText).find(f => f.path === parts.join('\\') + '\\');
    if (!target) return xmlText;

    let endIdx;
    if (target.selfClosing) {
        endIdx = target.startIndex + target.length;
    } else {
        const regex = /<Folder\b[^>]*?(\/?)>|<\/Folder>/g;
        regex.lastIndex = target.startIndex + target.length;
        let depth = 1;
        let match = null;
        while (depth > 0 && (match = regex.exec(xmlText)) !== null) {
            if (match[0] === '</Folder>') depth--;
            else if (match[1] !== '/') depth++;
        }
        if (depth > 0 || !match) return xmlText;
        endIdx = match.index + match[0].length;
    }

    let startIdx = target.startIndex;
    while (startIdx > 0 && (xmlText[startIdx - 1] === ' ' || xmlText[startIdx - 1] === '\t')) {
        startIdx--;
    }
    if (startIdx > 0 && xmlText[startIdx - 1] === '\n') {
        startIdx--;
        if (startIdx > 0 && xmlText[startIdx - 1] === '\r') {
            startIdx--;
        }
    }
    return xmlText.substring(0, startIdx) + xmlText.substring(endIdx);
}

/**
 * Renames a virtual folder in place: the target <Folder> tag's Name attribute, plus the FolderPath
 * attribute on every member whose path lies inside the folder. Virtual-folder membership in TwinCAT
 * XML is nothing but the folder nesting and the members' FolderPath attributes — so only the ONE
 * folder tag's Name and the affected FolderPath values change; nested sub-folder tags derive their
 * path from nesting and are left alone, and every other byte is preserved.
 * @param {string} xmlText POU/Interface XML text.
 * @param {string} folderPath Full virtual path of the folder to rename, with trailing backslash
 * (e.g. 'Methods\\Internal\\'), decoded as getFoldersDetailedFromXml reports it.
 * @param {string} newName The new (leaf) folder name (decoded; written entity-encoded).
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

    // 1. Rewrite the folder tag's Name attribute VALUE (matched tag only, encoded) via slice.
    const tag = xmlText.substring(folder.startIndex, folder.startIndex + folder.length);
    const nameSpan = attrValueSpan(tag, 'Name');
    if (!nameSpan) return xmlText;
    const newTag = tag.slice(0, nameSpan.start) + encodeXmlAttr(newName) + tag.slice(nameSpan.end);
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
        const rawValue = match[1];
        const value = decodeXmlAttr(rawValue);
        if (value.startsWith(folderPath)) {
            const newValue = newPath + value.slice(folderPath.length);
            const valueStart = match.index + match[0].indexOf('"') + 1;
            out += result.slice(last, valueStart) + encodeXmlAttr(newValue);
            last = valueStart + rawValue.length;
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
