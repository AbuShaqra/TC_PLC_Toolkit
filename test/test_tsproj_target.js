/**
 * @file test_tsproj_target.js
 * @description src/tsprojTarget.js: changing the solution's TargetNetId (user decision, 2026-11-16).
 * Pinned: only the attribute's value changes and every other byte survives (UTF-8 BOM, CRLF, LF,
 * non-ASCII bytes in ANSI and UTF-8); 0 or several occurrences, an element instead of the attribute,
 * UTF-16, a value changed since the run, a malformed new NetId and a file outside the solution's
 * folder are all refused with nothing written.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../src/tsprojTarget');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

const OLD = '10.0.0.4.1.1';
const NEW = '10.0.0.5.1.1';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const body = (nl) => [
    '<?xml version="1.0"?>',
    `<TcSmProject xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" TcSmVersion="1.0" TcVersion="3.1.4026.14">`,
    `\t<Project ProjectGUID="{00000000-0000-0000-0000-000000000001}" TargetNetId="${OLD}" ShowHideConfigurations="#x6">`,
    '\t\t<System/>',
    '\t</Project>',
    '</TcSmProject>',
    ''
].join(nl);

// ── Rewrite: the value only, every other byte kept ──────────────────────────────────────────────
for (const [name, buf] of [
    ['UTF-8 BOM + CRLF', Buffer.concat([BOM, Buffer.from(body('\r\n'), 'utf8')])],
    ['no BOM + LF', Buffer.from(body('\n'), 'utf8')],
    ['mixed line endings', Buffer.from(body('\r\n').replace('<System/>\r\n', '<System/>\n'), 'utf8')],
    ['UTF-8 non-ASCII elsewhere', Buffer.from(body('\r\n').replace('<System/>', '<System Comment="Übergabe ° ß"/>'), 'utf8')],
    ['ANSI (cp1252) byte elsewhere', Buffer.concat([Buffer.from(body('\r\n').split('<System/>')[0], 'latin1'), Buffer.from([0x3c, 0x21, 0x2d, 0x2d, 0xe4, 0xfc, 0x2d, 0x2d, 0x3e]), Buffer.from(body('\r\n').split('<System/>')[1], 'latin1')])]
]) {
    const r = t.rewriteTargetNetId(buf, OLD, NEW);
    const at = buf.indexOf(Buffer.from(OLD, 'latin1'));
    const expected = Buffer.concat([buf.subarray(0, at), Buffer.from(NEW, 'latin1'), buf.subarray(at + OLD.length)]);
    assert(r.ok && Buffer.compare(/** @type {any} */ (r).buffer, expected) === 0, `${name}: exactly the value's bytes change`);
}
{
    const buf = Buffer.concat([BOM, Buffer.from(body('\r\n'), 'utf8')]);
    const r = /** @type {any} */ (t.rewriteTargetNetId(buf, OLD, '10.0.0.1.1.1'));
    assert(r.ok && r.buffer.length === buf.length - (OLD.length - '10.0.0.1.1.1'.length) && r.buffer.subarray(0, 3).equals(BOM)
        && r.buffer.toString('utf8').includes('TargetNetId="10.0.0.1.1.1" ShowHide') && (r.buffer.toString('latin1').match(/\r\n/g) || []).length === 6,
        'a shorter value: BOM kept, CRLF kept, the attribute rewritten in place');
    const f = t.findTargetNetId(buf);
    assert(f.ok && f.value === OLD && f.count === 1, 'findTargetNetId reads the one value');
}

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────
const refuse = (name, buf, reason, from = OLD, to = NEW) => {
    const r = /** @type {any} */ (t.rewriteTargetNetId(buf, from, to));
    assert(!r.ok && r.reason === reason && !r.buffer, `${name}: refused (${reason})`);
    return r;
};
refuse('no TargetNetId', Buffer.from(body('\r\n').replace(` TargetNetId="${OLD}"`, ''), 'utf8'), 'none');
const several = refuse('two TargetNetId attributes', Buffer.from(body('\r\n').replace('<System/>', `<System TargetNetId="${OLD}"/>`), 'utf8'), 'several');
assert(several.count === 2, 'several: the count is reported');
refuse('a second occurrence in another case', Buffer.from(body('\r\n').replace('<System/>', '<System><targetnetid>1.2.3.4.5.6</targetnetid></System>'), 'utf8'), 'several');
refuse('an element, not the attribute', Buffer.from(body('\r\n').replace(` TargetNetId="${OLD}"`, '').replace('<System/>', `<TargetNetId>${OLD}</TargetNetId>`), 'utf8'), 'several');
refuse('the name alone, not as the attribute', Buffer.from(body('\r\n').replace(` TargetNetId="${OLD}"`, '').replace('<System/>', `<X TargetNetId='${OLD}'/>`), 'utf8'), 'not-attribute');
refuse('UTF-16 LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body('\r\n'), 'utf16le')]), 'encoding');
refuse('UTF-16 BE', Buffer.from([0xfe, 0xff, 0x00, 0x3c]), 'encoding');
const changed = refuse('the file names another target than the refused one', Buffer.from(body('\r\n'), 'utf8'), 'changed', '192.0.2.1.1.1');
assert(changed.found === OLD, 'changed: the value found is reported');
refuse('a malformed new NetId', Buffer.from(body('\r\n'), 'utf8'), 'invalid', OLD, '1.2.3');

// ── The file: inside the solution's folder, checked, then written ───────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc_tsproj_target_'));
const sln = path.join(TMP, 'Line', 'Line.sln');
const tsproj = path.join(TMP, 'Line', 'Line', 'Line.tsproj');
fs.mkdirSync(path.dirname(tsproj), { recursive: true });
fs.writeFileSync(sln, '');
const original = Buffer.concat([BOM, Buffer.from(body('\r\n'), 'utf8')]);
fs.writeFileSync(tsproj, original);
assert(t.insideSolution(tsproj, sln) && t.insideSolution(tsproj.replace(/\.tsproj$/, '.tspproj'), sln), 'a .tsproj/.tspproj under the solution folder is inside');
assert(!t.insideSolution(path.join(TMP, 'Other.tsproj'), sln) && !t.insideSolution(path.join(TMP, 'Line', 'x.xml'), sln) && !t.insideSolution('', sln),
    'a file outside the folder, another extension or none is not');
assert(t.checkSolutionTarget({ slnPath: sln, tsprojPath: tsproj, from: OLD, fs }).ok, 'checkSolutionTarget: one TargetNetId, still the refused one');
const outside = t.changeSolutionTarget({ slnPath: sln, tsprojPath: path.join(TMP, 'Elsewhere.tsproj'), from: OLD, to: NEW, fs });
assert(!outside.ok && /not a \.tsproj or \.tspproj inside the solution's folder/.test(outside.text), 'a system project outside the solution is never written');
const missing = t.checkSolutionTarget({ slnPath: sln, tsprojPath: path.join(TMP, 'Line', 'Gone.tsproj'), from: OLD, fs });
assert(!missing.ok && /Gone\.tsproj could not be read \(ENOENT\)/.test(missing.text), 'a missing file: could not be read');
const wrongFrom = t.changeSolutionTarget({ slnPath: sln, tsprojPath: tsproj, from: '192.0.2.1.1.1', to: NEW, fs });
assert(!wrongFrom.ok && /now names TargetNetId 199\.4\.42\.250\.1\.1, not 192\.0\.2\.1\.1\.1/.test(wrongFrom.text) && fs.readFileSync(tsproj).equals(original),
    'a file that changed since the run: refused, nothing written');
const done = t.changeSolutionTarget({ slnPath: sln, tsprojPath: tsproj, from: OLD, to: NEW, fs });
const after = fs.readFileSync(tsproj);
assert(done.ok && after.equals(Buffer.from(original.toString('latin1').replace(OLD, NEW), 'latin1')), 'changeSolutionTarget writes the one value, every other byte unchanged');
assert(!t.checkSolutionTarget({ slnPath: sln, tsprojPath: tsproj, from: OLD, fs }).ok, 'and the old value is gone');
fs.writeFileSync(tsproj, Buffer.from(body('\r\n').replace('<System/>', `<System TargetNetId="${OLD}"/>`), 'utf8'));
const twice = t.checkSolutionTarget({ slnPath: sln, tsprojPath: tsproj, from: OLD, fs });
assert(!twice.ok && /Line\.tsproj names TargetNetId 2 times, and TC Toolkit does not guess which one counts/.test(twice.text), 'checkSolutionTarget: several occurrences explained');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(errors === 0 ? '\nAll tsproj target tests passed.' : `\n${errors} tsproj target test(s) FAILED.`);
process.exit(errors === 0 ? 0 : 1);
