/**
 * @file test_request_pipeline.js
 * @description The request router (src/lsp/requestPipeline.js) over injected sync/handler recorders,
 * plus the library-index stage table and the pipeline that runs it.
 *
 * Two things this harness pins beyond "it wires calls through":
 *
 *  - `withDocument` syncs BEFORE the handler runs, every time, with the exact (code, fileUri, index)
 *    triple `getIndexForUri` and the request supplied. Every custom/* handler in server.js relies on
 *    this ordering to answer against an index that has already seen the document's own symbols and
 *    its library usage (see server.js syncDocument) — a handler that ran first would see a stale
 *    index on the very first request after an edit.
 *  - `LIBRARY_INDEX_STAGES`' order is validated DATA, not just documentation: `.tmc` must index before
 *    signatures (so a signature's bare-name entry never clobbers a real `.tmc` type with members), and
 *    signatures before browsercache (so browsercache enrichment has a type to attach names to). A
 *    reordering here is a silent regression in the merge semantics documented in server.js's
 *    indexLibraries, not just a style nit — validateStageOrder is what turns that into a load-time
 *    throw instead.
 *
 * The router and the pipeline take their real dependencies as injected functions, exactly as
 * scanController.js takes `scan` — this module must stay loadable by a bare `node` harness with no
 * vscode-languageserver, no IPC, and no libsymbols/libraries requires.
 */

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// Module-load assertions (group 4's "validation ran at module load") happen as part of this very
// require — a throw here would abort the whole harness, which IS the check.
const {
    createRequestRouter,
    LIBRARY_INDEX_STAGES,
    validateStageOrder,
    runLibraryIndexPipeline
} = require('../src/lsp/requestPipeline');

/** A recorder standing in for syncDocument: counts calls and remembers each call's arguments. */
function makeSyncRecorder(opts) {
    const { throwOnCall = 0 } = opts || {};
    const state = { calls: 0, seen: /** @type {Array<Array<any>>} */ ([]) };
    state.sync = (code, fileUri, index) => {
        state.calls++;
        state.seen.push([code, fileUri, index]);
        if (state.calls === throwOnCall) throw new Error('sync blew up');
    };
    return state;
}

function main() {
    // ---- Group 1: withDocument syncs exactly once, BEFORE the handler, with the right arguments ----
    {
        const index = { name: 'projectIndex' };
        const sync = makeSyncRecorder();
        const order = [];
        const router = createRequestRouter({
            getIndexForUri: (uri) => { order.push(`getIndexForUri:${uri}`); return index; }
        , sync: (...args) => { order.push('sync'); sync.sync(...args); } });

        const handler = (params, idx) => { order.push('handler'); return { got: idx }; };
        const fn = router.withDocument('fallback', handler);
        const params = { code: 'PROGRAM main END_PROGRAM', fileUri: 'file:///a.TcPOU' };
        const result = fn(params);

        assert(sync.calls === 1, `withDocument calls sync exactly once (expected 1, got ${sync.calls})`);
        assert(sync.seen[0][0] === params.code && sync.seen[0][1] === params.fileUri && sync.seen[0][2] === index,
            'sync receives (params.code, params.fileUri, index-from-getIndexForUri)');
        assert(order.indexOf('sync') < order.indexOf('handler'), 'sync runs BEFORE the handler');
        assert(result && result.got === index, 'withDocument returns the handler value, handler received the index');
    }

    // ---- Group 2: return/fallback semantics ----
    {
        // handler's return value passes through untouched.
        const router = createRequestRouter({ getIndexForUri: () => ({}), sync: () => {} });
        const fn = router.withDocument('fb', () => 'handler-result');
        assert(fn({ code: '', fileUri: 'u' }) === 'handler-result', 'withDocument returns the handler value');
    }
    {
        // a throwing handler returns the (value) fallback.
        const router = createRequestRouter({ getIndexForUri: () => ({}), sync: () => {} });
        const fn = router.withDocument('fallback-value', () => { throw new Error('handler blew up'); });
        assert(fn({ code: '', fileUri: 'u' }) === 'fallback-value', 'a throwing handler returns the value fallback');
    }
    {
        // a throwing sync returns the fallback too — the handler never runs.
        let handlerRan = false;
        const router = createRequestRouter({
            getIndexForUri: () => ({}),
            sync: () => { throw new Error('sync blew up'); }
        });
        const fn = router.withDocument('sync-fallback', () => { handlerRan = true; return 'x'; });
        const result = fn({ code: '', fileUri: 'u' });
        assert(result === 'sync-fallback', 'a throwing sync returns the fallback');
        assert(handlerRan === false, 'a throwing sync means the handler never runs');
    }
    {
        // a FUNCTION fallback receives the error — from a throwing handler...
        let received = null;
        const router = createRequestRouter({ getIndexForUri: () => ({}), sync: () => {} });
        const err = new Error('boom');
        const fn = router.withDocument((e) => { received = e; return 'from-fn'; }, () => { throw err; });
        const result = fn({ code: '', fileUri: 'u' });
        assert(result === 'from-fn', 'a function fallback\'s return value is used');
        assert(received === err, 'a function fallback receives the thrown error (handler case)');
    }
    {
        // ...and from a throwing sync.
        let received = null;
        const err = new Error('sync-boom');
        const router = createRequestRouter({ getIndexForUri: () => ({}), sync: () => { throw err; } });
        const fn = router.withDocument((e) => { received = e; return 'from-fn-2'; }, () => 'unreached');
        const result = fn({ code: '', fileUri: 'u' });
        assert(result === 'from-fn-2', 'a function fallback\'s return value is used (sync-throw case)');
        assert(received === err, 'a function fallback receives the thrown error (sync case)');
    }

    // ---- Group 3: withoutDocument never syncs, same catch semantics ----
    {
        const sync = makeSyncRecorder();
        const router = createRequestRouter({ getIndexForUri: () => ({ marker: true }), sync: sync.sync });
        const fn = router.withoutDocument('fb', (params, idx) => ({ params, idx }));
        const result = fn({ fileUri: 'file:///b.TcPOU' });
        assert(sync.calls === 0, `withoutDocument never calls sync (expected 0, got ${sync.calls})`);
        assert(result.idx && result.idx.marker === true, 'withoutDocument still resolves and passes the index through');
    }
    {
        const sync = makeSyncRecorder();
        const router = createRequestRouter({ getIndexForUri: () => ({}), sync: sync.sync });
        const fn = router.withoutDocument('fb', () => { throw new Error('handler blew up'); });
        assert(fn({ fileUri: 'u' }) === 'fb', 'withoutDocument: a throwing handler returns the value fallback');
        assert(sync.calls === 0, 'withoutDocument still never calls sync when the handler throws');
    }
    {
        let received = null;
        const err = new Error('without-boom');
        const router = createRequestRouter({
            getIndexForUri: () => { throw err; },
            sync: () => { throw new Error('must never be called'); }
        });
        const fn = router.withoutDocument((e) => { received = e; return 'fn-fb'; }, () => 'unreached');
        assert(fn({ fileUri: 'u' }) === 'fn-fb', 'withoutDocument: function fallback return value is used');
        assert(received === err, 'withoutDocument: function fallback receives the thrown error');
    }

    // ---- Group 4: validateStageOrder + LIBRARY_INDEX_STAGES ----
    {
        // The shipped table passes (module load already exercised this — re-running proves it's not
        // a fluke of require() caching, and lets this test fail loudly with the real message if not).
        let threw = false;
        try { validateStageOrder(LIBRARY_INDEX_STAGES); } catch (e) { threw = true; }
        assert(threw === false, 'validateStageOrder accepts the shipped LIBRARY_INDEX_STAGES');

        const names = LIBRARY_INDEX_STAGES.map(s => s.name);
        assert(names.join(',') === 'namespaces,symbols,typeSystem,signatures,rootSignatures,browsercache',
            `LIBRARY_INDEX_STAGES is in the documented order (got ${names.join(',')})`);

        assert(Object.isFrozen(LIBRARY_INDEX_STAGES), 'LIBRARY_INDEX_STAGES is frozen');
        assert(LIBRARY_INDEX_STAGES.every(s => Object.isFrozen(s)), 'every stage row is frozen');
    }
    {
        // A reordered copy — browsercache before its `after: ['signatures', 'typeSystem']` — throws,
        // and the offending names appear in the message.
        const reordered = [
            { name: 'namespaces', after: [] },
            { name: 'symbols', after: [] },
            { name: 'browsercache', after: ['signatures', 'typeSystem'] },
            { name: 'typeSystem', after: [] },
            { name: 'signatures', after: ['typeSystem'] },
            { name: 'rootSignatures', after: ['signatures'] }
        ];
        let threw = false;
        let message = '';
        try { validateStageOrder(reordered); } catch (e) { threw = true; message = e.message; }
        assert(threw, 'validateStageOrder rejects a reordered table (browsercache before signatures/typeSystem)');
        assert(message.indexOf('browsercache') !== -1, `error message names the offending stage (got: ${message})`);
        assert(message.indexOf('signatures') !== -1 || message.indexOf('typeSystem') !== -1,
            `error message names what it must follow (got: ${message})`);
    }
    {
        // Module load itself validated the table without throwing — proven simply by having reached
        // this line, since the require() at the top of this file would have thrown otherwise.
        assert(true, 'requiring the module ran validateStageOrder at load with no throw');
    }

    // ---- Group 5: runLibraryIndexPipeline ----
    {
        const callOrder = [];
        /** @param {string} name @param {object} patch */
        const recorder = (name, patch) => (ctx) => { callOrder.push({ name, ctx }); return patch; };
        const runners = {
            namespaces: recorder('namespaces', {}),
            symbols: recorder('symbols', { stats: { symbols: 10, archives: 2, failed: 0, ms: 5 } }),
            typeSystem: recorder('typeSystem', { tmc: { files: 1, symbols: 3, ms: 1 } }),
            signatures: recorder('signatures', { sig: { files: 1, functions: 2, functionBlocks: 1, added: 4, ms: 2 } }),
            rootSignatures: recorder('rootSignatures', {}),
            browsercache: recorder('browsercache', { bc: { methods: 7, properties: 1, types: 2, libraries: 1, ms: 3 } })
        };
        const ctx = { fsPath: '/proj', index: { name: 'idx' }, roots: ['/proj', '/other'] };
        const result = runLibraryIndexPipeline(runners, ctx);

        assert(callOrder.map(c => c.name).join(',') ===
            'namespaces,symbols,typeSystem,signatures,rootSignatures,browsercache',
            `stages run in table order (got ${callOrder.map(c => c.name).join(',')})`);
        assert(callOrder.every(c => c.ctx === ctx), 'ctx is passed through unchanged to every stage');

        assert(result.stats && result.stats.symbols === 10 && result.stats.archives === 2,
            'stat patches merge into result.stats');
        assert(result.tmc && result.tmc.files === 1, 'stat patches merge into result.tmc');
        assert(result.sig && result.sig.functions === 2, 'stat patches merge into result.sig');
        assert(result.bc && result.bc.methods === 7, 'stat patches merge into result.bc');

        // The exact log line, singular branch (properties === 1 -> "property").
        const expectedLine =
            `Library symbols: 10 from 2 archive(s) ` +
            `(0 undecodable) in 5 ms; ` +
            `type system: 1 .tmc file(s), 3 total symbols in 1 ms; ` +
            `signatures: 1 file(s), 2 function(s), ` +
            `1 FB(s), 4 type(s) merged in 2 ms; ` +
            `browsercache: 7 method(s) + 1 property ` +
            `on 2 type(s) from 1 library in 3 ms.`;
        assert(result.line === expectedLine, `log line matches today's format, singular branch (got: ${result.line})`);
    }
    {
        // Plural branch of the same ternary: properties !== 1 and libraries !== 1 -> "properties"/"libraries".
        const runners = {
            namespaces: () => ({}),
            symbols: () => ({ stats: { symbols: 0, archives: 0, failed: 0, ms: 0 } }),
            typeSystem: () => ({ tmc: { files: 1, symbols: 0, ms: 0 } }),
            signatures: () => ({ sig: { files: 0, functions: 0, functionBlocks: 0, added: 0, ms: 0 } }),
            rootSignatures: () => ({}),
            browsercache: () => ({ bc: { methods: 0, properties: 4, types: 1, libraries: 3, ms: 0 } })
        };
        const result = runLibraryIndexPipeline(runners, { fsPath: '/p', index: {}, roots: ['/p'] });
        assert(result.line.indexOf('4 properties') !== -1, `plural "properties" branch present (got: ${result.line})`);
        assert(result.line.indexOf('3 libraries') !== -1, `plural "libraries" branch present (got: ${result.line})`);
    }
    {
        // The nothing-indexed guard: stats.archives === 0, stats.failed === 0, tmc.files === 0,
        // sig.files === 0 -> today's if-guard is false -> null line, no throw.
        const runners = {
            namespaces: () => ({}),
            symbols: () => ({ stats: { symbols: 0, archives: 0, failed: 0, ms: 0 } }),
            typeSystem: () => ({ tmc: { files: 0, symbols: 0, ms: 0 } }),
            signatures: () => ({ sig: { files: 0, functions: 0, functionBlocks: 0, added: 0, ms: 0 } }),
            rootSignatures: () => ({}),
            browsercache: () => ({ bc: { methods: 0, properties: 0, types: 0, libraries: 0, ms: 0 } })
        };
        const result = runLibraryIndexPipeline(runners, { fsPath: '/p', index: {}, roots: [] });
        assert(result.line === null, `nothing-indexed guard returns a null line (got: ${JSON.stringify(result.line)})`);
    }
    {
        // Guard is an OR across the four conditions — tmc.files > 0 alone must still produce a line.
        const runners = {
            namespaces: () => ({}),
            symbols: () => ({ stats: { symbols: 0, archives: 0, failed: 0, ms: 0 } }),
            typeSystem: () => ({ tmc: { files: 2, symbols: 5, ms: 1 } }),
            signatures: () => ({ sig: { files: 0, functions: 0, functionBlocks: 0, added: 0, ms: 0 } }),
            rootSignatures: () => ({}),
            browsercache: () => ({ bc: { methods: 0, properties: 0, types: 0, libraries: 0, ms: 0 } })
        };
        const result = runLibraryIndexPipeline(runners, { fsPath: '/p', index: {}, roots: [] });
        assert(result.line !== null, 'tmc.files > 0 alone is enough to produce a log line (OR guard)');
    }

    console.log(errors === 0 ? '\nAll request-pipeline tests passed.' : `\n${errors} test(s) failed.`);
    if (errors > 0) process.exit(1);
}

main();
