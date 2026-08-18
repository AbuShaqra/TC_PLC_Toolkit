/**
 * @file test_libsymbols.js
 * @description Harness for src/lsp/libsymbols.js — the external-library symbol harvester.
 *
 * Two layers:
 *   1. Unit level (always runs): a ZIP archive is BUILT in memory with zlib.deflateRaw, holding a
 *      synthetic CODESYS string table, then read back. This exercises the whole path — central
 *      directory, stored + deflate entries, LEB128 string table, identifier filter, registry — with
 *      no dependency on any vendor file.
 *   2. Sample level: assert that the real archives under sample/**\/_Libraries decode and yield the
 *      specific symbols they declare. One archive there is COMMITTED — TwinCAT Dynamic Collections is
 *      MIT-licensed — so this layer runs on CI and on a fresh clone. The three Beckhoff archives
 *      beside it are licensed vendor binaries and git-ignored, so anything keyed to them is gated on
 *      their presence and skipped with a message.
 *
 * Also guards the types.js contract this feature depends on: an `external` node resolves to the
 * `unknown` type, which is what keeps member access on a library type from being flagged.
 *
 * Usage: node scratch/test_libsymbols.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { reportCoverage } = require('./_coverage');

const {
    readZipEntries,
    readZipEntryData,
    parseStringTable,
    harvestArchive,
    indexLibrarySymbols,
    isLibrarySymbol,
    getLibrarySymbols,
    getLibrarySymbolName,
    clearLibrarySymbols,
    registerLibrarySymbolNodes
} = require('../src/lsp/libsymbols');

const { typeFromNode, resolveSymbolType, lookupMember } = require('../src/lsp/types');
const {
    SAMPLE_DIR,
    MIT_SYMBOL_COUNT,
    sampleArchiveFixtures,
    skipBeckhoff
} = require('./_baseline');

let passed = 0;
function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------------------------------------
// Fixtures: build a ZIP archive, and a CODESYS string table, from scratch.
// ---------------------------------------------------------------------------------------------

/** Encodes an unsigned integer as LEB128, the way the CODESYS string table does. */
function varint(value) {
    const bytes = [];
    let v = value;
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v > 0) b |= 0x80;
        bytes.push(b);
    } while (v > 0);
    return Buffer.from(bytes);
}

/** Builds a string table: [count][ (id)(byteLength)(UTF-8) ]*. */
function buildStringTable(strings) {
    const parts = [varint(strings.length)];
    strings.forEach((s, i) => {
        const body = Buffer.from(s, 'utf8');
        parts.push(varint(i), varint(body.length), body);
    });
    return Buffer.concat(parts);
}

/**
 * Builds a ZIP archive from { name, data, store } entries.
 * @param {Array<{name: string, data: Buffer, store?: boolean}>} files
 * @returns {Buffer}
 */
function buildZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const f of files) {
        const nameBuf = Buffer.from(f.name, 'utf8');
        const body = f.store ? f.data : zlib.deflateRawSync(f.data);
        const method = f.store ? 0 : 8;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);              // version needed
        local.writeUInt16LE(0, 6);               // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(0, 14);              // crc32 (not validated by the reader)
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(f.data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);              // extra length
        locals.push(local, nameBuf, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(0, 16);            // crc32
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(f.data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);

        offset += 30 + nameBuf.length + body.length;
    }

    const localBuf = Buffer.concat(locals);
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    return Buffer.concat([localBuf, centralBuf, eocd]);
}

// The strings a real string table mixes together: object names, member names, GUIDs, doc comments.
const TABLE_STRINGS = [
    '6470a90f-b7cb-43ac-9ae5-94b2338b4573',   // GUID — must not be harvested
    'Project Settings',                        // has a space — must not be harvested
    'DEFAULT_ADS_TIMEOUT',
    'T_MaxString',
    'FB_FormatString',
    'TIMESTRUCT',
    ' Copies characters/bytes between buffers. ', // doc comment — must not be harvested
    'MEMCPY',
    'System.Guid',                              // dotted — must not be harvested
    '3.5.1.0'                                   // version — must not be harvested
];
const HARVESTABLE = ['DEFAULT_ADS_TIMEOUT', 'T_MaxString', 'FB_FormatString', 'TIMESTRUCT', 'MEMCPY'];

const ARCHIVE = buildZip([
    { name: '6470a90f-b7cb-43ac-9ae5-94b2338b4573.meta', data: Buffer.from([0x02, 0x20, 0x09]) },
    { name: '6470a90f-b7cb-43ac-9ae5-94b2338b4573.object', data: Buffer.from('binary object graph') },
    { name: '__shared_data_storage_string_table__.auxiliary', data: buildStringTable(TABLE_STRINGS) },
    { name: 'stored_entry.auxiliary', data: Buffer.from('uncompressed'), store: true }
]);

// ---------------------------------------------------------------------------------------------
// 1. ZIP reader
// ---------------------------------------------------------------------------------------------
console.log('\n=== ZIP reader ===');

check('reads the central directory', () => {
    const entries = readZipEntries(ARCHIVE);
    assert.strictEqual(entries.length, 4);
    assert.deepStrictEqual(entries.map(e => e.name), [
        '6470a90f-b7cb-43ac-9ae5-94b2338b4573.meta',
        '6470a90f-b7cb-43ac-9ae5-94b2338b4573.object',
        '__shared_data_storage_string_table__.auxiliary',
        'stored_entry.auxiliary'
    ]);
});

check('inflates a deflate entry', () => {
    const entries = readZipEntries(ARCHIVE);
    const obj = entries.find(e => e.name.endsWith('.object'));
    assert.strictEqual(readZipEntryData(ARCHIVE, obj).toString(), 'binary object graph');
});

check('reads a stored (method 0) entry', () => {
    const entries = readZipEntries(ARCHIVE);
    const stored = entries.find(e => e.name === 'stored_entry.auxiliary');
    assert.strictEqual(stored.method, 0);
    assert.strictEqual(readZipEntryData(ARCHIVE, stored).toString(), 'uncompressed');
});

check('rejects a non-ZIP buffer instead of inventing entries', () => {
    assert.throws(() => readZipEntries(Buffer.from('not a zip file at all, no EOCD here')), /ZIP/i);
});

check('rejects a deflate entry whose declared output exceeds the resource limit', () => {
    const oversized = buildZip([{
        name: '__shared_data_storage_string_table__.auxiliary',
        data: Buffer.alloc(17 * 1024 * 1024)
    }]);
    const entry = readZipEntries(oversized)[0];
    assert(oversized.length < 32 * 1024, 'the adversarial fixture remains a small compressed input');
    assert.throws(() => readZipEntryData(oversized, entry), /output limit/i);
});

check('the inflate output cap cannot be bypassed by a dishonest declared size', () => {
    const oversized = buildZip([{
        name: '__shared_data_storage_string_table__.auxiliary',
        data: Buffer.alloc(17 * 1024 * 1024)
    }]);
    const entry = readZipEntries(oversized)[0];
    entry.uncompressedSize = 1;
    assert.throws(() => readZipEntryData(oversized, entry), /larger than|output length|size mismatch/i);
});

check('rejects an entry whose compressed range runs beyond the archive', () => {
    const entry = readZipEntries(ARCHIVE)[0];
    entry.compressedSize = ARCHIVE.length;
    assert.throws(() => readZipEntryData(ARCHIVE, entry), /truncated data/i);
});

// ---------------------------------------------------------------------------------------------
// 2. String table
// ---------------------------------------------------------------------------------------------
console.log('\n=== string table (LEB128) ===');

check('decodes every string, in order', () => {
    const table = buildStringTable(TABLE_STRINGS);
    assert.deepStrictEqual(parseStringTable(table), TABLE_STRINGS);
});

check('decodes multi-byte varints (>127 entries, >127-byte strings)', () => {
    const many = [];
    for (let i = 0; i < 300; i++) many.push('Sym_' + i);
    many.push('X'.repeat(500)); // length needs two varint bytes
    const out = parseStringTable(buildStringTable(many));
    assert.strictEqual(out.length, 301);
    assert.strictEqual(out[299], 'Sym_299');
    assert.strictEqual(out[300].length, 500);
});

check('throws on a truncated table rather than returning junk', () => {
    const table = buildStringTable(TABLE_STRINGS);
    assert.throws(() => parseStringTable(table.subarray(0, table.length - 5)), /overrun|end of string table/i);
});

// ---------------------------------------------------------------------------------------------
// 3. Harvest filter
// ---------------------------------------------------------------------------------------------
console.log('\n=== harvest ===');

check('keeps identifier-shaped names only (no GUIDs, comments, dotted or version strings)', () => {
    const names = harvestArchive(ARCHIVE);
    assert.deepStrictEqual(names.sort(), HARVESTABLE.slice().sort());
});

// ---------------------------------------------------------------------------------------------
// 4. Registry (indexed from a temp folder holding the synthetic archive)
// ---------------------------------------------------------------------------------------------
console.log('\n=== registry ===');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml-libsym-'));
const libDir = path.join(tmpRoot, '_Libraries', 'Beckhoff Automation GmbH');
fs.mkdirSync(libDir, { recursive: true });
fs.writeFileSync(path.join(libDir, 'synthetic.compiled-library'), ARCHIVE);

try {
    clearLibrarySymbols();

    check('indexes archives found under the workspace folder', () => {
        const stats = indexLibrarySymbols(tmpRoot);
        assert.strictEqual(stats.archives, 1);
        assert.strictEqual(stats.failed, 0);
        assert.strictEqual(stats.symbols, HARVESTABLE.length);
    });

    check('isLibrarySymbol is case-insensitive (Structured Text is)', () => {
        assert.ok(isLibrarySymbol('DEFAULT_ADS_TIMEOUT'));
        assert.ok(isLibrarySymbol('default_ads_timeout'));
        assert.ok(isLibrarySymbol('t_maxstring'));
        assert.ok(!isLibrarySymbol('FB_NotInAnyLibrary'));
        assert.ok(!isLibrarySymbol(''));
        assert.ok(!isLibrarySymbol(null));
    });

    check('getLibrarySymbols returns the original spelling', () => {
        assert.ok(getLibrarySymbols().includes('T_MaxString'));
        assert.strictEqual(getLibrarySymbolName('t_maxstring'), 'T_MaxString');
        assert.strictEqual(getLibrarySymbolName('FB_Nonexistent'), undefined);
    });

    check('re-indexing the same folder does not duplicate symbols', () => {
        const stats = indexLibrarySymbols(tmpRoot);
        assert.strictEqual(stats.symbols, HARVESTABLE.length);
    });

    // -----------------------------------------------------------------------------------------
    // Registration into a symbol index — the mechanism the undeclared check actually consumes.
    // -----------------------------------------------------------------------------------------
    console.log('\n=== symbol-index registration ===');

    check('registers only the library symbols the document references', () => {
        const index = {};
        const code = 'nTimeout : UDINT := DEFAULT_ADS_TIMEOUT;\nsMsg : T_MaxString;\n';
        const added = registerLibrarySymbolNodes(index, code);
        assert.strictEqual(added, 2);
        assert.deepStrictEqual(Object.keys(index).sort(), ['DEFAULT_ADS_TIMEOUT', 'T_MaxString']);
        // Unreferenced library symbols stay out: the index must not balloon to library scale, or
        // every Object.keys() scan in features.js (findActiveScope runs per identifier token) slows
        // down by two orders of magnitude.
        assert.ok(!index.MEMCPY);
    });

    check('PERF GUARD: the index scales with the DOCUMENT, never the registry (the 78s cliff)', () => {
        // Registering the whole registry up front once took the diagnostics pass from 1.5s to 78s,
        // because Object.keys(index) is walked per identifier token. Registration MUST stay lazy:
        // only the symbols a document actually names may enter the index. If a future change makes it
        // eager (e.g. registering all symbols at index time), this assertion fails loudly.
        const index = {};
        const before = Object.keys(index).length;
        registerLibrarySymbolNodes(index, 'x := DEFAULT_ADS_TIMEOUT;'); // names 1 of the 5 harvestable
        const added = Object.keys(index).length - before;
        assert.strictEqual(added, 1, 'exactly the one referenced symbol should be registered');
        assert.ok(Object.keys(index).length < HARVESTABLE.length,
            `index (${Object.keys(index).length}) must stay below registry scale (${HARVESTABLE.length})`);
    });

    check('matches the document case-insensitively but registers the library spelling', () => {
        const index = {};
        registerLibrarySymbolNodes(index, 'x := t_MAXstring;');
        assert.ok(index.T_MaxString, 'expected the library spelling as the index key');
    });

    check('never shadows a project symbol of the same name (any casing)', () => {
        const project = { name: 'T_MAXSTRING', type: 'DUT', uri: 'file:///p.TcDUT', variables: [] };
        const index = { T_MAXSTRING: project };
        const added = registerLibrarySymbolNodes(index, 'sMsg : T_MaxString;');
        assert.strictEqual(added, 0);
        assert.strictEqual(Object.keys(index).length, 1);
        assert.strictEqual(index.T_MAXSTRING, project);
    });

    check('registered nodes are external, so member access on them is never flagged', () => {
        const index = {};
        registerLibrarySymbolNodes(index, 'fb : FB_FormatString;');
        const node = index.FB_FormatString;
        assert.strictEqual(node.external, true);
        assert.strictEqual(node.uri, '');            // falsy: provideReferences skips it
        assert.deepStrictEqual(node.variables, []);

        // The whole point: an empty variable list must NOT read as "this type has no such member".
        const type = resolveSymbolType('FB_FormatString', null, index);
        assert.strictEqual(type.kind, 'unknown');
        // undefined = "can't tell, stay silent"; null would mean "definitely absent" -> diagnostic.
        assert.strictEqual(lookupMember(type, 'sOut', index), undefined);
    });

    check('registration is idempotent', () => {
        const index = {};
        const code = 'x := DEFAULT_ADS_TIMEOUT;';
        assert.strictEqual(registerLibrarySymbolNodes(index, code), 1);
        assert.strictEqual(registerLibrarySymbolNodes(index, code), 0);
        assert.strictEqual(Object.keys(index).length, 1);
    });

    check('registration is a no-op without an index, code, or registry', () => {
        assert.strictEqual(registerLibrarySymbolNodes({}, ''), 0);
        assert.strictEqual(registerLibrarySymbolNodes(null, 'DEFAULT_ADS_TIMEOUT'), 0);
    });

    console.log('\n=== registry (cont.) ===');

    check('clearLibrarySymbols empties the registry', () => {
        clearLibrarySymbols();
        assert.strictEqual(getLibrarySymbols().length, 0);
        assert.ok(!isLibrarySymbol('T_MaxString'));
        const index = {};
        assert.strictEqual(registerLibrarySymbolNodes(index, 'x := T_MaxString;'), 0);
    });

    check('a missing folder is a no-op, not a throw', () => {
        const stats = indexLibrarySymbols(path.join(tmpRoot, 'does-not-exist'));
        assert.strictEqual(stats.archives, 0);
        assert.strictEqual(stats.symbols, 0);
    });

    check('an undecodable archive is skipped, not fatal', () => {
        const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tcxml-libsym-bad-'));
        fs.writeFileSync(path.join(badRoot, 'corrupt.compiled-library'), Buffer.from('this is not a zip'));
        const stats = indexLibrarySymbols(badRoot);
        assert.strictEqual(stats.failed, 1);
        assert.strictEqual(stats.archives, 0);
        fs.rmSync(badRoot, { recursive: true, force: true });
    });
} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    clearLibrarySymbols();
}

// ---------------------------------------------------------------------------------------------
// 5. The types.js contract that keeps member access silent
// ---------------------------------------------------------------------------------------------
console.log('\n=== external nodes resolve to `unknown` ===');

check('typeFromNode maps an external node to the anonymous unknown type', () => {
    // Even shaped like an FB with no members, an external node must never become a member-checkable
    // type — otherwise `libInst.Member` would be flagged "is not a member of type".
    const node = { name: 'FB_FormatString', type: 'FUNCTION_BLOCK', external: true, variables: [] };
    assert.strictEqual(typeFromNode(node).kind, 'unknown');
    // The empty name matters: checkDeclarationTypes reports an unknown leaf type unless its name is
    // empty/builtin/qualified, so a *named* unknown would newly flag `x : Lib.T_MaxString;`.
    assert.strictEqual(typeFromNode(node).name, '');
});

check('a normal node is unaffected', () => {
    const node = { name: 'FB_Real', type: 'FUNCTION_BLOCK', variables: [] };
    assert.strictEqual(typeFromNode(node).kind, 'fb');
});

// ---------------------------------------------------------------------------------------------
// 6. Real archives on disk
//
// The committed MIT archive makes this section run everywhere; the git-ignored Beckhoff archives
// add three more libraries on a developer machine. Assertions are split along that line.
// ---------------------------------------------------------------------------------------------
console.log('\n=== real library archives ===');

const fixtures = sampleArchiveFixtures(SAMPLE_DIR);

if (!fixtures.librariesDir) {
    console.log('  skip  sample/**/_Libraries not present — nothing to check.');
    reportCoverage('committed-library', 'skipped', 'sample/**/_Libraries not present');
} else {
    clearLibrarySymbols();
    const stats = indexLibrarySymbols(SAMPLE_DIR);
    console.log(`  indexed ${stats.archives} archive(s), ${stats.failed} undecodable, ` +
                `${stats.symbols} symbols in ${stats.ms} ms`);

    check('every archive decodes', () => {
        assert.ok(stats.archives > 0, 'expected at least one library archive');
        assert.strictEqual(stats.failed, 0, `${stats.failed} archive(s) failed to decode`);
    });

    if (!fixtures.hasMit) {
        console.log('  skip  the committed MIT archive is missing from this working copy — ' +
                    'restore sample/**/_Libraries/fisothemes/.');
        reportCoverage('committed-library', 'skipped', 'committed MIT archive missing');
    } else {
        reportCoverage('committed-library', 'ran', 'committed MIT archive decoded');
        check('the committed MIT archive harvests to exactly its known symbol set', () => {
            // A byte-fixed input: tcdyncollections.library v1.0.7 is committed, so an exact count is a
            // real ratchet on the ZIP reader and the LEB128 string-table decoder — a silently dropped
            // string-table region moves this number. Measured 2026-07-20 via harvestArchive().
            const names = harvestArchive(fs.readFileSync(fixtures.mitArchive));
            assert.strictEqual(names.length, MIT_SYMBOL_COUNT,
                `expected ${MIT_SYMBOL_COUNT} names from ${path.basename(fixtures.mitArchive)}`);
            // And nothing non-identifier-shaped slipped through on real vendor data, which mixes in
            // GUIDs, doc comments and version strings exactly as the synthetic table above does.
            const junk = names.filter(n => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
            assert.deepStrictEqual(junk, [], `non-identifier names harvested: ${junk.join(', ')}`);
        });

        check('the symbols TwinCAT Dynamic Collections declares are harvested', () => {
            // Discovered by running harvestArchive() over the committed archive and reading the names
            // back (2026-07-20) — not guessed. Deliberately spread across symbol shapes, so a decoder
            // that drops one string-table region shows up here rather than as a vague count change:
            //   FB          : FB_Array_List, FB_Hash_Map, FB_Queue, FB_Tree_Set
            //   interface   : I_Collection, I_Enumerator, I_List
            //   struct      : ST_MAP_ENTRY, ST_AVL_NODE
            //   enum        : E_COMPARISON, E_ERROR_CODE
            //   function    : F_Murmur3_Hash, F_Compare_Any
            //   alias       : T_Generic, T_Capacity
            //   GVL/global  : GVL_Constants, Global_Version
            const wanted = [
                'FB_Array_List', 'FB_Hash_Map', 'FB_Queue', 'FB_Tree_Set',
                'I_Collection', 'I_Enumerator', 'I_List',
                'ST_MAP_ENTRY', 'ST_AVL_NODE',
                'E_COMPARISON', 'E_ERROR_CODE',
                'F_Murmur3_Hash', 'F_Compare_Any',
                'T_Generic', 'T_Capacity',
                'GVL_Constants', 'Global_Version'
            ];
            const missing = wanted.filter(w => !isLibrarySymbol(w));
            assert.deepStrictEqual(missing, [], `not harvested: ${missing.join(', ')}`);
            // The over-harvest guard: a decoder that returned every string it saw would pass the list
            // above and still be broken.
            assert.ok(!isLibrarySymbol('FB_NotInAnyLibrary'), 'a name in no archive must not be harvested');
        });
    }

    // BONUS COVERAGE (developer machine only). The Beckhoff archives are `.compiled-library-ge33`
    // containers, a different extension and a different vendor's writer from the MIT `.library` above
    // — dropping `-ge33` support once stranded four libraries (see HANDOFF.md), so this list is worth
    // keeping even though CI cannot run it. Names discovered the same way, by reading the registry
    // back (2026-07-20), spread across all three libraries and across symbol shapes:
    //   Tc2_Standard : TON, TOF, CTUD, RS, CONCAT
    //   Tc2_System   : DEFAULT_ADS_TIMEOUT, T_MaxString, ST_AmsAddr, E_AdsErr, GETSYSTEMTIME,
    //                  FB_FileOpen, F_CreateAmsNetId
    //   Tc3_Module   : MEMCPY, FW_SafeRelease, TcBaseModule
    if (!fixtures.hasBeckhoff) {
        skipBeckhoff('the Beckhoff .compiled-library-ge33 symbol set');
    } else {
        check('the symbols the Beckhoff archives declare are harvested', () => {
            const wanted = [
                'TON', 'TOF', 'CTUD', 'RS', 'CONCAT',
                'DEFAULT_ADS_TIMEOUT', 'T_MaxString', 'ST_AmsAddr', 'E_AdsErr', 'GETSYSTEMTIME',
                'FB_FileOpen', 'F_CreateAmsNetId',
                'MEMCPY', 'FW_SafeRelease', 'TcBaseModule'
            ];
            const missing = wanted.filter(w => !isLibrarySymbol(w));
            assert.deepStrictEqual(missing, [], `not harvested: ${missing.join(', ')}`);
        });
    }

    check('indexing stays fast enough to run at startup', () => {
        assert.ok(stats.ms < 5000, `library indexing took ${stats.ms} ms`);
    });

    clearLibrarySymbols();
}

console.log(`\nAll ${passed} checks passed.`);
