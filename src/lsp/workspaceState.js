/**
 * @file workspaceState.js
 * @description Which workspace answers a request while scans come and go — the readiness side of the
 * per-project background scan (R6).
 *
 * The scan used to be one synchronous pass: the server's event loop stopped for its whole duration,
 * every request queued unread, and the finished workspace replaced the old one in a single assignment,
 * so no request could ever see a partial index. workspaceScan.js's startWorkspaceScan now indexes one
 * project at a time with the loop free in between. This module keeps the old guarantee under the new
 * timing: **a request is answered only from an index that is complete, in the workspace that is
 * current at the moment it is answered.**
 *
 *   - `settledFor(uri)` resolves with the current workspace once the index that answers `uri` is
 *     complete. If a newer scan replaced the workspace while the request waited, or the scan failed, it
 *     waits on the new current one instead — never answering from a superseded workspace, which is
 *     what a request queued behind the old synchronous scan would also have got.
 *   - The caller must use the returned workspace synchronously (no `await` between this resolving and
 *     reading the index), which is what makes "complete and current" still true when it reads.
 *   - `scan(roots)` supersedes a scan in flight. A scan that throws leaves the last COMPLETE workspace
 *     in place (as the synchronous scan did: a throw never replaced the workspace), and rejects.
 *
 * Lives outside server.js for the reason scanController.js and workspaceScan.js do: server.js opens IPC
 * at require time, and this is exactly the decision that needs a harness (test_scan_readiness.js).
 */

'use strict';

const { createEmptyWorkspace } = require('./workspaceScan');

/**
 * @typedef {import('./workspaceScan').Workspace & import('./workspaceScan').ReadinessGate} GatedWorkspace
 */

/**
 * @typedef {Object} WorkspaceState
 * @property {() => GatedWorkspace} current The workspace requests route through now (possibly still
 *   being scanned — never read an index from it without settledFor/settledAll first).
 * @property {(roots: Array<string>) => Promise<'complete'|'cancelled'>} scan Starts a scan, superseding
 *   one in flight; resolves when THIS scan finishes ('cancelled' when a later one superseded it).
 * @property {(fileUri: string) => Promise<GatedWorkspace>} settledFor The current workspace, once the
 *   index answering `fileUri` in it is complete.
 * @property {() => Promise<GatedWorkspace>} settledAll The current workspace, once every index is complete.
 */

/**
 * Creates the state.
 * @param {{startScan: (roots: Array<string>, hooks: {onFailure: (e: Error) => void}) =>
 *     import('./workspaceScan').ScanHandle,
 *   onComplete?: (workspace: GatedWorkspace) => void}} deps `startScan` is workspaceScan.js's
 *   startWorkspaceScan with the server's dependencies bound (it must pass `hooks.onFailure` through as
 *   startWorkspaceScan's `onFailure`); `onComplete` runs after each scan that
 *   finishes (the server flushes the persisted archive cache there).
 * @returns {WorkspaceState}
 */
function createWorkspaceState(deps) {
    const { startScan, onComplete = () => {} } = deps || {};
    /** @type {GatedWorkspace} */
    let current = createEmptyWorkspace();
    /** The last workspace whose scan completed — what a failed scan falls back to. */
    let lastComplete = current;
    /** @type {import('./workspaceScan').ScanHandle|null} */
    let inFlight = null;

    /**
     * Waits until `gate(workspace)` reports the current workspace ready, re-resolving whenever the
     * workspace it waited on stopped being current.
     * @param {(ws: GatedWorkspace) => Promise<boolean>} gate
     * @returns {Promise<GatedWorkspace>}
     */
    async function settle(gate) {
        for (;;) {
            const ws = current;
            const ready = await gate(ws);
            if (ready === true && ws === current) return ws;
            // Superseded or failed: `current` has already moved on (a newer scan replaces it before the
            // old one is cancelled; a failing scan's onFailure reverts it before its gates resolve), so
            // a gate answers false only for a workspace that is no longer current and this loop moves.
        }
    }

    return {
        current: () => current,
        scan: (roots) => {
            if (inFlight) inFlight.cancel();
            /** @type {import('./workspaceScan').ScanHandle|null} */
            let handle = null;
            const revert = () => {
                if (handle && inFlight === handle) {
                    inFlight = null;
                    // Same as the synchronous scan: a scan that throws never replaces the workspace.
                    current = lastComplete;
                }
            };
            handle = startScan(roots, { onFailure: revert });
            inFlight = handle;
            current = handle.workspace;
            const started = handle;
            return started.done.then((outcome) => {
                if (inFlight === started) inFlight = null;
                if (outcome === 'complete' && current === started.workspace) {
                    lastComplete = started.workspace;
                    onComplete(started.workspace);
                }
                return outcome;
            }, (e) => {
                revert();
                throw e;
            });
        },
        settledFor: (fileUri) => settle(ws => ws.readyFor(fileUri)),
        settledAll: () => settle(ws => ws.readyAll())
    };
}

module.exports = { createWorkspaceState };
