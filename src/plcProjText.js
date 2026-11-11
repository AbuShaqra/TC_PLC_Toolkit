/**
 * @file plcProjText.js
 * @description The `.plcproj` text edit a rename needs, as a pure function: rewrite the `Include`
 * path of the renamed file (or of a renamed directory and everything under it) IN PLACE.
 *
 * The rename used to unregister the old entry and register a new one. That moved the entry to the end
 * of its ItemGroup and rebuilt it from a template, dropping any child the original carried
 * (`<LinkAlways>true</LinkAlways>` on a GVL, `<ExcludeFromBuild>`), and it was a separate write from
 * the rename's other edits. Rewriting only the attribute value keeps every other byte, and as plain text
 * it can join the rename's single WorkspaceEdit (src/commands/renameCommands.js), so one undo restores
 * it with the rest. Deliberately free of `vscode`: test/test_plcproj_text.js drives it under plain Node.
 */

const { decodeXmlAttribute } = require('./twincatWorkspace');

/** Project items that name a file or folder of the project (not library references). */
const ITEM_INCLUDE_RE = /(<(?:Compile|Folder|None|Content)\s+Include=")([^"]*)(")/g;

/**
 * Encodes a decoded path for an XML attribute value. Only what must be escaped is.
 * @param {string} value
 * @returns {string}
 */
function encodeXmlAttribute(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Rewrites the `.plcproj` entries of a renamed file or directory. Paths are project-relative with
 * backslashes, as TwinCAT writes them, and compared case-insensitively (TwinCAT is Windows-only). A
 * file matches only its own entry; a directory matches its own `<Folder>` entry and every entry below
 * it (`old\…`), and keeps each one's tail as written. Entries are edited in place: their position,
 * their children and every byte outside the attribute value are unchanged.
 * @param {string} text The `.plcproj` text.
 * @param {string} oldRel Project-relative path before the rename (`POUs\FB_A.TcPOU`, `POUs\Sub`).
 * @param {string} newRel Project-relative path after it.
 * @param {boolean} isFolder True for a directory rename.
 * @returns {{text: string, count: number}} The rewritten text and how many entries changed.
 */
function renamePlcProjEntries(text, oldRel, newRel, isFolder) {
    const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '');
    const oldPath = norm(oldRel);
    const newPath = norm(newRel);
    const oldLower = oldPath.toLowerCase();
    if (!oldPath || oldPath === newPath) return { text, count: 0 };
    let count = 0;
    const out = String(text).replace(ITEM_INCLUDE_RE, (whole, open, raw, close) => {
        const value = decodeXmlAttribute(raw);
        const lower = value.toLowerCase();
        let next = null;
        if (lower === oldLower) next = newPath;
        else if (isFolder && lower.startsWith(oldLower + '\\')) next = newPath + value.slice(oldPath.length);
        if (next === null) return whole;
        count++;
        return open + encodeXmlAttribute(next) + close;
    });
    return { text: out, count };
}

module.exports = { renamePlcProjEntries };
