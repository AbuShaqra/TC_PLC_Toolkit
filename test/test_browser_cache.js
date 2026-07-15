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

console.log(`\n--- BROWSER CACHE TESTS COMPLETE with ${errors} error(s) ---`);
process.exit(errors ? 1 : 0);
