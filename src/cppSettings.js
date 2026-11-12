/**
 * @file cppSettings.js
 * @description The two R13 switches of Compile Project and how they stay consistent:
 * `tcToolkit.compiler.generateCpp` (write the project's C++ into `CPP_Files/`) and
 * `tcToolkit.compiler.buildWithGpp` (also compile that C++ with g++). Both default to off.
 *
 * The rule (user decision, 2026-11-12): the g++ build needs the C++, so turning the build on turns
 * generation on, and turning generation off turns the build off. It is kept per settings scope —
 * in the scope the user changed — and a run reads `generate = generateCpp || buildWithGpp`, so a
 * combination the rule could not fix (say, generation off in a more specific scope than the build)
 * still builds what it generates.
 *
 * Pure: the settings arrive as `inspect()`-shaped values and the writes leave as a list, so
 * test/test_cpp_settings.js covers every case; src/commands/compileCommands.js applies them.
 */

'use strict';

/** The section both switches live in (the same as the compiler's other settings). */
const CPP_SECTION = 'tcToolkit.compiler';

/** The switches' keys inside the section. */
const OPTION_KEYS = Object.freeze(/** @type {const} */ (['generateCpp', 'buildWithGpp']));

/**
 * Settings scopes, least specific first (VS Code's `ConfigurationTarget` is 1, 2, 3 in this order).
 * @type {ReadonlyArray<'global'|'workspace'|'workspaceFolder'>}
 */
const SCOPES = Object.freeze(['global', 'workspace', 'workspaceFolder']);

/**
 * @typedef {{global?: unknown, workspace?: unknown, workspaceFolder?: unknown}} ScopeValues One
 *   switch's value in each scope (`inspect()`'s `globalValue` … renamed); anything not a boolean is unset.
 */

/**
 * @typedef {{generateCpp: ScopeValues, buildWithGpp: ScopeValues}} OptionState
 */

/**
 * @typedef {{key: 'generateCpp'|'buildWithGpp', scope: 'global'|'workspace'|'workspaceFolder', value: boolean}} OptionWrite
 */

/**
 * The value in effect at a scope: the most specific boolean at that scope or below it, else false.
 * @param {ScopeValues} values
 * @param {'global'|'workspace'|'workspaceFolder'} [upTo] Default: the most specific scope.
 * @returns {boolean}
 */
function effectiveAt(values, upTo = 'workspaceFolder') {
    const until = SCOPES.indexOf(upTo);
    for (let i = until; i >= 0; i--) {
        const v = values ? values[SCOPES[i]] : undefined;
        if (typeof v === 'boolean') return v;
    }
    return false;
}

/**
 * What a run does, and what the two checkboxes show.
 * @param {OptionState} state
 * @returns {{generateCpp: boolean, buildWithGpp: boolean}} `generateCpp` is true whenever the build is.
 */
function effectiveOptions(state) {
    const build = effectiveAt(state.buildWithGpp);
    return { generateCpp: build || effectiveAt(state.generateCpp), buildWithGpp: build };
}

/**
 * The writes that restore the rule after the user changed the settings (in the Settings editor, a
 * settings.json, or another window): in each scope where the build went ON, generation is turned on
 * there if it is not on at that scope; in each scope where generation went OFF, the build is turned
 * off there if it is on at that scope.
 * @param {OptionState} before
 * @param {OptionState} after
 * @returns {OptionWrite[]}
 */
function couplingWrites(before, after) {
    /** @type {OptionWrite[]} */
    const writes = [];
    const val = (/** @type {ScopeValues} */ v, /** @type {string} */ s) => {
        const x = v ? /** @type {any} */ (v)[s] : undefined;
        return typeof x === 'boolean' ? x : undefined;
    };
    for (const scope of SCOPES) {
        const buildChanged = val(before.buildWithGpp, scope) !== val(after.buildWithGpp, scope);
        const genChanged = val(before.generateCpp, scope) !== val(after.generateCpp, scope);
        if (buildChanged && val(after.buildWithGpp, scope) === true && !effectiveAt(after.generateCpp, scope)) {
            writes.push({ key: 'generateCpp', scope, value: true });
        } else if (genChanged && !effectiveAt(after.generateCpp, scope) && effectiveAt(after.buildWithGpp, scope)
            && !(buildChanged && val(after.buildWithGpp, scope) === true)) {
            writes.push({ key: 'buildWithGpp', scope, value: false });
        }
    }
    return writes;
}

/**
 * The scope a checkbox writes to: the most specific one that already sets the switch (so the change
 * takes effect), else the user's settings.
 * @param {ScopeValues} values
 * @returns {'global'|'workspace'|'workspaceFolder'}
 */
function targetScope(values) {
    for (let i = SCOPES.length - 1; i >= 0; i--) {
        if (typeof (values ? values[SCOPES[i]] : undefined) === 'boolean') return SCOPES[i];
    }
    return 'global';
}

/**
 * The writes one checkbox of the Compile dropdown makes, the coupled switch included, so the
 * settings are consistent at once (and the change listener has nothing left to fix).
 * @param {'generateCpp'|'buildWithGpp'} key
 * @param {boolean} value
 * @param {OptionState} state
 * @returns {OptionWrite[]}
 */
function checkboxWrites(key, value, state) {
    /** @type {OptionWrite[]} */
    const writes = [];
    const on = effectiveOptions(state);
    if (key === 'buildWithGpp') {
        if (effectiveAt(state.buildWithGpp) !== value) writes.push({ key, scope: targetScope(state.buildWithGpp), value });
        if (value && !effectiveAt(state.generateCpp)) writes.push({ key: 'generateCpp', scope: targetScope(state.generateCpp), value: true });
    } else {
        // The box shows `generateCpp || buildWithGpp`: unticking it must turn both off.
        if (effectiveAt(state.generateCpp) !== value) writes.push({ key, scope: targetScope(state.generateCpp), value });
        if (!value && on.buildWithGpp) writes.push({ key: 'buildWithGpp', scope: targetScope(state.buildWithGpp), value: false });
    }
    return writes;
}

/**
 * Reads the state out of a VS Code configuration section.
 * @param {{inspect: (key: string) => any}} config `vscode.workspace.getConfiguration(CPP_SECTION)`.
 * @returns {OptionState}
 */
function readOptionState(config) {
    const of = (/** @type {string} */ key) => {
        const i = config.inspect(key) || {};
        return { global: i.globalValue, workspace: i.workspaceValue, workspaceFolder: i.workspaceFolderValue };
    };
    return { generateCpp: of('generateCpp'), buildWithGpp: of('buildWithGpp') };
}

module.exports = {
    CPP_SECTION, OPTION_KEYS, SCOPES,
    effectiveAt, effectiveOptions, couplingWrites, targetScope, checkboxWrites, readOptionState
};
