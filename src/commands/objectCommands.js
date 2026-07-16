/**
 * @file objectCommands.js
 * @description Registers the "TwinCAT Objects" explorer create/delete commands: methods, properties and
 * actions on a POU; new FB/PRG/FUN/ITF/GVL files; physical folders; and virtual (in-XML) folders and
 * components. Every structural edit goes through applyXmlEdit so TwinCAT's XML is preserved byte-for-byte
 * outside the edited region, and through plcProjHelper so the nearest .plcproj stays in sync.
 */

const vscode = require('vscode');
const path = require('path');
const { registerInPlcProj, unregisterFromPlcProj } = require('../plcProjHelper');
const {
    parseTwinCatXml,
    getFoldersDetailedFromXml,
    insertFolderIntoXml,
    insertComponentIntoXml,
    deleteComponentFromXml,
    deleteFolderTagFromXml
} = require('../xmlParser');

/**
 * Registers the TwinCAT Objects explorer create/delete commands.
 * @param {vscode.ExtensionContext} context The extension context.
 * @param {object} deps Injected collaborators owned by extension.js.
 * @param {any} deps.treeProvider The Objects tree data provider (refreshed after edits).
 */
function registerObjectCommands(context, { treeProvider }) {
    // Create Method Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createMethod', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleComponentCreation(node, 'Method');
        })
    );

    // Create Property Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createProperty', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleComponentCreation(node, 'Property');
        })
    );

    // Create Action Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createAction', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleComponentCreation(node, 'Action');
        })
    );

    // Create File FB Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileFB', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'FB');
        })
    );

    // Create File Program Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileProgram', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'PRG');
        })
    );

    // Create File Function Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileFunction', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'FUN');
        })
    );

    // Create File Interface Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileInterface', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'ITF');
        })
    );

    // Create File GVL Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createFileGVL', async (node) => {
            if (!node || !node.resourceUri) return;
            await handleFileCreation(node, 'GVL');
        })
    );

    // Create Physical Folder Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createPhysicalFolder', async (node) => {
            if (!node || !node.resourceUri) return;
            // Every name prompt here sets title + ignoreFocusOut: the quick-input drops down at the
            // top of the window and is easy to miss, and its default focus-out dismissal meant a
            // user who clicked elsewhere (wondering why "nothing happened") silently killed the
            // prompt (user report). The title bar makes the widget taller and self-explaining; the
            // prompt now stays until answered or Esc.
            const folderName = await vscode.window.showInputBox({
                title: 'TwinCAT — Create Folder',
                ignoreFocusOut: true,
                prompt: 'Enter Folder Name',
                placeHolder: 'e.g. MyFolder',
                validateInput: val => {
                    if (!val || val.trim().length === 0) return 'Folder name cannot be empty';
                    if (val.includes('/') || val.includes('\\') || val.includes(':') || val.includes('*') || val.includes('?') || val.includes('"') || val.includes('<') || val.includes('>') || val.includes('|')) {
                        return 'Folder name contains invalid characters';
                    }
                    return null;
                }
            });
            if (!folderName) return;

            const newFolderUri = vscode.Uri.joinPath(node.resourceUri, folderName);
            try {
                await vscode.workspace.fs.createDirectory(newFolderUri);
                await registerInPlcProj(newFolderUri, true);
                treeProvider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to create folder: ${err.message}`);
            }
        })
    );

    // Delete Physical Item Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.deletePhysicalItem', async (node) => {
            if (!node || !node.resourceUri) return;

            const isDir = node.contextValue === 'directory';
            const label = path.basename(node.resourceUri.fsPath);
            const itemType = isDir ? 'folder' : 'file';

            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to delete the ${itemType} "${label}"?`,
                { modal: true },
                'Yes'
            );
            if (answer !== 'Yes') return;

            try {
                await unregisterFromPlcProj(node.resourceUri, isDir);
                await vscode.workspace.fs.delete(node.resourceUri, { recursive: true, useTrash: true });
                treeProvider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to delete ${itemType}: ${err.message}`);
            }
        })
    );

    // Create Virtual Folder Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.createVirtualFolder', async (node) => {
            if (!node || !node.resourceUri) return;

            const folderName = await vscode.window.showInputBox({
                title: 'TwinCAT — Create Virtual Folder',
                ignoreFocusOut: true,
                prompt: 'Enter Folder Name',
                placeHolder: 'e.g. Internal',
                validateInput: val => {
                    if (!val || val.trim().length === 0) return 'Folder name cannot be empty';
                    if (val.includes('\\') || val.includes('/')) return 'Folder name cannot contain slashes';
                    return null;
                }
            });
            if (!folderName) return;

            const fileUri = node.resourceUri;
            const parentFolderPath = (node && node.contextValue && node.contextValue.startsWith('pouVirtualFolder')) ? node.folderPath : '';

            await applyXmlEdit(fileUri, (xmlText) => {
                const uuid = `{${require('crypto').randomUUID()}}`;
                return insertFolderIntoXml(xmlText, parentFolderPath, folderName, uuid);
            });

            treeProvider.refresh();
        })
    );

    // Delete Component Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.deleteComponent', async (node) => {
            if (!node || !node.resourceUri || !node.componentId) return;

            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to delete "${node.label}"?`,
                { modal: true },
                'Yes'
            );
            if (answer !== 'Yes') return;

            const fileUri = node.resourceUri;

            await applyXmlEdit(fileUri, (xmlText) => {
                const parsed = parseTwinCatXml(xmlText);
                if (!parsed) return xmlText;

                const comp = parsed.components.find(c => c.id === node.componentId);
                if (!comp) return xmlText;

                const componentType = comp.xmlContext.subType || comp.type;
                const componentName = comp.xmlContext.subName || comp.name;
                const accessorType = comp.xmlContext.accessorType;
                if (!componentType || !componentName) return xmlText;

                return deleteComponentFromXml(xmlText, parsed.rootName, componentType, componentName, accessorType);
            });

            treeProvider.refresh();
        })
    );

    // Delete Virtual Folder Command
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.deleteVirtualFolder', async (node) => {
            if (!node || !node.resourceUri || !node.folderPath) return;

            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to delete virtual folder "${node.label}" and all its nested sub-components?`,
                { modal: true },
                'Yes'
            );
            if (answer !== 'Yes') return;

            const fileUri = node.resourceUri;
            const targetFolder = node.folderPath;

            await applyXmlEdit(fileUri, (xmlText) => {
                const parsed = parseTwinCatXml(xmlText);
                if (!parsed) return xmlText;

                let cleanedText = xmlText;

                // 1. Delete all sub-components inside this folder
                parsed.components.forEach(c => {
                    if (c.id === 'root') return;
                    if (c.folderPath && c.folderPath.startsWith(targetFolder)) {
                        const componentType = c.xmlContext.subType;
                        const componentName = c.xmlContext.subName;
                        if (componentType && componentName) {
                            cleanedText = deleteComponentFromXml(cleanedText, parsed.rootName, componentType, componentName);
                        }
                    }
                });

                // 2. Delete the Folder tag in the XML matching the folder label
                cleanedText = deleteFolderTagFromXml(cleanedText, targetFolder);

                return cleanedText;
            });

            treeProvider.refresh();
        })
    );

    /**
     * Coordinates the QuickPick selection dialogue and inputs when creating a sub-component.
     * @param {vscode.TreeItem & {folderPath?: string}} node The context tree item.
     * @param {string} componentType 'Method', 'Property', or 'Action'.
     */
    async function handleComponentCreation(node, componentType) {
        const fileUri = node.resourceUri;
        const isItf = path.extname(fileUri.fsPath).toLowerCase() === '.tcio';

        let document;
        try {
            document = await vscode.workspace.openTextDocument(fileUri);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to open document: ${err.message}`);
            return;
        }
        const xmlText = document.getText();

        if (componentType === 'Property') {
            const parsed = parseTwinCatXml(xmlText);
            if (!parsed) return;
            const rootComp = parsed.components.find(c => c.id === 'root');
            if (rootComp && /\bFUNCTION\b(?!\s*BLOCK)/i.test(rootComp.declaration || '')) {
                vscode.window.showWarningMessage(`Properties cannot be created under Functions (FUN) like "${rootComp.name}".`);
                return;
            }
        }

        const name = await vscode.window.showInputBox({
            title: `TwinCAT — Create ${componentType}`,
            ignoreFocusOut: true,
            prompt: `Enter ${componentType} Name`,
            placeHolder: componentType === 'Property' ? 'e.g. MyProperty' : (componentType === 'Method' ? 'e.g. M_DoSomething' : 'e.g. A_DoSomething'),
            validateInput: val => {
                if (!val || val.trim().length === 0) return `${componentType} name cannot be empty`;
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) return 'Invalid identifier';
                return null;
            }
        });
        if (!name) return;

        const existingFolders = getFoldersDetailedFromXml(xmlText).map(f => f.path);

        /** @type {Array<{label:string,description?:string,folderPath?:string,isCreateNew?:boolean}>} */
        const quickPickItems = [
            {
                label: '$(root) [Root / No Folder]',
                description: 'Place at root level',
                folderPath: ''
            },
            {
                label: '$(folder-active) [Create New Folder...]',
                description: 'Create a new virtual folder',
                isCreateNew: true
            }
        ];
        existingFolders.forEach(folder => {
            quickPickItems.push({
                label: `$(folder) ${folder}`,
                folderPath: folder
            });
        });

        const quickPick = vscode.window.createQuickPick();
        quickPick.items = quickPickItems;
        quickPick.title = `TwinCAT — Select folder for ${componentType} "${name}"`;
        // Same rationale as the name prompts above: a focus-out here silently aborted the whole
        // create flow one step before the name prompt.
        quickPick.ignoreFocusOut = true;

        const isFolderNode = node && node.contextValue && node.contextValue.startsWith('pouVirtualFolder');
        if (isFolderNode && node.folderPath) {
            const matchedItem = quickPickItems.find(item => item.folderPath === node.folderPath);
            if (matchedItem) {
                quickPick.activeItems = [matchedItem];
            }
        }

        const selectedItem = await new Promise((resolve) => {
            quickPick.onDidAccept(() => {
                resolve(quickPick.selectedItems[0]);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                resolve(null);
                quickPick.dispose();
            });
            quickPick.show();
        });

        if (!selectedItem) return;

        let targetFolderPath = '';
        let parentPath = '';
        let newFolderName = '';
        let isNewFolder = false;

        if (selectedItem.isCreateNew) {
            newFolderName = await vscode.window.showInputBox({
                title: 'TwinCAT — Create Virtual Folder',
                ignoreFocusOut: true,
                prompt: 'Enter New Folder Name',
                placeHolder: 'e.g. Internal',
                validateInput: val => {
                    if (!val || val.trim().length === 0) return 'Folder name cannot be empty';
                    if (val.includes('\\') || val.includes('/')) return 'Folder name cannot contain slashes';
                    return null;
                }
            });
            if (!newFolderName) return;

            /** @type {Array<{label:string,description?:string,folderPath?:string}>} */
            const parentQuickPickItems = [
                {
                    label: '$(root) [Root / No Folder]',
                    description: 'Place new folder at root level',
                    folderPath: ''
                }
            ];
            existingFolders.forEach(folder => {
                parentQuickPickItems.push({
                    label: `$(folder) ${folder}`,
                    folderPath: folder
                });
            });

            const parentQuickPick = vscode.window.createQuickPick();
            parentQuickPick.items = parentQuickPickItems;
            parentQuickPick.title = `Select parent folder for new folder "${newFolderName}"`;

            if (isFolderNode && node.folderPath) {
                const matchedItem = parentQuickPickItems.find(item => item.folderPath === node.folderPath);
                if (matchedItem) {
                    parentQuickPick.activeItems = [matchedItem];
                }
            }

            const selectedParent = await new Promise((resolve) => {
                parentQuickPick.onDidAccept(() => {
                    resolve(parentQuickPick.selectedItems[0]);
                    parentQuickPick.hide();
                });
                parentQuickPick.onDidHide(() => {
                    resolve(null);
                    parentQuickPick.dispose();
                });
                parentQuickPick.show();
            });

            if (!selectedParent) return;

            parentPath = selectedParent.folderPath;
            targetFolderPath = parentPath ? `${parentPath}${newFolderName}\\` : `${newFolderName}\\`;
            isNewFolder = true;
        } else {
            targetFolderPath = selectedItem.folderPath;
        }

        await applyXmlEdit(fileUri, (currentXml) => {
            let updatedXml = currentXml;
            if (isNewFolder) {
                const folderUuid = `{${require('crypto').randomUUID()}}`;
                updatedXml = insertFolderIntoXml(updatedXml, parentPath, newFolderName, folderUuid);
            }
            return insertComponentIntoXml(updatedXml, fileUri, isItf, name, componentType, targetFolderPath);
        });
    }

    /**
     * Coordinates the file creation dialogue and generates boilerplate XML template.
     * @param {vscode.TreeItem} node The context directory tree item.
     * @param {string} fileType 'FB', 'PRG', 'FUN', 'ITF', or 'GVL'.
     */
    async function handleFileCreation(node, fileType) {
        const dirUri = node.resourceUri;
        const name = await vscode.window.showInputBox({
            title: `TwinCAT — Create ${fileType}`,
            ignoreFocusOut: true,
            prompt: `Enter ${fileType} Name`,
            placeHolder: `e.g. My${fileType}`,
            validateInput: val => {
                if (!val || val.trim().length === 0) return `${fileType} name cannot be empty`;
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) return 'Invalid identifier';
                return null;
            }
        });
        if (!name) return;

        const isItf = fileType === 'ITF';
        const isGvl = fileType === 'GVL';
        const ext = isItf ? '.TcIO' : (isGvl ? '.TcGVL' : '.TcPOU');
        const fileName = name + ext;
        const fileUri = vscode.Uri.joinPath(dirUri, fileName);

        try {
            await vscode.workspace.fs.stat(fileUri);
            vscode.window.showErrorMessage(`File "${fileName}" already exists.`);
            return;
        } catch (err) {
            // File does not exist, safe to create
        }

        const uuid = `{${require('crypto').randomUUID()}}`;
        let xmlContent = '';
        if (fileType === 'FB') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[FUNCTION_BLOCK ${name}
VAR_INPUT
END_VAR
VAR_OUTPUT
END_VAR
VAR
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>\n`;
        } else if (fileType === 'PRG') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[PROGRAM ${name}
VAR
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>\n`;
        } else if (fileType === 'FUN') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <POU Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[FUNCTION ${name} : BOOL
VAR_INPUT
END_VAR
VAR
END_VAR
]]></Declaration>
    <Implementation>
      <ST><![CDATA[]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>\n`;
        } else if (fileType === 'ITF') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <Itf Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[INTERFACE ${name}]]></Declaration>
  </Itf>
</TcPlcObject>\n`;
        } else if (fileType === 'GVL') {
            xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.12">
  <GVL Name="${name}" Id="${uuid}">
    <Declaration><![CDATA[{attribute 'qualified_only'}
VAR_GLOBAL
END_VAR
]]></Declaration>
  </GVL>
</TcPlcObject>\n`;
        }

        try {
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(xmlContent, 'utf8'));
            await registerInPlcProj(fileUri, false);
            treeProvider.refresh();
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to create file: ${err.message}`);
        }
    }
}

/**
 * Applies an XML edit to a file Uri by opening it, modifying it, and saving it to disk.
 * @param {vscode.Uri} fileUri File URI.
 * @param {Function} xmlModifier A function mapping old XML string to new XML string.
 * @returns {Promise<void>}
 */
async function applyXmlEdit(fileUri, xmlModifier) {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const originalText = document.getText();
    const newText = xmlModifier(originalText);

    if (newText !== originalText) {
        const edit = new vscode.WorkspaceEdit();
        const lastLine = document.lineAt(document.lineCount - 1);
        const range = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
        edit.replace(fileUri, range, newText);

        await vscode.workspace.applyEdit(edit);
        await document.save();
    }
}

// applyXmlEdit is exported for the drag & drop controller (extension.js injects it), so every
// structural XML edit — menu command or drop — goes through the one byte-preserving write path.
module.exports = { registerObjectCommands, applyXmlEdit };
