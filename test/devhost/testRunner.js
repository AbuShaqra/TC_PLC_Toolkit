/**
 * @file test/devhost/testRunner.js
 * @description The in-host half of the dev-host harness — runs INSIDE a real VS Code extension
 * host (`--extensionTestsPath`), launched by ./run.js. Traces the custom editor's
 * resolve → ready → init chain and the live LSP-client bridge against a real workspace, the two
 * links no headless harness can reach (test/browser/ drives the webview alone; everything else
 * drives the LSP in-process).
 *
 * Wrote for the 2026-08-10 regression: scan-time symbol nodes carried NORMALIZED (lowercased)
 * uris, so every cross-file Go to Definition opened a DUPLICATE, lowercase-titled tab —
 * "definitions are broken" to a user, invisible to every headless gate (the LSP still resolved,
 * the webview still rendered; only real vscode.openWith() exposes uri-casing identity).
 *
 * Contract with run.js (all via environment variables, which the extension host inherits):
 *   TCDEV_WS      — absolute path of the workspace under test (run.js passes a temp COPY).
 *   TCDEV_RESULTS — absolute path of the results JSON this module writes progressively.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..');
const WS = process.env.TCDEV_WS;
const SAMPLE = process.env.TCDEV_SAMPLE || WS;
const RESULTS = process.env.TCDEV_RESULTS;

const out = { steps: [], panels: [], treeReveals: [] };
function log(step, data) {
    out.steps.push({ step, ...data });
    try { fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)); } catch (e) { /* keep going */ }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
    const vscode = require('vscode');
    try {
        log('start', { ws: WS, folders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.toString()) });

        // Capture the real Objects TreeView's reveal calls before activation creates it. The wrapper
        // still delegates to VS Code, so `ok` proves the provider's getParent chain is accepted—not
        // merely that extension.js attempted to reveal a component-shaped stand-in.
        const origCreateTreeView = vscode.window.createTreeView.bind(vscode.window);
        vscode.window.createTreeView = function (viewId, options) {
            const view = origCreateTreeView(viewId, options);
            if (viewId !== 'twincatExplorer') return view;
            const origReveal = view.reveal.bind(view);
            view.reveal = async (element, revealOptions) => {
                const rec = {
                    uri: element && element.resourceUri && element.resourceUri.toString(),
                    componentId: element && element.componentId,
                    contextValue: element && element.contextValue,
                    parents: []
                };
                let current = element;
                for (let depth = 0; depth < 8 && current; depth++) {
                    current = options.treeDataProvider.getParent(current);
                    if (current) rec.parents.push(current.componentId || current.folderPath || String(current.label));
                }
                out.treeReveals.push(rec);
                try {
                    const result = await origReveal(element, revealOptions);
                    rec.ok = true;
                    return result;
                } catch (e) {
                    rec.ok = false;
                    rec.error = String(e);
                    throw e;
                } finally {
                    try { fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)); } catch (e) { /* keep going */ }
                }
            };
            return view;
        };

        // Patch the provider PROTOTYPE before any custom editor resolves: every future panel's
        // resolve → ready → init chain lands in `panels`. Same module instance as the extension's,
        // because the test shares its extension host and require cache.
        const cep = require(path.join(REPO, 'src', 'customEditorProvider.js'));
        const origResolve = cep.TwinCatCustomEditorProvider.prototype.resolveCustomTextEditor;
        cep.TwinCatCustomEditorProvider.prototype.resolveCustomTextEditor = function (document, panel, token) {
            const rec = { uri: document.uri.toString(), textLen: document.getText().length, fromWebview: [], toWebview: [], resolveThrew: null };
            out.panels.push(rec);
            try {
                panel.webview.onDidReceiveMessage(m => {
                    rec.fromWebview.push(m && m.type);
                    try { fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)); } catch (e) { /* keep going */ }
                });
            } catch (e) { rec.hookErr = String(e); }
            const origPost = panel.webview.postMessage.bind(panel.webview);
            panel.webview.postMessage = (msg) => {
                rec.toWebview.push(msg && msg.type);
                // Keep the payload of an insert: the Objects-tree insert commands are vscode-bound,
                // so this round trip is the only place their whole path (tree node → XML parse →
                // template → panel) can be proven end to end.
                if (msg && msg.type === 'insertText') rec.inserted = (rec.inserted || []).concat(msg.text);
                return origPost(msg);
            };
            try {
                return origResolve.call(this, document, panel, token);
            } catch (e) {
                rec.resolveThrew = String((e && e.stack) || e);
                throw e;
            } finally {
                fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
            }
        };

        // Case-insensitive: VS Code reports the development extensionPath in its own drive-letter
        // casing, which need not match ours.
        const wanted = REPO.replace(/\\/g, '/').toLowerCase();
        const ext = vscode.extensions.all.find(e =>
            path.resolve(e.extensionPath || '').replace(/\\/g, '/').toLowerCase() === wanted);
        if (!ext) { log('no-extension', { paths: vscode.extensions.all.map(e => e.extensionPath).slice(-5) }); return; }
        await ext.activate();
        log('activated', { id: ext.id });

        // Drive the actual VS Code-bound Objects provider over two same-named `.plcproj` copies.
        // The pure formatter has unit coverage, but only this proves the provider renders those labels.
        const { createProjectMap, normalizeProjectPath } = require(path.join(REPO, 'src', 'lsp', 'projectMap.js'));
        const { createSolutionMap } = require(path.join(REPO, 'src', 'solutionMap.js'));
        const { fileUriToFsPath } = require(path.join(REPO, 'src', 'fileUri.js'));
        const { TwinCatTreeDataProvider } = require(path.join(REPO, 'src', 'treeDataProvider.js'));
        const { projectLabel } = require(path.join(REPO, 'src', 'projectStatusBar.js'));
        const projectMap = createProjectMap([WS]);
        const solutionMap = createSolutionMap([WS], projectMap);
        const treeProvider = new TwinCatTreeDataProvider(() => projectMap, () => solutionMap);
        const roots = await treeProvider.getChildren();
        const solutionProjects = {};
        for (const root of roots) {
            if (root.contextValue !== 'solution') continue;
            solutionProjects[String(root.label)] = (await treeProvider.getChildren(root)).map(item => String(item.label));
        }
        const mainA = path.join(SAMPLE, 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
        const mainB = path.join(WS, 'LineB', 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
        const station = path.join(SAMPLE, 'TcToolkitSample_PLC', 'POUs', 'Machine', 'FB_Station.TcPOU');
        const stationProject = projectMap.get(projectMap.projectFor(station));
        log('multi-project-ui', {
            solutionLabels: roots.filter(item => item.contextValue === 'solution').map(item => String(item.label)),
            solutionProjects,
            statusLabels: [projectLabel(projectMap, mainA), projectLabel(projectMap, mainB)],
            indexedStationPath: stationProject && stationProject.objectFiles.get(normalizeProjectPath(station)),
            stationUri: vscode.Uri.file(station).toString()
        });

        const GVL = path.join(SAMPLE, 'TcToolkitSample_PLC', 'GVLs', 'GVL_System.TcGVL');
        const MAIN = path.join(SAMPLE, 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
        const gvlUri = vscode.Uri.file(GVL);

        // 1. Open the GVL as a user would from the Explorer; the chain must complete.
        await vscode.commands.executeCommand('vscode.openWith', gvlUri, 'twincat.xmlViewer');
        await sleep(4000);
        log('after-open', { tabs: vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label)) });

        // 2. The live LSP bridge: definition + references for GVL_System from MAIN, exactly the
        //    params the webview bridge sends. Retries while the server's initial scan finishes.
        const { parseTwinCatXml } = require(path.join(REPO, 'src', 'xmlParser.js'));
        const { convertXmlToSt } = require(path.join(REPO, 'src', 'stConverter.js'));
        const unit = convertXmlToSt(parseTwinCatXml(fs.readFileSync(MAIN, 'utf8')), { raw: true });
        const lines = unit.stText.split('\n');
        const li = lines.findIndex(l => /GVL_System\./.test(l));
        const params = {
            code: unit.stText,
            position: { line: li, character: lines[li].indexOf('GVL_System') + 1 },
            fileUri: vscode.Uri.file(MAIN).toString()
        };
        let def = null;
        for (let attempt = 0; attempt < 12 && !def; attempt++) {
            def = await vscode.commands.executeCommand('twincat.lsp.queryDefinition', params);
            if (!def) await sleep(5000);
        }
        const refs = await vscode.commands.executeCommand('twincat.lsp.queryReferences', params);
        log('lsp', {
            definition: def,
            refCount: Array.isArray(refs) ? refs.length : String(refs),
            referenceUris: Array.isArray(refs) ? [...new Set(refs.map(r => r.uri))] : [],
            referenceFsPaths: Array.isArray(refs)
                ? [...new Set(refs.map(r => fileUriToFsPath(r.uri)))]
                : []
        });

        // 3. Navigate with the uri the definition returned — the openFile flow. The GVL is already
        //    open, so a correctly-spelled uri must REUSE that tab, not add a lowercase twin.
        if (def && def.uri) {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(def.uri), 'twincat.xmlViewer');
            await sleep(3000);
            log('after-def-nav', { tabs: vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label)) });
        }

        // 3b. Navigation must leave the Objects tree on the component the webview actually loaded,
        // including virtual-folder members and both property accessors. The first open also emits a
        // root reveal during file activation; activeComponentChanged must win with the exact id.
        const stationUri = vscode.Uri.file(station);
        const componentTargets = [
            'method_Cyclic',
            'prop_State',
            'prop_State_get',
            'prop_State_set',
            'action_Act_Home'
        ];
        for (const componentId of componentTargets) {
            await vscode.commands.executeCommand('twincat.openComponent', stationUri, componentId);
            await sleep(900);
        }
        log('component-tree-reveal', {
            requested: componentTargets,
            reveals: out.treeReveals.filter(r => r.uri === stationUri.toString())
        });

        // A retained webview does not call loadComponent when its tab is reactivated. The host must
        // remember the last activeComponentChanged id or this round trip would reveal the file root.
        await vscode.commands.executeCommand('twincat.openComponent', stationUri, 'method_Cyclic');
        await sleep(900);
        const retainedStart = out.treeReveals.length;
        await vscode.commands.executeCommand('vscode.openWith', gvlUri, 'twincat.xmlViewer');
        await sleep(900);
        await vscode.commands.executeCommand('vscode.openWith', stationUri, 'twincat.xmlViewer');
        await sleep(900);
        log('retained-component-tree-reveal', {
            reveals: out.treeReveals.slice(retainedStart).filter(r => r.uri === stationUri.toString())
        });

        // 4. The Objects-tree insert commands. Their module is vscode-bound (like the drag-and-drop
        //    and clipboard controllers), so only a real host can show that a context-menu invocation
        //    reaches the webview's caret. The node stands in for the tree item VS Code would pass.
        // Located by search, not by a hardcoded path: the sample's folder layout is the generator's
        // business, and a stale path here fails as a silent skip rather than a red assertion.
        const findFile = (dir, name) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
                else if (e.name.toLowerCase() === name.toLowerCase()) return p;
            }
            return null;
        };
        const FB = findFile(SAMPLE, 'FB_Cylinder.TcPOU');
        if (FB) {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(FB), 'twincat.xmlViewer');
            await sleep(3000);
            const fileNode = { resourceUri: vscode.Uri.file(FB), contextValue: 'pouFile', label: 'FB_Cylinder.TcPOU' };
            await vscode.commands.executeCommand('twincat.insertObjectAtCursor', fileNode);
            await sleep(700);
            await vscode.commands.executeCommand('twincat.insertObjectDefinitionAtCursor',
                { resourceUri: vscode.Uri.file(FB), contextValue: 'component', label: 'FB_init' });
            await sleep(700);
            const panel = out.panels.filter(p => /FB_Cylinder\.TcPOU$/i.test(p.uri)).pop();
            log('object-insert', { inserted: (panel && panel.inserted) || [] });
        } else {
            log('object-insert', { skipped: 'FB_Cylinder.TcPOU not found', inserted: [] });
        }

        log('done', {});
    } catch (e) {
        log('CRASH', { error: String((e && e.stack) || e) });
    } finally {
        fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2));
        setTimeout(() => require('vscode').commands.executeCommand('workbench.action.closeWindow'), 1500);
        await sleep(3000);
    }
}

module.exports = { run };
