/**
 * @file cppGenerate.js
 * @description The vscode-free half of C++ generation (roadmap R13): run the compiler's compile mode
 * over a PLC project's check units, and put the `.cpp` / `.hpp` it writes into the project's own
 * `CPP_Files/` folder — without ever overwriting or deleting a file the toolkit did not write.
 *
 * Why a second compiler run: the compiler reports diagnostics as JSON only in its check mode
 * (`--json` is refused without `--check`, and `--check` refuses `-o`), so Compile Project checks
 * first — the diagnostics it places in the panes — and generates only when that check has no errors.
 *
 * Output: `<project dir>/CPP_Files/<project>.cpp` and `<project>.hpp` (one compilation unit per PLC
 * project, as the check compiles it), plus `<project>.o` from the optional g++ build (src/gpp.js).
 * The compiler writes into a temporary directory; only the files it produced are copied over.
 *
 * Ownership: `CPP_Files/.tc-toolkit-generated.json` records every file the toolkit wrote there, with
 * the project it belongs to and its SHA-256. A file is overwritten or deleted only when it is
 * recorded AND unchanged since (same hash); anything else — a file of the same name the user made,
 * or a generated file the user edited — is left alone and reported. The owner is the project's
 * `<ProjectGuid>` (`cppOwnerId`), which a rename keeps, so a renamed project's earlier files are
 * still its own and are cleaned up. The hash ignores line endings (a Git checkout with
 * `core.autocrlf` is not an edit), and on Windows and macOS file names compare case-insensitively.
 *
 * Library symbols (user decision 2026-11-12): a project that uses vendor-library blocks is still
 * generated. The compile mode gets the same interface-only declarations as the check
 * (src/libraryDecls.js), so the library's function blocks and functions become C++ with empty bodies.
 * `libraryCoverage` collects what the C++ therefore does not cover, per library as the `.plcproj`
 * names it; Compile Project says so in its summary and output channel, and `withCoverageHeader` puts
 * the same list at the top of the generated files (part of the text whose hash is recorded, so the
 * ownership record is unaffected).
 *
 * `.gitignore` (user decision 2026-11-12): the folder also gets a `.gitignore` listing the files the
 * toolkit writes there (each recorded project's `.cpp` / `.hpp` / `.o` and the ownership record), so
 * they are not committed by accident. It is the toolkit's like the other outputs (hash in the record,
 * key `gitignore`): kept up to date while unchanged, left alone when edited or when a `.gitignore`
 * the toolkit did not write is there, and never recreated once the user deleted it (the record then
 * says `removed`). See `maintainGitignore`.
 */

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runChild, buildCompilerArgs, writeRunDirectory } = require('./compileCheck');

/** The folder, inside a PLC project directory, that holds the project's generated C++. */
const CPP_FILES_DIR = 'CPP_Files';

/** The ownership record in that folder. */
const MANIFEST_NAME = '.tc-toolkit-generated.json';

/** The ignore file the toolkit keeps in that folder. */
const GITIGNORE_NAME = '.gitignore';

/** The comment line at the top of that file. */
const GITIGNORE_COMMENT = '# Written by TC Toolkit so its generated files are not committed; you may delete this file.';

/** Marks the record as this extension's (a foreign file of the same name is never overwritten). */
const MANIFEST_GENERATOR = 'TC Toolkit';

/** How long one generation may run before it is stopped. */
const DEFAULT_GENERATE_TIMEOUT_MS = 120000;

/**
 * The file stem of a project's C++ files: the project's name, with every character a file name or a
 * C++ `#include` could trip over replaced by `_`.
 * @param {string} projectName Usually the `.plcproj` file's stem.
 * @returns {string}
 */
function cppFileStem(projectName) {
    const stem = String(projectName || '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[.-]+/, '');
    return stem || 'project';
}

/**
 * Where one project's C++ goes.
 * @param {string} projectDir The `.plcproj`'s folder.
 * @param {string} projectName
 * @returns {{dir: string, stem: string, cpp: string, hpp: string, obj: string, manifest: string}}
 */
function cppOutputPaths(projectDir, projectName) {
    const stem = cppFileStem(projectName);
    const dir = path.join(projectDir, CPP_FILES_DIR);
    return {
        dir, stem,
        cpp: path.join(dir, `${stem}.cpp`), hpp: path.join(dir, `${stem}.hpp`), obj: path.join(dir, `${stem}.o`),
        manifest: path.join(dir, MANIFEST_NAME)
    };
}

/**
 * Whether a path lies under a `CPP_Files` folder (any letter case, at any depth).
 * @param {string} filePath A path with either separator.
 * @returns {boolean}
 */
function isUnderCppFiles(filePath) {
    return String(filePath || '').split(/[\\/]+/).slice(0, -1).some(seg => seg.toLowerCase() === 'cpp_files');
}

/**
 * The recorded hash of a file: SHA-256 over its bytes with every CRLF read as LF, so a line-ending
 * conversion alone (Git's `core.autocrlf`) does not make the toolkit's own file look edited.
 * @param {string|Buffer} data Text is taken as UTF-8.
 */
const sha256 = (data) => {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    // latin1 maps each byte to one character and back, so this is a byte-level CRLF → LF.
    const lf = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    return crypto.createHash('sha256').update(lf).digest('hex');
};

/** Whether this platform's file systems usually ignore the case of file names. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * The record's key for a file name: the exact key, or on a case-insensitive file system one that
 * differs only in case.
 * @param {Manifest} manifest
 * @param {string} name
 * @param {boolean} caseInsensitive
 * @returns {string|null}
 */
function recordKey(manifest, name, caseInsensitive) {
    if (Object.prototype.hasOwnProperty.call(manifest.files, name)) return name;
    if (!caseInsensitive) return null;
    const lower = name.toLowerCase();
    return Object.keys(manifest.files).find(k => k.toLowerCase() === lower) || null;
}

/**
 * Who owns a project's generated files: its `<ProjectGuid>` (a rename keeps it), else the
 * `.plcproj`'s file stem.
 * @param {string} plcprojText The `.plcproj`'s XML ('' when it could not be read).
 * @param {string} fallback
 * @returns {string}
 */
function cppOwnerId(plcprojText, fallback) {
    const m = /<ProjectGuid>\s*\{?([0-9A-Fa-f-]{36})\}?\s*<\/ProjectGuid>/.exec(String(plcprojText || ''));
    return m ? `guid:${m[1].toLowerCase()}` : String(fallback);
}

/**
 * @typedef {Object} LibraryCoverage One library whose code the generated C++ does not contain.
 * @property {string} library As the project's `.plcproj` references it; '' when it is not known.
 * @property {string[]} blocks Function blocks and functions: declarations with empty bodies.
 * @property {string[]} types Types declared from the library's interface.
 * @property {string[]} globalLists Global variable lists declared from the library's interface.
 * @property {string[]} substitutes Blocks the compiler provides itself, in place of the library's.
 * @property {string[]} undeclared Symbols no usable declaration was found for.
 */

/** How an unattributed library is named to the user. */
const UNKNOWN_LIBRARY = 'library not identified';

/**
 * What of a project's library use the generated C++ does not cover, per library.
 * @param {{declaredSymbols?: Array<{name: string, kind: string, library: string}>,
 *   compilerSubstitutes?: Array<{name: string, library: string}>, undeclared?: Array<{name: string, library: string}>}} o
 *   `declaredSymbols` / `compilerSubstitutes`: src/libraryDecls.js prepareLibraryCheck;
 *   `undeclared`: the library names of the errors the check's library filter dropped.
 * @returns {LibraryCoverage[]} Sorted by library name, an unknown library last; empty when the
 *   project uses no library symbol.
 */
function libraryCoverage(o) {
    /** @type {Map<string, LibraryCoverage>} */
    const byLibrary = new Map();
    /** @type {(library: string) => LibraryCoverage} */
    const entry = (library) => {
        const name = String(library || '');
        const key = name.toLowerCase();
        if (!byLibrary.has(key)) byLibrary.set(key, { library: name, blocks: [], types: [], globalLists: [], substitutes: [], undeclared: [] });
        return /** @type {LibraryCoverage} */ (byLibrary.get(key));
    };
    /** @type {(list: string[], name: string) => void} */
    const add = (list, name) => { if (name && !list.some(n => n.toLowerCase() === name.toLowerCase())) list.push(name); };
    for (const d of o.declaredSymbols || []) {
        const e = entry(d.library);
        if (d.kind === 'fb' || d.kind === 'function') add(e.blocks, d.name);
        else if (d.kind === 'gvl') add(e.globalLists, d.name);
        else add(e.types, d.name);
    }
    for (const d of o.compilerSubstitutes || []) add(entry(d.library).substitutes, d.name);
    for (const d of o.undeclared || []) add(entry(d.library).undeclared, d.name);
    const byName = (/** @type {string} */ a, /** @type {string} */ b) => a.toLowerCase().localeCompare(b.toLowerCase());
    const list = [...byLibrary.values()];
    for (const e of list) for (const k of /** @type {const} */ (['blocks', 'types', 'globalLists', 'substitutes', 'undeclared'])) e[k].sort(byName);
    return list.sort((a, b) => (!a.library !== !b.library ? (a.library ? -1 : 1) : byName(a.library, b.library)));
}

/** @param {LibraryCoverage} e */
const libraryLabel = (e) => e.library || UNKNOWN_LIBRARY;

/**
 * The summary's sentence on library code the C++ does not cover, naming the libraries; '' when none.
 * @param {LibraryCoverage[]} coverage
 * @param {{built: boolean, channel: string}} o `built`: g++ checked the C++; `channel`: the output
 *   channel that lists the blocks.
 * @returns {string}
 */
function libraryCoverageText(coverage, o) {
    if (!coverage || coverage.length === 0) return '';
    const names = coverage.map(libraryLabel).join(', ');
    const what = o.built ? 'The generated C++ and the g++ check do not cover' : 'The generated C++ does not cover';
    const has = (/** @type {'blocks'|'types'|'globalLists'|'substitutes'|'undeclared'} */ k) => coverage.some(e => e[k].length > 0);
    const how = has('blocks')
        ? 'their code is not available, so their function blocks and functions are declarations with empty bodies there'
        : has('substitutes') ? 'the compiler\'s own implementation of their blocks is used instead'
            : has('types') || has('globalLists') ? 'their types and global lists are declared from the libraries\' interfaces only'
                : 'some of their symbols have no declaration here';
    return `${what} the library code of ${names}: ${how}. The library blocks used are listed in the "${o.channel}" output.`;
}

/**
 * The output channel's list of library code the C++ does not cover, by library.
 * @param {LibraryCoverage[]} coverage
 * @returns {string[]} Indented lines (none when nothing is uncovered).
 */
function libraryCoverageLines(coverage) {
    /** @type {string[]} */
    const lines = [];
    for (const e of coverage || []) {
        lines.push(`  ${libraryLabel(e)}:`);
        if (e.blocks.length) lines.push(`    declarations with empty bodies (the library's code is not available): ${e.blocks.join(', ')}`);
        if (e.substitutes.length) lines.push(`    the compiler's own implementation used instead of the library's: ${e.substitutes.join(', ')}`);
        if (e.types.length) lines.push(`    types declared from the library's interface: ${e.types.join(', ')}`);
        if (e.globalLists.length) lines.push(`    global lists declared from the library's interface (a value that is not known starts at 0): ${e.globalLists.join(', ')}`);
        if (e.undeclared.length) lines.push(`    no usable declaration (the compiler cannot compile a use of these): ${e.undeclared.join(', ')}`);
    }
    return lines;
}

/**
 * The output channel's list of the library symbols that stopped the C++ generation (no declaration
 * the compiler can use), by library.
 * @param {LibraryCoverage[]} coverage
 * @returns {string[]} Indented lines (none when there are none).
 */
function libraryUndeclaredLines(coverage) {
    return (coverage || []).filter(e => e.undeclared.length > 0).map(e => `  ${libraryLabel(e)}: ${e.undeclared.join(', ')}`);
}

/**
 * The comment put at the top of a generated `.cpp` / `.hpp` that holds library blocks with empty
 * bodies, naming them; '' when there are none.
 * @param {LibraryCoverage[]} coverage
 * @returns {string} Line comments, each line ending in a newline.
 */
function libraryCoverageHeader(coverage) {
    // Control characters (a line break would end the comment) become spaces.
    const clean = (/** @type {string} */ t) => Array.from(String(t), c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/ {2,}/g, ' ').trim();
    const rows = [];
    for (const e of coverage || []) {
        if (e.blocks.length) rows.push(`//   ${clean(libraryLabel(e))}: ${e.blocks.map(clean).join(', ')}`);
        if (e.substitutes.length) rows.push(`//   ${clean(libraryLabel(e))} (the compiler's own implementation is used): ${e.substitutes.map(clean).join(', ')}`);
    }
    if (rows.length === 0) return '';
    return [
        '// TC Toolkit: this C++ does not contain the code of the library blocks below. Their code is',
        '// not available, so they are declarations with empty bodies here, and a g++ check of this',
        '// file does not cover them.',
        ...rows, ''
    ].join('\n') + '\n';
}

/**
 * A generated file's text with the coverage comment on top (unchanged when there is none). Keeps the
 * file's own line endings.
 * @param {string} text
 * @param {string} header libraryCoverageHeader's comment.
 * @returns {string}
 */
function withCoverageHeader(text, header) {
    if (!header) return text;
    return (/\r\n/.test(text) ? header.replace(/\n/g, '\r\n') : header) + text;
}

/**
 * @typedef {Object} Manifest
 * @property {string} generator Always MANIFEST_GENERATOR.
 * @property {number} version
 * @property {Object<string, {project: string, sha256: string}>} files By file name (no directory).
 * @property {{sha256: string}|{removed: true}} [gitignore] The `.gitignore` the toolkit wrote (its
 *   hash), or `removed`: it was deleted after the toolkit wrote it, and is not written again.
 */

/**
 * Reads a folder's ownership record.
 * @param {string} dir The `CPP_Files` folder.
 * @returns {{ok: true, manifest: Manifest} | {ok: false, message: string}} A missing record is an
 *   empty one; a file of that name that is not this extension's record is refused (`ok: false`).
 */
function readManifest(dir) {
    const file = path.join(dir, MANIFEST_NAME);
    /** @type {Manifest} */
    const empty = { generator: MANIFEST_GENERATOR, version: 1, files: {} };
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: true, manifest: empty }; }
    /** @type {any} */
    let data;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data || data.generator !== MANIFEST_GENERATOR || !data.files || typeof data.files !== 'object') {
        return { ok: false, message: `${file} exists and is not the record TC Toolkit keeps of its generated files; nothing was written there.` };
    }
    /** @type {Manifest} */
    const manifest = { generator: MANIFEST_GENERATOR, version: 1, files: {} };
    for (const [name, entry] of Object.entries(data.files)) {
        // A plain file name only: the record must never point outside its folder.
        if (!entry || typeof entry !== 'object' || path.basename(name) !== name || name === MANIFEST_NAME || name.toLowerCase() === GITIGNORE_NAME) continue;
        if (typeof entry.sha256 === 'string' && typeof entry.project === 'string') {
            manifest.files[name] = { project: entry.project, sha256: entry.sha256 };
        }
    }
    const g = data.gitignore;
    if (g && typeof g === 'object') {
        if (g.removed === true) manifest.gitignore = { removed: true };
        else if (typeof g.sha256 === 'string') manifest.gitignore = { sha256: g.sha256 };
    }
    return { ok: true, manifest };
}

/** @param {string} dir @param {Manifest} manifest */
function writeManifest(dir, manifest) {
    const files = {};
    for (const name of Object.keys(manifest.files).sort()) files[name] = manifest.files[name];
    /** @type {Object<string, any>} */
    const data = { generator: MANIFEST_GENERATOR, version: 1, files };
    if (manifest.gitignore) data.gitignore = manifest.gitignore;
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * The `.gitignore` text for a record: the comment line, then every recorded file, the object file of
 * every recorded `.cpp` (so a later g++ build needs no rewrite) and the record itself, each anchored
 * to the folder (`/name`). '' when nothing is recorded.
 * @param {Manifest} manifest
 * @returns {string}
 */
function gitignoreText(manifest) {
    const names = new Set(Object.keys(manifest.files));
    if (names.size === 0) return '';
    for (const name of Object.keys(manifest.files)) {
        if (/\.cpp$/i.test(name)) names.add(name.replace(/\.cpp$/i, '.o'));
    }
    names.add(MANIFEST_NAME);
    // Glob characters are escaped (the stems are [A-Za-z0-9_.-]; `/` in front makes `!`/`#` literal).
    const escape = (/** @type {string} */ n) => n.replace(/[\\*?[]/g, c => `\\${c}`);
    return [GITIGNORE_COMMENT, ...[...names].sort().map(n => `/${escape(n)}`)].join('\n') + '\n';
}

/**
 * @typedef {Object} GitignoreResult What happened to the folder's `.gitignore` on one write.
 * @property {'created'|'updated'|'unchanged'|'changed'|'foreign'|'not-recreated'|'none'|'failed'} status
 *   `changed`: the toolkit's own file, edited since (left alone); `foreign`: a `.gitignore` the
 *   toolkit did not write (left alone); `not-recreated`: the toolkit wrote one before and it was
 *   deleted since; `none`: nothing recorded to list.
 * @property {string} path
 * @property {string} [message] For `failed`.
 */

/**
 * Brings the folder's `.gitignore` in line with the record (user decision 2026-11-12). Changes
 * `manifest.gitignore`; the caller saves the record.
 * @param {string} dir
 * @param {Manifest} manifest
 * @returns {GitignoreResult}
 */
function maintainGitignore(dir, manifest) {
    const file = path.join(dir, GITIGNORE_NAME);
    const want = gitignoreText(manifest);
    /** @type {Buffer|null} */
    let current;
    try { current = fs.readFileSync(file); } catch (e) { current = null; }
    const recorded = manifest.gitignore;
    if (recorded && !('sha256' in recorded)) return { status: current ? 'foreign' : 'not-recreated', path: file };
    if (!current && recorded) {
        // Deleted after the toolkit wrote it: the user's choice, remembered.
        manifest.gitignore = { removed: true };
        return { status: 'not-recreated', path: file };
    }
    if (!want) return { status: 'none', path: file };
    if (current) {
        const have = sha256(current);
        if (have === sha256(want)) {
            // Already what it should be (also a user's edit that happens to match): the toolkit's.
            manifest.gitignore = { sha256: have };
            return { status: 'unchanged', path: file };
        }
        if (!recorded) return { status: 'foreign', path: file };
        if (!('sha256' in recorded) || recorded.sha256 !== have) return { status: 'changed', path: file };
    }
    try {
        fs.writeFileSync(file, want, 'utf8');
    } catch (e) {
        return { status: 'failed', path: file, message: e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : String(e) };
    }
    manifest.gitignore = { sha256: sha256(want) };
    return { status: current ? 'updated' : 'created', path: file };
}

/**
 * The output channel's line on the `.gitignore`, '' when there is nothing to say.
 * @param {GitignoreResult|undefined} g
 * @returns {string}
 */
function gitignoreNote(g) {
    if (!g) return '';
    const where = `${path.basename(path.dirname(path.dirname(g.path)))}/${path.basename(path.dirname(g.path))}/${GITIGNORE_NAME}`;
    switch (g.status) {
        case 'created': return `${where} written so the generated files are not committed; delete it to commit them (it is not written again).`;
        case 'changed': return `${where} was changed since TC Toolkit wrote it and is left alone; it may not list every generated file.`;
        case 'foreign': return `${where} was not written by TC Toolkit and is left alone; the generated files may not be ignored by git.`;
        case 'not-recreated': return `${where} was deleted after TC Toolkit wrote it, so it was not written again.`;
        case 'failed': return `${where} could not be written: ${g.message || 'unknown error'}.`;
        default: return '';
    }
}

/**
 * Whether the toolkit may replace or delete one file in its folder.
 * @param {string} dir
 * @param {Manifest} manifest
 * @param {string} name
 * @param {boolean} [caseInsensitive] Match the record's names regardless of case (Windows, macOS).
 * @returns {'absent'|'owned'|'foreign'|'changed'} `foreign`: not recorded (the user's own file);
 *   `changed`: recorded, but edited since it was written.
 */
function ownership(dir, manifest, name, caseInsensitive = CASE_INSENSITIVE_FS) {
    let data;
    try { data = fs.readFileSync(path.join(dir, name)); } catch (e) { return 'absent'; }
    const key = recordKey(manifest, name, caseInsensitive);
    if (!key) return 'foreign';
    return manifest.files[key].sha256 === sha256(data) ? 'owned' : 'changed';
}

/**
 * @typedef {Object} WriteResult
 * @property {boolean} ok False when the folder's record is not this extension's (nothing was touched).
 * @property {string} message Why not, when not ok.
 * @property {string[]} written Absolute paths written.
 * @property {string[]} removed Absolute paths of this project's earlier outputs that were deleted.
 * @property {Array<{path: string, reason: 'foreign'|'changed'}>} refused Files left alone.
 * @property {GitignoreResult} [gitignore] The folder's `.gitignore` (maintainGitignore).
 */

/**
 * Writes one project's generated files into its `CPP_Files` folder and deletes this project's
 * earlier outputs that this run did not produce (a renamed project, or an object file the new
 * `.cpp` no longer matches). Only absent or owned files are replaced; see `ownership`. The record is
 * saved however the run ends, so a file written before a later write failed stays the toolkit's.
 * @param {{dir: string, project: string, files: Array<{name: string, text: string}>, caseInsensitive?: boolean}} o
 *   `project`: the owner recorded with each file (`cppOwnerId`); `caseInsensitive`: defaults to
 *   this platform's usual file system.
 * @returns {WriteResult}
 */
function writeOwnedOutputs(o) {
    /** @type {WriteResult} */
    const result = { ok: true, message: '', written: [], removed: [], refused: [] };
    const ci = o.caseInsensitive === undefined ? CASE_INSENSITIVE_FS : !!o.caseInsensitive;
    fs.mkdirSync(o.dir, { recursive: true });
    const read = readManifest(o.dir);
    if (read.ok === false) return { ...result, ok: false, message: read.message };
    const manifest = read.manifest;
    const fold = (/** @type {string} */ n) => (ci ? n.toLowerCase() : n);
    const names = new Set(o.files.map(f => fold(f.name)));
    let dirty = false;
    try {
        for (const file of o.files) {
            const target = path.join(o.dir, file.name);
            const state = ownership(o.dir, manifest, file.name, ci);
            if (state === 'foreign' || state === 'changed') {
                result.refused.push({ path: target, reason: state });
                continue;
            }
            fs.writeFileSync(target, file.text, 'utf8');
            // Recorded under the name as written now (a case-only rename drops the old spelling).
            const oldKey = recordKey(manifest, file.name, ci);
            if (oldKey && oldKey !== file.name) delete manifest.files[oldKey];
            manifest.files[file.name] = { project: o.project, sha256: sha256(file.text) };
            dirty = true;
            result.written.push(target);
        }
        for (const [name, entry] of Object.entries(manifest.files)) {
            if (entry.project !== o.project || names.has(fold(name))) continue;
            const state = ownership(o.dir, manifest, name, false);
            if (state === 'owned') {
                try { fs.unlinkSync(path.join(o.dir, name)); result.removed.push(path.join(o.dir, name)); } catch (e) { continue; }
            }
            // Gone, removed, or edited by the user (then it is theirs now): no longer recorded.
            delete manifest.files[name];
            dirty = true;
        }
        const before = JSON.stringify(manifest.gitignore || null);
        result.gitignore = maintainGitignore(o.dir, manifest);
        if (JSON.stringify(manifest.gitignore || null) !== before) dirty = true;
    } finally {
        if (dirty) writeManifest(o.dir, manifest);
    }
    return result;
}

/**
 * Records a file another program wrote into the folder for this project (g++'s object file).
 * @param {string} dir
 * @param {string} project
 * @param {string} name
 * @returns {boolean} False when the file is missing or the record is not this extension's.
 */
function recordOwnedFile(dir, project, name) {
    const read = readManifest(dir);
    if (read.ok === false) return false;
    let data;
    try { data = fs.readFileSync(path.join(dir, name)); } catch (e) { return false; }
    const oldKey = recordKey(read.manifest, name, CASE_INSENSITIVE_FS);
    if (oldKey && oldKey !== name) delete read.manifest.files[oldKey];
    read.manifest.files[name] = { project, sha256: sha256(data) };
    writeManifest(dir, read.manifest);
    return true;
}

/**
 * Makes room for a file another program is about to write (g++'s object file): an owned earlier
 * copy is deleted, so a failed build leaves no stale object behind.
 * @param {string} dir
 * @param {string} name
 * @returns {'absent'|'owned'|'foreign'|'changed'|'bad-record'} `absent`/`owned`: the name is free now.
 */
function claimOutput(dir, name) {
    const read = readManifest(dir);
    if (read.ok === false) return 'bad-record';
    const state = ownership(dir, read.manifest, name);
    if (state === 'owned') {
        try { fs.unlinkSync(path.join(dir, name)); } catch (e) { return 'changed'; }
        delete read.manifest.files[/** @type {string} */ (recordKey(read.manifest, name, CASE_INSENSITIVE_FS))];
        writeManifest(dir, read.manifest);
    }
    return state;
}

/**
 * @typedef {Object} GenerateResult
 * @property {'done'|'failed'|'cancelled'|'timeout'} status
 * @property {string} message Why not done.
 * @property {string} cppText
 * @property {string} hppText
 * @property {string} log What the compiler printed (stdout and stderr), for the output channel.
 * @property {number} durationMs
 */

/**
 * Runs the compiler's compile mode over the same inputs a check uses, in a temporary directory that
 * is deleted again however the run ends, and returns the C++ it wrote.
 * @param {Object} o The options of `runCheck` (src/compileCheck.js), plus:
 * @param {string} o.nodeCommand
 * @param {Object<string, string>} [o.nodeEnv]
 * @param {string} o.compilerPath
 * @param {string} o.dialectFile
 * @param {import('./compileCheck').CheckInput[]} o.inputs
 * @param {import('./compileCheck').ExtraInput[]} [o.extraFiles]
 * @param {string[]} [o.defineArgs]
 * @param {string} o.stem The output file stem (`<stem>.cpp`, `<stem>.hpp`; the `.cpp` includes the `.hpp` by that name).
 * @param {number} [o.timeoutMs]
 * @param {(cancel: () => void) => void} [o.onCancel]
 * @param {import('./compileCheck').SpawnLike} [o.spawn]
 * @param {string} [o.tmpRoot]
 * @returns {Promise<GenerateResult>}
 */
async function runGenerate(o) {
    const spawn = o.spawn || /** @type {any} */ (childProcess.spawn);
    const started = Date.now();
    /** @type {(status: GenerateResult['status'], message: string, log?: string) => GenerateResult} */
    const ended = (status, message, log = '') => ({ status, message, cppText: '', hppText: '', log, durationMs: Date.now() - started });
    let dir = '';
    try {
        try {
            dir = writeRunDirectory(o);
        } catch (err) {
            return ended('failed', `The temporary files for the C++ generation could not be written: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}`);
        }
        const cppName = `${o.stem}.cpp`;
        const hppName = `${o.stem}.hpp`;
        const timeoutMs = o.timeoutMs || DEFAULT_GENERATE_TIMEOUT_MS;
        const run = await runChild(spawn, o.nodeCommand,
            buildCompilerArgs({ compilerPath: o.compilerPath, dialectFile: o.dialectFile, inputs: o.inputs, extraFiles: o.extraFiles, defineArgs: o.defineArgs, output: cppName }),
            { cwd: dir, timeoutMs, onCancel: o.onCancel, env: o.nodeEnv ? { ...process.env, ...o.nodeEnv } : undefined });
        const log = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
        if (run.outcome === 'cancelled') return ended('cancelled', '', log);
        if (run.outcome === 'timeout') return ended('timeout', `The C++ generation did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`, log);
        if (run.outcome === 'spawn-error') return ended('failed', `The compiler could not be started: ${run.error}`, log);
        if (run.code !== 0) {
            const firstError = (/^.*\berror\b.*$/im.exec(run.stderr || '') || [])[0] || String(run.stderr || '').trim().split(/\r?\n/).slice(-1)[0] || '';
            return ended('failed', `The compiler could not generate C++ (exit code ${run.code === null ? 'none' : run.code})${firstError ? `: ${firstError.trim().slice(0, 300)}` : '.'}`, log);
        }
        let cppText;
        let hppText;
        try {
            cppText = fs.readFileSync(path.join(dir, cppName), 'utf8');
            hppText = fs.readFileSync(path.join(dir, hppName), 'utf8');
        } catch (err) {
            return ended('failed', 'The compiler finished but wrote no C++ files.', log);
        }
        return { status: 'done', message: '', cppText, hppText, log, durationMs: Date.now() - started };
    } finally {
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
    }
}

module.exports = {
    CPP_FILES_DIR, MANIFEST_NAME, MANIFEST_GENERATOR, GITIGNORE_NAME, GITIGNORE_COMMENT, DEFAULT_GENERATE_TIMEOUT_MS,
    cppFileStem, cppOutputPaths, isUnderCppFiles, cppOwnerId,
    libraryCoverage, libraryCoverageText, libraryCoverageLines, libraryUndeclaredLines, libraryCoverageHeader, withCoverageHeader, UNKNOWN_LIBRARY,
    readManifest, ownership, writeOwnedOutputs, gitignoreText, maintainGitignore, gitignoreNote, recordOwnedFile, claimOutput,
    runGenerate
};
