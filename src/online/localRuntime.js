/**
 * @file localRuntime.js
 * @description Online monitoring (R15 phase 3a): which AMS Net ID "Local runtime" means on this PC.
 *
 * In kernel mode the router and the PLC runtime share one AmsNetId, so `localhost:851` (the router's
 * own NetId) reaches the PLC. With the TwinCAT 3.1.4026 user-mode runtime they do not (measured on
 * the user's PC, 2026-11-16): the router (`TcSystemServiceUm`) has one NetId, the runtime (a second
 * `TcSystemServiceUm -n "UmRT_Default"`) another, and port 851 at the router's NetId answers ADS
 * 0x6/0x7. So on Windows, "Local runtime" is resolved to the runtime's own NetId first.
 *
 * The source is the activation-target discovery Build through XAE already uses — the driver
 * `resources/xae/build-plc-project.ps1 -Json -ListTargets` with no `-SlnPath`: no COM object, no XAE
 * Shell; it reads the registry, `%ProgramData%\Beckhoff\TwinCAT\3.1\Runtimes\*\TcRegistry.xml` and
 * one `Win32_Process` query. Its cost is one `powershell.exe` start plus that query (expected 1-3 s;
 * not measured here). A user-mode runtime's NetId counts only when the driver reports it `trusted`
 * (a running instance wrote it; DEVELOPMENT.md "A user-mode runtime's AmsNetId is trusted only for a
 * running instance"); anything else is never used and is named with its reason.
 *
 * Resolution (`resolveLocalTarget`, user decision 2026-11-16 + coordinator ruling on kernel mode):
 *   - discovery failed, or no trusted user-mode runtime          → the router, as before (`router`)
 *   - exactly one trusted user-mode runtime and no real-time runtime record → that runtime (`runtime`)
 *   - exactly one trusted user-mode runtime, no kernel-mode runtime indicated → that runtime (`runtime`)
 *   - several trusted ones, or one next to a possible kernel-mode runtime  → ask (`pick`)
 * A kernel-mode runtime is indicated when the driver reports a real-time runtime record (the
 * registry's system AmsNetId) AND the kernel-mode system service process is not known to be absent
 * (`checkKernelService`: `tasklist` for TcSysSrv.exe — that image name is UNVERIFIED on a real PC).
 * The registry record alone cannot tell kernel mode apart (a user-mode PC may keep one), so the
 * process check decides; when it fails it asks instead of guessing (one extra click, never a wrong
 * target). The user's 4026 user-mode PC reported no real-time record at all (2026-11-16).
 * Nothing is cached: NetIds change on a runtime restart, so every Go Online resolves again.
 *
 * test/test_local_runtime.js covers it (spawn stubbed; no PowerShell runs there).
 */

'use strict';

const { runChild } = require('../compileCheck');
const { buildDriverArgs, parseLine, runtimeEntries, isValidNetId, QUICK_PICK_SEPARATOR } = require('../xaeBuild');

/** How long the discovery may take before "Local runtime" falls back to the router. */
const DISCOVERY_TIMEOUT_MS = 30000;

/**
 * @typedef {Object} RuntimeEntry One runtime of this PC as `-ListTargets` reports it.
 * @property {string} name
 * @property {string} netId
 * @property {string} kind 'user-mode' | 'real-time'
 */

/**
 * @typedef {Object} Discovery
 * @property {boolean} ok
 * @property {any[]} entries The `targets` event's raw `local` list (empty when not ok).
 * @property {string} [error] Why discovery gave nothing, in words.
 * @property {number} ms How long it took.
 * @property {boolean|null} [kernelService] `checkKernelService`'s answer, when the caller asked it.
 */

/**
 * Runs the driver's `-ListTargets` and returns its runtime list. Never rejects.
 * @param {Object} o
 * @param {Function} o.spawn child_process.spawn or a stub.
 * @param {string} o.scriptPath resources/xae/build-plc-project.ps1.
 * @param {number} [o.timeoutMs] Default DISCOVERY_TIMEOUT_MS.
 * @returns {Promise<Discovery>}
 */
async function discoverRuntimes(o) {
    const started = Date.now();
    const args = buildDriverArgs({ scriptPath: o.scriptPath, mode: 'listTargets' });
    const r = await runChild(/** @type {any} */ (o.spawn), 'powershell.exe', args, { timeoutMs: o.timeoutMs || DISCOVERY_TIMEOUT_MS });
    const ms = Date.now() - started;
    if (r.outcome === 'spawn-error') return { ok: false, entries: [], error: `PowerShell could not start (${r.error})`, ms };
    if (r.outcome === 'timeout') return { ok: false, entries: [], error: `it took longer than ${Math.round((o.timeoutMs || DISCOVERY_TIMEOUT_MS) / 1000)} s`, ms };
    /** @type {any} */
    let targets = null;
    for (const line of r.stdout.split(/\r?\n/)) {
        const item = parseLine(line);
        if (item.kind === 'event' && item.event.t === 'targets') targets = item.event;
    }
    if (!targets) {
        const tail = (r.stderr || '').trim().split(/\r?\n/).pop() || '';
        return { ok: false, entries: [], error: `the runtime list was not reported (exit code ${r.code})${tail ? `: ${tail}` : ''}`, ms };
    }
    const local = targets.local;
    return { ok: true, entries: Array.isArray(local) ? local : (local && typeof local === 'object' ? [local] : []), ms };
}

/** The kernel-mode TwinCAT system service's image name (unverified on a real PC). */
const KERNEL_SERVICE_IMAGE = 'TcSysSrv.exe';

/**
 * Whether the kernel-mode TwinCAT system service runs: true, false, or null when `tasklist` failed.
 * A match is a CSV row naming the image; any other successful output (a localized "no tasks" line)
 * is false. Never rejects.
 * @param {Function} execFile child_process.execFile or a stub.
 * @returns {Promise<boolean|null>}
 */
function checkKernelService(execFile) {
    return new Promise((resolve) => {
        try {
            execFile('tasklist', ['/FI', `IMAGENAME eq ${KERNEL_SERVICE_IMAGE}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 },
                (/** @type {any} */ err, /** @type {any} */ stdout) => {
                    if (err) { resolve(null); return; }
                    const text = String(stdout || '');
                    if (!text.trim()) { resolve(null); return; }
                    resolve(text.toLowerCase().includes(`"${KERNEL_SERVICE_IMAGE.toLowerCase()}"`));
                });
        } catch (e) {
            resolve(null);
        }
    });
}

/**
 * @typedef {Object} LocalResolution
 * @property {'router'|'runtime'|'pick'} kind
 * @property {RuntimeEntry|null} runtime The runtime to use (`runtime`).
 * @property {RuntimeEntry[]} runtimes The trusted user-mode runtimes (`pick`, `runtime`).
 * @property {RuntimeEntry|null} realTime The real-time runtime record, when it may be a running
 *   kernel-mode runtime (reported, and the kernel service not known to be absent).
 * @property {import('../xaeBuild').UnknownRuntime[]} unknown User-mode runtimes whose NetId is unknown.
 * @property {string|null} discoveryError Why discovery failed, when it did.
 */

/**
 * Decides what "Local runtime" targets. Pure.
 * @param {Discovery} d
 * @param {{kernelService?: boolean|null}} [o] `checkKernelService`'s answer: only `false` lets a
 *   real-time record be ignored.
 * @returns {LocalResolution}
 */
function resolveLocalTarget(d, o = {}) {
    /** @type {LocalResolution} */
    const res = { kind: 'router', runtime: null, runtimes: [], realTime: null, unknown: [], discoveryError: d.ok ? null : (d.error || 'unknown error') };
    if (!d.ok) return res;
    res.unknown = runtimeEntries(d.entries).unknown.filter(u => u.kind === 'user-mode');
    for (const t of d.entries) {
        if (!t || typeof t !== 'object' || !isValidNetId(t.netId)) continue;
        if (t.kind === 'real-time') {
            // Ignored only when the kernel service is known not to run; otherwise it makes the
            // resolution ask instead of choosing.
            if (o.kernelService !== false && !res.realTime) res.realTime = { name: String(t.name || 'Real-time runtime'), netId: t.netId, kind: 'real-time' };
            continue;
        }
        // Only an explicit 'trusted' counts: a list without the field never moves the target.
        if (t.kind !== 'user-mode' || t.netIdStatus !== 'trusted') continue;
        if (res.runtimes.some(r => r.netId === t.netId)) continue;
        res.runtimes.push({ name: String(t.name || t.netId), netId: t.netId, kind: 'user-mode' });
    }
    if (res.runtimes.length === 0) return res;
    if (res.runtimes.length === 1 && !res.realTime) {
        res.kind = 'runtime';
        res.runtime = res.runtimes[0];
        return res;
    }
    res.kind = 'pick';
    return res;
}

/**
 * The log line for a resolved user-mode runtime.
 * @param {RuntimeEntry} rt
 * @returns {string}
 */
function resolvedLogText(rt) {
    return `Local runtime: user-mode runtime ${rt.name} at ${rt.netId} (read from its configuration, instance running).`;
}

/**
 * The QuickPick for `pick`: the trusted user-mode runtimes, the real-time runtime at the router's own
 * NetId (when reported), then the unknown runtimes as separator rows that cannot be picked.
 * `preselect` (the last pick's NetId, or 'localhost' for the router) goes first.
 * @param {LocalResolution} res
 * @param {number} port
 * @param {string} [preselect]
 * @returns {Array<{label: string, description?: string, detail?: string, netId?: string, name?: string, kind?: number}>}
 */
function localPickItems(res, port, preselect) {
    /** @type {Array<{label: string, description?: string, detail?: string, netId?: string, name?: string, kind?: number}>} */
    const items = res.runtimes.map(r => ({
        label: r.name, description: `${r.netId}:${port}`,
        detail: 'User-mode runtime on this PC (its AMS Net ID read from its configuration, instance running)',
        netId: r.netId, name: r.name
    }));
    if (res.realTime) {
        items.push({
            label: 'This PC\'s router runtime (kernel mode)', description: `${res.realTime.netId}:${port}`,
            detail: 'The runtime at the router\'s own AMS Net ID, as before. A user-mode-only PC has no PLC there.',
            netId: 'localhost', name: 'router'
        });
    }
    if (preselect) {
        const i = items.findIndex(it => it.netId === preselect);
        if (i > 0) items.unshift(items.splice(i, 1)[0]);
    }
    for (const u of res.unknown) {
        items.push({ label: `${u.name}: AMS Net ID unknown, not offered (${u.reason})`, kind: QUICK_PICK_SEPARATOR });
    }
    return items;
}

/**
 * What to add to a failed Go Online's "Enter AMS Net ID…" hint when "Local runtime" stayed on the
 * router: why no user-mode runtime NetId was used. '' when there is nothing to say.
 * @param {LocalResolution|null} res
 * @returns {string}
 */
function unresolvedHintText(res) {
    if (!res || res.kind !== 'router') return '';
    if (res.discoveryError) return `Finding the user-mode runtime's AMS Net ID failed: ${res.discoveryError}.`;
    if (res.unknown.length === 0) return 'No user-mode runtime with a known AMS Net ID was found on this PC.';
    const named = res.unknown.map(u => `${u.name}: ${u.reason}${u.fileNetId ? ` (its configuration names ${u.fileNetId}, which no running instance is known to use)` : ''}`);
    return `The user-mode runtime's AMS Net ID is unknown, so the router's own was used. ${named.join('; ')}.`;
}

/**
 * The log line after a resolution that did not pick a runtime by itself.
 * @param {LocalResolution} res
 * @param {number} ms
 * @returns {string}
 */
function resolutionLogText(res, ms) {
    const took = `(discovery ${ms} ms)`;
    if (res.kind === 'runtime' && res.runtime) return `${resolvedLogText(res.runtime)} ${took}`;
    if (res.kind === 'pick') return `Local runtime: ${res.runtimes.length} user-mode runtime(s) with a known AMS Net ID${res.realTime ? ' and a possible kernel-mode runtime' : ''}; asking which one. ${took}`;
    const why = unresolvedHintText(res);
    return `Local runtime: the router's own AMS Net ID (localhost). ${why} ${took}`.replace(/\s+/g, ' ').trim();
}

module.exports = {
    DISCOVERY_TIMEOUT_MS, KERNEL_SERVICE_IMAGE, discoverRuntimes, checkKernelService, resolveLocalTarget, resolvedLogText, localPickItems, unresolvedHintText, resolutionLogText
};
