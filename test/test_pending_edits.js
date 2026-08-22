/**
 * @file test_pending_edits.js
 * @description The pending-edit state machine (`media/pendingEdits.js`) that both the webview
 * (stashing unsaved edits until they flush/save) and the extension host (folding them into the
 * document text) share.
 *
 * Pins the store's key format (`${componentId}_${blockType}`), the status-string/className pairs
 * `updateStatusText` used to compute inline, the init-restore matcher's triple-key match
 * (subType + subName + accessorType — the get/set accessor disambiguation), and `foldEdits`'s
 * reduce order, which both `customEditorProvider.js` fold loops ('sync-pending' and 'save') share.
 */

const { createStore, statusFor, applyCachedEdits, foldEdits } = require('../media/pendingEdits');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

function main() {
    // ---- Group 1: createStore / stash / count / snapshot ----
    {
        const store = createStore();
        store.stash('MyComp', 'Declaration', { subType: 'a' }, 'DECL TEXT');
        store.stash('MyComp', 'ST', { subType: 'a' }, 'ST TEXT');
        assert(store.count() === 2, `two distinct blockTypes -> count 2 (got ${store.count()})`);

        const snap = store.snapshot();
        assert(Object.prototype.hasOwnProperty.call(snap, 'MyComp_Declaration'),
            'snapshot key format is `${componentId}_${blockType}` (MyComp_Declaration)');
        assert(Object.prototype.hasOwnProperty.call(snap, 'MyComp_ST'), 'snapshot has MyComp_ST key too');
        assert(snap['MyComp_Declaration'].context.subType === 'a', 'record.context preserved');
        assert(snap['MyComp_Declaration'].blockType === 'Declaration', 'record.blockType preserved');
        assert(snap['MyComp_Declaration'].content === 'DECL TEXT', 'record.content preserved');
    }

    // ---- Group 2: re-stash same key overwrites, count unchanged ----
    {
        const store = createStore();
        store.stash('MyComp', 'Declaration', { subType: 'a' }, 'FIRST');
        store.stash('MyComp', 'Declaration', { subType: 'a' }, 'SECOND');
        assert(store.count() === 1, `re-stashing the same key does not grow count (got ${store.count()})`);
        assert(store.snapshot()['MyComp_Declaration'].content === 'SECOND', 're-stash overwrites the record');
    }

    // ---- Group 3: takeAll returns records and empties the store ----
    {
        const store = createStore();
        store.stash('MyComp', 'Declaration', { subType: 'a' }, 'DECL TEXT');
        store.stash('MyComp', 'ST', { subType: 'a' }, 'ST TEXT');
        const all = store.takeAll();
        assert(Array.isArray(all) && all.length === 2, `takeAll returns the records array (got length ${all.length})`);
        const contents = all.map(e => e.content).sort();
        assert(contents.join(',') === 'DECL TEXT,ST TEXT', 'takeAll records carry the stashed content');
        assert(store.count() === 0, `takeAll empties the store (count now ${store.count()})`);
        assert(Object.keys(store.snapshot()).length === 0, 'snapshot is {} after takeAll');
    }

    // ---- Group 4: createStore(seed) starts pre-populated ----
    {
        const seed = { 'Other_Declaration': { context: { subType: 'x' }, blockType: 'Declaration', content: 'SEEDED' } };
        const store = createStore(seed);
        assert(store.count() === 1, `createStore(seed) starts with the seed's keys (got count ${store.count()})`);
        assert(store.snapshot()['Other_Declaration'].content === 'SEEDED', 'seeded record content preserved');
        // createStore(initial) ALIASES the passed object rather than copying it — snapshot() returns
        // the exact same reference. editor.js's 'init' handler relies on this: it passes
        // message.cachedEdits straight in and later reads editsStore.snapshot() back out, so if the
        // store ever started copying, that message-object identity would silently break.
        assert(store.snapshot() === seed, 'createStore(initial) aliases the seed object (snapshot() === seed)');

        const emptyStore = createStore();
        assert(emptyStore.count() === 0, 'createStore() with no arg starts empty');
        assert(emptyStore.count() === 0 && Object.keys(emptyStore.snapshot()).length === 0,
            'createStore(undefined) -> {} (count 0)');
    }

    // ---- Group 5: statusFor ----
    {
        const zero = statusFor(0);
        assert(zero.text === 'Synced', `statusFor(0).text === 'Synced' (got "${zero.text}")`);
        assert(zero.className === 'status-indicator', `statusFor(0).className === 'status-indicator' (got "${zero.className}")`);

        const three = statusFor(3);
        assert(three.text === 'Unsaved Changes (3)', `statusFor(3).text exact string (got "${three.text}")`);
        assert(three.className === 'status-indicator modified', `statusFor(3).className exact string (got "${three.className}")`);

        const one = statusFor(1);
        assert(one.text === 'Unsaved Changes (1)', `statusFor(1).text exact string (got "${one.text}")`);
        assert(one.className === 'status-indicator modified', 'statusFor(1).className modified');
    }

    // ---- Group 6: applyCachedEdits ----
    {
        function comp(id, subType, subName, accessorType) {
            return { id, xmlContext: { subType, subName, accessorType }, declaration: 'ORIG DECL', implementation: 'ORIG IMPL' };
        }

        // Declaration edit lands in comp.declaration; ST edit lands in comp.implementation.
        {
            const components = [comp('C1', 'Method', 'Foo', null)];
            const cachedEdits = {
                'C1_Declaration': { context: { subType: 'Method', subName: 'Foo', accessorType: null }, blockType: 'Declaration', content: 'NEW DECL' },
                'C1_ST': { context: { subType: 'Method', subName: 'Foo', accessorType: null }, blockType: 'ST', content: 'NEW IMPL' }
            };
            applyCachedEdits(components, cachedEdits);
            assert(components[0].declaration === 'NEW DECL', 'Declaration-blockType edit overwrites comp.declaration');
            assert(components[0].implementation === 'NEW IMPL', 'non-Declaration blockType edit overwrites comp.implementation');
        }

        // Matching is by the xmlContext TRIPLE — a component differing only in accessorType must
        // NOT match (get/set accessor disambiguation).
        {
            const components = [
                comp('Get', 'Property', 'Bar', 'get'),
                comp('Set', 'Property', 'Bar', 'set')
            ];
            const cachedEdits = {
                'X_Declaration': { context: { subType: 'Property', subName: 'Bar', accessorType: 'get' }, blockType: 'Declaration', content: 'GETTER DECL' }
            };
            applyCachedEdits(components, cachedEdits);
            assert(components[0].declaration === 'GETTER DECL', 'accessorType match (get) lands the edit on the get component');
            assert(components[1].declaration === 'ORIG DECL', 'accessorType mismatch (set) is left untouched');
        }

        // An edit with no matching component is silently dropped (no throw, no mutation).
        {
            const components = [comp('C1', 'Method', 'Foo', null)];
            const cachedEdits = {
                'Ghost_Declaration': { context: { subType: 'Method', subName: 'NoSuchOne', accessorType: null }, blockType: 'Declaration', content: 'SHOULD NOT LAND' }
            };
            applyCachedEdits(components, cachedEdits);
            assert(components[0].declaration === 'ORIG DECL', 'edit with no matching component is silently dropped');
        }

        // null / absent cachedEdits is a no-op.
        {
            const components = [comp('C1', 'Method', 'Foo', null)];
            applyCachedEdits(components, null);
            assert(components[0].declaration === 'ORIG DECL', 'null cachedEdits is a no-op');
            applyCachedEdits(components, undefined);
            assert(components[0].declaration === 'ORIG DECL', 'undefined cachedEdits is a no-op');
        }
    }

    // ---- Group 7: foldEdits ----
    {
        // Edits apply in array order, each receiving the previous return value; record fields are
        // passed positionally (context, blockType, content).
        {
            const calls = [];
            function recorder(text, context, blockType, content) {
                calls.push({ text, context, blockType, content });
                return text + '|' + content;
            }
            const edits = [
                { context: 'ctxA', blockType: 'Declaration', content: 'A' },
                { context: 'ctxB', blockType: 'ST', content: 'B' },
                { context: 'ctxC', blockType: 'Declaration', content: 'C' }
            ];
            const result = foldEdits('START', edits, recorder);
            assert(result === 'START|A|B|C', `foldEdits threads the accumulator through in order (got "${result}")`);
            assert(calls.length === 3, 'replace called once per edit');
            assert(calls[0].text === 'START', 'first call receives the initial text');
            assert(calls[1].text === 'START|A', 'second call receives the first call\'s return value');
            assert(calls[2].text === 'START|A|B', 'third call receives the second call\'s return value');
            assert(calls[0].context === 'ctxA' && calls[0].blockType === 'Declaration' && calls[0].content === 'A',
                'record fields passed positionally: context, blockType, content');
        }

        // Empty edits array -> text unchanged.
        {
            let called = false;
            const result = foldEdits('UNCHANGED', [], () => { called = true; return 'SHOULD NOT BE USED'; });
            assert(result === 'UNCHANGED', 'empty edits array leaves text unchanged');
            assert(!called, 'replace is never invoked for an empty edits array');
        }
    }

    console.log(`\n${errors === 0 ? 'ALL PASSED' : `${errors} FAILURE(S)`}`);
    if (errors > 0) process.exitCode = 1;
}

main();
