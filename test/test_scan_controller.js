/**
 * @file test_scan_controller.js
 * @description The startup scan barrier (src/lsp/scanController.js) over an injected counting scan.
 *
 * The bug this pins: the full `scanWorkspace` ran TWICE on every startup — `onInitialize` scanned,
 * then the extension host's `custom/reindex` (which only ever wanted an ordering barrier, so that
 * `custom/libraries` is not asked before an index exists) scanned the very same roots again. On a
 * folder with eight PLC projects that second scan cost ~35 s cold, during which every language
 * feature is dead because the LSP's event loop is stopped.
 *
 * The controller is the whole of the decision, so this harness carries the whole of its correctness.
 * Two assertions here are load-bearing beyond "it caches":
 *
 *  - `rescan` after `ensureScanned` must ALWAYS scan. A `.plcproj` change arrives with the same
 *    roots — it is the content that moved — so an "already scanned these roots" shortcut in that
 *    path would silently stop picking up added libraries and added objects. Test 3 is the assertion
 *    that stops a future optimisation from breaking the watcher.
 *  - a throwing scan must NOT be recorded as complete. Serving a half-built index as if it were
 *    current means answering with false diagnostics, which this project treats as the one
 *    unacceptable failure mode.
 *
 * The scan is injected because the real one lives in server.js, which opens an IPC connection at
 * require time and so cannot be loaded by a standalone harness at all.
 */

const path = require('path');
const { createScanController, normalizeRootSet } = require('../src/lsp/scanController');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const ROOT = process.platform === 'win32' ? 'C:\\' : '/';
/** Builds an absolute platform path, so the suite runs on any OS while exercising Windows shapes. */
const p = (...segs) => path.join(ROOT, ...segs);

/**
 * A counting stand-in for `scanWorkspace`. `returned` flips to true as the very LAST thing the scan
 * does, so a test can prove the barrier promise resolves strictly after the scan finished rather
 * than merely after it was entered.
 * @param {{throwOnCall?: number}} [opts] `throwOnCall` makes the Nth call (1-based) throw.
 */
function countingScan(opts) {
    const { throwOnCall = 0 } = opts || {};
    const state = {
        calls: 0,
        /** @type {Array<Array<string>>} Roots as the controller passed them, per call. */
        seen: [],
        returned: false,
        scan: (roots) => {
            state.calls++;
            state.returned = false;
            state.seen.push(roots);
            if (state.calls === throwOnCall) throw new Error('scan blew up');
            state.returned = true;
        }
    };
    return state;
}

async function main() {
    const A = p('Software', 'PLC projects', 'LineA');
    const B = p('Software', 'PLC projects', 'LineB');

    // 1 — the duplicate startup scan. This is the one that fails "expected 1, got 2" against the
    // pre-fix behaviour, where every barrier request rebuilt the whole workspace.
    {
        const s = countingScan();
        const c = createScanController({ scan: s.scan });
        await c.ensureScanned([A]);
        await c.ensureScanned([A]);
        assert(s.calls === 1, `ensureScanned twice with the same roots scans ONCE (expected 1, got ${s.calls})`);
        assert(c.state().complete === true, 'the controller reports a completed scan');
    }

    // 2 — a different root set is a different workspace and must be scanned.
    {
        const s = countingScan();
        const c = createScanController({ scan: s.scan });
        await c.ensureScanned([A]);
        await c.ensureScanned([A, B]);
        assert(s.calls === 2, `ensureScanned with a differing root set scans again (expected 2, got ${s.calls})`);
    }

    // 3 — rescan is unconditional: the `.plcproj` watcher path must always rebuild.
    {
        const s = countingScan();
        const c = createScanController({ scan: s.scan });
        await c.ensureScanned([A]);
        await c.rescan([A]);
        assert(s.calls === 2, `rescan after ensureScanned with the SAME roots scans again (expected 2, got ${s.calls})`);
        // …and the rescan re-arms the "already current" state, so the barrier after it is free.
        await c.ensureScanned([A]);
        assert(s.calls === 2, `ensureScanned after a rescan of the same roots is free (expected 2, got ${s.calls})`);
    }

    // 4 — a throwing scan is not a completed scan.
    {
        const s = countingScan({ throwOnCall: 1 });
        const c = createScanController({ scan: s.scan });
        let threw = false;
        try {
            await c.ensureScanned([A]);
        } catch (e) {
            threw = true;
        }
        assert(threw, 'a throwing scan rejects rather than resolving silently');
        assert(c.state().complete === false, 'a throwing scan is NOT recorded as complete');
        await c.ensureScanned([A]);
        assert(s.calls === 2, `the next ensureScanned retries after a failed scan (expected 2, got ${s.calls})`);
        assert(c.state().complete === true, 'the retry is recorded as complete');
    }

    // 5 — roots compare order-, case- and separator-insensitively. The initialize params and the
    // host's workspace folders reach the controller by different routes and spell the same folder
    // differently; a spelling difference must not read as a different workspace.
    {
        const s = countingScan();
        const c = createScanController({ scan: s.scan });
        await c.ensureScanned([A, B]);
        await c.ensureScanned([B, A]);
        assert(s.calls === 1, `root ORDER does not matter (expected 1, got ${s.calls})`);
        await c.ensureScanned([A.toUpperCase(), B.toLowerCase()]);
        assert(s.calls === 1, `root CASE does not matter (expected 1, got ${s.calls})`);
        await c.ensureScanned([A.replace(/\\/g, '/'), B.replace(/\\/g, '/')]);
        assert(s.calls === 1, `the path SEPARATOR does not matter (expected 1, got ${s.calls})`);
        // Duplicates are a set, not a list: the same folder named twice is the same workspace.
        await c.ensureScanned([A, B, A]);
        assert(s.calls === 1, `a duplicated root does not force a rescan (expected 1, got ${s.calls})`);
    }

    // The scan itself must receive the caller's ORIGINAL spelling. normalizeProjectPath lower-cases,
    // and a lower-cased root propagates into every symbol node's uri — the 0.6.0 regression where
    // each cross-file Go to Definition opened a duplicate, lowercase-titled tab.
    {
        const s = countingScan();
        const c = createScanController({ scan: s.scan });
        await c.ensureScanned([A]);
        assert(s.seen[0] && s.seen[0][0] === A,
            `the scan receives the roots verbatim, not normalized (got ${JSON.stringify(s.seen[0])})`);
        assert(normalizeRootSet([A])[0] !== A,
            'sanity: normalizeRootSet really does rewrite the path (so the check above has teeth)');
    }

    // 6 — invalidate() forces the next ensureScanned to scan.
    {
        const s = countingScan();
        const c = createScanController({ scan: s.scan });
        await c.ensureScanned([A]);
        c.invalidate();
        assert(c.state().complete === false, 'invalidate() clears the completed state');
        await c.ensureScanned([A]);
        assert(s.calls === 2, `ensureScanned after invalidate() scans again (expected 2, got ${s.calls})`);
    }

    // 7 — the barrier. The host's startup request exists ONLY to order sendDiagnosticsConfig() and
    // the Libraries view refresh after the index, so resolving early would defeat its entire reason
    // to exist. `returned` is set as the last statement of the scan.
    {
        const s = countingScan();
        const c = createScanController({ scan: s.scan });
        const promise = c.ensureScanned([A]);
        await promise;
        assert(s.returned === true, 'the barrier resolves strictly AFTER the scan returned');
    }

    // 8 — an empty root set is a completed state, not "nothing has happened yet". A window with no
    // workspace folders has an empty but complete index, and the barrier still has to resolve.
    {
        const s = countingScan();
        const c = createScanController({ scan: s.scan });
        let resolved = false;
        await c.ensureScanned([]).then(() => { resolved = true; });
        assert(resolved, 'ensureScanned([]) resolves');
        assert(c.state().complete === true, 'an empty root set is recorded as a completed scan');
        const after = s.calls;
        await c.ensureScanned([]);
        assert(s.calls === after, `a second ensureScanned([]) does not re-scan (expected ${after}, got ${s.calls})`);
    }

    console.log(errors === 0 ? '\nAll scan-controller tests passed.' : `\n${errors} test(s) failed.`);
    if (errors > 0) process.exit(1);
}

main().catch(e => {
    console.error('[FAIL] harness threw:', e);
    process.exit(1);
});
