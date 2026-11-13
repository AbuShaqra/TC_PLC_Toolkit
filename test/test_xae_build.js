/**
 * @file test_xae_build.js
 * @description The vscode-free half of Build through XAE (roadmap R14): src/xaeBuild.js and
 * src/xaeBuildSettings.js, against the synthetic driver fixtures in test/fixtures/xae/.
 *
 * Pinned: the driver argv (headless unless `showWindow === true`, exactly one `-ShowWindow` when it
 * is; `-STA`, `-NonInteractive`, `-ExecutionPolicy Bypass` always; no `-TcVersion` unless a confirmed shellOverride (then exactly `-TcVersion <ProgId> -AllowVersionMismatch`, build only); activation only
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
        assert(!a.includes('-TcVersion') && !a.includes('-AllowVersionMismatch'), 'no -TcVersion or -AllowVersionMismatch without a shellOverride');
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

    // The shell override: only after the user confirmed it, only for a build, only a known ProgId.
    const ov = x.buildDriverArgs({ ...base, shellOverride: 'TcXaeShell.DTE.17.0' });
    const i = ov.indexOf('-TcVersion');
    assert(i > 0 && ov[i + 1] === 'TcXaeShell.DTE.17.0' && ov[i + 2] === '-AllowVersionMismatch' && count(ov, '-TcVersion') === 1 && count(ov, '-AllowVersionMismatch') === 1,
        'shellOverride → exactly -TcVersion <ProgId> -AllowVersionMismatch');
    assert(count(ov, '-ShowWindow') === 1 && count(x.buildDriverArgs({ ...base, showWindow: false, shellOverride: 'TcXaeShell.DTE.17.0' }), '-ShowWindow') === 1,
        'shellOverride → -ShowWindow once, even with showWindow off (XAE upgrades the project and shows dialogs; user 2026-11-13)');
    for (const bad of [{ mode: 'activate', targetNetId: '198.51.100.4.1.1', shellOverride: 'TcXaeShell.DTE.17.0' }, { shellOverride: 'TcXaeShell.DTE.99.0' }, { shellOverride: '3.1.4026.22' }]) {
        let refused = false;
        try { x.buildDriverArgs({ ...base, .../** @type {any} */ (bad) }); } catch (e) { refused = true; }
        assert(refused, `shellOverride refused: ${JSON.stringify(bad)}`);
    }
}

// ── missingShell: the offer when the project's XAE Shell is not installed ───────────────────────
{
    const facts = { progId: 'TcXaeShell.DTE.15.0', build: '4024', projectVersion: '3.1.4024.62', installed: ['TcXaeShell.DTE.17.0'] };
    const m = x.missingShell(facts, { mode: 'build', solutionName: 'TcToolkitSample2' });
    assert(m.offer && m.offer.progId === 'TcXaeShell.DTE.17.0' && m.confirmLabel === 'Build with XAE Shell 64'
        && m.question === 'TcToolkitSample2 was saved with TwinCAT 3.1.4024 and its XAE Shell (4024) is not installed. Build with XAE Shell 64 (4026) instead? XAE will upgrade the project files (it rewrites the .tspproj/.tsproj and .plcproj). The XAE window stays open for this build so you can answer its dialogs.',
        'build, another shell installed: the offer names both shells');
    assert(!/TwinCAT (XAE )?Build|TwinCAT PLC Toolkit/.test(m.question + m.text), 'TwinCAT is used only descriptively');
    const bare = x.missingShell({ ...facts, installed: 'TcXaeShell.DTE.17.0' }, { mode: 'build', solutionName: 'S' });
    assert(bare.offer && bare.offer.progId === 'TcXaeShell.DTE.17.0', 'a one-element list serialized as a bare string still counts');
    const act = x.missingShell(facts, { mode: 'activate', solutionName: 'S' });
    assert(act.offer === null && /Activation needs the project's own XAE Shell: Install XAE Shell \(4024\) \(TcXaeShell\.DTE\.15\.0\)/.test(act.text), 'activation: no offer, says which shell to install');
    const none = x.missingShell({ ...facts, installed: [] }, { mode: 'build', solutionName: 'S' });
    assert(none.offer === null && /Install XAE Shell \(4024\) \(TcXaeShell\.DTE\.15\.0\) to build it/.test(none.text), 'nothing installed: no offer, names the shell to install');
    const self = x.missingShell({ ...facts, installed: ['TcXaeShell.DTE.15.0', 'Other.DTE.1'] }, { mode: 'build', solutionName: 'S' });
    assert(self.offer === null, 'the missing shell itself and unknown ProgIds are never offered');
    const st = x.createRunState();
    x.reduce(st, x.parseLine('@@TCTK ' + JSON.stringify({ v: 1, t: 'hello', mode: 'build', showWindow: false })));
    x.reduce(st, x.parseLine('@@TCTK ' + JSON.stringify({ v: 1, t: 'fatal', code: 'progid-not-registered', text: "DTE ProgId 'TcXaeShell.DTE.15.0' is not registered", data: { ...facts, installed: [] } })));
    assert(/^The XAE build could not run: S was saved with TwinCAT 3\.1\.4024 and its XAE Shell \(4024\) is not installed\. Install/.test(x.describeExit(2, 'exit', st, { solutionName: 'S' }).title),
        'describeExit: the missing-shell fatal says which shell to install');
    // Never an older shell (user decision 2026-11-13): a 4026 project with only the 4024 shell gets no
    // offer, and the text names the shell to install and why the older one is not used.
    const newer = { progId: 'TcXaeShell.DTE.17.0', build: '4026', projectVersion: '3.1.4026.28', installed: ['TcXaeShell.DTE.15.0'] };
    const down = x.missingShell(newer, { mode: 'build', solutionName: 'S' });
    assert(down.offer === null && down.question === '' && !/upgrade/.test(down.text)
        && down.text === 'S was saved with TwinCAT 3.1.4026 and its XAE Shell 64 (4026) is not installed. XAE Shell (4024) is installed, but an older XAE Shell cannot open a project saved with a newer TwinCAT. Install XAE Shell 64 (4026) (TcXaeShell.DTE.17.0) to build it on this machine.',
        `an older shell is never offered: no offer, the shell to install named (${down.text})`);
    const up = x.missingShell(facts, { mode: 'build', solutionName: 'S' });
    assert(up.offer && Number(up.offer.build) > Number(facts.build), 'a newer shell is offered (4024 project, 4026 installed)');
    // The run was already on a confirmed substitute (-TcVersion 17.0) and THAT shell is not registered:
    // the driver's fatal carries the substitute's build with the project's own version.
    const sub = x.missingShell({ progId: 'TcXaeShell.DTE.17.0', build: '4026', projectVersion: '3.1.4024.62', installed: [] }, { mode: 'build', solutionName: 'S' });
    assert(sub.offer === null && /^S was saved with TwinCAT 3\.1\.4024, and XAE Shell 64 \(4026\) \(TcXaeShell\.DTE\.17\.0\), chosen in place of its XAE Shell \(4024\), is not registered with COM either/.test(sub.text)
        && /Repair XAE Shell 64 \(4026\), or install XAE Shell \(4024\) \(TcXaeShell\.DTE\.15\.0\)/.test(sub.text) && !/saved with TwinCAT 3\.1\.4026/.test(sub.text),
        `the substitute itself unregistered: the project's own version, and the substitution, named (${sub.text})`);
    const st2 = x.createRunState();
    x.reduce(st2, x.parseLine('@@TCTK ' + JSON.stringify({ v: 1, t: 'fatal', code: 'progid-not-registered', text: 'x', data: { progId: 'TcXaeShell.DTE.17.0', build: '4026', projectVersion: '3.1.4024.62', installed: [] } })));
    assert(/could not run: S was saved with TwinCAT 3\.1\.4024, and XAE Shell 64 \(4026\)/.test(x.describeExit(2, 'exit', st2, { solutionName: 'S' }).title),
        'describeExit reports the substitute that is not registered');
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
    // The 4026 shell under SuppressUI: Visible is not readable (first Windows run, 2026-11-13).
    const visUnread = x.createRunState();
    x.reduce(visUnread, x.parseLine('@@TCTK {"v":1,"t":"ui","requested":"headless","suppressUI":true,"mainWindowVisible":null,"reason":"build"}'));
    assert(x.describeUiMode(visUnread) === 'XAE window during the build: headless (SuppressUI=True; window visibility not readable).',
        'describeUiMode: SuppressUI=True with Visible unreadable still names the mode');
    const visUnread2 = x.createRunState();
    x.reduce(visUnread2, x.parseLine('@@TCTK {"v":1,"t":"ui","requested":"headless","suppressUI":false,"mainWindowVisible":null,"reason":"build"}'));
    assert(/: unknown \(SuppressUI=False; window visibility not readable\)\.$/.test(x.describeUiMode(visUnread2)), 'describeUiMode: SuppressUI=False with Visible unreadable says unknown');
    // ...and on the 4026 shell with the window shown (Windows check step 2): the requested mode is reported.
    const visUnread3 = x.createRunState();
    x.reduce(visUnread3, x.parseLine('@@TCTK {"v":1,"t":"ui","requested":"visible","suppressUI":false,"mainWindowVisible":null,"reason":"build"}'));
    assert(x.describeUiMode(visUnread3) === 'XAE window during the build: visible as requested (SuppressUI=False; window visibility not readable).',
        'describeUiMode: visible requested with Visible unreadable says "visible as requested"');
    const visUnread4 = x.createRunState();
    x.reduce(visUnread4, x.parseLine('@@TCTK {"v":1,"t":"ui","requested":"headless","suppressUI":false,"mainWindowVisible":null,"reason":"version-switch"}'));
    x.reduce(visUnread4, x.parseLine('@@TCTK {"v":1,"t":"ui","requested":"headless","suppressUI":false,"mainWindowVisible":null,"reason":"build"}'));
    assert(/: kept visible after a version switch \(SuppressUI=False; window visibility not readable\)\.$/.test(x.describeUiMode(visUnread4)), 'describeUiMode: a version switch with Visible unreadable');

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

// ── B: activation onto a target that runs another platform (user run 2026-11-13) ────────────────
{
    const fs = require('fs');
    const pathm = require('path');
    const sln1 = fs.readFileSync(pathm.join(__dirname, '..', 'sample', 'TcToolkitSample', 'TcToolkitSample.sln'), 'utf8');
    const sln2 = fs.readFileSync(pathm.join(__dirname, '..', 'sample', 'TcToolkitSample2', 'TcToolkitSample2.sln'), 'utf8');
    const d1 = x.declaredPairs(sln1);
    const d2 = x.declaredPairs(sln2);
    assert(d1.length === 14 && d1.includes('Release|TwinCAT OS (x64)') && d1.includes('Debug|TwinCAT RT (x86)'), 'declaredPairs: sample 1 declares 14 pairs');
    assert(d2.length === 8 && d2.includes('Release|TwinCAT CE7 (ARMV7)') && !d2.includes('Release|TwinCAT OS (x64)'), 'declaredPairs: sample 2 (4024) declares 8, no TwinCAT OS (x64)');
    assert(x.declaredPairs('no section').length === 0 && x.declaredPairs('').length === 0, 'declaredPairs: no section → none');
    const base = { configuration: 'Release', platform: 'TwinCAT RT (x64)' };
    assert(x.activationPlatform({ ...base, targetPlatform: 'TwinCAT RT (x64)', declared: d1 }).kind === 'same', 'same platform → same');
    assert(x.activationPlatform({ ...base, targetPlatform: 'twincat rt (X64)', declared: d1 }).kind === 'same', 'compared case-insensitively, as PowerShell -ne does');
    assert(x.activationPlatform({ ...base, targetPlatform: null, declared: d1 }).kind === 'same', 'unknown target platform → same (the driver warns, XAE checks)');
    const sw = x.activationPlatform({ ...base, targetPlatform: 'TwinCAT OS (x64)', declared: d1 });
    assert(sw.kind === 'switch' && sw.platform === 'TwinCAT OS (x64)', 'another declared platform → switch');
    const nd = x.activationPlatform({ ...base, targetPlatform: 'TwinCAT OS (x64)', declared: d2 });
    assert(nd.kind === 'not-declared' && nd.platform === 'TwinCAT OS (x64)', 'a platform the solution does not declare → not-declared');
    assert(x.activationPlatform({ ...base, targetPlatform: 'TwinCAT OS (x64)', declared: [] }).kind === 'unknown', 'unreadable pairs → unknown (nothing switched)');
    // The configured pair itself must be declared, or the driver stops after the confirmation.
    const custom = { configuration: 'Custom', platform: 'TwinCAT RT (x64)' };
    assert(x.activationPlatform({ ...custom, targetPlatform: 'TwinCAT RT (x64)', declared: d1 }).kind === 'pair-not-declared'
        && x.activationPlatform({ ...custom, targetPlatform: null, declared: d1 }).kind === 'pair-not-declared',
        'same (or unknown) target platform but an undeclared configuration|platform → pair-not-declared');
    assert(x.activationPlatform({ configuration: 'release', platform: 'twincat rt (x64)', targetPlatform: null, declared: d1 }).kind === 'same'
        && x.activationPlatform({ ...custom, targetPlatform: null, declared: [] }).kind === 'same', 'the pair compares case-insensitively; unreadable pairs refuse nothing');
    assert(x.activationPlatform({ ...custom, targetPlatform: 'TwinCAT OS (x64)', declared: d1 }).kind === 'not-declared', 'a switch still needs its own pair declared');
    const pnd = x.pairNotDeclaredText('Custom', 'TwinCAT RT (x64)', 'Sample', ['Debug|A', 'Release|B']);
    assert(/^Sample does not declare 'Custom\|TwinCAT RT \(x64\)', so it cannot be built and activated\. It declares 'Debug\|A', 'Release\|B'\./.test(pnd), 'the pair refusal lists the declared pairs');
    assert(x.activationPlatform({ configuration: 'Debug', platform: 'X', targetPlatform: 'twincat os (x64)', declared: d1 }).platform === 'TwinCAT OS (x64)', 'the switch uses the solution\'s spelling');
    const nt = x.platformNotDeclaredText({ netId: '198.51.100.4.1.1', name: 'UmRT_Default' }, 'TwinCAT OS (x64)', 'Release', 'Sample2');
    assert(/^UmRT_Default \(198\.51\.100\.4\.1\.1\) runs TwinCAT OS \(x64\), but Sample2 does not declare 'Release\|TwinCAT OS \(x64\)'/.test(nt)
        && /Add the solution platform 'TwinCAT OS \(x64\)' in XAE's Configuration Manager/.test(nt), 'the refusal names the platform to add in the Configuration Manager');
    const c = x.confirmationText({ netId: '198.51.100.4.1.1', name: 'UmRT_Default' }, 'Sample',
        { from: 'TwinCAT RT (x64)', to: 'TwinCAT OS (x64)', configuration: 'Release', provenance: 'read' });
    assert(/^UmRT_Default \(198\.51\.100\.4\.1\.1\) runs TwinCAT OS \(x64\), but TwinCAT RT \(x64\) is set\. Switch to TwinCAT OS \(x64\)\?/.test(c.message)
        && /built as Release\|TwinCAT OS \(x64\)/.test(c.message) && /running PLC on that target stops/.test(c.message) && !/inferred/.test(c.message),
        'the switch modal asks as XAE does, and still names the target and the consequences');
    assert(c.confirmLabel === x.SWITCH_FOR_RUN && c.rememberLabel === x.SWITCH_AND_REMEMBER && c.confirmLabel === 'Switch for this run' && c.rememberLabel === 'Switch and remember',
        'its buttons: Switch for this run, Switch and remember');
    assert(/inferred, not read from that runtime/.test(x.confirmationText({ netId: '1.2.3.4.1.1', name: 'RT' }, 'S', { from: 'a', to: 'b', configuration: 'Release', provenance: 'kind-inferred' }).message),
        'an inferred target platform says so');
    const lt = run('list-targets');
    assert(lt.state.targets.local[1].provenance === 'read' && lt.state.targets.local[0].provenance === 'kind-inferred', 'targets keep each platform\'s provenance');
    // The summary of gate 4's multi-line refusal is one line, with no stray punctuation.
    const g4 = run('target-refused-platform');
    const t = x.describeExit(2, 'exit', g4.state).title;
    assert(g4.state.fatal.data.gate === 4 && !/,\./.test(t) && !/\s{2}/.test(t)
        && /activation target 198\.51\.100\.4\.1\.1, which runs 'TwinCAT OS \(x64\)' \(read from that runtime's boot configuration\)\. Build it/.test(t)
        && /to build and activate here\.$/.test(t), `gate 4's refusal reads as one line (${t})`);
    assert(x.describeExit(2, 'exit', g4.state).detail === '', 'the refusal is in the title only: the detail does not repeat it');
    const blank = x.createRunState();
    x.reduce(blank, x.parseLine('@@TCTK ' + JSON.stringify({ v: 1, t: 'fatal', code: 'com-failure', text: '   \r\n  ' })));
    assert(x.describeExit(2, 'exit', blank).title === 'The XAE build could not run.', 'a blank fatal text: no dangling colon');
    assert(x.oneLine('a,\r\n   b') === 'a, b.' && x.oneLine('ends with comma,') === 'ends with comma.' && x.oneLine('done.') === 'done.' && x.oneLine('') === '', 'oneLine');
}

// ── C: a failed headless build with no error details (user run 2026-11-13, 4026) ────────────────
{
    const nd = run('errors-no-details-headless');
    assert(nd.state.errorDetails && nd.state.errorDetails.errorItems === 0 && nd.state.errorDetails.outputPanes === 0
        && nd.state.errorDetails.reasons.length === 4 && nd.state.errorDetails.route === 'none', 'errorDetails is read: counts, reasons and the route');
    const m = x.noErrorDetails(1, 'exit', nd.state);
    assert(m && m.offerRerun && m.text === "XAE returned no error details: typed error list: the error list is empty; the error list is empty; typed Output 'Build' pane: the Output window has no pane named 'Build'; the Output window is not available (XAE window hidden).",
        'noErrorDetails: the reasons, and a re-run offered for a headless build');
    assert(!/will show|shows the errors/i.test(m.text), 'it never claims the visible run will show the errors');
    assert(x.noErrorDetails(1, 'exit', run('errors-panes-only').state) === null, 'output pane text is a detail: nothing to say');
    assert(x.noErrorDetails(1, 'exit', run('errors-errorlist').state) === null, 'error items are details: nothing to say');
    assert(x.noErrorDetails(0, 'exit', run('build-ok-headless').state) === null && x.noErrorDetails(1, 'killed', nd.state) === null, 'only a confirmed compile failure');
    const visible = run('errors-no-details-headless');
    visible.state.done.ui.requested = 'visible';
    assert(x.noErrorDetails(1, 'exit', visible.state).offerRerun === false, 'no re-run offer when the window was already shown');
    const bare = x.createRunState();
    x.reduce(bare, x.parseLine('@@TCTK {"v":1,"t":"buildResult","failedProjects":1}'));
    x.reduce(bare, x.parseLine('@@TCTK {"v":1,"t":"errorDetails","errorItems":0,"outputPanes":0,"reasons":"only one"}'));
    assert(bare.errorDetails.reasons.length === 1 && bare.errorDetails.reasons[0] === 'only one', 'a one-reason list sent as a bare string (PS 5.1) is read');
    const none = x.createRunState();
    x.reduce(none, x.parseLine('@@TCTK {"v":1,"t":"buildResult","failedProjects":1}'));
    assert(x.noErrorDetails(1, 'exit', none).text === 'XAE returned no error details: the driver reported none.', 'no errorDetails event (an older driver): it says so');
    const emptyOnly = x.createRunState();
    x.reduce(emptyOnly, x.parseLine('@@TCTK {"v":1,"t":"buildResult","failedProjects":1}'));
    x.reduce(emptyOnly, x.parseLine('@@TCTK {"v":1,"t":"errorItem","file":null,"line":null,"column":null,"description":"","project":null,"level":"vsBuildErrorLevelMedium"}'));
    assert(x.noErrorDetails(1, 'exit', emptyOnly) !== null, 'empty error-list items (headless 4026) are no details');
    // The fallback runs whenever a confirmed compile failure placed nothing (user, 2026-11-13).
    assert(x.needsCompileFallback(1, 'exit', nd.state, 0) && x.needsCompileFallback(1, 'exit', run('errors-panes-only').state, 0),
        'needsCompileFallback: no details, or details that placed nothing');
    assert(!x.needsCompileFallback(1, 'exit', nd.state, 1) && !x.needsCompileFallback(2, 'exit', nd.state, 0) && !x.needsCompileFallback(4, 'exit', nd.state, 0)
        && !x.needsCompileFallback(1, 'killed', nd.state, 0) && !x.needsCompileFallback(0, 'exit', run('build-ok-headless').state, 0),
        'not once something is placed, not on exit 2/4/0, not on a stop');
    const planted = run('errors-pane-planted-headless');
    assert(x.describeExit(1, 'exit', planted.state).title === 'Build through XAE failed.' && x.describeExit(1, 'exit', planted.state, { errorCount: 1 }).title === 'Build through XAE failed: 1 error.',
        'describeExit: empty and summary items are not errors; the placed count is used when given');
}

// ── readXaeBuildSettings ────────────────────────────────────────────────────────────────────────
{
    const d = readXaeBuildSettings(() => undefined);
    assert(JSON.stringify(d) === JSON.stringify(XAE_BUILD_DEFAULTS) && d.showWindow === false, 'defaults: headless, Release, TwinCAT RT (x64), 30, 10');
    const vals = { showWindow: true, configuration: ' Debug ', platform: '', timeoutMinutes: 1000, stallMinutes: 0 };
    const r = readXaeBuildSettings(k => vals[k]);
    assert(r.showWindow === true && r.configuration === 'Debug' && r.platform === 'TwinCAT RT (x64)' && r.timeoutMinutes === 240 && r.stallMinutes === 2,
        'values are trimmed, an empty platform falls back, numbers are clamped');
    const custom = readXaeBuildSettings(k => ({ platform: 'TwinCAT OS (Custom)', configuration: 'Release_Line2' })[k]);
    assert(custom.platform === 'TwinCAT OS (Custom)' && custom.configuration === 'Release_Line2',
        'a platform outside the Settings dropdown (typed into settings.json) and a custom configuration are passed on as they are');
    assert(x.buildDriverArgs({ scriptPath: 's', slnPath: 'a.sln', platform: custom.platform }).includes('TwinCAT OS (Custom)'), 'and reach -Platform');
    const bad = readXaeBuildSettings(k => ({ showWindow: 'yes', timeoutMinutes: 'x', stallMinutes: NaN })[k]);
    assert(bad.showWindow === false && bad.timeoutMinutes === 30 && bad.stallMinutes === 10, 'wrong types fall back to the defaults');
}

// ── errorDetails.route and TC Toolkit's own check as the fallback (2026-11-13) ─────────────────
{
    const routeOf = (route) => {
        const st = x.createRunState();
        x.reduce(st, x.parseLine('@@TCTK ' + JSON.stringify({ v: 1, t: 'errorDetails', errorItems: 0, outputPanes: 0, reasons: 'one reason', route })));
        return st.errorDetails;
    };
    assert(routeOf('typed').route === 'typed' && routeOf('late-bound').route === 'late-bound' && routeOf('none').route === 'none',
        "errorDetails.route is read: 'typed' | 'late-bound' | 'none'");
    assert(routeOf(undefined).route === null && routeOf('other').route === null && routeOf('typed').reasons.join() === 'one reason',
        'an absent or unknown route is null (an older driver); a one-element reasons array as a bare string still reads');
    const src = 'TC Toolkit compile';
    const two = x.compileFallbackText([{ name: 'A', ok: true, errors: 2, warnings: 1 }, { name: 'B', ok: true, errors: 0, warnings: 0 }], src);
    assert(two.ran === 2 && !two.skipped && two.text === "TC Toolkit's own compile check (not XAE's; it can differ from XAE's): A: 2 errors, 1 warning; B: no errors. Its problems are in Problems as 'TC Toolkit compile'.",
        `the fallback text names each project and says it is not XAE's (${two.text})`);
    const setup = x.compileFallbackText([{ name: 'A', ok: false, reason: 'setup', message: 'No Node.js was found.' }], src);
    assert(setup.skipped && setup.ran === 0 && /was skipped: no compiler is configured for it \(No Node\.js was found\.\)\.$/.test(setup.text),
        'no usable compiler: skipped, and said');
    const other = x.compileFallbackText([{ name: 'A', ok: false, reason: 'running' }, { name: 'B', ok: false, reason: 'cancelled' }], src);
    assert(other.ran === 0 && /A: not checked \(Build Project is already running\); B: cancelled\.$/.test(other.text) && !/Problems as/.test(other.text),
        'a project that was not checked is named, and Problems is not pointed at');
    assert(/not from XAE, and can differ from XAE's/.test(x.FALLBACK_INTRO), 'the intro says the errors come from TC Toolkit\'s check, not XAE');
}

console.log(errors === 0 ? '\nAll XAE build tests passed.' : `\n${errors} XAE build test(s) FAILED.`);
process.exit(errors === 0 ? 0 : 1);
