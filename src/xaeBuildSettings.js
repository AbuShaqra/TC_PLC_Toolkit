/**
 * @file xaeBuildSettings.js
 * @description The `tcToolkit.xaeBuild` settings of "Build through XAE" (roadmap R14), read with
 * their defaults and limits applied.
 *
 *   showWindow      false   headless: the XAE Shell runs hidden with its UI suppressed. True keeps the
 *                           window visible and the UI unsuppressed for the whole run (`-ShowWindow`).
 *                           Either way the driver shows the window during activation, and keeps it
 *                           visible after an XAE version switch (see DEVELOPMENT.md "XAE build (R14)").
 *   configuration   'Release'
 *   platform        'TwinCAT RT (x64)'  a solution-platform value
 *   timeoutMinutes  30      5-240
 *   stallMinutes    10      2-60, the headless watchdog
 *
 * There is deliberately no activation-target setting: the target is picked and confirmed on every
 * run (the last pick is only a preselection, kept in workspaceState).
 *
 * Pure, in the style of src/cppSettings.js: the reader is injected (test/test_xae_build.js).
 */

'use strict';

/** The settings section. */
const XAE_BUILD_SECTION = 'tcToolkit.xaeBuild';

/** Defaults, as package.json declares them. */
const XAE_BUILD_DEFAULTS = Object.freeze({
    showWindow: false,
    configuration: 'Release',
    platform: 'TwinCAT RT (x64)',
    timeoutMinutes: 30,
    stallMinutes: 10
});

/** Limits of the two numbers, inclusive. */
const LIMITS = Object.freeze({ timeoutMinutes: [5, 240], stallMinutes: [2, 60] });

/**
 * @typedef {Object} XaeBuildSettings
 * @property {boolean} showWindow
 * @property {string} configuration
 * @property {string} platform
 * @property {number} timeoutMinutes
 * @property {number} stallMinutes
 */

/**
 * @param {unknown} v
 * @param {number} fallback
 * @param {[number, number]} range
 * @returns {number}
 */
function clampNumber(v, fallback, range) {
    if (typeof v !== 'number' || !isFinite(v)) return fallback;
    return Math.min(range[1], Math.max(range[0], v));
}

/**
 * Reads the settings; a value of the wrong type falls back to its default.
 * @param {(key: string) => unknown} get Reads one key of the `tcToolkit.xaeBuild` section.
 * @returns {XaeBuildSettings}
 */
function readXaeBuildSettings(get) {
    const str = (/** @type {'configuration'|'platform'} */ key) => {
        const v = get(key);
        return typeof v === 'string' && v.trim() ? v.trim() : XAE_BUILD_DEFAULTS[key];
    };
    const show = get('showWindow');
    return {
        showWindow: show === true,
        configuration: str('configuration'),
        platform: str('platform'),
        timeoutMinutes: clampNumber(get('timeoutMinutes'), XAE_BUILD_DEFAULTS.timeoutMinutes, /** @type {[number, number]} */ (LIMITS.timeoutMinutes.slice())),
        stallMinutes: clampNumber(get('stallMinutes'), XAE_BUILD_DEFAULTS.stallMinutes, /** @type {[number, number]} */ (LIMITS.stallMinutes.slice()))
    };
}

module.exports = { XAE_BUILD_SECTION, XAE_BUILD_DEFAULTS, LIMITS, readXaeBuildSettings };
