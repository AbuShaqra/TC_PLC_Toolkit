/**
 * @file test_peek_uri.js
 * @description The synthetic peek/goto URI vocabulary (`media/peekUri.js`) that lets the webview
 * route Monaco navigation across panes, components and files with no live model — pulled out of
 * `media/editor.js`'s `encodePeekUri` / `openPeekTarget` / `encodeGotoUri` / `decodeGotoUri`.
 *
 * `parseQuery` is exercised directly first, since every encode/decode function is built on it; the
 * rest is exercised through full round-trips against fixed fixtures so a drifted default or a
 * swapped 0/1-index shows up as an exact mismatch, not a vague "looks wrong".
 */

const {
    PEEK_SCHEME,
    GOTO_SCHEME,
    parseQuery,
    encodePeekParts,
    encodeGotoParts,
    decodeGotoTarget,
    peekOpenMessage
} = require('../media/peekUri');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
    // ---- Scheme constants ----
    assert(PEEK_SCHEME === 'twincat-peek', `PEEK_SCHEME is 'twincat-peek' (got ${PEEK_SCHEME})`);
    assert(GOTO_SCHEME === 'twincat', `GOTO_SCHEME is 'twincat' (got ${GOTO_SCHEME})`);

    // ---- parseQuery ----
    {
        assert(deepEqual(parseQuery(''), {}), 'parseQuery("") -> {}');
        assert(deepEqual(parseQuery(null), {}), 'parseQuery(null) -> {}');
        assert(deepEqual(parseQuery(undefined), {}), 'parseQuery(undefined) -> {}');

        const q = parseQuery('file=file%3A%2F%2F%2Fa.TcPOU&component=MAIN&empty&word=hello%20world');
        assert(q.file === 'file:///a.TcPOU', `parseQuery decodes %-encoded values (got ${q.file})`);
        assert(q.component === 'MAIN', 'parseQuery plain value');
        assert(q.empty === '', `parseQuery valueless key -> '' (got ${JSON.stringify(q.empty)})`);
        assert(q.word === 'hello world', 'parseQuery decodes spaces');

        // Round-trip: encode a set of key/value pairs the way this module's encoders do, decode back.
        const encoded = ['a=' + encodeURIComponent('x/y&z'), 'b=' + encodeURIComponent('')].join('&');
        const decoded = parseQuery(encoded);
        assert(decoded.a === 'x/y&z' && decoded.b === '', `parseQuery round-trips an encoded query (got ${JSON.stringify(decoded)})`);
    }

    // ---- encodePeekParts ----
    {
        const parts = encodePeekParts({ uri: 'file:///a.TcPOU', componentId: 'MAIN.Method1', pane: 'decl', path: '/custom/path' });
        assert(parts.scheme === PEEK_SCHEME, 'encodePeekParts scheme is PEEK_SCHEME');
        assert(parts.path === '/custom/path', `encodePeekParts keeps pane.path when given (got ${parts.path})`);
        const q = parseQuery(parts.query);
        assert(q.file === 'file:///a.TcPOU' && q.component === 'MAIN.Method1' && q.pane === 'decl',
            `encodePeekParts query round-trips (got ${JSON.stringify(q)})`);
        // Byte-for-byte: pins key order (file, component, pane) and %-encoding, not just the
        // decoded values parseQuery hands back above.
        assert(parts.query === 'file=file%3A%2F%2F%2Fa.TcPOU&component=MAIN.Method1&pane=decl',
            `encodePeekParts joined query is byte-identical (got ${parts.query})`);

        // Defaults
        const defaults = encodePeekParts({});
        assert(defaults.path === '/reference', `encodePeekParts defaults path to '/reference' (got ${defaults.path})`);
        const dq = parseQuery(defaults.query);
        assert(dq.file === '', 'encodePeekParts defaults file to empty string');
        assert(dq.component === 'root', `encodePeekParts defaults component to 'root' (got ${dq.component})`);
        assert(dq.pane === 'impl', `encodePeekParts defaults pane to 'impl' (got ${dq.pane})`);
    }

    // ---- encodeGotoParts ----
    {
        // With a full range and pane/localLine.
        const def = {
            uri: 'file:///b.TcPOU',
            componentId: 'MAIN.Method1',
            range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
            pane: 'impl',
            localLine: 12
        };
        const parts = encodeGotoParts(def, 'MyVar', 'file:///active.TcPOU');
        assert(parts.scheme === GOTO_SCHEME, 'encodeGotoParts scheme is GOTO_SCHEME');
        assert(parts.path === '/goto', `encodeGotoParts path is '/goto' (got ${parts.path})`);
        const q = parseQuery(parts.query);
        assert(q.file === 'file:///b.TcPOU', 'encodeGotoParts uses def.uri when present');
        assert(q.component === 'MAIN.Method1', 'encodeGotoParts carries componentId');
        assert(q.word === 'MyVar', 'encodeGotoParts carries targetWord');
        assert(q.sl === '4' && q.sc === '2' && q.el === '4' && q.ec === '9', `encodeGotoParts carries range sl/sc/el/ec (got ${JSON.stringify(q)})`);
        assert(q.pane === 'impl' && q.ll === '12', `encodeGotoParts carries pane/ll (got pane=${q.pane}, ll=${q.ll})`);
        // Byte-for-byte: pins key order (file, component, word, sl, sc, el, ec, pane, ll) and
        // %-encoding for the full fixture (range + pane + ll all present), not just the decoded
        // values parseQuery hands back above.
        assert(parts.query === 'file=file%3A%2F%2F%2Fb.TcPOU&component=MAIN.Method1&word=MyVar&sl=4&sc=2&el=4&ec=9&pane=impl&ll=12',
            `encodeGotoParts joined query is byte-identical (got ${parts.query})`);

        // Without def.uri -> falls back to activeFileUri.
        const noUri = encodeGotoParts({ componentId: 'root' }, 'Word', 'file:///active.TcPOU');
        const noUriQ = parseQuery(noUri.query);
        assert(noUriQ.file === 'file:///active.TcPOU', `encodeGotoParts falls back to activeFileUri (got ${noUriQ.file})`);

        // Without range -> no sl/sc/el/ec keys at all.
        const noRange = encodeGotoParts({ componentId: 'root' }, 'Word', 'file:///active.TcPOU');
        const noRangeQ = parseQuery(noRange.query);
        assert(noRangeQ.sl === undefined && noRangeQ.sc === undefined && noRangeQ.el === undefined && noRangeQ.ec === undefined,
            'encodeGotoParts omits sl/sc/el/ec entirely when def.range is absent');

        // Without pane/localLine -> no pane/ll keys at all.
        const noPane = encodeGotoParts({ componentId: 'root', range: def.range }, 'Word', 'file:///active.TcPOU');
        const noPaneQ = parseQuery(noPane.query);
        assert(noPaneQ.pane === undefined && noPaneQ.ll === undefined,
            'encodeGotoParts omits pane/ll entirely when def.pane/localLine are absent');

        // localLine === 0 must still be included (`!= null` check, not truthiness).
        const zeroLine = encodeGotoParts({ componentId: 'root', pane: 'decl', localLine: 0 }, 'Word', 'file:///active.TcPOU');
        const zeroLineQ = parseQuery(zeroLine.query);
        assert(zeroLineQ.ll === '0', `encodeGotoParts keeps localLine 0 (got ${JSON.stringify(zeroLineQ.ll)})`);
    }

    // ---- decodeGotoTarget inverts encodeGotoParts ----
    {
        const def = {
            uri: 'file:///b.TcPOU',
            componentId: 'MAIN.Method1',
            range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
            pane: 'impl',
            localLine: 12
        };
        const parts = encodeGotoParts(def, 'MyVar', 'file:///active.TcPOU');
        const target = decodeGotoTarget(parts.query);
        assert(deepEqual(target, {
            fileUri: 'file:///b.TcPOU',
            componentId: 'MAIN.Method1',
            targetWord: 'MyVar',
            pane: 'impl',
            localLine: 12,
            range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } }
        }), `decodeGotoTarget inverts encodeGotoParts exactly (got ${JSON.stringify(target)})`);

        // Range/pane absent -> nulls.
        const bare = encodeGotoParts({ componentId: 'root' }, 'Word', 'file:///active.TcPOU');
        const bareTarget = decodeGotoTarget(bare.query);
        assert(bareTarget.range === null, 'decodeGotoTarget yields range: null when absent');
        assert(bareTarget.pane === null, 'decodeGotoTarget yields pane: null when absent');
        assert(bareTarget.localLine === null, 'decodeGotoTarget yields localLine: null when absent');
        assert(bareTarget.fileUri === 'file:///active.TcPOU', 'decodeGotoTarget round-trips the fallback file uri');

        // Empty query -> full defaults.
        const empty = decodeGotoTarget('');
        assert(deepEqual(empty, {
            fileUri: '', componentId: 'root', targetWord: '', pane: null, localLine: null, range: null
        }), `decodeGotoTarget('') -> full defaults (got ${JSON.stringify(empty)})`);
    }

    // ---- peekOpenMessage ----
    {
        const queryString = 'file=' + encodeURIComponent('file:///a.TcPOU') + '&component=MAIN&pane=decl';

        // Real range.
        const withRange = peekOpenMessage(queryString, {
            startLineNumber: 6, startColumn: 3, endLineNumber: 6, endColumn: 9
        }, 'MyVar', 'file:///active.TcPOU');
        assert(deepEqual(withRange, {
            type: 'openFile',
            fileUri: 'file:///a.TcPOU',
            componentId: 'MAIN',
            range: {
                pane: 'decl',
                localLine: 5,
                start: { line: 5, character: 2 },
                end: { line: 5, character: 8 }
            },
            targetWord: 'MyVar'
        }), `peekOpenMessage with a real range (got ${JSON.stringify(withRange)})`);

        // Null range -> word-length fallback, defaults to line 0/col 0.
        const nullRange = peekOpenMessage('', null, 'MyVar', 'file:///active.TcPOU');
        assert(deepEqual(nullRange, {
            type: 'openFile',
            fileUri: 'file:///active.TcPOU',
            componentId: 'root',
            range: {
                pane: null,
                localLine: 0,
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 }
            },
            targetWord: 'MyVar'
        }), `peekOpenMessage with null range falls back to word length (got ${JSON.stringify(nullRange)})`);

        // Zero-length range -> same word-length fallback.
        const zeroRange = peekOpenMessage('', {
            startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 4
        }, 'Foo', 'file:///active.TcPOU');
        assert(deepEqual(zeroRange, {
            type: 'openFile',
            fileUri: 'file:///active.TcPOU',
            componentId: 'root',
            range: {
                pane: null,
                localLine: 2,
                start: { line: 2, character: 3 },
                end: { line: 2, character: 6 }
            },
            targetWord: 'Foo'
        }), `peekOpenMessage with a zero-length range falls back to word length (got ${JSON.stringify(zeroRange)})`);
    }

    console.log(`\n${errors === 0 ? 'ALL PASSED' : `${errors} FAILURE(S)`}`);
    if (errors > 0) process.exitCode = 1;
}

main();
