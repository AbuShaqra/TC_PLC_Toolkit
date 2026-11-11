/**
 * @file settingsMigration.js
 * @description Moves the user's values from the old `twincat.*` setting keys to the `tcToolkit.*`
 * keys, once per activation. VS Code's Settings editor builds a setting's label from its key, so the
 * old keys showed as "Twincat › Compiler: Path"; the keys were renamed and this carries values over.
 *
 * For every renamed key and every scope that holds a value under the OLD key (User, Workspace, and
 * each workspace folder): the value is copied to the NEW key at the same scope — only when the new
 * key has no value there, so a value the user already set under the new name wins — and the old
 * value is then removed at that scope. A copy that fails leaves the old value in place, so the next
 * activation tries again. Running it again is a no-op. It never throws or rejects: every failure is
 * logged and the rest of the migration carries on.
 *
 * The old keys stay contributed in package.json (deprecated, hidden by the Settings editor unless
 * set). Measured on VS Code 1.145: `inspect` does return values of an uncontributed key, and
 * removing one works, but WRITING one is refused ("not a registered configuration"); older
 * releases the engine range admits are not known to allow even the removal, so the migration does
 * not depend on it. Contributed, the old keys also stay greyed out rather than unknown in settings.json.
 *
 * vscode-light: everything VS Code-shaped comes in through `deps`, so test/test_settings_migration.js
 * drives it with a fake configuration store.
 */

'use strict';

/** Old key → new key, for every setting the extension contributes. */
const SETTING_RENAMES = Object.freeze([
    'diagnostics.memberAccess',
    'diagnostics.callArguments',
    'diagnostics.declarationTypes',
    'diagnostics.typeCompatibility',
    'libraryDefinitions.shell',
    'startPage.recentProjectsShown',
    'xaeShell.path4024',
    'xaeShell.path4026',
    'compiler.path',
    'compiler.nodePath'
].map((rest) => Object.freeze({ from: `twincat.${rest}`, to: `tcToolkit.${rest}` })));

/**
 * @typedef {Object} InspectLike
 * @property {unknown} [globalValue]
 * @property {unknown} [workspaceValue]
 * @property {unknown} [workspaceFolderValue]
 */

/**
 * @typedef {Object} ConfigLike The part of a `vscode.WorkspaceConfiguration` the migration uses.
 * @property {(key: string) => InspectLike | undefined} inspect
 * @property {(key: string, value: unknown, target: number) => PromiseLike<void>} update
 */

/**
 * @typedef {Object} MigrationDeps
 * @property {(section: string | undefined, scope?: unknown) => ConfigLike} getConfiguration
 *   `vscode.workspace.getConfiguration`; called afresh before every scope, so each step sees the
 *   writes of the one before.
 * @property {ReadonlyArray<{uri: unknown, name?: string}>} [workspaceFolders]
 * @property {{Global: number, Workspace: number, WorkspaceFolder: number}} ConfigurationTarget
 * @property {(message: string) => void} [log] Where failures are reported (default console.warn).
 * @property {ReadonlyArray<{from: string, to: string}>} [renames] Defaults to SETTING_RENAMES.
 */

/**
 * @typedef {Object} MigrationStep
 * @property {string} from
 * @property {string} to
 * @property {string} scope 'global' | 'workspace' | 'folder:<name>'
 * @property {'copied'|'kept'|'failed'} result `copied`: the value moved to the new key; `kept`: the
 *   new key already had a value there, so only the old one was removed; `failed`: see `error`.
 * @property {string} [error]
 */

/**
 * Migrates every old key at every scope. Never rejects.
 * @param {MigrationDeps} deps
 * @returns {Promise<MigrationStep[]>} One entry per (key, scope) that held an old value.
 */
async function migrateSettings(deps) {
    const log = deps.log || ((m) => console.warn(m));
    const renames = deps.renames || SETTING_RENAMES;
    const T = deps.ConfigurationTarget;
    /** @type {MigrationStep[]} */
    const steps = [];

    /** @type {Array<{scope: string, resource: unknown, field: 'globalValue'|'workspaceValue'|'workspaceFolderValue', target: number}>} */
    const scopes = [
        { scope: 'global', resource: undefined, field: 'globalValue', target: T.Global },
        { scope: 'workspace', resource: undefined, field: 'workspaceValue', target: T.Workspace }
    ];
    let folders = [];
    try { folders = Array.from(deps.workspaceFolders || []); } catch (e) { log(`TC Toolkit settings migration: cannot list workspace folders: ${describe(e)}`); }
    for (const f of folders) {
        scopes.push({ scope: `folder:${f.name || String(f.uri)}`, resource: f.uri, field: 'workspaceFolderValue', target: T.WorkspaceFolder });
    }

    for (const { from, to } of renames) {
        for (const s of scopes) {
            let step = null;
            try {
                const config = deps.getConfiguration(undefined, s.resource);
                const old = config.inspect(from);
                const oldValue = old ? old[s.field] : undefined;
                if (oldValue === undefined) continue;
                step = { from, to, scope: s.scope, result: /** @type {MigrationStep['result']} */ ('failed') };
                const current = config.inspect(to);
                if (current && current[s.field] !== undefined) {
                    step.result = 'kept';
                } else {
                    await config.update(to, oldValue, s.target);
                    step.result = 'copied';
                }
                await config.update(from, undefined, s.target);
            } catch (e) {
                if (!step) step = { from, to, scope: s.scope, result: 'failed' };
                step.result = 'failed';
                step.error = describe(e);
                log(`TC Toolkit settings migration: could not move "${from}" to "${to}" (${s.scope}): ${step.error}`);
            }
            if (step) steps.push(step);
        }
    }
    return steps;
}

/** @param {unknown} e */
function describe(e) {
    return e instanceof Error ? e.message : String(e);
}

module.exports = { SETTING_RENAMES, migrateSettings };
