/**
 * @file test_property_node_context.js
 * @description The property row's contextValue and every consumer of it (issue #25).
 *
 * The Objects tree encodes which accessors a property is MISSING in its contextValue
 * (`propertyNode`, `propertyNode.noGet`, `propertyNode.noSet`, `propertyNode.noGet.noSet`) so that
 * "Add Get Accessor" / "Add Set Accessor" show only while there is something to add. The risk is the
 * other direction: every menu `when` clause and every code path that used to compare with
 * 'propertyNode' must still accept all four variants, or copy/paste/delete/rename/insert silently
 * vanish from some properties. This harness pins:
 *  1. the tree builds the right variant for both / only Get / only Set / neither;
 *  2. the tree item id is the same for every variant (no reveal/expansion churn);
 *  3. package.json: no `viewItem == 'propertyNode'` remains, every property clause matches all four
 *     variants (and nothing else), and the two new entries match exactly the right variants and
 *     are hidden from the Command Palette;
 *  4. the code-side consumers (dndRules, isPropertyNode) accept every variant.
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

const XML = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="FB_Ctx" Id="{00000000-0000-0000-0000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION_BLOCK FB_Ctx
]]></Declaration>
    <Implementation><ST><![CDATA[]]></ST></Implementation>
    <Property Name="Both" Id="{00000000-0000-0000-0000-000000000002}">
      <Declaration><![CDATA[PROPERTY Both : INT
]]></Declaration>
      <Get Name="Get" Id="{00000000-0000-0000-0000-000000000003}">
        <Declaration><![CDATA[]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
      </Get>
      <Set Name="Set" Id="{00000000-0000-0000-0000-000000000004}">
        <Declaration><![CDATA[]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
      </Set>
    </Property>
    <Property Name="OnlyGet" Id="{00000000-0000-0000-0000-000000000005}">
      <Declaration><![CDATA[PROPERTY OnlyGet : INT
]]></Declaration>
      <Get Name="Get" Id="{00000000-0000-0000-0000-000000000006}">
        <Declaration><![CDATA[]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
      </Get>
    </Property>
    <Property Name="OnlySet" Id="{00000000-0000-0000-0000-000000000007}">
      <Declaration><![CDATA[PROPERTY OnlySet : INT
]]></Declaration>
      <Set Name="Set" Id="{00000000-0000-0000-0000-000000000008}">
        <Declaration><![CDATA[]]></Declaration><Implementation><ST><![CDATA[]]></ST></Implementation>
      </Set>
    </Property>
    <Property Name="Neither" Id="{00000000-0000-0000-0000-000000000009}">
      <Declaration><![CDATA[PROPERTY Neither : INT
]]></Declaration>
    </Property>
  </POU>
</TcPlcObject>`;

const uriFor = (fsPath) => ({
    fsPath,
    toString: () => 'file:///' + fsPath.replace(/\\/g, '/').replace(/^\/+/, '')
});

const ModuleResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === 'vscode') return 'vscode-property-context-stub';
    return ModuleResolve.call(this, req, ...rest);
};
const rootPath = path.resolve('C:\\CtxWorkspace');
require.cache['vscode-property-context-stub'] = {
    id: 'vscode-property-context-stub', filename: 'vscode-property-context-stub', loaded: true,
    exports: {
        EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
        TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
        ThemeColor: class { constructor(id) { this.id = id; } },
        Uri: { file: uriFor, joinPath: (base, name) => uriFor(path.join(base.fsPath, name)) },
        workspace: {
            workspaceFolders: [{ uri: uriFor(rootPath) }],
            openTextDocument: async () => ({ getText: () => XML })
        }
    }
};

const { TwinCatTreeDataProvider, TwinCatTreeItem } = require('../src/treeDataProvider');
const { isPropertyNode, propertyContextValue } = require('../src/objectKinds');
const { describeDragged } = require('../src/dndRules');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const VARIANTS = ['propertyNode', 'propertyNode.noGet', 'propertyNode.noSet', 'propertyNode.noGet.noSet'];
// contextValues that must NOT be taken for a property row.
const NON_PROPERTY = ['component', 'propertyNodeX', 'xpropertyNode', 'pouFile', 'pouVirtualFolder', 'Get', 'Set', ''];

// ── 1. The tree builds the right variant ─────────────────────────────────────────────────────────
const provider = new TwinCatTreeDataProvider(() => null, () => null);
const filePath = path.join(rootPath, 'PLC', 'POUs', 'FB_Ctx.TcPOU');
const fileUri = uriFor(filePath);

(async () => {
    const expected = {
        prop_Both: 'propertyNode',
        prop_OnlyGet: 'propertyNode.noSet',
        prop_OnlySet: 'propertyNode.noGet',
        prop_Neither: 'propertyNode.noGet.noSet'
    };
    for (const [id, cv] of Object.entries(expected)) {
        const item = await provider.getRevealItem(fileUri, id);
        assert(item && item.contextValue === cv, `TREE: ${id} → contextValue '${cv}' (got '${item && item.contextValue}')`);
        assert(item && item.id === fileUri.toString() + '#' + id,
            `TREE: ${id} keeps the component-shaped tree id whatever its variant (got ${item && item.id})`);
    }
    for (const id of ['prop_Both_get', 'prop_Both_set', 'prop_OnlyGet_get', 'prop_OnlySet_set']) {
        const item = await provider.getRevealItem(fileUri, id);
        assert(item && item.contextValue === 'component', `TREE: accessor ${id} stays a plain 'component' row`);
    }
    const neither = await provider.getRevealItem(fileUri, 'prop_Neither');
    assert(neither && neither.collapsibleState === 0, 'TREE: a property with no accessors is a leaf');

    // The id getter accepts every variant (a constructed item, independent of the fixture).
    for (const cv of VARIANTS) {
        const item = new TwinCatTreeItem('P', fileUri, 0, cv, null, null);
        item.componentId = 'prop_P';
        assert(item.id === fileUri.toString() + '#prop_P', `ID: '${cv}' yields the component id`);
    }

    // ── 2. Helpers ───────────────────────────────────────────────────────────────────────────────
    assert(propertyContextValue(true, true) === 'propertyNode', 'HELPER: both → propertyNode');
    assert(propertyContextValue(true, false) === 'propertyNode.noSet', 'HELPER: only Get → .noSet');
    assert(propertyContextValue(false, true) === 'propertyNode.noGet', 'HELPER: only Set → .noGet');
    assert(propertyContextValue(false, false) === 'propertyNode.noGet.noSet', 'HELPER: neither → .noGet.noSet');
    for (const cv of VARIANTS) assert(isPropertyNode(cv), `HELPER: isPropertyNode('${cv}')`);
    for (const cv of NON_PROPERTY) assert(!isPropertyNode(cv), `HELPER: !isPropertyNode('${cv}')`);

    // ── 3. package.json menus ────────────────────────────────────────────────────────────────────
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const menus = pkg.contributes.menus;
    const allWhen = Object.values(menus).flat().map(m => m.when || '');
    const keybindingWhen = (pkg.contributes.keybindings || []).map(k => k.when || '');
    assert(![...allWhen, ...keybindingWhen].some(w => /viewItem\s*==\s*'propertyNode'/.test(w)),
        "MENUS: no `viewItem == 'propertyNode'` equality remains anywhere");

    /** Every `viewItem =~ /…/` regex mentioning propertyNode in a when clause. */
    const regexesIn = (when) => [...when.matchAll(/viewItem\s*=~\s*\/((?:\\\/|[^/])+)\/([a-z]*)/g)]
        .filter(m => m[1].includes('propertyNode'))
        .map(m => new RegExp(m[1], m[2]));

    const ctx = menus['view/item/context'];
    const propertyEntries = ctx.filter(m => /propertyNode/.test(m.when || ''));
    const accessorCommands = new Set(['twincat.addGetAccessor', 'twincat.addSetAccessor']);
    const general = propertyEntries.filter(m => !accessorCommands.has(m.command));
    const generalCommands = general.map(m => m.command).sort();
    const expectedGeneral = ['twincat.copyObject', 'twincat.deleteComponent', 'twincat.insertObjectAtCursor',
        'twincat.pasteObject', 'twincat.renameObject'];
    assert(JSON.stringify(generalCommands) === JSON.stringify(expectedGeneral),
        `MENUS: the five property-row entries are all still there (got ${generalCommands.join(', ')})`);
    for (const m of general) {
        const res = regexesIn(m.when);
        assert(res.length === 1, `MENUS: ${m.command} has exactly one propertyNode regex`);
        for (const re of res) {
            assert(VARIANTS.every(v => re.test(v)), `MENUS: ${m.command} matches all four property variants`);
            assert(NON_PROPERTY.every(v => !re.test(v)), `MENUS: ${m.command}'s regex matches nothing but property rows`);
        }
    }

    const entry = (cmd) => ctx.find(m => m.command === cmd);
    const expectFor = {
        'twincat.addGetAccessor': ['propertyNode.noGet', 'propertyNode.noGet.noSet'],
        'twincat.addSetAccessor': ['propertyNode.noSet', 'propertyNode.noGet.noSet']
    };
    for (const [cmd, want] of Object.entries(expectFor)) {
        const m = entry(cmd);
        assert(!!m, `MENUS: ${cmd} has a view/item/context entry`);
        if (!m) continue;
        assert(/\bview == twincatExplorer\b/.test(m.when), `MENUS: ${cmd} is scoped to the Objects view`);
        const res = regexesIn(m.when);
        assert(res.length === 1, `MENUS: ${cmd} has exactly one propertyNode regex`);
        const matched = [...VARIANTS, ...NON_PROPERTY].filter(v => res[0] && res[0].test(v));
        assert(JSON.stringify(matched) === JSON.stringify(want),
            `MENUS: ${cmd} shows for exactly ${want.join(' + ')} (got ${matched.join(' + ') || 'nothing'})`);
        const declared = pkg.contributes.commands.find(c => c.command === cmd);
        assert(!!declared, `COMMANDS: ${cmd} is declared`);
        const palette = (menus.commandPalette || []).find(c => c.command === cmd);
        assert(!!palette && palette.when === 'false', `COMMANDS: ${cmd} is hidden from the Command Palette`);
    }
    assert(entry('twincat.addGetAccessor').group < entry('twincat.deleteComponent').group
        && entry('twincat.addSetAccessor').group < entry('twincat.deleteComponent').group,
    'MENUS: the add entries sort before Delete in the same group');
    assert(pkg.contributes.commands.find(c => c.command === 'twincat.addGetAccessor').title === 'Add Get Accessor'
        && pkg.contributes.commands.find(c => c.command === 'twincat.addSetAccessor').title === 'Add Set Accessor',
    'COMMANDS: titles are "Add Get Accessor" / "Add Set Accessor"');

    // ── 4. Code-side consumers ───────────────────────────────────────────────────────────────────
    for (const cv of VARIANTS) {
        const d = describeDragged({ contextValue: cv, resourceUri: fileUri, componentId: 'prop_Both' });
        assert(!!d && d.kind === 'component' && d.componentName === 'Both',
            `DND: a '${cv}' row is draggable as its property`);
    }

    // No source file compares a contextValue with 'propertyNode' by equality any more.
    const srcFiles = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) srcFiles.push(p);
        }
    };
    walk(path.join(__dirname, '..', 'src'));
    srcFiles.push(path.join(__dirname, '..', 'extension.js'));
    const offenders = srcFiles.filter(f => /[=!]==?\s*'propertyNode'|'propertyNode'\s*[=!]==?|Set\(\[[^\]]*'propertyNode'/.test(fs.readFileSync(f, 'utf8')))
        .map(f => path.relative(path.join(__dirname, '..'), f));
    assert(offenders.length === 0, `CODE: no equality test against 'propertyNode' in src/ or extension.js (${offenders.join(', ') || 'none'})`);

    if (errors) {
        console.error(`\n${errors} property-node context assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll property-node context assertions passed.');
})().catch(err => {
    console.error('[FAIL] harness crashed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
