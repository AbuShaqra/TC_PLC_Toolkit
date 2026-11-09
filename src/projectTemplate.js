/**
 * @file projectTemplate.js
 * @description Creates a NEW TwinCAT solution from one of the shipped templates (roadmap R2,
 * approach (a)): copy the template, rename the solution / system project / PLC project, and
 * re-issue every identity GUID consistently.
 *
 * Why a template and not hand-written files: only TwinCAT XAE has ever produced a `.sln` →
 * `.tsproj`/`.tspproj` → `.plcproj` skeleton that XAE accepts (docs/handoff-findings.md, "`sample/` is
 * GROUND TRUTH"). The templates under `resources/templates/tc3.1.40xx/` are therefore XAE's own output,
 * derived by `scripts/build-project-templates.js`; this module changes nothing in them but names and
 * identity GUIDs. Every other byte — BOMs, CRLF/LF, tabs, attribute order, a missing trailing newline —
 * is carried across untouched.
 *
 * GUIDs come in two kinds and both are classified explicitly (`inventoryGuids`):
 *   - IDENTITY GUIDs (the solution, the system project, the PLC project and its special objects, the
 *     task, every object `Id`) are what XAE mints fresh when it creates a project, so a copy must
 *     mint fresh ones too — same old GUID → same new GUID in every file, keeping each occurrence's
 *     letter case (the `.sln` writes them upper-case, the `.plcproj` lower-case).
 *   - TYPE / CLASS GUIDs (the `.sln` project-type GUID, a TcCOM CLSID, the option-archive keys, a
 *     `.tmc` content hash) are the same in every project and must never change.
 * A GUID that matches neither list is a template defect and makes creation fail loudly rather than
 * guess — guessing wrong either way produces a project XAE may refuse to open.
 *
 * Dependency-free (Node `fs`/`path`/`crypto` only, no `vscode`) so it is unit-testable and the
 * template build script can share it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** The templates the extension ships, newest first. `dir` is relative to `resources/templates/`. */
const TEMPLATE_VERSIONS = Object.freeze([
    Object.freeze({ id: '3.1.4026', dir: 'tc3.1.4026', label: 'TwinCAT 3.1 Build 4026' }),
    Object.freeze({ id: '3.1.4024', dir: 'tc3.1.4024', label: 'TwinCAT 3.1 Build 4024' })
]);

const { PLC_SUFFIX, MAX_NAME_LENGTH, validateProjectName } = require('../media/projectName');

/** Extensions read as text and rewritten (names, GUIDs). Anything else is copied byte-for-byte. */
const TEXT_EXTS = new Set([
    '.sln', '.tsproj', '.tspproj', '.xti', '.xtv', '.plcproj',
    '.tcpou', '.tcgvl', '.tcdut', '.tcio', '.tctto'
]);

/** The files that make a folder "already hold a TwinCAT solution". */
const SOLUTION_EXTS = new Set(['.sln', '.tsproj', '.tspproj', '.plcproj']);

const BOM = '﻿';

/** One GUID, without braces, in either case. Base64 blobs cannot match (they contain no `-`). */
const GUID_SRC = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
const GUID_RE = new RegExp(`\\b${GUID_SRC}\\b`, 'g');

/**
 * Where an IDENTITY GUID sits, per file type. Each pattern's group 1 is the GUID. The list is the
 * documented inventory (DEVELOPMENT.md, "Project templates"); keep the two in step.
 * @type {Array<{exts: string[], re: RegExp, what: string}>}
 */
const IDENTITY_CONTEXTS = [
    { exts: ['.sln'], what: 'system project GUID (.sln Project line)',
        re: new RegExp(`^Project\\("\\{${GUID_SRC}\\}"\\)\\s*=\\s*"[^"]*",\\s*"[^"]*",\\s*"\\{(${GUID_SRC})\\}"`, 'gm') },
    { exts: ['.sln'], what: 'SolutionGuid',
        re: new RegExp(`SolutionGuid\\s*=\\s*\\{(${GUID_SRC})\\}`, 'g') },
    { exts: ['.tsproj', '.tspproj'], what: 'system project ProjectGUID',
        re: new RegExp(`\\bProjectGUID="\\{(${GUID_SRC})\\}"`, 'g') },
    { exts: ['.tsproj', '.tspproj', '.xti'], what: 'PLC project GUID (<Project GUID=…>)',
        re: new RegExp(`<Project\\s+GUID="\\{(${GUID_SRC})\\}"`, 'g') },
    { exts: ['.plcproj'], what: 'PLC project ids (ProjectGuid, Application, TypeSystem, Implicit_*, LibraryReferences)',
        re: new RegExp(`<(?:ProjectGuid|Application|TypeSystem|Implicit_Task_Info|Implicit_KindOfTask|Implicit_Jitter_Distribution|LibraryReferences)>\\{(${GUID_SRC})\\}<`, 'g') },
    { exts: ['.tctto'], what: 'task Id',
        re: new RegExp(`<Task\\b[^>]*\\bId="\\{(${GUID_SRC})\\}"`, 'g') },
    { exts: ['.tctto'], what: 'task implicit objects (TaskFBGuid, Fb_init, Fb_exit, CycleUpdate, PostCycleUpdate)',
        re: new RegExp(`<(?:TaskFBGuid|Fb_init|Fb_exit|CycleUpdate|PostCycleUpdate)>\\{(${GUID_SRC})\\}<`, 'g') },
    { exts: ['.tcpou', '.tcgvl', '.tcdut', '.tcio'], what: 'object / member Id',
        re: new RegExp(`\\bId="\\{(${GUID_SRC})\\}"`, 'g') }
];

/**
 * Where a TYPE / CLASS GUID sits. These are identical in every project XAE writes (checked across the
 * 3.1.4024 and 3.1.4026 skeletons) and must survive unchanged.
 * @type {Array<{exts: string[], re: RegExp, what: string}>}
 */
const KEEP_CONTEXTS = [
    { exts: ['.sln'], what: '.sln project-type GUID (TwinCAT XAE project kind)',
        re: new RegExp(`^Project\\("\\{(${GUID_SRC})\\}"\\)`, 'gm') },
    { exts: ['.xti'], what: 'TcCOM class id (CLSID)',
        re: new RegExp(`<CLSID\\b[^>]*>\\{(${GUID_SRC})\\}</CLSID>`, 'g') },
    { exts: ['.xtv', '.xti'], what: '.tmc content hash (TmcHash; XAE recomputes it on build)',
        re: new RegExp(`\\bTmcHash="\\{(${GUID_SRC})\\}"`, 'g') },
    { exts: ['.plcproj'], what: 'PLC option-archive category / type keys (inside <XmlArchive>)',
        re: /<XmlArchive>[\s\S]*?<\/XmlArchive>/g }
];

/**
 * Lists every file under a directory, relative paths with `/` separators, sorted.
 * @param {string} root
 * @returns {string[]}
 */
function listFiles(root) {
    /** @type {string[]} */
    const out = [];
    const walk = (rel) => {
        for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(childRel);
            else if (entry.isFile()) out.push(childRel);
        }
    };
    walk('');
    return out.sort();
}

/**
 * Reads a template directory into memory and identifies its solution, system project and PLC
 * project from what is on disk (exactly one of each).
 * @param {string} templateDir Directory holding the template's `.sln`.
 * @returns {{files: Array<{rel: string, data: Buffer}>, solutionName: string, systemName: string, plcName: string}}
 */
function readTemplate(templateDir) {
    const rels = listFiles(templateDir).filter(rel => !/(^|\/)README\.md$/i.test(rel));
    const files = rels.map(rel => ({ rel, data: fs.readFileSync(path.join(templateDir, ...rel.split('/'))) }));
    const one = (exts, what) => {
        const hits = rels.filter(rel => exts.includes(path.extname(rel).toLowerCase()));
        if (hits.length !== 1) {
            throw new Error(`template ${templateDir} must hold exactly one ${what}, found ${hits.length}`);
        }
        return path.basename(hits[0], path.extname(hits[0]));
    };
    return {
        files,
        solutionName: one(['.sln'], '.sln'),
        systemName: one(['.tsproj', '.tspproj'], 'system project (.tsproj/.tspproj)'),
        plcName: one(['.plcproj'], '.plcproj')
    };
}

/** @param {string} s @returns {string} `s` with every regex metacharacter escaped. */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Applies a name map in ONE pass, longest key first, so a replaced span is never rescanned (applying
 * `{A: 'A_1', A_PLC: …}` one entry at a time would turn `A_PLC` into `A_1_PLC`).
 * @param {string} text
 * @param {Record<string, string>} nameMap
 * @returns {string}
 */
function applyNameMap(text, nameMap) {
    const keys = Object.keys(nameMap).sort((a, b) => b.length - a.length);
    if (keys.length === 0) return text;
    return text.replace(new RegExp(keys.map(escapeRegExp).join('|'), 'g'), m => nameMap[m]);
}

/**
 * Splits a buffer into its optional UTF-8 BOM and its text.
 * @param {Buffer} data
 * @returns {{bom: boolean, text: string}}
 */
function decodeText(data) {
    const text = data.toString('utf8');
    return text.startsWith(BOM) ? { bom: true, text: text.slice(1) } : { bom: false, text };
}

/**
 * @param {string} rel
 * @returns {boolean} Whether the file is rewritten as text.
 */
function isTextFile(rel) {
    return TEXT_EXTS.has(path.extname(rel).toLowerCase());
}

/**
 * Classifies every GUID in a template's text files as IDENTITY (re-issued on create) or KEEP
 * (type/class GUIDs), by where it appears. Keys are lower-case GUIDs without braces.
 * @param {Array<{rel: string, data: Buffer}>} files
 * @returns {{regen: Map<string, Set<string>>, keep: Map<string, Set<string>>, unclassified: Array<{guid: string, file: string}>, conflicts: string[]}}
 *   `regen`/`keep` map each GUID to the descriptions of where it was found.
 */
function inventoryGuids(files) {
    /** @type {Map<string, Set<string>>} */
    const regen = new Map();
    /** @type {Map<string, Set<string>>} */
    const keep = new Map();
    const add = (map, guid, what) => {
        const key = guid.toLowerCase();
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(what);
    };
    for (const file of files) {
        if (!isTextFile(file.rel)) continue;
        const ext = path.extname(file.rel).toLowerCase();
        const { text } = decodeText(file.data);
        for (const ctx of IDENTITY_CONTEXTS) {
            if (!ctx.exts.includes(ext)) continue;
            for (const m of text.matchAll(ctx.re)) add(regen, m[1], ctx.what);
        }
        for (const ctx of KEEP_CONTEXTS) {
            if (!ctx.exts.includes(ext)) continue;
            for (const m of text.matchAll(ctx.re)) {
                if (m[1]) { add(keep, m[1], ctx.what); continue; }
                // A region (the option archive): every GUID inside it is a key, not an identity.
                for (const g of m[0].matchAll(GUID_RE)) add(keep, g[0], ctx.what);
            }
        }
    }
    const conflicts = [...regen.keys()].filter(g => keep.has(g));
    /** @type {Array<{guid: string, file: string}>} */
    const unclassified = [];
    for (const file of files) {
        if (!isTextFile(file.rel)) continue;
        for (const m of decodeText(file.data).text.matchAll(GUID_RE)) {
            const key = m[0].toLowerCase();
            if (!regen.has(key) && !keep.has(key)) unclassified.push({ guid: m[0], file: file.rel });
        }
    }
    return { regen, keep, unclassified, conflicts };
}

/** @returns {string} A fresh random GUID, lower-case, without braces. */
function randomGuid() {
    return crypto.randomUUID();
}

/**
 * Plans a new project in memory: the renamed paths and rewritten bytes of every file. Writes nothing.
 * @param {{templateDir: string, name: string, newGuid?: () => string}} options
 *   `newGuid` is injectable for tests; it must return a lower-case GUID without braces.
 * @returns {{files: Array<{rel: string, data: Buffer}>, nameMap: Record<string, string>, guidMap: Map<string, string>, plcName: string}}
 */
function planProject(options) {
    const { templateDir, name } = options;
    const problem = validateProjectName(name);
    if (problem) throw new Error(`invalid project name "${name}": ${problem}`);
    const newGuid = options.newGuid || randomGuid;

    const template = readTemplate(templateDir);
    const plcName = name + PLC_SUFFIX;
    /** @type {Record<string, string>} */
    const nameMap = {
        [template.solutionName]: name,
        [template.systemName]: name,
        [template.plcName]: plcName
    };

    const inventory = inventoryGuids(template.files);
    if (inventory.conflicts.length || inventory.unclassified.length) {
        const list = [
            ...inventory.conflicts.map(g => `${g} (classified both identity and type)`),
            ...inventory.unclassified.map(u => `${u.guid} in ${u.file}`)
        ];
        throw new Error(`template ${templateDir} carries GUIDs that are not classified: ${list.join(', ')}`);
    }

    /** @type {Map<string, string>} old lower-case GUID → new lower-case GUID */
    const guidMap = new Map();
    for (const old of [...inventory.regen.keys()].sort()) {
        let fresh;
        do { fresh = String(newGuid()).toLowerCase(); } while (inventory.regen.has(fresh) || inventory.keep.has(fresh));
        guidMap.set(old, fresh);
    }

    const files = template.files.map(file => {
        const rel = applyNameMap(file.rel, nameMap);
        if (!isTextFile(file.rel)) return { rel, data: file.data };
        const { bom, text } = decodeText(file.data);
        const renamed = applyNameMap(text, nameMap).replace(GUID_RE, g => {
            const fresh = guidMap.get(g.toLowerCase());
            if (!fresh) return g;
            return g === g.toUpperCase() ? fresh.toUpperCase() : fresh;
        });
        return { rel, data: Buffer.from((bom ? BOM : '') + renamed, 'utf8') };
    });
    return { files, nameMap, guidMap, plcName };
}

/**
 * Looks for TwinCAT solution files under a directory (bounded depth, skipping VCS / vendor folders).
 * @param {string} dir
 * @param {number} [maxDepth]
 * @returns {string[]} Absolute paths of the `.sln`/`.tsproj`/`.tspproj`/`.plcproj` files found.
 */
function findSolutionFiles(dir, maxDepth = 4) {
    /** @type {string[]} */
    const out = [];
    const walk = (d, depth) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                if (depth < maxDepth && !['.git', 'node_modules', '_libraries'].includes(entry.name.toLowerCase())) {
                    walk(full, depth + 1);
                }
            } else if (SOLUTION_EXTS.has(path.extname(entry.name).toLowerCase())) {
                out.push(full);
            }
        }
    };
    walk(dir, 0);
    return out.sort();
}

/**
 * Checks whether a project can be created at `<location>/<name>`. Scope is a NEW solution only
 * (ROADMAP.md R2, decision 2): the target must not exist, or be a folder holding no TwinCAT
 * solution and none of the files about to be written.
 * @param {{location: string, name: string, plannedRels?: string[]}} options
 * @returns {{ok: boolean, targetDir: string, reason?: string}}
 */
function checkTarget(options) {
    const { location, name } = options;
    const problem = validateProjectName(name);
    const targetDir = path.join(location || '', name || '');
    if (problem) return { ok: false, targetDir, reason: problem };
    let stat;
    try { stat = fs.statSync(location); } catch (e) { stat = null; }
    if (!stat || !stat.isDirectory()) return { ok: false, targetDir, reason: `The location ${location} is not an existing folder.` };
    if (!fs.existsSync(targetDir)) return { ok: true, targetDir };
    if (!fs.statSync(targetDir).isDirectory()) return { ok: false, targetDir, reason: `${targetDir} exists and is not a folder.` };
    const existing = findSolutionFiles(targetDir);
    if (existing.length) {
        return {
            ok: false, targetDir,
            reason: `${targetDir} already contains a TwinCAT solution (${path.relative(targetDir, existing[0])}). ` +
                'Creating a project adds a new solution only; choose an empty folder or another name.'
        };
    }
    for (const rel of options.plannedRels || []) {
        if (fs.existsSync(path.join(targetDir, ...rel.split('/')))) {
            return { ok: false, targetDir, reason: `${path.join(targetDir, rel)} already exists.` };
        }
    }
    return { ok: true, targetDir };
}

/**
 * Creates a new TwinCAT solution at `<location>/<name>/` from a template. Never overwrites: every file
 * is opened exclusively, and on failure the files and folders this call created are removed again
 * (nothing that existed before is touched).
 * @param {{templateDir: string, location: string, name: string, newGuid?: () => string}} options
 * @returns {{targetDir: string, slnPath: string, plcprojPath: string, files: string[], guidMap: Map<string, string>}}
 */
function createProject(options) {
    const plan = planProject(options);
    const check = checkTarget({ location: options.location, name: options.name, plannedRels: plan.files.map(f => f.rel) });
    if (!check.ok) throw new Error(check.reason);
    const targetDir = check.targetDir;

    /** @type {string[]} */
    const createdFiles = [];
    /** @type {string[]} */
    const createdDirs = [];
    const ensureDir = (dir) => {
        if (fs.existsSync(dir)) return;
        ensureDir(path.dirname(dir));
        fs.mkdirSync(dir);
        createdDirs.push(dir);
    };
    try {
        ensureDir(targetDir);
        for (const file of plan.files) {
            const abs = path.join(targetDir, ...file.rel.split('/'));
            ensureDir(path.dirname(abs));
            fs.writeFileSync(abs, file.data, { flag: 'wx' });
            createdFiles.push(abs);
        }
    } catch (err) {
        for (const f of createdFiles.reverse()) { try { fs.unlinkSync(f); } catch (e) { /* best effort */ } }
        for (const d of createdDirs.reverse()) { try { fs.rmdirSync(d); } catch (e) { /* not empty: leave it */ } }
        throw err;
    }
    const find = (ext) => plan.files.map(f => f.rel).find(rel => rel.toLowerCase().endsWith(ext));
    return {
        targetDir,
        slnPath: path.join(targetDir, ...find('.sln').split('/')),
        plcprojPath: path.join(targetDir, ...find('.plcproj').split('/')),
        files: createdFiles.slice(),
        guidMap: plan.guidMap
    };
}

/**
 * Resolves a version id to its template directory under a templates root.
 * @param {string} templatesRoot `resources/templates` of the installed extension.
 * @param {string} versionId e.g. '3.1.4026'.
 * @returns {string}
 */
function templateDirFor(templatesRoot, versionId) {
    const v = TEMPLATE_VERSIONS.find(t => t.id === versionId);
    if (!v) throw new Error(`unknown TwinCAT version "${versionId}"`);
    return path.join(templatesRoot, v.dir);
}

module.exports = {
    TEMPLATE_VERSIONS,
    PLC_SUFFIX,
    MAX_NAME_LENGTH,
    IDENTITY_CONTEXTS,
    KEEP_CONTEXTS,
    validateProjectName,
    readTemplate,
    applyNameMap,
    decodeText,
    inventoryGuids,
    planProject,
    checkTarget,
    createProject,
    findSolutionFiles,
    templateDirFor,
    listFiles
};
