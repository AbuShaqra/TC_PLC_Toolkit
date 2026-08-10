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
const RESULTS = process.env.TCDEV_RESULTS;

const out = { steps: [], panels: [] };
function log(step, data) {
    out.steps.push({ step, ...data });
    try { fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)); } catch (e) { /* keep going */ }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
    const vscode = require('vscode');
    try {
        log('start', { ws: WS, folders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.toString()) });

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
            panel.webview.postMessage = (msg) => { rec.toWebview.push(msg && msg.type); return origPost(msg); };
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

        const GVL = path.join(WS, 'TcToolkitSample_PLC', 'GVLs', 'GVL_System.TcGVL');
        const MAIN = path.join(WS, 'TcToolkitSample_PLC', 'POUs', 'MAIN.TcPOU');
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
        log('lsp', { definition: def, refCount: Array.isArray(refs) ? refs.length : String(refs) });

        // 3. Navigate with the uri the definition returned — the openFile flow. The GVL is already
        //    open, so a correctly-spelled uri must REUSE that tab, not add a lowercase twin.
        if (def && def.uri) {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(def.uri), 'twincat.xmlViewer');
            await sleep(3000);
            log('after-def-nav', { tabs: vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label)) });
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
