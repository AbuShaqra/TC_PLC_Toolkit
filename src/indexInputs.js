/**
 * @file indexInputs.js
 * @description Which watcher events change the LSP's library index without being a `.plcproj`, and
 * the gate that keeps the extension's own writes of those files from re-indexing a second time.
 *
 * The scan reads two generated inputs besides the `.plcproj`: a project's `.tmc` (written by every
 * TwinCAT build) and the `library-signatures.xml` dump (written by Update Library Definitions). The
 * per-scan directory memo (twincatWorkspace.js `createDirectoryListingMemo`) means neither is seen
 * until the next `custom/reindex`, so the host's watcher sends one when either is created, changed or
 * deleted. Deliberately free of `vscode`, so test/test_index_inputs.js can drive it under plain Node.
 */

const path = require('path');
const { PROJECT_SKIP_DIRS } = require('./twincatWorkspace');

/** The dump Update Library Definitions writes; matched case-insensitively, as libsymbols.js does. */
const SIGNATURES_FILE_NAME = 'library-signatures.xml';

/**
 * Whether a watcher event's path is a file the library index reads: a `*.tmc` or a
 * `library-signatures.xml`, outside every directory the scan's own walkers skip (PROJECT_SKIP_DIRS:
 * `_Libraries`, `_CompileInfo`, `ST_Files`, VCS/editor metadata). A file the scan would never read
 * must not cost a full re-index.
 * @param {string} fsPath The event's path, with either separator.
 * @returns {boolean}
 */
function isIndexInputFile(fsPath) {
    const parts = String(fsPath || '').split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) return false;
    const name = parts[parts.length - 1].toLowerCase();
    if (name !== SIGNATURES_FILE_NAME && path.extname(name) !== '.tmc') return false;
    return !parts.slice(0, -1).some(part => PROJECT_SKIP_DIRS.has(part.toLowerCase()));
}

/**
 * @typedef {Object} OwnWriteGate
 * @property {<T>(work: () => T | Promise<T>) => Promise<T>} run Runs `work`; watcher events are
 *   suppressed while it runs and for the grace period after it settles.
 * @property {() => boolean} suppressed True while an own write is running or within its grace period.
 */

/**
 * Creates the gate for the extension's own writes of index inputs. The one writer today is Update
 * Library Definitions: it writes `library-signatures.xml` and then sends its own `custom/reindex`, so
 * the watcher's event for that write would be a second, redundant full scan. File events arrive
 * asynchronously and can land just after the write's promise settles, hence the grace period.
 * @param {{graceMs?: number, now?: () => number}} [deps] `now` is injected so the harness needs no
 *   wall clock.
 * @returns {OwnWriteGate}
 */
function createOwnWriteGate(deps) {
    const { graceMs = 2000, now = Date.now } = deps || {};
    let running = 0;
    let quietUntil = 0;
    return {
        async run(work) {
            running++;
            try {
                return await work();
            } finally {
                running--;
                quietUntil = Math.max(quietUntil, now() + graceMs);
            }
        },
        suppressed: () => running > 0 || now() < quietUntil
    };
}

module.exports = { isIndexInputFile, createOwnWriteGate, SIGNATURES_FILE_NAME };
