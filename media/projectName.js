/**
 * @file media/projectName.js
 * @description The one definition of what a new TwinCAT project may be called. The name becomes the
 * solution, the system project, the PLC project (`<Name>_PLC`), their folders and their files, so it
 * must be a safe file name on Windows AND a valid IEC 61131-3 identifier.
 *
 * Lives in `media/` because the start page validates the name as the user types (a plain `<script>`
 * tag), and is written to `require()` cleanly too so `src/projectTemplate.js` refuses exactly the same
 * names on the host side. One file, two loaders — the same arrangement as `media/stFolding.js`.
 */

// Dual-mode shim: `module.exports` under Node, a `projectName` global in the webview.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.projectName = factory();
}(typeof self !== 'undefined' ? /** @type {*} */ (self) : this, function () {
    'use strict';

    /** Suffix that turns the project name into the PLC project's name (both XAE skeletons use it). */
    var PLC_SUFFIX = '_PLC';

    /** Longest name accepted. Leaves room for `<Name>_PLC Instance.xti` under deep Windows paths. */
    var MAX_NAME_LENGTH = 48;

    /** Windows device names: a file or folder named after one cannot be created on Windows. */
    var RESERVED_WINDOWS_NAMES = [
        'con', 'prn', 'aux', 'nul',
        'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
        'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
    ];

    /**
     * Validates a project name.
     * @param {string} name
     * @returns {string|null} A user-facing reason it is refused, or null when it is accepted.
     */
    function validateProjectName(name) {
        if (typeof name !== 'string' || name.length === 0) return 'Enter a project name.';
        if (name.length > MAX_NAME_LENGTH) return 'Use at most ' + MAX_NAME_LENGTH + ' characters.';
        if (!/^[A-Za-z_]/.test(name)) return 'Start with a letter or an underscore.';
        if (!/^[A-Za-z0-9_]+$/.test(name)) return 'Use only letters, digits and underscores.';
        if (/__/.test(name)) return 'Do not use two underscores in a row (not a valid IEC identifier).';
        if (/_$/.test(name)) {
            return 'Do not end the name with an underscore (the PLC project would be ' + name + PLC_SUFFIX +
                ', with two in a row).';
        }
        if (RESERVED_WINDOWS_NAMES.indexOf(name.toLowerCase()) !== -1) return '"' + name + '" is reserved on Windows.';
        return null;
    }

    return {
        PLC_SUFFIX: PLC_SUFFIX,
        MAX_NAME_LENGTH: MAX_NAME_LENGTH,
        validateProjectName: validateProjectName
    };
}));
