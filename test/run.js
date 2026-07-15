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
 * Usage:  node test/run.js            (all suites)
 *         node test/run.js references (only suites whose name contains "references")
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const filter = process.argv[2];
const files = fs.readdirSync(dir)
    .filter(f => /^test_.*\.js$/.test(f))
    .filter(f => !filter || f.includes(filter))
    .sort();

if (files.length === 0) {
    console.error(filter ? `No suites match "${filter}".` : 'No test_*.js suites found.');
    process.exit(1);
}

const failed = [];
const started = Date.now();

for (const file of files) {
    process.stdout.write(`\n${'─'.repeat(70)}\n▶ ${file}\n${'─'.repeat(70)}\n`);
    const res = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
    if (res.status !== 0) failed.push(file);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${'═'.repeat(70)}`);
console.log(`Ran ${files.length} suite(s) in ${secs}s — ${files.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
    console.log('\nFAILED SUITES:');
    for (const f of failed) console.log(`  ✗ ${f}`);
    console.log('═'.repeat(70));
    process.exit(1);
}
console.log('✓ ALL SUITES PASSED');
console.log('═'.repeat(70));
