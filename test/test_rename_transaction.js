/**
 * @file test_rename_transaction.js
 * @description The rollback transaction behind cross-file rename (`src/renameTransaction.js`).
 *
 * A cross-file rename writes several files in sequence. Before this module a failure part-way
 * through left the workspace half-renamed with no way back, so what is pinned here is the promise
 * that replaced it: either every staged file lands, or every file already written is restored.
 *
 * The three guards that make that true are each pinned by a case that FAILS without them:
 *   - the pre-write re-read (a file that changed since it was staged is never written: 'changed-on-disk');
 *   - the rollback itself (a failed write undoes the writes before it, in reverse order);
 *   - the rollback's own verify (a file that changed AFTER our write is never clobbered by the
 *     restore — it is reported as 'changed-after-write' instead, because only the user can judge it).
 *
 * Rollback failures are reported, never swallowed: a file left modified is the one outcome the
 * caller has to tell the user about, so `rollbackFailures` carries the key and the reason per file.
 *
 * Keys are opaque identity strings here, exactly as the module treats them — the rename commands
 * map them back to real Uris, and this harness never needs a filesystem.
 */

const { createRenameTransaction } = require('../src/renameTransaction');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/** Deep-ish equality for the string arrays these results are made of. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A Map-backed io with programmable faults and a write log.
 * @param {Object<string, string>} files Initial contents, keyed by transaction key.
 * @param {{ failWrite?: (key: string, attempt: number) => boolean,
 *           failRead?: (key: string, attempt: number) => boolean,
 *           afterWrite?: (key: string, store: Map<string, string>) => void }} [opts]
 */
function createFakeIo(files, opts = {}) {
    const store = new Map(Object.entries(files));
    /** Keys of writes that actually landed, in order — the transaction's visible effect on disk. */
    const writeLog = [];
    /** Every write ATTEMPT, including the ones made to fail. */
    const writeAttempts = [];
    const readLog = [];
    let writeCount = 0;

    const io = {
        async read(key) {
            readLog.push(key);
            if (opts.failRead && opts.failRead(key, readLog.length)) {
                throw new Error(`read boom: ${key}`);
            }
            if (!store.has(key)) throw new Error(`no such file: ${key}`);
            return store.get(key);
        },
        async write(key, text) {
            writeCount++;
            writeAttempts.push(key);
            if (opts.failWrite && opts.failWrite(key, writeCount)) {
                throw new Error(`write boom: ${key}`);
            }
            store.set(key, text);
            writeLog.push(key);
            if (opts.afterWrite) opts.afterWrite(key, store);
        }
    };
    return { io, store, writeLog, writeAttempts, readLog };
}

/** The rename's real shape of modifier: a textual rewrite of the whole file. */
const rename = (from, to) => (text) => text.split(from).join(to);

async function main() {
    // ---- 1. The happy path: five files, one write each, in staging order ----------------------
    {
        const files = {};
        for (let i = 1; i <= 5; i++) files[`f${i}`] = `ref OLD in f${i}`;
        const { io, store, writeLog } = createFakeIo(files);
        const txn = createRenameTransaction(io);
        for (let i = 1; i <= 5; i++) await txn.stage(`f${i}`, rename('OLD', 'NEW'));
        const res = await txn.apply();

        assert(res.ok === true, 'success: apply reports ok');
        assert(same(res.written, ['f1', 'f2', 'f3', 'f4', 'f5']), 'success: written lists all five keys');
        assert(same(writeLog, ['f1', 'f2', 'f3', 'f4', 'f5']),
            'success: each file written exactly once, in staging order');
        assert([...store.values()].every(v => v.includes('NEW') && !v.includes('OLD')),
            'success: every file holds the rewritten text');
    }

    // An empty transaction is a successful no-op, not an error.
    {
        const { io, writeLog } = createFakeIo({});
        const res = await createRenameTransaction(io).apply();
        assert(res.ok === true && same(res.written, []) && writeLog.length === 0,
            'empty staging applies as a no-op success');
    }

    // ---- 2. A middle write fails: earlier writes are undone, later ones never happen ----------
    {
        const { io, store, writeLog, writeAttempts } = createFakeIo(
            { f1: 'OLD a', f2: 'OLD b', f3: 'OLD c' },
            { failWrite: (key, n) => n === 2 });
        const txn = createRenameTransaction(io);
        for (const k of ['f1', 'f2', 'f3']) await txn.stage(k, rename('OLD', 'NEW'));
        const res = await txn.apply();

        assert(res.ok === false, 'mid-failure: apply reports failure');
        assert(res.failedKey === 'f2', 'mid-failure: failedKey names the file that would not write');
        assert(res.reason === 'write-failed: write boom: f2', 'mid-failure: reason carries the write error');
        assert(same(res.rolledBack, ['f1']), 'mid-failure: the one already-written file was rolled back');
        assert(same(res.rollbackFailures, []), 'mid-failure: the rollback itself succeeded');
        assert(store.get('f1') === 'OLD a' && store.get('f2') === 'OLD b' && store.get('f3') === 'OLD c',
            'mid-failure: the store holds the original text of every file');
        assert(!writeAttempts.includes('f3'), 'mid-failure: the file after the failure was never written');
        assert(same(writeLog, ['f1', 'f1']), 'mid-failure: f1 was written once and restored once');
    }

    // ---- 3. The LAST write fails: everything before it is undone, newest first ----------------
    {
        const { io, store, writeLog } = createFakeIo(
            { f1: 'OLD 1', f2: 'OLD 2', f3: 'OLD 3', f4: 'OLD 4' },
            { failWrite: (key, n) => n === 4 });
        const txn = createRenameTransaction(io);
        for (const k of ['f1', 'f2', 'f3', 'f4']) await txn.stage(k, rename('OLD', 'NEW'));
        const res = await txn.apply();

        assert(res.ok === false && res.failedKey === 'f4', 'last-write failure: f4 is the failed key');
        assert(same(res.rolledBack, ['f3', 'f2', 'f1']), 'last-write failure: rollback runs in reverse order');
        assert(same(writeLog, ['f1', 'f2', 'f3', 'f3', 'f2', 'f1']),
            'last-write failure: the write log shows three writes then three restores, reversed');
        assert(['f1', 'f2', 'f3', 'f4'].every((k, i) => store.get(k) === `OLD ${i + 1}`),
            'last-write failure: every file is back to its original text');
    }

    // ---- 4. A rollback write throws: that file is reported, the others still restored ---------
    {
        // Attempt 3 (f3) fails the apply; attempt 4 restores f2; attempt 5 (restoring f1) throws.
        const { io, store } = createFakeIo(
            { f1: 'OLD 1', f2: 'OLD 2', f3: 'OLD 3' },
            { failWrite: (key, n) => n === 3 || n === 5 });
        const txn = createRenameTransaction(io);
        for (const k of ['f1', 'f2', 'f3']) await txn.stage(k, rename('OLD', 'NEW'));
        const res = await txn.apply();

        assert(res.ok === false && res.failedKey === 'f3', 'restore failure: the apply failed on f3');
        assert(same(res.rolledBack, ['f2']), 'restore failure: the other written file was still restored');
        assert(res.rollbackFailures.length === 1 && res.rollbackFailures[0].key === 'f1',
            'restore failure: the unrestorable file is reported by key');
        // Indexed defensively so a regression REPORTS rather than crashing the harness mid-run.
        assert((res.rollbackFailures[0] || {}).reason === 'restore-failed: write boom: f1',
            'restore failure: the reason carries the restore error');
        assert(store.get('f1') === 'NEW 1', 'restore failure: that file is left modified (honestly reported)');
        assert(store.get('f2') === 'OLD 2', 'restore failure: the restorable file is back to its original');
    }

    // ---- 5. A file changed between stage and apply is never written --------------------------
    {
        const { io, store, writeAttempts } = createFakeIo({ f1: 'OLD 1', f2: 'OLD 2', f3: 'OLD 3' });
        const txn = createRenameTransaction(io);
        for (const k of ['f1', 'f2', 'f3']) await txn.stage(k, rename('OLD', 'NEW'));
        // Someone else edits f2 after it was staged.
        store.set('f2', 'SOMEONE ELSE 2');
        const res = await txn.apply();

        assert(res.ok === false && res.failedKey === 'f2', 'changed-on-disk: the mutated file fails the apply');
        assert(res.reason === 'changed-on-disk', 'changed-on-disk: the reason names the cause exactly');
        assert(!writeAttempts.includes('f2'), 'changed-on-disk: the mutated file was never written');
        assert(same(res.rolledBack, ['f1']), 'changed-on-disk: the earlier write was rolled back');
        assert(store.get('f1') === 'OLD 1' && store.get('f2') === 'SOMEONE ELSE 2',
            "changed-on-disk: the rollback restores ours and leaves the other party's edit alone");
    }

    // ---- 6. A file changed AFTER our write is never clobbered by the rollback -----------------
    {
        const { io, store, writeAttempts } = createFakeIo(
            { f1: 'OLD 1', f2: 'OLD 2', f3: 'OLD 3' },
            {
                failWrite: (key, n) => n === 3,
                // The moment f1 is written, something else overwrites it.
                afterWrite: (key, s) => { if (key === 'f1') s.set('f1', 'SOMEONE ELSE 1'); }
            });
        const txn = createRenameTransaction(io);
        for (const k of ['f1', 'f2', 'f3']) await txn.stage(k, rename('OLD', 'NEW'));
        const res = await txn.apply();

        assert(res.ok === false && res.failedKey === 'f3', 'changed-after-write: the apply failed on f3');
        assert(same(res.rolledBack, ['f2']), 'changed-after-write: the untouched file was restored');
        assert(res.rollbackFailures.length === 1
            && (res.rollbackFailures[0] || {}).key === 'f1'
            && (res.rollbackFailures[0] || {}).reason === 'changed-after-write',
            'changed-after-write: the externally changed file is reported, not restored');
        assert(store.get('f1') === 'SOMEONE ELSE 1',
            "changed-after-write: the other party's content survives the rollback");
        assert(writeAttempts.filter(k => k === 'f1').length === 1,
            'changed-after-write: no restore write was even attempted on it');
    }

    // ---- 7. revert(): only after a successful apply, and only once ----------------------------
    {
        const { io, store, writeLog } = createFakeIo({ f1: 'OLD 1', f2: 'OLD 2' });
        const txn = createRenameTransaction(io);
        for (const k of ['f1', 'f2']) await txn.stage(k, rename('OLD', 'NEW'));

        let threwBeforeApply = false;
        try { await txn.revert(); } catch (e) { threwBeforeApply = true; }
        assert(threwBeforeApply, 'revert: refuses to run before apply');

        const res = await txn.apply();
        assert(res.ok === true, 'revert: the apply it undoes succeeded');
        const rb = await txn.revert();
        assert(same(rb.reverted, ['f2', 'f1']) && same(rb.failures, []),
            'revert: every written file restored, newest first');
        assert(store.get('f1') === 'OLD 1' && store.get('f2') === 'OLD 2',
            'revert: the store is back to its pre-apply contents');
        assert(same(writeLog, ['f1', 'f2', 'f2', 'f1']), 'revert: two writes then two restores');

        let threwOnSecond = false;
        try { await txn.revert(); } catch (e) { threwOnSecond = true; }
        assert(threwOnSecond, 'revert: a second revert throws rather than re-writing');
    }

    // ---- 8. Staging one key twice composes; rollback still restores the FIRST-read text -------
    {
        const { io, store } = createFakeIo(
            { f1: 'A in f1', f2: 'A in f2' },
            { failWrite: (key) => key === 'f2' });
        const txn = createRenameTransaction(io);
        const seen = [];
        await txn.stage('f1', (text) => { seen.push(text); return text.replace('A', 'B'); });
        await txn.stage('f1', (text) => { seen.push(text); return text.replace('B', 'C'); });
        await txn.stage('f2', rename('A', 'Z'));

        assert(seen[0] === 'A in f1' && seen[1] === 'B in f1',
            'compose: the second modifier receives the first modifier\'s output');
        const res = await txn.apply();
        assert(res.ok === false && same(res.rolledBack, ['f1']), 'compose: the composed file was rolled back');
        assert(store.get('f1') === 'A in f1',
            'compose: the rollback restores the ORIGINAL text, not the intermediate stage');
    }

    // ---- 9. A modifier that changes nothing stages nothing ------------------------------------
    {
        const { io, writeLog } = createFakeIo({ f1: 'unchanged', f2: 'OLD 2' });
        const txn = createRenameTransaction(io);
        await txn.stage('f1', (text) => text);
        await txn.stage('f2', rename('OLD', 'NEW'));
        const res = await txn.apply();

        assert(res.ok === true && same(res.written, ['f2']), 'no-op modifier: only the changed file is written');
        assert(!writeLog.includes('f1'), 'no-op modifier: the unchanged file is never written');
    }

    // A no-op RE-stage of an already-staged key keeps the change (only a first, unchanged stage is
    // dropped) — otherwise a two-step edit whose second step is a no-op would silently lose the first.
    {
        const { io, store } = createFakeIo({ f1: 'OLD 1' });
        const txn = createRenameTransaction(io);
        await txn.stage('f1', rename('OLD', 'NEW'));
        await txn.stage('f1', (text) => text);
        const res = await txn.apply();
        assert(res.ok === true && same(res.written, ['f1']) && store.get('f1') === 'NEW 1',
            'no-op modifier: a no-op re-stage keeps the earlier staged change');
    }

    // ---- 10. A stage-time read failure propagates; apply is single-shot -----------------------
    {
        const { io, writeLog } = createFakeIo(
            { f1: 'OLD 1', f2: 'OLD 2' },
            { failRead: (key) => key === 'f2' });
        const txn = createRenameTransaction(io);
        await txn.stage('f1', rename('OLD', 'NEW'));
        let readError = null;
        try { await txn.stage('f2', rename('OLD', 'NEW')); } catch (e) { readError = e; }
        assert(readError !== null && /read boom: f2/.test(readError.message),
            'stage read failure: the error propagates to the caller');
        assert(writeLog.length === 0, 'stage read failure: nothing was written');
    }
    {
        const { io } = createFakeIo({ f1: 'OLD 1' });
        const txn = createRenameTransaction(io);
        await txn.stage('f1', rename('OLD', 'NEW'));
        const first = await txn.apply();
        assert(first.ok === true, 'single-shot apply: the first call succeeds');
        let threw = false;
        try { await txn.apply(); } catch (e) { threw = true; }
        assert(threw, 'single-shot apply: a second apply throws');
        let stageThrew = false;
        try { await txn.stage('f1', rename('NEW', 'X')); } catch (e) { stageThrew = true; }
        assert(stageThrew, 'single-shot apply: staging after apply throws');
    }

    console.log(errors === 0 ? '\nAll rename-transaction tests passed.' : `\n${errors} test(s) failed.`);
    if (errors > 0) process.exit(1);
}

main().catch((err) => {
    console.error('[FAIL] harness crashed:', err);
    process.exit(1);
});
