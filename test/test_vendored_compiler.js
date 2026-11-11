/**
 * @file test_vendored_compiler.js
 * @description The compiler that ships with the extension (`resources/compiler/`, written by
 * scripts/vendor-compiler.js): it is all there, it is exactly what SOURCE.md records (the
 * corresponding-source link of the GPL-3.0 compiler names a full commit), its licence files and
 * third-party notices are present and ship, the bundle needs no npm package at run time, and the
 * only dialect profile shipped is resources/dialects/twincat3.json.
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

// Dialect profiles (user rule): the extension ships the TwinCAT profile and no other — none from the
// fork either (its CODESYS or IEC profiles are never copied; the bundle's built-in library importer is
// code, not a profile file).
const dialects = fs.readdirSync(path.join(REPO, 'resources', 'dialects')).sort();
assert(JSON.stringify(dialects) === '["twincat3.json"]', `resources/dialects/ holds exactly twincat3.json (${dialects.join(', ')})`);
assert(!walk(DIR).some(f => /\.json$/i.test(f)), 'resources/compiler/ carries no .json (no dialect profile from the fork)');
const profileFiles = walk(path.join(REPO, 'resources')).filter(f => /dialect/i.test(rel(f)) || /[\\/]dialects[\\/]/.test(f));
assert(profileFiles.length === 1 && path.basename(profileFiles[0]) === 'twincat3.json', `the only dialect profile under resources/ is twincat3.json (${profileFiles.map(f => path.relative(REPO, f)).join(', ')})`);
// {IF defined(X)} … {END_IF} is TwinCAT code: without the feature every such block is an error.
const profile = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'dialects', 'twincat3.json'), 'utf8'));
assert(Array.isArray(profile.features) && profile.features.includes('conditional_pragmas'), 'the TwinCAT profile turns on conditional_pragmas');

// Self-contained: the bundle requires Node built-ins only.
const bundle = fs.readFileSync(path.join(DIR, 'compiler.cjs'), 'utf8');
const builtins = new Set(require('module').builtinModules);
const required = [...new Set([...bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]))];
const foreign = required.filter(r => !builtins.has(r.replace(/^node:/, '')));
assert(required.length > 0 && foreign.length === 0, `the bundle requires Node built-ins only (${foreign.join(', ') || 'none foreign'})`);
// Compile Project passes the .plcproj compiler defines with these options (src/compilerDefines.js); a
// compiler without them stops every run of a project that has defines with a usage error.
assert(bundle.includes('"--pragma-define"') && bundle.includes('"--file-define"'),
    'the bundle accepts --pragma-define and --file-define (vendored at fork eb52d2c or later)');

if (errors > 0) {
    console.error(`\n${errors} vendored-compiler assertion(s) failed.`);
    process.exit(1);
}
console.log('\nAll vendored-compiler assertions passed.');
