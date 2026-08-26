/**
 * @file log.js
 * @description Structured, quiet-by-default logging for the LSP server.
 *
 * The request handlers in server.js deliberately catch every error and return a safe default (`[]`,
 * `null`, `{success:false}`) so that one failing feature can never break the editor. That is the right
 * UX and it is not changing — but it also made every internal failure invisible: a completion that
 * silently returns nothing looks exactly like a completion that legitimately has nothing to offer.
 * This module is how those catch sites say WHY, without touching what they return.
 *
 * Four properties are load-bearing:
 *
 *  - **Quiet by default.** The threshold is `warn`, so a normal session emits errors and warnings and
 *    nothing else. `debug`/`trace` exist for a developer chasing a specific failure and are opted into
 *    with `TWINCAT_LSP_LOG=debug`. A condition that fires routinely on a HEALTHY project therefore
 *    belongs at `debug`, never at `warn` — an unreadable vendor archive, a `<Compile>` entry whose file
 *    is gone, a half-written expression that will not tokenize. Putting routine noise at `warn` defeats
 *    the design, because then nobody reads `warn`.
 *
 *  - **Below-threshold calls cost one comparison.** `provideDiagnostics` runs per keystroke, so a
 *    disabled `log.debug(...)` must not allocate, format or serialize anything. Every method starts
 *    with the level check and returns before touching its arguments; the fields object a caller builds
 *    inline is the caller's own cost, which is what `isEnabled(level)` exists to let a hot call site
 *    avoid.
 *
 *  - **stderr, one line per record.** The server is a child process speaking LSP over Node IPC, so
 *    stdout belongs to the protocol; stderr is free and lands in the extension host's log. One line per
 *    record keeps it greppable.
 *
 *  - **Never throws.** A logger that can throw would turn a swallowed failure into a crash — the exact
 *    opposite of the point. The serializer degrades (an Error renders as its message plus first stack
 *    frame, a circular value as `String(value)`) rather than propagating.
 *
 * vscode-free and dependency-free, like every other module under `src/lsp/`, so a bare `node` harness
 * can load it (see `test/test_log.js`).
 */

'use strict';

/**
 * The levels, most severe first. The numeric value IS the threshold comparison: a record is emitted
 * when its own value is `<=` the configured threshold, so a higher number means more verbose.
 * @type {Readonly<Object<string, number>>}
 */
const LEVELS = Object.freeze({
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4
});

/** The threshold when the environment says nothing, or says something unrecognized. */
const DEFAULT_LEVEL = 'warn';

/** Prefix on every line, so LSP records are greppable out of a mixed extension-host log. */
const PREFIX = '[twincat-lsp]';

/**
 * The numeric value of a level NAME, or undefined when it is not one of the five. Case-insensitive
 * and whitespace-tolerant, because this normally comes from an environment variable a human typed.
 * @param {*} value A level name.
 * @returns {number|undefined}
 */
function levelValue(value) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(LEVELS, name) ? LEVELS[name] : undefined;
}

/**
 * Resolves a configured level to its numeric threshold, falling back to {@link DEFAULT_LEVEL}.
 * Anything that is not one of the five names is treated as unset rather than as an error, so a typo
 * in `TWINCAT_LSP_LOG` degrades to the quiet default instead of silencing the logger outright.
 * @param {*} value The configured level (an env-var string, or whatever a caller passed).
 * @returns {number} The threshold value from {@link LEVELS}.
 */
function thresholdFor(value) {
    const found = levelValue(value);
    return found === undefined ? LEVELS[DEFAULT_LEVEL] : found;
}

/**
 * Renders an Error the way a log line wants it: the message plus the first stack frame, which is the
 * part that says where it came from. `JSON.stringify(new Error('x'))` is `{}` — message and stack are
 * non-enumerable — so without this every logged error would read as an empty object.
 * @param {Error} err The error to describe.
 * @returns {string} `"<message> | <first stack frame>"`, or just the message when there is no stack.
 */
function describeError(err) {
    const message = String(err && err.message ? err.message : err);
    const stack = err && typeof err.stack === 'string' ? err.stack : '';
    // The first line of `stack` is normally "Error: <message>" — already covered by `message` — so
    // take the first line that actually looks like a frame.
    const frame = stack.split('\n').map(l => l.trim()).find(l => l.startsWith('at '));
    return frame ? `${message} | ${frame}` : message;
}

/**
 * JSON for one field value, degrading instead of throwing.
 *
 * Errors (at any depth) become {@link describeError} strings via the replacer. A value JSON cannot
 * represent at all — a circular object, a `toJSON` that throws, a BigInt — falls back to
 * `String(value)`, and a `String()` that itself throws falls back to a fixed marker. The result is
 * always valid JSON.
 * @param {*} value The field value.
 * @returns {string} A JSON fragment.
 */
function serializeValue(value) {
    try {
        const json = JSON.stringify(value, (key, v) => (v instanceof Error ? describeError(v) : v));
        // `undefined`, a function or a symbol stringifies to `undefined`, which is not JSON.
        return json === undefined ? JSON.stringify(String(value)) : json;
    } catch (e) {
        try {
            return JSON.stringify(String(value));
        } catch (e2) {
            return '"<unserializable>"';
        }
    }
}

/**
 * The `{...}` part of a log line: every own key of `fields`, each value through
 * {@link serializeValue}. Built field by field rather than with one `JSON.stringify(fields)` so that
 * a single unserializable value costs only itself — the rest of the record still reaches the log,
 * which is usually where the useful context is.
 * @param {Object} [fields] Flat field object; missing or empty renders as `{}`.
 * @returns {string} A JSON object literal.
 */
function serializeFields(fields) {
    if (!fields || typeof fields !== 'object') return '{}';
    const parts = [];
    for (const key of Object.keys(fields)) {
        parts.push(`${JSON.stringify(key)}:${serializeValue(fields[key])}`);
    }
    return `{${parts.join(',')}}`;
}

/**
 * @typedef {Object} Logger
 * @property {(event: string, fields?: Object) => void} error A failure: a request that returned its
 *   safe default because something threw.
 * @property {(event: string, fields?: Object) => void} warn A degraded condition that is worth a
 *   healthy project's owner seeing — it must NOT fire routinely (see the file header).
 * @property {(event: string, fields?: Object) => void} info
 * @property {(event: string, fields?: Object) => void} debug The default home for an expected skip.
 * @property {(event: string, fields?: Object) => void} trace
 * @property {(level: string) => boolean} isEnabled True when a record at `level` would be emitted —
 *   guard expensive field computation with this, not with a try/catch.
 */

/**
 * Builds a logger. The threshold and the sink are both parameters so a harness can drive the real
 * implementation without an environment variable and without writing to the process's stderr; the
 * module's own export (below) is this factory bound to `TWINCAT_LSP_LOG` and `process.stderr`.
 * @param {{level?: string, write?: (line: string) => void}} [options] `level` is a level name
 *   (case-insensitive; anything unrecognized means {@link DEFAULT_LEVEL}), read ONCE here. `write`
 *   receives one complete line, newline included.
 * @returns {Logger}
 */
function createLogger(options) {
    const opts = options || {};
    const threshold = thresholdFor(opts.level);
    const write = typeof opts.write === 'function' ? opts.write : () => {};

    /**
     * One log method. The returned function's FIRST statement is the threshold comparison, so a
     * below-threshold call reads no argument, allocates nothing and formats nothing.
     * @param {string} name Level name, as it appears in the line.
     * @param {number} value That level's numeric value.
     * @returns {(event: string, fields?: Object) => void}
     */
    function method(name, value) {
        return (event, fields) => {
            if (value > threshold) return;
            const line = `${PREFIX} ${new Date().toISOString()} ${name} ${event} ${serializeFields(fields)}\n`;
            // A broken sink must not turn a logged failure into a thrown one.
            try {
                write(line);
            } catch (e) {
                /* nothing sensible to do: the sink is where a report would have gone */
            }
        };
    }

    return {
        error: method('error', LEVELS.error),
        warn: method('warn', LEVELS.warn),
        info: method('info', LEVELS.info),
        debug: method('debug', LEVELS.debug),
        trace: method('trace', LEVELS.trace),
        // An unrecognized name is NOT enabled — the opposite of thresholdFor's fallback, deliberately:
        // a caller asking "would `debgu` be logged?" must not be told yes.
        isEnabled: (level) => {
            const value = levelValue(level);
            return value !== undefined && value <= threshold;
        }
    };
}

// The process-wide logger. `TWINCAT_LSP_LOG` is read exactly once, here, at module load: the
// threshold is a property of the run, and re-reading it per call would put an env lookup on the
// per-keystroke diagnostics path for no gain.
const defaultLogger = createLogger({
    level: process.env.TWINCAT_LSP_LOG,
    write: (line) => { process.stderr.write(line); }
});

module.exports = {
    error: defaultLogger.error,
    warn: defaultLogger.warn,
    info: defaultLogger.info,
    debug: defaultLogger.debug,
    trace: defaultLogger.trace,
    isEnabled: defaultLogger.isEnabled,
    createLogger,
    LEVELS,
    DEFAULT_LEVEL
};
