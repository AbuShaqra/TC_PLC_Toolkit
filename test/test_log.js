/**
 * @file test_log.js
 * @description The LSP's structured logger (`src/lsp/log.js`).
 *
 * The logger exists because every LSP request handler swallows its errors and returns a safe default
 * — the right UX, but it made "this feature is broken" indistinguishable from "this feature has
 * nothing to say". What is pinned here is the set of properties that make that reporting safe to leave
 * switched on in every catch block in the server:
 *
 *  - **Quiet by default.** The threshold is `warn` when `TWINCAT_LSP_LOG` says nothing, and also when
 *    it says something that is not a level name — a typo must not silence errors, and must not turn on
 *    the verbose levels either. Read once, at module load (checked here in real child processes, which
 *    is the only place that wiring exists).
 *  - **A below-threshold call costs one comparison.** `provideDiagnostics` runs per keystroke, so a
 *    disabled `log.debug(...)` must not serialize — or even READ — its fields. Pinned with a fields
 *    object whose property is a getter: it must stay untouched when the level is off, and must be read
 *    when it is on (or the assertion would pass for a logger that ignores its arguments entirely).
 *  - **It never throws.** An Error field renders as its message plus first stack frame (plain
 *    `JSON.stringify` of an Error is `{}`, message and stack being non-enumerable); a circular object
 *    degrades to `String(value)`; a sink that throws is absorbed. A logger that can throw would turn a
 *    swallowed failure into a crash, which is the exact opposite of the point.
 *
 * The line shape is pinned too: `[twincat-lsp] <iso> <level> <event> <fields-json>`. The fields half
 * must always be parseable JSON — that is what makes the log greppable and machine-readable after the
 * fact.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { createLogger, LEVELS, DEFAULT_LEVEL } = require('../src/lsp/log');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const LOG_MODULE = path.resolve(__dirname, '..', 'src', 'lsp', 'log.js');

/** A logger writing into an array, plus the array. */
function capture(level) {
    const lines = [];
    return { log: createLogger({ level, write: (line) => lines.push(line) }), lines };
}

/**
 * Splits one record into its parts.
 * @param {string} line A complete log line, newline included.
 * @returns {{prefix: string, timestamp: string, level: string, event: string, fields: string}|null}
 */
function parseLine(line) {
    const m = /^(\[twincat-lsp\]) (\S+) (\S+) (\S+) (\{.*\})\n$/.exec(line);
    if (!m) return null;
    return { prefix: m[1], timestamp: m[2], level: m[3], event: m[4], fields: m[5] };
}

// ---- Group 1: level ordering and threshold gating -------------------------------------------

{
    const { log, lines } = capture('warn');
    log.error('e', {});
    log.warn('w', {});
    log.info('i', {});
    log.debug('d', {});
    log.trace('t', {});
    assert(lines.length === 2, `warn threshold emits error+warn only (expected 2 lines, got ${lines.length})`);
    const events = lines.map(l => parseLine(l).event);
    assert(events.join(',') === 'e,w', `warn threshold emits exactly [e, w] (got [${events.join(', ')}])`);
}

{
    const { log, lines } = capture('trace');
    log.error('e'); log.warn('w'); log.info('i'); log.debug('d'); log.trace('t');
    assert(lines.length === 5, `trace threshold emits every level (expected 5, got ${lines.length})`);
}

{
    const { log, lines } = capture('error');
    log.error('e'); log.warn('w');
    assert(lines.length === 1 && parseLine(lines[0]).event === 'e',
        'error threshold emits errors and suppresses warnings');
}

assert(LEVELS.error < LEVELS.warn && LEVELS.warn < LEVELS.info &&
    LEVELS.info < LEVELS.debug && LEVELS.debug < LEVELS.trace,
    'LEVELS orders error < warn < info < debug < trace (a higher value is more verbose)');
assert(DEFAULT_LEVEL === 'warn', 'the default level is warn — errors and warnings surface, verbose stays off');

// ---- Group 2: a below-threshold call computes NOTHING ----------------------------------------
// The whole design rests on this: diagnostics run per keystroke, and a disabled debug call must not
// pay for its fields. The probe is a getter, so "did the logger touch the fields?" is observable.

{
    const { log, lines } = capture('warn');
    let reads = 0;
    const probe = { get detail() { reads++; return 'expensive'; } };

    log.debug('below-threshold', probe);
    assert(reads === 0 && lines.length === 0,
        `a debug call under the warn threshold writes nothing and reads no field (reads=${reads}, lines=${lines.length})`);

    log.warn('at-threshold', probe);
    assert(reads === 1 && lines.length === 1,
        `the same fields object IS read when the level is enabled (reads=${reads}) — the probe is real`);
}

{
    // isEnabled is the guard for a call site whose FIELDS are expensive to build (the logger cannot
    // help there — the caller has already built them by the time it is called).
    const { log } = capture('warn');
    assert(log.isEnabled('error') === true && log.isEnabled('warn') === true,
        'isEnabled is true at and above the threshold');
    assert(log.isEnabled('info') === false && log.isEnabled('debug') === false && log.isEnabled('trace') === false,
        'isEnabled is false below the threshold');
    assert(log.isEnabled('DEBUG') === false && capture('debug').log.isEnabled('DeBuG') === true,
        'isEnabled is case-insensitive about the level name it is asked about');
    assert(log.isEnabled('nonsense') === false && log.isEnabled(undefined) === false,
        'isEnabled says false for a name that is not a level — never "yes" to a typo');
}

// ---- Group 3: line shape and field serialization ---------------------------------------------

{
    const { log, lines } = capture('debug');
    log.debug('definition-request-failed', { uri: 'file:///c%3A/ws/MAIN.TcPOU', line: 12, character: 4 });
    const rec = parseLine(lines[0]);
    assert(rec !== null, `the record matches "[twincat-lsp] <iso> <level> <event> <json>" (got ${JSON.stringify(lines[0])})`);
    assert(rec.level === 'debug' && rec.event === 'definition-request-failed',
        'the level name and the event are their own whitespace-separated fields');
    assert(!isNaN(Date.parse(rec.timestamp)) && rec.timestamp.endsWith('Z'),
        `the timestamp is an ISO instant (got ${rec.timestamp})`);
    const fields = JSON.parse(rec.fields);
    assert(fields.uri === 'file:///c%3A/ws/MAIN.TcPOU' && fields.line === 12 && fields.character === 4,
        'the fields round-trip through JSON.parse with their values intact');
    assert(lines[0].endsWith('\n') && lines[0].indexOf('\n') === lines[0].length - 1,
        'exactly one line per record, newline included');
}

{
    const { log, lines } = capture('debug');
    log.debug('no-fields');
    log.debug('empty-fields', {});
    assert(parseLine(lines[0]).fields === '{}' && parseLine(lines[1]).fields === '{}',
        'a call with no fields (or empty fields) still renders a parseable {}');
}

// ---- Group 4: Error fields ------------------------------------------------------------------

{
    const { log, lines } = capture('debug');
    function throwingHelper() { throw new Error('index is not ready'); }
    let caught;
    try { throwingHelper(); } catch (e) { caught = e; }

    log.debug('handler-failed', { uri: 'file:///x.TcPOU', error: caught });
    const fields = JSON.parse(parseLine(lines[0]).fields);
    assert(typeof fields.error === 'string' && fields.error !== '{}',
        `an Error renders as text, not as JSON.stringify's empty object (got ${JSON.stringify(fields.error)})`);
    // String()-coerced on purpose: these three must REPORT a failure rather than throw the harness
    // over when a broken serializer hands back a non-string (the empty object, for instance).
    assert(String(fields.error).startsWith('index is not ready'),
        `the Error's message leads (got ${JSON.stringify(fields.error)})`);
    assert(/\| at .*throwingHelper/.test(String(fields.error)),
        `the first stack FRAME follows the message (got ${JSON.stringify(fields.error)})`);
    assert(String(fields.error).split('\n').length === 1, 'the stack never breaks the record onto a second line');
}

{
    // An Error nested inside a field object is described the same way — the replacer is depth-agnostic.
    const { log, lines } = capture('debug');
    log.debug('nested', { detail: { cause: new Error('inner') } });
    const fields = JSON.parse(parseLine(lines[0]).fields);
    assert(typeof fields.detail.cause === 'string' && fields.detail.cause.startsWith('inner'),
        'an Error nested inside a field value is described, not flattened to {}');
}

{
    // An error with no stack at all (a plain object thrown, or a stripped Error) must still render.
    const { log, lines } = capture('debug');
    const bare = new Error('no stack here');
    bare.stack = undefined;
    log.debug('bare', { error: bare });
    const fields = JSON.parse(parseLine(lines[0]).fields);
    assert(String(fields.error) === 'no stack here', `a stackless Error renders as its message alone (got ${JSON.stringify(fields.error)})`);
}

// ---- Group 5: values that break naive serializers ---------------------------------------------

{
    const { log, lines } = capture('debug');
    const circular = { name: 'workspace' };
    circular.self = circular;
    let threw = null;
    try {
        log.debug('circular-fields', { workspace: circular, uri: 'file:///x' });
    } catch (e) {
        threw = e;
    }
    assert(threw === null, `a circular field value does not throw (threw ${threw && threw.message})`);
    assert(lines.length === 1, 'the record is still written when one field cannot be serialized');
    const rec = parseLine(lines[0]);
    assert(rec !== null, 'the degraded record still matches the line shape');
    const fields = JSON.parse(rec.fields);
    assert(typeof fields.workspace === 'string',
        `the circular value degrades to a string (got ${JSON.stringify(fields.workspace)})`);
    assert(fields.uri === 'file:///x',
        'the OTHER fields survive intact — one bad value costs only itself');
}

{
    const { log, lines } = capture('debug');
    const hostile = { toJSON() { throw new Error('toJSON exploded'); } };
    log.debug('hostile-tojson', { value: hostile, keep: 1 });
    const fields = JSON.parse(parseLine(lines[0]).fields);
    assert(typeof fields.value === 'string' && fields.keep === 1,
        'a field whose toJSON throws degrades to a string and leaves its neighbours alone');
}

{
    const { log, lines } = capture('debug');
    log.debug('unrepresentable', { fn: () => 1, undef: undefined, big: BigInt(7), sym: Symbol('s') });
    const rec = parseLine(lines[0]);
    assert(rec !== null && JSON.parse(rec.fields), 'functions, undefined, BigInt and Symbol fields all stay valid JSON');
}

{
    // A key that needs escaping must not break the object either.
    const { log, lines } = capture('debug');
    log.debug('odd-keys', { 'a"b': 1, 'c\nd': 2 });
    const fields = JSON.parse(parseLine(lines[0]).fields);
    assert(fields['a"b'] === 1 && fields['c\nd'] === 2, 'field keys are JSON-escaped');
}

{
    // A sink that throws must be absorbed: logging is additive, and a broken sink cannot be allowed
    // to change the control flow of the catch block it was added to.
    const log = createLogger({ level: 'debug', write: () => { throw new Error('sink is gone'); } });
    let threw = null;
    try { log.error('with-broken-sink', { a: 1 }); } catch (e) { threw = e; }
    assert(threw === null, `a throwing sink is absorbed (threw ${threw && threw.message})`);
}

{
    const log = createLogger({ level: 'debug' });   // no sink at all
    let threw = null;
    try { log.error('no-sink'); } catch (e) { threw = e; }
    assert(threw === null, 'a logger built without a sink is a no-op, not a crash');
}

// ---- Group 6: TWINCAT_LSP_LOG parsing, in real child processes -------------------------------
// The env is read ONCE at module load, so the only honest test of that wiring is a fresh process.

/**
 * Loads the module in a child process with the given env value and reports what it emitted.
 * @param {string|undefined} envValue Value for TWINCAT_LSP_LOG; undefined leaves it unset.
 * @returns {{stderr: string, stdout: string}}
 */
function runChild(envValue) {
    const script = `
        const log = require(${JSON.stringify(LOG_MODULE)});
        log.error('child-error', { n: 1 });
        log.warn('child-warn', { n: 2 });
        log.info('child-info', { n: 3 });
        log.debug('child-debug', { n: 4 });
        log.trace('child-trace', { n: 5 });
        process.stdout.write(JSON.stringify({ debug: log.isEnabled('debug'), warn: log.isEnabled('warn') }));
    `;
    const env = { ...process.env };
    delete env.TWINCAT_LSP_LOG;
    if (envValue !== undefined) env.TWINCAT_LSP_LOG = envValue;
    const res = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    return { stderr: res.stderr || '', stdout: res.stdout || '' };
}

{
    const { stderr, stdout } = runChild(undefined);
    assert(/child-error/.test(stderr) && /child-warn/.test(stderr),
        'unset TWINCAT_LSP_LOG: errors and warnings reach stderr');
    assert(!/child-info|child-debug|child-trace/.test(stderr),
        `unset TWINCAT_LSP_LOG: info/debug/trace stay off (stderr was ${JSON.stringify(stderr)})`);
    assert(JSON.parse(stdout).debug === false && JSON.parse(stdout).warn === true,
        'unset TWINCAT_LSP_LOG: isEnabled agrees with what was written');
}

{
    const { stderr } = runChild('debug');
    assert(/child-debug/.test(stderr) && /child-info/.test(stderr) && !/child-trace/.test(stderr),
        'TWINCAT_LSP_LOG=debug turns on info+debug and leaves trace off');
}

{
    const { stderr } = runChild('  DeBuG ');
    assert(/child-debug/.test(stderr), 'the level name is case-insensitive and whitespace-tolerant');
}

{
    const { stderr } = runChild('shout');
    assert(/child-error/.test(stderr) && /child-warn/.test(stderr) && !/child-info|child-debug/.test(stderr),
        'an INVALID TWINCAT_LSP_LOG falls back to warn — a typo neither silences errors nor turns on debug');
}

{
    const { stderr } = runChild('');
    assert(/child-warn/.test(stderr) && !/child-debug/.test(stderr),
        'an empty TWINCAT_LSP_LOG behaves as unset');
}

{
    const { stderr } = runChild('error');
    assert(/child-error/.test(stderr) && !/child-warn/.test(stderr),
        'TWINCAT_LSP_LOG=error is quieter than the default');
}

{
    // The records go to stderr, never stdout: stdout carries the LSP protocol in the real server.
    const { stdout } = runChild('trace');
    assert(!/twincat-lsp/.test(stdout), 'no record is ever written to stdout — that stream belongs to the protocol');
}

console.log(errors === 0 ? '\nAll LSP logger tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
