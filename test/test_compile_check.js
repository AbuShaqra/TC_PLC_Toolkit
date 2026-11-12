/**
 * @file test_compile_check.js
 * @description The vscode-free half of Compile Project (`src/compileCheck.js`), with a fake child
 * process — no compiler and no Node probe is run for real (that is test/test_compile_real.js).
 *
 * Pinned: the bundled compiler as the default and the setting as its override, Node discovery (its
 * order, the version gate, the Windows install locations, the editor's own runtime as the last
 * resort), the setup messages (compiler missing, Node missing, Node too old — each naming the
 * setting that fixes it), the command line, reading the JSON report (clean, errors, malformed, exit code 2,
 * a crash), mapping diagnostics to file/component/pane/line, the pragma-warning filter and its
 * count, the temporary directory's lifetime, timeout and cancellation, and the XML range of a pane
 * position.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTwinCatXml } = require('../src/xmlParser');
const { memberName } = require('../src/componentId');
const cc = require('../src/compileCheck');
const { createFakeSpawn } = require('./_fakeChild');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const CRLF = '\r\n';
const cdata = (text) => `<![CDATA[${text}]]>`;
const fbXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1">',
    '  <POU Name="FB_A" Id="{a}" SpecialFunc="None">',
    `    <Declaration>${cdata(`FUNCTION_BLOCK FB_A${CRLF}VAR${CRLF}\tn : INT;${CRLF}END_VAR`)}</Declaration>`,
    `    <Implementation><ST>${cdata(`n := n + 1;`)}</ST></Implementation>`,
    '    <Method Name="Run" Id="{b}">',
    `      <Declaration>${cdata(`METHOD Run : BOOL`)}</Declaration>`,
    `      <Implementation><ST>${cdata(`n := 0;${CRLF}nNope := 5;`)}</ST></Implementation>`,
    '    </Method>',
    '  </POU>',
    '</TcPlcObject>'
].join(CRLF);
const gvlXml = `<TcPlcObject><GVL Name="GVL_Io" Id="{g}"><Declaration>${cdata(`{attribute 'qualified_only'}${CRLF}VAR_GLOBAL${CRLF}\tb : BOOL;${CRLF}END_VAR`)}</Declaration></GVL></TcPlcObject>`;

const FILES = [
    { filePath: path.join('C:', 'p', 'POUs', 'FB_A.TcPOU'), text: fbXml },
    { filePath: path.join('C:', 'p', 'GVLs', 'GVL_Io.TcGVL'), text: gvlXml },
    { filePath: path.join('C:', 'p', 'Broken.TcPOU'), text: '<nothing/>' }
];

(async () => {
    // ── Node version ────────────────────────────────────────────────────────────────────────────
    assert(cc.parseNodeVersion('v22.11.0\n').major === 22 && cc.parseNodeVersion('v22.11.0').text === '22.11.0', 'NODE: reads vMAJOR.MINOR.PATCH');
    assert(cc.parseNodeVersion('18.20.4').major === 18 && cc.parseNodeVersion('not node') === null && cc.parseNodeVersion('') === null,
        'NODE: accepts a bare version, rejects anything else');
    assert(cc.MIN_NODE_MAJOR === 22, 'NODE: the minimum is Node 22');

    // ── Setup check ─────────────────────────────────────────────────────────────────────────────
    const existsOnly = (...paths) => (p) => paths.includes(p);
    const nodeSays = (text, code = 0) => createFakeSpawn(() => ({ stdout: text, code }));
    // Linux, no editor runtime: `node` on PATH is the only automatic candidate.
    const plain = { platform: 'linux', env: {}, runtime: null };
    const BUNDLED = cc.bundledCompilerPath();

    // The compiler: bundled by default, the setting overrides it.
    assert(BUNDLED === path.join(__dirname, '..', 'resources', 'compiler', 'compiler.cjs') && fs.existsSync(BUNDLED),
        'BUNDLED: the default compiler is resources/compiler/compiler.cjs, and it is in the repo');
    assert(cc.resolveCompilerPath('', '/ext').path === path.join('/ext', 'resources', 'compiler', 'compiler.cjs') && cc.resolveCompilerPath('  ', '/ext').bundled === true &&
        cc.resolveCompilerPath(undefined).path === BUNDLED, 'BUNDLED: an empty setting resolves to the bundled compiler under the extension root');
    assert(cc.resolveCompilerPath(' /c/mine.cjs ', '/ext').path === '/c/mine.cjs' && cc.resolveCompilerPath('/c/mine.cjs').bundled === false,
        'OVERRIDE: a set compiler path wins over the bundled one');

    let fake = nodeSays('v22.3.0\n');
    let setup = await cc.checkSetup({ compilerPath: '', nodePath: '' }, { ...plain, spawn: fake.spawn });
    assert(setup.ok && setup.compilerPath === BUNDLED && setup.compilerBundled && setup.nodeCommand === 'node' && setup.nodeVersion === '22.3.0' && setup.nodeEnv === undefined,
        'SETUP: with nothing configured, the bundled compiler and Node 22 on PATH are enough');
    assert(fake.calls.length === 1 && fake.calls[0].command === 'node' && fake.calls[0].args.join(' ') === '--version' && fake.calls[0].options.shell === false &&
        fake.calls[0].options.env === undefined, 'SETUP: the Node version is checked with `node --version`, without a shell, in the inherited environment');

    setup = await cc.checkSetup({ compilerPath: '/c/bundle.cjs', nodePath: '' }, { ...plain, spawn: nodeSays('v22.3.0').spawn, exists: existsOnly('/c/bundle.cjs') });
    assert(setup.ok && setup.compilerPath === '/c/bundle.cjs' && !setup.compilerBundled, 'SETUP: an override compiler file that exists is used');

    setup = await cc.checkSetup({}, { ...plain, spawn: nodeSays('v22.3.0').spawn, exists: () => false, extensionRoot: '/ext' });
    assert(!setup.ok && setup.problems.length === 1 && setup.problems[0].setting === 'tcToolkit.compiler.path' &&
        /ships with the extension is missing/.test(setup.problems[0].message) && /Reinstall the extension/.test(setup.problems[0].message),
        'SETUP: a missing bundled compiler says so and how to fix it');

    setup = await cc.checkSetup({ compilerPath: '/gone/bundle.cjs' }, { ...plain, spawn: nodeSays('v23.0.0').spawn, exists: () => false });
    assert(!setup.ok && /"\/gone\/bundle\.cjs"/.test(setup.problems[0].message) && /does not exist/.test(setup.problems[0].message) &&
        /clear the setting/.test(setup.problems[0].message), 'SETUP: an override compiler path that is not a file is named, with the way back to the bundled one');

    setup = await cc.checkSetup({ compilerPath: '/c/bundle.cjs', nodePath: '' }, { ...plain, spawn: nodeSays('v18.20.4').spawn, exists: existsOnly('/c/bundle.cjs') });
    assert(!setup.ok && setup.problems.length === 1 && setup.problems[0].setting === 'tcToolkit.compiler.nodePath' &&
        /Node\.js 18\.20\.4 was found/.test(setup.problems[0].message) && /needs Node\.js 22 or newer/.test(setup.problems[0].message) &&
        /"node" on PATH/.test(setup.problems[0].message),
        'SETUP: a Node that is too old is reported with its version, where it was found and what is needed');

    fake = createFakeSpawn(() => ({ error: 'spawn node ENOENT' }));
    setup = await cc.checkSetup({ compilerPath: '/c/bundle.cjs' }, { ...plain, spawn: fake.spawn, exists: existsOnly('/c/bundle.cjs') });
    assert(!setup.ok && /could not be started/.test(setup.problems[0].message) && /ENOENT/.test(setup.problems[0].message) &&
        /Install Node\.js 22 or newer, or set "tcToolkit\.compiler\.nodePath"/.test(setup.problems[0].message),
        'SETUP: no Node on PATH says so and says how to fix it');

    fake = nodeSays('v22.0.0');
    setup = await cc.checkSetup({ compilerPath: '/c/bundle.cjs', nodePath: '/opt/node' }, { ...plain, spawn: fake.spawn, exists: existsOnly('/c/bundle.cjs') });
    assert(!setup.ok && fake.calls.length === 0 && /"\/opt\/node" \(setting "tcToolkit\.compiler\.nodePath"\) does not exist/.test(setup.problems[0].message),
        'SETUP: a configured Node path that does not exist is reported without trying to run it');

    fake = nodeSays('v22.0.0');
    setup = await cc.checkSetup({ compilerPath: '/c/bundle.cjs', nodePath: ' /opt/node ' }, { ...plain, spawn: fake.spawn, exists: existsOnly('/c/bundle.cjs', '/opt/node') });
    assert(setup.ok && setup.nodeCommand === '/opt/node' && fake.calls[0].command === '/opt/node', 'SETUP: a configured Node path is the one that runs');

    setup = await cc.checkSetup({ compilerPath: '/c/bundle.cjs' }, { ...plain, spawn: nodeSays('Python 3.12').spawn, exists: existsOnly('/c/bundle.cjs') });
    assert(!setup.ok && /is not a Node\.js executable/.test(setup.problems[0].message), 'SETUP: something that reports no Node version is refused');

    fake = createFakeSpawn(() => ({ hang: true }));
    setup = await cc.checkSetup({ compilerPath: '/c/bundle.cjs' }, { ...plain, spawn: fake.spawn, exists: existsOnly('/c/bundle.cjs'), timeoutMs: 30 });
    assert(!setup.ok && /did not answer/.test(setup.problems[0].message) && fake.calls[0].killed, 'SETUP: a Node probe that hangs is stopped and reported');

    setup = await cc.checkSetup({ compilerPath: '/gone.cjs' }, { ...plain, spawn: nodeSays('v16.0.0').spawn, exists: () => false });
    assert(setup.problems.length === 2 && setup.problems.map(p => p.setting).join() === 'tcToolkit.compiler.path,tcToolkit.compiler.nodePath',
        'SETUP: every problem is reported at once');

    // ── Node discovery: order, version gate, Windows locations, the editor's runtime ─────────────
    const winEnv = {
        ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        NVM_SYMLINK: 'C:\\nvm4w\\nodejs', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming'
    };
    const winRuntime = { execPath: 'C:\\Code\\Code.exe', nodeVersion: '22.15.1' };
    const order = cc.nodeCandidates('', { platform: 'win32', env: winEnv, runtime: winRuntime }).map(c => c.command);
    assert(JSON.stringify(order) === JSON.stringify([
        'node',
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
        'C:\\nvm4w\\nodejs\\node.exe',
        'C:\\Users\\u\\AppData\\Local\\Volta\\bin\\node.exe',
        'C:\\Program Files\\Volta\\node.exe',
        'C:\\Users\\u\\AppData\\Roaming\\fnm\\aliases\\default\\node.exe',
        'C:\\Code\\Code.exe'
    ]), `DISCOVER: Windows order is PATH, installer, nvm-windows, Volta, fnm, then the editor's runtime, each once (${order.join(' | ')})`);
    const runtimeCandidate = cc.nodeCandidates('', { platform: 'win32', env: winEnv, runtime: winRuntime }).pop();
    assert(runtimeCandidate.env && runtimeCandidate.env.ELECTRON_RUN_AS_NODE === '1', 'DISCOVER: the editor\'s runtime is run as Node (ELECTRON_RUN_AS_NODE=1)');
    assert(cc.nodeCandidates('', { platform: 'win32', env: { VOLTA_HOME: 'D:\\volta', FNM_DIR: 'D:\\fnm' }, runtime: null }).map(c => c.command).join() ===
        'node,D:\\volta\\bin\\node.exe,D:\\fnm\\aliases\\default\\node.exe', 'DISCOVER: VOLTA_HOME and FNM_DIR are honoured');
    assert(cc.nodeCandidates('', { platform: 'win32', env: winEnv, runtime: { execPath: 'C:\\Code\\Code.exe', nodeVersion: '20.18.0' } })
        .every(c => c.command !== 'C:\\Code\\Code.exe'), 'DISCOVER: an editor runtime older than Node 22 is not a candidate');
    assert(cc.nodeCandidates('', { platform: 'linux', env: winEnv, runtime: null }).map(c => c.command).join() === 'node',
        'DISCOVER: off Windows, only PATH (and the editor runtime) are tried');
    assert(cc.nodeCandidates('C:\\n\\node.exe', { platform: 'win32', env: winEnv, runtime: winRuntime }).map(c => c.command).join() === 'C:\\n\\node.exe',
        'DISCOVER: a configured Node path is the only candidate — it is never silently replaced');

    // A probe script: what each executable answers.
    const answers = (map) => createFakeSpawn((call) => {
        const a = map[call.command];
        return a === undefined ? { error: `spawn ${call.command} ENOENT` } : (typeof a === 'string' ? { stdout: a } : a);
    });
    const winDeps = (spawn, ...present) => ({ platform: 'win32', env: winEnv, runtime: winRuntime, spawn, exists: existsOnly(BUNDLED, ...present) });

    fake = answers({ 'C:\\Program Files\\nodejs\\node.exe': 'v22.11.0', 'C:\\Code\\Code.exe': 'v22.15.1' });
    setup = await cc.checkSetup({}, winDeps(fake.spawn, 'C:\\Program Files\\nodejs\\node.exe'));
    assert(setup.ok && setup.nodeCommand === 'C:\\Program Files\\nodejs\\node.exe' && setup.nodeEnv === undefined &&
        fake.calls.map(c => c.command).join() === 'node,C:\\Program Files\\nodejs\\node.exe',
        'DISCOVER: no node on PATH → the installer\'s node.exe is probed next and used; nothing later is tried');

    fake = answers({ node: 'v18.20.4', 'C:\\nvm4w\\nodejs\\node.exe': 'v20.1.0', 'C:\\Users\\u\\AppData\\Roaming\\fnm\\aliases\\default\\node.exe': 'v24.1.0' });
    setup = await cc.checkSetup({}, winDeps(fake.spawn, 'C:\\nvm4w\\nodejs\\node.exe', 'C:\\Users\\u\\AppData\\Roaming\\fnm\\aliases\\default\\node.exe'));
    assert(setup.ok && setup.nodeCommand === 'C:\\Users\\u\\AppData\\Roaming\\fnm\\aliases\\default\\node.exe' && setup.nodeVersion === '24.1.0' &&
        fake.calls.length === 3, 'DISCOVER: candidates older than Node 22 are passed over (the version gate), absent ones are not run');

    fake = answers({ node: 'v18.20.4', 'C:\\Code\\Code.exe': 'v22.15.1' });
    setup = await cc.checkSetup({}, winDeps(fake.spawn));
    const last = fake.calls[fake.calls.length - 1];
    assert(setup.ok && setup.nodeCommand === 'C:\\Code\\Code.exe' && setup.nodeEnv && setup.nodeEnv.ELECTRON_RUN_AS_NODE === '1' &&
        last.command === 'C:\\Code\\Code.exe' && last.options.env && last.options.env.ELECTRON_RUN_AS_NODE === '1',
        'DISCOVER: with no usable Node installed, the editor\'s own Node 22 runtime is the last resort, probed and run with ELECTRON_RUN_AS_NODE=1');

    fake = answers({ node: 'v18.20.4' });
    setup = await cc.checkSetup({}, { ...winDeps(fake.spawn), runtime: null });
    assert(!setup.ok && setup.problems.length === 1 && /^No Node\.js 22 or newer was found to run the compiler\./.test(setup.problems[0].message) &&
        /Node\.js 18\.20\.4 was found at "node" on PATH/.test(setup.problems[0].message) &&
        /usual install locations \(Node\.js installer, nvm-windows, Volta, fnm\) hold no Node\.js/.test(setup.problems[0].message) &&
        /Install Node\.js 22 or newer, or set "tcToolkit\.compiler\.nodePath"/.test(setup.problems[0].message),
        `DISCOVER: when none is found, the message says what was tried, what is missing and how to fix it (${setup.problems[0] && setup.problems[0].message})`);

    // The tile's cheap check.
    assert(cc.isCompilerAvailable('') && cc.isCompilerAvailable(undefined), 'TILE: with the setting empty the bundled compiler is available');
    assert(cc.isCompilerAvailable('/c/b.cjs', { exists: () => true }) && !cc.isCompilerAvailable('/c/b.cjs', { exists: () => false }) &&
        !cc.isCompilerAvailable('/c/b.cjs', { exists: () => { throw new Error('x'); } }) && !cc.isCompilerAvailable('', { exists: () => false }),
        'TILE: the compiler is unavailable only when its file (override or bundled) does not exist');

    // ── Inputs and the command line ─────────────────────────────────────────────────────────────
    const built = cc.buildCheckInputs(FILES, parseTwinCatXml);
    assert(built.inputs.length === 2 && built.inputs.map(i => i.name).join() === '1.st,2.st' && built.unparsed.length === 1 && /Broken/.test(built.unparsed[0]),
        'INPUT: each object becomes a numbered unit; a file that is not a TwinCAT object is listed, not guessed');
    const args = cc.buildCheckArgs({ compilerPath: '/c/bundle.cjs', dialectFile: '/x/twincat3.json', inputs: built.inputs });
    assert(args.join(' ') === '/c/bundle.cjs --check --json --dialect-file /x/twincat3.json 1.st 2.st --global-list 2.st=GVL_Io',
        `ARGS: check-only JSON, the dialect file, every unit, and each global list by its TwinCAT name (${args.join(' ')})`);
    assert(!args.includes('--strict') && !args.includes('-o') && !args.includes('--build'), 'ARGS: no --strict, no output file, no build');
    const withDefines = cc.buildCheckArgs({ compilerPath: '/c/bundle.cjs', dialectFile: '/x/twincat3.json', inputs: built.inputs,
        defineArgs: ['--pragma-define', 'SIM', '--pragma-define', 'N=4', '--file-define', '1.st=LOCAL'] });
    assert(withDefines.join(' ') === '/c/bundle.cjs --check --json --dialect-file /x/twincat3.json --pragma-define SIM --pragma-define N=4 --file-define 1.st=LOCAL 1.st 2.st --global-list 2.st=GVL_Io',
        `ARGS: the compiler defines (project and per-object) follow the profile, before the units (${withDefines.join(' ')})`);

    // ── Reading the report ──────────────────────────────────────────────────────────────────────
    const report = (diagnostics) => JSON.stringify({ dialect: 'twincat3', files: ['1.st', '2.st'], diagnostics, summary: {} });
    let parsed = cc.parseCheckOutput(report([]), 0);
    assert(parsed.ok && parsed.diagnostics.length === 0 && parsed.dialect === 'twincat3', 'JSON: a clean report');
    parsed = cc.parseCheckOutput(report([{ file: '1.st', line: 3, column: 2, severity: 'error', message: 'E', endLine: 3, endColumn: 5, code: 'X1' },
        { file: '1.st', line: 1, column: 1, severity: 'warning', message: 'W' }, { file: '1.st', line: 1, column: 1, severity: 'weird', message: 'U' },
        { nonsense: true }, null]), 1);
    assert(parsed.ok && parsed.diagnostics.length === 3 && parsed.diagnostics[0].endColumn === 5 && parsed.diagnostics[0].code === 'X1' &&
        parsed.diagnostics[2].severity === 'error', 'JSON: entries are normalised; an unknown severity counts as an error; junk entries are dropped');
    parsed = cc.parseCheckOutput('Segmentation fault', 1, 'boom\n');
    assert(!parsed.ok && /could not be read/.test(parsed.message) && /boom/.test(parsed.message), 'JSON: malformed output is a failure, never a clean result');
    parsed = cc.parseCheckOutput('{"diagnostics": "no"}', 0);
    assert(!parsed.ok, 'JSON: valid JSON of the wrong shape is a failure too');
    parsed = cc.parseCheckOutput('', 0);
    assert(!parsed.ok, 'JSON: empty output with exit code 0 is NOT "no errors"');
    parsed = cc.parseCheckOutput(report([{ file: null, line: 0, column: 0, severity: 'error', message: 'dialect file x.json: ENOENT' }]), 2);
    assert(!parsed.ok && /could not run the check: dialect file x\.json: ENOENT/.test(parsed.message), 'JSON: exit code 2 reports why the check could not run');
    parsed = cc.parseCheckOutput('', 2, 'error: usage\n');
    assert(!parsed.ok && /could not run the check: error: usage/.test(parsed.message), 'JSON: exit code 2 without a report falls back to stderr');
    parsed = cc.parseCheckOutput(report([]), 139, 'killed');
    assert(!parsed.ok && /stopped unexpectedly \(exit code 139\): killed/.test(parsed.message), 'JSON: any other exit code is a crash');
    parsed = cc.parseCheckOutput(report([]), null);
    assert(!parsed.ok && /exit code none/.test(parsed.message), 'JSON: no exit code (killed by a signal) is a crash');
    parsed = cc.parseCheckOutput(report([{ file: '1.st', line: 1, column: 1, severity: 'warning', message: 'W' }]), 1);
    assert(!parsed.ok && /lists none/.test(parsed.message), 'JSON: exit code 1 with no error in the report is not trusted');

    // ── Mapping ─────────────────────────────────────────────────────────────────────────────────
    const unitLine = (text) => built.inputs[0].unit.lines.indexOf(text) + 1;
    const mapped = cc.mapCheckDiagnostics([
        { file: '1.st', line: unitLine('nNope := 5;'), column: 1, severity: 'error', message: "Undeclared variable 'NNOPE'" },
        { file: './1.st', line: unitLine('\tn : INT;'), column: 2, severity: 'warning', message: 'Unused', endLine: unitLine('\tn : INT;'), endColumn: 3 },
        { file: '2.st', line: 1, column: 1, severity: 'warning', message: "Pragma ignored: {attribute 'qualified_only'}" },
        { file: '2.st', line: 1, column: 1, severity: 'error', message: 'Pragma ignored: not a warning' },
        { file: null, line: 0, column: 0, severity: 'error', message: 'Library X not found' },
        { file: '9.st', line: 1, column: 1, severity: 'error', message: 'Unknown file' },
        { file: '1.st', line: unitLine('END_METHOD'), column: 1, severity: 'error', message: 'Expected ;' }
    ], built.inputs);
    const d0 = mapped.diagnostics[0];
    assert(d0.filePath === FILES[0].filePath && d0.componentId === 'method_Run' && d0.pane === 'impl' && d0.line === 2 && d0.column === 1 &&
        d0.endLine === 2 && d0.endColumn === 12 && d0.severity === 'error' && d0.exact,
        'MAP: an error in a method body lands on that file, method, implementation pane and line');
    const d1 = mapped.diagnostics[1];
    assert(d1.componentId === 'root' && d1.pane === 'decl' && d1.line === 3 && d1.column === 2 && d1.endColumn === 3 && d1.severity === 'warning',
        'MAP: a warning stays a warning, in the declaration pane, with the compiler\'s end column');
    assert(mapped.filteredPragmaWarnings === 1 && !mapped.diagnostics.some(d => /qualified_only/.test(d.message)),
        'FILTER: pragma-skipped warnings are dropped and counted');
    assert(mapped.diagnostics.some(d => d.message === 'Pragma ignored: not a warning' && d.filePath === FILES[1].filePath),
        'FILTER: only WARNINGS are filtered — an error with the same wording is kept');
    assert(mapped.general.length === 2 && mapped.general.map(d => d.message).join('|') === 'Library X not found|Unknown file',
        'MAP: a diagnostic without a known file is kept as a general one, never dropped');
    const dGen = mapped.diagnostics[mapped.diagnostics.length - 1];
    assert(dGen.componentId === 'method_Run' && dGen.pane === 'impl' && dGen.line === 2 && !dGen.exact,
        'MAP: an error on a generated line lands at the end of the owning method, marked inexact');
    assert(cc.describeLocation(d0, memberName) === 'Run, implementation line 2' && cc.describeLocation(d1, memberName) === 'declaration line 3',
        'MAP: locations read "Run, implementation line 2" / "declaration line 3"');

    // ── The Problems-panel range of a pane position ─────────────────────────────────────────────
    // The Problems-panel range is the pane's own line and column (0-based), not a position in the XML.
    let range = cc.paneRange({ pane: 'impl', line: 2, column: 1, endLine: 2, endColumn: 12 });
    assert(JSON.stringify(range) === JSON.stringify({ start: { line: 1, character: 0 }, end: { line: 1, character: 11 } }),
        `RANGE: implementation line 2 is Ln 2 in the Problems panel (${JSON.stringify(range)})`);
    range = cc.paneRange({ pane: 'decl', line: 3, column: 2 });
    assert(JSON.stringify(range) === JSON.stringify({ start: { line: 2, character: 1 }, end: { line: 2, character: 1 } }),
        'RANGE: no end position gives an empty range at the start');
    range = cc.paneRange({ pane: 'impl', line: 4, column: 5, endLine: 3, endColumn: 1 });
    assert(range.end.line === 3 && range.end.character === 4, 'RANGE: an end before the start collapses to the start');
    range = cc.paneRange({ pane: 'impl', line: 0, column: 0 });
    assert(range.start.line === 0 && range.start.character === 0, 'RANGE: a missing line/column is the pane\'s first character');

    // ── Running the check ───────────────────────────────────────────────────────────────────────
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-compile-test-'));
    const leftovers = () => fs.readdirSync(tmpRoot);
    const base = { nodeCommand: '/opt/node', compilerPath: '/c/bundle.cjs', dialectFile: '/x/twincat3.json', inputs: built.inputs, tmpRoot };

    let seen = null;
    fake = createFakeSpawn((call) => {
        // The units exist while the compiler runs, in its working directory.
        seen = { files: fs.readdirSync(call.options.cwd).sort(), first: fs.readFileSync(path.join(call.options.cwd, '1.st'), 'utf8') };
        return { stdout: report([{ file: '1.st', line: unitLine('nNope := 5;'), column: 1, severity: 'error', message: 'E' },
            { file: '2.st', line: 1, column: 1, severity: 'warning', message: "Pragma ignored: {attribute 'qualified_only'}" },
            { file: '1.st', line: 1, column: 1, severity: 'warning', message: 'W' }]), code: 1 };
    });
    let result = await cc.runCheck({ ...base, spawn: fake.spawn });
    assert(result.status === 'done' && result.errors === 1 && result.warnings === 1 && result.filteredPragmaWarnings === 1 && result.diagnostics.length === 2,
        'RUN: errors and warnings are counted after the pragma filter');
    assert(seen && seen.files.join() === '1.st,2.st' && seen.first === built.inputs[0].unit.stText + '\n',
        'RUN: the units are written into the compiler\'s working directory');
    assert(fake.calls[0].command === '/opt/node' && fake.calls[0].args[0] === '/c/bundle.cjs' && fake.calls[0].options.shell === false &&
        fake.calls[0].options.cwd.startsWith(tmpRoot), 'RUN: the compiler is started with the chosen Node, as a child process without a shell');
    assert(leftovers().length === 0, 'RUN: the temporary directory is deleted after a run');

    result = await cc.runCheck({ ...base, spawn: createFakeSpawn(() => ({ stdout: report([]), code: 0 })).spawn });
    assert(result.status === 'done' && result.errors === 0 && result.warnings === 0 && result.durationMs >= 0, 'RUN: a clean project');

    result = await cc.runCheck({ ...base, spawn: createFakeSpawn(() => ({ stdout: 'garbage', stderr: 'TypeError: x', code: 1 })).spawn });
    assert(result.status === 'failed' && /could not be read/.test(result.message) && leftovers().length === 0, 'RUN: malformed output fails the run and still cleans up');

    result = await cc.runCheck({ ...base, spawn: createFakeSpawn(() => ({ stdout: report([{ file: null, line: 0, column: 0, severity: 'error', message: 'Cannot read input file: 1.st' }]), code: 2 })).spawn });
    assert(result.status === 'failed' && /Cannot read input file/.test(result.message), 'RUN: exit code 2 fails the run with the compiler\'s reason');

    result = await cc.runCheck({ ...base, spawn: createFakeSpawn(() => ({ error: 'spawn /opt/node ENOENT' })).spawn });
    assert(result.status === 'failed' && /could not be started: spawn \/opt\/node ENOENT/.test(result.message) && leftovers().length === 0, 'RUN: a compiler that cannot start');

    result = await cc.runCheck({ ...base, spawn: createFakeSpawn(() => ({ throws: 'EINVAL' })).spawn });
    assert(result.status === 'failed' && /EINVAL/.test(result.message), 'RUN: spawn throwing is a failure, not a crash');

    fake = createFakeSpawn(() => ({ hang: true }));
    result = await cc.runCheck({ ...base, spawn: fake.spawn, timeoutMs: 40 });
    assert(result.status === 'timeout' && fake.calls[0].killed && /did not finish/.test(result.message) && leftovers().length === 0,
        'RUN: a compiler that hangs is stopped at the timeout, and the temporary files go');

    fake = createFakeSpawn(() => ({ hang: true }));
    let cancel = null;
    const pending = cc.runCheck({ ...base, spawn: fake.spawn, onCancel: (fn) => { cancel = fn; } });
    await new Promise(r => setTimeout(r, 20));
    cancel();
    result = await pending;
    assert(result.status === 'cancelled' && fake.calls[0].killed && leftovers().length === 0, 'RUN: cancelling stops the compiler and cleans up');

    result = await cc.runCheck({ ...base, tmpRoot: path.join(tmpRoot, 'does', 'not', 'exist'), spawn: fake.spawn });
    assert(result.status === 'failed' && /temporary files/.test(result.message), 'RUN: an unwritable temporary directory is reported');
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    // ── Summary text ────────────────────────────────────────────────────────────────────────────
    assert(cc.summarize({ errors: 0, warnings: 0 }, 'PLC') === 'PLC: no errors.' && cc.summarize({ errors: 0, warnings: 2 }, 'PLC') === 'PLC: no errors, 2 warnings.' &&
        cc.summarize({ errors: 1, warnings: 1 }, 'PLC') === 'PLC: 1 error, 1 warning.' && cc.summarize({ errors: 3, warnings: 0 }, 'PLC') === 'PLC: 3 errors, 0 warnings.',
        'SUMMARY: "no errors", or N errors and M warnings');

    // ── runChild streams chunks to onStdout / onStderr (Build through XAE, R14) ───────────────
    {
        const seenOut = [];
        const seenErr = [];
        const streaming = createFakeSpawn(() => ({ stdout: 'line one\nline two\n', stderr: 'warn\n', code: 3 }));
        const r = await cc.runChild(streaming.spawn, 'x', [], {
            timeoutMs: 5000, onStdout: (c) => seenOut.push(String(c)), onStderr: (c) => seenErr.push(String(c))
        });
        assert(seenOut.join('') === 'line one\nline two\n' && seenErr.join('') === 'warn\n', 'runChild hands every chunk to onStdout / onStderr');
        assert(r.outcome === 'exit' && r.code === 3 && r.stdout === 'line one\nline two\n' && r.stderr === 'warn\n',
            'runChild still collects and returns the output with the callbacks set');
        const plain = await cc.runChild(createFakeSpawn(() => ({ stdout: 'x', code: 0 })).spawn, 'x', [], { timeoutMs: 5000 });
        assert(plain.stdout === 'x' && plain.code === 0, 'runChild without callbacks is unchanged');
    }

    if (errors > 0) {
        console.error(`\n${errors} compile-check assertion(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll compile-check assertions passed.');
})().catch((err) => { console.error(err); process.exit(1); });
