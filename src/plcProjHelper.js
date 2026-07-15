/**
 * @file plcProjHelper.js
 * @description Helpers to find and synchronize physical files and folders in TwinCAT .plcproj project files.
 */

const vscode = require('vscode');
const path = require('path');

/**
 * Updates a text document with new content using WorkspaceEdit.
 * @param {vscode.TextDocument} document The VS Code text document.
 * @param {string} newText The updated text content.
 * @returns {Thenable<boolean>} A promise that resolves to true if the edit was applied.
 */
function updateDocument(document, newText) {
    if (newText === document.getText()) return Promise.resolve(true);
    const edit = new vscode.WorkspaceEdit();
    const lastLine = document.lineAt(document.lineCount - 1);
    const range = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
    edit.replace(document.uri, range, newText);
    return vscode.workspace.applyEdit(edit);
}

/**
 * Traverses parent directories to locate the closest .plcproj file.
 * @param {string} startPath Starting directory path.
 * @returns {Promise<vscode.Uri|null>} URI of the found .plcproj file, or null.
 */
async function findPlcProjFile(startPath) {
    let currentDir = startPath;
    const maxDepth = 10;
    for (let depth = 0; depth < maxDepth; depth++) {
        try {
            const dirUri = vscode.Uri.file(currentDir);
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
            const plcProjEntry = entries.find(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.plcproj'));
            if (plcProjEntry) {
                return vscode.Uri.joinPath(dirUri, plcProjEntry[0]);
            }
        } catch (e) {
            // ignore
        }
        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
    }
    return null;
}

/**
 * Registers a new file or directory in the closest .plcproj file.
 * @param {vscode.Uri} targetUri The URI of the created file/folder.
 * @param {boolean} isFolder True if registering a folder, false for a file.
 * @returns {Promise<void>}
 */
async function registerInPlcProj(targetUri, isFolder) {
    try {
        const plcProjUri = await findPlcProjFile(path.dirname(targetUri.fsPath));
        if (!plcProjUri) return;

        const doc = await vscode.workspace.openTextDocument(plcProjUri);
        let plcProjText = doc.getText();
        
        const relativePath = path.relative(path.dirname(plcProjUri.fsPath), targetUri.fsPath);
        const projPath = relativePath.split(path.sep).join('\\');
        
        if (isFolder) {
            const folderEsc = projPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const folderRegex = new RegExp(`<Folder\\s+Include="${folderEsc}"\\s*/>`);
            if (folderRegex.test(plcProjText)) return;

            const folderMatch = plcProjText.match(/<Folder Include="[^"]*"\s*\/>/);
            if (folderMatch) {
                const closeItemGroupIdx = plcProjText.indexOf('</ItemGroup>', folderMatch.index);
                if (closeItemGroupIdx !== -1) {
                    let indent = '    ';
                    const lines = plcProjText.substring(0, closeItemGroupIdx).split('\n');
                    const lastLine = lines[lines.length - 1];
                    const indentMatch = lastLine.match(/^(\s*)/);
                    if (indentMatch) {
                        indent = indentMatch[1] || '    ';
                    }
                    const newText = plcProjText.substring(0, closeItemGroupIdx) +
                                    `${indent}<Folder Include="${projPath}" />\n` +
                                    plcProjText.substring(closeItemGroupIdx);
                    await updateDocument(doc, newText);
                    await doc.save();
                }
            }
        } else {
            const compileEsc = projPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const compileRegex = new RegExp(`<Compile\\s+Include="${compileEsc}">`);
            if (compileRegex.test(plcProjText)) return;

            const compileMatch = plcProjText.match(/<Compile Include="[^"]*">/);
            if (compileMatch) {
                const closeItemGroupIdx = plcProjText.indexOf('</ItemGroup>', compileMatch.index);
                if (closeItemGroupIdx !== -1) {
                    let indent = '    ';
                    const lines = plcProjText.substring(0, closeItemGroupIdx).split('\n');
                    let lastLine = '';
                    for (let i = lines.length - 1; i >= 0; i--) {
                        if (lines[i].trim().length > 0) {
                            lastLine = lines[i];
                            break;
                        }
                    }
                    const indentMatch = lastLine.match(/^(\s*)/);
                    if (indentMatch) {
                        indent = indentMatch[1] || '    ';
                    }
                    const newCompileNode = `${indent}<Compile Include="${projPath}">\n${indent}  <SubType>Code</SubType>\n${indent}</Compile>\n`;
                    const newText = plcProjText.substring(0, closeItemGroupIdx) +
                                    newCompileNode +
                                    plcProjText.substring(closeItemGroupIdx);
                    await updateDocument(doc, newText);
                    await doc.save();
                }
            }
        }
    } catch (err) {
        console.error(`Failed to register in plcproj: ${err.message}`);
    }
}

/**
 * Removes a file or directory registration from the closest .plcproj file.
 * @param {vscode.Uri} targetUri The URI of the deleted file/folder.
 * @param {boolean} isFolder True if unregistering a folder, false for a file.
 * @returns {Promise<void>}
 */
async function unregisterFromPlcProj(targetUri, isFolder) {
    try {
        const plcProjUri = await findPlcProjFile(isFolder ? targetUri.fsPath : path.dirname(targetUri.fsPath));
        if (!plcProjUri) return;

        const doc = await vscode.workspace.openTextDocument(plcProjUri);
        let plcProjText = doc.getText();
        
        const relativePath = path.relative(path.dirname(plcProjUri.fsPath), targetUri.fsPath);
        const projPath = relativePath.split(path.sep).join('\\');
        
        const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedPath = escapeRegExp(projPath);
        
        let newText = plcProjText;
        if (isFolder) {
            const folderRegex = new RegExp(`\\s*<Folder\\s+Include="${escapedPath}"\\s*/>`, 'g');
            newText = newText.replace(folderRegex, '');

            const nestedFolderRegex = new RegExp(`\\s*<Folder\\s+Include="${escapedPath}\\\\[^"]*"\\s*/>`, 'g');
            newText = newText.replace(nestedFolderRegex, '');

            const nestedCompileRegex = new RegExp(`\\s*<Compile\\s+Include="${escapedPath}\\\\[^"]*">[^]*?</Compile>`, 'g');
            newText = newText.replace(nestedCompileRegex, '');
        } else {
            const compileRegex = new RegExp(`\\s*<Compile\\s+Include="${escapedPath}">[^]*?</Compile>`, 'g');
            newText = newText.replace(compileRegex, '');
        }
        
        if (newText !== plcProjText) {
            await updateDocument(doc, newText);
            await doc.save();
        }
    } catch (err) {
        console.error(`Failed to unregister from plcproj: ${err.message}`);
    }
}

module.exports = {
    findPlcProjFile,
    registerInPlcProj,
    unregisterFromPlcProj,
    updateDocument
};
