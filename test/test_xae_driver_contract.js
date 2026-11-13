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
        /^\$items = \$dte\.ToolWindows/, /^for \(\$N = 1; \$N -le \$items\.Count/, /^\$it = \$items\.Item/,
        // The builder prints the typed reader's results directly and runs its late-bound reads only
        // when the typed list gave nothing; the driver collects both for its events. The builder has
        // no -ShowWindow, so its window note knows only the version switch.
        /^if \(\$N -eq 0\) \{$/, /^if \(\$didSwitchVersion\) \{ \$windowNote = /, /^Write-Host "--- pane: Build ---"/, /^Write-Host \$typedPane\.Text$/,
        /^Write-Host "output pane read: \$\(\$typedPane\.Reason\)"/, /^foreach \(\$why in \$paneRead\.Reasons\)/, /^foreach \(\$paneText in \$paneRead\.Panes\)/];
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
    assert(/try \{ \$items = \$errorList\.ErrorItems; \$itemsAnswered = \$true; break \}/.test(errorList) && !/Invoke-ComRetry[^\n]*\{ [^}\n]*\.ErrorItems \}/.test(errorList),
        'ErrorItems is read by plain assignment, never as an Invoke-ComRetry result');
    // The hand-written retry behaves like Invoke-ComRetry: a cancel between rejected calls, and a run of
    // rejections reported as such, never as "no item collection".
    const itemsLoop = (/for \(\$t = 1; \$t -le \$itemTries; \$t\+\+\) \{[\s\S]*?\n {12}\}/.exec(errorList) || [''])[0];
    assert(/80010001\|RPC_E_CALL_REJECTED[\s\S]*?Test-CancelRequested\s+Start-Sleep -Seconds 2/.test(itemsLoop), 'the ErrorItems retry checks for a cancel before each wait');
    assert(/elseif \(-not \$itemsAnswered\) \{ \$errorListReason = "the error list was still rejected after \$itemTries tries \(XAE busy\)" \}\s+elseif \(\$null -eq \$items\)/.test(errorList),
        'ErrorItems rejected on every try is reported as rejected, ahead of "no item collection"');
    // A cancel inside the error and Output reads is not a reason: every catch there that can see it
    // rethrows (`code` has its comment lines removed).
    assert(/\$items\.Item\(\$N\) \} \} catch \{ if \("\$_" -eq \$script:CancelSentinel\) \{ throw \}; continue \}/.test(errorList)
        && /\} catch \{\s+if \("\$_" -eq \$script:CancelSentinel\) \{ throw \}\s+\$why = /.test(errorList),
        'the error-list reads rethrow a cancel (item read, outer catch)');
    assert(/Emit-Event 'errorDetails'[\s\S]*?\}\)\s+\}\s+Test-CancelRequested/.test(errorList),
        'a cancel during the error and Output reads ends the run as cancelled (checked before the result)');
    assert(/\$paneRead = Get-OutputPaneTexts -Dte \$dte -WindowNote \$windowNote/.test(errorList) && !/\.OutputWindowPanes/.test(errorList),
        'the late-bound output panes are read only through Get-OutputPaneTexts, with the run\'s window note');
    // C (user run 2026-11-13, headless on 4026): no error items, the Output window $null. Each step
    // gives a reason, and the reasons reach the extension as one event, with the route that worked.
    assert(/Emit-Event 'errorDetails' \(\[ordered\]@\{ errorItems = \$errorItemsRead; outputPanes = \$paneTexts\.Count\s+reasons = \[string\[\]\]\$detailReasons; route = \$route; errorListRoute = \$errorListRoute; outputRoute = \$outputRoute \}\)/.test(errorList),
        'a failed build emits errorDetails (items read, panes read, reasons, route)');
    // The typed reader first (Beckhoff Infosys: late binding does not resolve ErrorItems), then the
    // late-bound reads only when it gave nothing; the route says which worked.
    const typedAt = errorList.indexOf('$typedErrors = Read-TypedErrorList -Dte $dte -ProgId $ProgId');
    const lateAt = errorList.indexOf('$dte.ToolWindows.ErrorList }');
    assert(typedAt > 0 && lateAt > typedAt && /if \(\$errorItemsRead -gt 0\) \{ \$errorListRoute = 'typed' \}\s+else \{/.test(errorList),
        'the typed error list is read first; the late-bound one only when it gave no item');
    assert(/if \(\$errorItemsRead -gt 0\) \{ \$errorListRoute = 'late-bound' \}/.test(errorList), 'the late-bound route is named when it gave items');
    assert(errorList.indexOf('Read-TypedErrorList') < errorList.indexOf('if ($failed -ne 0)'),
        'the typed error list is read after every build, a successful one included (warnings)');
    const typedPaneAt = errorList.indexOf('$typedPane = Read-TypedBuildPane -Dte $dte -ProgId $ProgId');
    assert(typedPaneAt > errorList.indexOf('if ($failed -ne 0)') && typedPaneAt < errorList.indexOf('Get-OutputPaneTexts -Dte'),
        'on failure the typed Build pane is read before the late-bound panes');
    assert(/if \(\$errorListRoute -eq 'typed' -or \$outputRoute -eq 'typed'\) \{ \$route = 'typed' \}\s+elseif \(\$errorListRoute -eq 'late-bound' -or \$outputRoute -eq 'late-bound'\) \{ \$route = 'late-bound' \}/.test(errorList)
        && /\$route = 'none'/.test(errorList), "route: 'typed' | 'late-bound' | 'none'");
    // The typed items keep the errorItem shape, so placement is unchanged.
    assert(/Emit-Event 'errorItem' \(\[ordered\]@\{ file = \$row\.file; line = \$row\.line; column = \$row\.column; description = \$row\.description; project = \$row\.project; level = \$row\.level \}\)/.test(errorList),
        'a typed item is emitted with the errorItem fields');
    // B: the "not available" reason names the run's real window mode, never "hidden" for a shown window.
    assert(/\$windowNote = 'XAE window hidden'\s+if \(\$ShowWindow\) \{ \$windowNote = 'XAE window shown' \}\s+elseif \(\$didSwitchVersion\) \{ \$windowNote = 'XAE window kept visible after a version switch' \}/.test(errorList),
        'the window note follows -ShowWindow and the version switch');
    for (const reason of ['the error list window is not available', 'the error list was still rejected after', 'the error list has no item collection', 'the error list is empty', 'the error list could not be read']) {
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
    assert(!fn.includes('(XAE window hidden)') && /param\(\[Parameter\(Mandatory\)\]\$Dte, \[string\]\$WindowNote\)/.test(fn)
        && fn.includes('[void]$reasons.Add("the Output window is not available ($WindowNote)")'),
        'Get-OutputPaneTexts takes the window mode from its caller (no hard-coded "XAE window hidden")');
    for (const reason of ['the Output window is not available', 'has no text document', 'has no selection', 'text not readable', 'every Output window pane was empty']) {
        assert(fn.includes(reason), `Get-OutputPaneTexts reason: ${reason}`);
    }
    // No method is called on anything that was not null-checked first: the raw PowerShell error
    // ("cannot call a method on a null-valued expression") is what the user saw.
    assert(!/\$pane\.TextDocument\.Selection/.test(fn) && !/\.Object\)?\.OutputWindowPanes/.test(fn), 'no unguarded chain through TextDocument or Window.Object');
    // A cancel thrown by Invoke-ComRetry is not a null: every catch around one rethrows it first.
    const comCatches = [...fn.matchAll(/Invoke-ComRetry[^\n]*\} catch \{([^\n]*)\}/g)].map(m => m[1]);
    assert(comCatches.length === 7 && comCatches.every(c => /^ if \("\$_" -eq \$script:CancelSentinel\) \{ throw \}; /.test(c)),
        `every one-line catch around Invoke-ComRetry in Get-OutputPaneTexts rethrows a cancel (${comCatches.length})`);
    assert(/\} catch \{\s+if \("\$_" -eq \$script:CancelSentinel\) \{ throw \}\s+\$why = [^\n]*\s+\[void\]\$reasons\.Add\("pane '\$name' text not readable/.test(fn),
        'the pane-text catch rethrows a cancel too');
    for (const copy of [BUILDER, path.join(REPO, 'templates', 'build_plc_project.ps1')]) {
        const text = fs.readFileSync(copy, 'utf8');
        assert(fnOf(text) === fn, `${path.relative(REPO, copy)} has the same Get-OutputPaneTexts`);
        assert(/\$paneRead = Get-OutputPaneTexts -Dte \$dte/.test(text) && !/foreach \(\$pane in \$ow\.OutputWindowPanes\)/.test(text),
            `${path.relative(REPO, copy)} reads the panes through it`);
        assert(![...text].some(ch => ch.charCodeAt(0) > 127) && /\r\n/.test(text) && !/[^\r]\n/.test(text), `${path.relative(REPO, copy)} stays ASCII and CRLF`);
    }
    assert(/\r\n/.test(ps1) && !/[^\r]\n/.test(ps1), 'the driver stays CRLF');
}

// ── The typed DTE reader (Beckhoff Infosys "Reading the VS output and the error list") ─────────
// Late binding does not resolve ErrorList.ErrorItems in PowerShell; C# through EnvDTE does. The four
// functions are the same text in all three copies, and every step fails softly with a one-line reason.
{
    const fnOf = (text, name) => {
        const t = text.replace(/\r\n/g, '\n');
        const at = t.indexOf(`function ${name} {`);
        if (at < 0) return '';
        // A function ends at the first `}` in column 0 after it, past its C# here-string (whose class
        // brace is in column 0 too) when it has one.
        const next = t.indexOf('\n<#', at + 1);
        const hereEnd = t.indexOf("\n'@", at);
        const from = hereEnd > 0 && (next < 0 || hereEnd < next) ? hereEnd : at;
        return t.slice(at, t.indexOf('\n}\n', from) + 2);
    };
    const names = ['Get-XaeShellInstallDir', 'Initialize-TypedDteReader', 'Read-TypedErrorList', 'Read-TypedBuildPane'];
    const fns = Object.fromEntries(names.map(n => [n, fnOf(ps1, n)]));
    for (const n of names) assert(fns[n].length > 0, `the driver defines ${n}`);
    for (const copy of [BUILDER, path.join(REPO, 'templates', 'build_plc_project.ps1')]) {
        const text = fs.readFileSync(copy, 'utf8');
        for (const n of names) assert(fnOf(text, n) === fns[n], `${path.relative(REPO, copy)} has the same ${n}`);
        const code = text.replace(/\r\n/g, '\n');
        const typed = code.indexOf('$typedErrors = Read-TypedErrorList -Dte $dte -ProgId $ProgId');
        assert(typed > 0 && typed < code.indexOf('$items = $dte.ToolWindows.ErrorList.ErrorItems') && /if \(\$N -eq 0\) \{/.test(code),
            `${path.relative(REPO, copy)} reads the typed error list first, the late-bound one only when it gave nothing`);
        const pane = code.indexOf('$typedPane = Read-TypedBuildPane -Dte $dte -ProgId $ProgId');
        assert(pane > 0 && pane < code.indexOf('$paneRead = Get-OutputPaneTexts -Dte $dte -WindowNote $windowNote'),
            `${path.relative(REPO, copy)} reads the typed Build pane before the late-bound panes, with its window note`);
        assert(!code.includes('(XAE window hidden)') && /\$windowNote = 'XAE window hidden'\n\s+if \(\$didSwitchVersion\) \{ \$windowNote = 'XAE window kept visible after a version switch' \}/.test(code),
            `${path.relative(REPO, copy)}: the window note follows the version switch`);
    }
    const shellDir = fns['Get-XaeShellInstallDir'];
    assert(/Registry::HKEY_CLASSES_ROOT\\\$ProgId\\CLSID/.test(shellDir) && /'HKEY_CLASSES_ROOT\\CLSID', 'HKEY_CLASSES_ROOT\\WOW6432Node\\CLSID'/.test(shellDir)
        && /\\LocalServer32"/.test(shellDir), 'the shell folder comes from the ProgId\'s LocalServer32 (64-bit view, then the 32-bit one for 4024)');
    assert(/"\$pf\\Beckhoff\\TcXaeShell"/.test(shellDir) && /if \(\$ProgId -eq 'TcXaeShell\.DTE\.15\.0'\) \{ \$candidates = @\("\$pf86\\Beckhoff\\TcXaeShell"\) \}/.test(shellDir),
        'then Program Files\\Beckhoff\\TcXaeShell (4026+), Program Files (x86) for the 32-bit 4024 shell');
    assert(!/Test-Path (?!-LiteralPath)/.test(shellDir), 'every registry and file test is -LiteralPath');

    const init = fns['Initialize-TypedDteReader'];
    assert(/if \(\$script:TypedDteTried\) \{ return \$script:TypedDteType \}\s+\$script:TypedDteTried = \$true/.test(init),
        'Add-Type is attempted once per run (a failure included)');
    const typeName = (/\$typeName = '([A-Za-z0-9]+)'/.exec(init) || [])[1];
    assert(typeName && new RegExp(`public class ${typeName}\\b`).test(init)
        && init.indexOf('$loaded = $typeName -as [type]') > 0 && init.indexOf('$loaded = $typeName -as [type]') < init.indexOf('Add-Type '),
        `a type ${typeName} already loaded in the session is reused, never compiled again under the same name`);
    assert(/Join-Path \$folder 'Common7\\IDE\\PublicAssemblies'/.test(init) && /@\('EnvDTE\.dll', 'EnvDTE80\.dll'\)/.test(init)
        && /Microsoft\.VisualStudio\.Interop\.dll/.test(init) && /\[System\.Reflection\.Assembly\]::LoadFrom\(\$p\)/.test(init),
        'EnvDTE, EnvDTE80 (and Microsoft.VisualStudio.Interop when found) from PublicAssemblies, loaded with LoadFrom');
    assert(/Add-Type -ReferencedAssemblies \(\[string\[\]\]\$refs\.ToArray\(\)\) -TypeDefinition \$source -ErrorAction Stop/.test(init),
        'the helper is compiled with Add-Type -ReferencedAssemblies -TypeDefinition');
    for (const [reason, what] of [
        ['"assembly not found: $p"', 'assembly not found (names the path)'],
        ['"Add-Type failed ($why)"', 'Add-Type failed (its message)'],
        ['"the XAE Shell folder of $ProgId was not found', 'no shell folder'],
        ['"the cast to DTE2 failed"', 'cast failed'],
        ['"the error list is empty"', 'no items'],
        ['"the Output window has no pane named \'Build\'"', 'no Build pane']
    ]) assert(init.includes(reason), `typed reader reason: ${what}`);
    assert(/EnvDTE80\.DTE2 d2 = Unwrap\(dte\) as EnvDTE80\.DTE2;/.test(init) && /public static ErrorRead ReadErrors\(object dte\)/.test(init),
        'the DTE arrives as object and is cast to DTE2');
    assert(/EnvDTE80\.ErrorItems items = list\.ErrorItems;/.test(init) && /for \(int i = 1; i <= r\.Count; i\+\+\)/.test(init) && /it = items\.Item\(i\);/.test(init),
        'ErrorItems.Item(i) for i = 1..Count');
    for (const f of ['ErrorLevel', 'Description', 'FileName', 'Line', 'Column', 'Project']) {
        assert(new RegExp(`public string ${f};`).test(init), `a row carries ${f} as a string`);
    }
    assert(/tw\.OutputWindow;/.test(init) && /ow\.OutputWindowPanes;/.test(init) && /p\.Name == "Build"/.test(init)
        && /build\.TextDocument;/.test(init) && /doc\.Selection;/.test(init)
        && /sel\.StartOfDocument\(false\);\s+sel\.EndOfDocument\(true\);\s+string text = sel\.Text;/.test(init),
        'the Output window\'s pane named exactly "Build": TextDocument.Selection, StartOfDocument(false), EndOfDocument(true), Text');
    assert(/return hr == 0x80010001 \|\| hr == 0x8001010A;/.test(init) && /catch \(Exception e\) \{ if \(IsBusy\(e\)\) throw; continue; \}/.test(init),
        'a busy shell inside the C# loop is rethrown for Invoke-ComRetry, any other item error loses only that item');
    for (const n of ['Read-TypedErrorList', 'Read-TypedBuildPane']) {
        const fn = fns[n];
        assert(/Initialize-TypedDteReader -ProgId \$ProgId/.test(fn) && /Invoke-ComRetry -MaxTries 10 \{ \$type::Read[A-Za-z]+\(\$Dte\.psobject\.BaseObject\) \}/.test(fn),
            `${n}: compiled once, called through Invoke-ComRetry with the unwrapped DTE`);
        assert(/catch \{\s+if \("\$_" -eq \$script:CancelSentinel\) \{ throw \}\s+\$why = /.test(fn), `${n}: a cancel is rethrown, any other failure is a reason`);
    }
    // The errorItem shape is kept: Line and Column become ints (or null), empty strings null.
    assert(/\[pscustomobject\]@\{\s+file = [^\n]+line = \$line; column = \$column\s+description = [^\n]+project = [^\n]+\s+level = /.test(fns['Read-TypedErrorList']),
        'Read-TypedErrorList returns the errorItem fields');
}

// ── The system project: .tsproj, or .tspproj (a TwinCAT project saved as separate files) ─────────
// User report 2026-11-13: TcToolkitSample2 has only a .tspproj, and the driver stopped with "no .tsproj".
// Two provider-side -Filter lookups merged before the sort (a Where-Object over every file under the
// solution folder builds an object per file), in the driver (both) and every copy.
{
    const copies = [
        ['the driver', ps1, 2, 'LiteralPath'],
        ['the builder', fs.readFileSync(BUILDER, 'utf8'), 1, 'Path'],
        ['templates/', fs.readFileSync(path.join(REPO, 'templates', 'build_plc_project.ps1'), 'utf8'), 1, 'Path'],
        ['probe-sysmanager.ps1', fs.readFileSync(path.join(REPO, 'scripts', 'Build PLC project', 'probe-sysmanager.ps1'), 'utf8'), 1, 'Path']
    ];
    for (const [name, text, count, param] of copies) {
        const pairs = [...text.matchAll(/= \(@\(Get-ChildItem -(\w+) ([^\n]+?) -Recurse -Filter \*\.tsproj -File -ErrorAction SilentlyContinue\) \+\r?\n\s+@\(Get-ChildItem -(\w+) ([^\n]+?) -Recurse -Filter \*\.tspproj -File -ErrorAction SilentlyContinue\)\) \|\r?\n\s+Sort-Object FullName -Unique \| Select-Object -First 1/g)];
        assert(pairs.length === count && pairs.every(m => m[1] === param && m[3] === param && m[2] === m[4]),
            `${name}: ${count} system-project lookup(s), -Filter *.tsproj and *.tspproj merged before Sort-Object (-${param})`);
        assert(!/Where-Object \{ \$_\.Extension -eq '\.tsproj'/.test(text) && !/-Filter \*\.tsp\*proj/.test(text),
            `${name}: no Where-Object over every file, no 8.3-prone *.tsp*proj filter`);
    }
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
        // The same census as the driver's: every mapped ProgId, newest first, tested literally in HKCR.
        assert(/foreach \(\$b in @\(\$ProgIdByBuild\.Keys \| Sort-Object \{ \[int\]\$_ \} -Descending\)\)/.test(b)
            && /Test-Path -LiteralPath "Registry::HKEY_CLASSES_ROOT\\\$p"/.test(b),
            `${path.relative(REPO, copy)} runs the same census (newest first, -LiteralPath)`);
        assert(JSON.stringify(table(fs.readFileSync(copy, 'utf8'))) === JSON.stringify(driverTable), `${path.relative(REPO, copy)} has the driver's $ProgIdByBuild`);
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
