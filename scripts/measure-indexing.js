#!/usr/bin/env node
/**
 * @file measure-indexing.js
 * @description Timing harness for the workspace scan (R6). Builds a synthetic multi-project workspace
 * from copies of the committed sample, then times the REAL scan composition — workspaceScan.js's
 * `scanWorkspace` with libraryIndex.js's `indexLibraries`, exactly what server.js runs — in fresh
 * Node processes, so each run is a new "session" with empty in-memory caches.
 *
 * Not part of `npm test`: it measures, it does not gate. Every library name it writes is SYNTHETIC
 * (`SynLibNN_…`); no vendor content is copied, and the workspace lives in a temp directory.
 *
 * Usage:
 *   node scripts/measure-indexing.js                       # 8 projects x 150 objects, 40 libraries
 *   node scripts/measure-indexing.js --projects 2 --objects 20 --libraries 5 --runs 3
 *   node scripts/measure-indexing.js --samples             # the committed sample/ folder as-is
 *   node scripts/measure-indexing.js --keep                # keep the generated workspace
 *   node scripts/measure-indexing.js --drop-caches         # Linux, root: drop the OS page cache
 *                                                          # before every session (true cold disk)
 *
 * What it reports, per run (median over --runs):
 *   cold   — a fresh process with no persisted archive cache (the first session ever on a machine);
 *   warm   — a fresh process reusing the persisted archive cache the cold run wrote (a second session);
 *   ready  — time from scan start until the first and the last project's index can answer, and until
 *            a request for the LAST-discovered project (an editor open on it at startup) is answered.
 *            Before R6 part 3 every one of these equals the whole scan.
 * Without --drop-caches the OS page cache stays warm, so "cold" means "cold for the toolkit" only.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SAMPLE = path.join(REPO, 'sample', 'TcToolkitSample');

/**
 * Parses `--name value` / `--flag` arguments.
 * @param {string[]} argv
 * @returns {Object<string, string|boolean>}
 */
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
    }
    return out;
}

/** LEB128, as the archive string table writes lengths and ids. */
function varint(value) {
    const bytes = [];
    let v = value;
    do { let b = v & 0x7f; v >>>= 7; if (v > 0) b |= 0x80; bytes.push(b); } while (v > 0);
    return Buffer.from(bytes);
}

/**
 * A ZIP archive with a deflated string-table entry and a stored filler entry, so the file has a
 * realistic size to read even though only the table is decoded. The table also carries `junk`
 * non-identifier strings (doc-comment shaped), as real tables do, so the decode has real work.
 * @param {string[]} identifiers
 * @param {number} fillerBytes
 * @param {number} junk
 * @returns {Buffer}
 */
function archiveOf(identifiers, fillerBytes, junk) {
    const entries = [];
    const names = identifiers.slice();
    for (let j = 0; j < junk; j++) names.push(`Synthetic comment ${j}: the value is clamped to the configured range (${j % 97}).`);
    const table = Buffer.concat([varint(names.length), ...names.flatMap((n, i) => {
        const b = Buffer.from(n, 'utf8');
        return [varint(i), varint(b.length), b];
    })]);
    entries.push({ name: '__shared_data_storage_string_table__.auxiliary', raw: table, body: zlib.deflateRawSync(table), method: 8 });
    const filler = Buffer.alloc(fillerBytes);
    for (let i = 0; i < filler.length; i++) filler[i] = (i * 2654435761) >>> 24;
    entries.push({ name: 'filler.bin', raw: filler, body: filler, method: 0 });

    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const crc = zlib.crc32 ? zlib.crc32(e.raw) : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.method, 8);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.body.length, 18); local.writeUInt32LE(e.raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(e.method, 10); central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(e.body.length, 20); central.writeUInt32LE(e.raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, e.body);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + e.body.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * A generated function block, in the TcPOU layout the indexer reads.
 * @param {string} name
 * @returns {string}
 */
function generatedPou(name) {
    const decl = [`FUNCTION_BLOCK ${name}`, 'VAR_INPUT', '\tbEnable : BOOL;', '\tnSetpoint : INT;', 'END_VAR',
        'VAR_OUTPUT', '\tbDone : BOOL;', 'END_VAR', 'VAR', '\tnCount : INT;', 'END_VAR'].join('\r\n');
    const impl = ['IF bEnable THEN', '\tnCount := nCount + 1;', '\tbDone := nCount >= nSetpoint;', 'END_IF'].join('\r\n');
    return '<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n' +
        `  <POU Name="${name}" Id="{00000000-0000-0000-0000-000000000001}" SpecialFunc="None">\r\n` +
        `    <Declaration><![CDATA[${decl}]]></Declaration>\r\n` +
        `    <Implementation>\r\n      <ST><![CDATA[${impl}]]></ST>\r\n    </Implementation>\r\n` +
        '  </POU>\r\n</TcPlcObject>';
}

/**
 * Builds the synthetic workspace: N copies of the sample, each with M extra objects, its own vendored
 * `_Libraries` (byte-identical across projects, same mtime — the real duplication pattern), a `_Boot`
 * tree and a docs folder (noise every directory walk has to cross), plus one workspace-level
 * `library-signatures.xml`.
 * @param {{dir: string, projects: number, objects: number, libraries: number, names: number,
 *   filler: number, junk: number}} opts
 * @returns {string} The workspace root.
 */
function buildWorkspace(opts) {
    const ws = opts.dir;
    fs.mkdirSync(ws, { recursive: true });
    const archives = [];
    for (let l = 0; l < opts.libraries; l++) {
        const names = [];
        for (let n = 0; n < opts.names; n++) names.push(`SynLib${l}_Sym${n}`);
        archives.push({ title: `SynLib${l}`, buf: archiveOf(names, opts.filler, opts.junk) });
    }
    const fixedTime = new Date('2026-01-01T00:00:00Z');
    for (let p = 0; p < opts.projects; p++) {
        const projRoot = path.join(ws, `Line${p}`);
        fs.cpSync(SAMPLE, projRoot, { recursive: true });
        const plcDir = path.join(projRoot, 'TcToolkitSample_PLC');
        const plcproj = path.join(plcDir, 'TcToolkitSample_PLC.plcproj');
        const genDir = path.join(plcDir, 'POUs', 'Generated');
        fs.mkdirSync(genDir, { recursive: true });
        const compiles = [];
        for (let o = 0; o < opts.objects; o++) {
            const name = `FB_Gen${o}`;
            fs.writeFileSync(path.join(genDir, `${name}.TcPOU`), generatedPou(name));
            compiles.push(`    <Compile Include="POUs\\Generated\\${name}.TcPOU">\r\n      <SubType>Code</SubType>\r\n    </Compile>`);
        }
        const text = fs.readFileSync(plcproj, 'utf8');
        fs.writeFileSync(plcproj, text.replace(/<ItemGroup>/, '<ItemGroup>\r\n' + compiles.join('\r\n')));
        for (const a of archives) {
            const d = path.join(plcDir, '_Libraries', 'synthetic co', a.title, '1.0.0.0');
            fs.mkdirSync(d, { recursive: true });
            const f = path.join(d, `${a.title}.compiled-library`);
            fs.writeFileSync(f, a.buf);
            fs.utimesSync(f, fixedTime, fixedTime);
        }
        for (let b = 0; b < 20; b++) {
            const d = path.join(projRoot, '_Boot', 'TwinCAT RT (x64)', 'Plc', `Port_${b}`);
            fs.mkdirSync(d, { recursive: true });
            for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(d, `file${f}.bin`), 'x');
        }
        for (let d = 0; d < 30; d++) {
            const dd = path.join(projRoot, 'Docs', `Section${d}`, 'Sub');
            fs.mkdirSync(dd, { recursive: true });
            for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(dd, `note${f}.txt`), 'x');
        }
    }
    const libs = [];
    for (let l = 0; l < opts.libraries; l++) {
        libs.push(`  <Library><LibraryName>SynLib${l}</LibraryName><Version>1.0.0.0</Version><Distributor>synthetic co</Distributor><TypeSignatures>` +
            `<TypeSignature type="Function"><Name>F_SynLib${l}</Name><Inputs><Input><Name>nA</Name><DataType>INT</DataType></Input></Inputs>` +
            `<Outputs><Output><Name>F_SynLib${l}</Name><DataType>INT</DataType></Output></Outputs></TypeSignature></TypeSignatures></Library>`);
    }
    fs.writeFileSync(path.join(ws, 'library-signatures.xml'), `<?xml version="1.0"?>\n<LibrarySignatures>\n${libs.join('\n')}\n</LibrarySignatures>\n`);
    return ws;
}

/**
 * The child-process body: one "session". Times the real scan and reports JSON on stdout.
 * @param {string[]} roots Workspace roots.
 * @param {string} cacheDir Persisted archive cache directory ('' for none).
 */
function child(roots, cacheDir) {
    const realReaddir = fs.readdirSync;
    let readdirCalls = 0;
    let readdirMs = 0;
    fs.readdirSync = function (...args) {
        readdirCalls++;
        const t = process.hrtime.bigint();
        try { return realReaddir.apply(fs, args); } finally { readdirMs += Number(process.hrtime.bigint() - t) / 1e6; }
    };
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const libsymbols = require(path.join(REPO, 'src/lsp/libsymbols'));
    if (cacheDir && typeof libsymbols.configureArchiveCache === 'function') libsymbols.configureArchiveCache(cacheDir);
    const scanModule = require(path.join(REPO, 'src/lsp/workspaceScan'));
    const { createIndexLibraries } = require(path.join(REPO, 'src/lsp/libraryIndex'));
    const loadMs = ms();
    const logs = [];
    const indexLibraries = createIndexLibraries({ log: (l) => logs.push(l) });
    /** Project key -> ms from scan start until its index could answer. */
    const ready = {};
    /** Ms from scan start until a request for the LAST-discovered project was answered. */
    let lastProjectAnswer = null;
    const done = (ws) => {
        const scanMs = ms() - loadMs;
        if (typeof libsymbols.flushArchiveCache === 'function') libsymbols.flushArchiveCache();
        const sigMs = logs.map(l => /signatures: .* in (\d+) ms; browsercache/.exec(l)).filter(Boolean).reduce((s, m) => s + Number(m[1]), 0);
        const archMs = logs.map(l => /archive\(s\) \(\d+ undecodable\) in (\d+) ms/.exec(l)).filter(Boolean).reduce((s, m) => s + Number(m[1]), 0);
        process.stdout.write(JSON.stringify({
            loadMs, scanMs, readdirCalls, readdirMs, sigMs, archMs,
            projects: ws.projectMap ? ws.projectMap.projects.size : 0,
            archive: { ...libsymbols.__archiveStats },
            ready,
            lastProjectAnswer
        }));
    };
    if (typeof scanModule.startWorkspaceScan !== 'function') {
        // The one-pass scan (before R6 part 3): nothing can answer until all of it has run.
        const ws = scanModule.scanWorkspace(roots, { indexLibraries });
        const t = ms() - loadMs;
        for (const k of ws.projectMap.keys()) ready[k] = t;
        lastProjectAnswer = t;
        done(ws);
        return;
    }
    const handle = scanModule.startWorkspaceScan(roots, {
        indexLibraries,
        onProjectReady: (key) => { ready[key] = ms() - loadMs; }
    });
    // An editor open on a file of the LAST project in discovery order asks at once — the worst case
    // for a scan without priority, and the case per-project readiness exists for.
    if (handle.workspace.projectMap && handle.workspace.projectMap.projects.size > 0) {
        const projects = Array.from(handle.workspace.projectMap.projects.values());
        const last = projects[projects.length - 1];
        const file = Array.from(last.objectFiles.values())[0];
        if (file) handle.workspace.readyFor(file).then(() => { lastProjectAnswer = ms() - loadMs; });
    }
    handle.done.then(() => done(handle.workspace));
}

/**
 * Runs one session in a fresh process.
 * @param {string[]} roots
 * @param {string} cacheDir
 * @param {boolean} dropCaches Drop the OS page cache first (Linux, root).
 * @returns {Object}
 */
function session(roots, cacheDir, dropCaches) {
    if (dropCaches) {
        spawnSync('sync');
        fs.writeFileSync('/proc/sys/vm/drop_caches', '3');
    }
    const r = spawnSync(process.execPath, [__filename, '--child', JSON.stringify({ roots, cacheDir })], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`session failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
}

/** @param {number[]} xs */
function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.child) {
        const { roots, cacheDir } = JSON.parse(String(args.child));
        child(roots, cacheDir);
        return;
    }
    const runs = Number(args.runs || 3);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_measure_'));
    let roots;
    if (args.samples) {
        roots = [path.join(REPO, 'sample')];
    } else if (args.workspace) {
        roots = [path.resolve(String(args.workspace))];
    } else {
        const opts = {
            dir: path.join(tmp, 'ws'),
            projects: Number(args.projects || 8),
            objects: Number(args.objects || 150),
            libraries: Number(args.libraries || 40),
            names: Number(args.names || 4000),
            filler: Number(args.filler || 400 * 1024),
            junk: Number(args.junk || 15000)
        };
        const t = Date.now();
        roots = [buildWorkspace(opts)];
        console.log(`Built ${opts.projects} project(s) x ${opts.objects} objects, ${opts.libraries} libraries ` +
            `(${opts.names} names + ${opts.junk} comment strings, ${Math.round(opts.filler / 1024)} KB filler each) ` +
            `at ${roots[0]} in ${Date.now() - t} ms`);
    }
    const rows = { cold: [], warm: [] };
    for (let i = 0; i < runs; i++) {
        const cacheDir = path.join(tmp, `cache${i}`);
        rows.cold.push(session(roots, cacheDir, !!args['drop-caches']));
        rows.warm.push(session(roots, cacheDir, !!args['drop-caches']));
    }
    for (const kind of ['cold', 'warm']) {
        const r = rows[kind];
        const last = r[r.length - 1];
        const readyTimes = r.map(x => Object.values(x.ready));
        const firstReady = readyTimes.every(t => t.length) ? median(readyTimes.map(t => Math.min(...t))) : null;
        const lastReady = readyTimes.every(t => t.length) ? median(readyTimes.map(t => Math.max(...t))) : null;
        console.log(`${kind.padEnd(5)} scan ${median(r.map(x => x.scanMs)).toFixed(0)} ms ` +
            `(module load ${median(r.map(x => x.loadMs)).toFixed(0)} ms), ` +
            `archive stage ${median(r.map(x => x.archMs))} ms, signature stage ${median(r.map(x => x.sigMs))} ms, ` +
            `readdir ${last.readdirCalls} calls / ${median(r.map(x => x.readdirMs)).toFixed(0)} ms, ` +
            `projects ${last.projects}, archives ${JSON.stringify(last.archive)}` +
            (firstReady !== null ? `, first project ready ${firstReady.toFixed(0)} ms, last ${lastReady.toFixed(0)} ms` : '') +
            (r.every(x => x.lastProjectAnswer !== null)
                ? `, a request for the last project answered at ${median(r.map(x => x.lastProjectAnswer)).toFixed(0)} ms` : ''));
    }
    if (!args.keep) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`Kept ${tmp}`);
}

main();
