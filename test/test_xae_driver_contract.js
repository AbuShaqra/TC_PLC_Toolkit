/**
 * @file test_xae_driver_contract.js
 * @description The XAE build driver (resources/xae/build-plc-project.ps1, roadmap R14) read as TEXT
 * against its JS reader (src/xaeBuild.js). PowerShell does not run here, so this pins what can be
 * pinned statically: every flag the extension can pass is a parameter, every event type is both
 * emitted and handled, the prefix, protocol version and exit codes agree, the builder's safety
 * markers survived the adaptation, headless stays the default, and the file ships in the VSIX.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const x = require('../src/xaeBuild');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const REPO = path.join(__dirname, '..');
const DRIVER = path.join(REPO, 'resources', 'xae', 'build-plc-project.ps1');
const BUILDER = path.join(REPO, 'scripts', 'Build PLC project', 'build_plc_project.ps1');
const ps1 = fs.readFileSync(DRIVER, 'utf8');

// ── Encoding: Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page ──────────────
assert(![...ps1].some(ch => ch.charCodeAt(0) > 127), 'the driver is pure ASCII');
assert(/^# Adapted from scripts\/Build PLC project\/build_plc_project\.ps1 at [0-9a-f]{7,}; keep behaviour in step by hand\./.test(ps1),
    'the header names the builder it was adapted from');

// ── param(): every flag buildDriverArgs can emit ────────────────────────────────────────────────
const paramBlock = (/\nparam\(([\s\S]*?)\n\)\r?\n/.exec(ps1) || [])[1] || '';
const params = new Set([...paramBlock.matchAll(/\$([A-Za-z]+)\s*(?:=|,|\r?\n|$)/g)].map(m => m[1]));
const emitted = new Set();
for (const o of [
    { scriptPath: 's', slnPath: 'a.sln', showWindow: true, configuration: 'Debug', platform: 'P', cancelFile: 'c' },
    { scriptPath: 's', slnPath: 'a.sln', mode: /** @type {'activate'} */ ('activate'), targetNetId: '1.2.3.4.1.1' },
    { scriptPath: 's', mode: /** @type {'listTargets'} */ ('listTargets') },
    { scriptPath: 's', slnPath: 'a.sln', shellOverride: 'TcXaeShell.DTE.17.0' }
]) {
    const args = x.buildDriverArgs(o);
    const afterFile = args.slice(args.indexOf('-File') + 2);
    for (const a of afterFile) if (/^-[A-Za-z]+$/.test(a)) emitted.add(a.slice(1));
}
for (const flag of emitted) assert(params.has(flag), `-${flag} is a parameter of the driver`);
for (const flag of ['ShowWindow', 'Json', 'ListTargets', 'CancelFile', 'SlnPath', 'ActivateConfiguration', 'TargetNetId', 'Configuration', 'Platform']) {
    assert(params.has(flag), `param() declares $${flag}`);
}
assert(/\[switch\]\$ShowWindow/.test(paramBlock) && /\[switch\]\$Json/.test(paramBlock) && /\[switch\]\$ListTargets/.test(paramBlock)
    && /\[string\]\$CancelFile/.test(paramBlock), 'the four new parameters are switches / a string, opt-in');

// ── Events: emitted ⇔ handled ───────────────────────────────────────────────────────────────────
const emittedTypes = new Set([...ps1.matchAll(/Emit-Event\s+'([A-Za-z]+)'/g)].map(m => m[1]));
// Enter-Phase, Emit-UiState and Emit-Fatal emit 'phase', 'ui' and 'fatal'.
if (/function Enter-Phase[\s\S]*?Emit-Event 'phase'/.test(ps1)) emittedTypes.add('phase');
if (/function Emit-UiState[\s\S]*?Emit-Event 'ui'/.test(ps1)) emittedTypes.add('ui');
if (/function Emit-Fatal[\s\S]*?Emit-Event 'fatal'/.test(ps1)) emittedTypes.add('fatal');
for (const t of x.EVENT_TYPES) assert(emittedTypes.has(t), `the driver emits '${t}'`);
for (const t of emittedTypes) assert(x.EVENT_TYPES.includes(t), `the reader handles '${t}'`);
const phases = new Set([...ps1.matchAll(/Enter-Phase '([a-z]+)'/g)].map(m => m[1]));
for (const p of ['resolve', 'launch', 'pin', 'open', 'configure', 'build', 'errors', 'target', 'activate', 'restart', 'verify', 'close']) {
    assert(phases.has(p), `phase '${p}' is entered`);
}
for (const p of x.UNINTERRUPTIBLE_PHASES) assert(phases.has(p), `uninterruptible phase '${p}' exists in the driver`);
const fatalCodes = new Set([...ps1.matchAll(/Emit-Fatal\s+(?:\$\(if[^']*)?'([a-z-]+)'/g)].map(m => m[1]));
for (const code of ['no-sln', 'ambiguous-sln', 'config-not-declared', 'no-tsproj', 'version-mismatch', 'progid-not-registered', 'target-refused', 'com-failure']) {
    assert(fatalCodes.has(code) || ps1.includes(`'${code}'`), `fatal code ${code}`);
}
assert(ps1.includes("'shell-closed'"), 'fatal code shell-closed');
for (const r of ['headless', 'requested', 'version-switch', 'build', 'activation', 'after-activation']) {
    assert(ps1.includes(`'${r}'`), `ui reason '${r}'`);
}

// ── Prefix, version, exit codes ─────────────────────────────────────────────────────────────────
assert(ps1.includes(`'${x.PREFIX}' + $sb.ToString()`), `the prefix is '${x.PREFIX}'`);
assert(new RegExp(`\\[ordered\\]@\\{ v = ${x.PROTOCOL}; t = \\$Type \\}`).test(ps1), `every event carries v = ${x.PROTOCOL}`);
assert(/-Compress -Depth 6/.test(ps1) && /\[int\]\$ch -gt 127/.test(ps1) && /\[Console\]::Out\.Flush\(\)/.test(ps1),
    'compact JSON, non-ASCII escaped, flushed per line');
assert(/\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/.test(ps1), 'a -Json run writes UTF-8');
assert(/\$exitCode = 4/.test(ps1) && /Exit-Run 4/.test(ps1), `exit ${x.EXIT.CANCELLED} (cancelled) exists`);
assert(/Exit-Run \$exitCode\s*$/.test(ps1.trimEnd()) && !/^\s*exit \d/m.test(ps1.replace(/function Exit-Run[\s\S]*?\n\}/, '')),
    'every exit goes through Exit-Run (so done is always last)');

// ── Safety markers of the builder, kept ─────────────────────────────────────────────────────────
for (const [marker, what] of [
    ['$ownShellPid', 'only the shell this run started is quit'],
    ['Close($false)', 'the solution is closed without saving'],
    ['Resolve-ActivationTarget', 'the four pre-IDE activation gates'],
    ['$TcAdsStateNames', 'the ADS state names'],
    ['if ($adsState -eq 5)', 'RUN is ADS state 5 and nothing else'],
    ['GetTargetNetId()', 'the target is read back after it is set'],
    ['[TcBuildMessageFilter]::Revoke()', 'the message filter is revoked last']
]) assert(ps1.includes(marker), `kept: ${what} (${marker})`);
assert(/try \{ Invoke-ComRetry \{ \$dte\.SuppressUI = \$false \}; \$uiWasSuppressed = \$false \} catch \{ \}\r?\n\s*try \{ Invoke-ComRetry \{ \$dte\.MainWindow\.Visible = \$true \} \} catch \{ \}/.test(ps1),
    'activation still turns SuppressUI off and shows the window, whatever -ShowWindow says');
assert(!/UserControl/.test(ps1.replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '')), 'UserControl is never set');

// ── Headless by default; -ShowWindow guards ─────────────────────────────────────────────────────
assert(/if \(-not \$didSwitchVersion -and -not \$ShowWindow\) \{\r?\n\s*try \{ Invoke-ComRetry \{ \$dte\.MainWindow\.Visible = \$false \} \} catch \{ \}/.test(ps1),
    'the hide step is guarded by -not $ShowWindow (and still skipped after a version switch)');
assert(/\} else \{\r?\n\s*Invoke-ComRetry \{ \$dte\.SuppressUI = \$true \}\r?\n\s*\}/.test(ps1), 'without -ShowWindow SuppressUI is set exactly as the builder sets it');
assert(/if \(-not \$uiWasSuppressed -and -not \$ShowWindow\)/.test(ps1), 'with -ShowWindow the activation finally does not re-suppress the UI');
assert(/Emit-UiState 'build'/.test(ps1) && ps1.indexOf("Emit-UiState 'build'") > ps1.indexOf('$sb.Build($true)'), "the 'build' UI sample is read right after Build returns");

// ── Cancel: armed before activation only ────────────────────────────────────────────────────────
const disarm = ps1.indexOf("$script:CancelArmed = $false\r\n        Enter-Phase 'target'") >= 0
    ? ps1.indexOf("$script:CancelArmed = $false\r\n        Enter-Phase 'target'")
    : ps1.indexOf("$script:CancelArmed = $false\n        Enter-Phase 'target'");
assert(disarm > 0, 'cancellation is disarmed before the target/activate phases');
const afterDisarm = ps1.slice(disarm, ps1.indexOf("Enter-Phase 'close'"));
assert(!/\$script:CancelArmed\s*=\s*(?![\s$]false|\s)/.test(afterDisarm), 'nothing re-arms cancellation between activation and close');
assert((ps1.match(/\$script:CancelArmed\s*=\s*(?![\s$]false|\s)/g) || []).length === 1, 'cancellation is armed in exactly one place (from -CancelFile, at the top)');
// Every phase the driver enters right after disarming (except the finally's 'close') is one the JS
// side never cancels: a cancel there would be ignored and could only end in a force stop.
const disarmedPhases = [...ps1.matchAll(/\$script:CancelArmed = \$false\r?\n\s*Enter-Phase '([a-z]+)'/g)].map(m => m[1]).filter(p => p !== 'close');
assert(disarmedPhases.includes('target') && disarmedPhases.every(p => x.UNINTERRUPTIBLE_PHASES.includes(p)),
    `every phase entered after the disarm is uninterruptible in JS (${disarmedPhases.join(', ')})`);
const phaseOrder = [...ps1.matchAll(/Enter-Phase '([a-z]+)'/g)].map(m => m[1]);
const fromTarget = phaseOrder.slice(phaseOrder.indexOf('target'), phaseOrder.lastIndexOf('close'));
assert(fromTarget.every(p => x.UNINTERRUPTIBLE_PHASES.includes(p)), `no cancellable phase between the disarm and close (${fromTarget.join(', ')})`);
assert(/if \("\$_" -eq \$script:CancelSentinel\) \{ throw \}/.test(ps1), 'the pin step does not forgive a cancel as a COM failure');

// ── Additive only: every builder line that is not an `exit` survived ───────────────────────────
if (fs.existsSync(BUILDER)) {
    const driverLines = new Set(ps1.split(/\r?\n/).map(l => l.trim()));
    const lost = fs.readFileSync(BUILDER, 'utf8').split(/\r?\n/).map(l => l.trim())
        .filter(l => l && !driverLines.has(l))
        .filter(l => !/^exit (2|\$exitCode)$/.test(l));
    // The four allowed rewrites: the provenance comment (privacy scrub), three guarded lines.
    const allowed = [/^# This script is copied between/, /^# `<repo>/, /^# resolves to the wrong directory/, /^# sits one level further up/,
        /^\[string\]\$TargetNetId$/, /^if \(-not \$SlnPath\) \{$/, /^try \{$/, /^\} catch \{ \}$/, /^foreach \(\$w in /, /^if \(-not \$didSwitchVersion\) \{$/,
        /^catch \{ \$activationFault = "\$_" \}$/, /^if \(-not \$uiWasSuppressed\) /,
        // Real paths go to -LiteralPath (a folder named 'Line [2]' is not a wildcard); a UNC solution
        // needs ProviderPath, not the provider-qualified Path.
        /^return \(Resolve-Path -LiteralPath \$candidate\)\.Path$/, /(Get-ChildItem|Select-String) -Path \$/, /^if \(-not \(Test-Path \$SlnPath\)\)/,
        // The error list and the output panes are read with Invoke-ComRetry, one item at a time.
        // (The output panes are read by Get-OutputPaneTexts, the same function in both.)
        /^\$items = \$dte\.ToolWindows/, /^for \(\$N = 1; \$N -le \$items\.Count/, /^\$it = \$items\.Item/];
    const unexplained = lost.filter(l => !allowed.some(re => re.test(l)));
    assert(unexplained.length === 0, `the adaptation is additive: no builder line lost without a reason (${unexplained.slice(0, 3).join(' | ') || 'none'})`);
    assert(fs.readFileSync(BUILDER, 'utf8').includes('# This script is copied between projects'), 'the builder itself is untouched');
}

// ── Real paths are literal; the shell census gates every DTE call ──────────────────────────────
{
    const code = ps1.replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
    const wildcard = [...code.matchAll(/(Get-ChildItem|Select-String|Test-Path|Get-Content|Resolve-Path)\s+(?:-Path\s+)?(\$[A-Za-z]+|\(Split-Path)/g)]
        .filter(m => !/^\$(ProgId)$/.test(m[2]))
        .map(m => m[0]);
    assert(wildcard.length === 0, `no real path goes to a wildcard -Path parameter (${wildcard.join(' | ') || 'none'})`);
    assert(!/Test-Path \$SlnPath/.test(code) && /Test-Path -LiteralPath \$SlnPath -PathType Leaf/.test(code), 'the solution is checked with Test-Path -LiteralPath');
    assert(/\(Resolve-Path -LiteralPath \$candidate\)\.ProviderPath/.test(code) && !/\(Resolve-Path [^)]*\)\.Path\b/.test(code),
        'Resolve-Path output is used as ProviderPath (UNC solutions)');
    const census = code.indexOf("Emit-Event 'shell'");
    const refuse = code.indexOf("Emit-Fatal 'shell-not-ours'");
    const firstDteWrite = code.indexOf('$dte.SuppressUI = ');
    assert(census > 0 && refuse > census && refuse < firstDteWrite && /if \(-not \$ownShellPid -and \$shellsBefore\.Count -gt 0\)/.test(code),
        'a shell that is not provably ours while others run is refused before SuppressUI, Open or Close');
    assert(/if \(\$dte -and \$script:ForeignShell\) \{[\s\S]*?ReleaseComObject[\s\S]*?\}\s*elseif \(\$dte\) \{\s*try \{ \$dte\.Solution\.Close\(\$false\) \}/.test(code),
        'the finally neither closes the solution nor quits a foreign shell');
    assert(/leaving the XAE Shell open[\s\S]{0,300}SuppressUI = \$false[\s\S]{0,120}MainWindow\.Visible = \$true/.test(code),
        'an unidentified shell that is left running is made visible again');
    const errorList = code.slice(code.indexOf("Enter-Phase 'errors'"), code.indexOf('BUILD SUCCEEDED'));
    assert(/Invoke-ComRetry -MaxTries 10 \{ \$dte\.ToolWindows\.ErrorList \}/.test(errorList)
        && /Invoke-ComRetry -MaxTries 10 \{ \$items\.Count \}/.test(errorList) && /Invoke-ComRetry -MaxTries 10 \{ \$items\.Item\(\$N\) \}/.test(errorList),
        'the error list is read with retries');
    // Invoke-ComRetry's `return` writes to the pipeline, which can enumerate a COM collection: a
    // one-item ErrorItems would come back as the bare item. It is assigned directly instead.
    assert(/try \{ \$items = \$errorList\.ErrorItems; break \}/.test(errorList) && !/Invoke-ComRetry[^\n]*\{ [^}\n]*\.ErrorItems \}/.test(errorList),
        'ErrorItems is read by plain assignment, never as an Invoke-ComRetry result');
    assert(/\$paneRead = Get-OutputPaneTexts -Dte \$dte/.test(errorList) && !/\.OutputWindowPanes/.test(errorList),
        'the output panes are read only through Get-OutputPaneTexts');
    // C (user run 2026-11-13, headless on 4026): no error items, the Output window $null. Each step
    // gives a reason, and the reasons reach the extension as one event.
    assert(/Emit-Event 'errorDetails' \(\[ordered\]@\{ errorItems = \$errorItemsRead; outputPanes = @\(\$paneRead\.Panes\)\.Count\s+reasons = \[string\[\]\]\$detailReasons \}\)/.test(errorList),
        'a failed build emits errorDetails (items read, panes read, reasons)');
    for (const reason of ['the error list window is not available', 'the error list has no item collection', 'the error list is empty', 'the error list could not be read']) {
        assert(errorList.includes(reason), `error-list reason: ${reason}`);
    }
}

// ── Get-OutputPaneTexts: every null guarded, the same function in all three copies ──────────────
{
    const fnOf = (text) => {
        const t = text.replace(/\r\n/g, '\n');
        const at = t.indexOf('function Get-OutputPaneTexts {');
        return at < 0 ? '' : t.slice(at, t.indexOf('\n}\n', at) + 2);
    };
    const fn = fnOf(ps1);
    assert(fn.length > 0, 'the driver defines Get-OutputPaneTexts');
    assert(fn.indexOf('$Dte.ToolWindows.OutputWindow') > 0 && fn.indexOf('$Dte.ToolWindows.OutputWindow') < fn.indexOf("$Dte.Windows.Item('{34E76E81-EE4A-11D0-AE2E-00A0C90FFFC3}')"),
        'ToolWindows.OutputWindow first, the Windows.Item route as the fallback');
    for (const guard of ['if ($null -ne $ow)', 'if ($null -ne $win)', 'if ($null -ne $wo)', 'if ($null -eq $doc)', 'if ($null -eq $sel)', 'Where-Object { $null -ne $_ }']) {
        assert(fn.includes(guard), `Get-OutputPaneTexts guards a null: ${guard}`);
    }
    for (const reason of ['the Output window is not available (XAE window hidden)', 'has no text document', 'has no selection', 'text not readable', 'every Output window pane was empty']) {
        assert(fn.includes(reason), `Get-OutputPaneTexts reason: ${reason}`);
    }
    // No method is called on anything that was not null-checked first: the raw PowerShell error
    // ("cannot call a method on a null-valued expression") is what the user saw.
    assert(!/\$pane\.TextDocument\.Selection/.test(fn) && !/\.Object\)?\.OutputWindowPanes/.test(fn), 'no unguarded chain through TextDocument or Window.Object');
    for (const copy of [BUILDER, path.join(REPO, 'templates', 'build_plc_project.ps1')]) {
        const text = fs.readFileSync(copy, 'utf8');
        assert(fnOf(text) === fn, `${path.relative(REPO, copy)} has the same Get-OutputPaneTexts`);
        assert(/\$paneRead = Get-OutputPaneTexts -Dte \$dte/.test(text) && !/foreach \(\$pane in \$ow\.OutputWindowPanes\)/.test(text),
            `${path.relative(REPO, copy)} reads the panes through it`);
        assert(![...text].some(ch => ch.charCodeAt(0) > 127) && /\r\n/.test(text) && !/[^\r]\n/.test(text), `${path.relative(REPO, copy)} stays ASCII and CRLF`);
    }
    assert(/\r\n/.test(ps1) && !/[^\r]\n/.test(ps1), 'the driver stays CRLF');
}

// ── The system project: .tsproj, or .tspproj (a TwinCAT project saved as separate files) ─────────
// User report 2026-11-13: TcToolkitSample2 has only a .tspproj, and the driver stopped with "no .tsproj".
{
    const lookups = ps1.match(/Get-ChildItem -LiteralPath [^\n]*-Recurse[^\n]*\r?\n[^\n]*/g) || [];
    const sysLookups = lookups.filter(l => /tsproj/.test(l));
    assert(sysLookups.length === 2 && sysLookups.every(l => /'\.tsproj'/.test(l) && /'\.tspproj'/.test(l)),
        `both system-project lookups accept .tsproj and .tspproj (${sysLookups.length})`);
    assert(!/-Filter \*\.tsproj\b/.test(ps1), 'no lookup filters on *.tsproj alone');
    const tsp = fs.readdirSync(path.join(REPO, 'sample', 'TcToolkitSample2', 'TcToolkitSample2')).filter(f => f.endsWith('.tspproj'));
    const tspText = fs.readFileSync(path.join(REPO, 'sample', 'TcToolkitSample2', 'TcToolkitSample2', tsp[0]), 'utf8');
    assert(tsp.length === 1 && /TcVersion="(3\.1\.(\d+)\.\d+)"/.test(tspText), 'sample 2 has a .tspproj the driver\'s TcVersion pattern reads');
}

// ── The missing-shell fatal names the installed shells (user decision 2026-11-13) ───────────────
// The extension offers the newest of `installed` for a build and re-runs with -TcVersion <ProgId>
// -AllowVersionMismatch; the ProgId table it names them from must be the driver's own.
{
    const { XAE_SHELL_VERSIONS } = require('../src/xaeShellDetect');
    const table = (text) => {
        const body = (/\$ProgIdByBuild = @\{([\s\S]*?)\}/.exec(text) || [])[1] || '';
        return Object.fromEntries([...body.matchAll(/'(\d+)'\s*=\s*'([^']+)'/g)].map(m => [m[1], m[2]]));
    };
    const driverTable = table(ps1);
    assert(JSON.stringify(driverTable) === JSON.stringify(Object.fromEntries(XAE_SHELL_VERSIONS.map(v => [v.id, v.progId]))),
        `the driver's $ProgIdByBuild is XAE_SHELL_VERSIONS' id → progId (${JSON.stringify(driverTable)})`);
    const block = (text) => {
        const at = text.indexOf('if (-not (Test-Path "Registry::HKEY_CLASSES_ROOT\\$ProgId")) {');
        return at < 0 ? '' : text.slice(at, text.indexOf('\n}', at));
    };
    const fatal = block(ps1);
    assert(/foreach \(\$b in @\(\$ProgIdByBuild\.Keys \| Sort-Object \{ \[int\]\$_ \} -Descending\)\)/.test(fatal)
        && /Test-Path -LiteralPath "Registry::HKEY_CLASSES_ROOT\\\$p"/.test(fatal) && /\$installedShells\.Add\(\$p\)/.test(fatal),
        'the fatal lists every mapped ProgId registered in HKCR, newest build first (-LiteralPath)');
    assert(/Emit-Fatal 'progid-not-registered'[\s\S]*progId\s+= \$ProgId[\s\S]*build\s+= \$target\.Build[\s\S]*projectVersion = \$target\.ProjectVersion[\s\S]*installed\s+= \[string\[\]\]\$installedShells\.ToArray\(\)/.test(fatal),
        'the progid-not-registered event carries progId, build, projectVersion and installed (a plain string[])');
    for (const copy of [BUILDER, path.join(REPO, 'templates', 'build_plc_project.ps1')]) {
        const b = block(fs.readFileSync(copy, 'utf8'));
        assert(/\$installedShells\.Add\(\$p\)/.test(b) && /Installed XAE Shells: /.test(b) && /No XAE Shell is installed/.test(b),
            `${path.relative(REPO, copy)} prints the installed shells on the same fatal`);
    }
    assert(/Installed XAE Shells: /.test(fatal) && /No XAE Shell is installed/.test(fatal), 'the driver prints them for a human too');
}

// ── Packaging ───────────────────────────────────────────────────────────────────────────────────
{
    const ignore = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const rel = 'resources/xae/build-plc-project.ps1';
    // A minimal glob: `**` any path, `*` one segment.
    const toRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').split('\u0001').join('.*') + '$');
    const hits = ignore.filter(g => !g.startsWith('!') && (toRe(g).test(rel) || toRe(g.replace(/\/\*\*$/, '')).test('resources/xae') || toRe(g).test('resources')));
    assert(hits.length === 0, `.vscodeignore does not exclude ${rel} (${hits.join(', ') || 'no match'})`);
}

console.log(errors === 0 ? '\nAll XAE driver contract tests passed.' : `\n${errors} XAE driver contract test(s) FAILED.`);
process.exit(errors === 0 ? 0 : 1);
