/** @file _fakeChild.js @description A scripted stand-in for `child_process.spawn`, for the Compile Project harnesses. */

const { EventEmitter } = require('events');

/**
 * Builds a fake `spawn`. Each call is recorded and answered by `script(call)`, which returns what the
 * child does: `{ stdout?, stderr?, code? }` to print and exit, `{ error }` to fail to start,
 * `{ hang: true }` to never exit (until killed), or `{ throws }` to throw from spawn itself.
 * @param {(call: {command: string, args: string[], options: any, index: number}) => any} script
 * @returns {{spawn: Function, calls: Array<{command: string, args: string[], options: any, index: number, killed: boolean}>}}
 */
function createFakeSpawn(script) {
    const calls = [];
    const spawn = (command, args, options) => {
        const call = { command, args: (args || []).slice(), options, index: calls.length, killed: false };
        calls.push(call);
        const behaviour = script(call) || {};
        if (behaviour.throws) throw new Error(behaviour.throws);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => { call.killed = true; };
        setImmediate(() => {
            if (behaviour.error) { child.emit('error', new Error(behaviour.error)); return; }
            if (behaviour.hang) return;
            if (behaviour.stdout) child.stdout.emit('data', Buffer.from(behaviour.stdout));
            if (behaviour.stderr) child.stderr.emit('data', Buffer.from(behaviour.stderr));
            child.emit('close', behaviour.code === undefined ? 0 : behaviour.code);
        });
        return child;
    };
    return { spawn, calls };
}

module.exports = { createFakeSpawn };
