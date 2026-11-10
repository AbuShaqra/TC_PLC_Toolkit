/**
 * @file test_server_ipc.js
 * @description The REAL language server (src/lsp/server.js) in its own process, over Node IPC, the way
 * the extension host runs it — the end-to-end check for R6's background scan and persisted archive cache.
 *
 * The sample is correct TwinCAT code, so every diagnostic on it is a bug; and diagnostics computed
 * against a PARTIAL index are not zero (asserted below as the control). So "a request sent while the scan
 * is still running returns zero diagnostics" is the end-to-end form of "no request ever sees a half-built
 * index". Pinned:
 *   - `initialize` answers without waiting for the scan;
 *   - a custom/diagnostics request for the LAST project, sent at once, returns zero diagnostics;
 *   - custom/indexReady resolves (joining the startup scan) and custom/libraries answers per project;
 *   - a custom/reindex followed at once by a request still answers with zero diagnostics;
 *   - the decoded archive names are persisted to `initializationOptions.archiveCacheDir`, and a second
 *     server session reads them back (still zero diagnostics).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { createMessageConnection, IPCMessageReader, IPCMessageWriter } = require('vscode-jsonrpc/node');

const { SAMPLE_PROJECT, sampleAvailable } = require('./_multiproject');
const { parseTwinCatXml } = require('../src/xmlParser');
const { convertXmlToSt } = require('../src/stConverter');
const { provideDiagnostics } = require('../src/lsp/features');
const { parseAndIndexDocument } = require('../src/lsp/parser');
const { fsPathToFileUri } = require('../src/fileUri');
const { FILE_NAME } = require('../src/lsp/archiveStore');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

if (!sampleAvailable()) {
    console.log('[SKIP] the committed sample is absent — no workspace to serve');
    process.exit(0);
}

const SERVER = path.join(__dirname, '..', 'src', 'lsp', 'server.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_server_ipc_'));
const ws = path.join(root, 'ws');
const cacheDir = path.join(root, 'globalStorage');
const LINES = ['LineA', 'LineB', 'LineC', 'LineD'];
for (const line of LINES) fs.cpSync(SAMPLE_PROJECT, path.join(ws, line), { recursive: true });
// Vendored copies of one library keep one mtime in a real workspace (a copy does not here); pin it so
// the four copies share one content key, as they would on disk.
const ARCHIVE_REL = ['TcToolkitSample_PLC', '_Libraries', 'fisothemes', 'twincat dynamic collections', '1.0.7', 'tcdyncollections.library'];
const VENDOR_TIME = new Date('2025-06-01T08:00:00Z');
for (const line of LINES) fs.utimesSync(path.join(ws, line, ...ARCHIVE_REL), VENDOR_TIME, VENDOR_TIME);

/** The webview's request for one object: its whole file as one ST unit. */
function unitFor(line, rel) {
    const file = path.join(ws, line, 'TcToolkitSample_PLC', ...rel.split('/'));
    const { stText } = convertXmlToSt(parseTwinCatXml(fs.readFileSync(file, 'utf8')), { raw: true });
    return { code: stText, fileUri: fsPathToFileUri(file) };
}

/** Starts a server process and connects to it. */
function startServer() {
    const child = fork(SERVER, ['--node-ipc'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const connection = createMessageConnection(new IPCMessageReader(child), new IPCMessageWriter(child));
    connection.onNotification(() => {});
    connection.onRequest(() => null);
    connection.listen();
    return { child, connection, stderr: () => stderr };
}

/** Rejects after `ms`, so a hung request fails the harness instead of stalling it. */
function within(ms, promise, label) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function session(label) {
    const server = startServer();
    const { connection } = server;
    const t0 = Date.now();
    await within(30000, connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: fsPathToFileUri(ws), name: 'ws' }],
        initializationOptions: { archiveCacheDir: cacheDir }
    }), 'initialize');
    const initMs = Date.now() - t0;
    connection.sendNotification('initialized', {});

    // At once, before anything says the index is ready: the LAST project's MAIN, and its FB.
    const main = unitFor('LineD', 'POUs/MAIN.TcPOU');
    const station = unitFor('LineD', 'POUs/Machine/FB_Station.TcPOU');
    const [d1, d2] = await within(60000, Promise.all([
        connection.sendRequest('custom/diagnostics', main),
        connection.sendRequest('custom/diagnostics', station)
    ]), 'early diagnostics');
    assert(Array.isArray(d1) && d1.length === 0 && Array.isArray(d2) && d2.length === 0,
        `${label}: requests sent during the startup scan return ZERO diagnostics on the correct sample (${d1.length}, ${d2.length})`);

    const ready = await within(60000, connection.sendRequest('custom/indexReady', { folders: [fsPathToFileUri(ws)] }), 'indexReady');
    assert(ready && ready.success === true && ready.scanned === false,
        `${label}: custom/indexReady joins the startup scan instead of scanning again`);

    const libs = await connection.sendRequest('custom/libraries', { fileUri: unitFor('LineB', 'POUs/MAIN.TcPOU').fileUri });
    assert(libs && libs.scope === 'project' && Array.isArray(libs.libraries) && libs.libraries.length > 0,
        `${label}: custom/libraries answers for the active file's project (${libs && libs.libraries.length} libraries)`);

    const reindex = connection.sendRequest('custom/reindex', { folders: [fsPathToFileUri(ws)] });
    const during = await within(60000, connection.sendRequest('custom/diagnostics', unitFor('LineC', 'POUs/MAIN.TcPOU')), 'diagnostics during reindex');
    assert(Array.isArray(during) && during.length === 0, `${label}: a request sent right after custom/reindex returns zero diagnostics`);
    const re = await within(60000, reindex, 'reindex');
    assert(re && re.success === true, `${label}: custom/reindex completes`);

    await connection.sendRequest('shutdown');
    connection.sendNotification('exit');
    await new Promise((resolve) => server.child.on('exit', resolve));
    connection.dispose();
    return { initMs, stderr: server.stderr() };
}

(async () => {
    // Control: the same unit against a project index that is missing its objects is NOT clean, so zero
    // above means the request saw a complete index, not that the check is blind.
    {
        const main = unitFor('LineD', 'POUs/MAIN.TcPOU');
        const partial = {};
        parseAndIndexDocument(main.code, main.fileUri, partial);
        const diags = provideDiagnostics(main.code, partial, main.fileUri);
        assert(diags.length > 0, `control: MAIN diagnosed against a partial index reports ${diags.length} diagnostic(s)`);
    }

    const first = await session('session 1');
    assert(first.initMs < 5000, `session 1: initialize answered in ${first.initMs} ms`);
    const store = path.join(cacheDir, FILE_NAME);
    assert(fs.existsSync(store), 'the decoded archive names were persisted to the configured global-storage directory');
    const doc = JSON.parse(fs.readFileSync(store, 'utf8'));
    const entries = Object.keys(doc.entries || {});
    assert(entries.length === 1 && entries[0].includes('tcdyncollections.library'),
        `the four vendored copies of the sample's library are ONE stored entry (${entries.length})`);
    const before = fs.statSync(store).mtimeMs;

    await session('session 2');
    assert(fs.statSync(store).mtimeMs === before, 'session 2 only READ the persisted cache (the file was not rewritten)');

    fs.rmSync(root, { recursive: true, force: true });
    if (errors > 0) {
        console.error(`\n${errors} server-IPC assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll server-IPC assertions passed.');
})().catch((e) => {
    console.error(e);
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
});
