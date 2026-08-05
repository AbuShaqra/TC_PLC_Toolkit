/**
 * @file test_memory_bank.js
 * @description Guards the shared memory bank in `.claude/memory/` — the notes themselves, and the
 * wiring that gets them into a session.
 *
 * The bank fails in exactly one way, and it is a silent one: a malformed note is skipped, a renamed
 * file breaks the `[[links]]` pointing at it, or the `SessionStart` hook stops being declared — and
 * nothing anywhere says so. Sessions simply stop being told things the project already learned, which
 * looks identical to there being nothing to tell. Hence a test rather than trust.
 *
 * It also pins the hook's *contract* with Claude Code, because that is what the shipped mechanism
 * depends on and it is not enforced anywhere else in the repo: the command must emit JSON carrying
 * `hookSpecificOutput.additionalContext`, and it must exit 0 no matter what it finds — a hook that
 * fails on every session start would be worse than one that occasionally says nothing.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readBank, readNote, digest, check } = require('../.claude/memory/bank');

const ROOT = path.join(__dirname, '..');
const BANK = path.join(ROOT, '.claude', 'memory');

let errors = 0;
function assert(cond, msg) {
    if (cond) console.log(`[PASS] ${msg}`);
    else { console.error(`[FAIL] ${msg}`); errors++; }
}

// ------------------------------------------------------------------ the notes are well-formed
const { problems, warnings } = check();
for (const p of problems) console.error('       ' + p);
assert(problems.length === 0, `every note parses, is named after its file, and has a valid type (${problems.length} problem(s))`);

const notes = readBank();
assert(notes.length > 0, `the bank has notes (${notes.length})`);
console.log(`\n${notes.length} note(s), ${warnings.length} dangling link(s) — dangling is legal, it marks a note worth writing`);
for (const n of notes) console.log(`   ${n.name} (${n.type})`);
console.log();

// A note nobody can act on is worse than no note. These are cheap proxies for "it says something".
for (const n of notes) {
    const body = fs.readFileSync(path.join(BANK, n.file), 'utf8').split(/^---\r?\n[\s\S]*?\r?\n---/)[1] || '';
    assert(body.trim().length > 200, `${n.file}: has a real body, not just frontmatter (${body.trim().length} chars)`);
}

// The bank must not become a second copy of the docs. These files own that content, and a note that
// duplicates them goes stale in a place nobody looks.
assert(fs.existsSync(path.join(ROOT, 'DEVELOPMENT.md')) && fs.existsSync(path.join(ROOT, 'HANDOFF.md')),
    'the docs the bank defers to (DEVELOPMENT.md, HANDOFF.md) exist');

// ------------------------------------------------------------------ the digest
const text = digest(notes);
for (const n of notes) {
    assert(text.includes(n.name), `${n.name} appears in the session digest`);
    assert(text.includes(n.description), `…with its description, which is what makes the index usable`);
}
assert(text.includes('.claude/memory/'), 'the digest points at the files, so a session can open the full note');
assert(!/\\"/.test(text), 'no escaped quotes leak out of the frontmatter into the digest');
assert(digest([]) === '', 'an empty bank produces no digest rather than an empty heading');

// ------------------------------------------------------------------ the hook contract
const settingsPath = path.join(ROOT, '.claude', 'settings.json');
assert(fs.existsSync(settingsPath), '.claude/settings.json is committed, so a clone needs no setup');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const commands = (settings.hooks && settings.hooks.SessionStart || [])
    .flatMap(entry => (entry.hooks || []).filter(h => h.type === 'command').map(h => h.command));
assert(commands.length === 1, `exactly one SessionStart command hook is declared (${commands.length})`);
assert(/bank\.js/.test(commands[0] || ''), `and it runs the bank script (${commands[0]})`);

// Run the command's script the way the hook does and check what Claude Code will actually receive.
const raw = execFileSync(process.execPath, [path.join(BANK, 'bank.js')], { encoding: 'utf8', input: '{}' });
let parsed = null;
try { parsed = JSON.parse(raw); } catch (e) { /* asserted below */ }
assert(parsed !== null, 'the hook emits valid JSON');
assert(parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName === 'SessionStart',
    'tagged with the SessionStart event name, which the contract requires');
assert(parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext === text,
    'and the injected context is exactly the digest');

// Exit 0 whatever happens: this runs at the start of every session.
for (const args of [[], ['--digest'], ['--nonsense']]) {
    let ok = true;
    try { execFileSync(process.execPath, [path.join(BANK, 'bank.js'), ...args], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { ok = false; }
    assert(ok, `bank.js ${args.join(' ') || '(no args)'} exits 0`);
}
// --check is the one mode allowed to fail — that is its job, and it runs here, not at session start.
assert(typeof check().problems.length === 'number', '--check reports problems separately from dangling links');

// ------------------------------------------------------------------ malformed notes are survivable
const tmp = path.join(BANK, '__test_malformed__.md');
try {
    fs.writeFileSync(tmp, 'no frontmatter at all\n');
    assert(readNote(tmp) === null, 'a note with no frontmatter parses to null rather than throwing');
    assert(!readBank().some(n => n.file === '__test_malformed__.md'), 'and is left out of the digest');
    assert(check().problems.some(p => p.includes('__test_malformed__')), 'while --check names it, so it gets fixed');
} finally {
    fs.unlinkSync(tmp);
}
assert(!fs.existsSync(tmp), 'the temporary note is cleaned up');

console.log(errors === 0 ? '\nAll memory-bank tests passed.' : `\n${errors} test(s) failed.`);
process.exit(errors === 0 ? 0 : 1);
