/**
 * @file test_component_id.js
 * @description The component-id grammar owner: make/parse round-trips, the frozen minted
 * shapes (driven through the REAL parseTwinCatXml), and the consumer-facing helpers.
 */
const assert = require('assert');
const { parseTwinCatXml } = require('../src/xmlParser');
const cid = require('../src/componentId');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`[PASS] ${name}`); }
    catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failures++; }
}

// --- Conformance: every shape the real parser mints round-trips through parse/make ---
const FIXTURE_XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1" ProductVersion="3.1.4024.0">
  <POU Name="FB_Fixture" Id="{11111111-1111-1111-1111-111111111111}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Fixture
VAR
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[;]]></ST>
    </Implementation>
    <Method Name="do_stuff" Id="{22222222-2222-2222-2222-222222222222}">
      <Declaration><![CDATA[METHOD do_stuff : BOOL]]></Declaration>
      <Implementation>
        <ST><![CDATA[;]]></ST>
      </Implementation>
    </Method>
    <Property Name="Speed" Id="{33333333-3333-3333-3333-333333333333}">
      <Declaration><![CDATA[PROPERTY Speed : INT]]></Declaration>
      <Get Name="Get" Id="{44444444-4444-4444-4444-444444444444}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[Speed := 1;]]></ST>
        </Implementation>
      </Get>
      <Set Name="Set" Id="{55555555-5555-5555-5555-555555555555}">
        <Declaration><![CDATA[VAR
END_VAR]]></Declaration>
        <Implementation>
          <ST><![CDATA[;]]></ST>
        </Implementation>
      </Set>
    </Property>
    <Action Name="Reset" Id="{66666666-6666-6666-6666-666666666666}">
      <Implementation>
        <ST><![CDATA[;]]></ST>
      </Implementation>
    </Action>
    <Transition Name="Ready" Id="{77777777-7777-7777-7777-777777777777}">
      <Implementation>
        <ST><![CDATA[TRUE]]></ST>
      </Implementation>
    </Transition>
  </POU>
</TcPlcObject>`;

check('fixture parses and mints every id shape', () => {
    const parsed = parseTwinCatXml(FIXTURE_XML);
    assert.ok(parsed, 'parseTwinCatXml returned null for the fixture');
    const ids = parsed.components.map(c => c.id);
    for (const expected of ['root', 'method_do_stuff', 'prop_Speed', 'prop_Speed_get',
                            'prop_Speed_set', 'action_Reset', 'transition_Ready']) {
        assert.ok(ids.includes(expected), `minted ids missing ${expected} (got: ${ids.join(', ')})`);
    }
    for (const id of ids) {
        const p = cid.parse(id);
        assert.ok(p, `parse(${id}) returned null on a minted id`);
        const remade = p.kind === 'root' ? 'root' : cid.make(p.kind, p.name, p.accessor);
        assert.strictEqual(remade, id, `round trip broke: ${id} -> ${remade}`);
    }
});

// --- parse: the frozen table ---
check('parse table', () => {
    assert.deepStrictEqual(cid.parse('root'), { kind: 'root', name: null, accessor: null });
    assert.deepStrictEqual(cid.parse('method_do_stuff'), { kind: 'method', name: 'do_stuff', accessor: null });
    assert.deepStrictEqual(cid.parse('prop_Speed'), { kind: 'prop', name: 'Speed', accessor: null });
    assert.deepStrictEqual(cid.parse('prop_Speed_get'), { kind: 'prop', name: 'Speed', accessor: 'get' });
    assert.deepStrictEqual(cid.parse('prop_Speed_set'), { kind: 'prop', name: 'Speed', accessor: 'set' });
    assert.deepStrictEqual(cid.parse('action_Reset'), { kind: 'action', name: 'Reset', accessor: null });
    assert.deepStrictEqual(cid.parse('transition_Ready'), { kind: 'transition', name: 'Ready', accessor: null });
    // The pinned ambiguity convention: accessor wins (matches dndRules/clipboard/referencesTree).
    assert.deepStrictEqual(cid.parse('prop_X_get'), { kind: 'prop', name: 'X', accessor: 'get' });
    // Outside the grammar:
    assert.strictEqual(cid.parse('trans_Ready'), null);
    assert.strictEqual(cid.parse('Method_Init'), null);   // prefixes are lowercase, case-sensitive
    assert.strictEqual(cid.parse('method_'), null);        // empty name is not a component
    assert.strictEqual(cid.parse(''), null);
    assert.strictEqual(cid.parse(null), null);
});

// --- make: valid combinations + programmer-error guard ---
check('make', () => {
    assert.strictEqual(cid.make('method', 'do_stuff'), 'method_do_stuff');
    assert.strictEqual(cid.make('prop', 'Speed'), 'prop_Speed');
    assert.strictEqual(cid.make('prop', 'Speed', 'get'), 'prop_Speed_get');
    assert.strictEqual(cid.make('transition', 'Ready'), 'transition_Ready');
    assert.strictEqual(cid.make('root'), 'root');
    assert.throws(() => cid.make('method', 'X', 'get'), /accessor/);
    assert.throws(() => cid.make('bogus', 'X'), /kind/);
    assert.throws(() => cid.make('method', ''), /name/);
});

// --- consumer helpers ---
check('isAccessor', () => {
    assert.strictEqual(cid.isAccessor('prop_Speed_get'), true);
    assert.strictEqual(cid.isAccessor('prop_Speed_set'), true);
    assert.strictEqual(cid.isAccessor('prop_Speed'), false);
    assert.strictEqual(cid.isAccessor('method_get_thing'), false);
    assert.strictEqual(cid.isAccessor('root'), false);
});
check('label — including the transition fix', () => {
    assert.strictEqual(cid.label('root'), 'Main');
    assert.strictEqual(cid.label(''), 'Main');
    assert.strictEqual(cid.label('method_Cyclic'), 'Cyclic()');
    assert.strictEqual(cid.label('prop_Speed'), 'Speed');
    assert.strictEqual(cid.label('prop_Speed_get'), 'Speed');
    assert.strictEqual(cid.label('action_Reset'), 'Reset');
    assert.strictEqual(cid.label('transition_Ready'), 'Ready');   // THE BUG: was 'transition_Ready'
    assert.strictEqual(cid.label('weird_thing'), 'weird_thing');  // preserved fallback
});
check('memberName — including the transition fix', () => {
    assert.strictEqual(cid.memberName('root'), 'root');
    assert.strictEqual(cid.memberName('method_Cyclic'), 'Cyclic');
    assert.strictEqual(cid.memberName('prop_Speed_get'), 'Speed_get'); // preserves today's peek path
    assert.strictEqual(cid.memberName('transition_Ready'), 'Ready');   // THE BUG: was 'transition_Ready'
    assert.strictEqual(cid.memberName('weird_thing'), 'weird_thing');
});
check('KIND_TO_XML_TAG', () => {
    assert.deepStrictEqual(cid.KIND_TO_XML_TAG,
        { method: 'Method', prop: 'Property', action: 'Action', transition: 'Transition' });
});
check('KINDS is frozen', () => {
    assert.ok(Object.isFrozen(cid.KINDS), 'KINDS must be frozen like KIND_TO_XML_TAG');
});
check('degenerate prop__get parse is pinned', () => {
    // A property named '_get': the accessor regex requires a non-empty name before the suffix,
    // so this is NOT an accessor — it is the correct reading, pinned so nobody "fixes" it.
    assert.deepStrictEqual(cid.parse('prop__get'), { kind: 'prop', name: '_get', accessor: null });
});
check('accessorIdsFor builds mint-identical accessor ids by concatenation', () => {
    assert.deepStrictEqual(cid.accessorIdsFor('prop_Speed'), { get: 'prop_Speed_get', set: 'prop_Speed_set' });
    // The Phase-1 Critical shape: a property literally named Data_get must NOT self-collapse.
    assert.deepStrictEqual(cid.accessorIdsFor('prop_Data_get'), { get: 'prop_Data_get_get', set: 'prop_Data_get_set' });
    assert.throws(() => cid.accessorIdsFor('method_Run'), /prop/);
    assert.throws(() => cid.accessorIdsFor('root'), /prop/);
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
