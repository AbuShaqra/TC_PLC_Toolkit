/**
 * @file test_index_inputs.js
 * @description The `.tmc` / `library-signatures.xml` watcher inputs (src/indexInputs.js): which paths
 * re-index, and the gate that keeps the extension's own dump write from re-indexing twice.
 *
 * Why it matters: the scan memoizes directory listings per scan, so a `.tmc` from a TwinCAT build or a
 * new signatures dump is invisible until the next `custom/reindex`. Too narrow a match leaves the index
 * stale (false diagnostics); too wide a match pays a full scan for files the scan never reads.
 * extension.js is vscode-bound, so its wiring is checked statically at the end.
 */

const fs = require('fs');
const path = require('path');
const { isIndexInputFile, createOwnWriteGate } = require('../src/indexInputs');
const { createDebouncer } = require('../src/util/debounce');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

async function main() {
    // --- what counts as an index input ---
    const yes = [
        'C:\\Work\\Plant\\PLC1\\PLC1.tmc',
        '/work/plant/PLC1/plc1.TMC',
        'C:\\Work\\Plant\\library-signatures.xml',
        '/work/plant/LIBRARY-SIGNATURES.XML'
    ];
    for (const p of yes) assert(isIndexInputFile(p), `index input: ${p}`);
    const no = [
        'C:\\Work\\Plant\\PLC1\\PLC1.plcproj',            // the .plcproj has its own path
        'C:\\Work\\Plant\\PLC1\\POUs\\MAIN.TcPOU',
        'C:\\Work\\Plant\\PLC1\\PLC1.tmc.bak',
        'C:\\Work\\Plant\\other-signatures.xml',
        'C:\\Work\\Plant\\PLC1\\_Libraries\\beckhoff\\x.tmc',  // the scan's walkers skip these dirs
        'C:\\Work\\Plant\\PLC1\\_CompileInfo\\a.tmc',
        'C:\\Work\\Plant\\PLC1\\ST_Files\\library-signatures.xml',
        '/work/.git/library-signatures.xml',
        '/work/node_modules/x/y.tmc',
        '',
        'C:\\Work\\Plant\\PLC1\\tmc'                         // a folder named tmc, no extension
    ];
    for (const p of no) assert(!isIndexInputFile(p), `not an index input: ${JSON.stringify(p)}`);

    // --- the own-write gate ---
    {
        let t = 1000;
        const gate = createOwnWriteGate({ graceMs: 500, now: () => t });
        assert(!gate.suppressed(), 'not suppressed before any own write');
        let seenInside = null;
        const result = await gate.run(async () => { seenInside = gate.suppressed(); t += 10000; return 7; });
        assert(seenInside === true, 'suppressed while the own write runs, however long it takes');
        assert(result === 7, 'run passes the work\'s result through');
        assert(gate.suppressed(), 'still suppressed inside the grace period (late file events)');
        t += 499;
        assert(gate.suppressed(), 'suppressed until the grace period ends');
        t += 1;
        assert(!gate.suppressed(), 'not suppressed after the grace period');

        let threw = false;
        try { await gate.run(() => { throw new Error('boom'); }); } catch { threw = true; }
        assert(threw, 'a failing own write rethrows');
        assert(gate.suppressed(), 'a failing own write still starts the grace period');
        t += 500;
        assert(!gate.suppressed(), '...and the gate reopens afterwards (never stuck closed)');
    }

    // --- end to end on the host's shape: inputs -> long debounce -> .plcproj debounce -> one reindex ---
    {
        const timers = new Map();
        let next = 1;
        const clock = {
            setTimeout: (cb) => { const h = next++; timers.set(h, cb); return h; },
            clearTimeout: (h) => { timers.delete(h); }
        };
        const flush = () => { while (timers.size) { const [[h, cb]] = timers.entries(); timers.delete(h); cb(); } };
        let reindexes = 0;
        let t = 0;
        const gate = createOwnWriteGate({ graceMs: 100, now: () => t });
        const reindexForLibraries = createDebouncer(() => { reindexes++; }, 400, clock);
        const reindexForInputs = createDebouncer(() => { reindexForLibraries.schedule(); }, 1500, clock);
        const note = (p) => { if (isIndexInputFile(p) && !gate.suppressed()) reindexForInputs.schedule(); };

        // A build touching three projects' .tmc plus a .plcproj change: one scan.
        note('/w/P1/P1.tmc'); note('/w/P2/P2.tmc'); note('/w/P3/P3.tmc');
        reindexForLibraries.schedule();
        flush();
        assert(reindexes === 1, `a build burst plus a .plcproj change re-indexes once (got ${reindexes})`);

        note('/w/P1/POUs/MAIN.TcPOU');
        flush();
        assert(reindexes === 1, 'a source file does not take this path');

        note('/w/library-signatures.xml');
        flush();
        assert(reindexes === 2, 'a new signatures dump re-indexes');

        await gate.run(async () => { note('/w/library-signatures.xml'); });
        note('/w/library-signatures.xml');  // late event inside the grace period
        flush();
        assert(reindexes === 2, 'our own dump write does not re-index through the watcher');
        t += 100;
        note('/w/P1/P1.tmc');
        flush();
        assert(reindexes === 3, 'a later external .tmc change re-indexes again');
    }

    // --- static wiring checks (extension.js and the command are vscode-bound) ---
    {
        const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
        for (const ev of ['onDidCreate', 'onDidChange', 'onDidDelete']) {
            assert(ext.includes(`workspaceWatcher.${ev}(noteIndexInput)`), `extension.js routes ${ev} to the index-input watcher`);
        }
        assert(/noteIndexInput[\s\S]{0,200}ownIndexWrites\.suppressed\(\)/.test(ext), 'the watcher consults the own-write gate');
        assert(/registerLibraryCommands\(context, \{[^}]*ownIndexWrites/.test(ext), 'the gate is handed to the library commands');
        const cmd = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'libraryCommands.js'), 'utf8');
        assert(/ownIndexWrites\.run\([\s\S]*runSignatureGenerator[\s\S]*custom\/reindex/.test(cmd),
            'Update Library Definitions writes the dump and re-indexes inside the gate');
    }

    if (errors) {
        console.error(`\n${errors} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll index-input checks passed.');
}

main().catch(e => { console.error(e); process.exit(1); });
