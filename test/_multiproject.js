/**
 * @file _multiproject.js
 * @description Fixture: the committed sample project copied twice under ONE workspace root.
 *
 * This is the reported bug's real shape — a folder holding several TwinCAT projects whose objects
 * share names. LineB is diverged the way two real machine projects diverge (its GVL_System has no
 * fbDerived), so a leak from B into A shows up as a diagnostic on A's correct code rather than as a
 * silent pass. Shared by the scope, library and rename harnesses so they cannot drift.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** The committed synthetic sample — ground truth, and correct TwinCAT code. */
const SAMPLE_PROJECT = path.join(__dirname, '..', 'sample', 'TcToolkitSample');

/**
 * True when the sample is present. Harnesses skip cleanly (exit 0) when it is not, the way every
 * other sample-based harness does; test/run.js then reports the run as REDUCED.
 * @returns {boolean}
 */
function sampleAvailable() {
    return fs.existsSync(SAMPLE_PROJECT);
}

/**
 * Absolute path of a sample object inside one fixture copy.
 * @param {string} projectDir A fixture copy root (the `lineA`/`lineB` returned by the builder).
 * @param {string} relative Path relative to the PLC project, e.g. 'POUs/MAIN.TcPOU'.
 * @returns {string} Absolute path.
 */
function objectPath(projectDir, relative) {
    return path.join(projectDir, 'TcToolkitSample_PLC', ...relative.split('/'));
}

/**
 * Builds the two-project fixture in a temp directory.
 * @returns {{root: string, lineA: string, lineB: string, plcprojA: string, plcprojB: string,
 *   cleanup: () => void}}
 */
function buildTwoProjectFixture() {
    const root = path.join(os.tmpdir(), 'tc_multiproj_' + process.pid + '_' + Date.now());
    const lineA = path.join(root, 'LineA');
    const lineB = path.join(root, 'LineB');
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(SAMPLE_PROJECT, lineA, { recursive: true });
    fs.cpSync(SAMPLE_PROJECT, lineB, { recursive: true });

    // LineB's machine has no derived station, so its GVL_System does not declare fbDerived. LineA's
    // MAIN calls GVL_System.fbDerived.Cyclic() — correct in LineA, and a false positive if B wins.
    const bGvl = objectPath(lineB, 'GVLs/GVL_System.TcGVL');
    const patched = fs.readFileSync(bGvl, 'utf8').replace(/\n\tfbDerived.*?;/, '');
    if (patched.includes('fbDerived')) {
        throw new Error('fixture: failed to remove fbDerived from LineB GVL_System — sample changed?');
    }
    fs.writeFileSync(bGvl, patched);

    return {
        root,
        lineA,
        lineB,
        plcprojA: path.join(lineA, 'TcToolkitSample_PLC', 'TcToolkitSample_PLC.plcproj'),
        plcprojB: path.join(lineB, 'TcToolkitSample_PLC', 'TcToolkitSample_PLC.plcproj'),
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

module.exports = { SAMPLE_PROJECT, sampleAvailable, objectPath, buildTwoProjectFixture };
