/**
 * @file _fakeXaeDriver.js
 * @description A scripted stand-in for `powershell.exe -File build-plc-project.ps1 -Json …`, for the
 * XAE build harnesses (roadmap R14). No PowerShell, no COM: each spawn replays a fixture from
 * test/fixtures/xae/ as the driver's stdout.
 *
 * A fixture is JSON lines: an object with `v`/`t` is an event (written with the `@@TCTK ` prefix and
 * every non-ASCII character escaped, exactly as the driver's Emit-Event does), `{"log": text}` is a
 * plain line (written as raw UTF-8), `{"exit": n}` the exit code.
 *
 * What a spawn does is decided by `script(call)`:
 *   `{fixture}` or `{lines, exit}`  what to print, then exit
 *   `chunkSize`                     split stdout into chunks of this many BYTES (tests the splitter)
 *   `hang: true`                    print, then never exit until killed
 *   `onCancelFile: {lines?, exit?}` while hanging, poll the `-CancelFile` path; once it exists,
 *                                   print these lines and exit (default exit 4); with `stay: true`
 *                                   print them and keep hanging (a driver that entered activation)
 *   `stderr` / `stderrChunks`       write this to stderr (a string, or Buffers chunk by chunk)
 *   `error`                         emit a spawn error
 * Every call is recorded: argv, whether the cancel file appeared, kills; `execFile` records taskkill
 * PIDs (`killedPids`) and argv (`taskkills`).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PREFIX } = require('../src/xaeBuild');

const FIXTURES = path.join(__dirname, 'fixtures', 'xae');

/**
 * Reads a fixture.
 * @param {string} name Without `.jsonl`.
 * @returns {{lines: Array<Object>, exit: number}}
 */
function readFixture(name) {
    const rows = fs.readFileSync(path.join(FIXTURES, name + '.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    const exitRow = rows.find(r => Object.prototype.hasOwnProperty.call(r, 'exit'));
    return { lines: rows.filter(r => r !== exitRow), exit: exitRow ? exitRow.exit : 0 };
}

/**
 * One fixture row as the driver writes it.
 * @param {any} row
 * @returns {string}
 */
function renderRow(row) {
    if (Object.prototype.hasOwnProperty.call(row, 'log')) return String(row.log);
    return PREFIX + JSON.stringify(row).replace(/[\u0080-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * @param {Array<Object>} rows
 * @returns {Buffer}
 */
function renderStdout(rows) {
    return Buffer.from(rows.map(r => renderRow(r) + '\r\n').join(''), 'utf8');
}

/**
 * Builds the fake spawn.
 * @param {(call: any) => any} script
 */
function createFakeXaeSpawn(script) {
    const calls = [];
    let nextPid = 7000;
    const spawn = (command, args, options) => {
        const call = { command, args: (args || []).slice(), options, index: calls.length, killed: false, cancelFileSeen: false, pid: nextPid++ };
        calls.push(call);
        const b = script(call) || {};
        const child = new EventEmitter();
        child.pid = call.pid;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        let poll = null;
        let exited = false;
        const exit = (code) => {
            if (exited) return;
            exited = true;
            if (poll) clearInterval(poll);
            setImmediate(() => child.emit('close', code));
        };
        child.kill = () => { call.killed = true; exit(null); };
        call.child = child;
        const write = (rows) => {
            const buf = renderStdout(rows);
            const size = b.chunkSize || buf.length || 1;
            for (let i = 0; i < buf.length; i += size) child.stdout.emit('data', buf.subarray(i, i + size));
        };
        setImmediate(() => {
            if (b.error) { child.emit('error', new Error(b.error)); return; }
            const fx = b.fixture ? readFixture(b.fixture) : { lines: b.lines || [], exit: b.exit === undefined ? 0 : b.exit };
            write(fx.lines);
            if (b.stderr) child.stderr.emit('data', Buffer.from(b.stderr));
            for (const c of b.stderrChunks || []) child.stderr.emit('data', c);
            if (b.onCancelFile) {
                const i = call.args.indexOf('-CancelFile');
                const file = i >= 0 ? call.args[i + 1] : null;
                poll = setInterval(() => {
                    if (file && fs.existsSync(file)) {
                        call.cancelFileSeen = true;
                        if (b.onCancelFile.ignore) return;
                        if (b.onCancelFile.stay) {
                            clearInterval(poll);
                            write(b.onCancelFile.lines || []);
                            return;
                        }
                        write(b.onCancelFile.lines || [{ v: 1, t: 'done', exitCode: 4, ui: null }]);
                        exit(b.onCancelFile.exit === undefined ? 4 : b.onCancelFile.exit);
                    }
                }, 5);
                return;
            }
            if (b.hang) return;
            exit(fx.exit);
        });
        return child;
    };
    /** @type {number[]} */
    const killedPids = [];
    /** @type {string[][]} */
    const taskkills = [];
    const execFile = (file, args, options, cb) => {
        if (/taskkill/i.test(file)) {
            taskkills.push(args.slice());
            const i = args.indexOf('/PID');
            const pid = Number(args[i + 1]);
            killedPids.push(pid);
            const call = calls.find(c => c.pid === pid);
            if (call) { call.killed = true; call.child.kill(); }
        }
        if (cb) setImmediate(() => cb(null, '', ''));
        return new EventEmitter();
    };
    return { spawn, calls, execFile, killedPids, taskkills };
}

module.exports = { createFakeXaeSpawn, readFixture, renderStdout, renderRow, FIXTURES };
