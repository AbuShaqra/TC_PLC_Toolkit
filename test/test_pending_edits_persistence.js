/**
 * @file test_pending_edits_persistence.js
 * @description The persisted pending-edit store (`src/pendingEditsStore.js`) that survives a
 * window reload. In Manual Sync mode the webview never posts `edit`, so the unsaved edits exist
 * only as the `updatePendingEdits` record the host keeps — and while that record lived in an
 * in-memory `Map`, a Ctrl+R restarted the extension host and the edits were gone.
 *
 * Pins the behaviour the fix turns on: the entry survives a NEW store instance over the SAME
 * memento (that is the reload — the store object dies, the memento does not), a stale entry
 * (the document changed underneath it) is dropped rather than restored, entries are isolated
 * per URI, an empty edits object removes the entry, an unknown URI reads without writing, and
 * the stored value survives the JSON round trip `workspaceState` puts it through.
 */

const { createPendingEditsStore } = require('../src/pendingEditsStore');

const KEY = 'twincat.pendingEdits';

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

/**
 * A stand-in for `vscode.Memento` (`context.workspaceState`): synchronous `get`, promise-returning
 * `update`, and `update(key, undefined)` removes the key — the same contract VS Code documents.
 * Records every call so a test can assert that a read did not write.
 * @returns {Object} The fake memento plus `_raw`/`_seed`/`_calls` inspection helpers.
 */
function createFakeMemento() {
    const data = new Map();
    const calls = [];
    return {
        get(key, defaultValue) {
            calls.push({ op: 'get', key });
            return data.has(key) ? data.get(key) : defaultValue;
        },
        update(key, value) {
            calls.push({ op: 'update', key, value });
            if (value === undefined) data.delete(key);
            else data.set(key, value);
            return Promise.resolve();
        },
        _calls: calls,
        _raw(key) { return data.get(key); },
        _seed(key, value) { data.set(key, value); }
    };
}

/** A pending-edit snapshot in exactly the shape `media/pendingEdits.js`'s `snapshot()` returns. */
function sampleEdits(marker) {
    return {
        'root_Declaration': {
            context: { subType: 'root', subName: '', accessorType: '' },
            blockType: 'Declaration',
            content: `FUNCTION_BLOCK FB_X\n(* ${marker} *)\nEND_FUNCTION_BLOCK`
        },
        'prop_State_get_ST': {
            context: { subType: 'property', subName: 'State', accessorType: 'Get' },
            blockType: 'ST',
            content: `State := ${marker};`
        }
    };
}

async function main() {
    const URI_A = 'file:///c%3A/proj/FB_Station.TcPOU';
    const URI_B = 'file:///c%3A/proj/FB_Other.TcPOU';
    const TEXT_A = '<TcPlcObject><POU Name="FB_Station"/></TcPlcObject>';
    const TEXT_B = '<TcPlcObject><POU Name="FB_Other"/></TcPlcObject>';

    // ---- Group 1: the reload case — a NEW store over the SAME memento still has the edits ----
    {
        const memento = createFakeMemento();
        const edits = sampleEdits('one');
        await createPendingEditsStore(memento).set(URI_A, edits, TEXT_A);

        // The store instance is thrown away, exactly as the extension host object is on reload.
        const reloaded = createPendingEditsStore(memento);
        const got = reloaded.get(URI_A, TEXT_A);
        assert(JSON.stringify(got) === JSON.stringify(edits),
            'a new store over the same memento returns the identical edits (the reload case)');
        assert(Object.keys(got).length === 2, `both records survive (got ${Object.keys(got).length})`);
        assert(got['prop_State_get_ST'].context.accessorType === 'Get',
            'the xmlContext triple (subType/subName/accessorType) survives storage');
    }

    // ---- Group 2: a changed document discards the entry AND clears it from the memento ----
    {
        const memento = createFakeMemento();
        const store = createPendingEditsStore(memento);
        await store.set(URI_A, sampleEdits('two'), TEXT_A);
        assert(!!memento._raw(KEY) && !!memento._raw(KEY)[URI_A], 'precondition: the entry is stored');

        const got = store.get(URI_A, TEXT_A + '\n(* changed on disk *)');
        assert(JSON.stringify(got) === '{}', 'a fingerprint mismatch returns {} rather than stale edits');

        // Fire-and-forget: the clearing update is not awaited by `get` (init needs a sync value),
        // so let the microtask queue drain before inspecting the memento.
        await Promise.resolve();
        const raw = memento._raw(KEY);
        assert(!raw || !raw[URI_A], 'the stale entry is REMOVED from the memento, not just ignored');
    }

    // ---- Group 3: delete is per-URI — a second file's entry survives ----
    {
        const memento = createFakeMemento();
        const store = createPendingEditsStore(memento);
        await store.set(URI_A, sampleEdits('a'), TEXT_A);
        await store.set(URI_B, sampleEdits('b'), TEXT_B);
        await store.delete(URI_A);

        assert(JSON.stringify(store.get(URI_A, TEXT_A)) === '{}', 'the deleted URI reads back empty');
        const survivor = store.get(URI_B, TEXT_B);
        assert(survivor['root_Declaration'] && survivor['root_Declaration'].content.includes('* b *'),
            'the other URI\'s entry is untouched by the delete');
        const raw = memento._raw(KEY);
        assert(!!raw && !raw[URI_A] && !!raw[URI_B], 'only the deleted URI is gone from the stored map');
    }

    // ---- Group 4: an empty edits object is a delete ----
    {
        const memento = createFakeMemento();
        const store = createPendingEditsStore(memento);
        await store.set(URI_A, sampleEdits('three'), TEXT_A);
        await store.set(URI_A, {}, TEXT_A);
        assert(JSON.stringify(store.get(URI_A, TEXT_A)) === '{}', 'setting {} clears the entry');
        const raw = memento._raw(KEY);
        assert(!raw || !raw[URI_A], 'setting {} removes the entry from the memento');
    }

    // ---- Group 5: reading an unknown URI never writes ----
    {
        const memento = createFakeMemento();
        const store = createPendingEditsStore(memento);
        const got = store.get(URI_A, TEXT_A);
        assert(JSON.stringify(got) === '{}', 'an unknown URI reads back {}');
        await Promise.resolve();
        assert(memento._calls.filter(c => c.op === 'update').length === 0,
            'reading an absent entry performs no memento update');
    }

    // ---- Group 6: the stored value survives the JSON round trip workspaceState performs ----
    {
        const source = createFakeMemento();
        await createPendingEditsStore(source).set(URI_A, sampleEdits('json'), TEXT_A);

        const revived = createFakeMemento();
        revived._seed(KEY, JSON.parse(JSON.stringify(source._raw(KEY))));
        const got = createPendingEditsStore(revived).get(URI_A, TEXT_A);
        assert(JSON.stringify(got) === JSON.stringify(sampleEdits('json')),
            'the memento value is plain JSON: a round-tripped copy still returns the edits');
    }

    // ---- Group 7: the fingerprint is text-derived, not identity-derived ----
    {
        const memento = createFakeMemento();
        const store = createPendingEditsStore(memento);
        await store.set(URI_A, sampleEdits('four'), TEXT_A);
        // A different string object with the same content must still match.
        const sameText = TEXT_A.split('').join('');
        assert(Object.keys(store.get(URI_A, sameText)).length === 2,
            'an equal-content document text matches the fingerprint');
        // Same length, different content: the length half alone must not be what matches.
        const sameLength = TEXT_A.slice(0, TEXT_A.length - 1) + 'X';
        assert(JSON.stringify(store.get(URI_A, sameLength)) === '{}',
            'a same-length but different document text does NOT match the fingerprint');
    }

    console.log(`\n${errors === 0 ? 'ALL PASSED' : `${errors} FAILURE(S)`}`);
    if (errors > 0) process.exitCode = 1;
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
