/**
 * @file fileUri.js
 * @description One conversion boundary between Windows filesystem paths and file URIs.
 */

const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

/** @param {string} fsPath @returns {string} */
function fsPathToFileUri(fsPath) {
    const value = String(fsPath || '');
    return value ? pathToFileURL(path.resolve(value)).href : '';
}

/** @param {string} uri @returns {string} */
function fileUriToFsPath(uri) {
    const value = String(uri || '');
    if (!value || !/^file:/i.test(value)) return value;
    return fileURLToPath(value);
}

/**
 * Case-insensitive identity key for the Windows filesystem targeted by TwinCAT.
 * @param {string} uri File URI.
 * @returns {string}
 */
function normalizeFileUri(uri) {
    try {
        const normalized = path.resolve(fileUriToFsPath(uri)).replace(/\\/g, '/');
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    } catch (e) {
        const value = String(uri || '');
        return process.platform === 'win32' ? value.toLowerCase() : value;
    }
}

/**
 * Basename helper that also accepts the POSIX-shaped synthetic file URIs used by pure unit tests on
 * Windows (`file:///tmp/X.st`), while production paths still go through fileURLToPath.
 * @param {string} uri File URI.
 * @returns {string}
 */
function fileUriBasename(uri) {
    try {
        return path.basename(fileUriToFsPath(uri));
    } catch (e) {
        const parsed = new URL(String(uri || ''));
        return path.posix.basename(decodeURIComponent(parsed.pathname));
    }
}

module.exports = { fsPathToFileUri, fileUriToFsPath, normalizeFileUri, fileUriBasename };
