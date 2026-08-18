/** @file _coverage.js @description Child-harness coverage reports consumed by test/run.js. */

const fs = require('fs');

/**
 * Reports whether a required gate actually ran. No environment variable means the harness was
 * launched directly, in which case reporting is deliberately a no-op.
 * @param {string} gate Stable gate name.
 * @param {'ran'|'skipped'} status Execution status.
 * @param {string} [detail] Explanation for a skip or partial run.
 */
function reportCoverage(gate, status, detail = '') {
    const target = process.env.TC_TEST_COVERAGE_FILE;
    if (!target) return;
    fs.writeFileSync(target, JSON.stringify({ gate, status, detail }), 'utf8');
}

module.exports = { reportCoverage };
