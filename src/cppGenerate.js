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
 * Library symbols: C++ is generated only for a project that needs no library declaration
 * (`libraryBlocksCpp`). The compiler would turn the interface-only declarations of src/libraryDecls.js
 * into empty-bodied C++ — library blocks that silently do nothing — and those declarations must never
 * be written into the project.
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
 * Why C++ must not be generated for a project that uses library symbols — or '' when it may.
 * The compiler has no implementation of a library's blocks and functions: given the interface-only
 * declarations the check uses, it would generate empty bodies that compile and silently do nothing.
 * @param {{extraFiles?: Array<unknown>, qualifiers?: number, filteredLibraryDiagnostics?: number}} o
 *   `extraFiles`: the library declarations the check needed; `qualifiers`: library namespace
 *   qualifiers stripped from the project's code; `filteredLibraryDiagnostics`: check errors on
 *   library names that were not shown.
 * @returns {string}
 */
function libraryBlocksCpp(o) {
    const uses = (o.extraFiles || []).length > 0 || (o.qualifiers || 0) > 0 || (o.filteredLibraryDiagnostics || 0) > 0;
    return uses ? 'C++ was not generated: the project uses library symbols, and the compiler has no implementation of them (the C++ would contain empty library blocks).' : '';
}

/**
 * @typedef {Object} Manifest
 * @property {string} generator Always MANIFEST_GENERATOR.
 * @property {number} version
 * @property {Object<string, {project: string, sha256: string}>} files By file name (no directory).
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
        if (!entry || typeof entry !== 'object' || path.basename(name) !== name || name === MANIFEST_NAME) continue;
        if (typeof entry.sha256 === 'string' && typeof entry.project === 'string') {
            manifest.files[name] = { project: entry.project, sha256: entry.sha256 };
        }
    }
    return { ok: true, manifest };
}

/** @param {string} dir @param {Manifest} manifest */
function writeManifest(dir, manifest) {
    const files = {};
    for (const name of Object.keys(manifest.files).sort()) files[name] = manifest.files[name];
    fs.writeFileSync(path.join(dir, MANIFEST_NAME),
        JSON.stringify({ generator: MANIFEST_GENERATOR, version: 1, files }, null, 2) + '\n', 'utf8');
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
    CPP_FILES_DIR, MANIFEST_NAME, MANIFEST_GENERATOR, DEFAULT_GENERATE_TIMEOUT_MS,
    cppFileStem, cppOutputPaths, isUnderCppFiles, cppOwnerId, libraryBlocksCpp,
    readManifest, ownership, writeOwnedOutputs, recordOwnedFile, claimOutput,
    runGenerate
};
