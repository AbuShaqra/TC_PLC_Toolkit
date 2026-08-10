/**
 * @file test_debounce.js
 * @description The trailing-edge debounce (src/util/debounce.js) that coalesces `.plcproj` watcher
 * bursts.
 *
 * Why it matters: src/plcProjHelper.js rewrites the `.plcproj` on every Objects-tree create/delete,
 * every rewrite fires the workspace watcher, and every watcher event used to trigger a FULL
 * workspace re-index — every project, every library archive. Adding three methods in a row paid for
 * three whole scans.
 *
 * Timers are injected rather than real, so the assertions are deterministic instead of racing a
 * wall-clock window: a sleep-based harness that passes on a quiet machine is exactly the kind of
 * test that fails once on CI and gets deleted.
 */

const { createDebouncer } = require('../src/util/debounce');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/**
 * A fake clock exposing the setTimeout/clearTimeout pair the debouncer injects. `tick()` fires the
 * pending callback, so "the window elapsed" is an explicit step in the test rather than a sleep.
 */
function fakeClock() {
    let nextHandle = 1;
    /** @type {Map<number, () => void>} */
    const timers = new Map();
    return {
        setTimeout: (cb) => { const h = nextHandle++; timers.set(h, cb); return h; },
        clearTimeout: (h) => { timers.delete(h); },
        /** Fires every currently-pending timer. */
        tick() {
            const due = Array.from(timers.entries());
            timers.clear();
            for (const [, cb] of due) cb();
        },
        get armed() { return timers.size; }
    };
}

async function main() {
    // N calls inside the window collapse into ONE invocation, carrying the LAST arguments — the
    // burst's final state is the only one worth indexing.
    {
        const clock = fakeClock();
        const calls = [];
        const d = createDebouncer((...args) => { calls.push(args); return 'done'; }, 400, clock);
        const promises = [d.schedule('a'), d.schedule('b'), d.schedule('c')];
        assert(calls.length === 0, 'nothing runs before the window elapses (trailing edge, not leading)');
        assert(clock.armed === 1, `only one timer is ever armed (expected 1, got ${clock.armed})`);
        clock.tick();
        assert(calls.length === 1, `three calls inside the window produce ONE invocation (expected 1, got ${calls.length})`);
        assert(JSON.stringify(calls[0]) === JSON.stringify(['c']),
            `the invocation carries the LAST arguments (got ${JSON.stringify(calls[0])})`);
        const settled = await Promise.all(promises);
        assert(settled.length === 3 && settled.every(v => v === 'done'),
            "every caller's promise resolves with the coalesced result");
    }

    // A call after the window is a new burst.
    {
        const clock = fakeClock();
        let calls = 0;
        const d = createDebouncer(() => { calls++; }, 400, clock);
        const first = d.schedule('first');
        clock.tick();
        await first;
        assert(calls === 1, `the first burst ran (expected 1, got ${calls})`);
        const second = d.schedule('second');
        clock.tick();
        await second;
        assert(calls === 2, `a call after the window invokes again (expected 2, got ${calls})`);
    }

    // Promises settle even when the work is asynchronous — the real callee is an LSP round-trip.
    {
        const clock = fakeClock();
        const d = createDebouncer(() => Promise.resolve('async result'), 400, clock);
        const promise = d.schedule();
        clock.tick();
        assert(await promise === 'async result', 'an async callee settles the waiters with its resolved value');
    }

    // A throwing callee rejects its waiters rather than leaving them hanging forever.
    {
        const clock = fakeClock();
        const d = createDebouncer(() => { throw new Error('boom'); }, 400, clock);
        const promise = d.schedule();
        clock.tick();
        let message = '';
        await promise.catch(e => { message = e.message; });
        assert(message === 'boom', `a throwing callee rejects the waiters (got "${message}")`);
    }

    // cancel() drops the queued call — it runs on disposal, so it must resolve (never reject) the
    // waiters: a rejection nobody is left to await surfaces as an unhandled rejection in the host log.
    {
        const clock = fakeClock();
        let calls = 0;
        const d = createDebouncer(() => { calls++; }, 400, clock);
        const promise = d.schedule();
        assert(d.pending() === true, 'pending() is true while a call is queued');
        d.cancel();
        assert(d.pending() === false, 'pending() is false after cancel()');
        clock.tick();
        assert(calls === 0, `a cancelled call never runs (expected 0, got ${calls})`);
        assert(await promise === undefined, 'a cancelled waiter resolves with undefined');
    }

    console.log(errors === 0 ? '\nAll debounce tests passed.' : `\n${errors} test(s) failed.`);
    if (errors > 0) process.exit(1);
}

main().catch(e => {
    console.error('[FAIL] harness threw:', e);
    process.exit(1);
});
