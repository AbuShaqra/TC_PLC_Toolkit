/**
 * @file test_xae_build.js
 * @description The vscode-free half of Build through XAE (roadmap R14): src/xaeBuild.js and
 * src/xaeBuildSettings.js, against the synthetic driver fixtures in test/fixtures/xae/.
 *
 * Pinned: the driver argv (headless unless `showWindow === true`, exactly one `-ShowWindow` when it
 * is; `-STA`, `-NonInteractive`, `-ExecutionPolicy Bypass` always; never `-TcVersion`; activation only
 * with a valid NetId), the line splitter (CRLF, a split inside the prefix and inside a UTF-8
 * character, a last line with no newline), parseLine, the reducer over every fixture, describeExit
 * for every exit code and outcome, describeUiMode for every mode, canCancel, isStalled, the target
 * pick and the confirmation text, and the settings reader.
 */

'use strict';

const x = require('../src/xaeBuild');
const { readXaeBuildSettings, XAE_BUILD_DEFAULTS } = require('../src/xaeBuildSettings');
const { placeXaeErrors, placementSummary } = require('../src/xaeErrorPlacement');
const { readFixture, renderStdout } = require('./_fakeXaeDriver');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}
const count = (arr, v) => arr.filter(a => a === v).length;

// ── buildDriverArgs: the right parameter for each setting value ─────────────────────────────────
{
    const base = { scriptPath: 'C:\\ext\\resources\\xae\\build-plc-project.ps1', slnPath: 'C:\\w\\S.sln' };
    const off = x.buildDriverArgs({ ...base, showWindow: false });
    const on = x.buildDriverArgs({ ...base, showWindow: true });
    const undef = x.buildDriverArgs({ ...base });
    assert(count(off, '-ShowWindow') === 0, 'showWindow:false → no -ShowWindow (headless)');
    assert(count(on, '-ShowWindow') === 1, 'showWindow:true → exactly one -ShowWindow');
    assert(count(undef, '-ShowWindow') === 0, 'showWindow undefined → headless');
    assert(count(x.buildDriverArgs({ ...base, showWindow: /** @type {any} */ ('true') }), '-ShowWindow') === 0, 'a non-boolean "true" is headless too');
    for (const a of [off, on]) {
        assert(a.includes('-STA') && a.includes('-NonInteractive') && a.includes('-NoProfile') && a[a.indexOf('-ExecutionPolicy') + 1] === 'Bypass',
            '-STA, -NonInteractive, -NoProfile and -ExecutionPolicy Bypass are present');
        assert(a[a.indexOf('-File') + 1] === base.scriptPath && a[a.indexOf('-SlnPath') + 1] === base.slnPath && a.includes('-Json'), 'the script, the solution and -Json');
        assert(!a.includes('-TcVersion') && !a.includes('-AllowVersionMismatch'), 'never -TcVersion or -AllowVersionMismatch');
        assert(!a.includes('-ActivateConfiguration') && !a.includes('-TargetNetId'), 'a build never activates');
    }
    const cfg = x.buildDriverArgs({ ...base, configuration: 'Debug', platform: 'TwinCAT OS (x64)', cancelFile: 'C:\\t\\c' });
    assert(cfg[cfg.indexOf('-Configuration') + 1] === 'Debug' && cfg[cfg.indexOf('-Platform') + 1] === 'TwinCAT OS (x64)'
        && cfg[cfg.indexOf('-CancelFile') + 1] === 'C:\\t\\c', 'configuration, platform (one argv entry with its spaces) and cancel file');
    const act = x.buildDriverArgs({ ...base, mode: 'activate', targetNetId: '198.51.100.4.1.1' });
    assert(act.includes('-ActivateConfiguration') && act[act.indexOf('-TargetNetId') + 1] === '198.51.100.4.1.1', 'activate passes the confirmed NetId');
    for (const bad of [undefined, '', '1.2.3.4.5', '1.2.3.4.5.256', '1.2.3.4.5.6 ', 'a.b.c.d.e.f']) {
        let threw = false;
        try { x.buildDriverArgs({ ...base, mode: 'activate', targetNetId: bad }); } catch (e) { threw = true; }
        assert(threw, `activate refuses NetId ${JSON.stringify(bad)}`);
    }
    const list = x.buildDriverArgs({ scriptPath: base.scriptPath, mode: 'listTargets', showWindow: true });
    assert(list.includes('-ListTargets') && !list.includes('-ShowWindow') && !list.includes('-SlnPath'), 'listTargets: no COM flags, no solution needed');
    let threw = false;
    try { x.buildDriverArgs({ scriptPath: base.scriptPath }); } catch (e) { threw = true; }
    assert(threw, 'a build without a solution is refused');
}

// ── createLineSplitter ──────────────────────────────────────────────────────────────────────────
{
    const got = [];
    const s = x.createLineSplitter(l => got.push(l));
    const bytes = Buffer.from('a\r\n@@TCTK {"v":1,"t":"warning","text":"Ger\u00e4t"}\r\nplain \u00fc\nlast', 'utf8');
    // Split inside the prefix ("@@TC|TK") and inside the two-byte ü.
    const cut1 = bytes.indexOf('@@TC') + 4;
    const cut2 = bytes.indexOf(Buffer.from('\u00fc', 'utf8')) + 1;
    s.push(bytes.subarray(0, cut1)); s.push(bytes.subarray(cut1, cut2)); s.push(bytes.subarray(cut2));
    assert(got.length === 3, 'three complete lines before end()');
    s.end();
    assert(JSON.stringify(got) === JSON.stringify(['a', '@@TCTK {"v":1,"t":"warning","text":"Ger\u00e4t"}', 'plain \u00fc', 'last']),
        'CRLF and LF, a split prefix, a split UTF-8 character, and a last line without newline');
    const one = [];
    const s1 = x.createLineSplitter(l => one.push(l));
    for (const b of Buffer.from('x\r\n')) s1.push(Buffer.from([b]));
    s1.end();
    assert(JSON.stringify(one) === '["x"]', 'byte-by-byte CRLF gives one line, no stray \\r');
}

// ── parseLine ───────────────────────────────────────────────────────────────────────────────────
{
    assert(x.parseLine('hello').kind === 'log', 'a plain line is a log line');
    const ev = x.parseLine('@@TCTK {"v":1,"t":"phase","name":"build"}');
    assert(ev.kind === 'event' && /** @type {any} */ (ev).event.name === 'build', 'a prefixed event');
    const bad = /** @type {any} */ (x.parseLine('@@TCTK {nope'));
    assert(bad.kind === 'log' && bad.protocolError, 'bad JSON → log + protocol error');
    const v2 = /** @type {any} */ (x.parseLine('@@TCTK {"v":2,"t":"phase"}'));
    assert(v2.kind === 'log' && /version/.test(v2.protocolError), 'unknown v → log + protocol error');
    assert(/** @type {any} */ (x.parseLine('@@TCTK [1]')).protocolError, 'an array is not an event');
    assert(x.parseLine(/** @type {any} */ (undefined)).kind === 'log', 'never throws');
}

// ── reduce over every fixture (through the real splitter and parser) ────────────────────────────
/** @param {string} name @param {any} [o] */
function run(name, o) {
    const fx = readFixture(name);
    const state = x.createRunState(o);
    const s = x.createLineSplitter(l => x.reduce(state, x.parseLine(l), 1000));
    s.push(renderStdout(fx.lines));
    s.end();
    return { state, exit: fx.exit };
}
{
    const ok = run('build-ok-headless');
    assert(ok.state.mode === 'build' && ok.state.showWindow === false && ok.state.shell.ours && ok.state.shell.pid === 4242, 'build-ok-headless: hello and shell');
    assert(ok.state.failedProjects === 0 && ok.state.done.exitCode === 0 && ok.state.phase === 'close' && ok.state.plan.progId === 'TcXaeShell.DTE.17.0', 'build-ok-headless: result, done, plan');
    assert(ok.state.log.includes('BUILD SUCCEEDED.') && ok.state.protocolWarnings === 0, 'plain lines are kept; no protocol warnings');
    const d = x.describeExit(ok.exit, 'exit', ok.state);
    assert(d.ok && d.severity === 'info' && /succeeded/.test(d.title), 'describeExit 0');
    assert(/hidden \(SuppressUI=True, MainWindow\.Visible=False\) - headless\./.test(x.describeUiMode(ok.state)), 'describeUiMode: headless');

    const vis = run('build-ok-visible');
    assert(/visible \(requested\) \(SuppressUI=False, MainWindow\.Visible=True\)/.test(x.describeUiMode(vis.state)), 'describeUiMode: visible (requested)');
    const sw = run('version-switch-headless');
    assert(/kept visible after a version switch/.test(x.describeUiMode(sw.state)), 'describeUiMode: version switch');
    const mismatch = x.createRunState();
    x.reduce(mismatch, x.parseLine('@@TCTK {"v":1,"t":"ui","requested":"headless","suppressUI":true,"mainWindowVisible":true,"reason":"build"}'));
    assert(/^Headless requested but the window was visible/.test(x.describeUiMode(mismatch)) && /HANDOFF Windows check/.test(x.describeUiMode(mismatch)),
        'describeUiMode: headless requested, window visible → points at the Windows check');
    const unread = x.createRunState();
    x.reduce(unread, x.parseLine('@@TCTK {"v":1,"t":"ui","requested":"headless","suppressUI":null,"mainWindowVisible":null,"reason":"build"}'));
    assert(/UI state unreadable/.test(x.describeUiMode(unread)) && /unreadable/.test(x.describeUiMode(x.createRunState())), 'describeUiMode: unreadable');

    const err = run('errors-errorlist');
    assert(err.state.errorItems.length === 3 && err.state.errorItems[0].line === 3 && err.state.errorItems[1].column === null
        && err.state.errorItems[2].file === null && err.state.panes.length === 1, 'errors-errorlist: items and pane');
    const de = x.describeExit(1, 'exit', err.state);
    assert(!de.ok && de.severity === 'error' && /3 errors/.test(de.title), 'describeExit 1 counts the errors');
    const panes = run('errors-panes-only');
    assert(panes.state.errorItems.length === 0 && panes.state.panes[0].text.includes('C0046'), 'errors-panes-only');
    assert(x.describeExit(1, 'exit', panes.state).title === 'Build through XAE failed.', 'describeExit 1 with no error list');

    const cfg = run('config-not-declared');
    assert(cfg.state.fatal.code === 'config-not-declared' && cfg.state.fatal.data.declared.length === 2, 'config-not-declared carries the declared pairs');
    assert(/could not run: 'Release\|TwinCAT RT \(x64\)' is not declared/.test(x.describeExit(2, 'exit', cfg.state).title), 'describeExit 2 names the fatal');
    assert(run('version-mismatch').state.fatal.code === 'version-mismatch', 'version-mismatch');
    const ref = run('target-refused');
    assert(ref.state.fatal.code === 'target-refused' && ref.state.fatal.data.gate === 3, 'target-refused carries the gate');

    const actRun = run('activation-run', { expectedNetId: '198.51.100.4.1.1' });
    assert(actRun.state.activation.outcome === 'run' && actRun.state.activation.adsState === 5 && !actRun.state.targetMismatch, 'activation-run');
    assert(/in RUN/.test(x.describeExit(0, 'exit', actRun.state).title) && /restarted TwinCAT on/.test(x.describeExit(0, 'exit', actRun.state).title),
        'describeExit 0 after activation (TwinCAT used descriptively)');
    assert(/shown for activation/.test(x.describeUiMode(actRun.state)), 'describeUiMode says the window was shown for activation');
    const wrong = run('activation-run', { expectedNetId: '198.51.100.1.1.1' });
    assert(wrong.state.targetMismatch, 'a target readback that differs from the pick is a mismatch');
    const inc = run('activation-incomplete');
    const di = x.describeExit(0, 'exit', inc.state);
    assert(inc.state.activation.outcome === 'incomplete' && !di.ok && di.severity === 'warning', 'activation-incomplete: a warning, not ok');
    const fail = run('activation-failed');
    assert(/CONFIG, not RUN/.test(x.describeExit(3, 'exit', fail.state).title), 'describeExit 3 names the ADS state');

    const lt = run('list-targets');
    assert(lt.state.targets.local.length === 2 && lt.state.targets.projectNetId === '198.51.100.4.1.1', 'list-targets: a malformed NetId is dropped');
    const items = x.targetPickItems(lt.state.targets, { preselect: '198.51.100.4.1.1' });
    assert(items[0].netId === '198.51.100.4.1.1' && items[0].picked && /\(project\)/.test(items[0].description) && !items[1].picked,
        'target pick: the last pick first and preselected, the project NetId marked');
    assert(/User-mode runtime/.test(items[0].detail) && /TwinCAT OS \(x64\)/.test(items[0].detail), 'target pick detail: kind and platform');
    assert(x.targetPickItems(null).length === 0, 'no targets → no items');

    const can = run('cancelled');
    assert(can.state.done.exitCode === 4 && x.describeExit(4, 'exit', can.state).severity === 'warning' && /cancelled/.test(x.describeExit(4, 'exit', can.state).title), 'describeExit 4');

    const de2 = run('german-message');
    assert(de2.state.log.includes('WARNUNG: Ger\u00e4t nicht gefunden \u00fc') && de2.state.warnings[0] === 'Aktive Plattform unterscheidet sich f\u00fcr das Ger\u00e4t',
        'German text survives both the raw UTF-8 line and the escaped event');
}

// ── describeExit: outcomes ──────────────────────────────────────────────────────────────────────
{
    const s = x.createRunState();
    x.reduce(s, x.parseLine('@@TCTK {"v":1,"t":"phase","name":"open"}'));
    assert(/timed out/.test(x.describeExit(null, 'timeout', s).title) && /open/.test(x.describeExit(null, 'timeout', s).detail), 'timeout');
    assert(/PowerShell/.test(x.describeExit(null, 'spawn-error', s, { error: 'ENOENT' }).title), 'spawn-error');
    assert(/stopped/.test(x.describeExit(null, 'killed', s).title), 'killed');
    assert(/interrupted/.test(x.describeExit(null, 'exit', s).title), 'no exit code → interrupted');
    assert(/interrupted.*exit code 255/.test(x.describeExit(255, 'exit', s).title), 'an unknown code → interrupted');
    const noDone = x.describeExit(0, 'exit', s);
    assert(noDone.ok && /final report is missing/.test(noDone.detail), 'a missing done: the exit code decides, the detail says so');
    const all = [0, 1, 2, 3, 4].map(c => x.describeExit(c, 'exit', s));
    assert(all.every(d => !/TC Toolkit|^TwinCAT/.test(d.title)) && all.filter(d => d.ok).length === 1, 'only exit 0 is ok; no title starts with TwinCAT');
}

// ── Exit code 1 is a compile failure only when the driver said so ───────────────────────────────
{
    const bare = x.createRunState();
    x.reduce(bare, x.parseLine('#< CLIXML'));
    const d = x.describeExit(1, 'exit', bare, { stderr: ['File C:\\x\\build-plc-project.ps1 cannot be loaded because running scripts is disabled on this system.'] });
    assert(!d.ok && /interrupted before it finished \(exit code 1\)/.test(d.title) && /running scripts is disabled/.test(d.detail),
        'exit 1 with no driver report (execution policy, binding error, outside kill): interrupted, with the stderr line');
    assert(!x.compileFailureConfirmed(bare) && !x.reachedBuildResult(1, 'exit', bare), 'and it is not a build result (Problems are kept)');
    const noStderr = x.describeExit(1, 'exit', bare);
    assert(/CLIXML/.test(noStderr.detail), 'without stderr the last log line explains it');
    const viaDone = x.createRunState();
    x.reduce(viaDone, x.parseLine('@@TCTK {"v":1,"t":"done","exitCode":1,"ui":null}'));
    const viaCount = x.createRunState();
    x.reduce(viaCount, x.parseLine('@@TCTK {"v":1,"t":"buildResult","failedProjects":1}'));
    const zero = x.createRunState();
    x.reduce(zero, x.parseLine('@@TCTK {"v":1,"t":"buildResult","failedProjects":0}'));
    assert(x.reachedBuildResult(1, 'exit', viaDone) && x.reachedBuildResult(1, 'exit', viaCount) && !x.reachedBuildResult(1, 'exit', zero),
        'confirmed by done.exitCode 1 or failedProjects > 0, not by failedProjects 0');
    assert(/^Build through XAE failed/.test(x.describeExit(1, 'exit', viaCount).title), 'a confirmed exit 1 is a failed build');
    assert(x.reachedBuildResult(0, 'exit', bare) && x.reachedBuildResult(3, 'exit', bare) && !x.reachedBuildResult(4, 'exit', bare)
        && !x.reachedBuildResult(2, 'exit', bare) && !x.reachedBuildResult(0, 'killed', bare), 'exit 0 and 3 are build results; 2, 4 and a stop are not');
}

// ── Counting by severity: one place, the same numbers everywhere ────────────────────────────────
{
    const s = x.createRunState();
    x.reduce(s, x.parseLine('@@TCTK {"v":1,"t":"buildResult","failedProjects":1}'));
    for (const level of ['vsBuildErrorLevelHigh', 'vsBuildErrorLevelHigh', 'vsBuildErrorLevelMedium']) {
        x.reduce(s, x.parseLine(`@@TCTK {"v":1,"t":"errorItem","file":null,"line":null,"column":null,"description":"d","project":null,"level":"${level}"}`));
    }
    assert(x.describeExit(1, 'exit', s).title === 'Build through XAE failed: 2 errors.', 'describeExit counts errors only (a Medium item is a warning)');
    const p = placeXaeErrors(s.errorItems, [], { readFile: () => '', exists: () => false });
    assert(p.errors === 2 && p.warnings === 1 && p.total === 3, 'placeXaeErrors counts errors and warnings separately');
    assert(placementSummary(p, 1, 'ch') === '2 errors, 1 warning (0 placed in Problems).', `the summary counts by severity (${placementSummary(p, 1, 'ch')})`);
    const onlyWarn = placeXaeErrors([{ file: null, line: null, column: null, description: 'w', project: null, level: 'vsBuildErrorLevelMedium' }], [], { readFile: () => '', exists: () => false });
    assert(placementSummary(onlyWarn, 0, 'ch') === '1 warning (0 placed in Problems).', 'a passed build with a warning is not summarised as an error');
}

// ── canCancel / isStalled ───────────────────────────────────────────────────────────────────────
{
    const s = x.createRunState();
    const phase = (n) => x.reduce(s, x.parseLine(`@@TCTK {"v":1,"t":"phase","name":"${n}"}`), 0);
    for (const p of ['resolve', 'launch', 'open', 'build', 'errors']) { phase(p); assert(x.canCancel(s), `canCancel in ${p}`); }
    for (const p of ['target', 'activate', 'restart', 'verify']) { phase(p); assert(!x.canCancel(s), `no cancel in ${p}`); }
    const t = x.createRunState();
    assert(!x.isStalled(t, 10 ** 9, { stallMs: 1 }), 'nothing heard yet → not stalled');
    x.reduce(t, x.parseLine('@@TCTK {"v":1,"t":"phase","name":"open"}'), 0);
    assert(x.isStalled(t, 600000, { stallMs: 600000 }) && !x.isStalled(t, 599999, { stallMs: 600000 }), 'headless, open, quiet for stallMs → stalled');
    assert(!x.isStalled(t, 10 ** 9, { stallMs: 1, showWindow: true }), 'never stalled with the window shown');
    x.reduce(t, x.parseLine('@@TCTK {"v":1,"t":"phase","name":"build"}'), 0);
    assert(!x.isStalled(t, 10 ** 9, { stallMs: 1 }), 'never stalled during the build itself');
    x.reduce(t, x.parseLine('@@TCTK {"v":1,"t":"phase","name":"activate"}'), 0);
    assert(!x.isStalled(t, 10 ** 9, { stallMs: 1 }), 'never stalled during activation (the window is shown)');
    x.reduce(t, x.parseLine('@@TCTK {"v":1,"t":"phase","name":"target"}'), 0);
    assert(!x.isStalled(t, 10 ** 9, { stallMs: 1 }), 'never stalled in target (cancellation is disarmed there)');
}

// ── confirmationText ────────────────────────────────────────────────────────────────────────────
{
    const c = x.confirmationText({ netId: '198.51.100.4.1.1', name: 'UmRT_Default' }, 'Sample');
    assert(c.confirmLabel === 'Activate on UmRT_Default (198.51.100.4.1.1)', 'the confirm button names the target');
    assert(/^Build Sample, activate the configuration on UmRT_Default \(198\.51\.100\.4\.1\.1\) and restart TwinCAT there\?/.test(c.message)
        && /running PLC on that target stops/.test(c.message) && /XAE window opens during activation/.test(c.message), 'the modal text');
}

// ── readXaeBuildSettings ────────────────────────────────────────────────────────────────────────
{
    const d = readXaeBuildSettings(() => undefined);
    assert(JSON.stringify(d) === JSON.stringify(XAE_BUILD_DEFAULTS) && d.showWindow === false, 'defaults: headless, Release, TwinCAT RT (x64), 30, 10');
    const vals = { showWindow: true, configuration: ' Debug ', platform: '', timeoutMinutes: 1000, stallMinutes: 0 };
    const r = readXaeBuildSettings(k => vals[k]);
    assert(r.showWindow === true && r.configuration === 'Debug' && r.platform === 'TwinCAT RT (x64)' && r.timeoutMinutes === 240 && r.stallMinutes === 2,
        'values are trimmed, an empty platform falls back, numbers are clamped');
    const bad = readXaeBuildSettings(k => ({ showWindow: 'yes', timeoutMinutes: 'x', stallMinutes: NaN })[k]);
    assert(bad.showWindow === false && bad.timeoutMinutes === 30 && bad.stallMinutes === 10, 'wrong types fall back to the defaults');
}

console.log(errors === 0 ? '\nAll XAE build tests passed.' : `\n${errors} XAE build test(s) FAILED.`);
process.exit(errors === 0 ? 0 : 1);
