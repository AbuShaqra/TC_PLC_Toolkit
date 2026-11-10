/**
 * @file scanController.js
 * @description Decides WHEN the workspace has to be scanned, separately from how it is scanned.
 *
 * The full `scanWorkspace` used to run TWICE on every startup: once from `onInitialize`, and again
 * from the `custom/reindex` the extension host sends right afterwards. The host's request was never
 * a request to rebuild anything — it is only an ordering barrier, because `custom/libraries` must not
 * be asked before an index exists — but `custom/reindex` carries no way to say so, and guessing
 * inside it would trade invalidation correctness for a few seconds. So the two meanings were split:
 * `custom/reindex` still means "the data changed, rebuild unconditionally", and `custom/indexReady`
 * means "resolve once these roots are indexed". This module is what tells them apart.
 *
 * It lives outside server.js for the same reason workspaceScan.js does: server.js opens an IPC
 * connection at require time, so nothing in it is loadable by a standalone harness. The scan is
 * injected (`deps.scan`), exactly as `scanWorkspace` injects `indexLibraries`.
 *
 * "Already current" is decided by exactly two facts, and no others: a scan **completed** — recorded
 * on completion, never on entry — and its root set equals the requested one. No time window, no
 * content fingerprint, no mtime sampling: those all fail open (they can call a stale index current),
 * and a stale index answers with false diagnostics, which is the one outcome this codebase refuses.
 */

const { normalizeProjectPath } = require('./projectMap');

/**
 * @typedef {Object} ScanController
 * @property {(roots: Array<string>) => Promise<{scanned: boolean}>} ensureScanned Scans only if no
 *   completed scan for this exact root set exists; resolves once the index is usable either way.
 * @property {(roots: Array<string>) => Promise<{scanned: boolean}>} rescan Always scans.
 * @property {() => void} invalidate Forgets the completed scan, so the next `ensureScanned` scans.
 * @property {() => {complete: boolean, roots: Array<string>|null}} state The recorded state, for
 *   logging and for the harness.
 */

/**
 * Joined on NUL rather than a space or a comma: `C:\Projects\PLC projects` is a real workspace here,
 * and any separator a path may itself contain lets two different root sets share one key.
 * @type {string}
 */
const KEY_SEPARATOR = '\u0000';

/**
 * The comparison form of a root set: normalized, de-duplicated and sorted. Order, case and path
 * separator must not matter — `onInitialize` gets its roots from the initialize params and
 * `custom/indexReady` gets them from the host's workspace folders, and two spellings of the same
 * folder must not read as a different workspace.
 * @param {Array<string>} roots Absolute workspace-root paths.
 * @returns {Array<string>} Normalized, de-duplicated, sorted roots.
 */
function normalizeRootSet(roots) {
    return Array.from(new Set((roots || []).map(normalizeProjectPath))).sort();
}

/**
 * Creates the scan controller.
 * @param {{scan: (roots: Array<string>) => any}} deps Injected side effects. `scan` rebuilds the
 *   workspace from the given roots; it may be synchronous or return a promise (server.js's does: the
 *   per-project background scan). A promise resolving to `'cancelled'` means a later scan superseded it.
 * @returns {ScanController}
 */
function createScanController(deps) {
    const { scan } = deps || {};

    /** Comparison key of the last COMPLETED scan, or null when there is none. */
    let completedKey = /** @type {string|null} */ (null);
    /** The normalized roots behind `completedKey`, kept for state() and logging. */
    let completedRoots = /** @type {Array<string>|null} */ (null);
    /** Bumped by every scan started; only the latest one may record completion. */
    let generation = 0;
    /**
     * The scan in flight, if any. With an asynchronous scan, an `ensureScanned` that arrives while one
     * is running for the same roots must WAIT for it rather than start a second — the latent hazard the
     * synchronous design never exposed (two callers would both have scanned).
     * @type {{key: string, promise: Promise<any>}|null}
     */
    let inFlight = null;

    /**
     * Runs the scan and records completion only if it returns and no later scan started meanwhile. A
     * throwing scan leaves the controller with no completed state, so the next `ensureScanned` retries
     * instead of serving a half-built index as if it were current.
     * @param {Array<string>} roots Absolute workspace-root paths, in the caller's own spelling.
     * @param {Array<string>} normalized The comparison form of `roots`.
     * @returns {Promise<{scanned: boolean}>}
     */
    async function run(roots, normalized) {
        // Invalidate up front: from here until the scan returns there IS no current index, and a
        // failure part-way through must not leave the previous root set looking valid.
        completedKey = null;
        completedRoots = null;
        const mine = ++generation;
        const key = normalized.join(KEY_SEPARATOR);
        // `roots` is passed through in the caller's original spelling, NEVER the normalized form.
        // normalizeProjectPath lower-cases, and a lower-cased root propagates into every symbol
        // node's uri — which is exactly the 0.6.0 regression where each cross-file Go to Definition
        // opened a duplicate, lowercase-titled tab. Normalization is for comparison only.
        const promise = Promise.resolve(scan(roots));
        inFlight = { key, promise };
        try {
            await promise;
        } finally {
            if (generation === mine) inFlight = null;
        }
        if (generation === mine) {
            completedKey = key;
            completedRoots = normalized;
        }
        return { scanned: true };
    }

    /**
     * Resolves once a scan of exactly these roots has completed, starting one only when none has and
     * none is running.
     * @param {Array<string>} roots
     * @returns {Promise<{scanned: boolean}>}
     */
    async function ensureScanned(roots) {
        const normalized = normalizeRootSet(roots);
        const key = normalized.join(KEY_SEPARATOR);
        for (;;) {
            // An empty root set is a legitimate completed state, not "nothing has happened yet": a
            // window with no workspace folders has an empty but complete index, and the host's
            // barrier still has to resolve. `completedKey === null` is the only "never scanned".
            if (completedKey !== null && completedKey === key) return { scanned: false };
            if (inFlight && inFlight.key === key) {
                // Join the running scan. If it is superseded or fails, look again: a newer scan of the
                // same roots is joined in turn, and a failure falls through to a scan of our own.
                const joined = inFlight;
                try {
                    await joined.promise;
                } catch (e) {
                    if (inFlight === joined) throw e;
                }
                continue;
            }
            return run(roots || [], normalized);
        }
    }

    return {
        ensureScanned,
        // Unconditional, always. This is what a `.plcproj` change routes through, and the reason it
        // must never learn to skip: on such a change the roots are unchanged — it is the CONTENT that
        // moved — so any "same roots, already scanned" shortcut here would silently stop picking up
        // added libraries and added objects. Nor may it join a scan in flight: that scan may have read
        // the file before the change.
        rescan: async (roots) => run(roots || [], normalizeRootSet(roots)),
        invalidate: () => {
            completedKey = null;
            completedRoots = null;
        },
        state: () => ({
            complete: completedKey !== null,
            roots: completedRoots ? completedRoots.slice() : null
        })
    };
}

module.exports = { createScanController, normalizeRootSet };
