/**
 * @file test_diagnostic_markers.js
 * @description The decl/impl marker split (`media/diagnosticMarkers.js`) that
 * `updateDiagnostics` in `media/editor.js` runs on every `custom/diagnostics` response.
 *
 * Pins the mapping from LSP severity numbers to the caller's injected severity values, the
 * per-component filter, and the pane routing rule — including its one surprising case: any pane
 * value other than the literal string `'decl'` (missing, `'impl'`, or garbage) lands in the impl
 * bucket. That is today's behaviour in `editor.js`, preserved verbatim here rather than "fixed".
 */

const { splitDiagnostics } = require('../media/diagnosticMarkers');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const SEVERITIES = { error: 'SENTINEL_ERROR', warning: 'SENTINEL_WARNING', info: 'SENTINEL_INFO' };

function diag(overrides) {
    return Object.assign({
        componentId: 'root',
        pane: 'decl',
        severity: 1,
        message: 'msg',
        range: { startLineNumber: 1, startColumn: 2, endLineNumber: 3, endColumn: 4 }
    }, overrides);
}

function main() {
    // ---- Group 1: severity mapping ----
    {
        const result = splitDiagnostics([
            diag({ severity: 1, pane: 'decl' }),
            diag({ severity: 2, pane: 'decl' }),
            diag({ severity: 3, pane: 'decl' }),
            diag({ severity: 0, pane: 'decl' }),
            diag({ severity: undefined, pane: 'decl' })
        ], 'root', SEVERITIES);

        assert(result.decl.length === 5, `all five land in decl (got ${result.decl.length})`);
        assert(result.decl[0].severity === SEVERITIES.error, 'severity 1 -> injected error sentinel');
        assert(result.decl[1].severity === SEVERITIES.warning, 'severity 2 -> injected warning sentinel');
        assert(result.decl[2].severity === SEVERITIES.info, 'severity 3 -> injected info sentinel (else branch)');
        assert(result.decl[3].severity === SEVERITIES.info, 'severity 0 -> injected info sentinel (else branch)');
        assert(result.decl[4].severity === SEVERITIES.info, 'severity undefined -> injected info sentinel');
    }

    // ---- Group 2: componentId filter ----
    {
        const result = splitDiagnostics([
            diag({ componentId: 'root', pane: 'decl' }),
            diag({ componentId: 'MAIN.Method1', pane: 'decl' })
        ], 'root', SEVERITIES);
        assert(result.decl.length === 1, `other-component diagnostics dropped (got ${result.decl.length})`);
        assert(result.impl.length === 0, 'impl bucket untouched by the dropped diagnostic');
    }

    // ---- Group 3: pane routing ----
    {
        const result = splitDiagnostics([
            diag({ pane: 'decl' }),
            diag({ pane: 'impl' }),
            diag({ pane: undefined }),
            diag({ pane: 'something-else' })
        ], 'root', SEVERITIES);
        assert(result.decl.length === 1, `only pane 'decl' lands in decl (got ${result.decl.length})`);
        assert(result.impl.length === 3, `everything else (impl/missing/garbage) lands in impl (got ${result.impl.length})`);
    }

    // ---- Group 4: marker field shape, asserted key-for-key ----
    {
        const result = splitDiagnostics([
            diag({
                pane: 'decl',
                severity: 2,
                message: 'a warning',
                range: { startLineNumber: 5, startColumn: 6, endLineNumber: 7, endColumn: 8 }
            })
        ], 'root', SEVERITIES);
        const marker = result.decl[0];
        assert(Object.keys(marker).sort().join(',') === 'endColumn,endLineNumber,message,severity,startColumn,startLineNumber',
            `marker has exactly the expected keys (got ${Object.keys(marker).sort().join(',')})`);
        assert(marker.severity === SEVERITIES.warning, 'marker.severity from injected severities');
        assert(marker.message === 'a warning', 'marker.message copied from d.message');
        assert(marker.startLineNumber === 5, 'marker.startLineNumber copied from d.range.startLineNumber');
        assert(marker.startColumn === 6, 'marker.startColumn copied from d.range.startColumn');
        assert(marker.endLineNumber === 7, 'marker.endLineNumber copied from d.range.endLineNumber');
        assert(marker.endColumn === 8, 'marker.endColumn copied from d.range.endColumn');
    }

    // ---- Group 5: empty / null diags ----
    {
        const empty = splitDiagnostics([], 'root', SEVERITIES);
        assert(Array.isArray(empty.decl) && empty.decl.length === 0, 'empty array -> empty decl');
        assert(Array.isArray(empty.impl) && empty.impl.length === 0, 'empty array -> empty impl');

        const nullResult = splitDiagnostics(null, 'root', SEVERITIES);
        assert(nullResult.decl.length === 0 && nullResult.impl.length === 0, 'null diags -> both empty');

        const undefinedResult = splitDiagnostics(undefined, 'root', SEVERITIES);
        assert(undefinedResult.decl.length === 0 && undefinedResult.impl.length === 0, 'undefined diags -> both empty');
    }

    console.log(`\n${errors === 0 ? 'ALL PASSED' : `${errors} FAILURE(S)`}`);
    if (errors > 0) process.exitCode = 1;
}

main();
