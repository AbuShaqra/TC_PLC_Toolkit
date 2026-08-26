'use strict';

// Tests the browsercache parser (src/lsp/browserCache.js): TwinCAT's per-library object tree, from which
// we harvest the METHOD and PROPERTY names of library function blocks and interfaces. Standalone Node.
//
// The parse must: file each member under the FB/interface that owns it; tell a property from a method by
// its TypeGUID; and NOT mistake a property's Get/Set accessors (its own children) for methods of the FB.

const { parseBrowserCache } = require('../src/lsp/browserCache');

let errors = 0;
function ok(cond, msg) { console.log(`${cond ? '[PASS]' : '[FAIL]'} ${msg}`); if (!cond) errors++; }
function eqArr(actual, expected, msg) {
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)})`);
}

// CODESYS object-type GUIDs (stable), the same the parser keys on.
const FB = '{6f9dac99-8de1-4efc-8465-68ac443b7d08}';
const ITF = '{6654496c-404d-479a-aad2-8551054e5f1e}';
const METHOD = '{f8a58466-d7f6-439f-bbb8-d4600e41d099}';
const METHOD2 = '{8ac092e5-3128-4e26-9e7e-11016c6684f2}';   // a second FB-method variant
const ITF_METHOD = '{f89f7675-27f1-46b3-8abb-b7da8e774ffd}'; // interface method
const PROPERTY = '{5a3b8626-d3e9-4f37-98b5-66420063d91e}';
const ACCESSOR = '{792f2eb6-721e-4e64-ba20-bc98351056db}';   // Get/Set — a property's children
const FOLDER = '{738bea1e-99bb-4f04-90bb-a7a567e74e3a}';
const DUT = '{2db5746d-d284-4425-9f7f-2663a34b0ebc}';
let g = 0; const oid = () => `{00000000-0000-0000-0000-${String(++g).padStart(12, '0')}}`;
const node = (name, type, children) => children
    ? `<Node Name="${name}" TypeGUID="${type}" ObjectGUID="${oid()}">${children}</Node>`
    : `<Node Name="${name}" TypeGUID="${type}" ObjectGUID="${oid()}" />`;

const XML = `<?xml version="1.0" encoding="utf-8"?>
<Library Name="TestLib, 1.0.0.0 (Acme)">
  ${node('COMPONENTs', FOLDER,
        node('FB_Widget', FB,
            node('Init', METHOD) +
            node('Cyclic', METHOD) +
            node('Reset', METHOD2) +
            node('Enabled', PROPERTY, node('Get', ACCESSOR) + node('Set', ACCESSOR)) +
            // a same-named method in a different case must not double
            node('cyclic', METHOD)
        )
  )}
  ${node('I_Widget', ITF,
        node('DoThing', ITF_METHOD) +
        node('Status', PROPERTY, node('Get', ACCESSOR))
  )}
  ${node('ST_Data', DUT)}
</Library>`;

const types = parseBrowserCache(XML);

ok(types.size === 2, `only FB and interface become types — not the DUT (got ${types.size})`);
ok(!types.has('st_data'), 'a DUT is not treated as a member-bearing type');

const fb = types.get('fb_widget');
ok(fb && fb.kind === 'fb', 'FB_Widget parsed as an fb');
eqArr(fb && fb.methods, ['Init', 'Cyclic', 'Reset'], "FB methods, de-duplicated case-insensitively (no 'cyclic' twin)");
eqArr(fb && fb.properties, ['Enabled'], 'FB property, told from methods by its GUID');
ok(fb && !fb.methods.some(m => m.toLowerCase() === 'get'),
    "a property's Get/Set accessors are NOT harvested as methods of the FB");

const itf = types.get('i_widget');
ok(itf && itf.kind === 'interface', 'I_Widget parsed as an interface');
eqArr(itf && itf.methods, ['DoThing'], 'interface method (its own GUID) is harvested');
eqArr(itf && itf.properties, ['Status'], 'interface property is harvested');

// Robustness: malformed / empty input must not throw.
ok(parseBrowserCache('').size === 0, 'empty string yields no types');
ok(parseBrowserCache(null).size === 0, 'null yields no types');

// ---------------------------------------------------------------------------------------------
// Ranking a namespace-qualified caret (`Tc2_MC2.▮`) — rankNamespaceSymbol.
// ---------------------------------------------------------------------------------------------
// A library's string table cannot tell a top-level type from an internal member name: measured on
// the real Tc2_MC2, 2,269 names of which the `.tmc` describes ~57 and the browsercache names 128 as
// real FBs plus 27 as member-only. The two sources cover different ground — the `.tmc` only exports
// what the project already USES, the browsercache lists everything the library declares — so both
// feed the ranking, and neither may filter: each is evidence of presence, never of absence.
console.log('\n--- namespace symbol ranking ---');
{
    const { rankNamespaceSymbol } = require('../src/lsp/features/completions');

    const tmc = new Map([['mc_power', { name: 'MC_Power', kind: 'fb' }]]);
    const bc = new Map([
        ['mc_power', { name: 'MC_Power', kind: 'fb' }],           // in BOTH — the .tmc must win
        ['mc_movevelocity', { name: 'MC_MoveVelocity', kind: 'fb' }],
        ['i_axis', { name: 'I_Axis', kind: 'interface' }]
    ]);
    const members = new Set(['actstop']);
    const isMember = n => members.has(String(n).toLowerCase());
    const rank = n => rankNamespaceSymbol(n, 'Tc2_MC2', tmc, bc, isMember);

    const tmcItem = rank('MC_Power');
    ok(tmcItem.sortText === '0_MC_Power', `a .tmc type takes tier 0 (got ${tmcItem.sortText})`);
    ok(tmcItem.detail === 'Function Block (Tc2_MC2)', `...with its real kind, not "Library Symbol" (got ${tmcItem.detail})`);

    const bcItem = rank('MC_MoveVelocity');
    ok(bcItem.sortText === '1_MC_MoveVelocity',
        `a type only the browsercache declares takes tier 1 (got ${bcItem.sortText})`);
    ok(bcItem.detail === 'Function Block (Tc2_MC2)', `...also with a real kind (got ${bcItem.detail})`);

    const itfItem = rank('I_Axis');
    ok(itfItem.kind === 8 && itfItem.detail === 'Interface (Tc2_MC2)',
        `an interface is reported as one, not as a Class (got kind=${itfItem.kind}, ${itfItem.detail})`);

    const plain = rank('SomethingUnknown');
    ok(plain.sortText === undefined,
        `an undifferentiated string-table name stays untiered (got ${plain.sortText})`);
    ok(plain.detail === 'Library Symbol (Tc2_MC2)', `...and keeps the generic detail (got ${plain.detail})`);

    const member = rank('ActStop');
    ok(member.sortText === 'zz_ActStop', `a member-only name sinks to tier 3 (got ${member.sortText})`);
    ok(member.detail === 'Member of a Tc2_MC2 type', `...and says why (got ${member.detail})`);

    // Nothing is ever dropped, whatever the tier — that is the standing rule for this list.
    for (const n of ['MC_Power', 'MC_MoveVelocity', 'I_Axis', 'SomethingUnknown', 'ActStop']) {
        ok(rank(n).label === n, `${n} survives ranking (nothing is filtered out)`);
    }

    // Ordering: the tier prefixes must actually sort the way the tiers are numbered — asserted
    // under BOTH comparisons, because they disagree about punctuation and digits. The member tier
    // is the trap: it has to land below entries that carry no sortText at all and so sort on their
    // letter-initial labels, which a '9_' or '~' prefix does not do.
    const keyed = ['MC_Power', 'MC_MoveVelocity', 'SomethingUnknown', 'ActStop']
        .map(n => { const i = rank(n); return { n, key: (i.sortText || i.label) }; });
    const EXPECTED = ['MC_Power', 'MC_MoveVelocity', 'SomethingUnknown', 'ActStop'];
    const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    eqArr([...keyed].sort((a, b) => byCodePoint(a.key, b.key)).map(x => x.n), EXPECTED,
        'tiers sort .tmc type, then browsercache type, then unknown, then member (code-point order)');
    eqArr([...keyed].sort((a, b) => a.key.localeCompare(b.key)).map(x => x.n), EXPECTED,
        '...and identically under locale collation');

    // Both sources absent (a fresh clone: no .tmc, no libraries installed) must still yield a
    // usable list rather than throwing or hiding everything.
    const bare = rankNamespaceSymbol('MC_Power', 'Tc2_MC2', new Map(), new Map(), () => false);
    ok(bare.label === 'MC_Power' && bare.sortText === undefined,
        'with neither .tmc nor browsercache, symbols still list (untiered)');
}

console.log(`\n--- BROWSER CACHE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors ? 1 : 0);
