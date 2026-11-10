/**
 * @file test_scan_readiness.js
 * @description R6 part 3: the per-project background scan, and the readiness gate that keeps it from
 * ever answering from a half-built index.
 *
 * The scan used to be one synchronous pass, so a request could only run before it started or after it
 * finished. workspaceScan.js's startWorkspaceScan now indexes one project at a time with the event loop
 * free in between, workspaceState.js decides which workspace answers, and scanController.js joins a scan
 * in flight instead of starting a second. Here the event loop is stepped BY HAND (the injected
 * `yieldToEventLoop`), so every interleaving below is deterministic.
 *
 * Pinned:
 *   1. a background scan builds exactly the indexes the one-pass scan builds (objects, libraries,
 *      routed `.st` files), project by project;
 *   2. a request for a project waits until THAT project's index is complete — never sees it partial —
 *      and is answered while other projects are still unindexed (independence);
 *   3. a request for a not-yet-indexed project moves it to the front of the queue;
 *   4. a file under no project waits for the whole scan;
 *   5. a scan superseded mid-way (reindex) never answers: its waiters move to the new workspace;
 *   6. a scan that throws leaves the last complete workspace answering, as the one-pass scan did;
 *   7. the controller: ensureScanned during a scan of the same roots JOINS it (one scan, not two),
 *      rescan always starts a new one, and only the latest scan records completion.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SAMPLE_PROJECT, sampleAvailable } = require('./_multiproject');
const { scanWorkspace, startWorkspaceScan, createEmptyWorkspace } = require('../src/lsp/workspaceScan');
const { createWorkspaceState } = require('../src/lsp/workspaceState');
const { createScanController } = require('../src/lsp/scanController');
const { createIndexLibraries } = require('../src/lsp/libraryIndex');
const { getLibrarySymbols } = require('../src/lsp/libsymbols');
const { normalizeProjectPath } = require('../src/lsp/projectMap');
const { fsPathToFileUri } = require('../src/fileUri');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

if (!sampleAvailable()) {
    console.log('[SKIP] the committed sample is absent — no workspace to scan');
    process.exit(0);
}

// --- Fixture: three copies of the sample, a loose .st at the root, one .st inside LineA's project ---
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_scan_readiness_'));
const LINES = ['LineA', 'LineB', 'LineC'];
for (const line of LINES) fs.cpSync(SAMPLE_PROJECT, path.join(root, line), { recursive: true });
fs.writeFileSync(path.join(root, 'Shared.st'), 'FUNCTION F_SharedLoose : INT\nVAR_INPUT\n\tnIn : INT;\nEND_VAR\nF_SharedLoose := nIn;\nEND_FUNCTION\n');
fs.writeFileSync(path.join(root, 'LineA', 'TcToolkitSample_PLC', 'OnlyA.st'), 'FUNCTION F_OnlyA : BOOL\nF_OnlyA := TRUE;\nEND_FUNCTION\n');
const plcDir = (line) => path.join(root, line, 'TcToolkitSample_PLC');
const keyOf = (line) => normalizeProjectPath(path.join(plcDir(line), 'TcToolkitSample_PLC.plcproj'));
const fileOf = (line) => fsPathToFileUri(path.join(plcDir(line), 'POUs', 'MAIN.TcPOU'));
const LOOSE_FILE = fsPathToFileUri(path.join(root, 'NotInAnyProject.TcPOU'));

const indexLibraries = createIndexLibraries();

/**
 * A comparable picture of one index: every symbol's name, uri and range, plus its library registry.
 * @param {Object} index
 * @returns {string}
 */
function snapshot(index) {
    const symbols = Object.keys(index).sort().map((k) => {
        const n = index[k] || {};
        return `${k}|${n.uri || ''}|${JSON.stringify(n.range || null)}|${(n.children ? Object.keys(n.children).length : 0)}`;
    });
    return JSON.stringify({ symbols, libraries: getLibrarySymbols(index).slice().sort() });
}

/** A hand-stepped event loop: each scan yield waits until the test calls step(). */
function manualLoop() {
    const pending = [];
    return {
        yieldToEventLoop: () => new Promise(resolve => pending.push(resolve)),
        step: async () => {
            const next = pending.shift();
            if (next) next();
            // Let the scan's continuation and any waiter callbacks run.
            for (let i = 0; i < 20; i++) await Promise.resolve();
            return !!next;
        },
        waiting: () => pending.length
    };
}

(async () => {
    const reference = scanWorkspace([root], { indexLibraries });
    const expected = new Map(LINES.map(l => [l, snapshot(reference.indexForKey(keyOf(l)))]));

    // --- 1. Same indexes as the one-pass scan ------------------------------------------------------
    {
        const scan = startWorkspaceScan([root], { indexLibraries });
        const outcome = await scan.done;
        assert(outcome === 'complete' && scan.workspace.isComplete(), 'a background scan runs to completion');
        for (const l of LINES) {
            assert(snapshot(scan.workspace.indexForKey(keyOf(l))) === expected.get(l),
                `${l}: the background scan's index equals the one-pass scan's (objects, libraries, .st)`);
        }
        const a = scan.workspace.indexForKey(keyOf('LineA'));
        const b = scan.workspace.indexForKey(keyOf('LineB'));
        assert(!!a.F_SharedLoose && !!b.F_SharedLoose && !!a.F_OnlyA && !b.F_OnlyA,
            'a loose root .st reaches every project; a .st inside a project reaches only that one');
        assert(getLibrarySymbols(a).length > 0, 'library symbols are part of what a project\'s gate waits for');
    }

    // --- 2-4. The gate, independence, priority, loose files -----------------------------------------
    {
        const loop = manualLoop();
        const order = [];
        const scan = startWorkspaceScan([root], {
            indexLibraries,
            yieldToEventLoop: loop.yieldToEventLoop,
            onProjectReady: (key) => order.push(key)
        });
        const ws = scan.workspace;
        assert(LINES.every(l => !ws.isReadyFor(fileOf(l))) && !ws.isComplete(),
            'before the first yield is released, no project is ready (initialize can answer at once)');

        /** What each waiter saw at the moment its gate opened. */
        const seen = new Map();
        const watch = (label, uri) => ws.readyFor(uri).then((ok) => {
            seen.set(label, {
                ok,
                index: snapshot(ws.indexForUri(uri)),
                readyNow: LINES.filter(l => ws.isReadyFor(fileOf(l)))
            });
        });
        // Ask for LineC first: it is last in discovery order, so serving it first proves priority.
        watch('LineC', fileOf('LineC'));
        let looseDone = false;
        ws.readyFor(LOOSE_FILE).then(() => { looseDone = true; });

        await loop.step(); // the initial yield: one task runs
        assert(order.length === 1 && order[0] === keyOf('LineC'),
            'the project a request waits for is indexed FIRST (it jumped the queue)');
        assert(seen.has('LineC') && seen.get('LineC').ok === true,
            'the waiting request is released as soon as its own project is ready');
        assert(seen.get('LineC').index === expected.get('LineC'),
            'and the index it sees then is COMPLETE — identical to the finished one-pass index');
        assert(seen.get('LineC').readyNow.length === 1,
            'while the other two projects are still unindexed (projects become ready independently)');
        assert(!looseDone, 'a file under no project is still waiting: it waits for the whole scan');
        const partialA = snapshot(ws.indexForKey(keyOf('LineA')));
        assert(partialA !== expected.get('LineA'),
            'LineA\'s index is not complete yet at this point — which is exactly what the gate keeps requests away from');

        watch('LineA', fileOf('LineA'));
        watch('LineB', fileOf('LineB'));
        while (await loop.step()) { /* run the scan out */ }
        await scan.done;
        for (const l of ['LineA', 'LineB']) {
            assert(seen.has(l) && seen.get(l).index === expected.get(l),
                `${l}: its waiter saw only the complete index`);
        }
        assert(looseDone && ws.isComplete(), 'the loose file is released once every project is indexed');
    }

    // --- 5. A superseded scan never answers -------------------------------------------------------
    {
        const loop = manualLoop();
        const state = createWorkspaceState({
            startScan: (roots, hooks) => startWorkspaceScan(roots, {
                indexLibraries, yieldToEventLoop: loop.yieldToEventLoop, onFailure: hooks.onFailure
            })
        });
        const first = state.scan([root]);
        const firstWs = state.current();
        let answeredFrom = null;
        state.settledFor(fileOf('LineB')).then((ws) => { answeredFrom = ws; });
        await loop.step(); // LineB (prioritized) is indexed in the FIRST scan...
        assert(answeredFrom === firstWs, 'a request answered before any reindex gets the scan it waited on');

        let lateAnswer = null;
        state.settledFor(fileOf('LineA')).then((ws) => { lateAnswer = ws; });
        const second = state.scan([root]); // ...then a reindex supersedes it mid-way
        const secondWs = state.current();
        assert(secondWs !== firstWs, 'the reindex replaces the current workspace at once');
        while (await loop.step()) { /* run both out */ }
        assert(await first === 'cancelled' && await second === 'complete',
            'the superseded scan reports cancelled; the new one completes');
        assert(lateAnswer === secondWs,
            'a request waiting on the superseded scan is answered from the NEW workspace, never the old one');
        assert(snapshot(lateAnswer.indexForUri(fileOf('LineA'))) === expected.get('LineA'),
            'and from a complete index there');
    }

    // --- 6. A failing scan leaves the last complete workspace ---------------------------------------
    {
        const good = createEmptyWorkspace();
        good.marker = 'last-complete';
        /** Fake handles: the state machine, isolated from real scanning. */
        const handles = [];
        const state = createWorkspaceState({
            startScan: (roots, hooks) => {
                let fail;
                const gate = new Promise((resolve) => { fail = (e) => { hooks.onFailure(e); resolve(false); }; });
                const ws = Object.assign(createEmptyWorkspace(), {
                    readyFor: () => gate, readyAll: () => gate, isReadyFor: () => false, isComplete: () => false
                });
                let reject;
                const done = new Promise((_, r) => { reject = r; });
                const handle = { workspace: roots[0] === 'good' ? good : ws, done: roots[0] === 'good' ? Promise.resolve('complete') : done, cancel: () => {} };
                handles.push({ handle, fail: (e) => { fail(e); reject(e); } });
                return handle;
            }
        });
        await state.scan(['good']);
        assert(state.current() === good, 'a completed scan becomes the current workspace');
        const failing = state.scan(['bad']);
        failing.catch(() => {});
        assert(state.current() !== good, 'a new scan routes requests through its own workspace while it runs');
        let answered = null;
        state.settledFor('file:///x/MAIN.TcPOU').then((ws) => { answered = ws; });
        handles[1].fail(new Error('synthetic task failure'));
        let rejected = false;
        try { await failing; } catch (e) { rejected = true; }
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert(rejected, 'the failing scan rejects (so the controller records no completion)');
        assert(state.current() === good && answered === good,
            'its waiters are answered from the last COMPLETE workspace, never from the failed one');
    }

    // --- 7. The controller with an asynchronous scan ------------------------------------------------
    {
        let scans = 0;
        const releases = [];
        const controller = createScanController({
            scan: () => { scans++; return new Promise(resolve => releases.push(resolve)); }
        });
        const initial = controller.ensureScanned(['C:\\ws']);
        const barrier = controller.ensureScanned(['c:/WS']);
        assert(scans === 1, 'ensureScanned during a scan of the same roots joins it — one scan, not two');
        releases.shift()('complete');
        const [a, b] = await Promise.all([initial, barrier]);
        assert(a.scanned === true && b.scanned === false && controller.state().complete,
            'both resolve when that one scan completes; only the starter reports scanning');

        const reindex = controller.rescan(['C:\\ws']);
        const joiner = controller.ensureScanned(['C:\\ws']);
        const reindex2 = controller.rescan(['C:\\ws']);
        assert(scans === 3, 'rescan always starts a new scan, even with one in flight (it must not skip)');
        releases.shift()('cancelled'); // the first rescan was superseded
        await reindex;
        assert(!controller.state().complete, 'a superseded scan does not record completion');
        releases.shift()('complete');
        await Promise.all([reindex2, joiner]);
        assert(controller.state().complete && scans === 3,
            'the joiner followed the newer scan of the same roots and resolved with it, without scanning');
    }

    fs.rmSync(root, { recursive: true, force: true });
    if (errors > 0) {
        console.error(`\n${errors} scan-readiness assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll scan-readiness assertions passed.');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
