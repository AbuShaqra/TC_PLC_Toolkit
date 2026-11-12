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
    { scriptPath: 's', mode: /** @type {'listTargets'} */ ('listTargets') }
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
        /^catch \{ \$activationFault = "\$_" \}$/, /^if \(-not \$uiWasSuppressed\) /];
    const unexplained = lost.filter(l => !allowed.some(re => re.test(l)));
    assert(unexplained.length === 0, `the adaptation is additive: no builder line lost without a reason (${unexplained.slice(0, 3).join(' | ') || 'none'})`);
    assert(fs.readFileSync(BUILDER, 'utf8').includes('# This script is copied between projects'), 'the builder itself is untouched');
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
