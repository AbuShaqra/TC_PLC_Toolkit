/**
 * @file typesCache.js
 * @description In-memory types caching, parsing variable declarations, and crawling workspace POU/GVL/DUT files.
 */

const vscode = require('vscode');
const path = require('path');
const { parseTwinCatXml } = require('./xmlParser');

// The active in-memory cache map
let workspaceTypesCache = {};

/**
 * Returns the current workspace types cache.
 * @returns {Object} Cache map containing POU/GVL/DUT variables, properties, methods, actions.
 */
function getWorkspaceTypesCache() {
    return workspaceTypesCache;
}

/**
 * Sets the active workspace types cache.
 * @param {Object} cache New cache map.
 */
function setWorkspaceTypesCache(cache) {
    workspaceTypesCache = cache;
}

/**
 * Parses variable declaration blocks to extract name and type pairs, supporting arrays, AT bindings, and enums.
 * @param {string} declText Declaration block text content.
 * @returns {Array<Object>} List of declared variables ({ name, type }).
 */
function getDeclaredVariables(declText) {
    const vars = [];
    if (!declText) return vars;
    
    const lines = declText.split('\n');
    for (const line of lines) {
        const cleaned = line.trim();
        if (cleaned.length === 0 || cleaned.startsWith('//') || cleaned.startsWith('(*') || cleaned.startsWith('/*')) {
            continue;
        }
        
        const colonIdx = cleaned.indexOf(':');
        const semiIdx = cleaned.indexOf(';');
        if (colonIdx !== -1 && semiIdx !== -1 && colonIdx < semiIdx) {
            const leftPart = cleaned.substring(0, colonIdx).trim();
            const rightPart = cleaned.substring(colonIdx + 1, semiIdx).trim();
            
            let varNamesPart = leftPart;
            const atIdx = leftPart.toUpperCase().indexOf(' AT ');
            if (atIdx !== -1) {
                varNamesPart = leftPart.substring(0, atIdx).trim();
            }
            
            const names = varNamesPart.split(',').map(n => n.trim()).filter(n => /^[a-zA-Z_][a-zA-Z0-9_]*$/i.test(n));
            names.forEach(name => {
                vars.push({
                    name: name,
                    type: rightPart
                });
            });
        }
    }
    
    // Fallback for Enums
    if (vars.length === 0) {
        let cleanedText = declText.replace(/\/\/.*$/gm, '');
        cleanedText = cleanedText.replace(/\(\*[\s\S]*?\*\)/g, '');
        cleanedText = cleanedText.replace(/\/\*[\s\S]*?\*\//g, '');
        
        const colonIdx = cleanedText.indexOf(':');
        if (colonIdx !== -1) {
            const parenStart = cleanedText.indexOf('(', colonIdx);
            const parenEnd = cleanedText.indexOf(')', parenStart);
            if (parenStart !== -1 && parenEnd !== -1 && parenStart < parenEnd) {
                const enumContent = cleanedText.substring(parenStart + 1, parenEnd);
                const parts = enumContent.split(',');
                for (let part of parts) {
                    part = part.trim();
                    if (part.length === 0) continue;
                    
                    const assignIdx = part.indexOf(':=');
                    let name = part;
                    if (assignIdx !== -1) {
                        name = part.substring(0, assignIdx).trim();
                    }
                    
                    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/i.test(name)) {
                        vars.push({
                            name: name,
                            type: 'Enum Value'
                        });
                    }
                }
            }
        }
    }
    
    return vars;
}

/**
 * Crawls workspace folders to index all TwinCAT code files.
 * @returns {Promise<Object>} The built types map.
 */
async function indexWorkspaceTypes() {
    const typesMap = {};
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return typesMap;

    for (const folder of folders) {
        await scanDirectoryForTypes(folder.uri, typesMap);
    }
    return typesMap;
}

/**
 * Scans directories recursively for TwinCAT files and parses them into the typesMap.
 * @param {vscode.Uri} dirUri Directory URI.
 * @param {Object} typesMap Destination types map.
 * @returns {Promise<void>}
 */
async function scanDirectoryForTypes(dirUri, typesMap) {
    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(dirUri, name);
            if (type === vscode.FileType.Directory) {
                if (name === '.git' || name === 'node_modules' || name === '.vscode') continue;
                await scanDirectoryForTypes(entryUri, typesMap);
            } else if (type === vscode.FileType.File) {
                const ext = path.extname(name).toLowerCase();
                if (['.tcpou', '.tcio', '.tcgvl', '.tcdut', '.tctleo'].includes(ext)) {
                    try {
                        const fileBytes = await vscode.workspace.fs.readFile(entryUri);
                        const content = Buffer.from(fileBytes).toString('utf8');
                        const parsed = parseTwinCatXml(content);
                        if (parsed) {
                            const rootComp = parsed.components.find(c => c.id === 'root');
                            const decl = rootComp ? rootComp.declaration : '';
                            const variables = getDeclaredVariables(decl);
                            
                            const properties = [];
                            const methods = [];
                            const actions = [];
                            
                            parsed.components.forEach(c => {
                                if (c.id === 'root') return;
                                if (c.type === 'Property') {
                                    properties.push(c.name.replace(/\s*\(Property Signature\)$/, ''));
                                } else if (c.type === 'Method') {
                                    methods.push(c.name);
                                } else if (c.type === 'Action') {
                                    actions.push(c.name);
                                }
                            });
                            
                            let specificType = parsed.rootType;
                            if (parsed.rootType === 'POU') {
                                if (/\bPROGRAM\b/i.test(decl)) {
                                    specificType = 'PROGRAM';
                                } else if (/\bFUNCTION_BLOCK\b/i.test(decl)) {
                                    specificType = 'FUNCTION_BLOCK';
                                } else if (/\bFUNCTION\b(?!\s*BLOCK)/i.test(decl)) {
                                    specificType = 'FUNCTION';
                                }
                            }
                            
                            typesMap[parsed.rootName] = {
                                uri: entryUri.toString(),
                                type: specificType,
                                variables: variables,
                                properties: properties,
                                methods: methods,
                                actions: actions
                            };
                        }
                    } catch (e) {
                        // ignore
                    }
                }
            }
        }
    } catch (err) {
        // ignore
    }
}

/**
 * Re-parses a single TwinCAT file and updates its cache entry.
 * @param {vscode.Uri} uri The file URI.
 * @returns {Promise<void>}
 */
async function updateCacheForFile(uri) {
    try {
        const fileBytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(fileBytes).toString('utf8');
        const parsed = parseTwinCatXml(content);
        if (parsed) {
            const rootComp = parsed.components.find(c => c.id === 'root');
            const decl = rootComp ? rootComp.declaration : '';
            const variables = getDeclaredVariables(decl);
            
            const properties = [];
            const methods = [];
            const actions = [];
            
            parsed.components.forEach(c => {
                if (c.id === 'root') return;
                if (c.type === 'Property') {
                    properties.push(c.name.replace(/\s*\(Property Signature\)$/, ''));
                } else if (c.type === 'Method') {
                    methods.push(c.name);
                } else if (c.type === 'Action') {
                    actions.push(c.name);
                }
            });
            
            let specificType = parsed.rootType;
            if (parsed.rootType === 'POU') {
                if (/\bPROGRAM\b/i.test(decl)) {
                    specificType = 'PROGRAM';
                } else if (/\bFUNCTION_BLOCK\b/i.test(decl)) {
                    specificType = 'FUNCTION_BLOCK';
                } else if (/\bFUNCTION\b(?!\s*BLOCK)/i.test(decl)) {
                    specificType = 'FUNCTION';
                }
            }
            
            workspaceTypesCache[parsed.rootName] = {
                uri: uri.toString(),
                type: specificType,
                variables: variables,
                properties: properties,
                methods: methods,
                actions: actions
            };
        }
    } catch (e) {
        // ignore
    }
}

module.exports = {
    getWorkspaceTypesCache,
    setWorkspaceTypesCache,
    getDeclaredVariables,
    indexWorkspaceTypes,
    updateCacheForFile
};
