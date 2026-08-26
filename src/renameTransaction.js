/**
 * @file renameTransaction.js
 * @description A staging-and-apply transaction over a set of whole-file text rewrites, so a
 * multi-file rename either fully lands or leaves the workspace as it was.
 *
 * A cross-file rename writes several files in sequence; a failure part-way through used to leave the
 * workspace half-renamed with no way back. Here the edits are STAGED first (each file's original text
 * and its rewritten text are held), then applied in one pass. Two guards make the pass reversible:
 *
 *   - before writing, the file is re-read and must still equal the text it was staged from — a file
 *     that changed underneath us fails the apply rather than being clobbered;
 *   - on the first failure, every file already written is restored in reverse order, and each restore
 *     re-reads and verifies the file still holds OUR write before putting the original back. A file
 *     that changed after we wrote it is never touched; it is reported instead.
 *
 * A rollback that cannot complete is therefore never silent: the caller receives the exact list of
 * files left modified and why, which is the one outcome a user has to be told about.
 *
 * Deliberately free of vscode and fs: the caller injects `read`/`write` and keys are opaque identity
 * strings, so the whole state machine is testable in plain Node.
 */

/**
 * One staged whole-file rewrite. `originalText` is the text of the FIRST read (so composed stages
 * still roll back to what was on disk before the transaction), `newText` the latest staged output.
 * @typedef {{ key: string, originalText: string, newText: string }} StagedChange
 */

/**
 * One file that could not be restored during a rollback, with the reason it was left modified.
 * @typedef {{ key: string, reason: string }} RollbackFailure
 */

/** @typedef {{ ok: true, written: string[] }} ApplySuccess */

/**
 * @typedef {{ ok: false, failedKey: string, reason: string, rolledBack: string[],
 *             rollbackFailures: RollbackFailure[] }} ApplyFailure
 */

/** @typedef {{ reverted: string[], failures: RollbackFailure[] }} RevertResult */

/**
 * @typedef {{ read: (key: string) => Promise<string>, write: (key: string, text: string) => Promise<void> }} TransactionIo
 */

/**
 * @typedef {{ stage: (key: string, modify: (text: string) => string) => Promise<void>,
 *             apply: () => Promise<ApplySuccess|ApplyFailure>,
 *             revert: () => Promise<RevertResult>,
 *             readonly state: string }} RenameTransaction
 */

/**
 * Creates a transaction over `io`. Keys are opaque identity strings — the caller decides what they
 * mean (the rename commands use the lowercased fsPath) and resolves them back to real files inside
 * `read`/`write`, so nothing here ever fabricates a path.
 * @param {TransactionIo} io Injected reader/writer.
 * @returns {RenameTransaction}
 */
function createRenameTransaction(io) {
    /** Staged changes in first-staged order (Map.set keeps a re-staged key in its original slot). */
    const staged = new Map();
    /** Keys actually written by apply(), in write order. */
    const written = [];
    /** 'staging' -> 'applied' | 'failed' | 'reverted'. */
    let state = 'staging';

    /**
     * Stages one file's rewrite. Re-staging a key composes: the modifier receives the previously
     * staged output, and the original text is kept from the first read so a rollback still restores
     * what was there before the transaction started. A modifier that returns its input unchanged
     * stages nothing (there is no write to make, and nothing to roll back).
     *
     * A read failure propagates: nothing has been written yet, so the caller's own error handling is
     * the right place for it.
     * @param {string} key Identity of the file to rewrite.
     * @param {(text: string) => string} modify Maps current text to new text.
     * @returns {Promise<void>}
     */
    async function stage(key, modify) {
        if (state !== 'staging') {
            throw new Error(`cannot stage: the transaction is already ${state}`);
        }
        const existing = staged.get(key);
        const input = existing ? existing.newText : await io.read(key);
        const output = modify(input);
        if (output === input && !existing) return;
        staged.set(key, { key, originalText: existing ? existing.originalText : input, newText: output });
    }

    /**
     * Restores every written file, newest first, verifying each one still holds our own write before
     * putting the original back. A file that no longer matches is left alone and reported — the
     * never-clobber rule outranks completing the rollback.
     * @returns {Promise<RevertResult>}
     */
    async function restoreWritten() {
        /** @type {string[]} */
        const reverted = [];
        /** @type {RollbackFailure[]} */
        const failures = [];
        for (let i = written.length - 1; i >= 0; i--) {
            const key = written[i];
            const change = staged.get(key);
            let current;
            try {
                current = await io.read(key);
            } catch (err) {
                failures.push({ key, reason: `restore-failed: ${err.message}` });
                continue;
            }
            if (current !== change.newText) {
                failures.push({ key, reason: 'changed-after-write' });
                continue;
            }
            try {
                await io.write(key, change.originalText);
            } catch (err) {
                failures.push({ key, reason: `restore-failed: ${err.message}` });
                continue;
            }
            reverted.push(key);
        }
        return { reverted, failures };
    }

    /**
     * Writes every staged change in staging order, rolling the whole set back on the first failure.
     * Callable once — a second call throws rather than replaying writes against changed files.
     * @returns {Promise<ApplySuccess|ApplyFailure>}
     */
    async function apply() {
        if (state !== 'staging') {
            throw new Error(`cannot apply: the transaction is already ${state}`);
        }
        for (const change of staged.values()) {
            let current;
            try {
                current = await io.read(change.key);
            } catch (err) {
                return await fail(change.key, `read-failed: ${err.message}`);
            }
            // The file must still be what it was staged from, or the staged text is not a rewrite of
            // the current content and writing it would discard someone else's change.
            if (current !== change.originalText) {
                return await fail(change.key, 'changed-on-disk');
            }
            try {
                await io.write(change.key, change.newText);
            } catch (err) {
                return await fail(change.key, `write-failed: ${err.message}`);
            }
            written.push(change.key);
        }
        state = 'applied';
        return { ok: true, written: written.slice() };
    }

    /**
     * Fails the apply: rolls back what was written and reports which key stopped it.
     * @param {string} failedKey
     * @param {string} reason
     * @returns {Promise<ApplyFailure>}
     */
    async function fail(failedKey, reason) {
        const rollback = await restoreWritten();
        state = 'failed';
        return {
            ok: false,
            failedKey,
            reason,
            rolledBack: rollback.reverted,
            rollbackFailures: rollback.failures
        };
    }

    /**
     * Undoes a SUCCESSFUL apply — the escape hatch for a caller whose own follow-up step failed after
     * the writes landed (the rename commands use it when the on-disk file rename fails). Only valid in
     * state 'applied'; a failed apply has already rolled itself back.
     * @returns {Promise<RevertResult>}
     */
    async function revert() {
        if (state !== 'applied') {
            throw new Error(`cannot revert: the transaction is ${state}, not applied`);
        }
        const result = await restoreWritten();
        state = 'reverted';
        return result;
    }

    return {
        stage,
        apply,
        revert,
        get state() { return state; }
    };
}

module.exports = { createRenameTransaction };
