/**
 * @file xaeShell.js
 * @description Discovers installed TwinCAT XAE shells and runs the library-signature generator by
 * driving one of them. This is the extension's only touch-point with TwinCAT itself; it runs solely
 * when the user invokes `twincat.updateLibraryDefinitions`, so the extension stays fully offline
 * otherwise. Distinct from `src/lsp/librarySignatures.js`, which merely parses the XML the generator
 * writes.
 */

// No value in this file references `vscode`, but the JSDoc below does (`@param
// {vscode.OutputChannel}`), and that is how `tsc --noEmit` resolves the namespace: deleting this
// line fails the type-check gate with "TS2503: Cannot find namespace 'vscode'". Verified.
// eslint-disable-next-line no-unused-vars
const vscode = require('vscode');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

/**
 * The TwinCAT XAE shells the signature generator knows how to drive, newest first.
 *
 * Both may be installed side by side, and they are **not** interchangeable: a library's signatures can
 * differ depending on which shell produced them — visualisation libraries especially — so the user is
 * asked which one to drive rather than us picking the first hit.
 * @type {{id: string, label: string, progId: string, exePath: string}[]}
 */
const TCXAESHELL_CANDIDATES = [
    {
        id: 'x64',
        label: 'TcXaeShell (64-bit)',
        progId: 'TcXaeShell.DTE.17.0',
        exePath: 'C:\\Program Files\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe'
    },
    {
        id: 'x86',
        label: 'TcXaeShell (32-bit)',
        progId: 'TcXaeShell.DTE.15.0',
        exePath: 'C:\\Program Files (x86)\\Beckhoff\\TcXaeShell\\Common7\\IDE\\TcXaeShell.exe'
    }
];

/**
 * Reads a registry key's *default* value with reg.exe, or null if the key/value is absent.
 *
 * Anchored on the `REG_SZ` type token rather than on the value's name: reg.exe is localized, so the
 * default value prints as "(Standard)" on a German Windows and "(Default)" on an English one.
 * @param {string} key Full key path, e.g. `HKCR\\TcXaeShell.DTE.17.0\\CLSID`.
 * @param {string} [view] Optional registry view flag — `/reg:64` or `/reg:32`.
 * @returns {string|null} The default value, or null.
 */
function regDefaultValue(key, view) {
    const args = ['query', key, '/ve'];
    if (view) args.push(view);
    try {
        const out = execFileSync('reg.exe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = /REG_SZ\s+(.+)/.exec(out);
        return m ? m[1].trim() : null;
    } catch (e) {
        return null;  // key not present in this view
    }
}

/**
 * Resolves a DTE ProgID to the .exe that serves it, via its CLSID's LocalServer32 registration.
 *
 * This is the fallback for a shell installed somewhere other than the default Beckhoff path: the COM
 * registration is what we actually need (that is how the script attaches), and it also records where the
 * .exe really is. The 32-bit shell registers its LocalServer32 in the 32-bit registry view only and the
 * 64-bit one in the 64-bit view only, so both views are tried.
 * @param {string} progId e.g. `TcXaeShell.DTE.17.0`.
 * @returns {string|null} Absolute path to an existing .exe, or null.
 */
function shellExeFromRegistry(progId) {
    const clsid = regDefaultValue(`HKCR\\${progId}\\CLSID`) || regDefaultValue(`HKCR\\${progId}\\CLSID`, '/reg:32');
    if (!clsid) return null;
    for (const view of ['/reg:64', '/reg:32']) {
        let raw = regDefaultValue(`HKCR\\CLSID\\${clsid}\\LocalServer32`, view);
        if (!raw) continue;
        // The registration may be quoted and may carry a trailing switch (e.g. /Automation).
        const quoted = /^"([^"]+)"/.exec(raw);
        if (quoted) raw = quoted[1];
        else if (!fs.existsSync(raw)) raw = raw.replace(/\s+[/-]\S+\s*$/, '');
        if (raw && fs.existsSync(raw)) return raw;
    }
    return null;
}

/**
 * The TwinCAT XAE shells actually installed on this machine, newest first.
 *
 * Probed before the generator is spawned so a user without TwinCAT gets an immediate, honest message
 * instead of a PowerShell window that fails a minute later — and so the user can be asked *which* shell
 * to drive when both are present.
 * @returns {{id: string, label: string, progId: string, exePath: string}[]} Possibly empty.
 */
function findTwinCatShells() {
    const shells = [];
    for (const cand of TCXAESHELL_CANDIDATES) {
        const exePath = fs.existsSync(cand.exePath) ? cand.exePath : shellExeFromRegistry(cand.progId);
        if (!exePath) continue;
        shells.push(Object.assign({}, cand, { exePath }));
    }
    return shells;
}

/**
 * Runs the library-signature generator over a workspace folder and resolves with its exit code.
 *
 * The generator is a PowerShell script rather than Node because it must drive TwinCAT's COM automation
 * interface, which needs a **single-threaded apartment** (`-STA`) and an `IOleMessageFilter` — neither
 * of which Node can provide. It is the only part of the toolkit that touches TwinCAT, and it only ever
 * runs when the user explicitly asks for it: the extension itself stays fully offline.
 *
 * The chosen shell is passed in explicitly (`-ShellExe` / `-ProgId`) instead of letting the script find
 * one itself: which shell produces the dump is a user decision, because the signatures can differ.
 * @param {string} scriptPath Absolute path to generate-library-signatures.ps1.
 * @param {string} workspaceFolder Absolute workspace folder to generate for.
 * @param {{exePath: string, progId: string}} shell The XAE shell the user chose to drive.
 * @param {vscode.OutputChannel} output Channel the script's stdout/stderr is streamed to.
 * @param {(line: string) => void} onLine Called with each output line (drives the progress report).
 * @returns {Promise<number>} The script's exit code (0 = success).
 */
function runSignatureGenerator(scriptPath, workspaceFolder, shell, output, onLine) {
    return new Promise((resolve) => {
        const proc = spawn(
            'powershell.exe',
            [
                '-NoProfile', '-STA', '-File', scriptPath, workspaceFolder,
                '-ShellExe', shell.exePath,
                '-ProgId', shell.progId
            ],
            { windowsHide: true }
        );

        let pending = '';
        const consume = (chunk) => {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();           // keep the partial trailing line for the next chunk
            for (const line of lines) {
                output.appendLine(line);
                if (line.trim()) onLine(line.trim());
            }
        };

        proc.stdout.on('data', consume);
        proc.stderr.on('data', consume);
        proc.on('error', (err) => {
            output.appendLine(`Failed to start PowerShell: ${err.message}`);
            resolve(1);
        });
        proc.on('close', (code) => {
            if (pending.trim()) output.appendLine(pending.trim());
            resolve(code === null ? 1 : code);
        });
    });
}

module.exports = {
    findTwinCatShells,
    runSignatureGenerator
};
