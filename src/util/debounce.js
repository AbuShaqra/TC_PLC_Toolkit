/**
 * @file debounce.js
 * @description Trailing-edge debounce. Deliberately free of `vscode` so the timing itself can be
 * driven by a harness under plain Node (test/test_debounce.js) — the callers that use it are
 * vscode-bound and are not loadable outside an extension host.
 *
 * It exists for one specific burst. `src/plcProjHelper.js` rewrites the `.plcproj` on every
 * Objects-tree create/delete, every rewrite fires the workspace watcher, and every one of those used
 * to trigger a FULL workspace re-index — every project, every library archive. Adding three methods
 * in a row therefore paid for three whole scans (~35 s each on a large multi-project folder).
 *
 * Trailing only, on purpose: the leading edge would index the `.plcproj` as it stood *before* the
 * change that triggered it, which is the stale answer, and the burst would still pay for the final
 * scan afterwards.
 */

/**
 * @typedef {Object} Debouncer
 * @property {(...args: any[]) => Promise<any>} schedule Queues an invocation `waitMs` from now,
 *   replacing any already-queued one. Resolves with the coalesced invocation's result.
 * @property {() => void} cancel Drops a queued invocation and resolves its waiters with `undefined`.
 * @property {() => boolean} pending True while an invocation is queued.
 */

/**
 * Creates a trailing-edge debouncer around `fn`.
 *
 * Returns an object rather than a callable-with-properties: the type-check gate reads the JSDoc, and
 * a plain object states `schedule`/`cancel`/`pending` in a way `tsc --noEmit` can actually verify.
 *
 * @param {(...args: any[]) => any} fn The work to coalesce. May return a promise; every waiter is
 *   settled with its outcome.
 * @param {number} waitMs Quiet period, in milliseconds, before the queued call runs.
 * @param {{setTimeout?: (cb: () => void, ms: number) => any,
 *   clearTimeout?: (handle: any) => void}} [deps] Injected timers, following the injection shape used
 *   elsewhere in the codebase (see workspaceScan.js `deps.indexLibraries`). The harness passes a fake
 *   clock so the timing assertions are deterministic instead of racing a real wall-clock window.
 * @returns {Debouncer}
 */
function createDebouncer(fn, waitMs, deps) {
    const { setTimeout: schedule = setTimeout, clearTimeout: unschedule = clearTimeout } = deps || {};

    /** @type {any} */
    let timer = null;
    /** @type {any[]} */
    let lastArgs = [];
    /** @type {Array<{resolve: (v: any) => void, reject: (e: any) => void}>} */
    let waiters = [];

    const fire = () => {
        timer = null;
        // Snapshot and clear first: `fn` may synchronously schedule the next call (a re-index whose
        // completion writes a file the same watcher sees), and that call must start a fresh window
        // rather than join the one being drained.
        const args = lastArgs;
        const settling = waiters;
        lastArgs = [];
        waiters = [];
        let result;
        try {
            result = fn(...args);
        } catch (e) {
            for (const w of settling) w.reject(e);
            return;
        }
        Promise.resolve(result).then(
            (value) => { for (const w of settling) w.resolve(value); },
            (err) => { for (const w of settling) w.reject(err); }
        );
    };

    return {
        schedule: (...args) => {
            // Last call in the burst wins: the coalesced invocation must see the newest arguments,
            // not the ones that opened the window.
            lastArgs = args;
            if (timer !== null) unschedule(timer);
            timer = schedule(fire, waitMs);
            return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); });
        },
        cancel: () => {
            if (timer === null) return;
            unschedule(timer);
            timer = null;
            const settling = waiters;
            lastArgs = [];
            waiters = [];
            // Resolve rather than reject: cancel() runs on disposal, and a rejected promise nobody is
            // left to await surfaces as an unhandled rejection in the extension host log.
            for (const w of settling) w.resolve(undefined);
        },
        pending: () => timer !== null
    };
}

module.exports = { createDebouncer };
