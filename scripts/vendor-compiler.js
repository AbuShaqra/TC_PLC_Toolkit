#!/usr/bin/env node
/**
 * @file vendor-compiler.js
 * @description Developer script (not shipped): copies the external IEC 61131-3 compiler that
 * *TC Toolkit: Build Project* runs into `resources/compiler/`, from a BUILT checkout of the STruC++
 * fork, and records the exact commit it was built from (the GPL-3.0 corresponding-source link).
 *
 * Usage:
 *   node scripts/vendor-compiler.js <fork checkout> [--repo-url <url>]
 *
 * The checkout must be clean (the recorded commit must BE the source of the files) and built:
 *   git -C <fork> checkout <commit> && (cd <fork> && npm ci && npm run build:bundle)
 *
 * What lands in resources/compiler/ (the directory is replaced as a whole):
 *   compiler.cjs                 dist/strucpp-bundle.cjs, renamed so no product name reaches the UI
 *   libs/<name>.stlib            the libraries a `--check` needs (the bundle loads every .stlib in
 *                                the `libs/` directory next to itself)
 *   include/<name>.hpp           the C++ runtime headers (src/runtime/include/), which the optional
 *                                g++ build of generated C++ compiles against (GPL-3.0-only WITH
 *                                the runtime library exception, per the fork's COPYING)
 *   LICENSE, COPYING, COPYING.RUNTIME              the fork's licence files, verbatim
 *   third-party/chevrotain-LICENSE.txt             Apache-2.0 (chevrotain and @chevrotain/*)
 *   third-party/lodash-es-LICENSE.txt              MIT
 *   SOURCE.md                    source repository, commit, build command, versions, SHA-256 of
 *                                every file above (test/test_vendored_compiler.js checks them)
 */

'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TARGET = path.join(REPO, 'resources', 'compiler');
const DEFAULT_REPO_URL = 'https://github.com/AbuShaqra/STruCpp';

/**
 * The libraries shipped. Only the IEC standard function blocks (TON, R_TRIG, CTU …) and the IEC
 * standard functions: the fork's other libraries (OSCAT, softmotion, extra FBs) are not TwinCAT's,
 * so shipping them would make names resolve that TwinCAT would refuse.
 */
const LIBS = ['iec-standard-fb.stlib', 'iec-std-functions.stlib'];

/** Bundled npm packages whose licences ship with the bundle: package → [licence file, shipped name]. */
const THIRD_PARTY = [
    { pkg: 'chevrotain', file: 'LICENSE.txt', as: 'chevrotain-LICENSE.txt', covers: ['chevrotain', '@chevrotain/gast', '@chevrotain/regexp-to-ast', '@chevrotain/utils'] },
    { pkg: 'lodash-es', file: 'LICENSE', as: 'lodash-es-LICENSE.txt', covers: ['lodash-es'] }
];

function fail(msg) {
    console.error(`vendor-compiler: ${msg}`);
    process.exit(1);
}

function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** Where the fork keeps its C++ runtime headers; every `*.hpp` in it is copied to `include/`. */
const RUNTIME_INCLUDE = path.join('src', 'runtime', 'include');

/** The licence line a runtime header carries when it has a per-file notice. */
const RUNTIME_SPDX = 'SPDX-License-Identifier: GPL-3.0-only WITH STruCpp-runtime-exception';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function main() {
    const argv = process.argv.slice(2);
    let repoUrl = DEFAULT_REPO_URL;
    const i = argv.indexOf('--repo-url');
    if (i >= 0) { repoUrl = argv[i + 1] || fail('--repo-url needs a value'); argv.splice(i, 2); }
    if (argv.length !== 1) fail('usage: node scripts/vendor-compiler.js <fork checkout> [--repo-url <url>]');
    const fork = path.resolve(argv[0]);

    const commit = git(fork, 'rev-parse', 'HEAD');
    const dirty = git(fork, 'status', '--porcelain', '--untracked-files=no');
    if (dirty) fail(`${fork} has uncommitted changes; the vendored files must be built from a commit:\n${dirty}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(fork, 'package.json'), 'utf8'));
    const versionOf = (name) => JSON.parse(fs.readFileSync(path.join(fork, 'node_modules', name, 'package.json'), 'utf8')).version;

    const includeDir = path.join(fork, RUNTIME_INCLUDE);
    if (!fs.existsSync(includeDir)) fail(`${includeDir} not found: is this a checkout of the compiler?`);
    const headers = fs.readdirSync(includeDir).filter(f => /\.hpp$/.test(f)).sort();
    if (headers.length === 0) fail(`${includeDir} holds no .hpp file`);
    // The fork's COPYING covers every src/runtime/include/*.hpp; most also carry the notice themselves.
    const copying = fs.readFileSync(path.join(fork, 'COPYING'), 'utf8');
    if (!copying.includes('src/runtime/include/*.hpp') || !copying.includes('STruCpp-runtime-exception')) {
        fail('COPYING no longer lists src/runtime/include/*.hpp under the runtime library exception; check the licence before vendoring');
    }
    const noNotice = headers.filter(h => !fs.readFileSync(path.join(includeDir, h), 'utf8').slice(0, 400).includes(RUNTIME_SPDX));

    /** @type {Array<{from: string, to: string}>} */
    const copies = [
        { from: path.join(fork, 'dist', 'strucpp-bundle.cjs'), to: 'compiler.cjs' },
        ...LIBS.map(lib => ({ from: path.join(fork, 'libs', lib), to: `libs/${lib}` })),
        ...headers.map(h => ({ from: path.join(fork, RUNTIME_INCLUDE, h), to: `include/${h}` })),
        ...['LICENSE', 'COPYING', 'COPYING.RUNTIME'].map(f => ({ from: path.join(fork, f), to: f })),
        ...THIRD_PARTY.map(t => ({ from: path.join(fork, 'node_modules', t.pkg, t.file), to: `third-party/${t.as}` }))
    ];
    const missing = copies.filter(c => !fs.existsSync(c.from)).map(c => c.from);
    if (missing.length) fail(`not found (is the checkout built? npm ci && npm run build:bundle):\n  ${missing.join('\n  ')}`);

    // The bundle must be no older than the commit, or it may not have been built from it.
    const committedAt = Number(git(fork, 'log', '-1', '--format=%ct')) * 1000;
    const bundleAt = fs.statSync(copies[0].from).mtimeMs;
    if (bundleAt < committedAt) fail('dist/strucpp-bundle.cjs is older than HEAD; rebuild it (npm run build:bundle)');

    let published;
    try { published = git(fork, 'branch', '-r', '--contains', commit); } catch (e) { published = ''; }

    fs.rmSync(TARGET, { recursive: true, force: true });
    for (const c of copies) {
        const to = path.join(TARGET, c.to);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(c.from, to);
    }

    const rows = copies.map(c => {
        const file = path.join(TARGET, c.to);
        return `| \`${c.to}\` | ${fs.statSync(file).size} | \`${sha256(file)}\` |`;
    });
    const thirdParty = THIRD_PARTY.flatMap(t => t.covers.map(name =>
        `| ${name} | ${versionOf(name)} | ${JSON.parse(fs.readFileSync(path.join(fork, 'node_modules', name, 'package.json'), 'utf8')).license} | \`third-party/${t.as}\` |`));
    const source = [
        '# Bundled compiler: source and licences',
        '',
        'This directory holds the external IEC 61131-3 compiler that *TC Toolkit: Build Project* runs, as',
        'a separate Node.js process. It is **STruC++**, distributed under the **GNU General Public',
        'License version 3** (`LICENSE`; the licensing overview is `COPYING`, the runtime library',
        'exception `COPYING.RUNTIME`). The extension\'s own licence does not cover these files.',
        '',
        '## Corresponding source',
        '',
        `- Repository: ${repoUrl}`,
        `- Commit: \`${commit}\``,
        `- Source at that commit: ${repoUrl}/tree/${commit}`,
        `- Compiler version: ${pkg.version}`,
        '- Built with: `npm ci && npm run build:bundle` (Node.js 22 or newer)',
        '- `compiler.cjs` is that build\'s `dist/strucpp-bundle.cjs`, renamed; `libs/` holds two of the',
        '  libraries the same build writes to `libs/` (their sources are under `libs/sources/` in the',
        '  repository).',
        '- `include/` holds the C++ runtime headers of the same commit (`src/runtime/include/`, every',
        '  `.hpp`). Build Project\'s optional g++ build compiles the generated C++ against them.',
        '',
        '## Licence of the runtime headers',
        '',
        'The fork\'s `COPYING` lists `src/runtime/include/*.hpp` as **GPL-3.0-only WITH',
        'STruCpp-runtime-exception** (`LICENSE` and `COPYING.RUNTIME`): the exception lets C++ generated',
        'from a user\'s program include them without the program becoming GPL-licensed.',
        `${headers.length - noNotice.length} of the ${headers.length} headers carry that SPDX line themselves` +
            (noNotice.length ? `; ${noNotice.map(h => `\`${h}\``).join(' and ')} carry no per-file notice and are covered by \`COPYING\`'s file list only.` : '.'),
        '',
        '## Files',
        '',
        '| File | Bytes | SHA-256 |',
        '| --- | --- | --- |',
        ...rows,
        '',
        '## Third-party components inside `compiler.cjs`',
        '',
        '| Package | Version | Licence | Licence text |',
        '| --- | --- | --- | --- |',
        ...thirdParty,
        '',
        'Written by `scripts/vendor-compiler.js`; do not edit by hand.',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(TARGET, 'SOURCE.md'), source, 'utf8');

    console.log(`Vendored compiler ${pkg.version} from ${commit} into ${path.relative(REPO, TARGET)}/`);
    for (const r of rows) console.log(`  ${r}`);
    if (!published) {
        console.warn(`WARNING: ${commit} is on no remote-tracking branch of ${fork}. The source link in SOURCE.md must`);
        console.warn('point at a commit the public repository has; push it (or vendor a published commit) before shipping.');
    }
}

main();
