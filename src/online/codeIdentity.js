/**
 * @file codeIdentity.js
 * @description Online monitoring (R15): the code-mismatch guard, as far as it can be checked without
 * an undocumented service. User decision D5 blocks writes "while the PLC's code differs from the
 * project"; what can actually be compared is weaker than "the same code", and this module says
 * exactly which of three checks passed:
 *
 *   1. **Name** — `_AppInfo.ProjectName` on the PLC equals a PLC project of the workspace. The first
 *      gate: a different name means a different project, and inline values are hidden.
 *   2. **Variable layout** — the symbol table of the project's last build (`<project>.tmc`, written by
 *      XAE on every build: name and BitSize of every symbol) against the PLC's uploaded symbols
 *      (ads-client `getSymbols`: name and byte size), restricted to the namespaces the `.tmc` has.
 *      A variable added, removed, retyped or resized between the build and what runs shows here.
 *   3. **Edited since the build** — any source file of the project (`.TcPOU/.TcGVL/.TcDUT/.TcIO`)
 *      newer than the `.tmc`: the code on disk is not the code that was built.
 *
 * What it CANNOT detect: a change to code bodies only (no variable changed) that was built but not
 * downloaded, or downloaded from another copy of the project. XAE's own login check (its compile
 * id) is not exposed through any documented ADS service, so it is not used. The status bar and the
 * docs say "name, variable layout and edits since the last build", never "same code".
 * vscode-free; the file system is injected for the harnesses.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Source files that make up a PLC project's code. */
const SOURCE_RE = /\.(TcPOU|TcGVL|TcDUT|TcIO)$/i;
/** Folders under a project that hold no project source. */
const SKIP_DIRS = new Set(['_libraries', '_compileinfo', '_boot', '.git', 'st_files', 'cpp_files']);

/**
 * The symbols of a `.tmc`'s data areas: name, byte size (BitSize / 8) and base type.
 * @param {string} text The `.tmc` file's text.
 * @returns {Map<string, {name: string, bytes: number|null, baseType: string, array: boolean}>} By lower-case name.
 */
function parseTmcSymbols(text) {
    /** @type {Map<string, {name: string, bytes: number|null, baseType: string, array: boolean}>} */
    const out = new Map();
    const areas = String(text || '').match(/<DataArea>[\s\S]*?<\/DataArea>/g) || [];
    for (const area of areas) {
        const re = /<Symbol>([\s\S]*?)<\/Symbol>/g;
        let m;
        while ((m = re.exec(area))) {
            const body = m[1];
            const name = /<Name>([^<]*)<\/Name>/.exec(body);
            if (!name) continue;
            const bits = /<BitSize>(\d+)<\/BitSize>/.exec(body);
            const base = /<BaseType[^>]*>([^<]*)<\/BaseType>/.exec(body);
            const n = bits ? Number(bits[1]) : NaN;
            out.set(name[1].toLowerCase(), {
                name: name[1], bytes: Number.isFinite(n) && n % 8 === 0 ? n / 8 : null,
                baseType: base ? base[1] : '', array: /<ArrayInfo>/.test(body)
            });
        }
    }
    return out;
}

/**
 * Compares the last build's symbols with the PLC's, by name and byte size, in the namespaces the
 * `.tmc` declares (so the PLC's own I/O and system areas outside them are not counted).
 * @param {ReturnType<typeof parseTmcSymbols>} built
 * @param {Array<{name: string, type: string, size?: number}>} online
 * @returns {{ok: boolean, differences: string[], checked: number}}
 */
function compareLayout(built, online) {
    const prefixes = new Set([...built.values()].map(s => s.name.split('.')[0].toLowerCase()));
    const onlineByName = new Map();
    for (const s of online) {
        if (prefixes.has(String(s.name).split('.')[0].toLowerCase())) onlineByName.set(String(s.name).toLowerCase(), s);
    }
    const differences = [];
    for (const [key, s] of built) {
        const o = onlineByName.get(key);
        if (!o) { differences.push(`${s.name} is in the last build but not on the PLC`); continue; }
        if (s.bytes !== null && typeof o.size === 'number' && o.size !== s.bytes) {
            differences.push(`${s.name} is ${s.bytes} bytes in the last build but ${o.size} on the PLC`);
        }
    }
    for (const [key, o] of onlineByName) {
        if (!built.has(key)) differences.push(`${o.name} is on the PLC but not in the last build`);
    }
    return { ok: differences.length === 0, differences, checked: built.size };
}

/**
 * Source files of a project changed after a time (the `.tmc`'s), newest first, at most `limit`.
 * @param {string} dir The project folder (where the `.plcproj` is).
 * @param {number} sinceMs
 * @param {{readdirSync: Function, statSync: Function}} [fsLike]
 * @param {number} [limit]
 * @returns {string[]} Paths relative to `dir`.
 */
function sourcesEditedSince(dir, sinceMs, fsLike = fs, limit = 5) {
    /** @type {Array<{p: string, t: number}>} */
    const found = [];
    const walk = (/** @type {string} */ d, /** @type {number} */ depth) => {
        if (depth > 8) return;
        let entries;
        try { entries = fsLike.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(full, depth + 1); continue; }
            if (!SOURCE_RE.test(e.name)) continue;
            try {
                const t = fsLike.statSync(full).mtimeMs;
                if (t > sinceMs) found.push({ p: path.relative(dir, full), t });
            } catch (err) { /* vanished: not a difference */ }
        }
    };
    walk(dir, 0);
    found.sort((a, b) => b.t - a.t);
    return found.slice(0, limit).map(f => f.p);
}

/**
 * The given files changed after a time, newest first, at most `limit`.
 * @param {string[]} files Absolute paths.
 * @param {number} sinceMs
 * @param {string} dir For relative names.
 * @param {{statSync: Function}} [fsLike]
 * @param {number} [limit]
 * @returns {string[]}
 */
function filesEditedSince(files, sinceMs, dir, fsLike = fs, limit = 5) {
    const found = [];
    for (const f of files) {
        try {
            const t = fsLike.statSync(f).mtimeMs;
            if (t > sinceMs) found.push({ p: dir ? path.relative(dir, f) : f, t });
        } catch (e) { /* missing: not an edit */ }
    }
    found.sort((a, b) => b.t - a.t);
    return found.slice(0, limit).map(x => x.p);
}

/**
 * @typedef {Object} CodeCheck
 * @property {'match'|'differs'|'unknown'} state Writes need 'match'.
 * @property {'match'|'differs'|'unknown'} name
 * @property {'match'|'differs'|'unknown'} layout
 * @property {'none'|'edited'|'unknown'} edits
 * @property {boolean} showValues Inline values are shown unless the NAME differs or cannot be read.
 * @property {string} reason One sentence for a refusal or the status bar.
 * @property {string[]} details The individual findings, for the output channel.
 */

/**
 * Runs the three checks.
 * @param {Object} o
 * @param {string|null} o.projectName `_AppInfo.ProjectName`, or null when unread.
 * @param {Array<{name: string, dir?: string, files?: string[]}>} o.projects The workspace's PLC projects;
 *   `files` are the objects the `.plcproj` compiles (else the folder is walked).
 * @param {() => Promise<Array<{name: string, type: string, size?: number}>>} o.onlineSymbols
 * @param {{readFileSync: Function, statSync: Function, readdirSync: Function}} [o.fs]
 * @returns {Promise<CodeCheck & {project: {name: string, dir?: string, files?: string[]}|null}>}
 */
async function checkCode(o) {
    const fsLike = o.fs || fs;
    const name = o.projectName;
    if (!name) {
        return { state: 'unknown', name: 'unknown', layout: 'unknown', edits: 'unknown', showValues: false, project: null,
            reason: 'The PLC did not report its project name, so its code cannot be checked against this workspace.', details: [] };
    }
    const project = o.projects.find(p => p.name.toLowerCase() === name.toLowerCase()) || null;
    if (!project) {
        return { state: 'differs', name: 'differs', layout: 'unknown', edits: 'unknown', showValues: false, project: null,
            reason: `The PLC runs "${name}", which is not a PLC project of this workspace.`, details: [] };
    }
    const details = [];
    const tmcPath = project.dir ? path.join(project.dir, `${project.name}.tmc`) : null;
    let tmcText = null;
    let tmcTime = 0;
    if (tmcPath) {
        try { tmcText = String(fsLike.readFileSync(tmcPath, 'utf8')); tmcTime = fsLike.statSync(tmcPath).mtimeMs; } catch (e) { tmcText = null; }
    }
    if (tmcText === null) {
        return { state: 'unknown', name: 'match', layout: 'unknown', edits: 'unknown', showValues: true, project,
            reason: `${project.name}.tmc (written by an XAE build) is missing, so the PLC's code cannot be checked beyond its project name.`,
            details: [`no ${project.name}.tmc in ${project.dir || '(unknown folder)'}`] };
    }
    /** @type {'match'|'differs'|'unknown'} */
    let layout = 'unknown';
    try {
        const cmp = compareLayout(parseTmcSymbols(tmcText), await o.onlineSymbols());
        layout = cmp.ok ? 'match' : 'differs';
        details.push(cmp.ok ? `variable layout: ${cmp.checked} symbols of the last build match the PLC`
            : `variable layout differs: ${cmp.differences.slice(0, 5).join('; ')}${cmp.differences.length > 5 ? ` (and ${cmp.differences.length - 5} more)` : ''}`);
    } catch (e) {
        details.push(`variable layout: the PLC's symbols could not be read (${e && /** @type {any} */ (e).message})`);
    }
    const edited = Array.isArray(project.files) ? filesEditedSince(project.files, tmcTime, project.dir || '', fsLike)
        : (project.dir ? sourcesEditedSince(project.dir, tmcTime, fsLike) : []);
    if (edited.length) details.push(`edited since the last build: ${edited.join(', ')}`);
    const edits = edited.length ? 'edited' : 'none';
    /** @type {'match'|'differs'|'unknown'} */
    const state = layout === 'differs' || edits === 'edited' ? 'differs' : (layout === 'match' ? 'match' : 'unknown');
    let reason = 'Project name and variable layout match the last build, and nothing was edited since it (a change to code bodies alone cannot be detected).';
    if (layout === 'differs') reason = `The variables on the PLC differ from the last build of ${project.name}.`;
    else if (edits === 'edited') reason = `${project.name} was edited since its last build (${edited[0]}), so the PLC does not run the code on screen.`;
    else if (layout === 'unknown') reason = `The PLC's variables could not be compared with the last build of ${project.name}.`;
    return { state, name: 'match', layout, edits, showValues: true, project, reason, details };
}

module.exports = { parseTmcSymbols, compareLayout, sourcesEditedSince, filesEditedSince, checkCode };
