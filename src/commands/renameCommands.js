/**
 * @file renameCommands.js
 * @description Registers the "TwinCAT Objects" explorer rename command (twincat.renameObject, bound
 * to F2). One command dispatches on the selected tree item's contextValue to five shapes of rename:
 *   - a TwinCAT object FILE (.TcPOU/.TcIO/.TcGVL/.TcDUT) — renames the root object inside the XML
 *     (Name attr + declaration header + LineIds via renameRootObjectInXml), renames the file on disk,
 *     re-syncs the .plcproj, and — after a confirmation modal — updates cross-file references;
 *   - a plain .st FILE — a bare on-disk rename (no XML, no .plcproj, no references), because .st files
 *     carry no wrapper and are never .plcproj members;
 *   - a MEMBER (Method/Property/Action/Transition) — renames it in place via renameComponentInXml and,
 *     for Method/Property/Action, offers to update references (Transitions are never referenced);
 *   - a physical DIRECTORY — an on-disk rename plus a .plcproj tree re-registration;
 *   - a VIRTUAL (in-XML) folder — renames the Folder tag and rewrites every member's FolderPath prefix
 *     via renameVirtualFolderInXml.
 *
 * The cross-file reference machinery is layered: the LSP (custom/referencesForSymbol) locates the
 * occurrences from disk, and renameEngine.applyReferenceEditsToXml splices oldName -> newName into the
 * backing CDATA of each file without disturbing a byte outside them. A second query
 * (custom/configReferencesForSymbol) covers the project's NON-CODE objects — visualizations, text
 * lists and task configurations — which name PLC symbols outside any CDATA and are spliced by offset
 * instead. Every structural XML edit still goes through the one byte-preserving writer (applyXmlEdit,
 * or its readXmlText/writeXmlText halves) and the .plcproj stays in sync, exactly as in
 * objectCommands.js / clipboardCommands.js. Deps are injected by extension.js.
 *
 * Cross-file updates are TRANSACTIONAL (renameTransaction.js): every reference and configuration edit
 * is staged first and applied in one pass, so a rename either fully lands or the workspace is put
 * back. A failure mid-apply restores every file already written; a failed on-disk file rename reverts
 * the content edits that preceded it; and a rollback that cannot complete is reported loudly, naming
 * each file left modified and why. Single-file renames (rename-only, Transitions, virtual folders)
 * keep the plain applyXmlEdit — one write has nothing to coordinate.
 */

const vscode = require('vscode');
const path = require('path');
const {
    parseTwinCatXml,
    renameRootObjectInXml,
    renameComponentInXml,
    renameVirtualFolderInXml,
    getFoldersDetailedFromXml
} = require('../xmlParser');
const { applyReferenceEditsToXml } = require('../renameEngine');
const { createRenameTransaction } = require('../renameTransaction');
const { registerInPlcProj, unregisterFromPlcProj, registerTreeInPlcProj } = require('../plcProjHelper');
const { TWINCAT_WATCH_EXTS } = require('../twincatWorkspace');

/** IEC identifier: files and members. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** contextValues classified as renamable TwinCAT object files (the .st path is handled separately). */
const OBJECT_FILE_CONTEXT_VALUES = new Set([
    'pouFile', 'pouFileProgram', 'pouFileFunction', 'itfFile', 'gvlFile', 'dutFile'
]);

/**
 * Registers the TwinCAT Objects explorer rename command.
 * @param {vscode.ExtensionContext} context The extension context.
 * @param {object} deps Injected collaborators owned by extension.js.
 * @param {vscode.TreeView<any>} deps.treeView The Objects tree view (F2 carries no item argument, so
 * the current selection stands in).
 * @param {any} deps.treeProvider The Objects tree data provider (refreshed after edits).
 * @param {(fileUri: vscode.Uri, xmlModifier: (xml: string) => string) => Promise<void>} deps.applyXmlEdit
 * The byte-preserving XML editor from objectCommands.js (single-file renames).
 * @param {(fileUri: vscode.Uri) => Promise<string>} deps.readXmlText The read half of that writer,
 * used at stage time by the rollback transaction.
 * @param {(fileUri: vscode.Uri, newText: string) => Promise<void>} deps.writeXmlText The write half,
 * used at apply time.
 * @param {() => (import('vscode-languageclient/node').LanguageClient | undefined)} deps.getClient
 * Closure over the (possibly not-yet-started) LSP client — mirrors registerLibraryCommands.
 */
function registerRenameCommands(context, { treeView, treeProvider, applyXmlEdit, readXmlText, writeXmlText, getClient }) {
    context.subscriptions.push(
        vscode.commands.registerCommand('twincat.renameObject', async (item) => {
            // F2 passes nothing, so the current selection stands in; no selection at all means nothing
            // to rename.
            const node = item || (treeView.selection && treeView.selection[0]);
            if (!node) return;

            const cv = node.contextValue || '';
            try {
                if (cv === 'stFile') {
                    await renameStFile(node);
                } else if (OBJECT_FILE_CONTEXT_VALUES.has(cv)) {
                    await renameObjectFile(node);
                } else if (cv === 'component' || cv === 'propertyNode') {
                    await renameMember(node);
                } else if (cv === 'directory') {
                    await renameDirectory(node);
                } else if (cv.startsWith('pouVirtualFolder')) {
                    await renameVirtualFolder(node);
                } else {
                    // Everything else (accessors are 'component' and refused inside renameMember).
                    vscode.window.setStatusBarMessage('This item cannot be renamed', 3000);
                }
            } catch (err) {
                // A failed rename must not be silent: the user just performed an explicit gesture.
                console.error('TwinCAT: rename failed:', err);
                vscode.window.showErrorMessage(`Failed to rename: ${err.message}`);
            }
        })
    );

    // ---- File-level renames -------------------------------------------------------------------

    /**
     * Renames a TwinCAT object file: rewrites the root object inside the XML, optionally updates
     * cross-file references, renames the file on disk, and re-syncs the .plcproj.
     * @param {vscode.TreeItem & { resourceUri: vscode.Uri }} node
     */
    async function renameObjectFile(node) {
        const fileUri = node.resourceUri;
        const ext = path.extname(fileUri.fsPath); // keep original casing (.TcPOU, .TcGVL, …)
        const oldStem = path.basename(fileUri.fsPath, ext);

        // Parse first: the ROOT name is the symbol truth the reference query keys on, and a file that
        // does not parse must be refused rather than guessed at.
        let document;
        try {
            document = await vscode.workspace.openTextDocument(fileUri);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
            return;
        }
        const parsed = parseTwinCatXml(document.getText());
        if (!parsed || !parsed.rootName) {
            vscode.window.setStatusBarMessage('This file is not a recognized TwinCAT object', 3000);
            return;
        }
        const rootName = parsed.rootName;

        const newName = await promptFileStem(fileUri, ext);
        if (!newName) return;

        // Confirm what happens to references before touching anything on disk.
        await saveDirtyTwinCatDocs();
        const spec = { rootName, fileUri: fileUri.toString() };
        const result = await queryReferences(spec);
        // Configuration objects (visualizations, text lists, task configs) reference objects by name
        // too, but only ask for them when the CODE query resolved: an unresolved code query already
        // routes to the rename-only fallback, and a half-update (code stale, config changed) must
        // never happen. A missing/failing config query is treated as zero occurrences and never
        // blocks the rename.
        const configOccs = result.resolved ? await queryConfigReferences(spec) : [];
        const decision = await confirmReferences(rootName, result, configOccs);
        if (decision.mode === 'abort') return;

        const tally = newTally();
        // Holds the applied transaction (null on the rename-only path) so a failed disk rename below
        // can put the content edits back.
        /** @type {ReturnType<typeof createXmlTransaction>|null} */
        let appliedTxn = null;
        if (decision.mode === 'updateRefs') {
            const ctx = createXmlTransaction();
            await stageReferenceUpdates(ctx.stageXml, fileUri, rootName, newName, decision.refs, false, tally, (xml) =>
                renameRootObjectInXml(xml, newName));
            // Config edits must land BEFORE the on-disk rename below — every config object references
            // the OLD uri, exactly as the code references do.
            await stageConfigUpdates(ctx.stageXml, configOccs, rootName, newName, tally);
            // Nothing on disk has changed yet: a failed apply has already restored itself, so the
            // rename stops here, before the file rename and the .plcproj re-sync.
            const res = await ctx.txn.apply();
            // `=== false`, not `!res.ok`: only an explicit comparison narrows the result union under
            // the type-check gate's JSDoc parsing.
            if (res.ok === false) {
                reportApplyFailure(res, ctx.displayPath, rootName);
                return;
            }
            appliedTxn = ctx;
        } else {
            // Rename-only: the object's own XML and file name must still stay in sync. Configuration
            // objects are left untouched by the user's explicit choice.
            await applyXmlEdit(fileUri, (xml) => renameRootObjectInXml(xml, newName));
        }

        // Rename on disk AFTER the XML writes (which opened/saved the old uri), then re-sync .plcproj.
        const newUri = vscode.Uri.file(path.join(path.dirname(fileUri.fsPath), newName + ext));
        if (!(await renameFileOnDisk(fileUri, newUri))) {
            // The references now name a file that kept its old name — undo them rather than leave the
            // workspace inconsistent. renameFileOnDisk has already reported its own error.
            if (appliedTxn) reportRevertOutcome(await appliedTxn.txn.revert(), appliedTxn.displayPath);
            return;
        }
        await unregisterFromPlcProj(fileUri, false);
        await registerInPlcProj(newUri, false);
        treeProvider.refresh();

        reportRename(oldStem, newName, decision.mode === 'updateRefs' ? tally : null, 0);
        warnUncovered(tally, newName);
    }

    /**
     * Renames a plain .st file: an on-disk rename only. .st files carry no XML wrapper to rewrite and
     * are never registered in a .plcproj, so neither step applies here.
     * @param {vscode.TreeItem & { resourceUri: vscode.Uri }} node
     */
    async function renameStFile(node) {
        const fileUri = node.resourceUri;
        const ext = path.extname(fileUri.fsPath);
        const oldStem = path.basename(fileUri.fsPath, ext);

        const newName = await promptFileStem(fileUri, ext);
        if (!newName) return;

        const newUri = vscode.Uri.file(path.join(path.dirname(fileUri.fsPath), newName + ext));
        if (!(await renameFileOnDisk(fileUri, newUri))) return;
        treeProvider.refresh();
        vscode.window.setStatusBarMessage(`Renamed ${oldStem}${ext} → ${newName}${ext}`, 4000);
    }

    // ---- Member rename ------------------------------------------------------------------------

    /**
     * Renames a Method/Property/Action/Transition in place, and — for Method/Property/Action — offers
     * to update cross-file references (interface/override declarations are structurally renamed too).
     * @param {vscode.TreeItem & { resourceUri: vscode.Uri, componentId?: string }} node
     */
    async function renameMember(node) {
        const fileUri = node.resourceUri;
        if (!node.componentId) {
            vscode.window.setStatusBarMessage('This item cannot be renamed', 3000);
            return;
        }

        let document;
        try {
            document = await vscode.workspace.openTextDocument(fileUri);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
            return;
        }
        const parsed = parseTwinCatXml(document.getText());
        if (!parsed) {
            vscode.window.setStatusBarMessage('This file is not a recognized TwinCAT object', 3000);
            return;
        }
        const comp = parsed.components.find(c => c.id === node.componentId);
        if (!comp) {
            vscode.window.setStatusBarMessage('This item no longer exists', 3000);
            return;
        }
        // A Get/Set accessor is renamed with its property, never on its own.
        if (comp.xmlContext.accessorType) {
            vscode.window.setStatusBarMessage('Get/Set accessors are renamed with their property', 3000);
            return;
        }

        const componentType = comp.xmlContext.subType; // 'Method' | 'Property' | 'Action' | 'Transition'
        const oldName = comp.xmlContext.subName;       // the real member name, never the display label
        if (!componentType || !oldName) {
            vscode.window.setStatusBarMessage('This item cannot be renamed', 3000);
            return;
        }

        // Collision domain: the root object name plus every member's real name, minus this member's own
        // name (excluded by EXACT match so a case-only rename is allowed).
        const names = [parsed.rootName];
        for (const c of parsed.components) {
            if (c.xmlContext && c.xmlContext.subName) names.push(c.xmlContext.subName);
        }
        const collision = buildCollisionSet(names, oldName);

        const newName = await vscode.window.showInputBox({
            title: `TwinCAT — Rename ${componentType}`,
            ignoreFocusOut: true,
            value: oldName,
            prompt: `New name for ${componentType.toLowerCase()} "${oldName}"`,
            validateInput: (val) => {
                const v = val || '';
                if (!IDENT_RE.test(v)) return 'Enter a valid identifier (letters, digits or underscore; not starting with a digit)';
                if (v === oldName) return 'Enter a different name';
                if (collision.has(v.toLowerCase())) return `"${v}" already exists in ${parsed.rootName}`;
                return null;
            }
        });
        if (!newName) return;

        // Transitions are never referenced by name from code — no query, no modal.
        if (componentType === 'Transition') {
            await applyXmlEdit(fileUri, (xml) =>
                renameComponentInXml(xml, parsed.rootName, 'Transition', oldName, newName));
            treeProvider.refresh();
            vscode.window.setStatusBarMessage(`Renamed ${oldName} → ${newName}`, 4000);
            return;
        }

        await saveDirtyTwinCatDocs();
        const spec = {
            rootName: parsed.rootName,
            fileUri: fileUri.toString(),
            member: { kind: componentType, name: oldName }
        };
        const result = await queryReferences(spec);
        // Members are referenced from visualizations and text lists too (see renameObjectFile for why
        // the config query is gated on a resolved code query).
        const configOccs = result.resolved ? await queryConfigReferences(spec) : [];
        const decision = await confirmReferences(oldName, result, configOccs);
        if (decision.mode === 'abort') return;

        const tally = newTally();
        if (decision.mode === 'updateRefs') {
            const ctx = createXmlTransaction();
            // propagateDeclRenames: true — an interface/override declaration of the same member in a
            // related object is renamed structurally so the two never drift apart.
            await stageReferenceUpdates(ctx.stageXml, fileUri, oldName, newName, decision.refs, true, tally, (xml, selfResult) => {
                // Complete the self file's own member rename, unless the engine already did it via a
                // diverted declaration-header occurrence.
                const already = selfResult.renamedDeclComponents.some(d =>
                    d.componentType === componentType && d.componentName.toLowerCase() === oldName.toLowerCase());
                return already ? xml : renameComponentInXml(xml, parsed.rootName, componentType, oldName, newName);
            });
            // Members carry no on-disk file rename, so ordering vs a disk move is moot here; config
            // edits simply follow the code edits.
            await stageConfigUpdates(ctx.stageXml, configOccs, oldName, newName, tally);
            // No disk rename follows, so a failed apply (already rolled back) simply ends the rename
            // before the tree refresh and the success report.
            const res = await ctx.txn.apply();
            if (res.ok === false) {
                reportApplyFailure(res, ctx.displayPath, oldName);
                return;
            }
        } else {
            await applyXmlEdit(fileUri, (xml) =>
                renameComponentInXml(xml, parsed.rootName, componentType, oldName, newName));
        }

        treeProvider.refresh();
        reportRename(oldName, newName, decision.mode === 'updateRefs' ? tally : null, tally.structuralFiles.size);
        warnUncovered(tally, newName);
    }

    // ---- Folder renames -----------------------------------------------------------------------

    /**
     * Renames a physical directory on disk and re-registers its whole tree under the new prefix in the
     * closest .plcproj. Never touches references.
     * @param {vscode.TreeItem & { resourceUri: vscode.Uri }} node
     */
    async function renameDirectory(node) {
        const dirUri = node.resourceUri;
        const oldName = path.basename(dirUri.fsPath);

        const parentUri = vscode.Uri.file(path.dirname(dirUri.fsPath));
        const entries = await vscode.workspace.fs.readDirectory(parentUri);
        const collision = new Set();
        for (const [name] of entries) {
            if (name === oldName) continue; // exact-match exclusion allows a case-only rename
            collision.add(name.toLowerCase());
        }

        const raw = await vscode.window.showInputBox({
            title: 'TwinCAT — Rename Folder',
            ignoreFocusOut: true,
            value: oldName,
            prompt: `New name for folder "${oldName}"`,
            validateInput: makeFolderValidator(oldName, collision)
        });
        if (!raw) return;
        const newName = raw.trim();

        const newUri = vscode.Uri.file(path.join(path.dirname(dirUri.fsPath), newName));
        if (!(await renameFileOnDisk(dirUri, newUri))) return;
        await unregisterFromPlcProj(dirUri, true);
        await registerTreeInPlcProj(newUri);
        treeProvider.refresh();
        vscode.window.setStatusBarMessage(`Renamed ${oldName} → ${newName}`, 4000);
    }

    /**
     * Renames a virtual (in-XML) folder: the Folder tag's Name and every member's FolderPath prefix.
     * Never touches references. The node carries the FILE in resourceUri and the folder's path (with a
     * trailing backslash) in folderPath.
     * @param {vscode.TreeItem & { resourceUri: vscode.Uri, folderPath?: string }} node
     */
    async function renameVirtualFolder(node) {
        const fileUri = node.resourceUri;
        const folderPath = node.folderPath || '';
        if (!folderPath) {
            vscode.window.setStatusBarMessage('This item cannot be renamed', 3000);
            return;
        }
        // folderPath is `A\B\` — the current leaf is the last segment; its siblings sit one level under
        // the same parent prefix.
        const segments = folderPath.replace(/\\+$/, '').split('\\');
        const oldLeaf = segments[segments.length - 1];
        const parentPrefix = segments.slice(0, -1).join('\\');

        let document;
        try {
            document = await vscode.workspace.openTextDocument(fileUri);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
            return;
        }
        const collision = new Set();
        for (const f of getFoldersDetailedFromXml(document.getText())) {
            const parts = f.path.replace(/\\+$/, '').split('\\');
            const isSibling = parts.length === segments.length && parts.slice(0, -1).join('\\') === parentPrefix;
            if (!isSibling || f.name === oldLeaf) continue; // exact-match exclusion allows case-only rename
            collision.add(f.name.toLowerCase());
        }

        const raw = await vscode.window.showInputBox({
            title: 'TwinCAT — Rename Virtual Folder',
            ignoreFocusOut: true,
            value: oldLeaf,
            prompt: `New name for virtual folder "${oldLeaf}"`,
            validateInput: makeFolderValidator(oldLeaf, collision)
        });
        if (!raw) return;
        const newName = raw.trim();

        await applyXmlEdit(fileUri, (xml) => renameVirtualFolderInXml(xml, folderPath, newName));
        treeProvider.refresh();
        vscode.window.setStatusBarMessage(`Renamed ${oldLeaf} → ${newName}`, 4000);
    }

    // ---- Reference-update plumbing ------------------------------------------------------------

    /**
     * Builds the transaction context for ONE rename operation: the transaction itself, a staging
     * helper that takes real Uris, and the key → real-path lookup every user-facing message uses.
     *
     * The key is `fsPath.toLowerCase()` and is an IDENTITY key only (win32 is case-insensitive):
     * nothing is ever read, written or displayed FROM it. `keyToUri` remembers the first real Uri seen
     * for a key, and both io halves and displayPath resolve through that, so the on-disk spelling is
     * never replaced by the lowercased one.
     * @returns {{ txn: import('../renameTransaction').RenameTransaction,
     *             stageXml: (targetUri: vscode.Uri, modify: (xml: string) => string) => Promise<void>,
     *             displayPath: (key: string) => string }}
     */
    function createXmlTransaction() {
        /** @type {Map<string, vscode.Uri>} */
        const keyToUri = new Map();
        const uriFor = (key) => {
            const uri = keyToUri.get(key);
            if (!uri) throw new Error(`no file is registered for "${key}"`);
            return uri;
        };
        const txn = createRenameTransaction({
            read: (key) => readXmlText(uriFor(key)),
            write: (key, text) => writeXmlText(uriFor(key), text)
        });
        return {
            txn,
            stageXml: (targetUri, modify) => {
                const key = targetUri.fsPath.toLowerCase();
                if (!keyToUri.has(key)) keyToUri.set(key, targetUri);
                return txn.stage(key, modify);
            },
            // Every key a result can name came through stageXml, so the fallback is unreachable; it is
            // there only so a message can never be the reason a failure report is lost.
            displayPath: (key) => {
                const uri = keyToUri.get(key);
                return uri ? uri.fsPath : key;
            }
        };
    }

    /**
     * Stages the oldName -> newName splices for every referencing file, then the self file's own
     * structural rename. Other files are staged first; the self file is staged last so its reference
     * splices and its structural rename land in a single write. Nothing is written here — the caller
     * applies the transaction — but the modifiers run at STAGE time, so `tally` is filled in now and
     * is only reported once the apply succeeds.
     * @param {(targetUri: vscode.Uri, modify: (xml: string) => string) => Promise<void>} stageXml
     * @param {vscode.Uri} selfUri The file being renamed.
     * @param {string} oldName The symbol's current name.
     * @param {string} newName The new name.
     * @param {Array<{uri: string, range: Object}>} refs References to update (declaration already removed).
     * @param {boolean} propagate propagateDeclRenames — true for members (interface/override decls).
     * @param {Tally} tally Accumulator, mutated in place.
     * @param {(xml: string, selfResult: ReturnType<typeof applyReferenceEditsToXml>) => string} finishSelf
     * Applied to the self file after the reference splices to complete the structural rename.
     */
    async function stageReferenceUpdates(stageXml, selfUri, oldName, newName, refs, propagate, tally, finishSelf) {
        const byUri = groupOccurrencesByUri(refs);
        const selfKey = selfUri.fsPath.toLowerCase();
        const selfOccs = [];

        for (const [uriStr, occs] of byUri) {
            const targetUri = vscode.Uri.parse(uriStr);
            if (targetUri.fsPath.toLowerCase() === selfKey) {
                for (const o of occs) selfOccs.push(o);
                continue;
            }
            await stageXml(targetUri, (xml) => {
                const r = applyReferenceEditsToXml(xml, occs, { oldName, newName, propagateDeclRenames: propagate });
                collectResult(tally, targetUri, r);
                return r.xmlText;
            });
        }

        await stageXml(selfUri, (xml) => {
            const r = applyReferenceEditsToXml(xml, selfOccs, { oldName, newName, propagateDeclRenames: propagate });
            collectResult(tally, selfUri, r);
            return finishSelf(r.xmlText, r);
        });
    }

    /**
     * Stages the oldName -> newName splices for every configuration object (visualization, text list
     * or task config) that references the symbol. Each file is staged once (grouped by uri) and gets
     * one byte-preserving write when the transaction applies; occurrences are guarded per-position by
     * spliceConfigOccurrences, so a stale offset is skipped (folded into tally.uncovered), never
     * written. These files are not LSP-indexed or watched, so there is nothing to reindex afterwards.
     * @param {(targetUri: vscode.Uri, modify: (xml: string) => string) => Promise<void>} stageXml
     * @param {Array<{uri: string, offset: number, length: number, chain: string}>} configOccs
     * @param {string} oldName The symbol's current name (the segment each occurrence's length spans).
     * @param {string} newName The new name.
     * @param {Tally} tally Accumulator, mutated in place (configApplied / configFiles / uncovered).
     */
    async function stageConfigUpdates(stageXml, configOccs, oldName, newName, tally) {
        const byUri = groupConfigOccurrencesByUri(configOccs);
        for (const [uriStr, occs] of byUri) {
            const targetUri = vscode.Uri.parse(uriStr);
            await stageXml(targetUri, (xml) => spliceConfigOccurrences(xml, occs, oldName, newName, tally));
        }
    }

    /**
     * Runs the reference query against the LSP. A missing client or any transport failure is treated
     * as "unresolved" so the caller falls back to a rename-only path rather than throwing.
     * @param {{ rootName: string, fileUri: string, member?: { kind: string, name: string } }} spec
     * @returns {Promise<{resolved: boolean, references: Array<Object>, declaration: Object|null}>}
     */
    async function queryReferences(spec) {
        const client = getClient();
        const unresolved = { resolved: false, references: [], declaration: null };
        if (!client) return unresolved;
        try {
            const r = await client.sendRequest('custom/referencesForSymbol', spec);
            return r || unresolved;
        } catch (e) {
            console.error('TwinCAT: referencesForSymbol failed:', e);
            return unresolved;
        }
    }

    /**
     * Runs the configuration-object reference query against the LSP (visualizations, text lists and
     * task configs). Any missing client, transport failure or unresolved response yields zero
     * occurrences — these updates are strictly additive and must never block or fail a rename the code
     * path already accepted.
     * @param {{ rootName: string, fileUri: string, member?: { kind: string, name: string } }} spec
     * The SAME spec shape as queryReferences.
     * @returns {Promise<Array<{uri: string, offset: number, length: number, chain: string}>>}
     */
    async function queryConfigReferences(spec) {
        const client = getClient();
        if (!client) return [];
        try {
            const r = await client.sendRequest('custom/configReferencesForSymbol', spec);
            if (r && r.resolved && Array.isArray(r.occurrences)) return r.occurrences;
            return [];
        } catch (e) {
            console.error('TwinCAT: configReferencesForSymbol failed:', e);
            return [];
        }
    }
}

// ===== Pure helpers (no injected deps) =========================================================

/**
 * @typedef {{ applied: number, updatedFiles: Set<string>, structuralFiles: Set<string>, uncovered: number,
 *             configApplied: number, configFiles: Set<string> }} Tally
 */

/**
 * A fresh reference-update accumulator. `configApplied`/`configFiles` track splices into the non-code
 * configuration objects (visualizations, text lists, task configs).
 */
function newTally() {
    return {
        applied: 0, updatedFiles: new Set(), structuralFiles: new Set(), uncovered: 0,
        configApplied: 0, configFiles: new Set()
    };
}

/**
 * Folds one applyReferenceEditsToXml result into the running tally: spliced count, files that actually
 * changed, files that got a structural (interface/override) declaration rename, and uncovered skips.
 * @param {Tally} tally
 * @param {vscode.Uri} uri The file the result belongs to.
 * @param {ReturnType<typeof applyReferenceEditsToXml>} r
 */
function collectResult(tally, uri, r) {
    const key = uri.fsPath.toLowerCase();
    tally.applied += r.applied;
    if (r.applied > 0) tally.updatedFiles.add(key);
    if (r.renamedDeclComponents.length > 0) tally.structuralFiles.add(key);
    for (const s of r.skipped) {
        // Skips flagged coveredByStructuralRename are expected (a synthesized declaration line the
        // structural rename handles) — only genuinely uncovered skips are user-facing problems.
        if (!s.coveredByStructuralRename) tally.uncovered++;
    }
}

/**
 * Groups reference occurrences by file uri, projecting each LSP range to its 0-based start position —
 * the raw-ST-unit coordinate renameEngine consumes.
 * @param {Array<{uri: string, range: {start: {line: number, character: number}}}>} refs
 * @returns {Map<string, Array<{line: number, character: number}>>}
 */
function groupOccurrencesByUri(refs) {
    const byUri = new Map();
    for (const r of refs) {
        let arr = byUri.get(r.uri);
        if (!arr) { arr = []; byUri.set(r.uri, arr); }
        arr.push({ line: r.range.start.line, character: r.range.start.character });
    }
    return byUri;
}

/** True when ch is an IEC identifier character; undefined (a string bound) counts as a non-word char. */
function isWordChar(ch) {
    return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Splices oldName -> newName at each guarded configuration-object occurrence in one file's text. The LSP
 * hands back JS-string offsets into the file's BOM-stripped text — the exact coordinate space
 * applyXmlEdit's modifier receives (document.getText() drops the BOM) — so no line mapping is needed;
 * each occurrence already spans exactly the one segment to replace (a dotted-chain segment in a
 * visualization or text list, the bare POU name in a task config).
 *
 * Occurrences are applied in DESCENDING offset order so an earlier splice never shifts a not-yet-applied
 * offset even when newName differs in length from oldName. Every occurrence is guarded before it is
 * written, mirroring renameEngine.spliceGroup: the segment at [offset, offset+length) must equal oldName
 * case-insensitively AND both neighbouring characters must be non-identifier chars (a preceding `.` for a
 * member segment, `"` for a path start or `>` for a task's `<Name>`, and any non-word char after, are all
 * allowed — only identifier chars are rejected, so a longer name is never partly overwritten). A mismatch
 * is counted as an uncovered skip and never written, so a stale or fabricated offset can only ever be
 * skipped, never corrupt a file.
 * @param {string} xml The file's current text (BOM-stripped, as applyXmlEdit supplies).
 * @param {Array<{uri: string, offset: number, length: number, chain: string}>} occs One file's occurrences.
 * @param {string} oldName The symbol's current name (the segment each occurrence's length was measured on).
 * @param {string} newName The new name.
 * @param {Tally} tally Accumulator, mutated in place: configApplied / configFiles on success, uncovered
 * on skip.
 * @returns {string} The spliced text (identical to the input outside the replaced segments).
 */
function spliceConfigOccurrences(xml, occs, oldName, newName, tally) {
    const oldLower = oldName.toLowerCase();
    const sorted = occs.slice().sort((a, b) => b.offset - a.offset);
    let out = xml;
    let localApplied = 0;
    for (const o of sorted) {
        const offset = o.offset;
        const end = offset + o.length;
        const segment = out.slice(offset, end);
        const before = offset > 0 ? out[offset - 1] : undefined;
        const after = out[end];
        if (segment.toLowerCase() !== oldLower || isWordChar(before) || isWordChar(after)) {
            tally.uncovered++;
            continue;
        }
        out = out.slice(0, offset) + newName + out.slice(end);
        localApplied++;
        tally.configApplied++;
    }
    if (localApplied > 0 && occs.length > 0) tally.configFiles.add(configUriKey(occs[0].uri));
    return out;
}

/**
 * Groups configuration-object occurrences by file uri, preserving the whole occurrence record
 * (offset/length are needed by the splice), so each file can be edited in a single byte-preserving write.
 * @param {Array<{uri: string, offset: number, length: number, chain: string}>} occs
 * @returns {Map<string, Array<{uri: string, offset: number, length: number, chain: string}>>}
 */
function groupConfigOccurrencesByUri(occs) {
    const byUri = new Map();
    for (const o of occs) {
        let arr = byUri.get(o.uri);
        if (!arr) { arr = []; byUri.set(o.uri, arr); }
        arr.push(o);
    }
    return byUri;
}

/**
 * Distinct-file count over configuration-object occurrence uris, compared by fsPath lowercased (win32 is
 * case-insensitive).
 */
function distinctConfigFileCount(occs) {
    const files = new Set();
    for (const o of occs) files.add(configUriKey(o.uri));
    return files.size;
}

/** Normalizes a uri string to the same file key the reference tally uses: fsPath, lowercased. */
function configUriKey(uriStr) {
    return vscode.Uri.parse(uriStr).fsPath.toLowerCase();
}

/**
 * Runs the references confirmation modal for a symbol whose references have been queried. When the
 * symbol is also used in configuration objects (visualizations, text lists, task configs), the counts
 * are folded into the message and the modal is shown even if there are no CODE references (a
 * visualisation-only symbol still needs the choice). "Rename only" stays available in every branch: it
 * renames the object itself and leaves both code and configuration objects alone.
 * @param {string} displayName The symbol's current name, as shown to the user.
 * @param {{resolved: boolean, references: Array<Object>, declaration: Object|null}} result
 * @param {Array<{uri: string, offset: number, length: number, chain: string}>} [configOccs]
 * Configuration-object occurrences (empty when the code query was unresolved — they were not queried
 * then).
 * @returns {Promise<{mode: 'abort'|'renameOnly'|'updateRefs', refs: Array<Object>}>}
 */
async function confirmReferences(displayName, result, configOccs) {
    if (result.resolved === false) {
        const choice = await vscode.window.showWarningMessage(
            `References for "${displayName}" could not be determined.`,
            { modal: true, detail: 'You can still rename the object itself; other files will keep the old name.' },
            'Rename only'
        );
        return choice === undefined ? { mode: 'abort', refs: [] } : { mode: 'renameOnly', refs: [] };
    }

    const refs = excludeDeclaration(result);
    const occs = configOccs || [];
    const n = refs.length;
    const k = occs.length;
    // Neither code nor configuration references: nothing to confirm, rename the object itself silently.
    if (n === 0 && k === 0) {
        return { mode: 'renameOnly', refs };
    }

    const m = distinctFileCount(refs);
    const l = distinctConfigFileCount(occs);
    let message;
    if (n > 0 && k > 0) {
        message = `"${displayName}" is referenced ${n} time(s) in ${m} file(s), plus ${k} reference(s) in ${l} visualisation/configuration file(s).`;
    } else if (n === 0) {
        message = `"${displayName}" is referenced only in visualisations and configuration objects: ${k} reference(s) in ${l} file(s).`;
    } else {
        message = `"${displayName}" is referenced ${n} time(s) in ${m} file(s).`;
    }

    const choice = await vscode.window.showWarningMessage(
        message,
        {
            modal: true,
            detail: '"Rename only" still renames the object itself — its XML and file name must stay in sync — but other files keep the old name.'
        },
        `Rename and update ${n + k} reference(s)`,
        'Rename only'
    );
    if (choice === undefined) return { mode: 'abort', refs };
    if (choice === 'Rename only') return { mode: 'renameOnly', refs };
    return { mode: 'updateRefs', refs };
}

/**
 * Returns the references with the declaration entry removed (at most one, matched by uri string plus
 * exact range equality) so it is not shown to the user as a reference to itself.
 * @param {{references: Array<Object>, declaration: Object|null}} result
 * @returns {Array<Object>}
 */
function excludeDeclaration(result) {
    const refs = (result.references || []).slice();
    const decl = result.declaration;
    if (decl && decl.uri && decl.range) {
        const idx = refs.findIndex(r => r.uri === decl.uri && rangesEqual(r.range, decl.range));
        if (idx !== -1) refs.splice(idx, 1);
    }
    return refs;
}

/** Distinct-file count over reference uris, compared by fsPath lowercased (win32 is case-insensitive). */
function distinctFileCount(refs) {
    const files = new Set();
    for (const r of refs) files.add(vscode.Uri.parse(r.uri).fsPath.toLowerCase());
    return files.size;
}

/** Exact equality of two LSP ranges. */
function rangesEqual(a, b) {
    return !!a && !!b
        && a.start.line === b.start.line && a.start.character === b.start.character
        && a.end.line === b.end.line && a.end.character === b.end.character;
}

/**
 * Prompts for a new file stem, rejecting names already taken in the file's own directory
 * (case-insensitively, excluding the file's current name so a case-only rename is allowed) and the
 * unchanged stem. The extension is fixed; only the stem is edited.
 * @param {vscode.Uri} fileUri The file being renamed.
 * @param {string} ext The file extension to keep (original casing).
 * @returns {Promise<string|undefined>} The new stem, or undefined if the user cancelled.
 */
async function promptFileStem(fileUri, ext) {
    const oldStem = path.basename(fileUri.fsPath, ext);
    const selfName = path.basename(fileUri.fsPath);
    const dirUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const taken = new Set();
    for (const [name] of entries) {
        if (name.toLowerCase() === selfName.toLowerCase()) continue;
        taken.add(name.toLowerCase());
    }
    return vscode.window.showInputBox({
        title: 'TwinCAT — Rename File',
        ignoreFocusOut: true,
        value: oldStem,
        prompt: `New name for ${selfName}`,
        validateInput: (val) => {
            const v = val || '';
            if (!IDENT_RE.test(v)) return 'Enter a valid identifier (letters, digits or underscore; not starting with a digit)';
            if (v === oldStem) return 'Enter a different name';
            if (taken.has((v + ext).toLowerCase())) return `"${v}${ext}" already exists here`;
            return null;
        }
    });
}

/**
 * Renames a file or directory on disk through a WorkspaceEdit (so open editors follow it), refusing to
 * clobber an existing destination. A case-only rename is exempted from the clobber guard: on win32 the
 * destination stats as existing because it IS the same entry.
 * @param {vscode.Uri} oldUri
 * @param {vscode.Uri} newUri
 * @returns {Promise<boolean>} true when the rename was applied.
 */
async function renameFileOnDisk(oldUri, newUri) {
    const oldBase = path.basename(oldUri.fsPath);
    const newBase = path.basename(newUri.fsPath);
    const caseOnly = newBase.toLowerCase() === oldBase.toLowerCase();
    if (!caseOnly) {
        let destinationTaken = true;
        try {
            await vscode.workspace.fs.stat(newUri);
        } catch (err) {
            destinationTaken = false;
        }
        if (destinationTaken) {
            vscode.window.showErrorMessage(`Cannot rename "${oldBase}": "${newUri.fsPath}" already exists.`);
            return false;
        }
    }
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(oldUri, newUri);
    try {
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) throw new Error('the filesystem rename was not applied');
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to rename "${oldBase}": ${err.message}`);
        return false;
    }
}

/**
 * Builds a case-insensitive collision set from candidate names, excluding the old name by EXACT match
 * so a case-only rename (Foo -> foo) is not treated as a collision with itself.
 * @param {string[]} names
 * @param {string} oldName
 * @returns {Set<string>}
 */
function buildCollisionSet(names, oldName) {
    const set = new Set();
    for (const n of names) {
        if (n === oldName) continue;
        set.add(String(n).toLowerCase());
    }
    return set;
}

/**
 * validateInput for folder names (physical and virtual): the objectCommands.js char set, plus the
 * shared "reject the unchanged name / reject a collision" rules. Whitespace is trimmed before every
 * check, matching how the caller trims the accepted value.
 * @param {string} oldName
 * @param {Set<string>} collision Sibling names, lowercased, excluding oldName.
 * @returns {(val: string) => (string|null)}
 */
function makeFolderValidator(oldName, collision) {
    return (val) => {
        const v = (val || '').trim();
        if (v.length === 0) return 'Folder name cannot be empty';
        if (/[\\/:*?"<>|]/.test(v)) return 'Folder name contains invalid characters';
        if (v === oldName) return 'Enter a different name';
        if (collision.has(v.toLowerCase())) return `"${v}" already exists`;
        return null;
    };
}

/**
 * Saves every dirty TwinCAT source document. The reference query reads target files from DISK, so an
 * unsaved edit in another open component would be invisible to it.
 * @returns {Promise<void>}
 */
async function saveDirtyTwinCatDocs() {
    for (const doc of vscode.workspace.textDocuments) {
        if (!doc.isDirty) continue;
        if (TWINCAT_WATCH_EXTS.has(path.extname(doc.uri.fsPath).toLowerCase())) {
            try {
                await doc.save();
            } catch (e) {
                // Best effort: a file that will not save simply keeps its unsaved edits out of the query.
                console.error('TwinCAT: could not save before reference query:', e);
            }
        }
    }
}

/**
 * Shows the success status-bar message. When references were updated, appends the applied/file counts
 * and — for members — how many related objects had their declaration renamed structurally.
 * @param {string} oldName
 * @param {string} newName
 * @param {Tally|null} tally The reference tally, or null for a rename-only (no update) operation.
 * @param {number} structuralCount Number of related objects whose declaration was also renamed (K).
 */
function reportRename(oldName, newName, tally, structuralCount) {
    let msg = `Renamed ${oldName} → ${newName}`;
    if (tally) {
        msg += ` (${tally.applied} reference(s) updated in ${tally.updatedFiles.size} file(s))`;
        if (structuralCount > 0) {
            msg += `; also renamed the declaration in ${structuralCount} related object(s)`;
        }
        if (tally.configApplied > 0) {
            msg += `; ${tally.configApplied} visualisation/configuration reference(s) updated in ${tally.configFiles.size} file(s)`;
        }
    }
    vscode.window.setStatusBarMessage(msg, 4000);
}

/**
 * Reports an aborted apply. The normal case is reassuring — the transaction restored every file it
 * had already written, so nothing changed — and the exception is loud: files the rollback could not
 * restore are named individually, because only the user can put those right.
 * @param {import('../renameTransaction').ApplyFailure} res The failed apply result.
 * @param {(key: string) => string} displayPath Transaction key → the file's real on-disk spelling.
 * @param {string} name The symbol being renamed, as shown to the user.
 */
function reportApplyFailure(res, displayPath, name) {
    const lead = `Rename of "${name}" was aborted: could not update "${displayPath(res.failedKey)}" (${res.reason}).`;
    if (res.rollbackFailures.length > 0) {
        reportRollbackFailures(res.rollbackFailures, displayPath, lead);
        return;
    }
    vscode.window.showErrorMessage(
        `${lead} ${res.rolledBack.length} already-updated file(s) were restored — no files were changed.`);
}

/**
 * Reports the revert that follows a failed on-disk file rename: the content edits had already landed,
 * so leaving them would point every reference at a name the file does not carry. renameFileOnDisk has
 * already shown its own error, so the clean case is only a warning; a failed restore is still loud.
 * @param {import('../renameTransaction').RevertResult} rb
 * @param {(key: string) => string} displayPath Transaction key → the file's real on-disk spelling.
 */
function reportRevertOutcome(rb, displayPath) {
    if (rb.failures.length > 0) {
        reportRollbackFailures(rb.failures, displayPath,
            'The file rename failed after the reference updates had been written.');
        return;
    }
    vscode.window.showWarningMessage(
        `The file rename failed, so all ${rb.reverted.length} updated file(s) were restored to their previous contents.`);
}

/**
 * The loud case both reports share: files that were changed and could NOT be put back. Each is named
 * by its real path with the reason it was left alone, because a silent half-rename is precisely the
 * outcome the transaction exists to prevent.
 * @param {Array<{key: string, reason: string}>} failures
 * @param {(key: string) => string} displayPath Transaction key → the file's real on-disk spelling.
 * @param {string} lead The sentence describing what failed, prepended to the list.
 */
function reportRollbackFailures(failures, displayPath, lead) {
    const list = failures.map(f => `"${displayPath(f.key)}" (${f.reason})`).join(', ');
    vscode.window.showErrorMessage(
        `${lead} ${failures.length} file(s) were changed but could NOT be restored and need review: ${list}`);
}

/**
 * Warns (non-modally) when some occurrences could not be safely spliced. Covered-by-structural-rename
 * skips are expected and never counted here.
 * @param {Tally} tally
 * @param {string} newName
 */
function warnUncovered(tally, newName) {
    if (tally.uncovered > 0) {
        vscode.window.showWarningMessage(
            `${tally.uncovered} occurrence(s) could not be safely updated and were skipped — review references to "${newName}".`);
    }
}

module.exports = { registerRenameCommands };
