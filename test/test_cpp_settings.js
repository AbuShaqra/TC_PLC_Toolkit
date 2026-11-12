/**
 * @file test_cpp_settings.js
 * @description The R13 switches of Compile Project (src/cppSettings.js): `generateCpp` and
 * `buildWithGpp`, both off by default, kept consistent per settings scope — turning the build on
 * turns generation on, turning generation off turns the build off — and the writes the Compile
 * dropdown's checkboxes make. Pure: no `vscode`.
 */

'use strict';

const s = require('../src/cppSettings');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const state = (gen, build) => ({ generateCpp: gen || {}, buildWithGpp: build || {} });

// ── Effective values ──────────────────────────────────────────────────────────────────────────
assert(eq(s.effectiveOptions(state()), { generateCpp: false, buildWithGpp: false }), 'DEFAULT: both switches are off');
assert(eq(s.effectiveOptions(state({ global: true })), { generateCpp: true, buildWithGpp: false }), 'EFFECTIVE: generation alone');
assert(eq(s.effectiveOptions(state({ global: false }, { global: true })), { generateCpp: true, buildWithGpp: true }),
    'EFFECTIVE: the build on means generation on, whatever generateCpp says (a run builds what it generates)');
assert(eq(s.effectiveOptions(state({ global: true, workspace: false })), { generateCpp: false, buildWithGpp: false }),
    'EFFECTIVE: the more specific scope wins');
assert(s.effectiveAt({ global: true, workspace: false }, 'global') === true && s.effectiveAt({ workspace: 'yes' }) === false,
    'EFFECTIVE: effectiveAt stops at the given scope; a non-boolean value counts as unset');

// ── Coupling after a change made elsewhere (Settings editor, settings.json) ───────────────────
assert(eq(s.couplingWrites(state(), state({}, { global: true })), [{ key: 'generateCpp', scope: 'global', value: true }]),
    'COUPLE: the build turned on in the user settings turns generation on there');
assert(eq(s.couplingWrites(state(), state({}, { workspace: true })), [{ key: 'generateCpp', scope: 'workspace', value: true }]),
    'COUPLE: the build turned on in the workspace turns generation on in the workspace (the scope changed)');
assert(eq(s.couplingWrites(state({ global: true }), state({ global: true }, { workspace: true })), []),
    'COUPLE: nothing to write when generation is already on at that scope (inherited from the user settings)');
assert(eq(s.couplingWrites(state({ global: true }, { global: true }), state({ global: false }, { global: true })),
    [{ key: 'buildWithGpp', scope: 'global', value: false }]),
'COUPLE: generation turned off while the build is on turns the build off in the same scope');
assert(eq(s.couplingWrites(state({ global: true }, { global: true }), state({ global: true, workspace: false }, { global: true })),
    [{ key: 'buildWithGpp', scope: 'workspace', value: false }]),
'COUPLE: generation turned off in the workspace turns the build off in the workspace, not in the user settings');
assert(eq(s.couplingWrites(state({ global: true }, { global: true }), state({}, { global: true })),
    [{ key: 'buildWithGpp', scope: 'global', value: false }]),
'COUPLE: removing generation (back to its default, off) also turns the build off');
assert(eq(s.couplingWrites(state({ global: true }), state({ global: false })), []), 'COUPLE: generation off with the build off: nothing to do');
assert(eq(s.couplingWrites(state({ global: true }, { global: true }), state({ global: true }, {})), []),
    'COUPLE: the build turned off leaves generation alone');
assert(eq(s.couplingWrites(state({ global: true }), state({ global: false }, { global: true })),
    [{ key: 'generateCpp', scope: 'global', value: true }]),
'COUPLE: build on and generation off at once (a hand edit): the build wins, generation is turned back on');
// The coupled write itself, fed back as the next change, writes nothing more (no ping-pong).
{
    const after = state({ global: true }, { global: true });
    assert(eq(s.couplingWrites(state({}, { global: true }), after), []), 'COUPLE: the fix-up write causes no further write');
}

// ── The dropdown's checkboxes ─────────────────────────────────────────────────────────────────
assert(eq(s.checkboxWrites('generateCpp', true, state()), [{ key: 'generateCpp', scope: 'global', value: true }]),
    'BOX: ticking Generate C++ writes it to the user settings');
assert(eq(s.checkboxWrites('buildWithGpp', true, state()),
    [{ key: 'buildWithGpp', scope: 'global', value: true }, { key: 'generateCpp', scope: 'global', value: true }]),
'BOX: ticking Build with g++ also ticks Generate C++');
assert(eq(s.checkboxWrites('generateCpp', false, state({ global: true }, { global: true })),
    [{ key: 'generateCpp', scope: 'global', value: false }, { key: 'buildWithGpp', scope: 'global', value: false }]),
'BOX: unticking Generate C++ also unticks Build with g++');
assert(eq(s.checkboxWrites('generateCpp', false, state({}, { workspace: true })), [{ key: 'buildWithGpp', scope: 'workspace', value: false }]),
    'BOX: Generate C++ shown ticked only because of the build: unticking it turns the build off where it is set');
assert(eq(s.checkboxWrites('buildWithGpp', false, state({ global: true }, { global: true })), [{ key: 'buildWithGpp', scope: 'global', value: false }]),
    'BOX: unticking Build with g++ leaves Generate C++ on');
assert(eq(s.checkboxWrites('generateCpp', true, state({ workspace: false })), [{ key: 'generateCpp', scope: 'workspace', value: true }]),
    'BOX: a switch set in the workspace is written there (so the click takes effect)');
assert(eq(s.checkboxWrites('generateCpp', true, state({ global: true })), []), 'BOX: no write when the value is already in effect');
assert(s.targetScope({ global: true, workspaceFolder: false }) === 'workspaceFolder' && s.targetScope({}) === 'global',
    'BOX: the target is the most specific scope that sets the switch, else the user settings');

// ── readOptionState over a VS Code-shaped configuration ───────────────────────────────────────
{
    const config = { inspect: (key) => (key === 'generateCpp' ? { globalValue: true, workspaceValue: undefined } : { workspaceValue: true }) };
    assert(eq(s.readOptionState(config), { generateCpp: { global: true, workspace: undefined, workspaceFolder: undefined },
        buildWithGpp: { global: undefined, workspace: true, workspaceFolder: undefined } }), 'READ: inspect() values become scope values');
    assert(s.CPP_SECTION === 'tcToolkit.compiler' && eq([...s.OPTION_KEYS], ['generateCpp', 'buildWithGpp']), 'KEYS: tcToolkit.compiler.generateCpp / buildWithGpp');
}

if (errors > 0) {
    console.error(`\n${errors} C++ settings assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll C++ settings assertions passed.');
