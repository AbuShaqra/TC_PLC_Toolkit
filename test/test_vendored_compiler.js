/**
 * @file test_vendored_compiler.js
 * @description The compiler that ships with the extension (`resources/compiler/`, written by
 * scripts/vendor-compiler.js): it is all there, it is exactly what SOURCE.md records (the
 * corresponding-source link of the GPL-3.0 compiler names a full commit), its licence files and
 * third-party notices are present and ship, and the bundle needs no npm package at run time.
 * The REAL run of it is test/test_compile_real.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bundledCompilerPath } = require('../src/compileCheck');

const REPO = path.join(__dirname, '..');
const DIR = path.join(REPO, 'resources', 'compiler');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const rel = (p) => path.relative(DIR, p).split(path.sep).join('/');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

assert(bundledCompilerPath() === path.join(DIR, 'compiler.cjs'), 'the default compiler path is resources/compiler/compiler.cjs');

const source = fs.readFileSync(path.join(DIR, 'SOURCE.md'), 'utf8');
const commit = (/^- Commit: `([0-9a-f]+)`$/m.exec(source) || [])[1] || '';
assert(/^[0-9a-f]{40}$/.test(commit), `SOURCE.md names the full commit the compiler was built from (${commit})`);
assert(source.includes(`/tree/${commit}`) && /^- Repository: https:\/\/github\.com\/\S+$/m.test(source),
    'SOURCE.md links the public source repository at that commit');

// Every file is listed with its size and SHA-256, and the directory holds nothing else.
const rows = [...source.matchAll(/^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \|$/gm)].map(m => ({ file: m[1], size: Number(m[2]), sha: m[3] }));
const expected = ['compiler.cjs', 'libs/iec-standard-fb.stlib', 'libs/iec-std-functions.stlib', 'LICENSE', 'COPYING', 'COPYING.RUNTIME',
    'third-party/chevrotain-LICENSE.txt', 'third-party/lodash-es-LICENSE.txt'];
assert(JSON.stringify(rows.map(r => r.file).sort()) === JSON.stringify(expected.slice().sort()), `SOURCE.md lists exactly the vendored files (${rows.map(r => r.file).join(', ')})`);
for (const r of rows) {
    const file = path.join(DIR, r.file);
    const ok = fs.existsSync(file) && fs.statSync(file).size === r.size &&
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === r.sha;
    assert(ok, `${r.file} is the file SOURCE.md records (size and SHA-256)`);
}
const onDisk = walk(DIR).map(rel).sort();
assert(JSON.stringify(onDisk) === JSON.stringify([...expected, 'SOURCE.md'].sort()), `resources/compiler/ holds nothing unrecorded (${onDisk.join(', ')})`);

// Licences.
assert(/GNU GENERAL PUBLIC LICENSE\s+Version 3/.test(fs.readFileSync(path.join(DIR, 'LICENSE'), 'utf8')), 'LICENSE is the GPL-3.0 text');
assert(/Apache License\s+Version 2\.0/.test(fs.readFileSync(path.join(DIR, 'third-party', 'chevrotain-LICENSE.txt'), 'utf8')), 'chevrotain\'s Apache-2.0 licence ships');
assert(/Permission is hereby granted, free of charge/.test(fs.readFileSync(path.join(DIR, 'third-party', 'lodash-es-LICENSE.txt'), 'utf8')), 'lodash-es\'s MIT licence ships');
const notices = fs.readFileSync(path.join(REPO, 'THIRD-PARTY-NOTICES.md'), 'utf8');
assert(/resources\/compiler\//.test(notices) && /GPL-3\.0/.test(notices) && /chevrotain/.test(notices) && /lodash-es/.test(notices) && notices.includes(commit),
    'THIRD-PARTY-NOTICES.md lists the bundled compiler (GPL-3.0, at its commit) and the two components inside it');

// It ships, and the dev script does not.
const ignore = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
assert(!ignore.some(l => /^(resources|resources\/compiler)(\/\*\*)?$/.test(l) || /\.cjs$|\.stlib$/.test(l)), '.vscodeignore keeps resources/compiler/ in the VSIX');
assert(ignore.includes('scripts/vendor-compiler.js'), '.vscodeignore drops the vendoring script');

// Self-contained: the bundle requires Node built-ins only.
const bundle = fs.readFileSync(path.join(DIR, 'compiler.cjs'), 'utf8');
const builtins = new Set(require('module').builtinModules);
const required = [...new Set([...bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]))];
const foreign = required.filter(r => !builtins.has(r.replace(/^node:/, '')));
assert(required.length > 0 && foreign.length === 0, `the bundle requires Node built-ins only (${foreign.join(', ') || 'none foreign'})`);

if (errors > 0) {
    console.error(`\n${errors} vendored-compiler assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll vendored-compiler assertions passed.');
