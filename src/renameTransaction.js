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
 * `applyAsOne(commit)` is the same transaction with ONE write step instead of one per file: the caller's
 * `commit` writes every staged change at once (the rename commands build a single WorkspaceEdit that
 * also carries the file rename, so one VS Code undo restores the whole rename). It keeps both guards:
 * every file is verified before the commit, and a commit that fails restores whatever of it landed,
 * by the same verify-before-restore rule.
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
 *             applyAsOne: (commit: (changes: StagedChange[]) => Promise<void>) => Promise<ApplySuccess|ApplyFailure>,
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
     * Writes every staged change in ONE caller-supplied step. Every file is first re-read and must
     * still equal the text it was staged from; a mismatch fails before anything is written. If the
     * commit throws, it may have landed partly, so each staged file is re-read: one still holding its
     * original needs nothing, one holding OUR text is restored, anything else is reported, never
     * overwritten. Callable once, like apply().
     * @param {(changes: StagedChange[]) => Promise<void>} commit Writes all changes at once. An error
     *   may carry `key` to name the file that stopped it.
     * @returns {Promise<ApplySuccess|ApplyFailure>}
     */
    async function applyAsOne(commit) {
        if (state !== 'staging') {
            throw new Error(`cannot apply: the transaction is already ${state}`);
        }
        const changes = Array.from(staged.values());
        for (const change of changes) {
            let current;
            try {
                current = await io.read(change.key);
            } catch (err) {
                state = 'failed';
                return { ok: false, failedKey: change.key, reason: `read-failed: ${err.message}`, rolledBack: [], rollbackFailures: [] };
            }
            if (current !== change.originalText) {
                state = 'failed';
                return { ok: false, failedKey: change.key, reason: 'changed-on-disk', rolledBack: [], rollbackFailures: [] };
            }
        }
        try {
            await commit(changes.map(c => ({ ...c })));
        } catch (err) {
            /** @type {string[]} */
            const rolledBack = [];
            /** @type {RollbackFailure[]} */
            const rollbackFailures = [];
            for (let i = changes.length - 1; i >= 0; i--) {
                const change = changes[i];
                let current;
                try {
                    current = await io.read(change.key);
                } catch (readErr) {
                    rollbackFailures.push({ key: change.key, reason: `restore-failed: ${readErr.message}` });
                    continue;
                }
                if (current === change.originalText) continue;
                if (current !== change.newText) {
                    rollbackFailures.push({ key: change.key, reason: 'changed-after-write' });
                    continue;
                }
                try {
                    await io.write(change.key, change.originalText);
                    rolledBack.push(change.key);
                } catch (writeErr) {
                    rollbackFailures.push({ key: change.key, reason: `restore-failed: ${writeErr.message}` });
                }
            }
            state = 'failed';
            const failedKey = err && typeof err.key === 'string' ? err.key : (changes.length ? changes[0].key : '');
            return { ok: false, failedKey, reason: `commit-failed: ${err && err.message}`, rolledBack, rollbackFailures };
        }
        for (const change of changes) written.push(change.key);
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
     * the writes landed. Only valid in state 'applied'; a failed apply has already rolled itself back.
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
        applyAsOne,
        revert,
        get state() { return state; }
    };
}

module.exports = { createRenameTransaction };
