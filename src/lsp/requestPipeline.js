/**
 * @file requestPipeline.js
 * @description Two small pieces of server.js infrastructure, pulled out so they are loadable by a
 * bare `node` harness (server.js opens an IPC connection at require time and so cannot be):
 *
 *  - `createRequestRouter` makes "sync the document before answering" a STRUCTURAL property of a
 *    handler instead of a line every custom/* handler has to remember to write. server.js's
 *    syncDocument() brings the index up to date with a document's own symbols and its library usage
 *    before any language feature runs on it — every custom/* handler needs that to happen first, in
 *    that order, or the very first request after an edit answers against a stale index. `withDocument`
 *    wraps a handler so the sync always runs, always before the handler, and a failure anywhere in
 *    that sequence (bad sync, bad handler) falls back the same way. `withoutDocument` is the explicit
 *    opposite: some requests (e.g. ones that read a document fresh from disk rather than from the
 *    webview's unsaved `params.code`) must NOT sync from `params.code` — there is no live code to sync
 *    from, or syncing would overwrite newer index state with a stale disk read. Its existence is the
 *    point: skipping the sync is a visible choice at the call site, not an accidental omission.
 *
 *  - `LIBRARY_INDEX_STAGES` / `validateStageOrder` / `runLibraryIndexPipeline` turn the hand-written
 *    call sequence in server.js's `indexLibraries` into validated DATA. That sequence encodes real
 *    merge semantics documented there: the `.tmc` must index before signatures, so a signature's
 *    bare-name entry never clobbers a `.tmc` type that already has real members; signatures (including
 *    the extra per-root scan for a workspace-level `library-signatures.xml`) must finish before
 *    browsercache, because browsercache enrichment only adds method/property NAMES to types the
 *    earlier stages already filed under a namespace. Reordering the table would silently change which
 *    stage's data wins, so `validateStageOrder` — run once at module load against the shipped table —
 *    turns a future reordering into a load-time throw instead of a quiet regression.
 *
 * The actual libsymbols.js / libraries.js calls are NOT required here: `runLibraryIndexPipeline` takes
 * them as injected `runners`, exactly as `scanController.js` takes `scan` and `workspaceScan.js` takes
 * `indexLibraries` — the caller (server.js) supplies the real work, this module supplies the order and
 * the bookkeeping.
 */

/**
 * Wraps `fn`, returning its result, or `fallback` (called with the error when it is a function, used
 * as-is otherwise) if `fn` throws.
 * @param {*} fallback A value, or a function `(error) => *`.
 * @param {() => *} fn
 * @returns {*}
 */
function callWithFallback(fallback, fn) {
    try {
        return fn();
    } catch (e) {
        return typeof fallback === 'function' ? fallback(e) : fallback;
    }
}

/**
 * Builds the two request-handler wrappers every custom/* LSP handler goes through.
 * @param {{getIndexForUri: (fileUri: string) => Object, sync: (code: string, fileUri: string, index: Object) => void}} deps
 *   `getIndexForUri` resolves a document's owning project index (workspaceScan.js's
 *   `indexForUri`/equivalent); `sync` brings that index up to date with the document's current code
 *   (server.js's `syncDocument`).
 * @returns {{
 *   withDocument: (fallback: *, handler: (params: Object, index: Object) => *) => (params: Object) => *,
 *   withoutDocument: (fallback: *, handler: (params: Object, index: Object) => *) => (params: Object) => *
 * }}
 */
function createRequestRouter(deps) {
    const { getIndexForUri, sync } = deps || {};

    return {
        /**
         * Wraps `handler` so that, on every call: the document's index is resolved, `sync` runs
         * against it with the request's own `params.code`, and only THEN does `handler` run — in that
         * order, always. Any throw along the way (a bad sync as much as a bad handler) is caught and
         * turned into `fallback`, so a single malformed request can never crash the server.
         * @param {*} fallback A value, or `(error) => *`, used when sync or the handler throws.
         * @param {(params: Object, index: Object) => *} handler
         * @returns {(params: {code: string, fileUri: string}) => *}
         */
        withDocument(fallback, handler) {
            return (params) => callWithFallback(fallback, () => {
                const index = getIndexForUri(params.fileUri);
                sync(params.code, params.fileUri, index);
                return handler(params, index);
            });
        },

        /**
         * Same wrapping as `withDocument`, WITHOUT the sync call. For requests that have no live
         * `params.code` to sync from, or that must answer from whatever the index already holds rather
         * than overwrite it with this request's view — skipping the sync is the entire reason this
         * variant exists, so it is written out here rather than left as an implicit "handler happens
         * not to call sync" at each call site.
         * @param {*} fallback A value, or `(error) => *`, used when the handler throws.
         * @param {(params: Object, index: Object) => *} handler
         * @returns {(params: {fileUri: string}) => *}
         */
        withoutDocument(fallback, handler) {
            return (params) => callWithFallback(fallback, () => {
                const index = getIndexForUri(params.fileUri);
                return handler(params, index);
            });
        }
    };
}

/**
 * The library-index stage table, in the order `runLibraryIndexPipeline` runs them and the order
 * server.js's `indexLibraries` already ran them in by hand. `after` names the stages that MUST have
 * already run — see the file header for why each dependency is real, not stylistic:
 *  - `signatures` depends on `typeSystem` (a `.tmc` type with real members must win over a bare-name
 *    signature entry).
 *  - `rootSignatures` depends on `signatures` (it extends the same `sig` totals with the extra
 *    workspace-root scan for `library-signatures.xml`).
 *  - `browsercache` depends on both `signatures` and `typeSystem` (it only adds names to types those
 *    two stages have already filed under a namespace).
 * `namespaces` and `symbols` have no dependencies — they are the two independent sources everything
 * else builds on.
 * @type {ReadonlyArray<{name: string, after: ReadonlyArray<string>}>}
 */
const LIBRARY_INDEX_STAGES = Object.freeze([
    { name: 'namespaces', after: [] },
    { name: 'symbols', after: [] },
    { name: 'typeSystem', after: [] },
    { name: 'signatures', after: ['typeSystem'] },
    { name: 'rootSignatures', after: ['signatures'] },
    { name: 'browsercache', after: ['signatures', 'typeSystem'] }
].map(s => Object.freeze({ name: s.name, after: Object.freeze(s.after) })));

/**
 * Throws if any stage in `stages` names a dependency (in its `after`) that has not appeared earlier in
 * the array. Run once at module load against `LIBRARY_INDEX_STAGES` — a later reordering (by hand-
 * editing the table) fails immediately at require time rather than silently changing which stage's
 * data wins a merge.
 * @param {ReadonlyArray<{name: string, after: ReadonlyArray<string>}>} stages
 */
function validateStageOrder(stages) {
    const seen = new Set();
    for (const stage of stages) {
        for (const dep of stage.after) {
            if (!seen.has(dep)) {
                throw new Error(
                    `Library index stage "${stage.name}" must run after "${dep}", but "${dep}" has not ` +
                    `run yet (stage order: ${stages.map(s => s.name).join(', ')})`
                );
            }
        }
        seen.add(stage.name);
    }
}

// Validated once, at load, against the shipped table. Task 2 deletes the hand-written call sequence
// in server.js's indexLibraries in favor of running this table through runLibraryIndexPipeline — this
// is what stops a future edit to the table from silently changing merge order.
validateStageOrder(LIBRARY_INDEX_STAGES);

/**
 * Runs every stage in `LIBRARY_INDEX_STAGES`' table order, in the given `ctx`, merging each stage's
 * returned patch into a `{ stats, tmc, sig, bc }` accumulator shaped exactly like the four locals
 * `indexLibraries` used to build by hand — then formats today's summary log line from that
 * accumulator, or returns a null line under the same "nothing indexed" guard `indexLibraries` used.
 * @param {Object<string, (ctx: {fsPath: string, index: Object, roots: Array<string>}) => Object>} runners
 *   One function per stage name in `LIBRARY_INDEX_STAGES`. Each returns a patch object — any subset of
 *   `{stats, tmc, sig, bc}` — whose keys overwrite the accumulator's matching keys; a stage that
 *   contributes nothing (e.g. `namespaces`, which only registers namespaces and reports no stats)
 *   returns `{}` or nothing. The real libsymbols.js/libraries.js calls are injected here by the
 *   caller — this function stays free of those requires.
 * @param {{fsPath: string, index: Object, roots: Array<string>}} ctx Passed unchanged to every stage.
 * @returns {{stats: Object, tmc: Object, sig: Object, bc: Object, line: string|null}} The merged stats
 *   plus the formatted log line, or `line: null` when nothing was indexed.
 */
function runLibraryIndexPipeline(runners, ctx) {
    const result = { stats: undefined, tmc: undefined, sig: undefined, bc: undefined };

    for (const stage of LIBRARY_INDEX_STAGES) {
        const runner = runners[stage.name];
        const patch = (runner ? runner(ctx) : undefined) || {};
        for (const key of Object.keys(patch)) {
            result[key] = patch[key];
        }
    }

    const { stats, tmc, sig, bc } = result;
    // Moved verbatim from server.js indexLibraries (formerly lines 126-135), guard included: a project
    // with no archives, no undecodable archives, no .tmc and no signatures dump has nothing worth
    // logging.
    let line = null;
    if (stats.archives > 0 || stats.failed > 0 || tmc.files > 0 || sig.files > 0) {
        line =
            `Library symbols: ${stats.symbols} from ${stats.archives} archive(s) ` +
            `(${stats.failed} undecodable) in ${stats.ms} ms; ` +
            `type system: ${tmc.files} .tmc file(s), ${tmc.symbols} total symbols in ${tmc.ms} ms; ` +
            `signatures: ${sig.files} file(s), ${sig.functions} function(s), ` +
            `${sig.functionBlocks} FB(s), ${sig.added} type(s) merged in ${sig.ms} ms; ` +
            `browsercache: ${bc.methods} method(s) + ${bc.properties} propert${bc.properties === 1 ? 'y' : 'ies'} ` +
            `on ${bc.types} type(s) from ${bc.libraries} librar${bc.libraries === 1 ? 'y' : 'ies'} in ${bc.ms} ms.`;
    }

    return { stats, tmc, sig, bc, line };
}

module.exports = {
    createRequestRouter,
    LIBRARY_INDEX_STAGES,
    validateStageOrder,
    runLibraryIndexPipeline
};
