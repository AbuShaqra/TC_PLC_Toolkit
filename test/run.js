/**
 * @file run.js
 * @description Test runner for the TwinCAT PLC Toolkit suite. Discovers every `test_*.js` in this
 * directory and runs each in its OWN Node process, because the harnesses rely on module-global state
 * (the workspace symbol index) and call `process.exit(1)` on failure — so they must be isolated.
 *
 * Unlike the old `&&` chain in package.json, this runs ALL suites even when one fails, then prints a
 * summary and exits non-zero if any failed. Sample-based suites skip cleanly when `sample/` is absent
 * (e.g. on CI / a fresh clone), so the runner is green there too.
 *
 * **That green is weaker than it looks**, which is why this runner classifies the run. `sample/`,
 * `sample/**\/_Libraries` and the project `.tmc` are git-ignored, so on CI the diagnostics ratchet and
 * the live-path guard — the two gates this project leans on hardest — skip themselves and still report
 * "passed". The banner below states plainly whether the run was FULL or REDUCED and what was missing,
 * so "did the ratchet actually run?" is a question with an answer instead of an assumption.
 *
 * Usage:  node test/run.js            (all suites)
 *         node test/run.js references (only suites whose name contains "references")
 *
 * Env:    REQUIRE_FULL_SUITE=1        fail instead of running REDUCED — use before packaging a
 *                                     release, so a degraded run can never be mistaken for a clean one.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = __dirname;
const filter = process.argv[2];

/**
 * Detects the fixtures a full run needs. All three are deliberately git-ignored (customer/vendor
 * content and build artifacts), so their absence is normal on CI — it just has to be *visible*.
 * @returns {{full: boolean, missing: string[]}}
 */
function detectFixtures() {
    const sampleDir = path.join(dir, '..', 'sample');
    const missing = [];
    if (!fs.existsSync(sampleDir)) {
        // Without the sample there is nothing to look inside for the other two.
        return { full: false, missing: ['sample/ (the real TwinCAT project: diagnostics ratchet, live path)'] };
    }
    let hasLibraries = false;
    let hasTmc = false;
    const walk = (d, depth) => {
        if (depth > 4 || (hasLibraries && hasTmc)) return;
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (e.name === '_Libraries') { hasLibraries = true; continue; }
                walk(path.join(d, e.name), depth + 1);
            } else if (e.name.toLowerCase().endsWith('.tmc')) {
                hasTmc = true;
            }
        }
    };
    walk(sampleDir, 0);
    if (!hasLibraries) missing.push('sample/**/_Libraries (library archives: symbol resolution)');
    if (!hasTmc) missing.push('sample/**/*.tmc (type system: struct fields, enum values, FB methods)');
    return { full: missing.length === 0, missing };
}

const fixtures = detectFixtures();
const requireFull = process.env.REQUIRE_FULL_SUITE === '1';
const files = fs.readdirSync(dir)
    .filter(f => /^test_.*\.js$/.test(f))
    .filter(f => !filter || f.includes(filter))
    .sort();

if (files.length === 0) {
    console.error(filter ? `No suites match "${filter}".` : 'No test_*.js suites found.');
    process.exit(1);
}

const failed = [];
const reports = new Map();
const coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-coverage-'));
process.on('exit', () => {
    try { fs.rmSync(coverageDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});
const started = Date.now();

for (const file of files) {
    process.stdout.write(`\n${'─'.repeat(70)}\n▶ ${file}\n${'─'.repeat(70)}\n`);
    const reportPath = path.join(coverageDir, `${file}.json`);
    const res = spawnSync(process.execPath, [path.join(dir, file)], {
        stdio: 'inherit',
        env: { ...process.env, TC_TEST_COVERAGE_FILE: reportPath }
    });
    if (res.status !== 0) failed.push(file);
    if (fs.existsSync(reportPath)) {
        try {
            const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            if (report && report.gate) reports.set(report.gate, report);
        } catch (e) {
            reports.set(file, { gate: file, status: 'skipped', detail: 'invalid coverage report' });
        }
    }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${'═'.repeat(70)}`);
console.log(`Ran ${files.length} suite(s) in ${secs}s — ${files.length - failed.length} passed, ${failed.length} failed`);

const requiredGates = [
    'live-path-sample',
    'sample-diagnostics',
    'sample-typecheck',
    'multi-project-sample',
    'committed-library'
];
const missedGates = requiredGates
    .map(gate => reports.get(gate) || { gate, status: 'skipped', detail: 'harness did not report execution' })
    .filter(report => report.status !== 'ran');
const coverageFull = !filter && fixtures.full && missedGates.length === 0;

// State the coverage the run actually achieved. Fixture presence is only a preflight hint; FULL
// requires the harnesses themselves to report that every load-bearing gate ran.
if (filter) {
    console.log(`Coverage: FILTERED — only suites matching "${filter}" ran.`);
} else if (coverageFull) {
    console.log('Coverage: FULL — sample project, library archives and .tmc all present.');
} else {
    console.log('Coverage: REDUCED — these gates did NOT run:');
    for (const m of fixtures.missing) console.log(`    · ${m}`);
    for (const report of missedGates) console.log(`    · ${report.gate}: ${report.detail || 'skipped'}`);
    console.log('  Passing here does not prove the diagnostics ratchet held. Run locally with the');
    console.log('  fixtures present (REQUIRE_FULL_SUITE=1 enforces it) before trusting it as a gate.');
}

if (failed.length || (requireFull && !coverageFull)) {
    console.log('\nFAILED SUITES:');
    for (const f of failed) console.log(`  ✗ ${f}`);
    if (requireFull && !coverageFull) console.log('  ✗ required FULL coverage was not achieved');
    console.log('═'.repeat(70));
    process.exit(1);
}
console.log(coverageFull ? '✓ ALL SUITES PASSED (full coverage)' : '✓ ALL SUITES PASSED (reduced coverage)');
console.log('═'.repeat(70));
