/**
 * @file test_settings_migration.js
 * @description The one-time move of setting values from the old `twincat.*` keys to `tcToolkit.*`
 * (src/settingsMigration.js), against a fake configuration store with VS Code's scope model: every
 * scope is migrated (User, Workspace, each workspace folder), a value already under the new key is
 * never overwritten, a second run changes nothing, and a failing write is logged, not thrown.
 */

'use strict';

const { SETTING_RENAMES, migrateSettings } = require('../src/settingsMigration');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const T = Object.freeze({ Global: 1, Workspace: 2, WorkspaceFolder: 3 });

/**
 * A configuration store shaped like VS Code's: one map per scope, `getConfiguration(undefined, folderUri)`
 * scoping `inspect().workspaceFolderValue` and WorkspaceFolder writes to that folder.
 * @param {{failUpdate?: (key: string, value: unknown, target: number) => boolean, throwSync?: boolean}} [opts]
 */
function createStore(opts = {}) {
    const store = { global: new Map(), workspace: new Map(), folders: new Map([['uri:a', new Map()], ['uri:b', new Map()]]) };
    const writes = [];
    const getConfiguration = (section, resource) => {
        if (section !== undefined) throw new Error('the migration reads full keys from the root section');
        return {
            inspect: (key) => ({
                key,
                globalValue: store.global.get(key),
                workspaceValue: store.workspace.get(key),
                workspaceFolderValue: resource ? store.folders.get(/** @type {string} */ (resource)).get(key) : undefined
            }),
            update: (key, value, target) => {
                if (opts.failUpdate && opts.failUpdate(key, value, target)) {
                    if (opts.throwSync) throw new Error(`cannot write ${key}`);
                    return Promise.reject(new Error(`cannot write ${key}`));
                }
                const map = target === T.Global ? store.global : target === T.Workspace ? store.workspace
                    : resource ? store.folders.get(/** @type {string} */ (resource)) : null;
                if (!map) return Promise.reject(new Error('WorkspaceFolder write without a resource'));
                writes.push({ key, value, target, resource });
                if (value === undefined) map.delete(key); else map.set(key, value);
                return Promise.resolve();
            }
        };
    };
    return { store, writes, getConfiguration };
}
const folders = [{ uri: 'uri:a', name: 'A' }, { uri: 'uri:b', name: 'B' }];

(async () => {
    // ── The table ───────────────────────────────────────────────────────────────────────────────
    assert(SETTING_RENAMES.length === 10 && SETTING_RENAMES.every(r => /^twincat\./.test(r.from) && r.to === r.from.replace(/^twincat\./, 'tcToolkit.')),
        'ten renames, each twincat.<rest> → tcToolkit.<rest>');

    // ── Every scope moves, nothing is overwritten ───────────────────────────────────────────────
    {
        const { store, getConfiguration } = createStore();
        store.global.set('twincat.compiler.path', 'C:\\c.cjs');
        store.global.set('twincat.diagnostics.memberAccess', false);
        store.global.set('twincat.xaeShell.path4026', 'D:\\old\\TcXaeShell.exe');
        store.global.set('tcToolkit.xaeShell.path4026', 'E:\\new\\TcXaeShell.exe'); // already set under the new key
        store.workspace.set('twincat.libraryDefinitions.shell', 'x64');
        store.folders.get('uri:a').set('twincat.diagnostics.declarationTypes', true);
        store.folders.get('uri:b').set('twincat.diagnostics.declarationTypes', false);
        store.folders.get('uri:b').set('tcToolkit.diagnostics.declarationTypes', true);
        const logs = [];
        const steps = await migrateSettings({ getConfiguration, workspaceFolders: folders, ConfigurationTarget: T, log: (m) => logs.push(m) });

        assert(store.global.get('tcToolkit.compiler.path') === 'C:\\c.cjs' && store.global.get('tcToolkit.diagnostics.memberAccess') === false,
            'User values move to the new key (a false boolean included)');
        assert(store.workspace.get('tcToolkit.libraryDefinitions.shell') === 'x64' && !store.global.has('tcToolkit.libraryDefinitions.shell'),
            'a Workspace value moves to the new key at Workspace scope, not User');
        assert(store.folders.get('uri:a').get('tcToolkit.diagnostics.declarationTypes') === true,
            'a WorkspaceFolder value moves within its own folder');
        assert(store.global.get('tcToolkit.xaeShell.path4026') === 'E:\\new\\TcXaeShell.exe',
            'a value already under the new key is not overwritten (User)');
        assert(store.folders.get('uri:b').get('tcToolkit.diagnostics.declarationTypes') === true,
            'a value already under the new key is not overwritten (WorkspaceFolder)');
        const leftovers = [store.global, store.workspace, ...store.folders.values()].flatMap(m => [...m.keys()]).filter(k => k.startsWith('twincat.'));
        assert(leftovers.length === 0, `every old value is removed, kept or copied (left: ${JSON.stringify(leftovers)})`);
        assert(steps.length === 6 && steps.filter(s => s.result === 'copied').length === 4 && steps.filter(s => s.result === 'kept').length === 2,
            `the report names each move (${JSON.stringify(steps.map(s => `${s.from}@${s.scope}:${s.result}`))})`);
        assert(steps.some(s => s.scope === 'folder:A') && steps.some(s => s.scope === 'folder:B' && s.result === 'kept'), 'folder steps are labelled by folder name');
        assert(logs.length === 0, 'a clean run logs nothing');

        // ── Idempotence ─────────────────────────────────────────────────────────────────────────
        const snapshot = JSON.stringify([[...store.global], [...store.workspace], ...[...store.folders.values()].map(m => [...m])]);
        const again = await migrateSettings({ getConfiguration, workspaceFolders: folders, ConfigurationTarget: T, log: (m) => logs.push(m) });
        assert(again.length === 0 && JSON.stringify([[...store.global], [...store.workspace], ...[...store.folders.values()].map(m => [...m])]) === snapshot,
            'a second run finds nothing and changes nothing');
    }

    // ── Nothing to do: no writes at all ─────────────────────────────────────────────────────────
    {
        const { writes, getConfiguration } = createStore();
        const steps = await migrateSettings({ getConfiguration, ConfigurationTarget: T, log: () => {} });
        assert(steps.length === 0 && writes.length === 0, 'with no old values (and no folders) nothing is written');
    }

    // ── Failures are logged, never thrown; a failed copy keeps the old value for the next run ────
    {
        const { store, getConfiguration } = createStore({ failUpdate: (key, value) => key === 'tcToolkit.compiler.path' && value !== undefined });
        store.global.set('twincat.compiler.path', 'C:\\c.cjs');
        store.global.set('twincat.compiler.nodePath', 'C:\\node.exe');
        const logs = [];
        let threw = null;
        let steps = [];
        try { steps = await migrateSettings({ getConfiguration, ConfigurationTarget: T, log: (m) => logs.push(m) }); } catch (e) { threw = e; }
        assert(!threw, 'a rejected write does not reject the migration');
        assert(logs.length === 1 && /twincat\.compiler\.path/.test(logs[0]) && /tcToolkit\.compiler\.path/.test(logs[0]) && /cannot write/.test(logs[0]),
            `the failure is logged with both keys and the error (${JSON.stringify(logs)})`);
        assert(store.global.get('twincat.compiler.path') === 'C:\\c.cjs' && !store.global.has('tcToolkit.compiler.path'),
            'a failed copy leaves the old value in place, so the next activation retries');
        assert(store.global.get('tcToolkit.compiler.nodePath') === 'C:\\node.exe' && !store.global.has('twincat.compiler.nodePath'),
            'the other keys still migrate after a failure');
        assert(steps.some(s => s.from === 'twincat.compiler.path' && s.result === 'failed' && /cannot write/.test(s.error || '')), 'the report marks the failed step');
    }
    {
        // A synchronous throw from update, a failing removal, and a getConfiguration that throws.
        const { store, getConfiguration } = createStore({ throwSync: true, failUpdate: (key, value) => key === 'twincat.startPage.recentProjectsShown' && value === undefined });
        store.global.set('twincat.startPage.recentProjectsShown', 5);
        const logs = [];
        const steps = await migrateSettings({ getConfiguration, ConfigurationTarget: T, log: (m) => logs.push(m) });
        assert(store.global.get('tcToolkit.startPage.recentProjectsShown') === 5 && logs.length === 1 && steps[0].result === 'failed',
            'a removal that throws synchronously is logged; the copy already made stands');
        const retry = createStore();
        retry.store.global.set('twincat.startPage.recentProjectsShown', 5);
        retry.store.global.set('tcToolkit.startPage.recentProjectsShown', 5);
        const retried = await migrateSettings({ getConfiguration: retry.getConfiguration, ConfigurationTarget: T, log: () => {} });
        assert(retried.length === 1 && retried[0].result === 'kept' && !retry.store.global.has('twincat.startPage.recentProjectsShown'),
            'the next run finishes the job: the new value is kept and the old one removed');

        const logs2 = [];
        let threw = null;
        try {
            await migrateSettings({ getConfiguration: () => { throw new Error('no configuration'); }, ConfigurationTarget: T, log: (m) => logs2.push(m) });
        } catch (e) { threw = e; }
        assert(!threw && logs2.length > 0 && logs2.every(m => /no configuration/.test(m)), 'a getConfiguration that throws is logged, not thrown');
        const badFolders = { [Symbol.iterator]() { throw new Error('folders unavailable'); } };
        const logs3 = [];
        const ok = createStore();
        ok.store.global.set('twincat.diagnostics.callArguments', false);
        await migrateSettings({ getConfiguration: ok.getConfiguration, workspaceFolders: /** @type {any} */ (badFolders), ConfigurationTarget: T, log: (m) => logs3.push(m) });
        assert(logs3.length === 1 && /folders unavailable/.test(logs3[0]) && ok.store.global.get('tcToolkit.diagnostics.callArguments') === false,
            'an unreadable folder list is logged and User/Workspace still migrate');
    }

    if (errors) {
        console.error(`\n${errors} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll settings migration tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
